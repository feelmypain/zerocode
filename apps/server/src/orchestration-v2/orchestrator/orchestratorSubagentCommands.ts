import {
  CommandId,
  isOrchestrationV2WorkActive,
  type NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DelegatedCompletionCohort,
  type OrchestrationV2DelegatedCompletionDelivery,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2RemoteTaskChild,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type RunId,
  type ThreadId,
} from "@zerocode/contracts";
import {
  delegatedTaskProgress,
  delegatedTaskReportRuns,
  makeSubagentChildThread,
  monitorUpdateRunIds,
  SUBAGENT_RESULT_TURN_ITEM_TYPES,
  subagentResultForRun,
  subagentThreadTitle,
} from "@zerocode/provider-core/server/subagentProjection";
import { hasPendingBackgroundSubagent } from "@zerocode/shared/orchestrationV2PendingBackgroundWork";
import { runRanAfter } from "@zerocode/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { followUpOwnerRun, isActiveRun } from "../CommandPolicy.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import { isUndeliveredMailboxSteer } from "../NotificationMailbox.ts";
import type { ProjectionRecords } from "../ProjectionStore.ts";
import {
  delegatedTaskAwaitsWork,
  delegatedTaskResultRun,
  delegatedTaskRuns,
  runOutcome,
} from "../RestartBackgroundNote.ts";
import {
  type CancelUnsettledEffects,
  cancelledAppOwnedTask,
  contextSourcePointForRun,
  delegatedCompletionWakeDetail,
  delegatedTaskTerminalStatus,
  hasLiveRun,
  isLiveRun,
  isOrchestratorProjectionError,
  isTerminalDelegatedTaskStatus,
  mayStartSubagentFollowup,
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorProviderAdapterError,
  type OrchestratorShared,
  type OrchestratorV2DispatchResult,
  type OrchestratorV2Error,
  providerTurnForRun,
} from "./orchestratorShared.ts";

const DELEGATED_CHILD_RUN_WINDOW = 20;

type DelegatedChildControls = ProjectionRecords<
  "runs" | "messages" | "subagents" | "providerThreads"
> & {
  /** Set when `runs` holds only what ran since this run, plus older unfinished and task runs. */
  readonly runsFloor?: OrchestrationV2Run | undefined;
};

function ranSince(run: OrchestrationV2Run, floor: OrchestrationV2Run): boolean {
  return run.id === floor.id || runRanAfter(run, floor);
}

/** The walk back to a report is exact when it stops at a run that ran since the floor. */
function reportRunsRead(
  controls: DelegatedChildControls,
  run: OrchestrationV2Run,
  reportRuns: ReadonlyArray<OrchestrationV2Run>,
): boolean {
  const floor = controls.runsFloor;
  if (floor === undefined || run.status !== "completed") return true;
  const oldest = reportRuns.at(-1) ?? run;
  if (!ranSince(oldest, floor)) return false;
  const monitorRuns = monitorUpdateRunIds(controls.messages);
  return controls.runs.some(
    (candidate) =>
      candidate.id !== run.id &&
      candidate.startedAt !== null &&
      candidate.status !== "rolled_back" &&
      !monitorRuns.has(candidate.id) &&
      runRanAfter(oldest, candidate) &&
      ranSince(candidate, floor),
  );
}

const completionDeliveryRun = (
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs">,
  delivery: OrchestrationV2DelegatedCompletionDelivery | null | undefined,
) => {
  if (delivery == null) return undefined;
  const message = projection.messages.find((candidate) => candidate.id === delivery.messageId);
  return projection.runs.find((candidate) => candidate.id === message?.runId);
};

const completionDeliveryMessage = (
  projection: Pick<OrchestrationV2ThreadProjection, "messages">,
  delivery: OrchestrationV2DelegatedCompletionDelivery | null | undefined,
) =>
  delivery === null || delivery === undefined
    ? undefined
    : projection.messages.find((candidate) => candidate.id === delivery.messageId);

/** Parent run and wake message events that commit a planDelegatedCompletionDelivery result. */
const delegatedCompletionPlanEvents = (
  threadId: ThreadId,
  plan: {
    readonly parentRun: OrchestrationV2Run | undefined;
    readonly message: OrchestrationV2ThreadProjection["messages"][number] | undefined;
  },
  threadProviderInstanceId: ProviderInstanceId,
  occurredAt: DateTime.Utc,
): ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">> => [
  ...(plan.parentRun === undefined
    ? []
    : [
        {
          type: "run.updated" as const,
          threadId,
          runId: plan.parentRun.id,
          ...(plan.parentRun.rootNodeId === null ? {} : { nodeId: plan.parentRun.rootNodeId }),
          providerInstanceId: plan.parentRun.providerInstanceId,
          occurredAt,
          payload: plan.parentRun,
        },
      ]),
  ...(plan.message === undefined
    ? []
    : [
        {
          type: "message.updated" as const,
          threadId,
          ...(plan.message.runId === null ? {} : { runId: plan.message.runId }),
          ...(plan.message.nodeId === null ? {} : { nodeId: plan.message.nodeId }),
          providerInstanceId: plan.parentRun?.providerInstanceId ?? threadProviderInstanceId,
          occurredAt,
          payload: plan.message,
        },
      ]),
];

interface SubagentCommandCallbacks {
  readonly dispatchMessage: (
    command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) => Effect.Effect<CancelUnsettledEffects | undefined, OrchestratorV2Error>;
  readonly dispatchWithReceipt: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<OrchestratorV2DispatchResult, OrchestratorV2Error>;
  readonly dispatchWithReceiptEffect: (
    command: OrchestrationV2ServerCommand,
    sideChatIds?: ReadonlyArray<ThreadId>,
    cancelledTask?: OrchestrationV2Subagent,
  ) => Effect.Effect<OrchestratorV2DispatchResult, OrchestratorV2Error>;
}

export function makeSubagentCommands(
  shared: OrchestratorShared,
  callbacks: SubagentCommandCallbacks,
) {
  const {
    continuationRequests,
    idAllocator,
    projectionStore,
    providerAdapters,
    threadDispatch,
    awaitsRestartContinuation,
    childAwaitsRestartContinuation,
    emit,
    emitQueuedRunCancellation,
    getProjectionWithPendingEvents,
    loadProjectionForCommand,
    mapDelegatedCompletionError,
    mapDispatchError,
    nextTurnItemOrdinal,
    stopReachedRun,
    subagentCount,
    writeSystemEvents,
  } = shared;

  const isUnobservedAcknowledgement = (
    command: OrchestrationV2ServerCommand,
  ): command is Extract<
    OrchestrationV2ServerCommand,
    { readonly type: "delegated_task.completion-delivery.acknowledge" }
  > & { readonly observedByRunId: null } =>
    command.type === "delegated_task.completion-delivery.acknowledge" &&
    command.observedByRunId === null;

  /** The parent records `planDelegatedCompletionDelivery` reads for one task: its run, and the queued wake's message, run and tasks. */
  const readDelegatedCompletionPlanRecords =
    /* The delegated task operation that calls this owns the span. */
    Effect.fnUntraced(function* (parentThreadId: ThreadId, task: OrchestrationV2Subagent) {
      const {
        thread,
        runs: [parentRun],
      } = yield* projectionStore.getThreadRecords(parentThreadId, ["runs"], {
        runIds: task.runId === null ? [] : [task.runId],
      });
      const delivery = parentRun?.delegatedCompletion?.delivery;
      if (delivery == null) return { thread, parentRun, runs: [], messages: [], subagents: [] };
      const { messages } = yield* projectionStore.getThreadRecords(parentThreadId, ["messages"], {
        messageIds: [delivery.messageId],
        messageRoles: ["user"],
      });
      const deliveryRunId = messages[0]?.runId;
      const { runs, subagents } = yield* projectionStore.getThreadRecords(
        parentThreadId,
        ["runs", "subagents"],
        {
          runIds: deliveryRunId == null ? [] : [deliveryRunId],
          subagentIds: [...delivery.taskIds, task.id],
        },
      );
      return { thread, parentRun, runs, messages, subagents };
    });

  const offerDelegatedCompletionDelivery =
    /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
    Effect.fnUntraced(function* (threadId: ThreadId, parentRunId: RunId) {
      const controls = yield* projectionStore.getThreadRecords(threadId, ["runs"], {
        runIds: [parentRunId],
      });
      const parentRun = controls.runs[0];
      const cohort = parentRun?.delegatedCompletion;
      const delivery = cohort?.delivery;
      if (
        parentRun === undefined ||
        cohort?.disposition !== "open" ||
        delivery == null ||
        delivery.taskIds.length === 0 ||
        controls.thread.archivedAt !== null ||
        controls.thread.deletedAt !== null
      )
        return;
      const messages = yield* projectionStore.getThreadRecords(threadId, ["messages"], {
        messageIds: [delivery.messageId],
      });
      const message = messages.messages[0];
      if (message !== undefined) {
        if (message.delegatedCompletion === undefined || message.runId === null) return;
        const runs = yield* projectionStore.getThreadRecords(threadId, ["runs"], {
          runIds: [message.runId],
        });
        const run = runs.runs[0];
        const turns = yield* projectionStore.getThreadRecords(threadId, ["providerTurns"], {
          providerTurnAttemptIds: run?.activeAttemptId == null ? [] : [run.activeAttemptId],
        });
        if (!isUndeliveredMailboxSteer({ ...messages, ...runs, ...turns }, delivery.messageId))
          return;
      }
      const projection = yield* projectionStore.getThreadRecords(threadId, ["providerThreads"], {
        providerThreadIds: parentRun.providerThreadId === null ? [] : [parentRun.providerThreadId],
      });
      const providerThread =
        parentRun.providerThreadId === null
          ? undefined
          : projection.providerThreads.find(
              (candidate) => candidate.id === parentRun.providerThreadId,
            );
      if (providerThread === undefined) {
        return;
      }
      yield* continuationRequests.offer({
        threadId,
        providerThreadId: providerThread.id,
        driver: providerThread.driver,
        detail: null,
        delivery: "message_text",
        delegatedCompletion: {
          parentRunId,
          generation: delivery.generation,
          messageId: delivery.messageId,
        },
      });
    });

  const offerDelegatedCompletionDeliveries =
    /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
    Effect.fnUntraced(function* (threadId: ThreadId) {
      const projection = yield* projectionStore.getThreadRecords(threadId, ["runs"]);
      for (const run of projection.runs) {
        if (
          run.delegatedCompletion?.delivery !== undefined &&
          run.delegatedCompletion.delivery !== null
        ) {
          yield* offerDelegatedCompletionDelivery(threadId, run.id);
        }
      }
    });

  const offerChildTaskDeliveries =
    /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
    Effect.fnUntraced(function* (parentThreadId: ThreadId, childThreadId: ThreadId) {
      // A task's wake lives on the run that requested it; the parent's other wakes are not this child's.
      const { subagents } = yield* projectionStore.getThreadRecords(parentThreadId, ["subagents"], {
        subagentChildThreadIds: [childThreadId],
      });
      const parentRunIds = new Set(
        subagents.flatMap((task) =>
          task.childThreadId === childThreadId && task.runId !== null ? [task.runId] : [],
        ),
      );
      for (const parentRunId of parentRunIds) {
        yield* offerDelegatedCompletionDelivery(parentThreadId, parentRunId);
      }
    });

  /** Marks a wake the provider received delivered and reserves the next one for pending siblings. */
  const acceptDelegatedCompletionDelivery = Effect.fn(
    "Orchestrator.acceptDelegatedCompletionDelivery",
  )(function* (input: {
    readonly command: OrchestrationV2ServerCommand;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly projection: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "runs" | "messages" | "subagents"
    >;
    readonly messageId: OrchestrationV2ConversationMessage["id"];
    readonly now: DateTime.Utc;
  }) {
    const { projection, now } = input;
    const message = projection.messages.find((row) => row.id === input.messageId);
    const ownership = message?.delegatedCompletion;
    const parentRun = projection.runs.find((run) => run.id === ownership?.parentRunId);
    const cohort = parentRun?.delegatedCompletion;
    const delivery = cohort?.delivery;
    if (
      parentRun === undefined ||
      cohort === undefined ||
      cohort.disposition !== "open" ||
      delivery == null ||
      delivery.messageId !== input.messageId ||
      delivery.generation !== ownership?.generation
    ) {
      return undefined;
    }
    const threadId = projection.thread.id;
    const parentIsLive = hasLiveRun({ runs: [parentRun] });
    const pendingTaskIds =
      projection.thread.archivedAt === null && projection.thread.deletedAt === null
        ? projection.subagents
            .filter(
              (task) =>
                task.origin === "app_owned" &&
                task.runId === parentRun.id &&
                task.completionDelivery?.state === "pending" &&
                isTerminalDelegatedTaskStatus(task.status) &&
                (!parentIsLive || task.completionWake === "always"),
            )
            .map((task) => task.id)
        : [];
    const nextDelivery =
      pendingTaskIds.length === 0
        ? null
        : {
            generation: cohort.nextGeneration,
            messageId: yield* mapDelegatedCompletionError(
              idAllocator.allocate.message({
                threadId,
                ordinal:
                  (yield* mapDelegatedCompletionError(projectionStore.getMessageCount(threadId))) +
                  1,
              }),
            ),
            taskIds: pendingTaskIds,
          };
    const emitEvent = emit(input.events, input.command);
    const acceptedIds = new Set(delivery.taskIds);
    const pendingIds = new Set(pendingTaskIds);
    for (const task of projection.subagents) {
      const state = pendingIds.has(task.id)
        ? "claimed"
        : acceptedIds.has(task.id) && task.completionDelivery?.state === "claimed"
          ? "delivered"
          : undefined;
      if (state === undefined) continue;
      yield* emitEvent({
        type: "subagent.updated",
        threadId,
        runId: parentRun.id,
        nodeId: task.id,
        driver: task.driver,
        providerInstanceId: task.providerInstanceId,
        occurredAt: now,
        payload: { ...task, completionDelivery: { state, observedByRunId: null }, updatedAt: now },
      });
    }
    yield* emitEvent({
      type: "run.updated",
      threadId,
      runId: parentRun.id,
      providerInstanceId: parentRun.providerInstanceId,
      occurredAt: now,
      payload: {
        ...parentRun,
        delegatedCompletion: {
          ...cohort,
          nextGeneration: cohort.nextGeneration + (nextDelivery === null ? 0 : 1),
          delivery: nextDelivery,
        },
      },
    });
    return parentRun.id;
  });

  const planDelegatedCompletionDelivery = Effect.fn(
    "orchestrationV2.planDelegatedCompletionDelivery",
  )(function* (input: {
    readonly parentProjection: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "messages" | "runs" | "subagents"
    >;
    readonly parentRun: OrchestrationV2Run | undefined;
    readonly task: OrchestrationV2Subagent;
    readonly updatedTask: OrchestrationV2Subagent;
    readonly now: DateTime.Utc;
  }) {
    const taskDelivery = input.updatedTask.completionDelivery;
    if (
      taskDelivery?.state === "acknowledged" ||
      taskDelivery?.state === "delivered" ||
      taskDelivery?.state === "disposed"
    ) {
      return {
        task: input.updatedTask,
        parentRun: undefined,
        message: undefined,
        offer: false,
      };
    }
    const cohort = input.parentRun?.delegatedCompletion;
    if (
      input.parentRun === undefined ||
      input.parentProjection.thread.archivedAt !== null ||
      input.parentProjection.thread.deletedAt !== null ||
      (cohort !== undefined && cohort.disposition !== "open")
    ) {
      return {
        task: {
          ...input.updatedTask,
          completionDelivery: {
            state: "disposed" as const,
            observedByRunId: null,
          },
        },
        parentRun: undefined,
        message: undefined,
        offer: false,
      };
    }
    // settled_only relies on a blocking wait that ends with the spawning turn; later results need another delivery path.
    if (
      (input.task.completionWake ?? "settled_only") === "settled_only" &&
      hasLiveRun({ runs: [input.parentRun] })
    ) {
      return {
        task: input.updatedTask,
        parentRun: undefined,
        message: undefined,
        offer: false,
      };
    }

    const delivery = cohort?.delivery ?? null;
    const deliveryRun = completionDeliveryRun(input.parentProjection, delivery);
    if (delivery !== null) {
      if (deliveryRun?.status === "queued" && deliveryRun.userMessageId === delivery.messageId) {
        const taskIds = Array.from(new Set([...delivery.taskIds, input.task.id]));
        const message = completionDeliveryMessage(input.parentProjection, delivery);
        const nextCohort = {
          ...cohort!,
          delivery: {
            ...delivery,
            taskIds,
          },
        };
        return {
          task: {
            ...input.updatedTask,
            completionDelivery: {
              state: "claimed" as const,
              observedByRunId: null,
            },
          },
          parentRun: {
            ...input.parentRun,
            delegatedCompletion: nextCohort,
          },
          message:
            message === undefined
              ? undefined
              : {
                  ...message,
                  text: delegatedCompletionWakeDetail(
                    taskIds,
                    input.parentProjection.subagents.map((task) =>
                      task.id === input.updatedTask.id ? input.updatedTask : task,
                    ),
                  ),
                  delegatedCompletion: {
                    parentRunId: input.parentRun.id,
                    generation: delivery.generation,
                    taskIds,
                  },
                  updatedAt: input.now,
                },
          offer: false,
        };
      }
      if (deliveryRun !== undefined) {
        // The terminal-run listener reserves successor wakes; keep racing siblings pending to avoid competing deliveries.
        return {
          task: {
            ...input.updatedTask,
            completionDelivery: {
              state: "pending" as const,
              observedByRunId: null,
            },
          },
          parentRun: undefined,
          message: undefined,
          offer: false,
        };
      }
      const taskIds = Array.from(new Set([...delivery.taskIds, input.task.id]));
      const nextCohort = {
        ...cohort!,
        delivery: {
          ...delivery,
          taskIds,
        },
      };
      return {
        task: {
          ...input.updatedTask,
          completionDelivery: {
            state: "claimed" as const,
            observedByRunId: null,
          },
        },
        parentRun: {
          ...input.parentRun,
          delegatedCompletion: nextCohort,
        },
        message: undefined,
        offer: true,
      };
    }

    const generation = cohort?.nextGeneration ?? 1;
    const messageId = yield* mapDelegatedCompletionError(
      idAllocator.allocate.message({
        threadId: input.parentRun.threadId,
        ordinal:
          (yield* mapDelegatedCompletionError(
            projectionStore.getMessageCount(input.parentRun.threadId),
          )) + 1,
      }),
    );
    const nextCohort = {
      disposition: "open" as const,
      nextGeneration: generation + 1,
      delivery: {
        generation,
        messageId,
        taskIds: [input.task.id],
      },
    };
    return {
      task: {
        ...input.updatedTask,
        completionDelivery: {
          state: "claimed" as const,
          observedByRunId: null,
        },
      },
      parentRun: {
        ...input.parentRun,
        delegatedCompletion: nextCohort,
      },
      message: undefined,
      offer: true,
    };
  });

  const dispatchDelegatedTaskCompletionDeliveryResolution = Effect.fn(
    "Orchestrator.dispatchDelegatedTaskCompletionDeliveryResolution",
  )(function* (
    command: Extract<
      OrchestrationV2Command,
      {
        readonly type:
          | "delegated_task.completion-delivery.acknowledge"
          | "delegated_task.completion-delivery.dispose";
      }
    >,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const projection = yield* loadProjectionForCommand(command, ["subagents"], {
      subagentIds: [command.taskId],
    });
    const task = projection.subagents.find(
      (candidate) => candidate.id === command.taskId && candidate.origin === "app_owned",
    );
    if (task === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Delegated task ${command.taskId} is not an app-owned task of thread ${command.parentThreadId}.`,
      });
    }
    const state =
      command.type === "delegated_task.completion-delivery.acknowledge"
        ? "acknowledged"
        : "disposed";
    const now = yield* DateTime.now;
    const emitEvent = emit(events, command);
    const {
      runs: [parentRun],
    } = yield* loadProjectionForCommand(command, ["runs"], {
      runIds: task.runId === null ? [] : [task.runId],
    });
    // A late wait can arrive after finalization held the result for its still-live spawning run.
    if (isUnobservedAcknowledgement(command)) {
      if (
        !isTerminalDelegatedTaskStatus(task.status) ||
        task.completionDelivery?.state !== "pending"
      )
        return;
      if (parentRun !== undefined && isLiveRun(parentRun)) return;
      const records = yield* loadProjectionForCommand(
        command,
        ["runs", "subagents", "messages", "providerTurns"],
        { messageRoles: ["user"] },
      );
      const plan = yield* planDelegatedCompletionDelivery({
        parentProjection: records,
        parentRun,
        task,
        updatedTask: task,
        now,
      }).pipe(mapDispatchError(command));
      if (plan.task.completionDelivery?.state === "pending") return;
      yield* emitEvent({
        type: "subagent.updated",
        threadId: command.parentThreadId,
        ...(task.runId === null ? {} : { runId: task.runId }),
        nodeId: task.id,
        driver: task.driver,
        providerInstanceId: task.providerInstanceId,
        occurredAt: now,
        payload: plan.task,
      });
      for (const event of delegatedCompletionPlanEvents(
        command.parentThreadId,
        plan,
        projection.thread.providerInstanceId,
        now,
      )) {
        yield* emitEvent(event);
      }
      return plan.parentRun?.id;
    }
    // task_status and zerocode_thread_read use distinct command IDs, so two
    // valid observations can race after their read preflight. Re-emit the
    // existing task row so the second dispatch is a successful idempotent
    // no-op rather than "already acknowledged/disposed" or empty-events.
    if (
      task.completionDelivery?.state === state ||
      (command.type === "delegated_task.completion-delivery.acknowledge" &&
        task.completionDelivery?.state === "disposed")
    ) {
      yield* emitEvent({
        type: "subagent.updated",
        threadId: command.parentThreadId,
        ...(task.runId === null ? {} : { runId: task.runId }),
        nodeId: task.id,
        driver: task.driver,
        providerInstanceId: task.providerInstanceId,
        occurredAt: now,
        payload: task,
      });
      return;
    }
    const updatedTask: OrchestrationV2Subagent = {
      ...task,
      completionDelivery: {
        state,
        observedByRunId:
          command.type === "delegated_task.completion-delivery.acknowledge"
            ? command.observedByRunId
            : null,
      },
      updatedAt: now,
    };
    yield* emitEvent({
      type: "subagent.updated",
      threadId: command.parentThreadId,
      ...(task.runId === null ? {} : { runId: task.runId }),
      nodeId: task.id,
      driver: task.driver,
      providerInstanceId: task.providerInstanceId,
      occurredAt: now,
      payload: updatedTask,
    });

    const cohort = parentRun?.delegatedCompletion;
    const delivery = cohort?.delivery;
    if (
      parentRun === undefined ||
      cohort === undefined ||
      delivery === null ||
      delivery === undefined
    ) {
      return;
    }
    if (!delivery.taskIds.includes(task.id)) {
      return;
    }

    const { messages } = yield* loadProjectionForCommand(command, ["messages"], {
      messageRoles: ["user"],
      messageIds: [delivery.messageId],
    });
    const deliveryRunId = completionDeliveryMessage({ messages }, delivery)?.runId ?? null;
    const { runs } = yield* loadProjectionForCommand(command, ["runs"], {
      runIds: deliveryRunId === null ? [] : [deliveryRunId],
    });
    const deliveryProjection = { messages, runs };
    const remainingTaskIds = delivery.taskIds.filter((taskId) => taskId !== task.id);
    const deliveryRun = completionDeliveryRun(deliveryProjection, delivery);
    const clearDelivery =
      remainingTaskIds.length === 0 &&
      (deliveryRun === undefined || deliveryRun.status === "queued");
    const updatedCohort: OrchestrationV2DelegatedCompletionCohort = {
      ...cohort,
      delivery: clearDelivery
        ? null
        : {
            ...delivery,
            taskIds: remainingTaskIds,
          },
    };
    yield* emitEvent({
      type: "run.updated",
      threadId: command.parentThreadId,
      runId: parentRun.id,
      ...(parentRun.rootNodeId === null ? {} : { nodeId: parentRun.rootNodeId }),
      providerInstanceId: parentRun.providerInstanceId,
      occurredAt: now,
      payload: {
        ...parentRun,
        delegatedCompletion: updatedCohort,
      },
    });

    if (deliveryRun?.status === "queued") {
      if (remainingTaskIds.length === 0) {
        const rootNodeFilter = {
          nodeIds: deliveryRun.rootNodeId === null ? [] : [deliveryRun.rootNodeId],
        };
        yield* emitQueuedRunCancellation({
          command,
          events,
          // Attempts have no id filter; a wake that never started has no attempt to cancel.
          projection:
            deliveryRun.activeAttemptId === null
              ? {
                  attempts: [],
                  ...(yield* loadProjectionForCommand(command, ["nodes"], rootNodeFilter)),
                }
              : yield* loadProjectionForCommand(command, ["nodes", "attempts"], rootNodeFilter),
          run: deliveryRun,
          now,
        });
        return parentRun.id;
      }
      const message = completionDeliveryMessage(deliveryProjection, delivery);
      if (message !== undefined) {
        const { subagents: remainingTasks } = yield* loadProjectionForCommand(
          command,
          ["subagents"],
          { subagentIds: remainingTaskIds },
        );
        yield* emitEvent({
          type: "message.updated",
          threadId: command.parentThreadId,
          runId: deliveryRun.id,
          ...(deliveryRun.rootNodeId === null ? {} : { nodeId: deliveryRun.rootNodeId }),
          providerInstanceId: deliveryRun.providerInstanceId,
          occurredAt: now,
          payload: {
            ...message,
            text: delegatedCompletionWakeDetail(remainingTaskIds, remainingTasks),
            delegatedCompletion: {
              parentRunId: parentRun.id,
              generation: delivery.generation,
              taskIds: remainingTaskIds,
            },
            updatedAt: now,
          },
        });
      }
    }
    return parentRun.id;
  });

  const disposeDelegatedCompletionCohort = Effect.fn(
    "Orchestrator.disposeDelegatedCompletionCohort",
  )(function* (input: {
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
    // An interrupted or cancelled wake disposes only the results it carried. The cohort stays
    // open, and its delivery stays the wake's, so the wake's terminal reserves any sibling's result.
    readonly interruptedWakeTaskIds?: ReadonlyArray<NodeId>;
  }) {
    const parentRun = input.projection.runs.find((candidate) => candidate.id === input.parentRunId);
    if (parentRun === undefined) {
      return;
    }
    const cohort = parentRun.delegatedCompletion;
    const tasks = input.projection.subagents.filter(
      (candidate) => candidate.origin === "app_owned" && candidate.runId === input.parentRunId,
    );
    if (cohort === undefined && tasks.length === 0) {
      return;
    }
    const emitEvent = emit(input.events, input.command);
    const wakeTaskIds = input.interruptedWakeTaskIds;
    const keptTaskIds = new Set(
      wakeTaskIds !== undefined && cohort?.disposition === "open"
        ? tasks
            .filter(
              (task) =>
                !wakeTaskIds.includes(task.id) &&
                task.completionDelivery?.state !== "acknowledged" &&
                task.completionDelivery?.state !== "delivered" &&
                task.completionDelivery?.state !== "disposed",
            )
            .map((task) => task.id)
        : [],
    );
    const nextCohort =
      keptTaskIds.size > 0
        ? cohort!
        : ({
            disposition: cohort?.disposition === "disposed" ? "disposed" : input.disposition,
            nextGeneration: cohort?.nextGeneration ?? 1,
            delivery: null,
          } as const);
    yield* emitEvent({
      type: "run.updated",
      threadId: parentRun.threadId,
      runId: parentRun.id,
      ...(parentRun.rootNodeId === null ? {} : { nodeId: parentRun.rootNodeId }),
      providerInstanceId: parentRun.providerInstanceId,
      occurredAt: input.now,
      payload: {
        ...parentRun,
        delegatedCompletion: nextCohort,
      },
    });
    for (const task of tasks) {
      if (
        keptTaskIds.has(task.id) ||
        task.completionDelivery?.state === "acknowledged" ||
        task.completionDelivery?.state === "delivered" ||
        task.completionDelivery?.state === "disposed"
      ) {
        continue;
      }
      yield* emitEvent({
        type: "subagent.updated",
        threadId: parentRun.threadId,
        ...(task.runId === null ? {} : { runId: task.runId }),
        nodeId: task.id,
        driver: task.driver,
        providerInstanceId: task.providerInstanceId,
        occurredAt: input.now,
        payload: {
          ...task,
          completionDelivery: {
            state: "disposed",
            observedByRunId: null,
          },
          updatedAt: input.now,
        },
      });
    }
    const deliveryRun = completionDeliveryRun(input.projection, cohort?.delivery ?? null);
    if (
      keptTaskIds.size === 0 &&
      input.cancelQueuedDelivery !== false &&
      deliveryRun?.status === "queued"
    ) {
      yield* emitQueuedRunCancellation({
        command: input.command,
        events: input.events,
        projection: input.projection,
        run: deliveryRun,
        now: input.now,
      });
    }
  });

  const disposeAllDelegatedCompletionCohorts = (input: {
    readonly command: OrchestrationV2Command;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly projection: Pick<
      OrchestrationV2ThreadProjection,
      "runs" | "subagents" | "messages" | "nodes" | "attempts"
    >;
    readonly now: DateTime.Utc;
    readonly cancelQueuedDelivery?: boolean;
  }) =>
    Effect.forEach(
      Array.from(
        new Set([
          ...input.projection.runs
            .filter((run) => run.delegatedCompletion !== undefined)
            .map((run) => run.id),
          ...input.projection.subagents
            .filter((task) => task.origin === "app_owned" && task.runId !== null)
            .map((task) => task.runId!),
        ]),
      ),
      (parentRunId) =>
        disposeDelegatedCompletionCohort({
          ...input,
          parentRunId,
          disposition: "disposed",
        }),
      { concurrency: 1, discard: true },
    );

  // A native background subagent keeps working, and delegating, after the latest run settles.
  const backgroundSubagentOutlivesRun = (run: OrchestrationV2Run) =>
    projectionStore.getThreadShell(run.threadId).pipe(
      Effect.map(
        (shell) =>
          shell !== null &&
          shell.archivedAt === null &&
          shell.activeRunId === null &&
          shell.latestRunId === run.id &&
          hasPendingBackgroundSubagent(shell.pendingBackgroundTasks, run.providerInstanceId),
      ),
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: run.threadId, cause }),
      ),
    );

  const dispatchDelegatedTaskRequest = Effect.fn("orchestrationV2.dispatch.delegatedTaskRequest")(
    function* (
      command: Extract<OrchestrationV2Command, { readonly type: "delegated_task.request" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
      effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    ) {
      const parentProjection = yield* projectionStore
        .getRunProviderRecords(command.parentThreadId, command.parentRunId, command.parentNodeId)
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.parentThreadId, cause }),
          ),
        );
      const parentRun = parentProjection.runs.find(
        (candidate) => candidate.id === command.parentRunId,
      );
      if (
        parentRun === undefined ||
        !(isActiveRun(parentRun) || (yield* backgroundSubagentOutlivesRun(parentRun)))
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Parent run ${command.parentRunId} is not active.`,
        });
      }
      if (yield* stopReachedRun(command, command.parentThreadId, parentRun.id)) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Parent run ${command.parentRunId} is stopping.`,
        });
      }
      const parentNode = parentProjection.nodes.find(
        (candidate) => candidate.id === command.parentNodeId,
      );
      if (
        parentNode === undefined ||
        parentNode.runId !== parentRun.id ||
        parentRun.rootNodeId === null
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Parent node ${command.parentNodeId} is not part of active run ${parentRun.id}.`,
        });
      }

      const targetAdapter = yield* providerAdapters.get(command.modelSelection.instanceId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProviderAdapterError({
              commandId: command.commandId,
              providerInstanceId: command.modelSelection.instanceId,
              cause,
            }),
        ),
      );

      const now = command.createdAt ?? (yield* DateTime.now);
      const taskNodeId = idAllocator.derive.delegatedTaskNode({
        commandId: command.commandId,
      });
      const childThreadId = idAllocator.derive.delegatedTaskThread({
        commandId: command.commandId,
      });
      const childMessageId = idAllocator.derive.delegatedTaskMessage({
        commandId: command.commandId,
      });
      const taskTurnItemId = idAllocator.derive.delegatedTaskTurnItem({
        commandId: command.commandId,
      });
      const taskTitle = subagentThreadTitle({
        parentTitle: parentProjection.thread.title,
        prompt: command.task,
        ...(command.title === undefined ? {} : { title: command.title }),
        ordinal: (yield* subagentCount(command.parentThreadId)) + 1,
      });
      const childThread: OrchestrationV2AppThread = {
        ...makeSubagentChildThread({
          parentThread: parentProjection.thread,
          childThreadId,
          parentNodeId: taskNodeId,
          activeProviderThreadId: null,
          providerInstanceId: command.modelSelection.instanceId,
          modelSelection: command.modelSelection,
          title: taskTitle,
          now,
          createdBy: command.createdBy,
          creationSource: command.creationSource,
        }),
        runtimeMode: command.runtimeMode,
        interactionMode: command.interactionMode,
        ...(command.workspaceStrategy === undefined ? {} : { branch: null, worktreePath: null }),
      };
      const task: OrchestrationV2Subagent = {
        id: taskNodeId,
        threadId: command.parentThreadId,
        runId: parentRun.id,
        parentNodeId: command.parentNodeId,
        origin: "app_owned",
        createdBy: command.createdBy,
        driver: targetAdapter.driver,
        providerInstanceId: command.modelSelection.instanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: command.task,
        title: command.title ?? null,
        model: command.modelSelection.model,
        modelSelection: command.modelSelection,
        ...(command.completionWake === undefined ? {} : { completionWake: command.completionWake }),
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
      const taskNode: OrchestrationV2ExecutionNode = {
        id: taskNodeId,
        threadId: command.parentThreadId,
        runId: parentRun.id,
        parentNodeId: command.parentNodeId,
        rootNodeId: parentRun.rootNodeId,
        kind: "subagent",
        status: "running",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const parentProviderTurn = providerTurnForRun(parentProjection, parentRun);
      const taskTurnItem: OrchestrationV2TurnItem = {
        id: taskTurnItemId,
        threadId: command.parentThreadId,
        runId: parentRun.id,
        nodeId: taskNodeId,
        providerThreadId: parentRun.providerThreadId,
        providerTurnId: parentProviderTurn?.id ?? null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: yield* nextTurnItemOrdinal(parentProjection),
        status: "running",
        title: command.title ?? taskTitle,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "subagent",
        subagentId: taskNodeId,
        origin: "app_owned",
        driver: targetAdapter.driver,
        providerInstanceId: command.modelSelection.instanceId,
        childThreadId,
        prompt: command.task,
        result: null,
      };
      const emitEvent = emit(events, command);

      yield* emitEvent({
        type: "thread.created",
        threadId: childThreadId,
        driver: targetAdapter.driver,
        providerInstanceId: command.modelSelection.instanceId,
        occurredAt: now,
        payload: childThread,
      });
      yield* emitEvent({
        type: "node.updated",
        threadId: command.parentThreadId,
        runId: parentRun.id,
        nodeId: taskNodeId,
        driver: targetAdapter.driver,
        providerInstanceId: command.modelSelection.instanceId,
        occurredAt: now,
        payload: taskNode,
      });
      yield* emitEvent({
        type: "subagent.updated",
        threadId: command.parentThreadId,
        runId: parentRun.id,
        nodeId: taskNodeId,
        driver: targetAdapter.driver,
        providerInstanceId: command.modelSelection.instanceId,
        occurredAt: now,
        payload: task,
      });
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.parentThreadId,
        runId: parentRun.id,
        nodeId: taskNodeId,
        driver: targetAdapter.driver,
        providerInstanceId: command.modelSelection.instanceId,
        occurredAt: now,
        payload: taskTurnItem,
      });

      const childMessageCommand = {
        type: "message.dispatch",
        createdBy: command.createdBy,
        creationSource: command.creationSource,
        commandId: command.commandId,
        threadId: childThreadId,
        senderThreadId: command.parentThreadId,
        messageId: childMessageId,
        text: command.task,
        attachments: [],
        modelSelection: command.modelSelection,
        dispatchMode:
          command.workspaceStrategy === undefined
            ? { type: "start_immediately" }
            : { type: "defer_start", workspaceStrategy: command.workspaceStrategy },
      } satisfies Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
      yield* callbacks.dispatchMessage(childMessageCommand, events, effects);

      const childProjection = yield* getProjectionWithPendingEvents(childThreadId, events);
      const childRun = childProjection.runs[0];
      if (childRun === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Delegated child thread ${childThreadId} did not create a run.`,
        });
      }
      const spawnTransferId = yield* mapDispatchError(command)(
        idAllocator.allocate.contextTransfer({
          sourceThreadId: command.parentThreadId,
          targetThreadId: childThreadId,
          type: "subagent_spawn",
        }),
      );
      const spawnTransfer: OrchestrationV2ContextTransfer = {
        id: spawnTransferId,
        type: "subagent_spawn",
        sourceThreadId: command.parentThreadId,
        targetThreadId: childThreadId,
        sourcePoint: {
          ...contextSourcePointForRun(parentProjection, parentRun),
          turnItemId: taskTurnItemId,
        },
        basePoint: null,
        sourceProviderInstanceId: parentRun.providerInstanceId,
        targetProviderInstanceId: command.modelSelection.instanceId,
        targetRunId: childRun.id,
        status: "consumed",
        resolution: null,
        createdBy: command.createdBy,
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: now,
      };
      yield* emitEvent({
        type: "context-transfer.created",
        threadId: childThreadId,
        runId: childRun.id,
        providerInstanceId: command.modelSelection.instanceId,
        occurredAt: now,
        payload: spawnTransfer,
      });
    },
  );

  const recordSubagentFollowup = Effect.fnUntraced(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    if (!mayStartSubagentFollowup(command)) return;
    const pending = yield* Ref.get(events);
    const message = pending
      .flatMap((event) =>
        event.type === "message.updated" && event.payload.id === command.messageId
          ? [event.payload]
          : [],
      )
      .at(-1);
    if (message?.runId == null) return;
    // Only new attempts can own tasks; steers join an existing snapshot that cannot settle newly bound tasks.
    const startsAttempt = pending.some(
      (event) =>
        (event.type === "run.created" && event.payload.id === message.runId) ||
        (event.type === "run-attempt.created" && event.payload.runId === message.runId),
    );
    if (!startsAttempt) return;
    const child = yield* projectionStore.getThread(command.threadId);
    const parentThreadId = child.lineage.parentThreadId;
    // A send with no sender thread comes from a client acting for the owner, like a user send.
    if (
      child.lineage.relationshipToParent !== "subagent" ||
      parentThreadId === null ||
      (command.notification === undefined &&
        command.createdBy !== "user" &&
        command.usageLimitContinuationOfRunId === undefined &&
        command.senderThreadId !== undefined &&
        command.senderThreadId !== parentThreadId)
    )
      return;
    const run =
      pending
        .flatMap((event) =>
          (event.type === "run.created" || event.type === "run.updated") &&
          event.payload.id === message.runId
            ? [event.payload]
            : [],
        )
        .at(-1) ??
      (yield* projectionStore.getThreadRecords(command.threadId, ["runs"])).runs.find(
        (row) => row.id === message.runId,
      );
    if (run === undefined || run.delegatedTaskId !== undefined) return;
    // A wake continues the latest follow-up while it is open, as it continues the original task.
    const latestFollowupId =
      command.notification === undefined
        ? undefined
        : (yield* projectionStore
            .getThreadRecords(command.threadId, ["runs"])
            .pipe(mapDispatchError(command))).runs
            .filter((row) => row.id !== run.id && row.delegatedTaskId !== undefined)
            .toSorted((a, b) => b.ordinal - a.ordinal)[0]?.delegatedTaskId;
    const parent = yield* projectionStore
      .getThreadRecords(parentThreadId, ["runs", "subagents"], {
        // Every run followUpOwnerRun can pick, so a long parent's history stays unread.
        runStatuses: ["preparing", "starting", "running", "waiting"],
        includeLatestExecutedRun: true,
        subagentIds: [
          ...(child.forkedFrom?.type === "node" ? [child.forkedFrom.nodeId] : []),
          ...(latestFollowupId === undefined ? [] : [latestFollowupId]),
        ],
      })
      .pipe(mapDispatchError(command));
    const original = parent.subagents.find(
      (task) =>
        task.origin === "app_owned" &&
        task.childThreadId === child.id &&
        task.id === (child.forkedFrom?.type === "node" ? child.forkedFrom.nodeId : undefined),
    );
    if (original === undefined || original.result === null) return;
    const openFollowup = parent.subagents.find(
      (task) =>
        task.id === latestFollowupId &&
        task.origin === "app_owned" &&
        task.childThreadId === child.id &&
        task.cancelledRunId === undefined &&
        task.result === null,
    );
    if (openFollowup !== undefined) {
      yield* emit(
        events,
        command,
      )({
        type: "run.updated",
        threadId: child.id,
        runId: run.id,
        occurredAt: message.createdAt,
        payload: { ...run, delegatedTaskId: openFollowup.id },
      });
      return;
    }
    const owner = followUpOwnerRun(parent.runs);
    if (owner === null || owner.rootNodeId === null) return;
    const ownerRecords = yield* projectionStore
      .getRunProviderRecords(parentThreadId, owner.id, owner.rootNodeId)
      .pipe(mapDispatchError(command));
    const now = message.createdAt;
    const adapter = yield* providerAdapters.get(run.providerInstanceId);
    const taskId = idAllocator.derive.delegatedTaskNode({ commandId: command.commandId });
    const task: OrchestrationV2Subagent = {
      ...original,
      createdBy: command.createdBy,
      driver: adapter.driver,
      id: taskId,
      runId: owner.id,
      parentNodeId: owner.rootNodeId,
      providerInstanceId: run.providerInstanceId,
      providerThreadId: run.providerThreadId,
      model: run.modelSelection.model,
      modelSelection: run.modelSelection,
      prompt: command.text,
      title: child.title,
      completionWake: "always",
      completionDelivery: { state: "pending", observedByRunId: null },
      status: run.status === "queued" ? (run.queueHeld === true ? "idle" : "pending") : "running",
      progress: undefined,
      cancelledRunId: undefined,
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };
    const node: OrchestrationV2ExecutionNode = {
      id: taskId,
      threadId: parentThreadId,
      runId: owner.id,
      parentNodeId: owner.rootNodeId,
      rootNodeId: owner.rootNodeId,
      kind: "subagent",
      status: task.status,
      countsForRun: false,
      providerThreadId: run.providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    const turnItem: OrchestrationV2TurnItem = {
      id: idAllocator.derive.delegatedTaskTurnItem({ commandId: command.commandId }),
      threadId: parentThreadId,
      runId: owner.id,
      nodeId: taskId,
      providerThreadId: owner.providerThreadId,
      providerTurnId: providerTurnForRun(ownerRecords, owner)?.id ?? null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: yield* nextTurnItemOrdinal(parent),
      status: task.status,
      title: child.title,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "subagent",
      subagentId: taskId,
      origin: "app_owned",
      driver: task.driver,
      providerInstanceId: task.providerInstanceId,
      childThreadId: child.id,
      prompt: command.text,
      result: null,
    };
    const emitEvent = emit(events, command);
    yield* emitEvent({
      type: "run.updated",
      threadId: child.id,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, delegatedTaskId: taskId },
    });
    yield* emitEvent({
      type: "node.updated",
      threadId: parentThreadId,
      runId: owner.id,
      nodeId: taskId,
      occurredAt: now,
      payload: node,
    });
    yield* emitEvent({
      type: "subagent.updated",
      threadId: parentThreadId,
      runId: owner.id,
      nodeId: taskId,
      occurredAt: now,
      payload: task,
    });
    yield* emitEvent({
      type: "turn-item.updated",
      threadId: parentThreadId,
      runId: owner.id,
      nodeId: taskId,
      occurredAt: now,
      payload: turnItem,
    });
  });

  /**
   * Records a task that runs in a linked environment on its parent: the
   * task, its node and its turn item, as a local delegation does, but no child
   * thread here. The parent's own checks are the local request's.
   */
  const dispatchRemoteDelegatedTaskRequest = Effect.fn(
    "orchestrationV2.dispatch.remoteDelegatedTaskRequest",
  )(function* (
    command: Extract<
      OrchestrationV2InternalCommand,
      { readonly type: "delegated_task.remote.request" }
    >,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const parentProjection = yield* projectionStore
      .getThreadRecords(command.parentThreadId, ["runs", "providerTurns", "attempts", "subagents"])
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.parentThreadId, cause }),
        ),
      );
    const parentRun = parentProjection.runs.find(
      (candidate) => candidate.id === command.parentRunId,
    );
    // A follow-up to a finished task there binds as one to a child here does.
    const followsUp = parentProjection.subagents.some(
      (task) =>
        task.result !== null &&
        task.remoteChild?.environmentId === command.remoteChild.environmentId &&
        task.remoteChild.threadId === command.remoteChild.threadId,
    );
    if (
      parentRun === undefined ||
      (followsUp
        ? parentRun.id !== followUpOwnerRun(parentProjection.runs)?.id
        : !isActiveRun(parentRun)) ||
      parentRun.rootNodeId === null
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Parent run ${command.parentRunId} is not active.`,
      });
    }
    if (yield* stopReachedRun(command, command.parentThreadId, parentRun.id)) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Parent run ${command.parentRunId} is stopping.`,
      });
    }
    const now = yield* DateTime.now;
    const taskNodeId = idAllocator.derive.delegatedTaskNode({ commandId: command.commandId });
    const taskTurnItemId = idAllocator.derive.delegatedTaskTurnItem({
      commandId: command.commandId,
    });
    const taskTitle = subagentThreadTitle({
      parentTitle: parentProjection.thread.title,
      prompt: command.task,
      ...(command.title === undefined ? {} : { title: command.title }),
      ordinal: (yield* subagentCount(command.parentThreadId)) + 1,
    });
    const common = {
      threadId: command.parentThreadId,
      runId: parentRun.id,
      nodeId: taskNodeId,
      driver: command.driver,
      providerInstanceId: command.modelSelection.instanceId,
      occurredAt: now,
    };
    const emitEvent = emit(events, command);
    yield* emitEvent({
      ...common,
      type: "node.updated",
      payload: {
        id: taskNodeId,
        threadId: command.parentThreadId,
        runId: parentRun.id,
        parentNodeId: command.parentNodeId,
        rootNodeId: parentRun.rootNodeId,
        kind: "subagent",
        status: "running",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    });
    yield* emitEvent({
      ...common,
      type: "subagent.updated",
      payload: {
        id: taskNodeId,
        threadId: command.parentThreadId,
        runId: parentRun.id,
        parentNodeId: command.parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: command.driver,
        providerInstanceId: command.modelSelection.instanceId,
        providerThreadId: null,
        childThreadId: null,
        remoteChild: command.remoteChild,
        nativeTaskRef: null,
        prompt: command.task,
        title: command.title ?? null,
        model: command.modelSelection.model,
        modelSelection: command.modelSelection,
        ...(command.completionWake === undefined ? {} : { completionWake: command.completionWake }),
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    });
    yield* emitEvent({
      ...common,
      type: "turn-item.updated",
      payload: {
        id: taskTurnItemId,
        threadId: command.parentThreadId,
        runId: parentRun.id,
        nodeId: taskNodeId,
        providerThreadId: parentRun.providerThreadId,
        providerTurnId: providerTurnForRun(parentProjection, parentRun)?.id ?? null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: yield* nextTurnItemOrdinal(parentProjection),
        status: "running",
        title: command.title ?? taskTitle,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "subagent",
        subagentId: taskNodeId,
        origin: "app_owned",
        driver: command.driver,
        providerInstanceId: command.modelSelection.instanceId,
        childThreadId: null,
        remoteChild: command.remoteChild,
        prompt: command.task,
        result: null,
      },
    });
  });

  const emitRemoteStopOwed = Effect.fn("orchestrationV2.dispatch.remoteStopOwed")(function* (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: Extract<
      OrchestrationV2InternalCommand,
      { readonly type: "delegated_task.remote.complete" | "delegated_task.remote.stop" }
    >,
    task: OrchestrationV2Subagent,
    remoteChild: OrchestrationV2RemoteTaskChild,
  ) {
    const now = yield* DateTime.now;
    yield* emit(
      events,
      command,
    )({
      type: "subagent.updated",
      threadId: command.parentThreadId,
      ...(task.runId === null ? {} : { runId: task.runId }),
      nodeId: task.id,
      driver: task.driver,
      occurredAt: now,
      payload: {
        ...task,
        remoteChild: {
          ...remoteChild,
          stoppedThere: false,
          stopCount: (remoteChild.stopCount ?? 0) + 1,
        },
        updatedAt: now,
      },
    });
  });

  /**
   * Completes a task that ran in a linked environment: the parent half of
   * `finalizeAppOwnedSubagent`, with the result its thread there ended with.
   * It runs under the parent's lock, so it never interleaves with a wake
   * policy change or a delivery on the same task.
   */
  const dispatchRemoteDelegatedTaskComplete = Effect.fn(
    "orchestrationV2.dispatch.remoteDelegatedTaskComplete",
  )(function* (
    command: Extract<
      OrchestrationV2InternalCommand,
      { readonly type: "delegated_task.remote.complete" }
    >,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    // Delivery planning reads only this task and the undelivered tasks of the queued delivery;
    // the task's own node and turn item are all it updates besides.
    const parentProjection = yield* projectionStore
      .getThreadRecords(
        command.parentThreadId,
        ["runs", "messages", "subagents", "providerTurns", "nodes", "turnItems"],
        {
          turnItemTypes: ["subagent"],
          messageRoles: ["user"],
          omitSettledSubagents: { except: [command.taskId] },
          nodeIds: [command.taskId],
          turnItemNodeIds: [command.taskId],
        },
      )
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.parentThreadId, cause }),
        ),
      );
    const task = parentProjection.subagents.find(
      (candidate) =>
        candidate.id === command.taskId &&
        candidate.origin === "app_owned" &&
        candidate.remoteChild !== undefined,
    );
    if (task === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Delegated task ${command.taskId} is not a remote task of thread ${command.parentThreadId}.`,
      });
    }
    if (
      command.stoppedThere === "stopped" &&
      (command.stopCount ?? 0) !== (task.remoteChild?.stopCount ?? 0)
    )
      return;
    const remoteChild =
      command.stoppedThere === undefined
        ? task.remoteChild
        : { ...task.remoteChild!, stoppedThere: true };
    // The first result stands; a repeated follower report records nothing, which
    // the dispatcher refuses. A stop there after the result is still recorded, but
    // a run that ended by itself does not settle a stop the task here still owes.
    if (task.result !== null) {
      // A Stop or cancel here that lost the race to the result still owes its stop.
      if (command.stoppedThere === undefined) {
        return yield* emitRemoteStopOwed(events, command, task, task.remoteChild!);
      }
      const owesStop =
        task.status === "cancelled" ||
        task.status === "interrupted" ||
        task.remoteChild?.stoppedThere === false;
      if (
        task.remoteChild?.stoppedThere === true ||
        (owesStop && command.stoppedThere !== "stopped")
      )
        return;
      const now = yield* DateTime.now;
      yield* emit(
        events,
        command,
      )({
        type: "subagent.updated",
        threadId: command.parentThreadId,
        ...(task.runId === null ? {} : { runId: task.runId }),
        nodeId: task.id,
        driver: task.driver,
        occurredAt: now,
        payload: { ...task, remoteChild, updatedAt: now },
      });
      return;
    }
    const now = yield* DateTime.now;
    const updatedTask: OrchestrationV2Subagent = {
      ...task,
      remoteChild,
      status: command.status,
      result: command.result,
      ...(command.executedModel === undefined ? {} : { executedModel: command.executedModel }),
      completedAt: now,
      updatedAt: now,
    };
    const parentRun =
      task.runId === null
        ? undefined
        : parentProjection.runs.find((candidate) => candidate.id === task.runId);
    const plan = yield* planDelegatedCompletionDelivery({
      parentProjection,
      parentRun,
      task,
      updatedTask,
      now,
    }).pipe(mapDispatchError(command));
    const emitEvent = emit(events, command);
    yield* emitEvent({
      type: "subagent.updated",
      threadId: command.parentThreadId,
      ...(task.runId === null ? {} : { runId: task.runId }),
      nodeId: task.id,
      driver: task.driver,
      occurredAt: now,
      payload: plan.task,
    });
    for (const event of delegatedCompletionPlanEvents(
      command.parentThreadId,
      plan,
      parentProjection.thread.providerInstanceId,
      now,
    )) {
      yield* emitEvent(event);
    }
    const node = parentProjection.nodes.find((candidate) => candidate.id === task.id);
    if (node !== undefined) {
      yield* emitEvent({
        type: "node.updated",
        threadId: command.parentThreadId,
        ...(node.runId === null ? {} : { runId: node.runId }),
        nodeId: node.id,
        driver: task.driver,
        occurredAt: now,
        payload: { ...node, status: command.status, completedAt: now },
      });
    }
    const item = parentProjection.turnItems.find(
      (candidate) => candidate.type === "subagent" && candidate.subagentId === task.id,
    );
    if (item !== undefined) {
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.parentThreadId,
        ...(item.runId === null ? {} : { runId: item.runId }),
        ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
        driver: task.driver,
        occurredAt: now,
        payload: {
          ...item,
          status: command.status,
          result: command.result,
          completedAt: now,
          updatedAt: now,
        } as OrchestrationV2TurnItem,
      });
    }
  });

  /**
   * Owes a stop to the thread there of a remote task that already has its
   * result. Only `remoteChild.stoppedThere` changes, so the result and its
   * delivery stand; the follower sends the stop and clears it.
   */
  const dispatchRemoteDelegatedTaskStop = Effect.fn(
    "orchestrationV2.dispatch.remoteDelegatedTaskStop",
  )(function* (
    command: Extract<
      OrchestrationV2InternalCommand,
      { readonly type: "delegated_task.remote.stop" }
    >,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const { subagents } = yield* projectionStore
      .getThreadRecords(command.parentThreadId, ["subagents"])
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.parentThreadId, cause }),
        ),
      );
    const task = subagents.find(
      (candidate) =>
        candidate.id === command.taskId &&
        candidate.origin === "app_owned" &&
        candidate.remoteChild !== undefined &&
        candidate.result !== null,
    );
    if (task?.remoteChild === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Delegated task ${command.taskId} is not a finished remote task of thread ${command.parentThreadId}.`,
      });
    }
    yield* emitRemoteStopOwed(events, command, task, task.remoteChild);
  });

  // After blocking waits time out, enable later completions to wake the parent.
  // Hold the parent dispatch lock shared with finalization to serialize full-row writes.
  const dispatchDelegatedTaskWakePolicy = Effect.fn(
    "orchestrationV2.dispatch.delegatedTaskWakePolicy",
  )(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "delegated_task.wake-policy" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    // Delivery planning reads only this task and the undelivered tasks of the queued delivery.
    const parentProjection = yield* projectionStore
      .getThreadRecords(
        command.parentThreadId,
        ["subagents", "runs", "messages", "providerTurns"],
        {
          omitSettledSubagents: { except: [command.taskId] },
        },
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProjectionError({
              threadId: command.parentThreadId,
              cause,
            }),
        ),
      );
    const task = parentProjection.subagents.find(
      (candidate) => candidate.id === command.taskId && candidate.origin === "app_owned",
    );
    if (task === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Delegated task ${command.taskId} is not an app-owned task of thread ${command.parentThreadId}.`,
      });
    }
    if (task.completionWake === command.completionWake) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Delegated task ${command.taskId} already wakes the parent with completionWake ${command.completionWake}.`,
      });
    }
    const now = yield* DateTime.now;
    const emitEvent = emit(events, command);
    const updatedTask: OrchestrationV2Subagent = {
      ...task,
      completionWake: command.completionWake,
      updatedAt: now,
    };
    // Finalization already offered for ended parent runs; another offer would duplicate the wake.
    const parentRun =
      task.runId === null
        ? undefined
        : parentProjection.runs.find((candidate) => candidate.id === task.runId);
    const completionPlan =
      command.completionWake === "always" &&
      isTerminalDelegatedTaskStatus(task.status) &&
      parentRun !== undefined &&
      hasLiveRun({ runs: [parentRun] })
        ? yield* planDelegatedCompletionDelivery({
            parentProjection,
            parentRun,
            task: updatedTask,
            updatedTask,
            now,
          })
        : undefined;
    yield* emitEvent({
      type: "subagent.updated",
      threadId: command.parentThreadId,
      ...(task.runId === null ? {} : { runId: task.runId }),
      nodeId: task.id,
      driver: task.driver,
      providerInstanceId: task.providerInstanceId,
      occurredAt: now,
      payload: completionPlan?.task ?? updatedTask,
    });
    if (completionPlan === undefined) {
      return;
    }
    if (completionPlan.parentRun !== undefined) {
      yield* emitEvent({
        type: "run.updated",
        threadId: command.parentThreadId,
        runId: completionPlan.parentRun.id,
        ...(completionPlan.parentRun.rootNodeId === null
          ? {}
          : { nodeId: completionPlan.parentRun.rootNodeId }),
        providerInstanceId: completionPlan.parentRun.providerInstanceId,
        occurredAt: now,
        payload: completionPlan.parentRun,
      });
    }
    if (completionPlan.message !== undefined) {
      yield* emitEvent({
        type: "message.updated",
        threadId: command.parentThreadId,
        ...(completionPlan.message.runId === null ? {} : { runId: completionPlan.message.runId }),
        ...(completionPlan.message.nodeId === null
          ? {}
          : { nodeId: completionPlan.message.nodeId }),
        providerInstanceId:
          completionPlan.parentRun?.providerInstanceId ??
          parentProjection.thread.providerInstanceId,
        occurredAt: now,
        payload: completionPlan.message,
      });
    }
    return completionPlan.parentRun?.id;
  });

  const dispatchCreatedThreadRecord = Effect.fn("orchestrationV2.dispatch.createdThreadRecord")(
    function* (
      command: Extract<OrchestrationV2Command, { readonly type: "thread.created.record" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    ) {
      const parentProjection = yield* projectionStore
        .getThreadRecords(
          command.parentThreadId,
          ["runs", "nodes", "turnItems", "attempts", "providerTurns"],
          { turnItemTypes: [], messageRoles: ["user"] },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProjectionError({
                threadId: command.parentThreadId,
                cause,
              }),
          ),
        );
      const targetProjection = yield* projectionStore
        .getThreadRecords(
          command.targetThreadId,
          ["runs", "nodes", "turnItems", "attempts", "providerTurns"],
          { turnItemTypes: [], messageRoles: ["user"] },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProjectionError({
                threadId: command.targetThreadId,
                cause,
              }),
          ),
        );
      const parentRun = parentProjection.runs.find(
        (candidate) => candidate.id === command.parentRunId,
      );
      const parentNode = parentProjection.nodes.find(
        (candidate) => candidate.id === command.parentNodeId,
      );
      if (
        parentRun === undefined ||
        parentNode === undefined ||
        parentNode.runId !== command.parentRunId ||
        parentRun.rootNodeId !== command.parentNodeId
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Parent node ${command.parentNodeId} is not the root of run ${command.parentRunId}.`,
        });
      }
      if (parentProjection.thread.projectId !== targetProjection.thread.projectId) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Target thread ${command.targetThreadId} belongs to another project.`,
        });
      }
      if (
        command.targetRunId !== null &&
        !targetProjection.runs.some((candidate) => candidate.id === command.targetRunId)
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Target run ${command.targetRunId} does not belong to thread ${command.targetThreadId}.`,
        });
      }

      const now = yield* DateTime.now;
      const parentProviderTurn = providerTurnForRun(parentProjection, parentRun);
      const turnItem: OrchestrationV2TurnItem = {
        id: idAllocator.derive.createdThreadTurnItem({ commandId: command.commandId }),
        threadId: command.parentThreadId,
        runId: command.parentRunId,
        nodeId: command.parentNodeId,
        providerThreadId: parentRun.providerThreadId,
        providerTurnId: parentProviderTurn?.id ?? null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: yield* nextTurnItemOrdinal(parentProjection),
        status: "completed",
        title: targetProjection.thread.title,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "thread_created",
        targetThreadId: command.targetThreadId,
        targetRunId: command.targetRunId,
        targetProviderInstanceId: targetProjection.thread.modelSelection.instanceId,
        targetModel: targetProjection.thread.modelSelection.model,
      };

      yield* emit(
        events,
        command,
      )({
        type: "turn-item.updated",
        threadId: command.parentThreadId,
        runId: command.parentRunId,
        nodeId: command.parentNodeId,
        providerInstanceId: parentRun.providerInstanceId,
        occurredAt: now,
        payload: turnItem,
      });
    },
  );

  /** Writes a parent's app-owned task, and sets its node and turn items to the task's status. */
  const writeAppOwnedTask = Effect.fn("Orchestrator.writeAppOwnedTask")(function* (input: {
    readonly command: Extract<
      OrchestrationV2ServerCommand,
      { readonly type: "run.interrupt" | "thread.stop" | "subagent.stop" }
    >;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly task: OrchestrationV2Subagent;
    readonly nodes: ReadonlyArray<OrchestrationV2ExecutionNode>;
    readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly now: DateTime.Utc;
  }) {
    const { command, task, now } = input;
    const emitEvent = emit(input.events, command);
    yield* emitEvent({
      type: "subagent.updated",
      threadId: command.threadId,
      nodeId: task.id,
      occurredAt: now,
      payload: task,
    });
    const node = input.nodes.find((candidate) => candidate.id === task.id);
    if (node !== undefined)
      yield* emitEvent({
        type: "node.updated",
        threadId: command.threadId,
        nodeId: node.id,
        occurredAt: now,
        payload: { ...node, status: task.status, completedAt: task.completedAt },
      });
    for (const item of input.turnItems) {
      if (item.type !== "subagent" || item.subagentId !== task.id) continue;
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        nodeId: task.id,
        occurredAt: now,
        payload: { ...item, status: task.status, completedAt: task.completedAt, updatedAt: now },
      });
    }
  });

  const cancelIdleOrphans = Effect.fn("Orchestrator.cancelIdleOrphans")(
    function* (input: {
      readonly command: Extract<
        OrchestrationV2ServerCommand,
        { readonly type: "run.interrupt" | "thread.stop" }
      >;
      readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
      readonly projection: Pick<OrchestrationV2ThreadProjection, "subagents" | "turnItems">;
    }) {
      const { command, events, projection } = input;
      const pending = yield* Ref.get(events);
      const children = new Map<
        ThreadId,
        ProjectionRecords<"runs" | "providerThreads" | "runtimeRequests" | "turnItems"> | null
      >();
      const idleChildren = new Map<ThreadId, boolean>();
      let nodes: ReadonlyArray<OrchestrationV2ExecutionNode> | undefined;
      for (const recorded of projection.subagents) {
        const updated = pending.findLast(
          (event) => event.type === "subagent.updated" && event.payload.id === recorded.id,
        );
        const task = updated?.type === "subagent.updated" ? updated.payload : recorded;
        if (
          task.origin !== "app_owned" ||
          task.childThreadId === null ||
          !isOrchestrationV2WorkActive(task.status)
        )
          continue;
        const childThreadId = task.childThreadId;
        const child = children.has(childThreadId)
          ? (children.get(childThreadId) ?? null)
          : yield* projectionStore
              .getThreadRecords(
                childThreadId,
                ["runs", "providerThreads", "runtimeRequests", "turnItems"],
                {
                  turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
                  turnItemStatuses: ["pending", "running", "waiting"],
                },
              )
              .pipe(
                Effect.catchTags({
                  ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
                }),
                Effect.mapError(
                  (cause) => new OrchestratorProjectionError({ threadId: childThreadId, cause }),
                ),
              );
        children.set(childThreadId, child);
        if (child === null) continue;
        if (
          child.thread.lineage.parentThreadId !== command.threadId ||
          child.thread.lineage.relationshipToParent !== "subagent" ||
          (child.thread.forkedFrom?.type === "node" &&
            child.thread.forkedFrom.nodeId === task.id) ||
          child.runs.some((run) => run.delegatedTaskId === task.id)
        )
          continue;
        const idle =
          idleChildren.get(task.childThreadId) ??
          (!child.runs.some((run) => run.status === "queued" || isActiveRun(run)) &&
            !child.providerThreads.some(
              (thread) =>
                thread.status === "active" || (thread.pendingBackgroundTasks?.length ?? 0) > 0,
            ) &&
            !child.runtimeRequests.some((request) => request.status === "pending") &&
            child.turnItems.length === 0 &&
            Option.isNone(yield* Effect.findFirst(child.runs, awaitsRestartContinuation)));
        idleChildren.set(task.childThreadId, idle);
        if (!idle) continue;
        // Stop can cancel an idle orphan without guessing which completed run owned its result.
        const now = yield* DateTime.now;
        nodes ??= (yield* projectionStore.getThreadRecords(command.threadId, ["nodes"])).nodes;
        yield* writeAppOwnedTask({
          command,
          events,
          task: cancelledAppOwnedTask(task, now),
          nodes,
          turnItems: projection.turnItems,
          now,
        });
      }
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isOrchestratorProjectionError(cause)
            ? cause
            : new OrchestratorProjectionError({ threadId: input.command.threadId, cause }),
        ),
      ),
  );

  /**
   * Thread lineage and fork origin are immutable, so this
   * is safe to read without holding either thread's dispatch lock.
   */
  const appOwnedSubagentParentThreadId = Effect.fn("Orchestrator.appOwnedSubagentParentThreadId")(
    function* (childThreadId: ThreadId) {
      const childThread = yield* projectionStore.getThread(childThreadId);
      const lineage = childThread.lineage;
      return lineage.relationshipToParent === "subagent" &&
        lineage.parentThreadId !== null &&
        childThread.forkedFrom?.type === "node"
        ? lineage.parentThreadId
        : undefined;
    },
  );

  const readAllDelegatedChildControls = (childThreadId: ThreadId) =>
    projectionStore.getThreadRecords(
      childThreadId,
      ["runs", "messages", "subagents", "providerThreads"],
      { messageRoles: ["user"], delegatedTaskMessagesOnly: true },
    );

  const readDelegatedChildControls = Effect.fn("Orchestrator.readDelegatedChildControls")(
    function* (childThreadId: ThreadId, taskIds: ReadonlyArray<NodeId>) {
      // Progress tells a held wake from a held message the user wrote by the run's message.
      const withHeldMessages = Effect.fn("Orchestrator.readHeldRunMessages")(function* <
        A extends Omit<DelegatedChildControls, "runsFloor">,
      >(read: A) {
        const heldRunIds = read.runs.flatMap((run) =>
          run.status === "queued" && run.queueHeld === true ? [run.id] : [],
        );
        if (heldRunIds.length === 0) return read;
        const { messages } = yield* projectionStore.getThreadRecords(childThreadId, ["messages"], {
          messageRoles: ["user"],
          messageRunIds: heldRunIds,
        });
        return { ...read, messages: [...read.messages, ...messages] };
      });
      const controls: DelegatedChildControls = yield* withHeldMessages(
        yield* projectionStore.getDelegatedChildControls(childThreadId, {
          taskIds,
          windowSize: DELEGATED_CHILD_RUN_WINDOW,
        }),
      );
      const progress = delegatedTaskProgress(controls);
      // The latest result may have ended before the runs read above; then read them all.
      if (
        controls.runsFloor !== undefined &&
        (progress.resultRun === undefined || !ranSince(progress.resultRun, controls.runsFloor))
      ) {
        const all = yield* withHeldMessages(yield* readAllDelegatedChildControls(childThreadId));
        return { controls: all, progress: delegatedTaskProgress(all) };
      }
      return { controls, progress };
    },
  );

  // A finished delegate otherwise keeps its provider process until the idle timeout. Callers hold
  // the parent lock; the child lock orders this after any follow-up that started a run meanwhile.
  const releaseFinishedDelegateSessions = Effect.fn("Orchestrator.releaseFinishedDelegateSessions")(
    function* (childThreadId: ThreadId, resultRunId: RunId, taskId: NodeId) {
      yield* threadDispatch.withLock(
        childThreadId,
        Effect.gen(function* () {
          const { controls: child, progress } = yield* readDelegatedChildControls(childThreadId, [
            taskId,
          ]);
          // Unawaited background tasks still allow a result but die with the process; the idle
          // timer keeps their process pinned.
          if (
            progress.state !== "result_available" ||
            child.providerThreads.some((thread) => (thread.pendingBackgroundTasks ?? []).length > 0)
          )
            return;
          const { providerSessions } = yield* projectionStore.getThreadRecords(childThreadId, [
            "providerSessions",
          ]);
          for (const session of providerSessions) {
            // Shared processes unload their threads themselves; only a per-thread process lingers.
            if (
              session.status === "stopped" ||
              session.status === "error" ||
              session.capabilities.sessions.supportsMultipleProviderThreadsPerSession
            )
              continue;
            yield* callbacks.dispatchWithReceiptEffect({
              type: "provider-session.detach",
              commandId: CommandId.make(
                `command:system:delegated-task-release:${resultRunId}:${session.id}`,
              ),
              threadId: childThreadId,
              providerSessionId: session.id,
              reason: "Delegated task finished.",
            });
          }
        }),
      );
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to release a finished delegate's provider session", { cause }),
    ),
  );

  /**
   * Callers must hold the parent thread's dispatch lock: wake-policy updates the same
   * subagent row with full-row payloads, so unserialized writers clobber policy or terminal status.
   */
  const finalizeAppOwnedSubagentTask = Effect.fn("Orchestrator.finalizeAppOwnedSubagentTask")(
    function* (
      childControls: DelegatedChildControls,
      options: {
        readonly settledContinuationOf?: RunId;
        readonly syncRunId?: RunId;
        readonly task: OrchestrationV2Subagent;
        readonly resultRun?: OrchestrationV2Run;
      },
    ) {
      const childThreadId = childControls.thread.id;
      const forkedFrom = childControls.thread.forkedFrom;
      if (
        childControls.thread.lineage.relationshipToParent !== "subagent" ||
        childControls.thread.lineage.parentThreadId === null ||
        forkedFrom?.type !== "node"
      ) {
        return;
      }
      const taskRuns = delegatedTaskRuns(childControls, options.task.id);
      const childRun =
        taskRuns.length === 0
          ? options.task.id === forkedFrom.nodeId
            ? options.resultRun
            : undefined
          : delegatedTaskResultRun(taskRuns);
      if (childRun === undefined) return;
      let outcome = runOutcome(childRun);
      let terminalStatus = delegatedTaskTerminalStatus(outcome);
      if (terminalStatus === null) {
        if (childRun.delegatedTaskId === undefined || childRun.id !== options.syncRunId) return;
        const task = options.task;
        const status: OrchestrationV2Subagent["status"] =
          childRun.status === "queued"
            ? childRun.queueHeld === true
              ? "idle"
              : "pending"
            : childRun.status === "waiting"
              ? "waiting"
              : "running";
        if (task.result !== null || task.status === status) return;
        const parent = yield* projectionStore.getThreadRecords(
          childControls.thread.lineage.parentThreadId,
          ["nodes", "turnItems"],
          { nodeIds: [task.id], turnItemNodeIds: [task.id], turnItemTypes: ["subagent"] },
        );
        const now = yield* DateTime.now;
        const scope = {
          threadId: parent.thread.id,
          ...(task.runId === null ? {} : { runId: task.runId }),
          nodeId: task.id,
          providerInstanceId: task.providerInstanceId,
          occurredAt: now,
        };
        const node = parent.nodes.find((row) => row.id === task.id);
        const item = parent.turnItems.find(
          (row) => row.type === "subagent" && row.subagentId === task.id,
        );
        yield* writeSystemEvents([
          {
            ...scope,
            type: "subagent.updated",
            payload: { ...task, status, completedAt: null, updatedAt: now },
          },
          ...(node === undefined
            ? []
            : [
                {
                  ...scope,
                  type: "node.updated" as const,
                  payload: { ...node, status, completedAt: null },
                },
              ]),
          ...(item === undefined
            ? []
            : [
                {
                  ...scope,
                  type: "turn-item.updated" as const,
                  payload: { ...item, status, completedAt: null, updatedAt: now },
                },
              ]),
        ]);
        return;
      }
      // A follow-up ends with the work it awaits, as the original task does. A cancelled task
      // does not wait for the background work its cancel is stopping.
      if (
        delegatedTaskAwaitsWork(
          taskRuns,
          options.task.cancelledRunId === undefined
            ? childControls
            : { subagents: childControls.subagents, providerThreads: [] },
        )
      )
        return;
      if (
        yield* childAwaitsRestartContinuation(
          taskRuns.length === 0 ? childControls.runs : taskRuns,
          childRun,
          options?.settledContinuationOf,
        )
      ) {
        return;
      }

      // A run queued behind the report can end the task without saying anything.
      const reportFrom = { ...childRun, status: outcome };
      let reportRuns = delegatedTaskReportRuns(childControls, reportFrom);
      if (!reportRunsRead(childControls, reportFrom, reportRuns)) {
        reportRuns = delegatedTaskReportRuns(
          yield* readAllDelegatedChildControls(childThreadId),
          reportFrom,
        );
      }
      const resultRunIds = [childRun.id, ...reportRuns.map((run) => run.id)];
      const childResult = yield* projectionStore.getThreadRecords(
        childThreadId,
        ["messages", "turnItems", "providerTurns", "attempts"],
        {
          messageRoles: ["assistant"],
          messageRunIds: resultRunIds,
          turnItemRunIds: resultRunIds,
          turnItemTypes: [...SUBAGENT_RESULT_TURN_ITEM_TYPES, "run_interrupt_request"],
          providerTurnAttemptIds: [childRun, ...reportRuns].flatMap(
            (run) => run.activeAttemptId ?? [],
          ),
          attemptIds: childRun.activeAttemptId === null ? [] : [childRun.activeAttemptId],
        },
      );
      // A steered run's attempt can point at a provider turn that another attempt started.
      const attemptTurnId = childResult.attempts[0]?.providerTurnId;
      const steeredTurns =
        attemptTurnId == null ||
        childResult.providerTurns.some((turn) => turn.runAttemptId === childRun.activeAttemptId)
          ? []
          : (yield* projectionStore.getThreadRecords(childThreadId, ["providerTurns"], {
              providerTurnIds: [attemptTurnId],
            })).providerTurns;
      const childProjection = {
        ...childControls,
        runs: reportRuns,
        messages: childResult.messages,
        turnItems: childResult.turnItems,
        providerTurns: [...childResult.providerTurns, ...steeredTurns],
        attempts: childResult.attempts,
      };
      const parentThreadId = childControls.thread.lineage.parentThreadId;
      // The task's node and turn item share its id.
      const parentTask = yield* projectionStore.getThreadRecords(
        parentThreadId,
        ["subagents", "nodes", "turnItems"],
        {
          subagentIds: [options.task.id],
          nodeIds: [options.task.id],
          turnItemNodeIds: [options.task.id],
          turnItemTypes: ["subagent"],
        },
      );
      const task = parentTask.subagents.find(
        (candidate) =>
          candidate.id === options.task.id &&
          candidate.origin === "app_owned" &&
          candidate.childThreadId === childThreadId,
      );
      if (task === undefined) {
        return;
      }
      // A cancelled task's completed run ends it interrupted, as does one whose provider turn its
      // parent's Stop interrupted to kill background work. Stop's marker on an idle run names no
      // provider turn and interrupted nothing.
      const cancelled = task.cancelledRunId === childRun.id;
      const stopped =
        task.completionDelivery?.state === "disposed" &&
        childResult.turnItems.some(
          (item) =>
            item.runId === childRun.id &&
            item.type === "run_interrupt_request" &&
            item.providerTurnId !== null,
        );
      if ((cancelled || stopped) && terminalStatus === "completed")
        outcome = terminalStatus = "interrupted";
      // Every result the child sent is among its own transfers, far fewer than the parent's.
      const childTransfers = yield* projectionStore.getThreadRecords(childThreadId, [
        "contextTransfers",
      ]);
      const existingResultTransfer = childTransfers.contextTransfers.find(
        (transfer) =>
          transfer.type === "subagent_result" &&
          transfer.sourceThreadId === childThreadId &&
          transfer.targetThreadId === parentThreadId &&
          (transfer.sourcePoint.runId === childRun.id ||
            (options.task.id === forkedFrom.nodeId && transfer.sourcePoint.runId === undefined)),
      );
      if (existingResultTransfer !== undefined) {
        return;
      }

      const now = yield* DateTime.now;
      const result = subagentResultForRun(childProjection, { ...childRun, status: outcome });
      const { parentRun, ...parentProjection } = yield* readDelegatedCompletionPlanRecords(
        parentThreadId,
        task,
      );
      const parentNode = parentTask.nodes.find((candidate) => candidate.id === task.id);
      const parentTurnItem = parentTask.turnItems.find(
        (candidate) => candidate.type === "subagent" && candidate.subagentId === task.id,
      );
      const updatedTask: OrchestrationV2Subagent = {
        ...task,
        providerThreadId: childRun.providerThreadId,
        status: terminalStatus,
        result: result.text,
        completedAt: now,
        updatedAt: now,
        // The cancelling parent gets no wake, and the task records the run it settled from.
        ...(cancelled
          ? {
              cancelledRunId: childRun.id,
              completionDelivery: { state: "disposed" as const, observedByRunId: null },
            }
          : {}),
      };
      const completionPlan = yield* planDelegatedCompletionDelivery({
        parentProjection,
        parentRun,
        task,
        updatedTask,
        now,
      });
      const resultTransferId = yield* idAllocator.allocate.contextTransfer({
        sourceThreadId: childThreadId,
        targetThreadId: parentThreadId,
        type: "subagent_result",
      });
      const resultTransfer: OrchestrationV2ContextTransfer = {
        id: resultTransferId,
        type: "subagent_result",
        sourceThreadId: childThreadId,
        targetThreadId: parentThreadId,
        sourcePoint: {
          ...contextSourcePointForRun(childProjection, childRun),
          ...(result.turnItemId === null ? {} : { turnItemId: result.turnItemId }),
        },
        basePoint: null,
        sourceProviderInstanceId: childRun.providerInstanceId,
        targetProviderInstanceId:
          parentRun?.providerInstanceId ?? parentProjection.thread.providerInstanceId,
        targetRunId: parentRun?.id ?? null,
        status: "consumed",
        resolution: null,
        createdBy: "system",
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: now,
      };

      const completionEvents: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">> = [
        {
          type: "subagent.updated",
          threadId: parentThreadId,
          ...(task.runId === null ? {} : { runId: task.runId }),
          nodeId: task.id,
          driver: task.driver,
          occurredAt: now,
          payload: completionPlan.task,
        },
        ...delegatedCompletionPlanEvents(
          parentThreadId,
          completionPlan,
          parentProjection.thread.providerInstanceId,
          now,
        ),
        ...(parentNode === undefined
          ? []
          : [
              {
                type: "node.updated" as const,
                threadId: parentThreadId,
                ...(parentNode.runId === null ? {} : { runId: parentNode.runId }),
                nodeId: parentNode.id,
                driver: task.driver,
                occurredAt: now,
                payload: {
                  ...parentNode,
                  status: terminalStatus,
                  providerThreadId: childRun.providerThreadId,
                  completedAt: now,
                },
              },
            ]),
        ...(parentTurnItem === undefined
          ? []
          : [
              {
                type: "turn-item.updated" as const,
                threadId: parentThreadId,
                ...(parentTurnItem.runId === null ? {} : { runId: parentTurnItem.runId }),
                ...(parentTurnItem.nodeId === null ? {} : { nodeId: parentTurnItem.nodeId }),
                driver: task.driver,
                occurredAt: now,
                payload: {
                  ...parentTurnItem,
                  status: terminalStatus,
                  result: result.text,
                  completedAt: now,
                  updatedAt: now,
                },
              },
            ]),
        {
          type: "context-transfer.created",
          threadId: parentThreadId,
          ...(parentRun === undefined ? {} : { runId: parentRun.id }),
          providerInstanceId: childRun.providerInstanceId,
          occurredAt: now,
          payload: resultTransfer,
        },
      ];
      yield* writeSystemEvents(completionEvents, [], { updateDelegatedCompletionOnly: true });
      yield* releaseFinishedDelegateSessions(childThreadId, childRun.id, task.id);

      if (completionPlan.offer && completionPlan.parentRun !== undefined) {
        yield* offerDelegatedCompletionDelivery(parentThreadId, completionPlan.parentRun.id);
      }
    },
  );

  // A waiting run has ended its turn, so its task waits only on the work it left.
  const progressAfterTurn = (child: Parameters<typeof delegatedTaskProgress>[0]) =>
    delegatedTaskProgress({
      ...child,
      runs: child.runs.map((run) =>
        run.status === "waiting" ? { ...run, status: "completed" as const } : run,
      ),
    });

  const finalizeAppOwnedSubagent = Effect.fn("Orchestrator.finalizeAppOwnedSubagent")(function* (
    childThreadId: ThreadId,
    options?: { readonly settledContinuationOf?: RunId; readonly syncRunId?: RunId },
  ) {
    const child = yield* projectionStore.getThreadRecords(childThreadId, ["contextTransfers"]);
    const parentThreadId = child.thread.lineage.parentThreadId;
    const forkedFrom = child.thread.forkedFrom;
    if (
      child.thread.lineage.relationshipToParent !== "subagent" ||
      parentThreadId === null ||
      forkedFrom?.type !== "node"
    )
      return;
    // Each task of this child names it, so the parent's other tasks stay unread.
    const parent = yield* projectionStore.getThreadRecords(parentThreadId, ["subagents"], {
      subagentChildThreadIds: [childThreadId],
    });
    const resultSent = child.contextTransfers.some(
      (transfer) =>
        transfer.type === "subagent_result" &&
        transfer.sourceThreadId === childThreadId &&
        transfer.targetThreadId === parentThreadId,
    );
    const openTasks = parent.subagents.filter(
      (task) =>
        task.origin === "app_owned" &&
        task.childThreadId === childThreadId &&
        !(task.result !== null && resultSent),
    );
    const { controls: childControls, progress } = yield* readDelegatedChildControls(
      childThreadId,
      openTasks.map((task) => task.id),
    );
    const cancelAwaitsWork = progress.state === "working" && !progress.onlyAwaitsUserRun;
    for (const task of openTasks) {
      // A cancelled task does not wait for the work its cancel is stopping.
      const cancelled = task.cancelledRunId !== undefined;
      if (
        task.id === forkedFrom.nodeId &&
        (cancelled ? cancelAwaitsWork : progress.state !== "result_available")
      )
        continue;
      yield* finalizeAppOwnedSubagentTask(childControls, {
        ...options,
        task,
        ...(progress.resultRun === undefined ? {} : { resultRun: progress.resultRun }),
      });
    }

    // Only the run a cancelled task settled from ends with it. The row read above has no
    // such run yet when this call settled the task, from the same result run.
    const { resultRun } = progress;
    const resultTaskId = resultRun?.delegatedTaskId ?? forkedFrom.nodeId;
    const resultTask = parent.subagents.find((task) => task.id === resultTaskId);
    const taskCancelled =
      resultTask?.cancelledRunId !== undefined && resultTask.cancelledRunId === resultRun?.id;
    if (
      resultRun === undefined ||
      (taskCancelled ? cancelAwaitsWork : progress.state !== "result_available")
    )
      return;
    const status = delegatedTaskTerminalStatus(runOutcome(resultRun));
    if (status !== "interrupted" && status !== "cancelled" && !taskCancelled) return;
    if (
      yield* childAwaitsRestartContinuation(
        childControls.runs,
        resultRun,
        options?.settledContinuationOf,
      )
    )
      return;
    // Callers hold the parent lock; dismiss takes the child lock, as follow-up intake does.
    const { runtimeRequests } = yield* projectionStore.getThreadRecords(childThreadId, [
      "runtimeRequests",
    ]);
    const pendingQuestions = runtimeRequests.filter(
      (request) =>
        request.status === "pending" &&
        request.kind === "user_input" &&
        request.responseCapability.type === "message",
    );
    if (pendingQuestions.length === 0) return;
    const { nodes } = yield* projectionStore.getThreadRecords(childThreadId, ["nodes"]);
    const resultRunIds = new Set<RunId>();
    let run: OrchestrationV2Run | undefined = resultRun;
    while (run !== undefined && !resultRunIds.has(run.id)) {
      resultRunIds.add(run.id);
      const previousRunId: RunId | undefined = run.restartContinuationOfRunId;
      run =
        previousRunId === undefined
          ? undefined
          : (childControls.runs.find((candidate) => candidate.id === previousRunId) ??
            (yield* projectionStore.getRun(childThreadId, previousRunId)));
    }
    for (const request of pendingQuestions) {
      if (
        nodes.some(
          (node) =>
            node.id === request.nodeId && node.runId !== null && resultRunIds.has(node.runId),
        )
      ) {
        yield* callbacks
          .dispatchWithReceipt({
            type: "thread.user-input.dismiss",
            commandId: CommandId.make(`command:system:delegated-task-question:${request.id}`),
            threadId: childThreadId,
            requestId: request.id,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to dismiss task question", {
                requestId: request.id,
                cause,
              }),
            ),
          );
      }
    }
  });

  const finalizeDelegatedCompletionDelivery = Effect.fn(
    "Orchestrator.finalizeDelegatedCompletionDelivery",
  )(function* (threadId: ThreadId, runId: RunId) {
    // Ordinary turns do not own a delegated delivery. Read just their input
    // before loading the cohort state needed to settle an actual delivery.
    const message = yield* projectionStore.getRunMessage(threadId, runId);
    if (message?.delegatedCompletion === undefined) return;
    const projection = yield* projectionStore.getThreadRecords(
      threadId,
      ["runs", "messages", "subagents"],
      {
        runIds: [runId, message.delegatedCompletion.parentRunId],
        messageIds: [message.id],
        subagentRunIds: [message.delegatedCompletion.parentRunId],
      },
    );
    const deliveryRun = projection.runs.find((candidate) => candidate.id === runId);
    const deliveryMessage =
      deliveryRun === undefined
        ? undefined
        : projection.messages.find((candidate) => candidate.id === deliveryRun.userMessageId);
    const messageOwnership = deliveryMessage?.delegatedCompletion;
    if (deliveryRun === undefined || messageOwnership === undefined) {
      return;
    }
    const parentRun = projection.runs.find(
      (candidate) => candidate.id === messageOwnership.parentRunId,
    );
    const cohort = parentRun?.delegatedCompletion;
    const delivery = cohort?.delivery;
    if (
      parentRun === undefined ||
      cohort === undefined ||
      delivery === null ||
      delivery === undefined ||
      delivery.messageId !== deliveryRun.userMessageId ||
      delivery.generation !== messageOwnership.generation
    ) {
      return;
    }

    const now = yield* DateTime.now;
    const nextTaskStates = new Map<
      OrchestrationV2Subagent["id"],
      OrchestrationV2Subagent["completionDelivery"]
    >();
    for (const task of projection.subagents) {
      if (
        task.origin !== "app_owned" ||
        task.runId !== parentRun.id ||
        !delivery.taskIds.includes(task.id) ||
        task.completionDelivery?.state !== "claimed"
      ) {
        continue;
      }
      nextTaskStates.set(task.id, {
        state: deliveryRun.status === "cancelled" ? "pending" : "delivered",
        observedByRunId: null,
      });
    }
    const pendingTaskIds = projection.subagents
      .filter(
        (task) =>
          task.origin === "app_owned" &&
          task.runId === parentRun.id &&
          isTerminalDelegatedTaskStatus(task.status) &&
          (task.completionDelivery?.state === "pending" ||
            nextTaskStates.get(task.id)?.state === "pending"),
      )
      .map((task) => task.id);
    const canReserveFollowUp =
      cohort.disposition === "open" &&
      projection.thread.archivedAt === null &&
      projection.thread.deletedAt === null &&
      pendingTaskIds.length > 0;
    const nextDelivery = canReserveFollowUp
      ? {
          generation: cohort.nextGeneration,
          messageId: yield* mapDelegatedCompletionError(
            idAllocator.allocate.message({
              threadId,
              ordinal:
                (yield* mapDelegatedCompletionError(
                  projectionStore.getMessageCount(projection.thread.id),
                )) + 1,
            }),
          ),
          taskIds: pendingTaskIds,
        }
      : null;
    if (nextDelivery !== null) {
      for (const taskId of pendingTaskIds) {
        nextTaskStates.set(taskId, {
          state: "claimed",
          observedByRunId: null,
        });
      }
    }
    const updatedParentRun: OrchestrationV2Run = {
      ...parentRun,
      delegatedCompletion: {
        ...cohort,
        nextGeneration: nextDelivery === null ? cohort.nextGeneration : cohort.nextGeneration + 1,
        delivery: nextDelivery,
      },
    };
    const taskEvents = projection.subagents.flatMap((task) => {
      const completionDelivery = nextTaskStates.get(task.id);
      if (completionDelivery === undefined) {
        return [];
      }
      return [
        {
          type: "subagent.updated" as const,
          threadId,
          ...(task.runId === null ? {} : { runId: task.runId }),
          nodeId: task.id,
          driver: task.driver,
          providerInstanceId: task.providerInstanceId,
          occurredAt: now,
          payload: {
            ...task,
            completionDelivery,
            updatedAt: now,
          },
        },
      ];
    });
    yield* writeSystemEvents([
      ...taskEvents,
      {
        type: "run.updated",
        threadId,
        runId: updatedParentRun.id,
        ...(updatedParentRun.rootNodeId === null ? {} : { nodeId: updatedParentRun.rootNodeId }),
        providerInstanceId: updatedParentRun.providerInstanceId,
        occurredAt: now,
        payload: updatedParentRun,
      },
    ]);
    if (nextDelivery !== null) {
      yield* offerDelegatedCompletionDelivery(threadId, parentRun.id);
    }
  });

  const dispatchNotificationAccepted = Effect.fn("orchestrationV2.notificationAccepted")(function* (
    command: Extract<OrchestrationV2Command, { type: "notification.delivery.accept" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const projection = yield* getProjectionWithPendingEvents(command.threadId, events);
    const now = yield* DateTime.now;
    const parentRunId = yield* acceptDelegatedCompletionDelivery({
      command,
      events,
      projection,
      messageId: command.messageId,
      now,
    });
    if (parentRunId === undefined) {
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
    return parentRunId;
  });

  return {
    isUnobservedAcknowledgement,
    offerDelegatedCompletionDelivery,
    offerDelegatedCompletionDeliveries,
    offerChildTaskDeliveries,
    acceptDelegatedCompletionDelivery,
    dispatchDelegatedTaskCompletionDeliveryResolution,
    disposeDelegatedCompletionCohort,
    disposeAllDelegatedCompletionCohorts,
    dispatchDelegatedTaskRequest,
    recordSubagentFollowup,
    dispatchRemoteDelegatedTaskRequest,
    dispatchRemoteDelegatedTaskComplete,
    dispatchRemoteDelegatedTaskStop,
    dispatchDelegatedTaskWakePolicy,
    dispatchCreatedThreadRecord,
    writeAppOwnedTask,
    cancelIdleOrphans,
    appOwnedSubagentParentThreadId,
    progressAfterTurn,
    finalizeAppOwnedSubagent,
    finalizeDelegatedCompletionDelivery,
    dispatchNotificationAccepted,
  };
}
