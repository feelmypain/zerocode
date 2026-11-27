import {
  isCompactionCommandMessage,
  latestProviderTurnForAttempt,
  type MessageId,
  type ModelSelection,
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2ContextTransferResolution,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2ModelSwitch,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  parseGoalCommand,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ProviderInstanceId,
  type ProviderSessionId,
  type RunId,
  type NodeId,
  type ChatAttachment,
} from "@zerocode/contracts";
import { notificationTurnItem } from "@zerocode/provider-core/server/notification";
import { expandAssistantCitationsForProvider } from "@zerocode/shared/assistantCitations";
import { isSlashCommand } from "@zerocode/shared/composerTrigger";
import { modelSelectionsEqual } from "@zerocode/shared/model";
import {
  latestExecutedRun,
  latestRootProviderFailure,
  runRanAfter,
  usageLimitBlockedRun,
} from "@zerocode/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import {
  goalCommandStopsActiveRun,
  isActiveRun,
  isNativeMaintenanceCommand,
  providerSwitchWaitsForTurn,
  providerTurnCapabilities,
  resolveMessageDispatch,
  resolveMessageDispatchIntent,
} from "../CommandPolicy.ts";
import { contextBoundaryOrdinal, turnItemsSinceContextBoundary } from "../contextBoundary.ts";
import {
  readForkHistoryItems,
  visibleConversationItems,
  visibleDeltaRunOrdinals,
} from "../ContextHandoffService.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import { guestShareAfterCancelledSend, withoutGuestAttribution } from "../GuestShareDecider.ts";
import { modelSwitchSince } from "../modelSwitch.ts";
import {
  isBufferedProviderNotification,
  isUndeliveredMailboxSteer,
} from "../NotificationMailbox.ts";
import { isPlaceholderThreadTitle } from "../placeholderThreadTitle.ts";
import { applyToProjection, threadShellFromProjection } from "../ProjectionStore.ts";
import { isAutomaticCompletionRun, queuedRunsInDeliveryOrder } from "../QueuedRunOrder.ts";
import {
  cancelledBeforeStart,
  continuationFailedBeforePrompt,
  isRestartContinuationSource,
} from "../RestartBackgroundNote.ts";
import { outputRequestProblem } from "../runOutput.ts";
import {
  appendContextHandoffId,
  dispatchProviderThread,
  forkTransferSupersededEvent,
  FRESH_CONTEXT_DETACH_REASON,
  isHandoffSourceRun,
  lastDeliveredRunForProviderThread,
  nextRunOrdinal,
  pendingForkTransferForThread,
  rootProviderThreadsForProvider,
  sessionsReleasedByFreshContext,
  uniqueSessions,
  wakeWorkStartedAt,
} from "./orchestratorQueueRunner.ts";
import {
  type CancelUnsettledEffects,
  contextSourcePointForRun,
  delegatedCompletionWakeDetail,
  followsCurrentConversation,
  isLiveRun,
  OrchestratorCommandRejectedError,
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorProviderAdapterError,
  type OrchestratorShared,
  pendingThreadTitleGenerationEffect,
  providerThreadForRun,
  queuedRunModelSelection,
  shouldPrepareLegacyImportHandoff,
  WORKSPACE_PREPARATION_INPUT,
  worktreeSetupPending,
} from "./orchestratorShared.ts";

// Clients seed a new thread with its first message, and empty threads start as "New thread" or
// an agent's placeholder. Any other title on a thread without messages was chosen on purpose.
// A fork or side chat starts with a title its first message replaces, so only a rename keeps it.
function hasTitleSetBeforeFirstMessage(
  thread: OrchestrationV2AppThread,
  titleSeed: string | undefined,
): boolean {
  if (thread.titleRenamed === true) return true;
  const title = thread.title.trim();
  return (
    thread.forkedFrom === null &&
    thread.lineage.sideChat !== true &&
    title.length > 0 &&
    title !== "New thread" &&
    !isPlaceholderThreadTitle(title) &&
    title !== titleSeed?.trim()
  );
}

function withoutPreparationResult(
  item: Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }>,
) {
  const { output: _output, exitCode: _exitCode, outputIndicatesFailure: _failure, ...rest } = item;
  return rest;
}

/** The selection the thread will be on once every queued run has started. */
function queueTailModelSelection(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages">,
): ModelSelection {
  return (
    queuedRunsInDeliveryOrder(projection).findLast(
      (run) =>
        !followsCurrentConversation(
          projection.messages.find((message) => message.id === run.userMessageId),
        ),
    )?.modelSelection ?? projection.thread.modelSelection
  );
}

function pendingMergeBackTransfersForThread(
  projection: Pick<OrchestrationV2ThreadProjection, "contextTransfers" | "thread">,
): ReadonlyArray<OrchestrationV2ContextTransfer> {
  return projection.contextTransfers.filter(
    (transfer) =>
      transfer.type === "merge_back" &&
      transfer.targetThreadId === projection.thread.id &&
      transfer.status === "pending",
  );
}

function latestContextTransfer(
  transfers: ReadonlyArray<OrchestrationV2ContextTransfer>,
): OrchestrationV2ContextTransfer | undefined {
  return transfers.reduce<OrchestrationV2ContextTransfer | undefined>((latest, transfer) => {
    if (latest === undefined) {
      return transfer;
    }
    return DateTime.toEpochMillis(transfer.updatedAt) >= DateTime.toEpochMillis(latest.updatedAt)
      ? transfer
      : latest;
  }, undefined);
}

interface RunCommandCallbacks {
  readonly isStaleQuestionWake: (
    projection: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents">,
    messageId: MessageId,
    notification: OrchestrationV2ThreadProjection["messages"][number]["notification"],
  ) => Effect.Effect<boolean, OrchestratorProjectionError>;
  readonly acceptDelegatedCompletionDelivery: (input: {
    readonly command: OrchestrationV2ServerCommand;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly projection: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "runs" | "messages" | "subagents"
    >;
    readonly messageId: OrchestrationV2ConversationMessage["id"];
    readonly now: DateTime.Utc;
  }) => Effect.Effect<RunId | undefined, OrchestratorDispatchError>;
  readonly disposeDelegatedCompletionCohort: (input: {
    readonly command: OrchestrationV2ServerCommand;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly projection: Pick<
      OrchestrationV2ThreadProjection,
      "runs" | "subagents" | "messages" | "nodes" | "attempts"
    >;
    readonly parentRunId: RunId;
    readonly disposition: "stopped" | "disposed";
    readonly now: DateTime.Utc;
    readonly cancelQueuedDelivery?: boolean;
    readonly interruptedWakeTaskIds?: ReadonlyArray<NodeId>;
  }) => Effect.Effect<void, OrchestratorDispatchError>;
  readonly stopRunForQueuedCommand: (input: {
    readonly command: Extract<
      OrchestrationV2Command,
      { readonly type: "message.dispatch" | "queued-message.promote-to-steer" }
    >;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>;
    readonly projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">;
    readonly queuedRunId: RunId;
    readonly targetRunId: RunId | undefined;
    readonly reason: string;
    readonly now: DateTime.Utc;
  }) => Effect.Effect<CancelUnsettledEffects | undefined, OrchestratorDispatchError>;
}

export function makeRunCommands(shared: OrchestratorShared, callbacks: RunCommandCallbacks) {
  const {
    checkpointService,
    commandPolicy,
    contextHandoffService,
    idAllocator,
    projectionStore,
    providerAdapters,
    providerSessions,
    providerSwitchService,
    runtimePolicy,
    emit,
    emitQueuedRunCancellation,
    ensureGoalCommandSupported,
    getProjectionWithPendingEvents,
    goalDriverFor,
    limitForbidsParkedSteer,
    loadProjectionForCommand,
    mapDispatchError,
    nextTurnItemOrdinal,
    notificationTasks,
    providerSessionIdFor,
    readHandoffItems,
    readInheritedItems,
    refuseAboveDispatchModeLimit,
    sessionHasBackgroundWork,
    stopReachedRun,
    turnStartedModes,
  } = shared;

  const ensureSteeringMessage = Effect.fn("Orchestrator.ensureSteeringMessage")(function* (
    command: Extract<
      OrchestrationV2Command,
      { readonly type: "message.dispatch" | "queued-message.promote-to-steer" }
    >,
    message: Pick<OrchestrationV2ConversationMessage, "text" | "attachments" | "context">,
  ) {
    if (
      expandAssistantCitationsForProvider(message.text).length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS
    ) {
      return yield* new OrchestratorCommandRejectedError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Message exceeds ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")} characters after expanding quotes. Shorten it and try again.`,
      });
    }
    if (isNativeMaintenanceCommand(message)) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause:
          message.text.trim().toLowerCase() === "/compact"
            ? "Context compaction must run as a separate turn. Queue it or wait for the active turn to finish."
            : "Signing out must run as a separate turn. Queue it or wait for the active turn to finish.",
      });
    }
    if (parseGoalCommand(message) !== null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause:
          "Goal commands must run as a separate turn. Queue it or wait for the active turn to finish.",
      });
    }
  });

  const dispatchSteerIntoRun = Effect.fn("Orchestrator.dispatchSteerIntoRun")(function* (input: {
    readonly command: Extract<
      OrchestrationV2Command,
      { readonly type: "message.dispatch" | "queued-message.promote-to-steer" }
    >;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>;
    readonly projection: Pick<
      OrchestrationV2ThreadProjection,
      | "runs"
      | "messages"
      | "providerSessions"
      | "providerThreads"
      | "providerTurns"
      | "subagents"
      | "attempts"
      | "nodes"
      | "thread"
      | "turnItems"
    >;
    readonly modelSelection: ModelSelection;
    readonly targetRunId: OrchestrationV2Run["id"];
    readonly messageId: OrchestrationV2ConversationMessage["id"];
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
    readonly context?: import("@zerocode/contracts").OrchestrationMessageContext | undefined;
    readonly createdBy: OrchestrationV2ConversationMessage["createdBy"];
    readonly creationSource: OrchestrationV2ConversationMessage["creationSource"];
    readonly scheduledTaskId?: OrchestrationV2ConversationMessage["scheduledTaskId"];
    readonly senderThreadId?: OrchestrationV2ConversationMessage["senderThreadId"];
    readonly linkedSender?: OrchestrationV2ConversationMessage["linkedSender"];
    readonly idleCompaction?: OrchestrationV2ConversationMessage["idleCompaction"];
    readonly delegatedCompletion?: OrchestrationV2ConversationMessage["delegatedCompletion"];
    readonly notification?: OrchestrationV2ConversationMessage["notification"];
    readonly forceRestart: boolean;
  }) {
    const targetRun = input.projection.runs.find((candidate) => candidate.id === input.targetRunId);
    if (targetRun === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: input.command.commandId,
        commandType: input.command.type,
        cause: `Target run ${input.targetRunId} was not found.`,
      });
    }
    yield* ensureSteeringMessage(input.command, input);
    // An explicit restart already gives up the turn, so only steering holds commands back.
    if (!input.forceRestart && isSlashCommand(input)) {
      return yield* new OrchestratorDispatchError({
        commandId: input.command.commandId,
        commandType: input.command.type,
        cause:
          "Commands must run as a separate turn. Queue it or wait for the active turn to finish.",
      });
    }
    const targetMessage = input.projection.messages.find(
      (message) => message.id === targetRun.userMessageId,
    );
    if (targetMessage !== undefined && isNativeMaintenanceCommand(targetMessage)) {
      return yield* new OrchestratorDispatchError({
        commandId: input.command.commandId,
        commandType: input.command.type,
        cause:
          targetMessage.text.trim().toLowerCase() === "/compact"
            ? "Wait for context compaction to finish before steering the thread."
            : "Wait for sign-out to finish before steering the thread.",
      });
    }
    const rootNodeId = targetRun.rootNodeId;
    if (rootNodeId === null) {
      return yield* new OrchestratorDispatchError({
        commandId: input.command.commandId,
        commandType: input.command.type,
        cause: `Target run ${targetRun.id} has no root node.`,
      });
    }
    if (targetRun.status !== "running") {
      return yield* new OrchestratorDispatchError({
        commandId: input.command.commandId,
        commandType: input.command.type,
        cause: `Target run ${targetRun.id} is ${targetRun.status} and cannot be steered.`,
      });
    }
    // The run reads as running until its provider stops, but a steer accepted
    // after Stop never reaches the agent.
    if (yield* stopReachedRun(input.command, input.command.threadId, targetRun.id)) {
      return yield* new OrchestratorDispatchError({
        commandId: input.command.commandId,
        commandType: input.command.type,
        cause: `Target run ${targetRun.id} is stopping and cannot be steered.`,
      });
    }
    const providerThread = input.projection.providerThreads.find(
      (candidate) => candidate.id === targetRun.providerThreadId,
    );
    if (providerThread === undefined || providerThread.providerSessionId === null) {
      return yield* new OrchestratorDispatchError({
        commandId: input.command.commandId,
        commandType: input.command.type,
        cause: `Provider thread ${targetRun.providerThreadId} has no active provider session for steering.`,
      });
    }
    const providerSessionId = providerThread.providerSessionId;
    const providerTurn = input.projection.providerTurns.find(
      (candidate) =>
        candidate.runAttemptId === targetRun.activeAttemptId && candidate.status === "running",
    );
    if (providerTurn === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: input.command.commandId,
        commandType: input.command.type,
        cause: `No running provider turn found for active run ${targetRun.id}.`,
      });
    }
    const sessionOption = yield* providerSessions.get(providerSessionId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorDispatchError({
            commandId: input.command.commandId,
            commandType: input.command.type,
            cause,
          }),
      ),
    );
    if (Option.isNone(sessionOption)) {
      return yield* new OrchestratorDispatchError({
        commandId: input.command.commandId,
        commandType: input.command.type,
        cause: `Provider session ${providerThread.providerSessionId} is not active.`,
      });
    }

    const session = sessionOption.value;
    const now = yield* DateTime.now;
    const emitEvent = emit(input.events, input.command);
    const selectionChanged = !modelSelectionsEqual(targetRun.modelSelection, input.modelSelection);
    const providerInstanceChanged =
      targetRun.providerInstanceId !== input.modelSelection.instanceId;
    const selectionTransition =
      selectionChanged && !providerInstanceChanged
        ? yield* providerAdapters.get(targetRun.providerInstanceId).pipe(
            Effect.flatMap((adapter) =>
              adapter.planSelectionTransition({
                current: targetRun.modelSelection,
                target: input.modelSelection,
                sessionCapabilities: session.providerSession.capabilities,
              }),
            ),
            Effect.mapError(
              (cause) =>
                new OrchestratorProviderAdapterError({
                  commandId: input.command.commandId,
                  providerInstanceId: targetRun.providerInstanceId,
                  cause,
                }),
            ),
          )
        : null;
    if (selectionTransition?.type === "reject") {
      return yield* new OrchestratorDispatchError({
        commandId: input.command.commandId,
        commandType: input.command.type,
        cause: selectionTransition.reason,
      });
    }
    const appendSteeringMessage = Effect.fn("Orchestrator.appendSteeringMessage")(
      function* (messageInput: {
        readonly runId: OrchestrationV2Run["id"];
        readonly nodeId: OrchestrationV2ExecutionNode["id"];
        readonly providerTurnId: typeof providerTurn.id | null;
        readonly providerThreadId: OrchestrationV2ProviderThread["id"];
        readonly providerInstanceId: ProviderInstanceId;
        readonly modelSwitch?: OrchestrationV2ModelSwitch | undefined;
        readonly ordinal?: number;
      }) {
        const message: OrchestrationV2ConversationMessage = {
          createdBy: input.createdBy,
          creationSource: input.creationSource,
          ...(input.delegatedCompletion === undefined
            ? {}
            : { delegatedCompletion: input.delegatedCompletion }),
          ...(input.notification === undefined ? {} : { notification: input.notification }),
          ...(input.scheduledTaskId === undefined
            ? {}
            : { scheduledTaskId: input.scheduledTaskId }),
          ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
          ...(input.linkedSender === undefined ? {} : { linkedSender: input.linkedSender }),
          ...(input.idleCompaction === undefined ? {} : { idleCompaction: input.idleCompaction }),
          id: input.messageId,
          threadId: input.command.threadId,
          runId: messageInput.runId,
          nodeId: messageInput.nodeId,
          role: "user",
          text: input.text,
          attachments: input.attachments,
          ...(input.context ? { context: input.context } : {}),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        };
        const turnItem: OrchestrationV2TurnItem = {
          createdBy: input.createdBy,
          creationSource: input.creationSource,
          ...(input.scheduledTaskId === undefined
            ? {}
            : { scheduledTaskId: input.scheduledTaskId }),
          ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
          ...(input.linkedSender === undefined ? {} : { linkedSender: input.linkedSender }),
          ...(input.idleCompaction === undefined ? {} : { idleCompaction: input.idleCompaction }),
          id: idAllocator.derive.userTurnItem({ messageId: input.messageId }),
          threadId: input.command.threadId,
          runId: messageInput.runId,
          nodeId: messageInput.nodeId,
          providerThreadId: messageInput.providerThreadId,
          providerTurnId: messageInput.providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: messageInput.ordinal ?? (yield* nextTurnItemOrdinal(input.projection)),
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: input.messageId,
          inputIntent:
            input.command.type === "queued-message.promote-to-steer"
              ? "promoted_queued_to_steer"
              : "steer",
          text: input.text,
          attachments: input.attachments,
          ...(input.context ? { context: input.context } : {}),
          ...(messageInput.modelSwitch === undefined
            ? {}
            : { modelSwitch: messageInput.modelSwitch }),
        };
        yield* emitEvent({
          type: "message.updated",
          threadId: input.command.threadId,
          runId: messageInput.runId,
          nodeId: messageInput.nodeId,
          providerInstanceId: messageInput.providerInstanceId,
          occurredAt: now,
          payload: message,
        });
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: input.command.threadId,
          runId: messageInput.runId,
          nodeId: messageInput.nodeId,
          providerInstanceId: messageInput.providerInstanceId,
          occurredAt: now,
          payload: notificationTurnItem(
            turnItem,
            message,
            yield* notificationTasks(input.command.threadId, message, input.projection.subagents),
          ),
        });
      },
    );

    // A selection the provider applies on its next turn joins the running
    // turn as a steer and waits for the next turn. Restarting the turn for it
    // would end the turn's native subagents, which a steer must never do.
    const selectionMustApplyNow =
      selectionChanged &&
      (providerInstanceChanged || selectionTransition?.type !== "apply_on_next_turn");
    const attachmentsNeedRestart =
      input.attachments.length > 0 &&
      session.providerSession.capabilities.turns.activeSteeringAcceptsAttachments === false;
    const steeringPolicy = yield* mapDispatchError(input.command)(
      commandPolicy.decideSteeringExecution({
        commandId: input.command.commandId,
        threadId: input.command.threadId,
        providerInstanceId: targetRun.providerInstanceId,
        capabilities: session.providerSession.capabilities,
        forceRestart: input.forceRestart || selectionMustApplyNow || attachmentsNeedRestart,
      }),
    );

    if (steeringPolicy === "active_steering") {
      yield* refuseAboveDispatchModeLimit(
        input.command,
        input.command.threadId,
        turnStartedModes(input.projection.attempts, targetRun),
      );
      const instanceChanged =
        input.projection.thread.providerInstanceId !== input.modelSelection.instanceId;
      // Only a user's steer carries the picker's selection; the adapter applies it to the live turn.
      const steerCarriesSelection =
        input.delegatedCompletion === undefined && input.notification === undefined;
      if (
        steerCarriesSelection &&
        (instanceChanged ||
          !modelSelectionsEqual(input.projection.thread.modelSelection, input.modelSelection))
      ) {
        yield* emitEvent({
          type: instanceChanged ? "thread.provider-switched" : "thread.model-selection-updated",
          threadId: input.command.threadId,
          providerInstanceId: input.modelSelection.instanceId,
          occurredAt: now,
          payload: {
            ...input.projection.thread,
            providerInstanceId: input.modelSelection.instanceId,
            modelSelection: input.modelSelection,
            updatedAt: now,
          },
        });
      }
      yield* appendSteeringMessage({
        runId: targetRun.id,
        nodeId: rootNodeId,
        providerTurnId: providerTurn.id,
        providerThreadId: providerThread.id,
        providerInstanceId: targetRun.providerInstanceId,
      });
      yield* Ref.update(input.effects, (existing) => [
        ...existing,
        {
          id: `effect:${input.command.commandId}:provider-turn.steer:${providerTurn.id}`,
          commandId: input.command.commandId,
          threadId: input.command.threadId,
          request: {
            type: "provider-turn.steer",
            providerSessionId,
            providerThreadId: providerThread.id,
            providerTurnId: providerTurn.id,
            messageId: input.messageId,
            ...(steerCarriesSelection ? { modelSelection: input.modelSelection } : {}),
            steerFollowUpAfterRunOrdinal: Math.max(
              0,
              ...input.projection.runs.map((run) => run.ordinal),
            ),
          },
        } satisfies PendingOrchestrationEffectV2,
      ]);
      return;
    }

    const currentAttempt = input.projection.attempts.find(
      (candidate) => candidate.id === targetRun.activeAttemptId,
    );
    const currentRootNode = input.projection.nodes.find((candidate) => candidate.id === rootNodeId);
    const attemptOrdinal =
      Math.max(
        0,
        ...input.projection.attempts
          .filter((candidate) => candidate.runId === targetRun.id)
          .map((candidate) => candidate.attemptOrdinal),
      ) + 1;
    const nextAttemptId = idAllocator.derive.runAttempt({
      runId: targetRun.id,
      attemptOrdinal,
    });
    const nextRootNodeId = idAllocator.derive.rootNodeAttempt({
      runId: targetRun.id,
      attemptOrdinal,
    });
    let restartProviderThread = providerThread;
    let restartSessionTransition:
      | {
          readonly type: "replace";
          readonly replacementProviderSessionId: ProviderSessionId;
        }
      | { readonly type: "detach" }
      | null = null;
    let restartHandoff: OrchestrationV2ContextHandoff | null = null;
    let restartTransfer: OrchestrationV2ContextTransfer | null = null;
    const canResumeAcrossInstances =
      providerInstanceChanged &&
      providerThread.nativeThreadRef !== null &&
      (yield* providerSwitchService
        .plan({
          projection: {
            ...input.projection,
            thread: { ...input.projection.thread, modelSelection: targetRun.modelSelection },
          },
          targetModelSelection: input.modelSelection,
        })
        .pipe(mapDispatchError(input.command))).transition.type === "restart_and_resume";
    const requiresProviderThreadHandoff =
      (providerInstanceChanged && !canResumeAcrossInstances) ||
      selectionTransition?.type === "create_with_handoff";
    const requiresProviderSessionRestart =
      canResumeAcrossInstances || selectionTransition?.type === "restart_session";
    if (requiresProviderThreadHandoff) {
      const targetAdapter = yield* providerAdapters.get(input.modelSelection.instanceId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProviderAdapterError({
              commandId: input.command.commandId,
              providerInstanceId: input.modelSelection.instanceId,
              cause,
            }),
        ),
      );
      const targetCapabilities = yield* targetAdapter.getCapabilities().pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProviderAdapterError({
              commandId: input.command.commandId,
              providerInstanceId: input.modelSelection.instanceId,
              cause,
            }),
        ),
      );
      yield* mapDispatchError(input.command)(
        commandPolicy.ensureContextHandoff({
          commandId: input.command.commandId,
          threadId: input.command.threadId,
          providerInstanceId: input.modelSelection.instanceId,
          capabilities: targetCapabilities,
          strategy: "full_thread_summary",
        }),
      );
      const existingTargetProviderThread = rootProviderThreadsForProvider(
        input.projection,
        input.modelSelection.instanceId,
      ).find((candidate) => candidate.id !== providerThread.id);
      const targetProviderSessionId =
        existingTargetProviderThread?.providerSessionId ??
        (yield* mapDispatchError(input.command)(
          providerSessionIdFor({
            adapter: targetAdapter,
            providerInstanceId: input.modelSelection.instanceId,
            threadId: input.command.threadId,
          }),
        ));
      const targetProviderThreadBase: OrchestrationV2ProviderThread =
        existingTargetProviderThread === undefined
          ? {
              id: idAllocator.derive.providerThread({
                driver: targetAdapter.driver,
                nativeThreadId: `pending:${targetRun.id}:attempt:${attemptOrdinal}`,
              }),
              driver: targetAdapter.driver,
              providerInstanceId: input.modelSelection.instanceId,
              providerSessionId: targetProviderSessionId,
              appThreadId: input.command.threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "not_loaded",
              firstRunOrdinal: targetRun.ordinal,
              lastRunOrdinal: targetRun.ordinal,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }
          : {
              ...existingTargetProviderThread,
              providerSessionId: targetProviderSessionId,
              lastRunOrdinal: targetRun.ordinal,
              updatedAt: now,
            };
      const transferId = yield* mapDispatchError(input.command)(
        idAllocator.allocate.contextTransfer({
          sourceThreadId: input.command.threadId,
          targetThreadId: input.command.threadId,
          type: "provider_handoff",
        }),
      );
      const contextBoundary = contextBoundaryOrdinal(input.projection);
      restartHandoff = yield* contextHandoffService
        .prepareProviderHandoff({
          threadId: input.command.threadId,
          targetRunId: targetRun.id,
          transferId,
          fromProviderThreadIds: [providerThread.id],
          toProviderThreadId: targetProviderThreadBase.id,
          fromProviderInstanceId: targetRun.providerInstanceId,
          toProviderInstanceId: input.modelSelection.instanceId,
          coveredRunOrdinals: { from: Math.max(1, contextBoundary), to: targetRun.ordinal },
          strategy: "full_thread_summary",
          items: yield* readHandoffItems(
            input.command.threadId,
            contextBoundary === 0
              ? undefined
              : input.projection.runs
                  .filter((run) => run.ordinal >= contextBoundary)
                  .map((run) => run.id),
          ),
          runs: input.projection.runs,
          createdAt: now,
        })
        .pipe(mapDispatchError(input.command));
      restartProviderThread = {
        ...targetProviderThreadBase,
        handoffIds: Array.from(
          new Set([...targetProviderThreadBase.handoffIds, restartHandoff.id]),
        ),
      };
      restartTransfer = {
        id: transferId,
        type: "provider_handoff",
        sourceThreadId: input.command.threadId,
        targetThreadId: input.command.threadId,
        sourcePoint: contextSourcePointForRun(input.projection, targetRun),
        basePoint: null,
        sourceProviderInstanceId: targetRun.providerInstanceId,
        targetProviderInstanceId: input.modelSelection.instanceId,
        targetRunId: targetRun.id,
        status: "consumed",
        resolution: {
          strategy: "portable_context",
          contextHandoffId: restartHandoff.id,
        },
        createdBy: input.createdBy,
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: now,
      };
      restartSessionTransition = { type: "detach" };
    } else if (requiresProviderSessionRestart) {
      const nextProviderSessionId = yield* mapDispatchError(input.command)(
        idAllocator.allocate.providerSession({
          providerInstanceId: input.modelSelection.instanceId,
          threadId: input.command.threadId,
        }),
      );
      restartProviderThread = {
        ...providerThread,
        providerInstanceId: input.modelSelection.instanceId,
        providerSessionId: nextProviderSessionId,
        status: "not_loaded",
        updatedAt: now,
      };
      restartSessionTransition = {
        type: "replace",
        replacementProviderSessionId: nextProviderSessionId,
      };
    }
    const resolvedRuntimePolicy = yield* runtimePolicy
      .resolve({ thread: input.projection.thread, modelSelection: input.modelSelection })
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: input.command.commandId,
              commandType: input.command.type,
              cause,
            }),
        ),
      );
    const checkpointScope = yield* checkpointService
      .prepareRootRunScope({
        threadId: input.command.threadId,
        runId: targetRun.id,
        rootNodeId: nextRootNodeId,
        providerThreadId: restartProviderThread.id,
        cwd:
          resolvedRuntimePolicy.cwd ??
          input.projection.thread.worktreePath ??
          session.providerSession.cwd,
        createdAt: now,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: input.command.commandId,
              commandType: input.command.type,
              cause,
            }),
        ),
      );
    const restartedRun: OrchestrationV2Run = {
      ...targetRun,
      providerInstanceId: input.modelSelection.instanceId,
      modelSelection: input.modelSelection,
      providerThreadId: restartProviderThread.id,
      rootNodeId: nextRootNodeId,
      activeAttemptId: nextAttemptId,
      userMessageId: input.messageId,
      status: "starting",
      contextHandoffId: restartHandoff?.id ?? targetRun.contextHandoffId,
    };
    const nextAttempt: OrchestrationV2RunAttempt = {
      id: nextAttemptId,
      runId: targetRun.id,
      attemptOrdinal,
      rootNodeId: nextRootNodeId,
      providerInstanceId: input.modelSelection.instanceId,
      providerThreadId: restartProviderThread.id,
      providerTurnId: null,
      reason: "steering_restart",
      status: "pending",
      startedAt: null,
      completedAt: null,
    };
    const nextRootNode: OrchestrationV2ExecutionNode = {
      id: nextRootNodeId,
      threadId: input.command.threadId,
      runId: targetRun.id,
      parentNodeId: null,
      rootNodeId: nextRootNodeId,
      kind: "root_turn",
      status: "pending",
      countsForRun: true,
      providerThreadId: restartProviderThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: checkpointScope.id,
      startedAt: null,
      completedAt: null,
    };
    if (currentAttempt !== undefined) {
      yield* emitEvent({
        type: "run-attempt.updated",
        threadId: input.command.threadId,
        runId: targetRun.id,
        nodeId: rootNodeId,
        providerInstanceId: targetRun.providerInstanceId,
        occurredAt: now,
        payload: { ...currentAttempt, status: "superseded", completedAt: now },
      });
    }
    if (currentRootNode !== undefined) {
      yield* emitEvent({
        type: "node.updated",
        threadId: input.command.threadId,
        runId: targetRun.id,
        nodeId: rootNodeId,
        providerInstanceId: targetRun.providerInstanceId,
        occurredAt: now,
        payload: { ...currentRootNode, status: "interrupted", completedAt: now },
      });
    }
    if (selectionChanged) {
      yield* emitEvent({
        type: providerInstanceChanged
          ? "thread.provider-switched"
          : "thread.model-selection-updated",
        threadId: input.command.threadId,
        providerInstanceId: input.modelSelection.instanceId,
        occurredAt: now,
        payload: {
          ...input.projection.thread,
          providerInstanceId: input.modelSelection.instanceId,
          modelSelection: input.modelSelection,
          updatedAt: now,
        },
      });
    }
    if (requiresProviderThreadHandoff || requiresProviderSessionRestart) {
      yield* emitEvent({
        type: "provider-thread.updated",
        threadId: input.command.threadId,
        driver: restartProviderThread.driver,
        providerInstanceId: input.modelSelection.instanceId,
        occurredAt: now,
        payload: restartProviderThread,
      });
    }
    if (restartHandoff !== null) {
      yield* emitEvent({
        type: "context-handoff.updated",
        threadId: input.command.threadId,
        runId: targetRun.id,
        providerInstanceId: input.modelSelection.instanceId,
        occurredAt: now,
        payload: restartHandoff,
      });
    }
    if (restartTransfer !== null) {
      yield* emitEvent({
        type: "context-transfer.created",
        threadId: input.command.threadId,
        runId: targetRun.id,
        providerInstanceId: input.modelSelection.instanceId,
        occurredAt: now,
        payload: restartTransfer,
      });
    }
    yield* emitEvent({
      type: "run.updated",
      threadId: input.command.threadId,
      runId: targetRun.id,
      nodeId: nextRootNodeId,
      providerInstanceId: input.modelSelection.instanceId,
      occurredAt: now,
      payload: restartedRun,
    });
    yield* emitEvent({
      type: "run-attempt.created",
      threadId: input.command.threadId,
      runId: targetRun.id,
      nodeId: nextRootNodeId,
      providerInstanceId: input.modelSelection.instanceId,
      occurredAt: now,
      payload: nextAttempt,
    });
    yield* emitEvent({
      type: "node.updated",
      threadId: input.command.threadId,
      runId: targetRun.id,
      nodeId: nextRootNodeId,
      providerInstanceId: input.modelSelection.instanceId,
      occurredAt: now,
      payload: nextRootNode,
    });
    yield* emitEvent({
      type: "checkpoint-scope.created",
      threadId: input.command.threadId,
      runId: targetRun.id,
      nodeId: nextRootNodeId,
      providerInstanceId: input.modelSelection.instanceId,
      occurredAt: now,
      payload: checkpointScope,
    });
    // The restart replaces the run's input, so the wake it was running can no longer be
    // settled at its terminal. Its provider turn was running, so the wake already landed.
    yield* callbacks.acceptDelegatedCompletionDelivery({
      command: input.command,
      events: input.events,
      projection: input.projection,
      messageId: targetRun.userMessageId,
      now,
    });
    const steeringOrdinal = yield* nextTurnItemOrdinal(input.projection);
    if (restartHandoff !== null) {
      const covered = restartHandoff.coveredRunOrdinals;
      const coveredRuns = input.projection.runs.filter(
        (run) => run.ordinal >= covered.from && run.ordinal <= covered.to,
      );
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: input.command.threadId,
        runId: targetRun.id,
        nodeId: nextRootNodeId,
        providerInstanceId: input.modelSelection.instanceId,
        occurredAt: now,
        payload: {
          id: idAllocator.derive.runSignalTurnItem({
            runId: targetRun.id,
            signal: `context-handoff:${restartHandoff.id}`,
          }),
          threadId: input.command.threadId,
          runId: targetRun.id,
          nodeId: nextRootNodeId,
          providerThreadId: restartProviderThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: steeringOrdinal,
          status: "completed",
          title: "Provider handoff",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "handoff",
          contextHandoffId: restartHandoff.id,
          fromProviderThreadIds: restartHandoff.fromProviderThreadIds,
          toProviderThreadId: restartHandoff.toProviderThreadId,
          fromProviderInstanceIds: Array.from(
            new Set(coveredRuns.map((run) => run.providerInstanceId)),
          ),
          toProviderInstanceId: input.modelSelection.instanceId,
          fromModelSelections: Array.from(
            new Map(
              coveredRuns.map((run) => [
                `${run.modelSelection.instanceId}\0${run.modelSelection.model}`,
                run.modelSelection,
              ]),
            ).values(),
          ),
          toModel: input.modelSelection.model,
          strategy: restartHandoff.strategy,
          summary: restartHandoff.summaryText,
        },
      });
    }
    yield* appendSteeringMessage({
      runId: targetRun.id,
      nodeId: nextRootNodeId,
      providerTurnId: null,
      providerThreadId: restartProviderThread.id,
      providerInstanceId: input.modelSelection.instanceId,
      // Measured on the pre-restart projection, so the rewritten run is not its own baseline.
      ...(restartHandoff === null ? modelSwitchSince(input.projection, input.modelSelection) : {}),
      ordinal: restartHandoff === null ? steeringOrdinal : steeringOrdinal + 1,
    });
    const interruptedAttemptId = targetRun.activeAttemptId;
    if (interruptedAttemptId === null) {
      return yield* new OrchestratorDispatchError({
        commandId: input.command.commandId,
        commandType: input.command.type,
        cause: `Active run ${targetRun.id} has no attempt to interrupt.`,
      });
    }
    yield* Ref.update(input.effects, (existing) => [
      ...existing,
      {
        id: `effect:${input.command.commandId}:provider-turn.restart:${providerTurn.id}`,
        commandId: input.command.commandId,
        threadId: input.command.threadId,
        request: {
          type: "provider-turn.restart",
          providerSessionId,
          providerThreadId: providerThread.id,
          providerTurnId: providerTurn.id,
          interruptedAttemptId,
          runId: targetRun.id,
          ...(restartSessionTransition === null
            ? {}
            : { sessionTransition: restartSessionTransition }),
        },
      } satisfies PendingOrchestrationEffectV2,
    ]);
  });

  const dispatchMessage = Effect.fn("Orchestrator.dispatchMessage")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    // A compacted thread reads every run, but attempts, nodes, messages, provider turns and prompts
    // only for its recent runs and the runs this command names. An idle compaction reads in full:
    // its busy check below looks for a delegated result's message under any old run.
    let projection = yield* getProjectionWithPendingEvents(
      command.threadId,
      events,
      command.idleCompaction === undefined
        ? {
            keepRunIds: [
              command.manualContinuationOfRunId,
              command.restartContinuationOfRunId,
              command.usageLimitContinuationOfRunId,
              command.steerFollowUpOfRunId,
              ...(command.dispatchMode.type === "steer_active" ||
              command.dispatchMode.type === "restart_active"
                ? [command.dispatchMode.targetRunId]
                : []),
            ].flatMap((runId) => (runId === undefined ? [] : [runId])),
            keepMessageId: command.messageId,
          }
        : undefined,
    );
    if (command.steerFollowUpOfRunId !== undefined) {
      const source = projection.runs.find((run) => run.id === command.steerFollowUpOfRunId);
      if (
        source === undefined ||
        command.dispatchMode.type !== "queue_after_active" ||
        !projection.messages.some(
          (message) => message.id === command.messageId && message.runId === source.id,
        ) ||
        projection.thread.archivedAt !== null ||
        projection.thread.deletedAt !== null ||
        (yield* stopReachedRun(command, command.threadId, source.id))
      ) {
        yield* emit(
          events,
          command,
        )({
          type: "thread.metadata-updated",
          threadId: command.threadId,
          occurredAt: yield* DateTime.now,
          payload: projection.thread,
        });
        return;
      }
    }
    if (yield* callbacks.isStaleQuestionWake(projection, command.messageId, command.notification)) {
      yield* emit(
        events,
        command,
      )({
        type: "thread.metadata-updated",
        threadId: command.threadId,
        occurredAt: yield* DateTime.now,
        payload: projection.thread,
      });
      return;
    }
    const activeProviderInstanceId = projection.providerThreads.find(
      (candidate) => candidate.id === projection.thread.activeProviderThreadId,
    )?.providerInstanceId;
    // Another provider is handed what ran since it last saw the thread, which can be older than
    // the compaction, so a provider switch reads the whole history.
    if (
      activeProviderInstanceId !== undefined &&
      activeProviderInstanceId !==
        (command.modelSelection ?? projection.thread.modelSelection).instanceId
    ) {
      projection = yield* getProjectionWithPendingEvents(command.threadId, events);
    }
    if (command.manualContinuationOfRunId !== undefined) {
      const source = projection.runs.find((run) => run.id === command.manualContinuationOfRunId);
      const limited = latestRootProviderFailure(source ?? null, projection.turnItems);
      if (
        command.dispatchMode.type !== "start_immediately" ||
        source === undefined ||
        (source.status !== "interrupted" &&
          !(source.status === "failed" && limited?.class === "usage_limit")) ||
        latestExecutedRun(projection.runs)?.id !== source.id ||
        projection.thread.archivedAt !== null ||
        projection.thread.deletedAt !== null ||
        projection.runtimeRequests.some((request) => request.status === "pending")
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "This thread can no longer be resumed from that run.",
        });
      }
    }
    if (command.usageLimitContinuationOfRunId !== undefined) {
      const run = usageLimitBlockedRun(projection.runs, projection.turnItems, null);
      const failure = latestRootProviderFailure(run, projection.turnItems);
      const recovery = projection.thread.limitRecovery;
      const now = yield* DateTime.now;
      if (
        run?.id !== command.usageLimitContinuationOfRunId ||
        failure?.class !== "usage_limit" ||
        threadShellFromProjection(projection).lastErrorClass !== "usage_limit" ||
        !recovery?.autoResume ||
        recovery.requestId !== command.usageLimitRecoveryRequestId ||
        recovery.runId !== run.id ||
        recovery.resetAt !== failure.resetAt ||
        Date.parse(recovery.resetAt) > DateTime.toEpochMillis(now) ||
        projection.thread.archivedAt !== null ||
        projection.thread.deletedAt !== null ||
        projection.thread.settledOverride === "settled" ||
        projection.thread.providerInstanceId !== run.providerInstanceId ||
        projection.runtimeRequests.some((request) => request.status === "pending") ||
        (projection.thread.snoozedUntil != null &&
          DateTime.toEpochMillis(projection.thread.snoozedUntil) > DateTime.toEpochMillis(now))
      ) {
        yield* emit(
          events,
          command,
        )({
          type: "thread.metadata-updated",
          threadId: command.threadId,
          occurredAt: now,
          payload: {
            ...projection.thread,
            ...(recovery?.autoResume &&
            recovery.requestId === command.usageLimitRecoveryRequestId &&
            recovery.runId === command.usageLimitContinuationOfRunId &&
            projection.thread.snoozedUntil != null &&
            DateTime.toEpochMillis(projection.thread.snoozedUntil) > DateTime.toEpochMillis(now)
              ? { limitRecovery: { ...recovery, requestId: command.commandId } }
              : {}),
          },
        });
        return;
      }
    }

    if (command.restartContinuationOfRunId !== undefined) {
      const source = projection.runs.find((run) => run.id === command.restartContinuationOfRunId);
      if (
        !source ||
        !(
          isRestartContinuationSource(source, projection.providerTurns) ||
          continuationFailedBeforePrompt(source, projection.providerTurns)
        ) ||
        projection.thread.archivedAt !== null ||
        projection.thread.deletedAt !== null ||
        projection.thread.providerInstanceId !== source.providerInstanceId ||
        projection.runs.some(
          (run) =>
            run.id !== source.id &&
            run.status !== "queued" &&
            !cancelledBeforeStart(run) &&
            runRanAfter(run, source),
        ) ||
        (yield* stopReachedRun(command, command.threadId, source.id))
      ) {
        // Preserve the current row so stale automatic deliveries receive an
        // accepted receipt without changing work or repeatedly retrying.
        yield* emit(
          events,
          command,
        )({
          type: "thread.metadata-updated",
          threadId: command.threadId,
          occurredAt: yield* DateTime.now,
          payload: projection.thread,
        });
        return;
      }
    }

    // The service checked idleness before this command; a run or a delegated result that landed
    // since makes the thread busy, and that turn refreshes the cache anyway.
    if (
      command.idleCompaction === "beforeCacheExpires" &&
      projection.runs.some(
        (run) =>
          run.status === "queued" ||
          isActiveRun(run) ||
          (run.delegatedCompletion?.disposition === "open" &&
            run.delegatedCompletion.delivery !== null &&
            !projection.messages.some(
              (message) => message.id === run.delegatedCompletion?.delivery?.messageId,
            )),
      )
    ) {
      yield* emit(
        events,
        command,
      )({
        type: "thread.metadata-updated",
        threadId: command.threadId,
        occurredAt: yield* DateTime.now,
        payload: projection.thread,
      });
      return;
    }

    if (projection.thread.lastVisitedAt === null && !isNativeMaintenanceCommand(command)) {
      const now = yield* DateTime.now;
      // Null keeps imported history read. The first fresh dispatch establishes
      // a read watermark so its completion can be unread on every client.
      // Offset it so a completion in the same millisecond is still unread.
      const event = yield* emit(
        events,
        command,
      )({
        type: "thread.metadata-updated",
        threadId: command.threadId,
        providerInstanceId: projection.thread.providerInstanceId,
        occurredAt: now,
        payload: {
          ...projection.thread,
          lastVisitedAt: DateTime.subtract(now, { milliseconds: 1 }),
        },
      });
      projection = applyToProjection(projection, event);
    }

    // A run the thread queues for itself continues the task of the run that sent it.
    const continuedTaskId = projection.runs.find((run) =>
      command.restartContinuationOfRunId === undefined
        ? command.senderThreadId === command.threadId && isActiveRun(run)
        : run.id === command.restartContinuationOfRunId,
    )?.delegatedTaskId;

    if (projection.thread.settledOverride !== null) {
      const now = yield* DateTime.now;
      const thread: OrchestrationV2AppThread = {
        ...projection.thread,
        settledOverride: null,
        settledAt: null,
        unsettledAt:
          projection.thread.settledOverride === "active"
            ? (projection.thread.unsettledAt ?? null)
            : now,
        updatedAt: now,
      };
      const event = yield* emit(
        events,
        command,
      )({
        type: "thread.unsettled",
        threadId: command.threadId,
        providerInstanceId: thread.providerInstanceId,
        occurredAt: now,
        payload: thread,
      });
      projection = applyToProjection(projection, event);
    }
    // Background wakes and delegated completions continue work the user already snoozed, so
    // only a message someone actually sent ends the snooze.
    const automaticWake =
      command.notification !== undefined || command.delegatedCompletion !== undefined;
    if (projection.thread.snoozedUntil != null && !automaticWake) {
      const now = yield* DateTime.now;
      const thread: OrchestrationV2AppThread = {
        ...projection.thread,
        snoozedUntil: null,
        snoozedAt: null,
        updatedAt: now,
      };
      const event = yield* emit(
        events,
        command,
      )({
        type: "thread.unsnoozed",
        threadId: command.threadId,
        providerInstanceId: thread.providerInstanceId,
        occurredAt: now,
        payload: thread,
      });
      projection = applyToProjection(projection, event);
    }
    const userMessages = projection.messages.filter((message) => message.role === "user");
    // The recent runs of a compacted thread can hold only a `/compact` while an older prompt
    // exists, so when every loaded prompt is one, every user message is checked.
    const onlyMaintenanceHistory = [
      ...userMessages,
      ...projection.turnItems.flatMap((item) => (item.type === "user_message" ? [item] : [])),
    ].every(isNativeMaintenanceCommand)
      ? projectionStore
          .getThreadRecords(command.threadId, ["messages"], { messageRoles: ["user"] })
          .pipe(
            // A thread this command creates has no stored messages yet.
            Effect.catchTags({
              ProjectionStoreThreadNotFoundError: () => Effect.succeed({ messages: [] }),
            }),
            Effect.map(({ messages }) => [...messages, ...userMessages]),
            Effect.map((all) => all.length > 0 && all.every(isNativeMaintenanceCommand)),
            mapDispatchError(command),
          )
      : Effect.succeed(false);
    // A thread named before its first message (for example by an MCP launch that tracks an issue)
    // keeps that name instead of a title generated from a terse prompt such as "work on this".
    const seedsUntitledThread =
      command.titleSeed !== undefined &&
      (yield* projectionStore.getMessageCount(command.threadId).pipe(mapDispatchError(command))) ===
        0 &&
      !hasTitleSetBeforeFirstMessage(projection.thread, command.titleSeed);
    if (
      !isNativeMaintenanceCommand(command) &&
      (seedsUntitledThread ||
        (command.createdBy === "user" &&
          // A draft opened by `/compact` is titled after it, so only a chosen title stays here.
          projection.thread.titleRenamed !== true &&
          (yield* onlyMaintenanceHistory)))
    ) {
      const now = yield* DateTime.now;
      const thread: OrchestrationV2AppThread = {
        ...projection.thread,
        title: command.titleSeed ?? projection.thread.title,
        titleRegeneration: { requestId: command.commandId, startedAt: now },
        updatedAt: now,
      };
      const event = yield* emit(
        events,
        command,
      )({
        type: "thread.metadata-updated",
        threadId: command.threadId,
        providerInstanceId: thread.providerInstanceId,
        occurredAt: now,
        payload: thread,
      });
      yield* Ref.update(effects, (existing) => [
        ...existing,
        pendingThreadTitleGenerationEffect(command.commandId, command.threadId, {
          type: "initial",
          messageId: command.messageId,
        }),
      ]);
      projection = applyToProjection(projection, event);
    }
    let modelSelection = command.modelSelection ?? projection.thread.modelSelection;
    // Native goal commands must not steer an existing turn.
    const parsedGoalCommand = parseGoalCommand(command);
    const goalCommand =
      parsedGoalCommand === null ||
      (yield* goalDriverFor(command, modelSelection.instanceId)) === undefined
        ? null
        : parsedGoalCommand;
    // A goal command keeps the run it was sent at; the goal handling below queues it.
    let dispatchMode =
      goalCommand === null
        ? resolveMessageDispatch(projection, command)
        : resolveMessageDispatchIntent(projection, command.dispatchMode, command.deliveryIntent);
    if (dispatchMode.type === "steer_active" || dispatchMode.type === "restart_active") {
      const targetRunId = dispatchMode.targetRunId;
      const target = projection.runs.find((run) => run.id === targetRunId);
      const turn = latestProviderTurnForAttempt(
        projection.providerTurns.filter((candidate) => candidate.nodeId === target?.rootNodeId),
        target?.activeAttemptId,
      );
      // The client may still show a running turn while its completion is being
      // projected. Preserve the submission as a new turn when steering is too late.
      if (
        target !== undefined &&
        (target.status === "completed" ||
          (dispatchMode.type === "restart_active" && !isActiveRun(target)) ||
          ((target.status === "running" || target.status === "waiting") &&
            turn !== undefined &&
            (turn.status === "completed" ||
              (dispatchMode.type === "restart_active" &&
                turn.status !== "pending" &&
                turn.status !== "running"))))
      ) {
        dispatchMode = { type: "start_immediately" };
      }
    }
    // Stop leaves the run reading as running until its provider stops. A plain
    // send in that window queues behind the stopped queue instead of steering
    // text the agent never receives, and like any user send it releases the
    // hold; an explicit steer still fails below.
    if (
      command.deliveryIntent === "auto" &&
      (dispatchMode.type === "steer_active" || dispatchMode.type === "restart_active") &&
      (yield* stopReachedRun(command, command.threadId, dispatchMode.targetRunId))
    ) {
      dispatchMode = { type: "queue_after_active" };
    }
    // An agent's automatic send must not overtake its own earlier message still queued
    // (e.g. behind /compact), or the agent receives them out of send order.
    if (
      command.deliveryIntent === "auto" &&
      command.createdBy === "agent" &&
      (dispatchMode.type === "steer_active" || dispatchMode.type === "restart_active")
    ) {
      const queuedRuns = projection.runs.filter(
        (run) => run.status === "queued" && run.queueHeld !== true,
      );
      if (queuedRuns.length > 0) {
        const queuedMessages = yield* projectionStore
          .getMessagesById(
            command.threadId,
            queuedRuns.map((run) => run.userMessageId),
          )
          .pipe(mapDispatchError(command));
        if (
          [...queuedMessages.values()].some(
            (message) =>
              message.createdBy === "agent" && message.senderThreadId === command.senderThreadId,
          )
        ) {
          dispatchMode = { type: "queue_after_active" };
        }
      }
    }
    // An explicit restart that Stop reached has only its start left, so it
    // queues behind the stopping run like any other start.
    if (
      dispatchMode.type === "restart_active" &&
      (yield* stopReachedRun(command, command.threadId, dispatchMode.targetRunId))
    ) {
      dispatchMode = { type: "start_immediately" };
    }
    const freshContext = command.freshContext === true;
    // A result is asked of one whole turn, so a send that declares one never joins a running turn.
    // A run that continues one cut short still owes that run's result.
    const continuedRunId =
      command.restartContinuationOfRunId ??
      command.usageLimitContinuationOfRunId ??
      command.manualContinuationOfRunId;
    const outputSchema =
      command.outputSchema ??
      (continuedRunId === undefined
        ? undefined
        : projection.runs.find((run) => run.id === continuedRunId)?.outputSchema);
    const schemaProblem =
      command.outputSchema === undefined
        ? null
        : outputRequestProblem(command.outputSchema, command);
    if (schemaProblem !== null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: schemaProblem,
      });
    }
    const output = outputSchema === undefined ? {} : { outputSchema };
    if (
      (freshContext || command.outputSchema !== undefined) &&
      (dispatchMode.type === "steer_active" || dispatchMode.type === "restart_active")
    ) {
      dispatchMode = { type: "queue_after_active" };
    }
    let queuedRunStop:
      | { readonly runId: RunId; readonly reason: string; readonly skipsHeldQueue?: true }
      | undefined;
    if (goalCommand !== null) {
      // A goal command never joins a running turn. One that starts or ends goal
      // work stops the run and goes first in the queue; the rest wait. A send
      // that asked to be queued (no delivery intent) only queues, and a run
      // that is only finishing or running background work is never stopped.
      const resolvedMode = dispatchMode;
      const target =
        resolvedMode.type === "steer_active" || resolvedMode.type === "restart_active"
          ? projection.runs.find((run) => run.id === resolvedMode.targetRunId)
          : resolvedMode.type === "queue_after_active" && command.deliveryIntent !== undefined
            ? projection.runs.findLast(isLiveRun)
            : undefined;
      if (target !== undefined) {
        const goal = projection.providerThreads.find(
          (candidate) => candidate.id === target.providerThreadId,
        )?.goal;
        const targetMessage = projection.messages.find(
          (message) => message.id === target.userMessageId,
        );
        if (
          isLiveRun(target) &&
          goalCommandStopsActiveRun(goalCommand, goal?.status ?? null) &&
          (targetMessage === undefined || !isNativeMaintenanceCommand(targetMessage)) &&
          !(yield* stopReachedRun(command, command.threadId, target.id))
        ) {
          queuedRunStop = { runId: target.id, reason: "Stopped to apply /goal" };
        }
        dispatchMode = { type: "queue_after_active" };
      }
    }
    if (
      command.notification !== undefined &&
      (command.createdBy !== "agent" ||
        (command.creationSource !== "server" && command.creationSource !== "provider") ||
        (dispatchMode.type !== "queue_after_active" &&
          !(
            command.restartContinuationOfRunId !== undefined &&
            dispatchMode.type === "start_immediately"
          )))
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Notifications must be server- or provider-created queued messages.",
      });
    }
    let delegatedCompletion: OrchestrationV2ConversationMessage["delegatedCompletion"] | undefined;
    if (command.delegatedCompletion !== undefined) {
      const requestedCompletion = command.delegatedCompletion;
      if (
        command.createdBy !== "agent" ||
        command.creationSource !== "server" ||
        dispatchMode.type !== "queue_after_active"
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Delegated completion delivery must be a server-created queued message.",
        });
      }
      const parentRun = projection.runs.find(
        (candidate) => candidate.id === requestedCompletion.parentRunId,
      );
      const delivery = parentRun?.delegatedCompletion?.delivery;
      if (
        parentRun?.delegatedCompletion?.disposition !== "open" ||
        delivery === null ||
        delivery === undefined ||
        delivery.generation !== requestedCompletion.generation ||
        delivery.messageId !== command.messageId ||
        (projection.messages.some((candidate) => candidate.id === command.messageId) &&
          command.steerFollowUpOfRunId === undefined &&
          !isUndeliveredMailboxSteer(projection, command.messageId))
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Delegated completion delivery is no longer dispatchable.",
        });
      }
      delegatedCompletion = {
        parentRunId: requestedCompletion.parentRunId,
        generation: delivery.generation,
        taskIds: delivery.taskIds,
      };
    }
    // A steer that switches provider needs a new turn. A provider that cannot restart its
    // turn for new input takes it after the turn, like a provider that cannot steer at all.
    // An explicit steer that Stop reached still fails below.
    if (dispatchMode.type === "steer_active" && command.modelSelection !== undefined) {
      const targetRunId = dispatchMode.targetRunId;
      const target = projection.runs.find((run) => run.id === targetRunId);
      if (
        target !== undefined &&
        isActiveRun(target) &&
        target.providerInstanceId !== command.modelSelection.instanceId &&
        !(yield* stopReachedRun(command, command.threadId, target.id))
      ) {
        // Before the provider session starts, the adapter's capabilities stand in for its own.
        const turns =
          providerTurnCapabilities(projection, target) ??
          (yield* providerAdapters.get(target.providerInstanceId).pipe(
            Effect.flatMap((adapter) => adapter.getCapabilities()),
            mapDispatchError(command),
          )).turns;
        if (providerSwitchWaitsForTurn(turns)) {
          dispatchMode = { type: "queue_after_active" };
        }
      }
    }
    // A provider that can stop a turn but not restart it with new input runs a
    // restart as the next turn: first in the queue, with the running turn stopped.
    if (dispatchMode.type === "restart_active" && !isNativeMaintenanceCommand(command)) {
      const targetRunId = dispatchMode.targetRunId;
      const target = projection.runs.find((run) => run.id === targetRunId);
      const providerSessionId = projection.providerThreads.find(
        (candidate) => candidate.id === target?.providerThreadId,
      )?.providerSessionId;
      const turns = projection.providerSessions.find((session) => session.id === providerSessionId)
        ?.capabilities.turns;
      const targetMessage = projection.messages.find(
        (message) => message.id === target?.userMessageId,
      );
      if (
        target?.status === "running" &&
        turns !== undefined &&
        turns.supportsInterrupt &&
        turns.supportsQueuedMessages &&
        !turns.supportsSteeringByInterruptRestart &&
        (targetMessage === undefined || !isNativeMaintenanceCommand(targetMessage)) &&
        !(yield* stopReachedRun(command, command.threadId, target.id))
      ) {
        // The restart replaces the stopped turn, so an older held queue does not hold it.
        queuedRunStop = {
          runId: target.id,
          reason: "Stopped to send a new message",
          skipsHeldQueue: true,
        };
        dispatchMode = { type: "queue_after_active" };
      }
    }
    // Steer mailbox deliveries, delegated task questions, and command notices
    // into an active goal under the thread lock: queued behind a long turn or a
    // goal run, they are never seen. Never interrupt/restart a turn for one.
    const noticeKind = command.notification?.source.kind;
    const commandNotice = noticeKind === "command" && command.creationSource === "server";
    if (
      !freshContext &&
      // A steer follow-up was declined by the active turn; steering it again loses it.
      command.steerFollowUpOfRunId === undefined &&
      // Steering refuses a command, so a notice that reads like one stays queued.
      !isSlashCommand(command) &&
      (delegatedCompletion !== undefined
        ? delegatedCompletion.taskIds.every(
            (id) =>
              projection.subagents.find((task) => task.id === id)?.completionWake === "always",
          )
        : noticeKind === "delegated_task" || commandNotice)
    ) {
      const active = projection.runs.find((run) => run.status === "running");
      const providerThread = projection.providerThreads.find(
        (row) => row.id === active?.providerThreadId,
      );
      const activeTurn = projection.providerTurns.find(
        (turn) => turn.runAttemptId === active?.activeAttemptId && turn.status === "running",
      );
      const activeMessage = projection.messages.find(
        (message) => message.id === active?.userMessageId,
      );
      if (
        active !== undefined &&
        activeTurn !== undefined &&
        providerThread?.providerSessionId != null &&
        (!commandNotice || providerThread.goal?.status === "active") &&
        (activeMessage === undefined || !isNativeMaintenanceCommand(activeMessage))
      ) {
        const session = yield* providerSessions
          .get(providerThread.providerSessionId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (
          Option.isSome(session) &&
          session.value.providerSession.capabilities.turns.supportsActiveSteering &&
          session.value.providerSession.capabilities.turns.activeSteeringInterruptsTools !== true &&
          !(yield* stopReachedRun(command, command.threadId, active.id))
        ) {
          dispatchMode = { type: "steer_active", targetRunId: active.id };
        }
      }
    }
    const notification =
      command.manualContinuationOfRunId === undefined
        ? command.notification
        : {
            source: { kind: "system" as const },
            outcome: "updated" as const,
            summary: "Resumed thread",
          };
    const dispatchText =
      command.manualContinuationOfRunId !== undefined
        ? ""
        : delegatedCompletion === undefined
          ? command.text
          : delegatedCompletionWakeDetail(delegatedCompletion.taskIds, projection.subagents);
    const sourcePlanProjection =
      command.sourcePlanRef === undefined
        ? null
        : yield* getProjectionWithPendingEvents(command.sourcePlanRef.threadId, events);
    const sourcePlanArtifact =
      command.sourcePlanRef === undefined
        ? undefined
        : yield* projectionStore
            .getPlan(command.sourcePlanRef.threadId, command.sourcePlanRef.planId)
            .pipe(mapDispatchError(command));
    const sourcePlan = sourcePlanArtifact?.kind === "proposed_plan" ? sourcePlanArtifact : null;
    if (command.sourcePlanRef !== undefined && sourcePlan === null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Proposed plan ${command.sourcePlanRef.planId} does not exist on thread ${command.sourcePlanRef.threadId}.`,
      });
    }
    if (
      sourcePlanProjection !== null &&
      sourcePlanProjection.thread.projectId !== projection.thread.projectId
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Proposed plan ${command.sourcePlanRef?.planId} belongs to a different project.`,
      });
    }
    if (sourcePlan !== null && sourcePlan.status !== "active") {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Proposed plan ${sourcePlan.id} is not active.`,
      });
    }
    const completeSourcePlan = (occurredAt: DateTime.Utc) =>
      sourcePlan === null
        ? Effect.void
        : emit(
            events,
            command,
          )({
            type: "plan.updated",
            threadId: sourcePlan.threadId,
            ...(sourcePlan.runId === null ? {} : { runId: sourcePlan.runId }),
            nodeId: sourcePlan.nodeId,
            occurredAt,
            payload: { ...sourcePlan, status: "completed" },
          });

    let steerWhenReadyRunId: RunId | undefined;
    if (dispatchMode.type === "steer_active") {
      const targetRunId = dispatchMode.targetRunId;
      const target = projection.runs.find((run) => run.id === targetRunId);
      if (
        (target?.status === "preparing" ||
          target?.status === "starting" ||
          (target?.status === "running" &&
            !projection.providerTurns.some(
              (turn) => turn.runAttemptId === target.activeAttemptId && turn.status === "running",
            ))) &&
        !(yield* stopReachedRun(command, command.threadId, target.id))
      ) {
        // Such a caller's message waits for its own turn instead.
        if (yield* limitForbidsParkedSteer) {
          dispatchMode = { type: "queue_after_active" };
        } else {
          const adapter = yield* providerAdapters
            .get(target.providerInstanceId)
            .pipe(mapDispatchError(command));
          const capabilities = yield* adapter.getCapabilities().pipe(mapDispatchError(command));
          yield* commandPolicy
            .decideSteeringExecution({
              commandId: command.commandId,
              threadId: command.threadId,
              providerInstanceId: target.providerInstanceId,
              capabilities,
            })
            .pipe(mapDispatchError(command));
          yield* ensureSteeringMessage(command, command);
          steerWhenReadyRunId = target.id;
          dispatchMode = { type: "queue_after_active" };
        }
      }
    }
    if (dispatchMode.type === "steer_active" || dispatchMode.type === "restart_active") {
      yield* ensureGoalCommandSupported(command, command, modelSelection.instanceId);
      yield* dispatchSteerIntoRun({
        command,
        events,
        effects,
        projection,
        modelSelection:
          delegatedCompletion === undefined && notification === undefined
            ? modelSelection
            : (projection.runs.find((run) => run.id === dispatchMode.targetRunId)?.modelSelection ??
              modelSelection),
        delegatedCompletion,
        ...(notification === undefined ? {} : { notification }),
        targetRunId: dispatchMode.targetRunId,
        messageId: command.messageId,
        text: dispatchText,
        ...(command.context ? { context: command.context } : {}),
        attachments: command.attachments,
        createdBy: command.createdBy,
        creationSource: command.creationSource,
        ...(command.scheduledTaskId === undefined
          ? {}
          : { scheduledTaskId: command.scheduledTaskId }),
        ...(command.senderThreadId === undefined ? {} : { senderThreadId: command.senderThreadId }),
        ...(command.linkedSender === undefined ? {} : { linkedSender: command.linkedSender }),
        ...(command.idleCompaction === undefined ? {} : { idleCompaction: command.idleCompaction }),
        forceRestart: dispatchMode.type === "restart_active",
      });
      return;
    }

    const activeProviderThread = dispatchProviderThread(
      projection,
      { ...command, delegatedCompletion },
      freshContext,
    );
    const activeRun = projection.runs.find(isActiveRun);
    // Messages after failed or stopped worktree setup must wait for a worktree,
    // rather than start in the project checkout.
    const latestRun = latestExecutedRun(projection.runs);
    const worktreeMissingRun =
      activeRun === undefined &&
      (dispatchMode.type === "queue_after_active" || dispatchMode.type === "start_immediately") &&
      (latestRun?.status === "failed" || latestRun?.status === "interrupted") &&
      latestRun.startedAt === null &&
      latestRun.workspacePreparation?.type === "worktree" &&
      projection.thread.worktreePath === null
        ? latestRun
        : undefined;
    // A steer whose run already ended still keeps its place in the queue.
    const steerFollowUpSource =
      command.steerFollowUpOfRunId === undefined
        ? undefined
        : projection.runs.find((run) => run.id === command.steerFollowUpOfRunId);
    const queueBehindRun = activeRun ?? worktreeMissingRun ?? steerFollowUpSource;
    const pendingMergeBackTransfers = pendingMergeBackTransfersForThread(projection);
    const startsOrQueuesRun =
      dispatchMode.type === "defer_start" ||
      dispatchMode.type === "start_immediately" ||
      dispatchMode.type === "queue_after_active";
    const shouldQueue = queueBehindRun !== undefined && startsOrQueuesRun;
    // An explicit pick queued ahead reaches the thread only when its run starts. A goal or
    // restart command that stops the active run goes first, so nothing queued applies before it.
    // Buffered provider wakes drain output their own provider already produced.
    const incomingMessage = { ...command, delegatedCompletion };
    // A message that names no model runs on the thread's pick when it starts, not a copy from now.
    const followsThreadSelection =
      command.modelSelection === undefined &&
      (command.scheduledTaskId !== undefined ||
        (shouldQueue &&
          !followsCurrentConversation(incomingMessage) &&
          !isBufferedProviderNotification(incomingMessage)));
    if (
      shouldQueue &&
      // A steer whose run ended keeps the thread's selection, as it did before it queued.
      queueBehindRun !== steerFollowUpSource &&
      steerWhenReadyRunId === undefined &&
      command.modelSelection === undefined &&
      queuedRunStop === undefined &&
      !followsCurrentConversation(incomingMessage) &&
      !isBufferedProviderNotification(incomingMessage)
    ) {
      modelSelection = queueTailModelSelection(projection);
    }
    yield* ensureGoalCommandSupported(command, command, modelSelection.instanceId);
    // Client messages resume held queues; server continuations and scheduled tasks do not.
    // Provider failure or usage limits re-hold the queue.
    const worktreeSetupUnresolved = worktreeSetupPending(projection);
    const sentByUserFromClient =
      command.steerFollowUpOfRunId === undefined &&
      command.createdBy === "user" &&
      (command.creationSource === "web" || command.creationSource === "mobile") &&
      command.scheduledTaskId === undefined;
    const heldRunsToRelease =
      sentByUserFromClient && startsOrQueuesRun && !worktreeSetupUnresolved
        ? projection.runs.filter((run) => run.status === "queued" && run.queueHeld === true)
        : [];
    const releasedAt = yield* DateTime.now;
    for (const held of heldRunsToRelease) {
      yield* emit(
        events,
        command,
      )({
        type: "run.updated",
        threadId: command.threadId,
        runId: held.id,
        providerInstanceId: held.providerInstanceId,
        occurredAt: releasedAt,
        payload: { ...held, queueHeld: false },
      });
    }
    if (shouldQueue) {
      if (pendingMergeBackTransfers.length > 0) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Thread ${command.threadId} has a pending merge-back transfer; queued merge-back consumption is not implemented yet.`,
        });
      }
      const queueProviderThread =
        activeProviderThread ??
        projection.providerThreads.find(
          (candidate) => candidate.id === queueBehindRun.providerThreadId,
        );
      if (queueProviderThread === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Active run ${queueBehindRun.id} has no provider thread for queued dispatch.`,
        });
      }
      const now = yield* DateTime.now;
      const ordinal = nextRunOrdinal(projection);
      const runId = idAllocator.derive.run({ threadId: command.threadId, ordinal });
      const targetProviderThread = freshContext
        ? undefined
        : modelSelection.instanceId === queueProviderThread.providerInstanceId
          ? queueProviderThread
          : rootProviderThreadsForProvider(projection, modelSelection.instanceId)[0];
      const queuedAdapter = yield* providerAdapters
        .get(modelSelection.instanceId)
        .pipe(mapDispatchError(command));
      const selectedProviderSession =
        targetProviderThread?.providerSessionId === null ||
        targetProviderThread?.providerSessionId === undefined
          ? undefined
          : projection.providerSessions.find(
              (candidate) => candidate.id === targetProviderThread.providerSessionId,
            );
      const queuedCapabilities =
        selectedProviderSession?.capabilities ??
        (yield* queuedAdapter.getCapabilities().pipe(mapDispatchError(command)));
      yield* mapDispatchError(command)(
        commandPolicy.ensureQueuedMessages({
          commandId: command.commandId,
          threadId: command.threadId,
          providerInstanceId: modelSelection.instanceId,
          capabilities: queuedCapabilities,
        }),
      );
      const queuedProviderThread: OrchestrationV2ProviderThread = targetProviderThread ?? {
        id: idAllocator.derive.providerThread({
          driver: queuedAdapter.driver,
          nativeThreadId: `pending:${runId}`,
        }),
        driver: queuedAdapter.driver,
        providerInstanceId: modelSelection.instanceId,
        providerSessionId: null,
        appThreadId: command.threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
      const rootNodeId = idAllocator.derive.rootNode({ runId });
      const checkpointScope =
        queueBehindRun.status === "preparing" || worktreeMissingRun !== undefined
          ? null
          : yield* runtimePolicy.resolve({ thread: projection.thread, modelSelection }).pipe(
              Effect.flatMap((resolvedRuntimePolicy) =>
                checkpointService.prepareRootRunScope({
                  threadId: command.threadId,
                  runId,
                  rootNodeId,
                  providerThreadId: queuedProviderThread.id,
                  cwd:
                    resolvedRuntimePolicy.cwd ??
                    selectedProviderSession?.cwd ??
                    projection.thread.worktreePath ??
                    process.cwd(),
                  createdAt: now,
                }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause,
                  }),
              ),
            );
      const queueIsHeld = projection.runs.some(
        (candidate) => candidate.status === "queued" && candidate.queueHeld === true,
      );
      // Buffered wakes need a ZeroCode run for output the CLI already started producing.
      // Stop still holds wakes that arrive before the active run settles.
      const wakeSkipsHold =
        !worktreeSetupUnresolved &&
        activeRun !== undefined &&
        queueIsHeld &&
        command.createdBy === "agent" &&
        command.creationSource === "provider" &&
        !(yield* stopReachedRun(command, command.threadId, activeRun.id));
      let steerFollowUpQueuePosition: number | undefined;
      if (command.steerFollowUpAfterRunOrdinal !== undefined) {
        const afterRunOrdinal = command.steerFollowUpAfterRunOrdinal;
        const steerOrdinal =
          projection.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === command.messageId,
          )?.ordinal ?? -1;
        // Earlier declined steers have newer runs but retain their original turn-item ordinals.
        const earlierSteerMessageIds = new Set(
          projection.turnItems.flatMap((item) =>
            item.type === "user_message" && item.ordinal < steerOrdinal ? [item.messageId] : [],
          ),
        );
        steerFollowUpQueuePosition =
          Math.max(
            0,
            ...projection.runs
              .filter(
                (candidate) =>
                  candidate.status === "queued" &&
                  (candidate.ordinal <= afterRunOrdinal ||
                    earlierSteerMessageIds.has(candidate.userMessageId)),
              )
              .map((candidate) => candidate.queuePosition ?? candidate.ordinal),
          ) + 1;
      }
      const run: OrchestrationV2Run = {
        id: runId,
        threadId: command.threadId,
        ordinal,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        providerThreadId: queuedProviderThread.id,
        userMessageId: command.messageId,
        rootNodeId,
        activeAttemptId: attemptId,
        status: "queued",
        ...(steerWhenReadyRunId === undefined ? {} : { steerWhenReadyRunId }),
        // A restart cancels its run; nobody knows whether the provider read the steer, so a person decides.
        ...(worktreeMissingRun !== undefined ||
        steerFollowUpSource?.status === "cancelled" ||
        (heldRunsToRelease.length === 0 &&
          queueIsHeld &&
          !wakeSkipsHold &&
          queuedRunStop?.skipsHeldQueue !== true)
          ? { queueHeld: true }
          : {}),
        queuePosition:
          queuedRunStop !== undefined
            ? 1
            : (steerFollowUpQueuePosition ??
              Math.max(
                0,
                ...projection.runs
                  .filter((candidate) => candidate.status === "queued")
                  .map((candidate) => candidate.queuePosition ?? candidate.ordinal),
              ) + 1),
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
        ...(command.sourcePlanRef === undefined ? {} : { sourcePlanRef: command.sourcePlanRef }),
        ...(command.restartContinuationOfRunId === undefined
          ? {}
          : { restartContinuationOfRunId: command.restartContinuationOfRunId }),
        ...(command.manualContinuationOfRunId === undefined
          ? {}
          : { manualContinuationOfRunId: command.manualContinuationOfRunId }),
        ...(command.usageLimitContinuationOfRunId === undefined
          ? {}
          : { usageLimitContinuationOfRunId: command.usageLimitContinuationOfRunId }),
        ...(continuedTaskId === undefined ? {} : { delegatedTaskId: continuedTaskId }),
        ...(freshContext ? { freshContext: true } : {}),
        ...output,
      };
      const attempt: OrchestrationV2RunAttempt = {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        providerThreadId: queuedProviderThread.id,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      };
      const rootNode: OrchestrationV2ExecutionNode = {
        id: rootNodeId,
        threadId: command.threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId: queuedProviderThread.id,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: checkpointScope?.id ?? null,
        startedAt: null,
        completedAt: null,
      };
      const message: OrchestrationV2ConversationMessage = {
        createdBy: command.createdBy,
        creationSource: command.creationSource,
        ...(command.scheduledTaskId === undefined
          ? {}
          : { scheduledTaskId: command.scheduledTaskId }),
        ...(command.senderThreadId === undefined ? {} : { senderThreadId: command.senderThreadId }),
        ...(command.linkedSender === undefined ? {} : { linkedSender: command.linkedSender }),
        ...(command.idleCompaction === undefined ? {} : { idleCompaction: command.idleCompaction }),
        ...(followsThreadSelection ? { followsThreadSelection: true as const } : {}),
        id: command.messageId,
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        role: "user",
        text: dispatchText,
        ...(command.context ? { context: command.context } : {}),
        attachments: command.attachments,
        streaming: false,
        createdAt: now,
        updatedAt: now,
        ...(delegatedCompletion === undefined ? {} : { delegatedCompletion }),
        ...(notification === undefined ? {} : { notification }),
      };
      const emitEvent = emit(events, command);
      if (targetProviderThread === undefined) {
        yield* emitEvent({
          type: "provider-thread.updated",
          threadId: command.threadId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: queuedProviderThread,
        });
      }
      yield* emitEvent({
        type: "run.created",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: run,
      });
      if (steerFollowUpQueuePosition !== undefined) {
        for (const queued of projection.runs) {
          if (
            queued.status !== "queued" ||
            (queued.queuePosition ?? queued.ordinal) < steerFollowUpQueuePosition
          )
            continue;
          yield* emitEvent({
            type: "run.updated",
            threadId: command.threadId,
            runId: queued.id,
            providerInstanceId: queued.providerInstanceId,
            occurredAt: now,
            payload: {
              ...queued,
              ...(heldRunsToRelease.includes(queued) ? { queueHeld: false } : {}),
              queuePosition: (queued.queuePosition ?? queued.ordinal) + 1,
            },
          });
        }
      }
      yield* completeSourcePlan(now);
      yield* emitEvent({
        type: "run-attempt.created",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: attempt,
      });
      yield* emitEvent({
        type: "node.updated",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: rootNode,
      });
      if (checkpointScope !== null) {
        yield* emitEvent({
          type: "checkpoint-scope.created",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: checkpointScope,
        });
      }
      yield* emitEvent({
        type: "message.updated",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: message,
      });
      const existingItem = projection.turnItems.find(
        (item) => item.type === "user_message" && item.messageId === command.messageId,
      );
      if (existingItem?.type === "user_message") {
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            ...existingItem,
            runId,
            nodeId: rootNodeId,
            providerThreadId: queuedProviderThread.id,
            providerTurnId: null,
            inputIntent: "queued_turn",
            status: "pending",
            startedAt: null,
            completedAt: null,
            updatedAt: now,
          },
        });
      }
      if (queuedRunStop !== undefined) {
        return yield* callbacks.stopRunForQueuedCommand({
          command,
          events,
          effects,
          projection: yield* getProjectionWithPendingEvents(command.threadId, events),
          queuedRunId: runId,
          targetRunId: queuedRunStop.runId,
          reason: queuedRunStop.reason,
          now,
        });
      }
      return;
    }
    // A scheduled fresh run is a side conversation, so it must not drop the fork's context.
    const supersedesForkTransfer = freshContext && command.scheduledTaskId === undefined;
    const pendingForkTransfer = supersedesForkTransfer
      ? undefined
      : pendingForkTransferForThread(projection);
    const pendingMergeBackSourceThreadIds = new Set(
      pendingMergeBackTransfers.map((transfer) => transfer.sourceThreadId),
    );
    if (pendingMergeBackSourceThreadIds.size > 1) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} has pending merge-back transfers from multiple forks.`,
      });
    }
    const pendingMergeBackTransfer = latestContextTransfer(pendingMergeBackTransfers);
    const supersededMergeBackTransfers = pendingMergeBackTransfers.filter(
      (transfer) => transfer.id !== pendingMergeBackTransfer?.id,
    );
    const now = yield* DateTime.now;
    if (
      !modelSelectionsEqual(projection.thread.modelSelection, modelSelection) ||
      projection.thread.providerInstanceId !== modelSelection.instanceId
    ) {
      yield* emit(
        events,
        command,
      )({
        type:
          projection.thread.providerInstanceId === modelSelection.instanceId
            ? "thread.model-selection-updated"
            : "thread.provider-switched",
        threadId: command.threadId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: {
          ...projection.thread,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          updatedAt: now,
        },
      });
    }
    if (
      freshContext &&
      (pendingForkTransfer !== undefined || pendingMergeBackTransfer !== undefined)
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause:
          pendingMergeBackTransfer !== undefined
            ? "Send a message without /clear to apply the merged context first."
            : "A fresh session can't start while a fork or merge is still being applied.",
      });
    }
    const ordinal = nextRunOrdinal(projection);
    const runId = idAllocator.derive.run({ threadId: command.threadId, ordinal });
    const contextBoundary = freshContext ? ordinal : contextBoundaryOrdinal(projection);
    const latestCompletedRun = projection.runs.findLast((run) => run.status === "completed");
    const latestHandoffRun = projection.runs.findLast(isHandoffSourceRun);
    const legacyImportItems =
      projection.thread.historyOrigin === "v1_import" && contextBoundary === 0
        ? yield* readHandoffItems(command.threadId, [null])
        : [];
    const isProviderSwitch =
      activeProviderThread !== undefined &&
      activeProviderThread.providerInstanceId !== modelSelection.instanceId;
    // Account overlays share native history. Selection commands may already
    // have updated the app thread, so classify against the native thread's owner.
    const providerSwitchPlan = isProviderSwitch
      ? yield* providerSwitchService
          .plan({
            projection: {
              ...projection,
              thread: {
                ...projection.thread,
                modelSelection: {
                  ...projection.thread.modelSelection,
                  instanceId: activeProviderThread.providerInstanceId,
                },
              },
            },
            targetModelSelection: modelSelection,
          })
          .pipe(mapDispatchError(command))
      : null;
    const canResumeAcrossInstances =
      !freshContext &&
      isProviderSwitch &&
      activeProviderThread.nativeThreadRef !== null &&
      providerSwitchPlan?.transition.type === "restart_and_resume";
    const releasableSessions = uniqueSessions([
      ...projection.providerSessions.filter(
        (session) =>
          providerSwitchPlan?.releaseProviderSessionIds.includes(session.id) &&
          session.status !== "stopped" &&
          session.status !== "error",
      ),
      ...(freshContext ? sessionsReleasedByFreshContext(projection, activeProviderThread) : []),
    ]);
    const sessionsToDetach: Array<OrchestrationV2ProviderSession> = [];
    for (const detaching of releasableSessions) {
      if (yield* sessionHasBackgroundWork(detaching, projection.providerThreads)) {
        // A schedule has nobody to wait or press Stop; like a queued fresh start, leave it running.
        if (freshContext && command.scheduledTaskId !== undefined) continue;
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: freshContext
            ? "The current session is still running background agents or commands, and a fresh session would end them. Wait for them to finish, or press Stop, then send the message again."
            : "The previous provider is still running background agents or commands, and switching would end them. Wait for them to finish, or press Stop, then send the message again.",
        });
      }
      sessionsToDetach.push(detaching);
    }

    if (
      pendingForkTransfer === undefined &&
      pendingMergeBackTransfer === undefined &&
      (!isProviderSwitch || freshContext)
    ) {
      const reusableProviderThread = freshContext ? undefined : activeProviderThread;
      const adapter = yield* providerAdapters.get(modelSelection.instanceId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProviderAdapterError({
              commandId: command.commandId,
              providerInstanceId: modelSelection.instanceId,
              cause,
            }),
        ),
      );
      const providerSessionId =
        reusableProviderThread?.providerSessionId ??
        (yield* mapDispatchError(command)(
          providerSessionIdFor({
            adapter,
            providerInstanceId: modelSelection.instanceId,
            threadId: command.threadId,
          }),
        ));
      const providerThreadId =
        reusableProviderThread?.id ??
        idAllocator.derive.providerThread({
          driver: adapter.driver,
          nativeThreadId: `pending:${runId}`,
        });
      const legacyImportHandoff = shouldPrepareLegacyImportHandoff({
        hasNativeHistory:
          activeProviderThread !== undefined && activeProviderThread.nativeThreadRef !== null,
        historyOrigin: projection.thread.historyOrigin,
        hasCompletedRun: latestCompletedRun !== undefined,
        legacyImportItemCount: legacyImportItems.length,
      })
        ? yield* contextHandoffService
            .prepareLegacyImport({
              threadId: command.threadId,
              targetRunId: runId,
              toProviderThreadId: providerThreadId,
              toProviderInstanceId: modelSelection.instanceId,
              items: legacyImportItems,
              createdAt: now,
            })
            .pipe(mapDispatchError(command))
        : null;
      const providerThread: OrchestrationV2ProviderThread =
        reusableProviderThread === undefined
          ? {
              id: providerThreadId,
              driver: adapter.driver,
              providerInstanceId: modelSelection.instanceId,
              providerSessionId,
              appThreadId: command.threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "not_loaded",
              firstRunOrdinal: ordinal,
              lastRunOrdinal: ordinal,
              handoffIds: legacyImportHandoff === null ? [] : [legacyImportHandoff.id],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }
          : {
              ...reusableProviderThread,
              providerSessionId,
              lastRunOrdinal: ordinal,
              handoffIds: appendContextHandoffId(
                reusableProviderThread.handoffIds,
                legacyImportHandoff?.id ?? null,
              ),
              updatedAt: now,
            };
      const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
      const rootNodeId = idAllocator.derive.rootNode({ runId });
      const checkpointScope =
        dispatchMode.type === "defer_start"
          ? null
          : yield* runtimePolicy
              .resolve({
                thread: projection.thread,
                modelSelection,
              })
              .pipe(
                mapDispatchError(command),
                Effect.flatMap((resolvedRuntimePolicy) =>
                  checkpointService.prepareRootRunScope({
                    threadId: command.threadId,
                    runId,
                    rootNodeId,
                    providerThreadId,
                    cwd:
                      resolvedRuntimePolicy.cwd ?? projection.thread.worktreePath ?? process.cwd(),
                    createdAt: now,
                  }),
                ),
                mapDispatchError(command),
              );
      const run: OrchestrationV2Run = {
        id: runId,
        threadId: command.threadId,
        ordinal,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: command.messageId,
        rootNodeId,
        activeAttemptId: attemptId,
        status: dispatchMode.type === "defer_start" ? "preparing" : "starting",
        queuePosition: null,
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: legacyImportHandoff?.id ?? null,
        ...(command.sourcePlanRef === undefined ? {} : { sourcePlanRef: command.sourcePlanRef }),
        ...(command.restartContinuationOfRunId === undefined
          ? {}
          : { restartContinuationOfRunId: command.restartContinuationOfRunId }),
        ...(command.manualContinuationOfRunId === undefined
          ? {}
          : { manualContinuationOfRunId: command.manualContinuationOfRunId }),
        ...(command.usageLimitContinuationOfRunId === undefined
          ? {}
          : { usageLimitContinuationOfRunId: command.usageLimitContinuationOfRunId }),
        ...(dispatchMode.type === "defer_start" && dispatchMode.workspaceStrategy !== undefined
          ? { workspacePreparation: dispatchMode.workspaceStrategy }
          : {}),
        ...(continuedTaskId === undefined ? {} : { delegatedTaskId: continuedTaskId }),
        ...wakeWorkStartedAt(projection, command),
        ...(freshContext ? { freshContext: true } : {}),
        ...output,
      };
      const attempt: OrchestrationV2RunAttempt = {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      };
      const rootNode: OrchestrationV2ExecutionNode = {
        id: rootNodeId,
        threadId: command.threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: checkpointScope?.id ?? null,
        startedAt: null,
        completedAt: null,
      };
      const message: OrchestrationV2ConversationMessage = {
        createdBy: command.createdBy,
        creationSource: command.creationSource,
        ...(command.scheduledTaskId === undefined
          ? {}
          : { scheduledTaskId: command.scheduledTaskId }),
        ...(command.senderThreadId === undefined ? {} : { senderThreadId: command.senderThreadId }),
        ...(command.linkedSender === undefined ? {} : { linkedSender: command.linkedSender }),
        ...(command.idleCompaction === undefined ? {} : { idleCompaction: command.idleCompaction }),
        ...(followsThreadSelection ? { followsThreadSelection: true as const } : {}),
        id: command.messageId,
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        role: "user",
        text: dispatchText,
        ...(command.context ? { context: command.context } : {}),
        attachments: command.attachments,
        streaming: false,
        createdAt: now,
        updatedAt: now,
        ...(delegatedCompletion === undefined ? {} : { delegatedCompletion }),
        ...(notification === undefined ? {} : { notification }),
      };
      const turnItem: OrchestrationV2TurnItem = {
        createdBy: command.createdBy,
        creationSource: command.creationSource,
        ...(command.scheduledTaskId === undefined
          ? {}
          : { scheduledTaskId: command.scheduledTaskId }),
        ...(command.senderThreadId === undefined ? {} : { senderThreadId: command.senderThreadId }),
        ...(command.linkedSender === undefined ? {} : { linkedSender: command.linkedSender }),
        ...(command.idleCompaction === undefined ? {} : { idleCompaction: command.idleCompaction }),
        id: idAllocator.derive.userTurnItem({ messageId: command.messageId }),
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: yield* nextTurnItemOrdinal(projection),
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "user_message",
        messageId: command.messageId,
        inputIntent: "turn_start",
        text: dispatchText,
        ...(command.context ? { context: command.context } : {}),
        attachments: command.attachments,
        ...(freshContext ? { freshContext: true } : {}),
        ...(run.contextHandoffId === null ? modelSwitchSince(projection, modelSelection) : {}),
      };
      const preparationTurnItem: OrchestrationV2TurnItem | null =
        dispatchMode.type === "defer_start"
          ? {
              id: idAllocator.derive.turnItemFromProviderItem({
                driver: adapter.driver,
                nativeItemId: `workspace-preparation:${runId}`,
              }),
              threadId: command.threadId,
              runId,
              nodeId: rootNodeId,
              providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: turnItem.ordinal + 1,
              status: "running",
              title: WORKSPACE_PREPARATION_INPUT,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              type: "command_execution",
              input: WORKSPACE_PREPARATION_INPUT,
            }
          : null;
      const emitEvent = emit(events, command);
      yield* emitEvent({
        type: "provider-thread.updated",
        threadId: command.threadId,
        driver: adapter.driver,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: providerThread,
      });
      if (legacyImportHandoff !== null) {
        yield* emitEvent({
          type: "context-handoff.updated",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: legacyImportHandoff,
        });
      }
      yield* emitEvent({
        type: "run.created",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: run,
      });
      yield* completeSourcePlan(now);
      const supersededForkTransfer = supersedesForkTransfer
        ? pendingForkTransferForThread(projection)
        : undefined;
      if (supersededForkTransfer !== undefined) {
        yield* emitEvent(
          forkTransferSupersededEvent(
            supersededForkTransfer,
            runId,
            modelSelection.instanceId,
            now,
          ),
        );
      }
      yield* emitEvent({
        type: "run-attempt.created",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: attempt,
      });
      yield* emitEvent({
        type: "node.updated",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: rootNode,
      });
      if (checkpointScope !== null) {
        yield* emitEvent({
          type: "checkpoint-scope.created",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: checkpointScope,
        });
      }
      yield* emitEvent({
        type: "message.updated",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: message,
      });
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: notificationTurnItem(
          turnItem,
          message,
          yield* notificationTasks(command.threadId, message, projection.subagents),
        ),
      });
      if (preparationTurnItem !== null) {
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: preparationTurnItem,
        });
      }
      for (const session of sessionsToDetach) {
        if (session.id === providerSessionId) continue;
        yield* emitEvent({
          type: "provider-session.detached",
          threadId: command.threadId,
          driver: session.driver,
          providerInstanceId: session.providerInstanceId,
          occurredAt: now,
          payload: {
            providerSessionId: session.id,
            detachedAt: now,
            reason: FRESH_CONTEXT_DETACH_REASON,
          },
        });
        yield* Ref.update(effects, (existing) => [
          ...existing,
          {
            id: `effect:${command.commandId}:provider-session.detach:${session.id}`,
            commandId: command.commandId,
            threadId: command.threadId,
            request: {
              type: "provider-session.detach",
              providerSessionId: session.id,
              detail: FRESH_CONTEXT_DETACH_REASON,
            },
          } satisfies PendingOrchestrationEffectV2,
        ]);
      }
      const pendingEffect = {
        id: `effect:${command.commandId}:provider-turn.start:${runId}`,
        commandId: command.commandId,
        threadId: command.threadId,
        request: { type: "provider-turn.start", runId },
      } satisfies PendingOrchestrationEffectV2;
      if (dispatchMode.type !== "defer_start") {
        yield* Ref.update(effects, (existing) => [...existing, pendingEffect]);
      }
      return;
    }
    const sourceProjection =
      pendingForkTransfer === undefined
        ? null
        : yield* projectionStore
            .getThreadRecords(pendingForkTransfer.sourceThreadId, [
              "runs",
              "attempts",
              "providerThreads",
              "providerTurns",
            ])
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorProjectionError({
                    threadId: pendingForkTransfer.sourceThreadId,
                    cause,
                  }),
              ),
            );
    const sourceRun =
      pendingForkTransfer?.sourcePoint.runId === undefined || sourceProjection === null
        ? null
        : (sourceProjection.runs.find(
            (candidate) => candidate.id === pendingForkTransfer.sourcePoint.runId,
          ) ?? null);
    const sourceProviderThread =
      sourceProjection === null || sourceRun === null
        ? undefined
        : providerThreadForRun(sourceProjection, sourceRun);
    const sourceProviderTurnId =
      sourceProjection === null || sourceRun === null || sourceRun.activeAttemptId === null
        ? undefined
        : (latestProviderTurnForAttempt(sourceProjection.providerTurns, sourceRun.activeAttemptId)
            ?.id ??
          sourceProjection.attempts.find((candidate) => candidate.id === sourceRun.activeAttemptId)
            ?.providerTurnId ??
          undefined);
    const sideChatFork =
      pendingForkTransfer !== undefined && projection.thread.lineage.sideChat === true;
    // Opened during the parent's first turn: the digest is the whole context.
    const sideChatWithoutSource =
      sideChatFork && pendingForkTransfer.sourcePoint.runId === undefined;
    if (pendingForkTransfer !== undefined) {
      if (!sideChatWithoutSource && (sourceRun === null || sourceProviderThread === undefined)) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Pending fork transfer ${pendingForkTransfer.id} has no resolvable source provider thread.`,
        });
      }
      if (pendingForkTransfer.sourceProviderInstanceId === null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Pending fork transfer ${pendingForkTransfer.id} has no source provider.`,
        });
      }
    }

    const adapter = yield* providerAdapters.get(modelSelection.instanceId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorProviderAdapterError({
            commandId: command.commandId,
            providerInstanceId: modelSelection.instanceId,
            cause,
          }),
      ),
    );
    const targetProviderThread =
      isProviderSwitch && !canResumeAcrossInstances
        ? rootProviderThreadsForProvider(projection, modelSelection.instanceId)[0]
        : activeProviderThread;
    const providerSessionId =
      (canResumeAcrossInstances ? undefined : targetProviderThread?.providerSessionId) ??
      (yield* mapDispatchError(command)(
        providerSessionIdFor({
          adapter,
          providerInstanceId: modelSelection.instanceId,
          threadId: command.threadId,
        }),
      ));
    const existingProviderSession = projection.providerSessions.find(
      (candidate) => candidate.id === providerSessionId,
    );
    const resolvedRuntimePolicy = yield* runtimePolicy
      .resolve({ thread: projection.thread, modelSelection })
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause,
            }),
        ),
      );

    const capabilities = yield* adapter.getCapabilities().pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorProviderAdapterError({
            commandId: command.commandId,
            providerInstanceId: modelSelection.instanceId,
            cause,
          }),
      ),
    );
    const sourceRunsAfterFork =
      sourceProjection === null
        ? []
        : sourceProjection.runs.filter(
            (candidate) => sourceRun === null || candidate.ordinal > sourceRun.ordinal,
          );
    const forkExecution =
      pendingForkTransfer === undefined || sourceRun === null
        ? null
        : yield* mapDispatchError(command)(
            commandPolicy.decideForkExecution({
              commandId: command.commandId,
              threadId: command.threadId,
              providerInstanceId: modelSelection.instanceId,
              capabilities,
              sameProvider:
                pendingForkTransfer.sourceProviderInstanceId === modelSelection.instanceId,
              hasStrongNativeSource: sourceProviderThread?.nativeThreadRef?.strength === "strong",
              hasNativeTurnBoundary:
                sourceProjection?.providerTurns.find((turn) => turn.id === sourceProviderTurnId)
                  ?.nativeTurnRef != null,
              sourceRunStatus: sourceRun.status,
              fromSpecificTurn: sourceRun !== null,
              sourceBusy: sourceRunsAfterFork.some(isActiveRun),
            }),
          );
    const canResolveForkNatively = forkExecution === "native_fork";
    const requiresPortableFork = forkExecution === "portable_context";

    if (canResolveForkNatively) {
      yield* mapDispatchError(command)(
        commandPolicy.ensureNativeFork({
          commandId: command.commandId,
          threadId: command.threadId,
          providerInstanceId: modelSelection.instanceId,
          capabilities,
          fromSpecificTurn: sourceRun !== null,
        }),
      );
    }

    const ensuredProviderThread: OrchestrationV2ProviderThread =
      targetProviderThread === undefined
        ? {
            id: idAllocator.derive.providerThread({
              driver: adapter.driver,
              nativeThreadId: `pending:${runId}`,
            }),
            driver: adapter.driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId,
            appThreadId: command.threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "not_loaded",
            firstRunOrdinal: ordinal,
            lastRunOrdinal: ordinal,
            handoffIds: [],
            forkedFrom:
              canResolveForkNatively && sourceProviderThread !== undefined
                ? {
                    providerThreadId: sourceProviderThread.id,
                    ...(sourceProviderTurnId === undefined
                      ? {}
                      : { providerTurnId: sourceProviderTurnId }),
                  }
                : null,
            createdAt: now,
            updatedAt: now,
          }
        : {
            ...targetProviderThread,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId,
            updatedAt: now,
          };
    const portableForkItems =
      !requiresPortableFork || sourceProjection === null || sourceRun === null
        ? []
        : yield* readForkHistoryItems(
            projectionStore,
            sourceProjection,
            sourceRun,
            projection.thread,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorProjectionError({ threadId: sourceProjection.thread.id, cause }),
            ),
          );
    const portableForkHandoff =
      !requiresPortableFork ||
      pendingForkTransfer === undefined ||
      sourceProjection === null ||
      sourceRun === null
        ? null
        : yield* contextHandoffService
            .prepareProviderHandoff({
              threadId: command.threadId,
              sourceThreadId: sourceProjection.thread.id,
              targetRunId: runId,
              transferId: pendingForkTransfer.id,
              fromProviderThreadIds:
                sourceProviderThread === undefined ? [] : [sourceProviderThread.id],
              toProviderThreadId: ensuredProviderThread.id,
              fromProviderInstanceId: sourceRun.providerInstanceId,
              toProviderInstanceId: modelSelection.instanceId,
              coveredRunOrdinals: visibleDeltaRunOrdinals(sourceProjection, portableForkItems),
              strategy: "full_thread_summary",
              items: portableForkItems,
              runs: sourceProjection.runs,
              createdAt: now,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause,
                  }),
              ),
            );
    // Without a source run the digest covers the parent's whole history: inherited fork rows
    // first, so the cap truncates them first, then imported and run items.
    const sideChatParentRunIds = [
      // Queued messages have not reached the main thread yet.
      ...sourceRunsAfterFork.filter((run) => run.status !== "queued").map((run) => run.id),
      ...(sourceRun === null && sourceProjection?.thread.historyOrigin === "v1_import"
        ? [null]
        : []),
    ];
    const sideChatParentItems =
      !sideChatFork || sourceProjection === null
        ? []
        : [
            ...(sideChatWithoutSource ? yield* readInheritedItems(sourceProjection.thread) : []),
            ...(sideChatParentRunIds.length === 0
              ? []
              : visibleConversationItems(
                  sourceProjection,
                  yield* readHandoffItems(sourceProjection.thread.id, sideChatParentRunIds),
                )),
          ];
    // The framing note goes in even when the parent has no activity after the fork point.
    const sideChatContextHandoff =
      !sideChatFork || pendingForkTransfer === undefined || sourceProjection === null
        ? null
        : yield* contextHandoffService
            .prepareSideChatContext({
              threadId: command.threadId,
              parentThreadId: sourceProjection.thread.id,
              targetRunId: runId,
              transferId: pendingForkTransfer.id,
              toProviderThreadId: ensuredProviderThread.id,
              fromProviderInstanceId:
                pendingForkTransfer.sourceProviderInstanceId ?? modelSelection.instanceId,
              toProviderInstanceId: modelSelection.instanceId,
              coveredRunOrdinals: visibleDeltaRunOrdinals(sourceProjection, sideChatParentItems),
              parentItems: sideChatParentItems,
              createdAt: now,
            })
            .pipe(mapDispatchError(command));
    const requiresFullProviderSwitchContext =
      isProviderSwitch && pendingMergeBackTransfer !== undefined;
    const targetLastCompletedRun =
      targetProviderThread === undefined
        ? undefined
        : lastDeliveredRunForProviderThread(projection, targetProviderThread.id);
    const providerSwitchCoveredRuns =
      !isProviderSwitch || canResumeAcrossInstances || latestHandoffRun === undefined
        ? []
        : projection.runs.filter(
            (run) =>
              isHandoffSourceRun(run) &&
              run.ordinal >= contextBoundary &&
              run.ordinal >
                (requiresFullProviderSwitchContext ? 0 : (targetLastCompletedRun?.ordinal ?? 0)) &&
              run.ordinal <= latestHandoffRun.ordinal,
          );
    const providerSwitchNeedsFullContext =
      targetProviderThread === undefined ||
      targetProviderThread.nativeThreadRef === null ||
      requiresFullProviderSwitchContext;
    const providerSwitchItems =
      providerSwitchCoveredRuns.length === 0
        ? []
        : [
            ...(providerSwitchNeedsFullContext && contextBoundary === 0
              ? yield* readInheritedItems(projection.thread)
              : []),
            ...(latestCompletedRun !== undefined && providerSwitchNeedsFullContext
              ? legacyImportItems
              : []),
            ...(yield* readHandoffItems(
              command.threadId,
              providerSwitchCoveredRuns.map((run) => run.id),
            )),
          ];
    const providerSwitchTransferId =
      providerSwitchCoveredRuns.length === 0 || latestHandoffRun === undefined
        ? null
        : yield* mapDispatchError(command)(
            idAllocator.allocate.contextTransfer({
              sourceThreadId: command.threadId,
              targetThreadId: command.threadId,
              type: "provider_handoff",
            }),
          );
    if (providerSwitchTransferId !== null) {
      yield* mapDispatchError(command)(
        commandPolicy.ensureContextHandoff({
          commandId: command.commandId,
          threadId: command.threadId,
          providerInstanceId: modelSelection.instanceId,
          capabilities,
          strategy: providerSwitchNeedsFullContext ? "full_thread_summary" : "delta_context",
        }),
      );
    }
    const providerSwitchHandoff =
      providerSwitchTransferId === null || latestHandoffRun === undefined
        ? null
        : yield* contextHandoffService
            .prepareProviderHandoff({
              threadId: command.threadId,
              targetRunId: runId,
              transferId: providerSwitchTransferId,
              fromProviderThreadIds: Array.from(
                new Set(
                  providerSwitchCoveredRuns.flatMap((run) =>
                    run.providerThreadId === null ? [] : [run.providerThreadId],
                  ),
                ),
              ),
              toProviderThreadId: ensuredProviderThread.id,
              fromProviderInstanceId: latestHandoffRun.providerInstanceId,
              toProviderInstanceId: modelSelection.instanceId,
              coveredRunOrdinals: {
                from: providerSwitchCoveredRuns[0]!.ordinal,
                to: providerSwitchCoveredRuns.at(-1)!.ordinal,
              },
              strategy: providerSwitchNeedsFullContext
                ? "full_thread_summary"
                : "delta_since_target_last_seen",
              items: providerSwitchItems,
              runs: projection.runs,
              createdAt: now,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause,
                  }),
              ),
            );
    const legacyImportRecoveryHandoff =
      isProviderSwitch &&
      !canResumeAcrossInstances &&
      ensuredProviderThread.nativeThreadRef === null &&
      latestCompletedRun === undefined &&
      legacyImportItems.length > 0
        ? yield* contextHandoffService
            .prepareLegacyImport({
              threadId: command.threadId,
              targetRunId: runId,
              toProviderThreadId: ensuredProviderThread.id,
              toProviderInstanceId: modelSelection.instanceId,
              items: legacyImportItems,
              createdAt: now,
            })
            .pipe(mapDispatchError(command))
        : null;
    const providerThread: OrchestrationV2ProviderThread = {
      ...ensuredProviderThread,
      status: ensuredProviderThread.status === "error" ? "error" : "active",
      firstRunOrdinal: ensuredProviderThread.firstRunOrdinal ?? ordinal,
      lastRunOrdinal: ordinal,
      handoffIds: [
        ...ensuredProviderThread.handoffIds,
        ...[
          portableForkHandoff,
          sideChatContextHandoff,
          providerSwitchHandoff,
          legacyImportRecoveryHandoff,
        ].flatMap((handoff) => (handoff === null ? [] : [handoff.id])),
      ],
      updatedAt: now,
    };

    const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
    const rootNodeId = idAllocator.derive.rootNode({ runId });
    const emitEvent = emit(events, command);
    const mergeBackSourceProjection =
      pendingMergeBackTransfer === undefined
        ? null
        : yield* projectionStore
            .getThreadRecords(pendingMergeBackTransfer.sourceThreadId, [
              "runs",
              "attempts",
              "providerThreads",
              "providerTurns",
            ])
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorProjectionError({
                    threadId: pendingMergeBackTransfer.sourceThreadId,
                    cause,
                  }),
              ),
            );
    const mergeBackSourceRun =
      pendingMergeBackTransfer?.sourcePoint.runId === undefined ||
      mergeBackSourceProjection === null
        ? null
        : (mergeBackSourceProjection.runs.find(
            (candidate) => candidate.id === pendingMergeBackTransfer.sourcePoint.runId,
          ) ?? null);
    if (pendingMergeBackTransfer !== undefined && mergeBackSourceRun === null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Pending merge-back transfer ${pendingMergeBackTransfer.id} has no resolvable source run.`,
      });
    }
    const mergeBackSourceProviderThread =
      mergeBackSourceProjection === null || mergeBackSourceRun === null
        ? undefined
        : providerThreadForRun(mergeBackSourceProjection, mergeBackSourceRun);
    if (pendingMergeBackTransfer !== undefined && mergeBackSourceProviderThread === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Pending merge-back transfer ${pendingMergeBackTransfer.id} has no resolvable source provider thread.`,
      });
    }
    if (pendingMergeBackTransfer !== undefined) {
      yield* mapDispatchError(command)(
        commandPolicy.ensureContextHandoff({
          commandId: command.commandId,
          threadId: command.threadId,
          providerInstanceId: modelSelection.instanceId,
          capabilities,
          strategy: "fork_delta_context",
        }),
      );
    }
    const mergeBackDeltaItems =
      mergeBackSourceProjection === null || mergeBackSourceRun === null
        ? []
        : yield* Effect.gen(function* () {
            const sourceRuns = mergeBackSourceProjection.runs.filter(
              (run) => run.ordinal <= mergeBackSourceRun.ordinal,
            );
            const rawItems = yield* readHandoffItems(
              mergeBackSourceProjection.thread.id,
              sourceRuns.map((run) => run.id),
            );
            const { turnItems } = turnItemsSinceContextBoundary({
              runs: sourceRuns,
              turnItems: rawItems,
            });
            return visibleConversationItems(mergeBackSourceProjection, turnItems);
          });
    const mergeBackHandoff =
      pendingMergeBackTransfer === undefined ||
      mergeBackSourceProjection === null ||
      mergeBackSourceRun === null ||
      mergeBackSourceProviderThread === undefined
        ? null
        : yield* contextHandoffService
            .prepareForkDelta({
              sourceThreadId: pendingMergeBackTransfer.sourceThreadId,
              targetThreadId: command.threadId,
              targetRunId: runId,
              transferId: pendingMergeBackTransfer.id,
              fromProviderThreadIds: [mergeBackSourceProviderThread.id],
              toProviderThreadId: providerThread.id,
              fromProviderInstanceId: mergeBackSourceRun.providerInstanceId,
              toProviderInstanceId: modelSelection.instanceId,
              coveredRunOrdinals: visibleDeltaRunOrdinals(
                mergeBackSourceProjection,
                mergeBackDeltaItems,
              ),
              deltaItems: mergeBackDeltaItems,
              createdAt: now,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause,
                  }),
              ),
            );
    const checkpointScope = yield* checkpointService
      .prepareRootRunScope({
        threadId: command.threadId,
        runId,
        rootNodeId,
        providerThreadId: providerThread.id,
        cwd:
          resolvedRuntimePolicy.cwd ??
          existingProviderSession?.cwd ??
          projection.thread.worktreePath ??
          process.cwd(),
        createdAt: now,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause,
            }),
        ),
      );
    const run: OrchestrationV2Run = {
      id: runId,
      threadId: command.threadId,
      ordinal,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      providerThreadId: providerThread.id,
      userMessageId: command.messageId,
      rootNodeId,
      activeAttemptId: attemptId,
      status: "starting",
      queuePosition: null,
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId:
        portableForkHandoff?.id ??
        providerSwitchHandoff?.id ??
        mergeBackHandoff?.id ??
        legacyImportRecoveryHandoff?.id ??
        null,
      ...(command.sourcePlanRef === undefined ? {} : { sourcePlanRef: command.sourcePlanRef }),
      ...(command.restartContinuationOfRunId === undefined
        ? {}
        : { restartContinuationOfRunId: command.restartContinuationOfRunId }),
      ...(command.manualContinuationOfRunId === undefined
        ? {}
        : { manualContinuationOfRunId: command.manualContinuationOfRunId }),
      ...(command.usageLimitContinuationOfRunId === undefined
        ? {}
        : { usageLimitContinuationOfRunId: command.usageLimitContinuationOfRunId }),
      ...(continuedTaskId === undefined ? {} : { delegatedTaskId: continuedTaskId }),
      ...wakeWorkStartedAt(projection, command),
      ...output,
    };
    const attempt: OrchestrationV2RunAttempt = {
      id: attemptId,
      runId,
      attemptOrdinal: 1,
      rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      providerThreadId: providerThread.id,
      providerTurnId: null,
      reason: "initial",
      status: "pending",
      startedAt: null,
      completedAt: null,
    };
    const rootNode: OrchestrationV2ExecutionNode = {
      id: rootNodeId,
      threadId: command.threadId,
      runId,
      parentNodeId: null,
      rootNodeId,
      kind: "root_turn",
      status: "pending",
      countsForRun: true,
      providerThreadId: providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: checkpointScope.id,
      startedAt: null,
      completedAt: null,
    };
    const message: OrchestrationV2ConversationMessage = {
      createdBy: command.createdBy,
      creationSource: command.creationSource,
      ...(command.scheduledTaskId === undefined
        ? {}
        : { scheduledTaskId: command.scheduledTaskId }),
      ...(command.senderThreadId === undefined ? {} : { senderThreadId: command.senderThreadId }),
      ...(command.linkedSender === undefined ? {} : { linkedSender: command.linkedSender }),
      ...(command.idleCompaction === undefined ? {} : { idleCompaction: command.idleCompaction }),
      id: command.messageId,
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      role: "user",
      text: dispatchText,
      ...(command.context ? { context: command.context } : {}),
      attachments: command.attachments,
      streaming: false,
      createdAt: now,
      updatedAt: now,
      ...(delegatedCompletion === undefined ? {} : { delegatedCompletion }),
      ...(notification === undefined ? {} : { notification }),
    };
    const turnItem: OrchestrationV2TurnItem = {
      createdBy: command.createdBy,
      creationSource: command.creationSource,
      ...(command.scheduledTaskId === undefined
        ? {}
        : { scheduledTaskId: command.scheduledTaskId }),
      ...(command.senderThreadId === undefined ? {} : { senderThreadId: command.senderThreadId }),
      ...(command.linkedSender === undefined ? {} : { linkedSender: command.linkedSender }),
      ...(command.idleCompaction === undefined ? {} : { idleCompaction: command.idleCompaction }),
      id: idAllocator.derive.userTurnItem({ messageId: command.messageId }),
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: ordinal * 100,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "user_message",
      messageId: command.messageId,
      inputIntent: "turn_start",
      text: dispatchText,
      ...(command.context ? { context: command.context } : {}),
      attachments: command.attachments,
      ...(run.contextHandoffId === null
        ? modelSwitchSince(
            projection,
            modelSelection,
            // Side chats do not show the parent's runs.
            sideChatFork ? undefined : sourceRun?.modelSelection,
          )
        : {}),
    };
    // A side chat's "Context from" divider already marks its copied context.
    const activeHandoff =
      (sideChatFork ? null : portableForkHandoff) ?? mergeBackHandoff ?? providerSwitchHandoff;
    const handoffSourceRuns =
      portableForkHandoff !== null
        ? sourceRun === null
          ? []
          : [sourceRun]
        : providerSwitchHandoff === null
          ? mergeBackSourceRun === null
            ? []
            : [mergeBackSourceRun]
          : providerSwitchCoveredRuns;
    const handoffFromModelSelections = Array.from(
      new Map(
        handoffSourceRuns.map((run) => [
          `${run.modelSelection.instanceId}\0${run.modelSelection.model}`,
          run.modelSelection,
        ]),
      ).values(),
    );
    const handoffTurnItem: OrchestrationV2TurnItem | null =
      activeHandoff === null
        ? null
        : {
            id: idAllocator.derive.runSignalTurnItem({
              runId,
              signal: `context-handoff:${activeHandoff.id}`,
            }),
            threadId: command.threadId,
            runId,
            nodeId: rootNodeId,
            providerThreadId: providerThread.id,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal * 100 - 1,
            status: "completed",
            title:
              portableForkHandoff !== null
                ? "Fork context"
                : providerSwitchHandoff !== null
                  ? "Provider handoff"
                  : "Merge-back context",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "handoff",
            contextHandoffId: activeHandoff.id,
            fromProviderThreadIds: activeHandoff.fromProviderThreadIds,
            toProviderThreadId: activeHandoff.toProviderThreadId,
            fromProviderInstanceIds: Array.from(
              new Set(handoffSourceRuns.map((run) => run.providerInstanceId)),
            ),
            toProviderInstanceId: modelSelection.instanceId,
            fromModelSelections: handoffFromModelSelections,
            toModel: modelSelection.model,
            strategy: activeHandoff.strategy,
            summary: activeHandoff.summaryText,
          };
    const nativeForkResolution: OrchestrationV2ContextTransferResolution | null =
      !canResolveForkNatively || providerThread.nativeThreadRef === null
        ? null
        : {
            strategy: "native_fork",
            providerThreadRef: providerThread.nativeThreadRef,
          };
    const portableForkContext =
      portableForkHandoff ?? (sideChatWithoutSource ? sideChatContextHandoff : null);
    const portableForkResolution: OrchestrationV2ContextTransferResolution | null =
      pendingForkTransfer === undefined || portableForkContext === null
        ? null
        : {
            strategy: "portable_context",
            contextHandoffId: portableForkContext.id,
          };
    const mergeBackResolution: OrchestrationV2ContextTransferResolution | null =
      pendingMergeBackTransfer === undefined || mergeBackHandoff === null
        ? null
        : {
            strategy: "fork_delta_context",
            contextHandoffId: mergeBackHandoff.id,
          };

    if (pendingForkTransfer !== undefined && canResolveForkNatively) {
      yield* emitEvent({
        type: "context-transfer.updated",
        threadId: command.threadId,
        runId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: {
          ...pendingForkTransfer,
          targetProviderInstanceId: modelSelection.instanceId,
          targetRunId: runId,
          status: "pending",
          resolution: null,
          error: null,
          updatedAt: now,
        },
      });
    }
    if (pendingForkTransfer !== undefined && portableForkResolution !== null) {
      yield* emitEvent({
        type: "context-transfer.updated",
        threadId: command.threadId,
        runId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: {
          ...pendingForkTransfer,
          targetProviderInstanceId: modelSelection.instanceId,
          targetRunId: runId,
          status: "resolved_portable",
          resolution: portableForkResolution,
          error: null,
          updatedAt: now,
        },
      });
    }
    yield* emitEvent({
      type: "provider-thread.updated",
      threadId: command.threadId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: providerThread,
    });
    if (portableForkHandoff !== null) {
      yield* emitEvent({
        type: "context-handoff.updated",
        threadId: command.threadId,
        runId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: portableForkHandoff,
      });
    }
    if (sideChatContextHandoff !== null) {
      yield* emitEvent({
        type: "context-handoff.updated",
        threadId: command.threadId,
        runId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: sideChatContextHandoff,
      });
    }
    if (legacyImportRecoveryHandoff !== null) {
      yield* emitEvent({
        type: "context-handoff.updated",
        threadId: command.threadId,
        runId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: legacyImportRecoveryHandoff,
      });
    }
    if (
      providerSwitchTransferId !== null &&
      providerSwitchHandoff !== null &&
      latestHandoffRun !== undefined
    ) {
      const transfer: OrchestrationV2ContextTransfer = {
        id: providerSwitchTransferId,
        type: "provider_handoff",
        sourceThreadId: command.threadId,
        targetThreadId: command.threadId,
        sourcePoint: contextSourcePointForRun(projection, latestHandoffRun),
        basePoint:
          requiresFullProviderSwitchContext || targetLastCompletedRun === undefined
            ? null
            : contextSourcePointForRun(projection, targetLastCompletedRun),
        sourceProviderInstanceId: latestHandoffRun.providerInstanceId,
        targetProviderInstanceId: modelSelection.instanceId,
        targetRunId: runId,
        status: "consumed",
        resolution: {
          strategy:
            providerSwitchHandoff.strategy === "full_thread_summary"
              ? "portable_context"
              : "delta_context",
          contextHandoffId: providerSwitchHandoff.id,
        },
        createdBy: command.createdBy,
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: now,
      };
      yield* emitEvent({
        type: "context-transfer.created",
        threadId: command.threadId,
        runId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: transfer,
      });
      yield* emitEvent({
        type: "context-handoff.updated",
        threadId: command.threadId,
        runId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: providerSwitchHandoff,
      });
    }
    if (mergeBackHandoff !== null) {
      yield* emitEvent({
        type: "context-handoff.updated",
        threadId: command.threadId,
        runId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: mergeBackHandoff,
      });
    }
    for (const supersededTransfer of supersededMergeBackTransfers) {
      yield* emitEvent({
        type: "context-transfer.updated",
        threadId: command.threadId,
        runId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: {
          ...supersededTransfer,
          status: "superseded",
          error:
            pendingMergeBackTransfer === undefined
              ? "Superseded while consuming merge-back transfer."
              : `Superseded by merge-back transfer ${pendingMergeBackTransfer.id}.`,
          updatedAt: now,
        },
      });
    }
    if (pendingMergeBackTransfer !== undefined && mergeBackResolution !== null) {
      yield* emitEvent({
        type: "context-transfer.updated",
        threadId: command.threadId,
        runId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: {
          ...pendingMergeBackTransfer,
          targetProviderInstanceId: modelSelection.instanceId,
          targetRunId: runId,
          status: "consumed",
          resolution: mergeBackResolution,
          error: null,
          updatedAt: now,
          consumedAt: now,
        },
      });
    }
    yield* emitEvent({
      type: "run.created",
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: run,
    });
    yield* completeSourcePlan(now);
    yield* emitEvent({
      type: "run-attempt.created",
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: attempt,
    });
    yield* emitEvent({
      type: "node.updated",
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: rootNode,
    });
    yield* emitEvent({
      type: "checkpoint-scope.created",
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: checkpointScope,
    });
    if (handoffTurnItem !== null) {
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: handoffTurnItem,
      });
    }
    yield* emitEvent({
      type: "message.updated",
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: message,
    });
    yield* emitEvent({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: notificationTurnItem(
        turnItem,
        message,
        yield* notificationTasks(command.threadId, message, projection.subagents),
      ),
    });
    const forkResolution = nativeForkResolution ?? portableForkResolution;
    if (pendingForkTransfer !== undefined && forkResolution !== null) {
      yield* emitEvent({
        type: "context-transfer.updated",
        threadId: command.threadId,
        runId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: {
          ...pendingForkTransfer,
          targetProviderInstanceId: modelSelection.instanceId,
          targetRunId: runId,
          status: "consumed",
          resolution: forkResolution,
          error: null,
          updatedAt: now,
          consumedAt: now,
        },
      });
    }

    const detachDetail = canResumeAcrossInstances
      ? "Provider account changed; continuing the native thread."
      : "Provider or model selection changed.";
    for (const session of sessionsToDetach) {
      yield* emitEvent({
        type: "provider-session.detached",
        threadId: command.threadId,
        driver: session.driver,
        providerInstanceId: session.providerInstanceId,
        occurredAt: now,
        payload: {
          providerSessionId: session.id,
          detachedAt: now,
          reason: detachDetail,
        },
      });
      yield* Ref.update(effects, (existing) => [
        ...existing,
        {
          id: `effect:${command.commandId}:provider-session.detach:${session.id}`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: {
            type: "provider-session.detach",
            providerSessionId: session.id,
            detail: detachDetail,
          },
        } satisfies PendingOrchestrationEffectV2,
      ]);
    }
    const pendingEffect = {
      id: `effect:${command.commandId}:provider-turn.start:${runId}`,
      commandId: command.commandId,
      threadId: command.threadId,
      request: { type: "provider-turn.start", runId },
    } satisfies PendingOrchestrationEffectV2;
    yield* Ref.update(effects, (existing) => [...existing, pendingEffect]);
  });

  const dispatchQueuedMessagePromoteToSteer = Effect.fn(
    "Orchestrator.dispatchQueuedMessagePromoteToSteer",
  )(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "queued-message.promote-to-steer" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const projection = yield* loadProjectionForCommand(
      command,
      [
        "runs",
        "nodes",
        "attempts",
        "messages",
        "providerThreads",
        "providerTurns",
        "providerSessions",
        "turnItems",
        "runtimeRequests",
        "subagents",
      ],
      // User messages measure a restart's model switch. Steering reads root and live nodes only.
      { turnItemTypes: ["user_message"], messageRoles: ["user"], omitSettledLeafNodes: true },
    );
    if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} is not active.`,
      });
    }
    const queuedRun = projection.runs.find((candidate) => candidate.id === command.queuedRunId);
    if (queuedRun === undefined || queuedRun.status !== "queued") {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Queued run ${command.queuedRunId} is not queued.`,
      });
    }
    const queuedRootNode =
      queuedRun.rootNodeId === null
        ? undefined
        : projection.nodes.find((candidate) => candidate.id === queuedRun.rootNodeId);
    const queuedAttempt =
      queuedRun.activeAttemptId === null
        ? undefined
        : projection.attempts.find((candidate) => candidate.id === queuedRun.activeAttemptId);
    const queuedMessage = projection.messages.find(
      (candidate) => candidate.id === queuedRun.userMessageId,
    );
    if (
      queuedRootNode === undefined ||
      queuedAttempt === undefined ||
      queuedMessage === undefined
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Queued run ${queuedRun.id} is missing message or execution state.`,
      });
    }
    if (
      queuedMessage.delegatedCompletion !== undefined ||
      queuedMessage.notification !== undefined
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Automatic completion deliveries cannot be promoted to Steer.",
      });
    }

    const now = yield* DateTime.now;
    const emitEvent = emit(events, command);
    // A scheduled delivery steers on the thread's current pick, so /goal must suit that provider.
    const modelSelection = queuedRunModelSelection(projection, queuedRun);
    const parsedGoalCommand = parseGoalCommand(queuedMessage);
    const goalCommand =
      parsedGoalCommand === null ||
      (yield* goalDriverFor(command, modelSelection.instanceId)) === undefined
        ? null
        : parsedGoalCommand;
    const target = projection.runs.find((run) => run.id === command.targetRunId);
    const targetMessage = projection.messages.find(
      (message) => message.id === target?.userMessageId,
    );
    // A compacting turn cannot take steering input, so steering skips the compaction instead.
    if (
      target !== undefined &&
      targetMessage !== undefined &&
      isCompactionCommandMessage(targetMessage)
    ) {
      if (goalCommand !== null) {
        yield* ensureGoalCommandSupported(command, queuedMessage, modelSelection.instanceId);
      }
      yield* emitEvent({
        type: "run.updated",
        threadId: command.threadId,
        runId: queuedRun.id,
        nodeId: queuedRootNode.id,
        providerInstanceId: queuedRun.providerInstanceId,
        occurredAt: now,
        payload: { ...queuedRun, queuePosition: 1 },
      });
      const stops =
        isLiveRun(target) && !(yield* stopReachedRun(command, command.threadId, target.id));
      return yield* callbacks.stopRunForQueuedCommand({
        command,
        events,
        effects,
        projection,
        queuedRunId: queuedRun.id,
        targetRunId: stops ? target.id : undefined,
        reason: "Skipped compaction to send a queued message",
        now,
      });
    }
    // Skipping compaction starts the message as its own turn; steering would join the current one.
    if (queuedRun.freshContext === true) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "A message that starts a fresh session can't steer the current turn.",
      });
    }
    // Steering joins a turn that was not asked for this message's result, so it would be lost.
    if (queuedRun.outputSchema !== undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "A message that asks for a result can't steer the current turn.",
      });
    }
    // A steered command replaces the turn's task, so promoting one only moves it first.
    if (goalCommand !== null || isSlashCommand(queuedMessage)) {
      if (goalCommand !== null) {
        yield* ensureGoalCommandSupported(command, queuedMessage, modelSelection.instanceId);
      }
      const goal = projection.providerThreads.find(
        (candidate) => candidate.id === target?.providerThreadId,
      )?.goal;
      yield* emitEvent({
        type: "run.updated",
        threadId: command.threadId,
        runId: queuedRun.id,
        nodeId: queuedRootNode.id,
        providerInstanceId: queuedRun.providerInstanceId,
        occurredAt: now,
        payload: { ...queuedRun, queuePosition: 1 },
      });
      const stops =
        goalCommand !== null &&
        target !== undefined &&
        isLiveRun(target) &&
        goalCommandStopsActiveRun(goalCommand, goal?.status ?? null) &&
        (targetMessage === undefined || !isNativeMaintenanceCommand(targetMessage)) &&
        !(yield* stopReachedRun(command, command.threadId, target.id));
      return yield* callbacks.stopRunForQueuedCommand({
        command,
        events,
        effects,
        projection,
        queuedRunId: queuedRun.id,
        targetRunId: stops ? target.id : undefined,
        reason: "Stopped to apply /goal",
        now,
      });
    }
    if (
      (target?.status === "preparing" ||
        target?.status === "starting" ||
        (target?.status === "running" &&
          !projection.providerTurns.some(
            (turn) => turn.runAttemptId === target.activeAttemptId && turn.status === "running",
          ))) &&
      !(yield* stopReachedRun(command, command.threadId, target.id))
    ) {
      if (yield* limitForbidsParkedSteer) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "The current turn is not running yet. Try again once it is.",
        });
      }
      yield* ensureSteeringMessage(command, queuedMessage);
      const adapter = yield* providerAdapters
        .get(target.providerInstanceId)
        .pipe(mapDispatchError(command));
      const capabilities = yield* adapter.getCapabilities().pipe(mapDispatchError(command));
      yield* commandPolicy
        .decideSteeringExecution({
          commandId: command.commandId,
          threadId: command.threadId,
          providerInstanceId: target.providerInstanceId,
          capabilities,
        })
        .pipe(mapDispatchError(command));
      yield* emitEvent({
        type: "run.updated",
        threadId: command.threadId,
        runId: queuedRun.id,
        nodeId: queuedRootNode.id,
        providerInstanceId: queuedRun.providerInstanceId,
        occurredAt: now,
        payload: { ...queuedRun, steerWhenReadyRunId: target.id },
      });
      return;
    }
    yield* emitEvent({
      type: "run.updated",
      threadId: command.threadId,
      runId: queuedRun.id,
      nodeId: queuedRootNode.id,
      providerInstanceId: queuedRun.providerInstanceId,
      occurredAt: now,
      payload: {
        ...queuedRun,
        status: "cancelled",
        queuePosition: null,
        completedAt: now,
      },
    });
    yield* emitEvent({
      type: "run-attempt.updated",
      threadId: command.threadId,
      runId: queuedRun.id,
      nodeId: queuedRootNode.id,
      providerInstanceId: queuedRun.providerInstanceId,
      occurredAt: now,
      payload: {
        ...queuedAttempt,
        status: "cancelled",
        completedAt: now,
      },
    });
    yield* emitEvent({
      type: "node.updated",
      threadId: command.threadId,
      runId: queuedRun.id,
      nodeId: queuedRootNode.id,
      providerInstanceId: queuedRun.providerInstanceId,
      occurredAt: now,
      payload: {
        ...queuedRootNode,
        status: "cancelled",
        completedAt: now,
      },
    });

    yield* dispatchSteerIntoRun({
      command,
      events,
      effects,
      projection,
      modelSelection,
      targetRunId: command.targetRunId,
      messageId: queuedMessage.id,
      text: queuedMessage.text,
      attachments: queuedMessage.attachments,
      ...(queuedMessage.context ? { context: queuedMessage.context } : {}),
      createdBy: queuedMessage.createdBy,
      creationSource: queuedMessage.creationSource,
      ...(queuedMessage.scheduledTaskId === undefined
        ? {}
        : { scheduledTaskId: queuedMessage.scheduledTaskId }),
      ...(queuedMessage.senderThreadId === undefined
        ? {}
        : { senderThreadId: queuedMessage.senderThreadId }),
      ...(queuedMessage.linkedSender === undefined
        ? {}
        : { linkedSender: queuedMessage.linkedSender }),
      ...(queuedMessage.idleCompaction === undefined
        ? {}
        : { idleCompaction: queuedMessage.idleCompaction }),
      forceRestart: false,
    });
  });

  const dispatchQueuedRunReorder = Effect.fn("Orchestrator.dispatchQueuedRunReorder")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "queued-run.reorder" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const projection = yield* loadProjectionForCommand(command, ["runs", "messages"], {
      messageRoles: ["user"],
    });
    const queuedRuns = queuedRunsInDeliveryOrder(projection);
    const moving = queuedRuns.find((run) => run.id === command.runId);
    if (moving === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Run ${command.runId} is not queued.`,
      });
    }
    const movingMessage = projection.messages.find(
      (candidate) => candidate.id === moving.userMessageId,
    );
    if (
      movingMessage?.delegatedCompletion !== undefined ||
      movingMessage?.notification !== undefined
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Automatic completion deliveries cannot be reordered.",
      });
    }
    const automaticRuns = queuedRuns.filter((run) => isAutomaticCompletionRun(projection, run));
    if (
      command.beforeRunId !== null &&
      automaticRuns.some((run) => run.id === command.beforeRunId)
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Queued messages cannot be reordered ahead of automatic completion delivery.",
      });
    }
    const reorderableRuns = queuedRuns.filter((run) => !isAutomaticCompletionRun(projection, run));
    const withoutMoving = reorderableRuns.filter((run) => run.id !== command.runId);
    const beforeIndex =
      command.beforeRunId === null
        ? withoutMoving.length
        : withoutMoving.findIndex((run) => run.id === command.beforeRunId);
    if (beforeIndex === -1) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Queue target ${command.beforeRunId} is not queued.`,
      });
    }
    const reordered = [
      ...automaticRuns,
      ...withoutMoving.slice(0, beforeIndex),
      moving,
      ...withoutMoving.slice(beforeIndex),
    ];
    const now = yield* DateTime.now;
    const emitEvent = emit(events, command);
    yield* Effect.forEach(
      reordered,
      (run, index) =>
        Effect.gen(function* () {
          const queuePosition = index + 1;
          if (run.queuePosition === queuePosition) {
            return;
          }
          yield* emitEvent({
            type: "run.updated",
            threadId: command.threadId,
            runId: run.id,
            ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: {
              ...run,
              queuePosition,
            },
          });
        }),
      { concurrency: 1 },
    );
  });

  const dispatchQueuedRunCancel = Effect.fn("Orchestrator.dispatchQueuedRunCancel")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "queued-run.cancel" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    // Settling disposes a cancelled wake's whole cohort, so a sibling's late result cannot unsettle it.
    disposes: "wake" | "cohort" = "wake",
  ) {
    const projection = yield* loadProjectionForCommand(
      command,
      ["runs", "messages", "nodes", "attempts", "subagents", "turnItems"],
      // Cancelling reads the queued run's own message and root node, never a settled leaf.
      {
        turnItemTypes: [],
        messageRoles: ["user"],
        messageRunIds: [command.runId],
        omitSettledLeafNodes: true,
      },
    );
    const queuedRun = projection.runs.find((candidate) => candidate.id === command.runId);
    if (queuedRun === undefined || queuedRun.status !== "queued") {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Run ${command.runId} is not queued.`,
      });
    }
    const queuedMessage = projection.messages.find(
      (candidate) => candidate.id === queuedRun.userMessageId,
    );
    const now = yield* DateTime.now;
    if (queuedMessage?.delegatedCompletion !== undefined) {
      yield* callbacks.disposeDelegatedCompletionCohort({
        command,
        events,
        projection,
        parentRunId: queuedMessage.delegatedCompletion.parentRunId,
        disposition: "disposed",
        now,
        cancelQueuedDelivery: false,
        ...(disposes === "wake"
          ? { interruptedWakeTaskIds: queuedMessage.delegatedCompletion.taskIds }
          : {}),
      });
    }
    yield* emitQueuedRunCancellation({ command, events, projection, run: queuedRun, now });
    const emitEvent = emit(events, command);
    const guest = queuedMessage?.context?.guest;
    if (guest !== undefined) {
      const thread = guestShareAfterCancelledSend(projection.thread, guest, now);
      if (thread !== projection.thread) {
        yield* emitEvent({
          type: "thread.guest-share-updated",
          threadId: command.threadId,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: now,
          payload: thread,
        });
      }
    }
  });

  const dispatchRunOutputSubmit = Effect.fn("Orchestrator.dispatchRunOutputSubmit")(function* (
    command: Extract<OrchestrationV2InternalCommand, { readonly type: "run.output.submit" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const projection = yield* projectionStore
      .getThreadRecords(command.threadId, ["runs"])
      .pipe(mapDispatchError(command));
    const run = projection.runs.find((candidate) => candidate.id === command.runId);
    if (run?.outputSchema === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Run ${command.runId} was not asked for a result.`,
      });
    }
    // The service picks the active run, but the run can end before this command is its turn. A
    // turn that completed without its result still owes it, and a later turn may give it.
    const owes = run.status === "completed" && run.output === undefined;
    if (!isActiveRun(run) && !owes) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Run ${command.runId} is ${run.status} and takes no result.`,
      });
    }
    // A stopped run stays active until its provider settles; what it submits then is not kept.
    if (yield* stopReachedRun(command, command.threadId, run.id)) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Run ${command.runId} was stopped and takes no result.`,
      });
    }
    const now = yield* DateTime.now;
    yield* emit(
      events,
      command,
    )({
      type: "run.output-submitted",
      threadId: command.threadId,
      runId: run.id,
      ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: {
        runId: run.id,
        output: { value: command.value, submittedAt: DateTime.formatIso(now) },
      },
    });
  });

  const dispatchQueuedRunEdit = Effect.fn("Orchestrator.dispatchQueuedRunEdit")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "queued-run.edit" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    if (command.text.trim().length === 0) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Queued run ${command.runId} cannot be edited to an empty message.`,
      });
    }
    const projection = yield* loadProjectionForCommand(command, ["runs", "messages", "turnItems"], {
      turnItemTypes: ["user_message"],
      messageRoles: ["user"],
    });
    const queuedRun = projection.runs.find((candidate) => candidate.id === command.runId);
    if (queuedRun === undefined || queuedRun.status !== "queued") {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Run ${command.runId} is not queued.`,
      });
    }
    const queuedMessage = projection.messages.find(
      (candidate) => candidate.id === queuedRun.userMessageId,
    );
    if (queuedMessage === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Queued run ${queuedRun.id} has no user message.`,
      });
    }
    if (
      queuedMessage.delegatedCompletion !== undefined ||
      queuedMessage.notification !== undefined
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Automatic completion deliveries cannot be edited.",
      });
    }
    // The agent text and the shown text of a guest message must stay the guest's words.
    if (queuedMessage.context?.guest !== undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "A guest's message cannot be edited. Cancel it instead.",
      });
    }
    const modelSelection = command.modelSelection ?? queuedRunModelSelection(projection, queuedRun);
    yield* ensureGoalCommandSupported(
      command,
      { text: command.text, attachments: command.attachments ?? queuedMessage.attachments },
      modelSelection.instanceId,
    );
    const editProblem =
      queuedRun.outputSchema === undefined
        ? null
        : outputRequestProblem(queuedRun.outputSchema, {
            text: command.text,
            attachments: command.attachments ?? queuedMessage.attachments,
          });
    if (editProblem !== null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: editProblem,
      });
    }
    const queuedTurnItem = projection.turnItems.find(
      (candidate) => candidate.type === "user_message" && candidate.messageId === queuedMessage.id,
    );

    const now = yield* DateTime.now;
    const emitEvent = emit(events, command);
    let updatedRun =
      command.modelSelection === undefined
        ? queuedRun
        : { ...queuedRun, modelSelection, providerInstanceId: modelSelection.instanceId };
    if (
      updatedRun.steerWhenReadyRunId !== undefined &&
      (isSlashCommand({
        text: command.text,
        attachments: command.attachments ?? queuedMessage.attachments,
      }) ||
        (yield* limitForbidsParkedSteer))
    ) {
      const { steerWhenReadyRunId: _, ...queued } = updatedRun;
      updatedRun = queued;
    }
    if (updatedRun !== queuedRun) {
      yield* emitEvent({
        type: "run.updated",
        threadId: command.threadId,
        runId: queuedRun.id,
        ...(queuedRun.rootNodeId === null ? {} : { nodeId: queuedRun.rootNodeId }),
        providerInstanceId: updatedRun.providerInstanceId,
        occurredAt: now,
        payload: updatedRun,
      });
    }
    const editedAttachments =
      command.attachments === undefined ? {} : { attachments: command.attachments };
    const { followsThreadSelection: _followsThreadSelection, ...pinnedMessage } = queuedMessage;
    yield* emitEvent({
      type: "message.updated",
      threadId: command.threadId,
      runId: queuedRun.id,
      ...(queuedRun.rootNodeId === null ? {} : { nodeId: queuedRun.rootNodeId }),
      providerInstanceId: queuedRun.providerInstanceId,
      occurredAt: now,
      payload: withoutGuestAttribution({
        ...(command.modelSelection === undefined ? queuedMessage : pinnedMessage),
        text: command.text,
        ...editedAttachments,
        ...(command.context ? { context: command.context } : {}),
        updatedAt: now,
      }),
    });
    if (queuedTurnItem !== undefined && queuedTurnItem.type === "user_message") {
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: queuedRun.id,
        ...(queuedRun.rootNodeId === null ? {} : { nodeId: queuedRun.rootNodeId }),
        providerInstanceId: queuedRun.providerInstanceId,
        occurredAt: now,
        payload: withoutGuestAttribution({
          ...queuedTurnItem,
          text: command.text,
          ...editedAttachments,
          ...(command.context ? { context: command.context } : {}),
          updatedAt: now,
        }),
      });
    }
    // Thread deletion only cleans files the thread still references.
    const keptAttachmentIds = new Set(
      (command.attachments ?? queuedMessage.attachments).map((attachment) => attachment.id),
    );
    const droppedAttachmentIds = queuedMessage.attachments
      .map((attachment) => attachment.id)
      .filter((id) => !keptAttachmentIds.has(id));
    if (droppedAttachmentIds.length > 0) {
      yield* Ref.update(effects, (existing) => [
        ...existing,
        {
          id: `effect:${command.commandId}:attachment.cleanup`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: {
            type: "attachment.cleanup",
            attachmentIds: droppedAttachmentIds,
            skipReferenced: true,
          },
        } satisfies PendingOrchestrationEffectV2,
      ]);
    }
  });

  const preparedRunState = (
    command: Extract<
      OrchestrationV2Command,
      {
        readonly type:
          | "prepared-run.release"
          | "prepared-run.progress"
          | "prepared-run.fail"
          | "prepared-run.retry";
      }
    >,
    projection: Pick<
      OrchestrationV2ThreadProjection,
      "runs" | "attempts" | "nodes" | "providerThreads" | "turnItems"
    >,
  ) => {
    const run = projection.runs.find((candidate) => candidate.id === command.runId);
    const attempt = projection.attempts.find((candidate) => candidate.id === run?.activeAttemptId);
    const rootNode = projection.nodes.find((candidate) => candidate.id === run?.rootNodeId);
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === run?.providerThreadId,
    );
    const preparationItem = projection.turnItems.find(
      (
        candidate,
      ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }> =>
        candidate.runId === command.runId &&
        candidate.type === "command_execution" &&
        candidate.input === WORKSPACE_PREPARATION_INPUT,
    );
    if (
      run?.status !== (command.type === "prepared-run.retry" ? "failed" : "preparing") ||
      attempt === undefined ||
      rootNode === undefined ||
      providerThread === undefined ||
      preparationItem === undefined
    ) {
      return null;
    }
    return { run, attempt, rootNode, providerThread, preparationItem } as const;
  };

  const dispatchPreparedRunProgress = Effect.fn("Orchestrator.dispatchPreparedRunProgress")(
    function* (
      command: Extract<OrchestrationV2Command, { readonly type: "prepared-run.progress" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    ) {
      const projection = yield* loadProjectionForCommand(
        command,
        ["runs", "attempts", "nodes", "providerThreads", "turnItems"],
        { turnItemTypes: ["command_execution"], turnItemRunId: command.runId },
      );
      const state = preparedRunState(command, projection);
      if (state === null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} is not awaiting workspace preparation.`,
        });
      }
      const now = yield* DateTime.now;
      yield* emit(
        events,
        command,
      )({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: {
          ...state.preparationItem,
          title: command.phase === "worktree" ? "Preparing worktree" : "Starting setup script",
          updatedAt: now,
        },
      });
    },
  );

  const dispatchPreparedRunRelease = Effect.fn("Orchestrator.dispatchPreparedRunRelease")(
    function* (
      command: Extract<OrchestrationV2Command, { readonly type: "prepared-run.release" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
      effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    ) {
      const projection = yield* loadProjectionForCommand(
        command,
        ["runs", "attempts", "nodes", "providerThreads", "turnItems"],
        { turnItemTypes: ["command_execution"], turnItemRunId: command.runId },
      );
      const state = preparedRunState(command, projection);
      if (state === null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} is not awaiting workspace preparation.`,
        });
      }
      const now = yield* DateTime.now;
      const resolvedRuntimePolicy = yield* runtimePolicy
        .resolve({ thread: projection.thread, modelSelection: state.run.modelSelection })
        .pipe(mapDispatchError(command));
      const checkpointScope = yield* checkpointService
        .prepareRootRunScope({
          threadId: command.threadId,
          runId: state.run.id,
          rootNodeId: state.rootNode.id,
          providerThreadId: state.providerThread.id,
          cwd: resolvedRuntimePolicy.cwd ?? projection.thread.worktreePath ?? process.cwd(),
          createdAt: now,
        })
        .pipe(mapDispatchError(command));
      const emitEvent = emit(events, command);
      yield* emitEvent({
        type: "checkpoint-scope.created",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: checkpointScope,
      });
      yield* emitEvent({
        type: "node.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: { ...state.rootNode, checkpointScopeId: checkpointScope.id },
      });
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: {
          ...state.preparationItem,
          status: "completed",
          title: "Workspace ready",
          output: "Workspace preparation completed.",
          exitCode: 0,
          completedAt: now,
          updatedAt: now,
        },
      });
      yield* emitEvent({
        type: "run.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: { ...state.run, status: "starting" },
      });
      yield* Ref.update(effects, (existing) => [
        ...existing,
        {
          id: `effect:${command.commandId}:provider-turn.start:${state.run.id}`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: { type: "provider-turn.start", runId: state.run.id },
        } satisfies PendingOrchestrationEffectV2,
      ]);
    },
  );

  const dispatchPreparedRunFail = Effect.fn("Orchestrator.dispatchPreparedRunFail")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "prepared-run.fail" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const projection = yield* loadProjectionForCommand(
      command,
      ["runs", "attempts", "nodes", "providerThreads", "turnItems"],
      { turnItemTypes: ["command_execution"], turnItemRunId: command.runId },
    );
    const state = preparedRunState(command, projection);
    if (state === null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Run ${command.runId} is not awaiting workspace preparation.`,
      });
    }
    const now = yield* DateTime.now;
    const emitEvent = emit(events, command);
    yield* emitEvent({
      type: "run-attempt.updated",
      threadId: command.threadId,
      runId: state.run.id,
      nodeId: state.rootNode.id,
      providerInstanceId: state.run.providerInstanceId,
      occurredAt: now,
      payload: { ...state.attempt, status: "failed", completedAt: now },
    });
    yield* emitEvent({
      type: "node.updated",
      threadId: command.threadId,
      runId: state.run.id,
      nodeId: state.rootNode.id,
      providerInstanceId: state.run.providerInstanceId,
      occurredAt: now,
      payload: { ...state.rootNode, status: "failed", completedAt: now },
    });
    yield* emitEvent({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId: state.run.id,
      nodeId: state.rootNode.id,
      providerInstanceId: state.run.providerInstanceId,
      occurredAt: now,
      payload: {
        ...state.preparationItem,
        status: "failed",
        title: "Workspace preparation failed",
        output: command.failure.message,
        exitCode: 1,
        completedAt: now,
        updatedAt: now,
      },
    });
    yield* emitEvent({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId: state.run.id,
      nodeId: state.rootNode.id,
      providerInstanceId: state.run.providerInstanceId,
      occurredAt: now,
      payload: {
        id: idAllocator.derive.turnItemFromProviderItem({
          driver: state.providerThread.driver,
          nativeItemId: `workspace-preparation-failure:${state.run.id}`,
        }),
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerThreadId: state.providerThread.id,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: yield* nextTurnItemOrdinal(projection),
        status: "failed",
        title: "Workspace preparation failed",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "error",
        failure: {
          ...command.failure,
          code: ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
        },
      },
    });
    yield* emitEvent({
      type: "run.updated",
      threadId: command.threadId,
      runId: state.run.id,
      nodeId: state.rootNode.id,
      providerInstanceId: state.run.providerInstanceId,
      occurredAt: now,
      payload: { ...state.run, status: "failed", completedAt: now },
    });
  });

  const dispatchPreparedRunRetry = Effect.fn("Orchestrator.dispatchPreparedRunRetry")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "prepared-run.retry" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const projection = yield* loadProjectionForCommand(
      command,
      ["runs", "attempts", "nodes", "providerThreads", "turnItems"],
      { turnItemTypes: ["command_execution", "error"], turnItemRunId: command.runId },
    );
    const state = preparedRunState(command, projection);
    const failureItem = projection.turnItems.find(
      (candidate): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "error" }> =>
        candidate.type === "error" &&
        candidate.status === "failed" &&
        candidate.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
    );
    if (
      state === null ||
      state.run.workspacePreparation === undefined ||
      failureItem === undefined ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Run ${command.runId} has no failed workspace preparation to retry.`,
      });
    }
    if (projection.runs.some((run) => run.id !== state.run.id && isActiveRun(run))) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Another run is active on this thread.",
      });
    }
    const now = yield* DateTime.now;
    const emitEvent = emit(events, command);
    const scope = {
      threadId: command.threadId,
      runId: state.run.id,
      nodeId: state.rootNode.id,
      providerInstanceId: state.run.providerInstanceId,
      occurredAt: now,
    };
    yield* emitEvent({
      ...scope,
      type: "turn-item.updated",
      payload: { ...failureItem, status: "cancelled", updatedAt: now },
    });
    yield* emitEvent({
      ...scope,
      type: "turn-item.updated",
      payload: {
        ...withoutPreparationResult(state.preparationItem),
        status: "running",
        title: WORKSPACE_PREPARATION_INPUT,
        completedAt: null,
        updatedAt: now,
      },
    });
    yield* emitEvent({
      ...scope,
      type: "run-attempt.updated",
      payload: { ...state.attempt, status: "pending", completedAt: null },
    });
    yield* emitEvent({
      ...scope,
      type: "node.updated",
      payload: { ...state.rootNode, status: "pending", completedAt: null },
    });
    yield* emitEvent({
      ...scope,
      type: "run.updated",
      payload: { ...state.run, status: "preparing", completedAt: null },
    });
    // Messages held when this preparation failed follow the run again. A hold
    // from a later run (a stop, say) is not this failure's to release.
    const failureOwnsQueue = latestExecutedRun(projection.runs)?.id === state.run.id;
    for (const run of projection.runs) {
      if (!failureOwnsQueue || run.status !== "queued" || run.queueHeld !== true) continue;
      yield* emitEvent({
        type: "run.updated",
        threadId: command.threadId,
        runId: run.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: { ...run, queueHeld: false },
      });
    }
  });

  return {
    dispatchMessage,
    dispatchQueuedMessagePromoteToSteer,
    dispatchQueuedRunReorder,
    dispatchQueuedRunCancel,
    dispatchRunOutputSubmit,
    dispatchQueuedRunEdit,
    dispatchPreparedRunProgress,
    dispatchPreparedRunRelease,
    dispatchPreparedRunFail,
    dispatchPreparedRunRetry,
  };
}
