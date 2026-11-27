import {
  ProviderDriverKind,
  TextGenerationError,
  type OrchestrationV2ProviderCapabilities,
} from "@zerocode/contracts";
import { KiroSettings } from "../settings.ts";
import * as HostProcess from "@zerocode/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type * as ProviderHost from "@zerocode/provider-core/server/ProviderHost";
import {
  ACP_BASE_PROVIDER_CAPABILITIES,
  makeLazyProviderAdapter,
} from "@zerocode/provider-core/server/adapterDriver";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@zerocode/provider-core/server/driver";
import { ProviderDriverError } from "@zerocode/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@zerocode/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@zerocode/provider-core/server/pathExpansion";
import { withInstanceIdentity } from "@zerocode/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@zerocode/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@zerocode/provider-core/server/managedProvider";
import { acpSelectionTransition } from "@zerocode/provider-core/server/selectionTransition";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@zerocode/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@zerocode/provider-core/server/textGeneration";
import type { KiroAdapterV2DriverEnv } from "./adapter.ts";
import {
  buildInitialKiroProviderSnapshot,
  checkKiroProviderStatus,
  kiroDefaultModelId,
} from "./status.ts";

const DRIVER_KIND = ProviderDriverKind.make("kiro");
const decodeKiroSettings = Schema.decodeSync(KiroSettings);
// Kiro updates itself in the background (`kiro-cli update` reports only), so
// ZeroCode offers no one-click update.
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

const KIRO_PROVIDER_CAPABILITIES = {
  ...ACP_BASE_PROVIDER_CAPABILITIES,
  sessions: {
    ...ACP_BASE_PROVIDER_CAPABILITIES.sessions,
    supportsModelSwitchInSession: true,
  },
  threads: {
    ...ACP_BASE_PROVIDER_CAPABILITIES.threads,
    canForkThread: true,
    canForkFromTurn: true,
  },
  turns: {
    ...ACP_BASE_PROVIDER_CAPABILITIES.turns,
    supportsActiveSteering: true,
    activeSteeringInterruptsTools: false,
    activeSteeringAcceptsAttachments: false,
  },
  tools: {
    ...ACP_BASE_PROVIDER_CAPABILITIES.tools,
    supportsMcpTools: true,
  },
  subagents: {
    ...ACP_BASE_PROVIDER_CAPABILITIES.subagents,
    supportsSubagents: true,
    emitsSubagentLifecycle: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

const unsupportedTextGeneration: ProviderTextGeneration = (() => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Kiro does not provide application text generation.",
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

export type KiroDriverEnv =
  | KiroAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | ProviderHost.ProviderHost;

export const KiroDriver: ProviderDriver<KiroSettings, KiroDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Kiro",
    supportsMultipleInstances: true,
  },
  configSchema: KiroSettings,
  defaultConfig: (): KiroSettings => decodeKiroSettings({}),
  create: Effect.fn("KiroDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* SecureRandom.SecureRandom;
    const processEnv = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
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
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
    } satisfies KiroSettings;
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<KiroSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialKiroProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider: checkKiroProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(SecureRandom.SecureRandom, crypto),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            // The cause keeps the failure; the detail reaches the snapshot, so it stays fixed.
            detail: "Failed to build Kiro snapshot.",
            cause,
          }),
      ),
    );

    // "Kiro default" selects the default the snapshot read from Kiro's model list.
    const orchestrationAdapter = yield* makeLazyProviderAdapter({
      instanceId,
      driver: DRIVER_KIND,
      checksVersionAtHandshake: false,
      getCapabilities: Effect.fn("AcpAdapter.getCapabilities")(() =>
        Effect.succeed(KIRO_PROVIDER_CAPABILITIES),
      ),
      planSelectionTransition: Effect.fn("AcpAdapter.planSelectionTransition")((input) =>
        Effect.succeed(acpSelectionTransition(input)),
      ),
      load: () =>
        Effect.promise(() => import("./adapter.ts")).pipe(
          Effect.flatMap(({ makeKiroAdapterV2Driver }) =>
            makeKiroAdapterV2Driver(
              snapshot.getSnapshot.pipe(
                Effect.map((current) => kiroDefaultModelId(current.models)),
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
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter,
      textGeneration: unsupportedTextGeneration,
    } satisfies ProviderInstance;
  }),
};
