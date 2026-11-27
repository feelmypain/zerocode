import {
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ProviderCapabilities,
  type ProviderSessionId,
} from "@zerocode/contracts";
import type { ProviderDriverCreateInput } from "./driver.ts";
export type { ProviderDriverCreateInput as ProviderAdapterDriverCreateInput } from "./driver.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ProviderAdapter from "./ProviderAdapter.ts";

export class ProviderAdapterDriverCreateError extends Schema.TaggedError<ProviderAdapterDriverCreateError>()(
  "ProviderAdapterDriverCreateError",
  {
    driver: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to create orchestration-v2 provider adapter ${this.instanceId} (${this.driver}): ${this.detail}`;
  }
}

export interface ProviderAdapterDriver<Config, R = never> {
  readonly driverKind: ProviderDriverKind;
  readonly configSchema: Schema.Codec<Config, unknown>;
  readonly defaultConfig: () => Config;
  readonly create: (
    input: ProviderDriverCreateInput<Config>,
  ) => Effect.Effect<
    ProviderAdapter.ProviderAdapterV2["Service"],
    ProviderAdapterDriverCreateError,
    R | Scope.Scope
  >;
}

export type AnyProviderAdapterDriver<R = never> = ProviderAdapterDriver<any, R>;

/** Base capabilities shared by ACP-backed provider drivers before their adapter module loads. */
export const ACP_BASE_PROVIDER_CAPABILITIES = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: true,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsNativeResume: false,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: true,
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
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
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
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "weak",
    nativeRequestIds: "weak",
  },
  runtimePolicy: {
    enforcement: "client-boundary",
  },
} satisfies OrchestrationV2ProviderCapabilities;

/**
 * Defers importing and constructing a heavy provider adapter until the first `openSession`.
 * Captures the driver's `Context` and `Scope`, serializes concurrent loads, and never caches load failures.
 */
export const makeLazyProviderAdapter = Effect.fn("ProviderDriver.makeLazyProviderAdapter")(
  function* <E, R>(input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly checksVersionAtHandshake?: boolean;
    readonly getCapabilities: ProviderAdapter.ProviderAdapterV2["Service"]["getCapabilities"];
    readonly planSelectionTransition: ProviderAdapter.ProviderAdapterV2["Service"]["planSelectionTransition"];
    readonly load: () => Effect.Effect<ProviderAdapter.ProviderAdapterV2["Service"], E, R>;
  }): Effect.fn.Return<ProviderAdapter.ProviderAdapterV2["Service"], never, R | Scope.Scope> {
    const context = yield* Effect.context<R>();
    const driverScope = yield* Scope.Scope;
    const loadLock = yield* Semaphore.make(1);
    let cached: ProviderAdapter.ProviderAdapterV2["Service"] | undefined;

    const resolveAdapter = (providerSessionId: ProviderSessionId) =>
      Effect.suspend(() => {
        if (cached !== undefined) return Effect.succeed(cached);
        return loadLock.withPermits(1)(
          Effect.suspend(() => {
            if (cached !== undefined) return Effect.succeed(cached);
            return input.load().pipe(
              Effect.provideContext(context),
              Effect.provideService(Scope.Scope, driverScope),
              Effect.tap((adapter) =>
                Effect.sync(() => {
                  cached = adapter;
                }),
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: input.driver,
                    providerSessionId,
                    cause,
                  }),
              ),
            );
          }),
        );
      });

    return ProviderAdapter.ProviderAdapterV2.of({
      instanceId: input.instanceId,
      driver: input.driver,
      ...(input.checksVersionAtHandshake === undefined
        ? {}
        : { checksVersionAtHandshake: input.checksVersionAtHandshake }),
      // Delegate after load so runtime-discovered capabilities (e.g. connected version features) surface.
      getCapabilities: Effect.fnUntraced(function* () {
        return cached !== undefined
          ? yield* cached.getCapabilities()
          : yield* input.getCapabilities();
      }),
      planSelectionTransition: Effect.fn(
        "ProviderAdapter.ProviderAdapterV2.planSelectionTransition",
      )((transition) =>
        cached !== undefined
          ? cached.planSelectionTransition(transition)
          : input.planSelectionTransition(transition),
      ),
      openSession: Effect.fnUntraced(function* (openInput) {
        const adapter = yield* resolveAdapter(openInput.providerSessionId);
        return yield* adapter.openSession(openInput);
      }),
    });
  },
);
