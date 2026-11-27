import type {
  OrchestrationV2ProviderCapabilities,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
} from "@zerocode/contracts";
import * as ProviderAdapter from "@zerocode/provider-core/server/ProviderAdapter";
import type { ProviderTextGeneration } from "@zerocode/provider-core/server/textGeneration";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

export const CLAUDE_PROVIDER_CAPABILITIES = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkWhileSourceRunning: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsNativeResume: true,
    supportsActiveSteering: true,
    activeSteeringInterruptsTools: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: true,
    supportsBackgroundWait: true,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
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
    acceptsSystemContext: true,
    acceptsDeveloperContext: true,
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
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: {
    enforcement: "native",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export const CODEX_PROVIDER_CAPABILITIES = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkWhileSourceRunning: true,
    canForkFromSubagentThread: true,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsNativeResume: true,
    supportsActiveSteering: true,
    activeSteeringDuringCompaction: true,
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
    supportsDynamicToolCallbacks: true,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: true,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: true,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: true,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
    canCloseSubagents: true,
    canForkSubagentThread: true,
  },
  context: {
    acceptsSystemContext: true,
    acceptsDeveloperContext: true,
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
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: {
    enforcement: "native",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export const ANTIGRAVITY_PROVIDER_CAPABILITIES = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
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
    supportsMcpTools: true,
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
    supportsSubagents: true,
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

export const makeLazyOrchestrationAdapter = Effect.fn(
  "ProviderDriver.makeLazyOrchestrationAdapter",
)(function* <E, R>(input: {
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
    getCapabilities: input.getCapabilities,
    planSelectionTransition: input.planSelectionTransition,
    openSession: Effect.fnUntraced(function* (openInput) {
      const adapter = yield* resolveAdapter(openInput.providerSessionId);
      return yield* adapter.openSession(openInput);
    }),
  });
});

export const makeLazyTextGeneration = Effect.fn("ProviderDriver.makeLazyTextGeneration")(function* <
  R,
>(
  load: () => Effect.Effect<ProviderTextGeneration, never, R>,
): Effect.fn.Return<ProviderTextGeneration, never, R> {
  const context = yield* Effect.context<R>();
  const loadLock = yield* Semaphore.make(1);
  let cached: ProviderTextGeneration | undefined;

  const resolve = Effect.suspend(() => {
    if (cached !== undefined) return Effect.succeed(cached);
    return loadLock.withPermits(1)(
      Effect.suspend(() => {
        if (cached !== undefined) return Effect.succeed(cached);
        return load().pipe(
          Effect.provideContext(context),
          Effect.tap((service) =>
            Effect.sync(() => {
              cached = service;
            }),
          ),
        );
      }),
    );
  });

  return {
    generateTranscriptionPostProcessing: (input) =>
      resolve.pipe(Effect.flatMap((service) => service.generateTranscriptionPostProcessing(input))),
    generateCommitMessage: (input) =>
      resolve.pipe(Effect.flatMap((service) => service.generateCommitMessage(input))),
    generatePrContent: (input) =>
      resolve.pipe(Effect.flatMap((service) => service.generatePrContent(input))),
    generateBranchName: (input) =>
      resolve.pipe(Effect.flatMap((service) => service.generateBranchName(input))),
    generateThreadTitle: (input) =>
      resolve.pipe(Effect.flatMap((service) => service.generateThreadTitle(input))),
    generateReviewGuide: (input) =>
      resolve.pipe(Effect.flatMap((service) => service.generateReviewGuide(input))),
  };
});
