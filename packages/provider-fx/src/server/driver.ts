import { TextGenerationError, type OrchestrationV2ProviderCapabilities } from "@zerocode/contracts";
import { FxSettings } from "../settings.ts";
import * as HostProcess from "@zerocode/shared/HostProcess";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderHost from "@zerocode/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@zerocode/provider-core/server/ProviderLatestVersions";
import {
  ACP_BASE_PROVIDER_CAPABILITIES,
  makeLazyProviderAdapter,
} from "@zerocode/provider-core/server/adapterDriver";
import { acpSelectionTransition } from "@zerocode/provider-core/server/selectionTransition";
import type { FxAdapterV2DriverEnv } from "./adapter.ts";
import { ProviderDriverError } from "@zerocode/provider-core/server/errors";
import {
  buildInitialFxProviderSnapshot,
  checkFxProviderStatus,
  readFxDefaultChoice,
} from "./status.ts";
import { makeManagedServerProvider } from "@zerocode/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@zerocode/provider-core/server/driver";
import { withInstanceIdentity } from "@zerocode/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@zerocode/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@zerocode/provider-core/server/pathExpansion";
import { discoverFxSkills } from "./skills.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@zerocode/provider-core/server/maintenanceResolver";
import { fetchLatestFxVersion, makeFxMaintenance } from "./maintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@zerocode/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@zerocode/provider-core/server/textGeneration";
import { FX_DRIVER_KIND } from "./acpSupport.ts";

const decodeFxSettings = Schema.decodeSync(FxSettings);

const FX_PROVIDER_CAPABILITIES = {
  ...ACP_BASE_PROVIDER_CAPABILITIES,
  sessions: {
    ...ACP_BASE_PROVIDER_CAPABILITIES.sessions,
    supportsModelSwitchInSession: true,
  },
  threads: {
    ...ACP_BASE_PROVIDER_CAPABILITIES.threads,
    canReadThreadSnapshot: true,
  },
  tools: {
    ...ACP_BASE_PROVIDER_CAPABILITIES.tools,
    supportsMcpTools: true,
  },
  checkpointing: {
    ...ACP_BASE_PROVIDER_CAPABILITIES.checkpointing,
    providerCanReadConversationSnapshot: true,
  },
  subagents: {
    ...ACP_BASE_PROVIDER_CAPABILITIES.subagents,
    supportsSubagents: true,
    emitsSubagentLifecycle: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

// See `supportsTextGeneration` in status.ts.
const unsupportedTextGeneration: ProviderTextGeneration = (() => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "fx does not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
    generateTranscriptionPostProcessing: () => unsupported("generateTranscriptionPostProcessing"),
  };
})();

export type FxDriverEnv =
  | FxAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderHost.ProviderHost
  | ProviderLatestVersions.ProviderLatestVersions;

export const FxDriver: ProviderDriver<FxSettings, FxDriverEnv> = {
  driverKind: FX_DRIVER_KIND,
  metadata: {
    displayName: "fx",
    supportsMultipleInstances: true,
  },
  configSchema: FxSettings,
  defaultConfig: (): FxSettings => decodeFxSettings({}),
  create: Effect.fn("FxDriver.create")(function* ({
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
    const host = yield* ProviderHost.ProviderHost;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const processEnv = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: FX_DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: FX_DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
    } satisfies FxSettings;
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(
        makeFxMaintenance(
          fetchLatestFxVersion().pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
        ),
        {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
          npmCacheDir: path.join(host.paths.providerStatusCacheDir, "npm"),
        },
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    );
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<FxSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialFxProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider: checkFxProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
      enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichProviderSnapshotWithVersionAdvisory(currentSnapshot, maintenanceCapabilities, {
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            }),
          ),
          Effect.flatMap(publishSnapshot),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: FX_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the fx provider snapshot.",
            cause,
          }),
      ),
    );

    const orchestrationAdapter = yield* makeLazyProviderAdapter({
      instanceId,
      driver: FX_DRIVER_KIND,
      checksVersionAtHandshake: false,
      getCapabilities: Effect.fn("AcpAdapter.getCapabilities")(() =>
        Effect.succeed(FX_PROVIDER_CAPABILITIES),
      ),
      planSelectionTransition: Effect.fn("AcpAdapter.planSelectionTransition")((input) =>
        Effect.succeed(acpSelectionTransition(input)),
      ),
      load: () =>
        Effect.promise(() => import("./adapter.ts")).pipe(
          Effect.flatMap(({ makeFxAdapterV2Driver }) =>
            makeFxAdapterV2Driver((cwd) =>
              readFxDefaultChoice(effectiveConfig, processEnv, cwd).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              ),
            ).create({
              instanceId,
              displayName,
              accentColor,
              environment,
              enabled,
              config: effectiveConfig,
            }),
          ),
        ),
    });

    return {
      instanceId,
      driverKind: FX_DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd: (cwd) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              discoverFxSkills({ cwd, environment: processEnv }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              ),
            ]).pipe(Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills }))),
      orchestrationAdapter,
      textGeneration: unsupportedTextGeneration,
    } satisfies ProviderInstance;
  }),
};
