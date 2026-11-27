import {
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type ServerProvider,
} from "@zerocode/contracts";
import { MuseSettings } from "../settings.ts";
import * as HostProcess from "@zerocode/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@zerocode/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@zerocode/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@zerocode/provider-core/server/McpProviderSessions";
import { makeLazyProviderAdapter } from "@zerocode/provider-core/server/adapterDriver";
import { expandHomePath } from "@zerocode/provider-core/server/pathExpansion";
import { turnScopedSelectionTransition } from "@zerocode/provider-core/server/selectionTransition";
import { makeMuseTextGeneration } from "./textGeneration.ts";
import { ProviderDriverError } from "@zerocode/provider-core/server/errors";
import * as IdAllocator from "@zerocode/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@zerocode/provider-core/server/ProviderContinuationRequests";
import { checkMuseProviderStatus, makePendingMuseProvider } from "./status.ts";
import * as ProviderEventLoggers from "@zerocode/provider-core/server/ProviderEventLoggers";
import { makeManagedServerProvider } from "@zerocode/provider-core/server/managedProvider";
import type { ProviderUsageLimitsReport } from "@zerocode/provider-core/server/snapshot";
import { makeUsageLimits } from "@zerocode/provider-core/server/usageLimits";
import { enrichMuseSnapshot, latestMuseVersion, museMaintenance } from "./maintenance.ts";
import { makeMuseEnvironment } from "./sdk.ts";
import { museUsageReader } from "./usage.ts";
import type * as MuseUsageHome from "./MuseUsageHome.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@zerocode/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@zerocode/provider-core/server/instanceEnvironment";
import {
  makeCachedProviderMaintenanceResolution,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@zerocode/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@zerocode/provider-core/server/snapshotSettings";
import { withInstanceIdentity } from "@zerocode/provider-core/server/instanceIdentity";

const DRIVER_KIND = ProviderDriverKind.make("muse");
const decodeMuseSettings = Schema.decodeSync(MuseSettings);

const MUSE_PROVIDER_CAPABILITIES = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsNativeResume: false,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: true,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export type MuseDriverEnv =
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export const MuseDriver: ProviderDriver<
  MuseSettings,
  MuseDriverEnv,
  Path.Path | MuseUsageHome.MuseUsageHome
> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Muse Code", supportsMultipleInstances: true },
  usage: museUsageReader,
  configSchema: MuseSettings,
  defaultConfig: () => decodeMuseSettings({}),
  create: Effect.fn("MuseDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const host = yield* ProviderHost.ProviderHost;
    const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const { cwd } = host.paths;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const hostEnvironment = yield* HostProcess.Environment;
    // Drop an inherited META_API_KEY so Muse uses its login; an instance value still wins.
    const processEnvironment = yield* mergeProviderInstanceEnvironment(
      environment,
      makeMuseEnvironment(hostEnvironment),
    );
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
    } satisfies MuseSettings;
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    // Only a running CLI reports usage; status probes cannot fetch it.
    const latestUsage = yield* Ref.make<ProviderUsageLimitsReport | undefined>(undefined);
    const usagePermit = yield* Semaphore.make(1);
    const withLatestUsage = (provider: ServerProvider) =>
      Ref.get(latestUsage).pipe(
        Effect.map((report): ServerProvider =>
          report
            ? {
                ...provider,
                ...(report.authLabel
                  ? { auth: { ...provider.auth, label: report.authLabel } }
                  : {}),
                usageLimits: makeUsageLimits({
                  checkedAt: report.checkedAt,
                  windows: report.windows,
                }),
              }
            : provider,
        ),
      );
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const resolveInstallation = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(museMaintenance, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnvironment,
        npmCacheDir: path.join(host.paths.providerStatusCacheDir, "npm"),
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    );
    const resolveMaintenance = Effect.fn("MuseDriver.resolveMaintenance")(function* (options?: {
      readonly fresh?: boolean;
    }) {
      const capabilities = yield* resolveInstallation(options);
      // The maintenance runner requests fresh capabilities around an explicit update
      // and needs the native target version to verify that the command actually upgraded.
      const latestVersion =
        options?.fresh && !capabilities.lookupLatestVersion
          ? yield* latestMuseVersion(processEnvironment, { fresh: true }).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
            )
          : undefined;
      return latestVersion !== undefined ? { ...capabilities, latestVersion } : capabilities;
    });
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<MuseSettings>>({
      // Status refresh respects update checks; explicit updates use the resolver below.
      resolveMaintenance: (options) =>
        host.settings.get.pipe(
          Effect.orDie,
          Effect.flatMap((settings) =>
            settings.enableProviderUpdateChecks
              ? resolveMaintenance(options)
              : resolveInstallation(options),
          ),
        ),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        makePendingMuseProvider(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider: checkMuseProviderStatus(effectiveConfig, processEnvironment, cwd).pipe(
        Effect.map(stampIdentity),
        Effect.flatMap(withLatestUsage),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
      enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichMuseSnapshot({
              snapshot: currentSnapshot,
              maintenanceCapabilities,
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              environment: processEnvironment,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          Effect.flatMap(publishSnapshot),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Muse Code snapshot.",
            cause,
          }),
      ),
    );
    const modelCatalog = snapshot.getSnapshot.pipe(Effect.map((current) => current.models));
    const orchestrationAdapter = yield* makeLazyProviderAdapter({
      instanceId,
      driver: DRIVER_KIND,
      getCapabilities: Effect.fn("MuseAdapter.getCapabilities")(() =>
        Effect.succeed(MUSE_PROVIDER_CAPABILITIES),
      ),
      planSelectionTransition: Effect.fn("MuseAdapter.planSelectionTransition")(() =>
        Effect.succeed(turnScopedSelectionTransition()),
      ),
      load: () =>
        Effect.promise(() => import("./adapter.ts")).pipe(
          Effect.flatMap(({ makeMuseAdapterV2 }) =>
            makeMuseAdapterV2({
              instanceId,
              settings: effectiveConfig,
              environment: processEnvironment,
              modelCatalog,
              ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
              continuationRequests,
              onUsageLimits: (report) =>
                usagePermit.withPermits(1)(
                  Effect.gen(function* () {
                    const previous = yield* Ref.get(latestUsage);
                    if (previous && Date.parse(report.checkedAt) < Date.parse(previous.checkedAt))
                      return;
                    yield* Ref.set(latestUsage, report);
                    yield* snapshot.applyUsageLimits({ ...report, complete: true });
                  }),
                ),
            }),
          ),
        ),
    });
    const textGeneration = yield* makeMuseTextGeneration(effectiveConfig, {
      environment: processEnvironment,
      modelCatalog,
    });
    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot: { ...snapshot, resolveMaintenance, refreshUsage: Effect.void },
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
