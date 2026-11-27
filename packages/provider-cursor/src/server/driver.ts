import {
  ProviderDriverKind,
  ProviderSetupError,
  type OrchestrationV2ProviderCapabilities,
  type ServerProviderModel,
} from "@zerocode/contracts";
import { CursorSettings } from "../settings.ts";
import type { SDKModel } from "@cursor/sdk";
import * as Effect from "effect/Effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import { cursorRateModel } from "./accountUsage.ts";
import { readCursorUsageLimits } from "./usageLimits.ts";

import * as ProviderHost from "@zerocode/provider-core/server/ProviderHost";
import { makeLazyProviderAdapter } from "@zerocode/provider-core/server/adapterDriver";
import { turnScopedSelectionTransition } from "@zerocode/provider-core/server/selectionTransition";
import { makeCursorTextGeneration } from "./textGeneration.ts";
import type { CursorAdapterV2DriverEnv } from "./adapter.ts";
import { ProviderDriverError } from "@zerocode/provider-core/server/errors";
import { buildInitialCursorProviderSnapshot, checkCursorProviderStatus } from "./status.ts";
import * as CursorSdkCatalog from "./CursorSdkCatalog.ts";
import { makeManagedServerProvider } from "@zerocode/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@zerocode/provider-core/server/driver";
import { withInstanceIdentity } from "@zerocode/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@zerocode/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@zerocode/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@zerocode/provider-core/server/snapshotSettings";
import { probeCursorSkills } from "./skills.ts";
import { makeCursorAuth } from "./auth.ts";
import * as CursorCredentialStore from "./credentialStore.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";
import * as CursorUsageAccounts from "./CursorUsageAccounts.ts";

const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const isSdkRunnerError = Schema.is(CursorAgentSdk.CursorAgentSdkRunnerError);

const DRIVER_KIND = ProviderDriverKind.make("cursor");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

const CURSOR_PROVIDER_CAPABILITIES = {
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
    canRollbackThread: true,
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
    supportsNativeResume: true,
    supportsActiveSteering: true,
    activeSteeringInterruptsTools: true,
    activeSteeringAcceptsAttachments: false,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: true,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
    supportsBackgroundWait: true,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: true,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: true,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "weak",
    nativeRequestIds: "none",
  },
  runtimePolicy: {
    enforcement: "native",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export type CursorDriverEnv =
  | CursorAdapterV2DriverEnv
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | CursorSdk.CursorSdk
  | ProviderHost.ProviderHost;

export const CursorDriver: ProviderDriver<
  CursorSettings,
  CursorDriverEnv,
  CursorUsageAccounts.CursorUsageAccounts
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Cursor",
    supportsMultipleInstances: true,
  },
  configSchema: CursorSettings,
  defaultConfig: (): CursorSettings => decodeCursorSettings({}),
  usage: {
    kind: "scan",
    provider: "cursor",
    rateModel: cursorRateModel,
    scan: ({ instances, windowStartMs, retentionCutoffMs, awaitRefresh }) =>
      CursorUsageAccounts.CursorUsageAccounts.pipe(
        Effect.flatMap((accounts) =>
          accounts.scan({
            instances,
            windowStartMs,
            retentionCutoffMs,
            awaitRefresh,
          }),
        ),
      ),
  },
  create: Effect.fn("CursorDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const host = yield* ProviderHost.ProviderHost;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const sdkRunner = yield* CursorAgentSdk.CursorAgentSdkRunner;
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: displayName ?? "Cursor",
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies CursorSettings;
    const credentials = yield* CursorCredentialStore.makeCursorCredentialStore(
      instanceId,
      path.join(
        host.paths.stateDir,
        "provider-auth",
        encodeURIComponent(instanceId),
        "cursor.json",
      ),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Could not open the Cursor credential store.",
            cause,
          }),
      ),
    );
    const auth = yield* makeCursorAuth({
      instanceId,
      displayName: displayName ?? "Cursor",
      enabled,
      ...(processEnv.CURSOR_API_KEY ? { apiKey: processEnv.CURSOR_API_KEY } : {}),
      store: credentials.store,
      credentialBinding: credentials.binding,
      onChanged: (signedIn): Effect.Effect<void, ProviderSetupError> =>
        snapshot.refresh.pipe(
          Effect.flatMap((provider) =>
            !signedIn || provider.auth.status === "authenticated"
              ? Effect.void
              : Effect.fail(
                  new ProviderSetupError({
                    instanceId,
                    operation: "start",
                    detail: provider.message ?? "Could not verify the Cursor sign-in. Try again.",
                  }),
                ),
          ),
        ),
    });
    const stampSnapshot: typeof stampIdentity = (draft) =>
      stampIdentity({
        ...draft,
        setup: { canAuthenticate: !auth.usesApiKey, canInstall: false },
        auth: {
          ...draft.auth,
          canLogout: !auth.usesApiKey,
        },
      });

    let catalogModels: ReadonlyArray<ServerProviderModel> = [];
    let catalogSdkModels: ReadonlyArray<SDKModel> = [];
    const orchestrationAdapter = yield* makeLazyProviderAdapter({
      instanceId,
      driver: DRIVER_KIND,
      getCapabilities: Effect.fn("CursorAdapter.getCapabilities")(() =>
        Effect.succeed(CURSOR_PROVIDER_CAPABILITIES),
      ),
      planSelectionTransition: Effect.fn("CursorAdapter.planSelectionTransition")(() =>
        Effect.succeed(turnScopedSelectionTransition()),
      ),
      load: () =>
        Effect.promise(() => import("./adapter.ts")).pipe(
          Effect.flatMap(({ makeCursorAdapterV2 }) =>
            makeCursorAdapterV2({
              instanceId,
              environment: processEnv,
              getModels: () => catalogModels,
              getSdkModels: () => catalogSdkModels,
            }).pipe(
              Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
                ...sdkRunner,
                open: (input) =>
                  auth.requireApiKey.pipe(
                    Effect.flatMap((apiKey) =>
                      Effect.acquireRelease(
                        sdkRunner
                          .open({ ...input, options: { ...input.options, apiKey } })
                          .pipe(
                            Effect.flatMap((session) =>
                              Effect.cached(session.close).pipe(
                                Effect.map((close) => ({ ...session, close })),
                              ),
                            ),
                          ),
                        (session) => session.close.pipe(Effect.ignore),
                      ),
                    ),
                    auth.withAccess,
                    Effect.mapError((cause) =>
                      isSdkRunnerError(cause)
                        ? cause
                        : new CursorAgentSdk.CursorAgentSdkRunnerError({ method: "open", cause }),
                    ),
                  ),
              }),
            ),
          ),
        ),
    });
    const textGeneration = yield* makeCursorTextGeneration(
      effectiveConfig,
      processEnv,
      auth.requireApiKey,
      auth.withAccess,
      () => catalogModels,
      () => catalogSdkModels,
      sdkRunner,
    );

    const checkProvider = auth.readApiKey.pipe(
      Effect.orElseSucceed(() => undefined),
      Effect.flatMap((apiKey) =>
        checkCursorProviderStatus(
          effectiveConfig,
          {
            ...processEnv,
            CURSOR_API_KEY: apiKey,
          },
          auth.usesApiKey ? "api-key" : "browser",
        ).pipe(
          Effect.filterOrElse(
            (snapshot) =>
              !(
                effectiveConfig.enabled &&
                snapshot.installed &&
                snapshot.auth.status === "authenticated"
              ),
            (snapshot) =>
              readCursorUsageLimits(effectiveConfig, {
                ...processEnv,
                CURSOR_API_KEY: apiKey,
              }).pipe(Effect.map((usageLimits) => ({ ...snapshot, usageLimits }))),
          ),
        ),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.map(stampSnapshot),
      Effect.tap((provider) =>
        Effect.sync(() => {
          // A failed check lists only custom models, so keep the last loaded catalog.
          if (provider.models.some((model) => !model.isCustom)) {
            catalogModels = provider.models;
          }
        }),
      ),
      Effect.provideServiceEffect(
        CursorSdkCatalog.CursorSdkCatalog,
        Effect.map(CursorSdkCatalog.CursorSdkCatalog, (catalog) =>
          CursorSdkCatalog.CursorSdkCatalog.of({
            // Untraced: CursorSdkCatalog.read already spans this call.
            read: Effect.fnUntraced(function* (apiKey) {
              const snapshot = yield* catalog.read(apiKey);
              if (snapshot.models.length > 0) catalogSdkModels = snapshot.models;
              return snapshot;
            }),
          }),
        ),
      ),
      Effect.provide(CursorSdkCatalog.layer),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CursorSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialCursorProviderSnapshot(settings.provider).pipe(Effect.map(stampSnapshot)),
      checkProvider,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Cursor snapshot.",
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      auth: auth.controller,
      snapshot,
      snapshotForCwd: (cwd) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              probeCursorSkills(cwd, processEnv).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: `Failed to discover Cursor skills for '${cwd}'`,
                      cause,
                    }),
                ),
              ),
            ]).pipe(Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills }))),
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
