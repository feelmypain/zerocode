import type {
  GuestShareId,
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadLinkMetadata,
  ProjectId,
} from "@zerocode/contracts";
import {
  CommandId,
  isOrchestrationV2WorkActive,
  type MessageId,
  type NodeId,
  OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2LimitRecoveryUpdate,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationV2TurnItem,
  type RunId,
  ThreadId,
  type TurnItemId,
} from "@zerocode/contracts";
import * as IdAllocator from "@zerocode/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@zerocode/provider-core/server/ProviderContinuationRequests";
import { delegatedTaskProgress } from "@zerocode/provider-core/server/subagentProjection";
import * as KeyedLock from "@zerocode/shared/KeyedLock";
import { backgroundWorkHoldsCompletion } from "@zerocode/shared/orchestrationV2PendingBackgroundWork";
import { latestExecutedRun } from "@zerocode/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { withCommandMetrics } from "../observability/Metrics.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TaskFolderStore from "../workspace/TaskFolderStore.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { CommandPolicyV2, isActiveRun } from "./CommandPolicy.ts";
import { CommandReceiptStoreV2, type CommandReceiptV2 } from "./CommandReceiptStore.ts";
import { ContextHandoffServiceV2 } from "./ContextHandoffService.ts";
import { DispatchModeLimit, type RuntimeModeCeiling } from "./DispatchModeLimit.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { withoutGuestAttribution } from "./GuestShareDecider.ts";
import { makeApprovalAndInputCommands } from "./orchestrator/orchestratorApprovalAndInputCommands.ts";
import { makeCheckpointCommands } from "./orchestrator/orchestratorCheckpointCommands.ts";
import { makeQueueRunner } from "./orchestrator/orchestratorQueueRunner.ts";
import { makeRunCommands } from "./orchestrator/orchestratorRunCommands.ts";
import { makeRunStopCommands } from "./orchestrator/orchestratorRunStopCommands.ts";
import {
  type CancelUnsettledEffects,
  commandThreadId,
  delegatedTasksStopEffect,
  delegatedTaskTerminalStatus,
  hasRunningDelegatedTasks,
  isLiveRun,
  makeOrchestratorShared,
  mayStartSubagentFollowup,
  OrchestratorCommandIdConflictError,
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorCommandRejectedError,
  OrchestratorDispatchError,
  OrchestratorDomainEventStreamError,
  OrchestratorProjectionError,
  OrchestratorProviderAdapterError,
  OrchestratorProviderSelectionBusyError,
  OrchestratorRuntimeModeAboveCeilingError,
  OrchestratorSubagentThreadReadOnlyError,
  OrchestratorThreadAboveModeLimitError,
  OrchestratorThreadAlreadyExistsError,
  OrchestratorV2Error,
  type OrchestratorV2DispatchResult,
  providerTurnForRun,
  QUEUED_TURN_START_GRACE_MS,
  queuedRunModelSelection,
  runtimePolicyCeilingCause,
  shouldPrepareLegacyImportHandoff,
  threadHasUnfinishedWork,
  usageLimitHoldsQueue,
  worktreeSetupPending,
} from "./orchestrator/orchestratorShared.ts";
import { makeSubagentCommands } from "./orchestrator/orchestratorSubagentCommands.ts";
import { makeThreadCommands } from "./orchestrator/orchestratorThreadCommands.ts";
import {
  ProjectionStoreV2,
  type ActiveShellIndexEntry,
  type ActiveThreadListEntry,
  type OlderSettledThreadsListing,
  type OlderSettledThreadsQuery,
  type ProjectionCheckpointContext,
  type ProjectionRecordField,
  type ProjectionRecordFilter,
  type ProjectionRecords,
  type ProjectionTimelinePage,
  type ProjectionTimelinePageOptions,
  type ShellSnapshotOptions,
} from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { ProviderSwitchServiceV2 } from "./ProviderSwitchService.ts";
import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";
import {
  delegatedTaskAwaitsWork,
  delegatedTaskResultRun,
  delegatedTaskRuns,
  runOutcome,
} from "./RestartBackgroundNote.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { planThreadDeletion } from "./ThreadDeletion.ts";
import { ThreadForkServiceV2 } from "./ThreadForkService.ts";

export {
  OrchestratorCommandIdConflictError,
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorCommandRejectedError,
  OrchestratorDispatchError,
  OrchestratorDomainEventStreamError,
  OrchestratorProjectionError,
  OrchestratorProviderAdapterError,
  OrchestratorProviderSelectionBusyError,
  OrchestratorRuntimeModeAboveCeilingError,
  OrchestratorSubagentThreadReadOnlyError,
  OrchestratorThreadAboveModeLimitError,
  OrchestratorThreadAlreadyExistsError,
  OrchestratorV2Error,
  providerTurnForRun,
  QUEUED_TURN_START_GRACE_MS,
  shouldPrepareLegacyImportHandoff,
  threadHasUnfinishedWork,
};
export type { OrchestratorV2DispatchResult };

export interface OrchestratorV2Shape {
  readonly resumeQueuedRuns: Effect.Effect<number, OrchestratorV2Error>;
  readonly recoverDelegatedTasks: Effect.Effect<void>;
  readonly recoverDelegatedTask: (
    threadId: ThreadId,
    options?: { readonly sourceRunId?: RunId; readonly completedRunId?: RunId },
  ) => Effect.Effect<void, OrchestratorProjectionError>;
  /** Commits cancellation with the child's Stop after descendants accept stopping. */
  readonly cancelDelegatedTask: <E, R>(input: {
    readonly parentThreadId: ThreadId;
    readonly taskId: NodeId;
    readonly command: Extract<OrchestrationV2ServerCommand, { readonly type: "thread.stop" }>;
    readonly stopDescendants: (
      dispatch: OrchestratorV2Shape["dispatch"],
    ) => Effect.Effect<void, E, R>;
  }) => Effect.Effect<void, E | OrchestratorV2Error, R>;
  readonly delegatedTaskResultPending: (
    childThreadId: ThreadId,
    taskId?: NodeId,
  ) => Effect.Effect<boolean, OrchestratorProjectionError>;
  readonly restartContinuationPending: (run: OrchestrationV2Run) => Effect.Effect<boolean>;
  /** Declined continuations emit no thread event; this still wakes waiters. */
  readonly awaitRestartContinuation: (run: OrchestrationV2Run) => Effect.Effect<void>;
  readonly dispatch: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<OrchestratorV2DispatchResult, OrchestratorV2Error>;
  readonly autoArmLimitRecovery: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly limitRecovery: OrchestrationV2LimitRecoveryUpdate;
  }) => Effect.Effect<void, OrchestratorV2Error>;
  readonly searchThreadStream: (
    input: OrchestrationV2SearchThreadInput,
  ) => Stream.Stream<OrchestrationV2SearchThreadResult, OrchestratorV2Error>;
  readonly searchThread: (
    input: OrchestrationV2SearchThreadInput,
  ) => Effect.Effect<OrchestrationV2SearchThreadResult, OrchestratorV2Error>;
  readonly getThreadHistoryPage: (
    threadId: ThreadId,
    cursor: string,
    throughEntryId?: string,
    conversationOnly?: boolean,
    workMode?: "deferred" | "work",
  ) => Effect.Effect<OrchestrationV2ThreadHistoryPage, OrchestratorV2Error>;
  readonly getTimelinePage: (
    threadId: ThreadId,
    options: ProjectionTimelinePageOptions,
  ) => Effect.Effect<ProjectionTimelinePage, OrchestratorProjectionError>;
  readonly getMessageCount: (threadId: ThreadId) => Effect.Effect<number, OrchestratorV2Error>;
  readonly getRunCount: (threadId: ThreadId) => Effect.Effect<number, OrchestratorV2Error>;
  readonly getMessagesById: (
    threadId: ThreadId,
    messageIds: ReadonlyArray<MessageId>,
  ) => Effect.Effect<
    ReadonlyMap<MessageId, OrchestrationV2ConversationMessage>,
    OrchestratorV2Error
  >;
  readonly getTranscriptByteFloor: (
    threadId: ThreadId,
    limit: number,
  ) => Effect.Effect<number, OrchestratorV2Error>;
  readonly getTurnItem: (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) => Effect.Effect<OrchestrationV2TurnItem | null, OrchestratorV2Error>;
  readonly getThreadRecords: <K extends ProjectionRecordField>(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, OrchestratorV2Error>;
  readonly listAppOwnedChildThreadIds: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, OrchestratorV2Error>;
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, OrchestratorV2Error>;
  readonly getCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectionCheckpointContext, OrchestratorV2Error>;
  readonly getThreadSnapshot: (threadId: ThreadId) => Effect.Effect<
    {
      readonly schemaVersion: number;
      readonly snapshotSequence: number;
      readonly projection: OrchestrationV2ThreadProjection;
    },
    OrchestratorV2Error
  >;
  readonly getThreadSnapshotWindow: (
    threadId: ThreadId,
    options: Parameters<ProjectionStoreV2["Service"]["getThreadSnapshotWindow"]>[1],
  ) => Effect.Effect<
    {
      readonly schemaVersion: number;
      readonly snapshotSequence: number;
      readonly projection: OrchestrationV2ThreadProjection;
    },
    OrchestratorV2Error
  >;
  readonly getPullRequestSnapshot: (
    options: Parameters<ProjectionStoreV2["Service"]["getPullRequestSnapshot"]>[0],
  ) => Effect.Effect<
    Effect.Success<ReturnType<ProjectionStoreV2["Service"]["getPullRequestSnapshot"]>>,
    OrchestratorV2Error
  >;
  readonly getAgentAwarenessSnapshot: (
    threadId?: ThreadId,
  ) => Effect.Effect<
    Effect.Success<ReturnType<ProjectionStoreV2["Service"]["getAgentAwarenessSnapshot"]>>,
    OrchestratorV2Error
  >;
  readonly getShellSnapshot: (
    options?: ShellSnapshotOptions,
  ) => Effect.Effect<OrchestrationV2ThreadShellSnapshot, OrchestratorV2Error>;
  readonly listActiveSubagentThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    OrchestratorV2Error
  >;
  readonly listEphemeralThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    OrchestratorV2Error
  >;
  readonly countThreads: () => Effect.Effect<number, OrchestratorV2Error>;
  readonly listActiveShellIndex: () => Effect.Effect<
    ReadonlyArray<ActiveShellIndexEntry>,
    OrchestratorV2Error
  >;
  readonly listActiveThreads: (
    projectId?: ProjectId,
  ) => Effect.Effect<ReadonlyArray<ActiveThreadListEntry>, OrchestratorV2Error>;
  readonly listOlderSettledThreads: (
    query: OlderSettledThreadsQuery,
  ) => Effect.Effect<OlderSettledThreadsListing, OrchestratorV2Error>;
  readonly readShellSnapshot: (
    options?: ShellSnapshotOptions,
  ) => Effect.Effect<
    Effect.Effect<OrchestrationV2ThreadShellSnapshot, OrchestratorV2Error>,
    OrchestratorV2Error
  >;
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell | null, OrchestratorV2Error>;
  readonly findGuestShareThreadId: (
    shareId: GuestShareId,
  ) => Effect.Effect<ThreadId | null, OrchestratorV2Error>;
  /** Titles of the given threads that exist, archived ones included. */
  readonly getThreadLinkMetadata: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<Record<ThreadId, OrchestrationV2ThreadLinkMetadata>, OrchestratorV2Error>;
  readonly getThreadTitles: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<Record<ThreadId, string>, OrchestratorV2Error>;
  readonly getThreadEventSequence: (
    threadId: ThreadId,
  ) => Effect.Effect<number, OrchestratorV2Error>;
  readonly streamStoredEvents: Stream.Stream<OrchestrationV2StoredEvent, OrchestratorV2Error>;
  /** Events arrive projected for the wire and shared by every subscriber; never mutate them. */
  readonly streamStoredEventsFrom: (input?: {
    readonly threadId?: ThreadId;
    readonly afterSequence?: number;
    readonly eventType?: OrchestrationV2DomainEvent["type"];
  }) => Stream.Stream<OrchestrationV2StoredEvent, OrchestratorV2Error>;
  readonly streamDomainEvents: Stream.Stream<OrchestrationV2DomainEvent, OrchestratorV2Error>;
}

export class OrchestratorV2 extends Context.Service<OrchestratorV2, OrchestratorV2Shape>()(
  "zerocode/orchestration-v2/Orchestrator/OrchestratorV2",
) {}

// A workspace change detaches the session, which can settle the calling run at once. Queuing its
// follow-up in a later command would let a delegated task report its result before that exists.
function metadataUpdateContinuation(
  command: Extract<OrchestrationV2Command, { readonly type: "thread.metadata.update" }>,
): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> | undefined {
  return command.continuation === undefined
    ? undefined
    : {
        type: "message.dispatch",
        commandId: command.commandId,
        threadId: command.threadId,
        messageId: command.continuation.messageId,
        text: command.continuation.text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "mcp",
      };
}

// A later command for the first message would leave the new thread committed with no run,
// and every client would show it idle until that command landed.
function threadCreateInitialMessage(
  command: Extract<OrchestrationV2Command, { readonly type: "thread.create" }>,
): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> | undefined {
  if (command.initialMessage === undefined) return undefined;
  const { workspaceStrategy, ...message } = command.initialMessage;
  return {
    ...message,
    type: "message.dispatch",
    commandId: command.commandId,
    threadId: command.threadId,
    modelSelection: command.modelSelection,
    dispatchMode:
      workspaceStrategy === undefined
        ? { type: "start_immediately" }
        : { type: "defer_start", workspaceStrategy },
    createdBy: command.createdBy,
    creationSource: command.creationSource,
  };
}

// Startup recovery settles whatever is still missed after this window.
const parentTaskSyncRetry = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
  Schedule.upTo({ duration: Duration.hours(1) }),
);

const makeOrchestrator = Effect.fn("orchestrationV2.Orchestrator.layer")(function* () {
  const checkpointService = yield* CheckpointServiceV2;
  const commandPolicy = yield* CommandPolicyV2;
  const contextHandoffService = yield* ContextHandoffServiceV2;
  const eventSink = yield* EventSinkV2;
  const commandReceipts = yield* CommandReceiptStoreV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const taskFolderStore = yield* TaskFolderStore.TaskFolderStore;
  const projectionStore = yield* ProjectionStoreV2;
  const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providerAdapters = yield* ProviderAdapterRegistryV2;
  const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
  const providerSessions = yield* ProviderSessionManagerV2;
  const providerSwitchService = yield* ProviderSwitchServiceV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const runtimePolicy = yield* RuntimePolicyV2;
  const threadForkService = yield* ThreadForkServiceV2;
  const threadDispatch = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const messageIntake = yield* KeyedLock.make<ThreadId>();
  // Read once: the policy is fixed for the server's life, and dispatch takes it as an input.
  const { managedPolicy } = serverSettings;
  const runtimeModeCeiling: RuntimeModeCeiling | undefined =
    managedPolicy?.limits?.maxRuntimeMode === undefined
      ? undefined
      : {
          organization: managedPolicy.organization,
          maxRuntimeMode: managedPolicy.limits.maxRuntimeMode,
        };

  const shared = makeOrchestratorShared({
    checkpointService,
    commandPolicy,
    contextHandoffService,
    eventSink,
    commandReceipts,
    idAllocator,
    projects,
    taskFolderStore,
    projectionStore,
    effectOutbox,
    fileSystem,
    path,
    providerAdapters,
    continuationRequests,
    providerSessions,
    providerSwitchService,
    serverSettings,
    runtimePolicy,
    threadForkService,
    threadDispatch,
    messageIntake,
    runtimeModeCeiling,
  });

  const {
    awaitLatestRunCapture,
    awaitsCheckpointCapture,
    awaitsRestartContinuation,
    childAwaitsRestartContinuation,
    emit,
    findThread,
    liveSideChatIds,
    loadProjectionForCommand,
    makeSystemEvent,
    mapDispatchError,
    refuseAboveDispatchModeLimit,
    refuseAboveRuntimeModeCeiling,
    refuseNativeSubagentMessage,
    stopReachedRun,
  } = shared;

  const checkpointCommands = makeCheckpointCommands(shared);
  const queueRunner = makeQueueRunner(shared, {
    dispatchWithReceiptEffect: (...args) => dispatchWithReceiptEffect(...args),
  });
  const subagentCommands = makeSubagentCommands(shared, {
    dispatchMessage: (...args) => runCommands.dispatchMessage(...args),
    dispatchWithReceipt: (...args) => dispatchWithReceipt(...args),
    dispatchWithReceiptEffect: (...args) => dispatchWithReceiptEffect(...args),
  });
  const approvalAndInputCommands = makeApprovalAndInputCommands(shared, {
    dispatchMessage: (...args) => runCommands.dispatchMessage(...args),
    recordSubagentFollowup: (command, events) =>
      subagentCommands
        .recordSubagentFollowup(command, events)
        .pipe(shared.mapDispatchError(command)),
  });
  const runStopCommands = makeRunStopCommands(shared, {
    disposeDelegatedCompletionCohort: (...args) =>
      subagentCommands.disposeDelegatedCompletionCohort(...args),
    closePendingLinkRequests: (...args) =>
      approvalAndInputCommands.closePendingLinkRequests(...args),
    dispatchQueuedRunCancel: (...args) => runCommands.dispatchQueuedRunCancel(...args),
    writeAppOwnedTask: (...args) => subagentCommands.writeAppOwnedTask(...args),
    cancelIdleOrphans: (...args) => subagentCommands.cancelIdleOrphans(...args),
  });
  const runCommands = makeRunCommands(shared, {
    isStaleQuestionWake: (...args) => queueRunner.isStaleQuestionWake(...args),
    acceptDelegatedCompletionDelivery: (...args) =>
      subagentCommands.acceptDelegatedCompletionDelivery(...args),
    disposeDelegatedCompletionCohort: (...args) =>
      subagentCommands.disposeDelegatedCompletionCohort(...args),
    stopRunForQueuedCommand: (...args) => runStopCommands.stopRunForQueuedCommand(...args),
  });
  const threadCommands = makeThreadCommands(shared, {
    dispatchMessage: (...args) => runCommands.dispatchMessage(...args),
    disposeAllDelegatedCompletionCohorts: (...args) =>
      subagentCommands.disposeAllDelegatedCompletionCohorts(...args),
    closePendingLinkRequests: (...args) =>
      approvalAndInputCommands.closePendingLinkRequests(...args),
    dispatchRuntimeRequestRespond: (...args) =>
      approvalAndInputCommands.dispatchRuntimeRequestRespond(...args),
    dispatchQueuedRunCancel: (...args) => runCommands.dispatchQueuedRunCancel(...args),
  });

  const dispatchUnsupported = (command: OrchestrationV2ServerCommand) =>
    Effect.fail(
      new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
      }),
    );

  const dispatchOnce = Effect.fn("orchestrationV2.dispatch.once")(function* (
    command: OrchestrationV2ServerCommand,
    sideChatIds: ReadonlyArray<ThreadId>,
  ): Effect.fn.Return<
    {
      readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
      readonly effects: ReadonlyArray<PendingOrchestrationEffectV2>;
      readonly cancelUnsettledEffects?: CancelUnsettledEffects;
      readonly updateDelegatedCompletionOnlyRunId?: RunId;
    },
    OrchestratorV2Error
  > {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.command_id": command.commandId,
      "orchestration_v2.command_type": command.type,
      "orchestration_v2.thread_id": commandThreadId(command),
    });

    const events = yield* Ref.make<Array<OrchestrationV2DomainEvent>>([]);
    const effects = yield* Ref.make<Array<PendingOrchestrationEffectV2>>([]);
    let cancelUnsettledEffects: CancelUnsettledEffects | undefined;
    let updateDelegatedCompletionOnlyRunId: RunId | undefined;
    switch (command.type) {
      case "thread.create": {
        yield* threadCommands.dispatchThreadCreate(command, events);
        const initialMessage = threadCreateInitialMessage(command);
        if (initialMessage !== undefined) {
          cancelUnsettledEffects = yield* runCommands.dispatchMessage(
            withoutGuestAttribution(initialMessage),
            events,
            effects,
          );
        }
        break;
      }
      case "thread.visit":
        yield* threadCommands.dispatchThreadVisit(command, events);
        break;
      case "thread.auto-settle": {
        // Recheck live state; changes and explicit overrides take precedence over the sweep snapshot.
        const thread = yield* projectionStore
          .getThread(command.threadId)
          .pipe(
            Effect.mapError(
              (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
            ),
          );
        if (
          thread.settledOverride !== null ||
          DateTime.toEpochMillis(thread.updatedAt) > DateTime.toEpochMillis(command.snapshotAt)
        ) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Thread ${command.threadId} changed before automatic settlement.`,
          });
        }
        // The completion reaction starts or holds the queue just after a run ends; settling
        // first would cancel an automatic wake it was about to start.
        const { runs } = yield* loadProjectionForCommand(command, ["runs"]);
        const endedAt = latestExecutedRun(runs)?.completedAt;
        if (
          endedAt != null &&
          runs.some((run) => run.status === "queued") &&
          Math.abs(DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(endedAt)) <
            QUEUED_TURN_START_GRACE_MS
        ) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Thread ${command.threadId} has a queued run that may still start.`,
          });
        }
        yield* threadCommands.dispatchThreadMutation(
          {
            type: "thread.settle",
            commandId: command.commandId,
            threadId: command.threadId,
            ...(command.settledAt === undefined ? {} : { settledAt: command.settledAt }),
          },
          events,
          effects,
        );
        break;
      }
      case "thread.delete": {
        const now = yield* DateTime.now;
        const planDeletion = Effect.fn("Orchestrator.planDeletion")(function* (
          deletion: typeof command,
        ) {
          const projection = yield* projectionStore
            .getThreadRecords(deletion.threadId, [
              "runs",
              "attempts",
              "nodes",
              "runtimeRequests",
              "subagents",
              "providerSessions",
            ])
            .pipe(
              Effect.mapError(
                (cause) => new OrchestratorProjectionError({ threadId: deletion.threadId, cause }),
              ),
            );
          return yield* mapDispatchError(command)(
            planThreadDeletion({
              command: deletion,
              projection,
              attachmentIds: yield* projectionStore
                .getThreadAttachmentIds(deletion.threadId)
                .pipe(mapDispatchError(command)),
              now,
              idAllocator,
            }),
          );
        });
        // Checked under the thread lock: a message sent since the client looked keeps the thread.
        if (command.onlyIfUnused === true) {
          const usage = yield* projectionStore
            .getThreadRecords(command.threadId, ["runs", "messages"])
            .pipe(
              Effect.mapError(
                (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
              ),
            );
          if (usage.runs.length > 0 || usage.messages.length > 0) {
            return { events: [], effects: [] };
          }
        }
        // The dispatch wrapper holds each side chat's lock, so none can commit after this plan.
        const plans = [
          yield* planDeletion(command),
          ...(yield* Effect.forEach(sideChatIds, (threadId) =>
            planDeletion({
              ...command,
              commandId: CommandId.make(`${command.commandId}:side-chat:${threadId}`),
              threadId,
            }),
          )),
        ];
        return {
          events: plans.flatMap((plan) => plan.events),
          effects: plans.flatMap((plan) => plan.effects),
          // A continuation would hold off the purge, and a late title would bring text back.
          cancelUnsettledEffects: {
            effectTypes: ["provider-runtime.continue", "thread-title.generate"],
            reason: "Thread deleted.",
          },
        };
      }
      case "thread.archive":
      case "thread.unarchive": {
        const parentArchivedAt = (yield* findThread(command.threadId))?.archivedAt ?? null;
        yield* threadCommands.dispatchThreadMutation(command, events, effects);
        // Unarchive restores the side chats this parent's archive took, not ones archived before it.
        for (const threadId of sideChatIds) {
          const sideChatArchivedAt = (yield* findThread(threadId))?.archivedAt ?? null;
          const follows =
            command.type === "thread.archive"
              ? sideChatArchivedAt === null
              : sideChatArchivedAt !== null &&
                parentArchivedAt !== null &&
                DateTime.toEpochMillis(sideChatArchivedAt) >=
                  DateTime.toEpochMillis(parentArchivedAt);
          if (!follows) continue;
          // Archive refuses a side chat still waiting on delegated tasks, so it stays active.
          if (command.type === "thread.archive") {
            const { subagents } = yield* projectionStore
              .getThreadRecords(threadId, ["subagents"])
              .pipe(mapDispatchError(command));
            if (hasRunningDelegatedTasks(subagents)) continue;
          }
          yield* threadCommands.dispatchThreadMutation(
            {
              ...command,
              commandId: CommandId.make(`${command.commandId}:side-chat:${threadId}`),
              threadId,
            },
            events,
            effects,
          );
        }
        break;
      }
      case "thread.settle":
      case "thread.unsettle":
      case "thread.snooze":
      case "thread.unsnooze":
      case "thread.auto-settle.set":
      case "thread.pin":
      case "thread.unpin":
      case "thread.pin.reorder":
      case "thread.active.reorder":
      case "thread.tag.set":
      case "thread.mark-unread":
      case "thread.pull-request.link":
      case "thread.pull-request.unlink":
      case "thread.pull-request-link.sync":
      case "thread.issue.link":
      case "thread.issue.unlink":
      case "thread.pull-request.watch":
      case "thread.pull-request.sync":
      case "thread.title.regeneration.complete":
      case "thread.runtime-mode.set":
      case "thread.interaction-mode.set":
      case "thread.model-selection.set":
      case "provider.switch":
        yield* threadCommands.dispatchThreadMutation(command, events, effects);
        break;
      case "thread.metadata.update": {
        const continuation = metadataUpdateContinuation(command);
        if (continuation !== undefined) yield* refuseNativeSubagentMessage(command);
        yield* threadCommands.dispatchThreadMutation(command, events, effects);
        if (continuation !== undefined) {
          cancelUnsettledEffects = yield* runCommands.dispatchMessage(
            continuation,
            events,
            effects,
          );
          yield* subagentCommands
            .recordSubagentFollowup(continuation, events)
            .pipe(mapDispatchError(command));
        }
        break;
      }
      case "thread.pull-request-watch.checks-reopen":
        yield* threadCommands.dispatchThreadMutation(command, events, effects);
        break;
      case "thread.pull-request-watch.sync":
        yield* threadCommands.dispatchPullRequestWatchSync(command, events, effects);
        break;
      case "thread.guest-share.open":
      case "thread.guest-share.redeem":
      case "thread.guest-share.close":
      case "thread.guest-message.submit":
      case "thread.guest-message.dismiss":
        yield* threadCommands.dispatchGuestShare(command, events, effects);
        break;
      case "provider-session.detach":
        yield* threadCommands.dispatchProviderSessionDetach(command, events, effects);
        break;
      case "thread.project.adopt-folder":
        yield* threadCommands.dispatchThreadProjectAdoptFolder(command, events);
        break;
      case "message.dispatch": {
        const thread = yield* refuseNativeSubagentMessage(command);
        const guestSend =
          command.guestMessageId === undefined
            ? undefined
            : yield* threadCommands.emitGuestMessageSent(
                command,
                command.guestMessageId,
                thread,
                events,
              );
        const dispatched =
          guestSend === undefined
            ? withoutGuestAttribution(command)
            : {
                ...command,
                text: guestSend.text,
                context: { version: 1 as const, records: [], guest: guestSend.guest },
              };
        cancelUnsettledEffects = yield* runCommands.dispatchMessage(dispatched, events, effects);
        yield* subagentCommands
          .recordSubagentFollowup(dispatched, events)
          .pipe(mapDispatchError(command));
        break;
      }
      case "notification.delivery.accept":
        updateDelegatedCompletionOnlyRunId = yield* subagentCommands.dispatchNotificationAccepted(
          command,
          events,
        );
        break;
      case "prepared-run.release":
        yield* runCommands.dispatchPreparedRunRelease(command, events, effects);
        break;
      case "prepared-run.progress":
        yield* runCommands.dispatchPreparedRunProgress(command, events);
        break;
      case "prepared-run.fail":
        yield* runCommands.dispatchPreparedRunFail(command, events);
        break;
      case "prepared-run.retry":
        yield* runCommands.dispatchPreparedRunRetry(command, events);
        break;
      case "runtime-request.respond":
        yield* approvalAndInputCommands.dispatchRuntimeRequestRespond(command, events, effects);
        break;
      case "thread.user-input.dismiss":
        yield* approvalAndInputCommands.dispatchThreadUserInputDismiss(command, events, effects);
        break;
      case "subagent.stop":
        yield* runStopCommands.dispatchSubagentStop(command, events, effects);
        break;
      case "run.interrupt":
        cancelUnsettledEffects = yield* runStopCommands.dispatchRunInterrupt(
          command,
          events,
          effects,
        );
        if (command.holdQueue === true) {
          // Stop must still commit when a child can't be read, so a failed repair's
          // partial events are dropped.
          const repairEvents = yield* Ref.make(yield* Ref.get(events));
          const repaired = yield* Effect.exit(
            loadProjectionForCommand(command, ["subagents", "turnItems"], {
              turnItemTypes: ["subagent"],
              turnItemStatuses: ["pending", "running", "waiting"],
            }).pipe(
              Effect.flatMap((projection) =>
                subagentCommands.cancelIdleOrphans({
                  command,
                  events: repairEvents,
                  projection,
                }),
              ),
            ),
          );
          if (Exit.isSuccess(repaired)) yield* Ref.set(events, yield* Ref.get(repairEvents));
          else
            yield* Effect.logWarning("Stop could not cancel orphaned delegated follow-ups", {
              threadId: command.threadId,
              cause: repaired.cause,
            });
          yield* Ref.update(effects, (existing) => [
            ...existing,
            delegatedTasksStopEffect(command),
          ]);
        }
        break;
      case "thread.stop":
        cancelUnsettledEffects = yield* runStopCommands.dispatchThreadStop(
          command,
          events,
          effects,
        );
        break;
      case "queued-message.promote-to-steer":
        cancelUnsettledEffects = yield* runCommands.dispatchQueuedMessagePromoteToSteer(
          command,
          events,
          effects,
        );
        break;
      case "queued-run.start":
      case "queue.resume": {
        const projection = yield* loadProjectionForCommand(
          command,
          ["runs", "turnItems", "providerSessions", "messages"],
          { turnItemTypes: ["error"], messageRoles: ["user"] },
        );
        if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Thread ${command.threadId} is not active.`,
          });
        }
        const selectedRunId = command.type === "queued-run.start" ? command.runId : undefined;
        const selectedRun =
          selectedRunId === undefined
            ? undefined
            : projection.runs.find((run) => run.id === selectedRunId && run.status === "queued");
        if (selectedRunId !== undefined) {
          const selectedMessage = projection.messages.find(
            (message) => message.id === selectedRun?.userMessageId,
          );
          if (
            selectedRun === undefined ||
            selectedMessage === undefined ||
            selectedMessage.delegatedCompletion !== undefined ||
            selectedMessage.notification !== undefined ||
            projection.runs.some(isActiveRun)
          ) {
            return yield* new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: "A queued user message can only be sent now while the thread is stopped.",
            });
          }
        }
        const nextRun = selectedRun ?? queuedRunsInDeliveryOrder(projection)[0];
        if (
          usageLimitHoldsQueue(
            projection,
            nextRun === undefined
              ? projection.thread.providerInstanceId
              : queuedRunModelSelection(projection, nextRun).instanceId,
          )
        ) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Continue the limited thread before resuming its queue.",
          });
        }
        if (worktreeSetupPending(projection)) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Retry worktree setup or choose a workspace before resuming the queue.",
          });
        }
        const now = yield* DateTime.now;
        const queued = projection.runs.filter((run) => run.status === "queued");
        for (const run of queued) {
          yield* emit(
            events,
            command,
          )({
            type: "run.updated",
            threadId: command.threadId,
            runId: run.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...run, queueHeld: false },
          });
        }
        if (queued.length === 0) {
          yield* emit(
            events,
            command,
          )({
            type: "thread.metadata-updated",
            threadId: command.threadId,
            occurredAt: now,
            payload: projection.thread,
          });
        }
        break;
      }
      case "queued-run.reorder":
        yield* runCommands.dispatchQueuedRunReorder(command, events);
        break;
      case "queued-run.cancel":
        yield* runCommands.dispatchQueuedRunCancel(command, events);
        break;
      case "queued-run.edit":
        yield* runCommands.dispatchQueuedRunEdit(command, events, effects);
        break;
      case "run.output.submit":
        yield* runCommands.dispatchRunOutputSubmit(command, events);
        break;
      case "checkpoint.rollback":
        yield* checkpointCommands.dispatchCheckpointRollback(command, events, effects);
        break;
      case "checkpoint.rollback.fail":
        yield* checkpointCommands.dispatchCheckpointRollbackFail(command, events);
        break;
      case "runtime-request.delivery.fail":
        yield* approvalAndInputCommands.dispatchRuntimeRequestDeliveryFail(command, events);
        break;
      case "thread.background-work.settle":
        yield* runStopCommands.dispatchBackgroundWorkSettle(command, events, effects);
        break;
      case "thread.interrupt.unresponsive":
        yield* runStopCommands.dispatchInterruptUnresponsive(command, events);
        break;
      case "thread.fork":
        yield* checkpointCommands.dispatchThreadFork(command, events);
        break;
      case "thread.merge_back":
        yield* checkpointCommands.dispatchThreadMergeBack(command, events);
        break;
      case "delegated_task.request":
        yield* subagentCommands.dispatchDelegatedTaskRequest(command, events, effects);
        break;
      case "delegated_task.remote.request":
        yield* subagentCommands.dispatchRemoteDelegatedTaskRequest(command, events);
        break;
      case "delegated_task.remote.complete":
        yield* subagentCommands.dispatchRemoteDelegatedTaskComplete(command, events);
        break;
      case "delegated_task.remote.stop":
        yield* subagentCommands.dispatchRemoteDelegatedTaskStop(command, events);
        break;
      case "delegated_task.wake-policy":
        updateDelegatedCompletionOnlyRunId =
          yield* subagentCommands.dispatchDelegatedTaskWakePolicy(command, events);
        break;
      case "delegated_task.completion-delivery.acknowledge":
      case "delegated_task.completion-delivery.dispose":
        updateDelegatedCompletionOnlyRunId =
          yield* subagentCommands.dispatchDelegatedTaskCompletionDeliveryResolution(
            command,
            events,
          );
        break;
      case "thread.created.record":
        yield* subagentCommands.dispatchCreatedThreadRecord(command, events);
        break;
      case "secret_request.record":
        yield* approvalAndInputCommands.dispatchSecretRequestRecord(command, events);
        break;
      case "link_request.record":
        yield* approvalAndInputCommands.dispatchLinkRequestRecord(command, events, effects);
        break;
      default:
        return yield* dispatchUnsupported(command);
    }
    return {
      events: yield* Ref.get(events),
      effects: yield* Ref.get(effects),
      ...(cancelUnsettledEffects === undefined ? {} : { cancelUnsettledEffects }),
      ...(updateDelegatedCompletionOnlyRunId === undefined
        ? {}
        : { updateDelegatedCompletionOnlyRunId }),
    };
  });

  const replayCommandReceipt = Effect.fn("orchestrationV2.dispatch.replayReceipt")(function* (
    command: OrchestrationV2ServerCommand,
    receipt: CommandReceiptV2,
  ) {
    if (receipt.status === "rejected") {
      return yield* new OrchestratorCommandPreviouslyRejectedError({
        commandId: command.commandId,
        commandType: command.type,
        detail: receipt.error ?? "Previously rejected.",
      });
    }
    const dispatchThreadId = commandThreadId(command);
    // Receipts only prove execution for the thread they were recorded against.
    if (receipt.threadId !== dispatchThreadId) {
      return yield* new OrchestratorCommandIdConflictError({
        commandId: command.commandId,
        commandType: command.type,
        receiptThreadId: receipt.threadId,
        commandThreadId: dispatchThreadId,
      });
    }
    const storedEvents = yield* eventSink.readByCommandId({ commandId: command.commandId }).pipe(
      Stream.runCollect,
      Effect.map((events): ReadonlyArray<OrchestrationV2StoredEvent> => Array.from(events)),
      Effect.mapError(
        (cause) =>
          new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          }),
      ),
    );
    if (command.type === "queue.resume" || command.type === "queued-run.start") {
      yield* mapDispatchError(command)(
        queueRunner.startNextQueuedRun(command.threadId, {
          userStarted: true,
          ...(command.type === "queued-run.start" ? { queuedRunId: command.runId } : {}),
        }),
      );
    }
    return {
      sequence: receipt.resultSequence,
      storedEvents,
      replayed: true,
    } satisfies OrchestratorV2DispatchResult;
  });

  /** `sideChatIds` are the live side chats a delete, archive, or unarchive cascades to, read under their locks. */
  const dispatchWithReceiptEffect = Effect.fn("orchestrationV2.dispatch.withReceipt")(function* (
    command: OrchestrationV2ServerCommand,
    sideChatIds: ReadonlyArray<ThreadId> = [],
    cancelledTask?: OrchestrationV2Subagent,
  ): Effect.fn.Return<OrchestratorV2DispatchResult, OrchestratorV2Error> {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.command_id": command.commandId,
      "orchestration_v2.command_type": command.type,
      "orchestration_v2.thread_id": commandThreadId(command),
    });

    const existingReceipt = yield* commandReceipts.getByCommandId(command.commandId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          }),
      ),
    );

    if (Option.isSome(existingReceipt)) {
      return yield* replayCommandReceipt(command, existingReceipt.value);
    }

    // Recheck under the lock; the user may have raised modes since sender preflight.
    const limit = yield* DispatchModeLimit;
    if (limit !== undefined) {
      // Fork and merge-back sources are unlocked; validate the modes copied by their dispatch.
      const threadId = commandThreadId(command);
      const shell = yield* projectionStore
        .getThreadShell(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
      if (shell !== null) yield* refuseAboveDispatchModeLimit(command, threadId, shell);
    }

    // The run-end release can lag behind a new send; start the queue first so the send waits behind it.
    // A restart continuation resumes the ended run, so it must not be overtaken by the queue.
    // A steer follow-up takes its place first and starts the queue after it commits. A send that
    // beats the run-end reaction places the ended run's unread steers before it starts anything.
    if (
      command.type === "message.dispatch" &&
      command.restartContinuationOfRunId === undefined &&
      command.steerFollowUpOfRunId === undefined &&
      (command.dispatchMode.type === "start_immediately" ||
        command.dispatchMode.type === "queue_after_active" ||
        command.dispatchMode.type === "defer_start")
    ) {
      yield* mapDispatchError(command)(
        queueRunner
          .requeueUnreadSteers(command.threadId)
          .pipe(
            Effect.andThen(
              queueRunner.startNextQueuedRun(command.threadId, { latestRunEnded: true }),
            ),
          ),
      );
    }

    const plan = yield* dispatchOnce(command, sideChatIds).pipe(
      Effect.tap((planned) => refuseAboveRuntimeModeCeiling(command, planned.events)),
      Effect.filterOrFail(
        (planned) =>
          planned.events.length > 0 ||
          subagentCommands.isUnobservedAcknowledgement(command) ||
          command.type === "thread.background-work.settle" ||
          // A stale visit changes no read state.
          command.type === "thread.visit" ||
          // A read can answer a watch again before a push's reopen lands; nothing is left to clear.
          command.type === "thread.pull-request-watch.checks-reopen" ||
          command.type === "thread.interrupt.unresponsive" ||
          command.type === "thread.stop" ||
          command.type === "subagent.stop" ||
          // Closing a share again, or after it ended, is not an error.
          command.type === "thread.guest-share.close" ||
          (command.type === "thread.delete" && command.onlyIfUnused === true),
        (_planned) =>
          new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Command produced no domain events.",
          }),
      ),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          // Refusals depend on modes the user can change; a recorded rejection would block the retry.
          if (
            cause._tag === "OrchestratorThreadAboveModeLimitError" ||
            cause._tag === "OrchestratorRuntimeModeAboveCeilingError"
          ) {
            return yield* cause;
          }
          // Resolving a turn's policy refuses the same way, from inside the decision.
          const ceiling = runtimePolicyCeilingCause(cause);
          if (ceiling !== undefined) {
            const { threadId, runtimeMode, maxRuntimeMode, organization } = ceiling;
            return yield* new OrchestratorRuntimeModeAboveCeilingError({
              commandId: command.commandId,
              threadId,
              refused: "turn",
              runtimeMode,
              maxRuntimeMode,
              organization,
            });
          }
          const rejectedAt = yield* DateTime.now;
          const receipt = yield* eventSink
            .commitRejectedCommand({
              commandId: command.commandId,
              threadId: commandThreadId(command),
              commandType: command.type,
              rejectedAt,
              error: cause instanceof Error ? cause.message : String(cause),
            })
            .pipe(
              Effect.mapError(
                (receiptCause) =>
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: receiptCause,
                  }),
              ),
            );
          if (
            command.type === "queued-run.edit" &&
            receipt.status === "rejected" &&
            cause._tag === "OrchestratorDispatchError"
          ) {
            return yield* new OrchestratorCommandRejectedError({
              commandId: cause.commandId,
              commandType: cause.commandType,
              cause: cause.cause,
            });
          }
          return yield* cause;
        }),
      ),
    );

    if (plan.events.length === 0 && plan.effects.length === 0 && cancelledTask === undefined) {
      // A settle that ended nothing still records its receipt: a replayed Stop
      // effect then finds it instead of settling work that appeared since.
      const { resultSequence, inserted } = yield* Effect.gen(function* () {
        const sequence = yield* eventSink.latestSequence({ threadId: commandThreadId(command) });
        const inserted = yield* commandReceipts.insertIfAbsent({
          commandId: command.commandId,
          threadId: commandThreadId(command),
          commandType: command.type,
          acceptedAt: yield* DateTime.now,
          resultSequence: sequence,
          status: "accepted",
          error: null,
        });
        return { resultSequence: sequence, inserted };
      }).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause,
            }),
        ),
      );
      if (!inserted) {
        const receipt = yield* mapDispatchError(command)(
          commandReceipts.getByCommandId(command.commandId),
        );
        if (Option.isNone(receipt)) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Conflicting receipt is not a thread command receipt.",
          });
        }
        return yield* replayCommandReceipt(command, receipt.value);
      }
      return {
        sequence: resultSequence,
        storedEvents: [],
      } satisfies OrchestratorV2DispatchResult;
    }
    const acceptedAt = plan.events.at(-1)?.occurredAt ?? (yield* DateTime.now);
    const committed = yield* eventSink
      .commitCommand({
        commandId: command.commandId,
        threadId: commandThreadId(command),
        commandType: command.type,
        acceptedAt,
        events:
          cancelledTask === undefined
            ? plan.events
            : [
                ...plan.events,
                yield* makeSystemEvent({
                  type: "subagent.updated",
                  threadId: cancelledTask.threadId,
                  nodeId: cancelledTask.id,
                  occurredAt: cancelledTask.updatedAt,
                  payload: cancelledTask,
                }).pipe(mapDispatchError(command)),
              ],
        effects: plan.effects,
        ...(plan.cancelUnsettledEffects === undefined
          ? {}
          : { cancelUnsettledEffects: plan.cancelUnsettledEffects }),
        ...(plan.updateDelegatedCompletionOnlyRunId === undefined
          ? {}
          : { updateDelegatedCompletionOnlyRunId: plan.updateDelegatedCompletionOnlyRunId }),
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

    if (committed.receipt.status === "rejected") {
      return yield* new OrchestratorCommandPreviouslyRejectedError({
        commandId: command.commandId,
        commandType: command.type,
        detail: committed.receipt.error ?? "Previously rejected.",
      });
    }
    // A concurrent command with this id for another thread can commit first,
    // under that thread's lock; its receipt is not this command's result.
    if (committed.receipt.threadId !== commandThreadId(command)) {
      return yield* new OrchestratorCommandIdConflictError({
        commandId: command.commandId,
        commandType: command.type,
        receiptThreadId: committed.receipt.threadId,
        commandThreadId: commandThreadId(command),
      });
    }
    if (
      command.type === "queue.resume" ||
      command.type === "queued-run.start" ||
      (command.type === "thread.runtime-mode.set" && runtimeModeCeiling !== undefined)
    ) {
      yield* mapDispatchError(command)(
        queueRunner.startNextQueuedRun(command.threadId, {
          userStarted: command.type !== "thread.runtime-mode.set",
          ...(command.type === "queued-run.start" ? { queuedRunId: command.runId } : {}),
        }),
      );
    }
    if (
      command.type === "notification.delivery.accept" ||
      // A steer restart that settled a wake can reserve the next one for its siblings.
      ((command.type === "message.dispatch" ||
        command.type === "queued-message.promote-to-steer") &&
        committed.storedEvents.some(
          ({ event }) =>
            event.type === "subagent.updated" &&
            event.payload.completionDelivery?.state === "claimed",
        ))
    ) {
      yield* mapDispatchError(command)(
        subagentCommands.offerDelegatedCompletionDeliveries(command.threadId),
      );
    }
    if (
      command.type === "delegated_task.wake-policy" ||
      command.type === "delegated_task.remote.complete" ||
      subagentCommands.isUnobservedAcknowledgement(command)
    ) {
      yield* mapDispatchError(command)(
        subagentCommands.offerDelegatedCompletionDeliveries(command.parentThreadId),
      );
    }

    if (command.type === "message.dispatch" && command.steerFollowUpOfRunId !== undefined) {
      yield* mapDispatchError(command)(
        queueRunner.startNextQueuedRun(command.threadId, { latestRunEnded: true }),
      );
    }

    return {
      sequence: committed.receipt.resultSequence,
      storedEvents: committed.storedEvents,
      ...(committed.committed ? {} : { replayed: true as const }),
    } satisfies OrchestratorV2DispatchResult;
  }, withCommandMetrics);

  // Follow-up intake and Stop serialize on the parent before taking the child lock.
  const withSubagentParentLock = <A, E, R>(threadId: ThreadId, dispatch: Effect.Effect<A, E, R>) =>
    subagentCommands.appOwnedSubagentParentThreadId(threadId).pipe(
      Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })),
      Effect.flatMap((parentThreadId) =>
        parentThreadId === undefined ? dispatch : threadDispatch.withLock(parentThreadId, dispatch),
      ),
    );

  // dispatchWithReceiptEffect owns the dispatch span; this wrapper selects the thread locks.
  const dispatchWithReceipt = Effect.fnUntraced(function* (
    command: OrchestrationV2ServerCommand,
  ): Effect.fn.Return<OrchestratorV2DispatchResult, OrchestratorV2Error> {
    // The latest stable run is the one with a checkpoint. Wait for a just-completed run's capture,
    // outside the locks its commit takes, so a fork right after a turn starts from that turn.
    if (
      (command.type === "thread.fork" || command.type === "thread.merge_back") &&
      command.sourcePoint.type === "latest_stable"
    ) {
      yield* awaitLatestRunCapture(command.sourceThreadId);
    }
    const dispatch = threadDispatch.withLock(
      commandThreadId(command),
      dispatchWithReceiptEffect(command),
    );
    // A fork holds its source's lock, so a source deletion and its fork never interleave. A
    // parent's lock comes before its side chats' locks. A side chat fork from a side chat or a
    // fork onto an existing thread would invert that order; dispatch rejects both, so they skip it.
    if (command.type === "thread.fork" && command.sourceThreadId !== command.targetThreadId) {
      const source = yield* findThread(command.sourceThreadId);
      const target = yield* findThread(command.targetThreadId);
      const skipsSourceLock =
        source === null ||
        target !== null ||
        (command.sideChat === true && source.lineage.sideChat === true);
      return yield* skipsSourceLock
        ? dispatch
        : threadDispatch.withLock(command.sourceThreadId, dispatch);
    }
    if (
      command.type === "thread.delete" ||
      command.type === "thread.archive" ||
      command.type === "thread.unarchive"
    ) {
      const cascade = threadDispatch.withLock(
        command.threadId,
        liveSideChatIds(command.threadId).pipe(
          Effect.flatMap((sideChatIds) =>
            sideChatIds.reduce(
              (locked, sideChatId) => threadDispatch.withLock(sideChatId, locked),
              dispatchWithReceiptEffect(command, sideChatIds),
            ),
          ),
        ),
      );
      return yield* command.type === "thread.delete"
        ? threadDispatch.withDeletionLock(cascade)
        : cascade;
    }
    // Taken before the lineage read, so a message whose read yields keeps its
    // place ahead of later messages to the same thread.
    const message =
      command.type === "thread.metadata.update" ? metadataUpdateContinuation(command) : command;
    if (message?.type === "message.dispatch")
      return yield* messageIntake.withLock(
        message.threadId,
        mayStartSubagentFollowup(message)
          ? withSubagentParentLock(message.threadId, dispatch)
          : dispatch,
      );
    // Answering a message-mode question can also start a follow-up.
    return yield* command.type === "runtime-request.respond"
      ? withSubagentParentLock(command.threadId, dispatch)
      : dispatch;
  });

  const parentTaskSyncRetries = yield* FiberSet.make();
  const syncDelegatedParentTask = Effect.fn("Orchestrator.syncDelegatedParentTask")(function* (
    childThreadId: ThreadId,
    options: { readonly syncRunId: RunId | undefined; readonly retry: boolean },
  ) {
    const parentThreadId = yield* subagentCommands.appOwnedSubagentParentThreadId(childThreadId);
    if (parentThreadId === undefined) return;
    const finalize = subagentCommands.finalizeAppOwnedSubagent(
      childThreadId,
      options.syncRunId === undefined ? undefined : { syncRunId: options.syncRunId },
    );
    yield* threadDispatch.withLock(
      parentThreadId,
      // A failed attempt may have committed the result before offering its wake.
      options.retry
        ? subagentCommands
            .offerChildTaskDeliveries(parentThreadId, childThreadId)
            .pipe(Effect.andThen(finalize))
        : finalize,
    );
  });
  // Only these reactions tell a parent about its child before a restart; a dropped one leaves its task running.
  const updateDelegatedParentTask = Effect.fn("Orchestrator.updateDelegatedParentTask")(function* (
    childThreadId: ThreadId,
    syncRunId?: RunId,
  ) {
    const context = {
      threadId: childThreadId,
      ...(syncRunId === undefined ? {} : { runId: syncRunId }),
    };
    yield* syncDelegatedParentTask(childThreadId, { syncRunId, retry: false }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Retrying a delegated task update for its parent", {
          ...context,
          cause,
        }).pipe(
          Effect.andThen(
            syncDelegatedParentTask(childThreadId, { syncRunId, retry: true }).pipe(
              Effect.retry({ schedule: parentTaskSyncRetry }),
              Effect.delay("1 second"),
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to update a delegated task for its parent", {
                  ...context,
                  cause,
                }),
              ),
              FiberSet.run(parentTaskSyncRetries),
            ),
          ),
        ),
      ),
    );
  });
  const handleRunUpdate = Effect.fn("Orchestrator.handleRunUpdate")(
    function* (stored: OrchestrationV2StoredEvent) {
      if (stored.event.type !== "run.updated") return;
      const threadId = stored.event.threadId;
      const run = stored.event.payload;
      // Take parent and child locks sequentially, never nested: delegation holds the parent
      // while writing child events, so nesting parent inside child would invert the order.
      // The keyed semaphores are neither reentrant nor deadlock-aware.
      if (
        delegatedTaskTerminalStatus(run.status) !== null &&
        !(yield* awaitsCheckpointCapture(run))
      ) {
        // Before the parent hears of the failure: a pending continuation keeps the task open.
        if (run.status === "failed" && run.restartContinuationOfRunId !== undefined) {
          yield* threadDispatch
            .withLock(threadId, queueRunner.retryContinuationStart(threadId, run.id))
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to schedule a restart continuation retry", {
                  threadId,
                  runId: run.id,
                  cause,
                }),
              ),
            );
        }
        yield* threadDispatch
          .withLock(
            threadId,
            subagentCommands.finalizeDelegatedCompletionDelivery(threadId, run.id),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to settle a delegated completion delivery", {
                threadId,
                runId: run.id,
                cause,
              }),
            ),
          );
        yield* threadDispatch
          .withLock(
            threadId,
            (run.status === "completed"
              ? queueRunner.releaseUnattendedHolds(threadId, run.id)
              : Effect.void
            ).pipe(
              Effect.andThen(
                queueRunner
                  .requeueUnreadSteers(threadId, [run.id])
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("Failed to read unread steers", { threadId, cause }),
                    ),
                  ),
              ),
              Effect.andThen(
                queueRunner.startNextQueuedRun(threadId, {
                  endedRunId: run.id,
                  ...(run.status === "failed" ? { failedRunId: run.id } : {}),
                }),
              ),
            ),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to start the next queued V2 run", { threadId, cause }),
            ),
          );
      }
      yield* updateDelegatedParentTask(threadId, run.id);
    },
    (effect, stored) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to react to V2 run update", {
            threadId: stored.event.threadId,
            sequence: stored.sequence,
            cause,
          }),
        ),
      ),
  );

  // One thread's reactions run in event order; a reaction waiting on one thread's lock must
  // not hold up another thread's.
  const threadReactions = yield* KeyedLock.makeRunner<ThreadId>();

  // Projections already contain historical terminals; replaying them delays startup queue promotion with database size.
  const terminalEventsAfterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
  // Filter run updates before buffering so blocked queue promotion does not retain unrelated tool bodies.
  yield* eventSink
    .stream({ afterSequence: terminalEventsAfterSequence, eventType: "run.updated" })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          (!String(stored.commandId).startsWith("command:runtime-reconcile:") ||
            (stored.event.payload.delegatedTaskId !== undefined &&
              stored.event.payload.status === "queued" &&
              stored.event.payload.queueHeld === true)) &&
          ((stored.event.payload.delegatedTaskId !== undefined &&
            (stored.event.payload.status === "queued" ||
              stored.event.payload.status === "starting" ||
              stored.event.payload.status === "waiting")) ||
            stored.event.payload.status === "completed" ||
            stored.event.payload.status === "interrupted" ||
            stored.event.payload.status === "failed" ||
            stored.event.payload.status === "cancelled" ||
            stored.event.payload.status === "rolled_back"),
      ),
      Stream.runForEach((stored) =>
        threadReactions.run(stored.event.threadId, handleRunUpdate(stored)),
      ),
      Effect.forkScoped,
    );

  yield* eventSink
    .stream({ afterSequence: terminalEventsAfterSequence, eventType: "provider-turn.updated" })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "provider-turn.updated" &&
          stored.event.payload.status === "running",
      ),
      Stream.runForEach(
        Effect.fn("Orchestrator.deliverDeferredSteers")(
          function* (stored) {
            if (stored.event.type !== "provider-turn.updated") return;
            const threadId = stored.event.threadId;
            const turn = stored.event.payload;
            const projection = yield* projectionStore.getThreadRecords(threadId, ["runs"], {
              runStatuses: ["queued", "running"],
            });
            const run = projection.runs.find(
              (candidate) =>
                candidate.activeAttemptId === turn.runAttemptId && candidate.status === "running",
            );
            if (run === undefined) return;
            const pending = projection.runs
              .filter(
                (queued) => queued.status === "queued" && queued.steerWhenReadyRunId === run.id,
              )
              .toSorted(
                (left, right) =>
                  (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal),
              );
            for (const queued of pending) {
              yield* dispatchWithReceiptEffect({
                type: "queued-message.promote-to-steer",
                commandId: CommandId.make(
                  `command:deferred-steer:${queued.id}:${run.id}:${turn.runAttemptId}`,
                ),
                threadId,
                queuedRunId: queued.id,
                targetRunId: run.id,
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Failed to deliver a deferred steer", {
                    threadId,
                    runId: queued.id,
                    cause,
                  }),
                ),
              );
            }
          },
          (effect, stored) => threadDispatch.withLock(stored.event.threadId, effect),
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to deliver deferred steering", { cause }),
          ),
          (effect, stored) => threadReactions.run(stored.event.threadId, effect),
        ),
      ),
      Effect.forkScoped,
    );

  // A child whose run ends while its background tasks or its own subagents still run has no
  // result yet. When that work settles there is no run update to finalize it, so these events
  // do it. A roster counts when a task seen holding leaves it, since that may be one follow-up's.
  const holdingTaskIdsByProviderThread = new Map<string, ReadonlySet<string>>();
  const settlesChildWork = (stored: OrchestrationV2StoredEvent) => {
    const { event } = stored;
    if (event.type === "subagent.updated")
      return !isOrchestrationV2WorkActive(event.payload.status);
    if (event.type !== "provider-thread.updated") return false;
    const holding = new Set(
      (event.payload.pendingBackgroundTasks ?? [])
        .filter((task) => backgroundWorkHoldsCompletion([task]))
        .map((task) => task.taskId),
    );
    const previous = holdingTaskIdsByProviderThread.get(event.payload.id);
    if (holding.size > 0) holdingTaskIdsByProviderThread.set(event.payload.id, holding);
    else holdingTaskIdsByProviderThread.delete(event.payload.id);
    return previous !== undefined && [...previous].some((taskId) => !holding.has(taskId));
  };
  yield* Stream.merge(
    eventSink.stream({
      afterSequence: terminalEventsAfterSequence,
      eventType: "provider-thread.updated",
    }),
    eventSink.stream({ afterSequence: terminalEventsAfterSequence, eventType: "subagent.updated" }),
  ).pipe(
    Stream.filter(settlesChildWork),
    Stream.runForEach((stored) =>
      threadReactions.run(stored.event.threadId, updateDelegatedParentTask(stored.event.threadId)),
    ),
    Effect.forkScoped,
  );

  const recoverDelegatedTasks = Effect.gen(function* () {
    yield* projectionStore.getRecoveryThreadIds("subagent-results").pipe(
      Effect.tap((threadIds) =>
        Effect.annotateCurrentSpan("recovery.subagentResultThreads", threadIds.length),
      ),
      Effect.flatMap((threadIds) =>
        Effect.forEach(
          threadIds,
          (threadId) =>
            Effect.gen(function* () {
              const thread = yield* projectionStore.getThreadShell(threadId);
              const parentThreadId = thread?.lineage.parentThreadId;
              if (parentThreadId === undefined || parentThreadId === null) return;
              yield* threadDispatch.withLock(
                parentThreadId,
                subagentCommands.finalizeAppOwnedSubagent(threadId),
              );
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to recover terminal app-owned subagent", {
                  childThreadId: threadId,
                  cause,
                }),
              ),
            ),
          { concurrency: 8, discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to inspect app-owned subagents during recovery", {
          cause,
        }),
      ),
    );
    yield* projectionStore.getRecoveryThreadIds("delegated-completions").pipe(
      Effect.tap((threadIds) =>
        Effect.annotateCurrentSpan("recovery.delegatedCompletionThreads", threadIds.length),
      ),
      Effect.flatMap((threadIds) =>
        Effect.forEach(
          threadIds,
          (threadId) =>
            threadDispatch
              .withLock(
                threadId,
                Effect.gen(function* () {
                  const projection = yield* projectionStore.getThreadRecords(threadId, ["runs"]);
                  // Only the current delivery's run can settle its cohort; revisiting historical delivery runs repeatedly reloads the thread.
                  const openDeliveryMessageIds = new Set(
                    projection.runs.flatMap((run) =>
                      run.delegatedCompletion?.delivery == null
                        ? []
                        : [run.delegatedCompletion.delivery.messageId],
                    ),
                  );
                  const terminalDeliveryRunIds = projection.runs
                    .filter(
                      (run) =>
                        delegatedTaskTerminalStatus(run.status) !== null &&
                        openDeliveryMessageIds.has(run.userMessageId),
                    )
                    .map((run) => run.id);
                  for (const runId of terminalDeliveryRunIds) {
                    yield* subagentCommands.finalizeDelegatedCompletionDelivery(threadId, runId);
                  }
                  const refreshed =
                    terminalDeliveryRunIds.length === 0
                      ? projection
                      : yield* projectionStore.getThreadRecords(threadId, ["runs"]);
                  for (const run of refreshed.runs) {
                    if (
                      run.delegatedCompletion?.delivery !== null &&
                      run.delegatedCompletion !== undefined
                    ) {
                      yield* subagentCommands.offerDelegatedCompletionDelivery(threadId, run.id);
                    }
                  }
                }),
              )
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Failed to recover delegated completion delivery", {
                    threadId,
                    cause,
                  }),
                ),
              ),
          { concurrency: 8, discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to inspect delegated completion delivery during recovery", {
          cause,
        }),
      ),
    );
    // Recovery leaves a steer the provider had not read pending, and no run update follows it.
    yield* projectionStore.getRecoveryThreadIds("unread-steers").pipe(
      Effect.flatMap((threadIds) =>
        Effect.forEach(
          threadIds,
          (threadId) =>
            threadDispatch.withLock(threadId, queueRunner.requeueUnreadSteers(threadId)).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to requeue an unread steer during recovery", {
                  threadId,
                  cause,
                }),
              ),
            ),
          { discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to inspect unread steers during recovery", { cause }),
      ),
    );
  });

  const delegatedTaskResultPending = Effect.fn("Orchestrator.delegatedTaskResultPending")(
    function* (childThreadId: ThreadId, taskId?: NodeId) {
      const child = yield* projectionStore.getThreadRecords(
        childThreadId,
        ["runs", "messages", "subagents", "providerThreads", "providerTurns", "attempts"],
        { messageRoles: ["user"] },
      );
      if (taskId !== undefined) {
        const runs = delegatedTaskRuns(child, taskId);
        const run = delegatedTaskResultRun(runs);
        if (
          run === undefined ||
          delegatedTaskTerminalStatus(run.status) === null ||
          delegatedTaskAwaitsWork(runs, child)
        )
          return true;
        return yield* childAwaitsRestartContinuation(runs, run);
      }
      const progress = delegatedTaskProgress(child);
      if (progress.state !== "result_available") return true;
      if (progress.resultRun === undefined) return false;
      return yield* childAwaitsRestartContinuation(child.runs, progress.resultRun);
    },
    (effect, childThreadId, _taskId?) =>
      effect.pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: childThreadId, cause }),
        ),
      ),
  );

  const recoverDelegatedTask = Effect.fn("Orchestrator.recoverDelegatedTask")(
    function* (
      threadId: ThreadId,
      options?: { readonly sourceRunId?: RunId; readonly completedRunId?: RunId },
    ) {
      const completedRunId = options?.completedRunId;
      if (completedRunId !== undefined) {
        yield* threadDispatch.withLock(
          threadId,
          Effect.gen(function* () {
            const message = yield* projectionStore.getRunMessage(threadId, completedRunId);
            if (message?.delegatedCompletion === undefined) return;
            // A prior attempt may have committed the next generation before offering its wake.
            yield* subagentCommands.offerDelegatedCompletionDelivery(
              threadId,
              message.delegatedCompletion.parentRunId,
            );
            yield* subagentCommands.finalizeDelegatedCompletionDelivery(threadId, completedRunId);
          }),
        );
      }
      const sourceRunId = options?.sourceRunId;
      const parentThreadId = yield* subagentCommands.appOwnedSubagentParentThreadId(threadId);
      if (parentThreadId === undefined) return;
      if (
        sourceRunId === undefined &&
        !(yield* projectionStore.hasPendingDelegatedCompletion(threadId))
      )
        return;
      yield* threadDispatch.withLock(
        parentThreadId,
        subagentCommands
          .offerChildTaskDeliveries(parentThreadId, threadId)
          .pipe(
            Effect.andThen(
              subagentCommands.finalizeAppOwnedSubagent(
                threadId,
                sourceRunId === undefined ? undefined : { settledContinuationOf: sourceRunId },
              ),
            ),
          ),
      );
    },
    (effect, threadId, _options) =>
      effect.pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
  );

  const cancelDelegatedTask: OrchestratorV2Shape["cancelDelegatedTask"] = Effect.fn(
    "Orchestrator.cancelDelegatedTask",
  )(function* (input) {
    const { command } = input;
    return yield* threadDispatch.withLock(
      input.parentThreadId,
      Effect.gen(function* () {
        const { subagents } = yield* projectionStore
          .getThreadRecords(input.parentThreadId, ["subagents"], { subagentIds: [input.taskId] })
          .pipe(mapDispatchError(command));
        const task = subagents.find(
          (candidate) =>
            candidate.id === input.taskId &&
            candidate.origin === "app_owned" &&
            candidate.childThreadId === command.threadId &&
            isOrchestrationV2WorkActive(candidate.status),
        );
        const child = yield* projectionStore
          .getThreadRecords(
            command.threadId,
            ["runs", "messages", "subagents", "providerThreads"],
            { messageRoles: ["user"] },
          )
          .pipe(mapDispatchError(command));
        const followUpRun = child.runs
          .filter((run) => run.delegatedTaskId === input.taskId)
          .toSorted((a, b) => b.ordinal - a.ordinal)[0];
        const unsettled =
          followUpRun === undefined
            ? child.thread.forkedFrom?.type === "node" &&
              child.thread.forkedFrom.nodeId === input.taskId &&
              subagentCommands.progressAfterTurn(child).state !== "result_available"
            : delegatedTaskTerminalStatus(runOutcome(followUpRun)) === null ||
              delegatedTaskAwaitsWork(delegatedTaskRuns(child, input.taskId), child);
        yield* threadDispatch.withLock(
          command.threadId,
          Effect.gen(function* () {
            // Hold intake closed until descendants stop and this thread's Stop commits.
            yield* input.stopDescendants((command) =>
              commandThreadId(command) === input.command.threadId
                ? dispatchWithReceiptEffect(command)
                : dispatchWithReceipt(command),
            );
            const child = yield* projectionStore
              .getThreadRecords(
                command.threadId,
                ["runs", "messages", "subagents", "providerThreads"],
                { messageRoles: ["user"] },
              )
              .pipe(mapDispatchError(command));
            const followUpRun = child.runs
              .filter((run) => run.delegatedTaskId === input.taskId)
              .toSorted((a, b) => b.ordinal - a.ordinal)[0];
            const monitorRunIds = new Set(
              child.messages
                .filter((message) => message.notification?.source.kind === "monitor")
                .map((message) => message.runId),
            );
            const activeRun = child.runs
              .filter((run) => isLiveRun(run) && !monitorRunIds.has(run.id))
              .toSorted((a, b) => b.ordinal - a.ordinal)[0];
            const cancelledRun =
              followUpRun ?? activeRun ?? subagentCommands.progressAfterTurn(child).resultRun;
            const now = yield* DateTime.now;
            const cancelledTask =
              task !== undefined && unsettled && cancelledRun !== undefined
                ? { ...task, cancelledRunId: cancelledRun.id, updatedAt: now }
                : undefined;
            // The marker, Stop receipt and interrupt outbox commit together under both locks.
            yield* dispatchWithReceiptEffect(command, [], cancelledTask);
          }),
        );
        yield* subagentCommands
          .finalizeAppOwnedSubagent(command.threadId)
          .pipe(mapDispatchError(command));
      }),
    );
  });

  const shellProjectionError = (cause: unknown) =>
    new OrchestratorProjectionError({ threadId: ThreadId.make("thread:shell"), cause });

  return OrchestratorV2.of({
    resumeQueuedRuns: queueRunner.resumeQueuedRuns,
    recoverDelegatedTasks,
    recoverDelegatedTask,
    cancelDelegatedTask,
    delegatedTaskResultPending,
    restartContinuationPending: Effect.fn("OrchestratorV2.restartContinuationPending")(
      function (run) {
        return awaitsRestartContinuation(run).pipe(Effect.orElseSucceed(() => false));
      },
    ),
    awaitRestartContinuation: Effect.fn("OrchestratorV2.awaitRestartContinuation")(function (run) {
      return effectOutbox.awaitSettled(`effect:restart-continuation:${run.id}`).pipe(Effect.ignore);
    }),
    dispatch: dispatchWithReceipt,
    autoArmLimitRecovery: Effect.fn("OrchestratorV2.autoArmLimitRecovery")(function (input) {
      return threadDispatch.withLock(
        input.threadId,
        Effect.gen(function* () {
          const thread = yield* projectionStore
            .getThread(input.threadId)
            .pipe(
              Effect.mapError(
                (cause) => new OrchestratorProjectionError({ threadId: input.threadId, cause }),
              ),
            );
          // Stop or an explicit recovery choice can commit after the sweep reads its candidate.
          if (
            thread.limitRecovery?.runId === input.limitRecovery.runId &&
            thread.limitRecovery.resetAt === input.limitRecovery.resetAt
          )
            return;
          const command = { type: "thread.metadata.update", ...input } as const;
          // A Stop that reached the run before its limit failure landed had nothing to disarm.
          const stopped = yield* stopReachedRun(command, input.threadId, input.limitRecovery.runId);
          yield* dispatchWithReceiptEffect(
            stopped
              ? {
                  ...command,
                  limitRecovery: { ...input.limitRecovery, autoResume: false, snooze: false },
                }
              : command,
          );
        }),
      );
    }),
    searchThreadStream: (input) =>
      projectionStore
        .searchThreadStream(input)
        .pipe(
          Stream.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: input.threadId, cause }),
          ),
        ),
    searchThread: Effect.fn("OrchestratorV2.searchThread")(function (input) {
      return projectionStore
        .searchThread(input)
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: input.threadId, cause }),
          ),
        );
    }),
    getThreadHistoryPage: Effect.fn("OrchestratorV2.getThreadHistoryPage")(
      function (threadId, cursor, throughEntryId, conversationOnly, workMode) {
        return projectionStore
          .getThreadHistoryPage(threadId, cursor, throughEntryId, conversationOnly, workMode)
          .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
      },
    ),
    getTimelinePage: Effect.fn("OrchestratorV2.getTimelinePage")(function (threadId, options) {
      return projectionStore
        .getTimelinePage(threadId, options)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
    }),
    getMessageCount: Effect.fn("OrchestratorV2.getMessageCount")(function (threadId) {
      return projectionStore
        .getMessageCount(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
    }),
    getRunCount: Effect.fn("OrchestratorV2.getRunCount")(function (threadId) {
      return projectionStore
        .getRunCount(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
    }),
    getMessagesById: Effect.fn("OrchestratorV2.getMessagesById")(function (threadId, messageIds) {
      return projectionStore
        .getMessagesById(threadId, messageIds)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
    }),
    getTranscriptByteFloor: Effect.fn("OrchestratorV2.getTranscriptByteFloor")(
      function (threadId, limit) {
        return projectionStore
          .getTranscriptByteFloor(threadId, limit)
          .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
      },
    ),
    getTurnItem: Effect.fn("OrchestratorV2.getTurnItem")(function (input) {
      return projectionStore
        .getTurnItem(input)
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: input.threadId, cause }),
          ),
        );
    }),
    getThreadRecords: Effect.fn("OrchestratorV2.getThreadRecords")(
      function (threadId, fields, filter) {
        return projectionStore
          .getThreadRecords(threadId, fields, filter)
          .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
      },
    ),
    listAppOwnedChildThreadIds: Effect.fn("OrchestratorV2.listAppOwnedChildThreadIds")(
      function (threadId) {
        return projectionStore
          .listAppOwnedChildThreadIds(threadId)
          .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
      },
    ),
    getThreadProjection: Effect.fn("OrchestratorV2.getThreadProjection")(function (threadId) {
      return projectionStore
        .getThreadProjection(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
    }),
    getCheckpointContext: Effect.fn("OrchestratorV2.getCheckpointContext")(function (threadId) {
      return projectionStore
        .getCheckpointContext(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
    }),
    getThreadSnapshot: Effect.fn("OrchestratorV2.getThreadSnapshot")(function (threadId) {
      return projectionStore
        .getThreadSnapshot(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
    }),
    getThreadSnapshotWindow: Effect.fn("OrchestratorV2.getThreadSnapshotWindow")(
      function (threadId, options) {
        return projectionStore
          .getThreadSnapshotWindow(threadId, options)
          .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
      },
    ),
    getPullRequestSnapshot: Effect.fn("OrchestratorV2.getPullRequestSnapshot")(function (options) {
      return projectionStore
        .getPullRequestSnapshot(options)
        .pipe(Effect.mapError(shellProjectionError));
    }),
    getAgentAwarenessSnapshot: Effect.fn("OrchestratorV2.getAgentAwarenessSnapshot")(
      function (threadId) {
        return projectionStore
          .getAgentAwarenessSnapshot(threadId)
          .pipe(Effect.mapError(shellProjectionError));
      },
    ),
    getShellSnapshot: Effect.fn("OrchestratorV2.getShellSnapshot")(function (options) {
      return projectionStore.getShellSnapshot(options).pipe(Effect.mapError(shellProjectionError));
    }),
    listActiveSubagentThreadIds: Effect.fn("OrchestratorV2.listActiveSubagentThreadIds")(
      function () {
        return projectionStore
          .listActiveSubagentThreadIds()
          .pipe(Effect.mapError(shellProjectionError));
      },
    ),
    listEphemeralThreadIds: Effect.fn("OrchestratorV2.listEphemeralThreadIds")(function () {
      return projectionStore.listEphemeralThreadIds().pipe(Effect.mapError(shellProjectionError));
    }),
    countThreads: Effect.fn("OrchestratorV2.countThreads")(function () {
      return projectionStore.countThreads().pipe(Effect.mapError(shellProjectionError));
    }),
    listActiveShellIndex: Effect.fn("OrchestratorV2.listActiveShellIndex")(function () {
      return projectionStore.listActiveShellIndex().pipe(Effect.mapError(shellProjectionError));
    }),
    listActiveThreads: Effect.fn("OrchestratorV2.listActiveThreads")(function (projectId) {
      return projectionStore
        .listActiveThreads(projectId)
        .pipe(Effect.mapError(shellProjectionError));
    }),
    listOlderSettledThreads: Effect.fn("OrchestratorV2.listOlderSettledThreads")(function (query) {
      return projectionStore
        .listOlderSettledThreads(query)
        .pipe(Effect.mapError(shellProjectionError));
    }),
    readShellSnapshot: Effect.fn("OrchestratorV2.readShellSnapshot")(function (options) {
      return projectionStore
        .readShellSnapshot(options)
        .pipe(
          Effect.mapError(shellProjectionError),
          Effect.map(Effect.mapError(shellProjectionError)),
        );
    }),
    getThreadShell: Effect.fn("OrchestratorV2.getThreadShell")(function (threadId) {
      return projectionStore
        .getThreadShell(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
    }),
    findGuestShareThreadId: Effect.fn("OrchestratorV2.findGuestShareThreadId")(function (shareId) {
      return projectionStore
        .findGuestShareThreadId(shareId)
        .pipe(Effect.mapError(shellProjectionError));
    }),
    getThreadLinkMetadata: Effect.fn("OrchestratorV2.getThreadLinkMetadata")(function (threadIds) {
      return projectionStore
        .getThreadLinkMetadata(threadIds)
        .pipe(Effect.mapError(shellProjectionError));
    }),
    getThreadTitles: Effect.fn("OrchestratorV2.getThreadTitles")(function (threadIds) {
      return projectionStore.getThreadTitles(threadIds).pipe(Effect.mapError(shellProjectionError));
    }),
    getThreadEventSequence: Effect.fn("OrchestratorV2.getThreadEventSequence")(function (threadId) {
      return eventSink
        .latestSequence({ threadId })
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
    }),
    streamStoredEvents: eventSink.stream().pipe(
      Stream.mapError(
        (cause) =>
          new OrchestratorDomainEventStreamError({
            cause,
          }),
      ),
    ),
    streamStoredEventsFrom: (input) =>
      eventSink.stream({ ...input, bounded: true }).pipe(
        Stream.mapError(
          (cause) =>
            new OrchestratorDomainEventStreamError({
              cause,
            }),
        ),
      ),
    // Start at the latest sequence; awareness needs no historical replay.
    streamDomainEvents: Stream.unwrap(
      eventSink
        .latestSequence()
        .pipe(Effect.map((latest) => eventSink.stream({ afterSequence: latest }))),
    ).pipe(
      Stream.map((stored) => stored.event),
      Stream.mapError(
        (cause) =>
          new OrchestratorDomainEventStreamError({
            cause,
          }),
      ),
    ),
  });
});

export const layer: Layer.Layer<
  OrchestratorV2,
  never,
  | CheckpointServiceV2
  | FileSystem.FileSystem
  | Path.Path
  | CommandPolicyV2
  | CommandReceiptStoreV2
  | ContextHandoffServiceV2
  | EffectOutbox.EffectOutboxV2
  | EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProjectStore.ProjectStoreV2
  | ProviderAdapterRegistryV2
  | ProviderSessionManagerV2
  | ProviderSwitchServiceV2
  | ProjectionStoreV2
  | RuntimePolicyV2
  | ServerSettings.ServerSettingsService
  | TaskFolderStore.TaskFolderStore
  | ThreadForkServiceV2
> = Layer.effect(OrchestratorV2, makeOrchestrator()).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
);
