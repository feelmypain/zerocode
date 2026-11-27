import {
  CommandId,
  isDeliveredProviderTurn,
  isRuntimeModeAbove,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Notification,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  orchestrationV2RunWorkStartedAt,
  type ProviderInstanceId,
  type ProviderSessionId,
  resolveProviderInstanceEnabled,
  type RunId,
  type ThreadId,
} from "@zerocode/contracts";
import { makeProviderFailure } from "@zerocode/provider-core/server/failure";
import { notificationTurnItem } from "@zerocode/provider-core/server/notification";
import { modelSelectionsEqual } from "@zerocode/shared/model";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@zerocode/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import {
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
} from "../../sourceControl/threadPullRequests.ts";
import { isActiveRun } from "../CommandPolicy.ts";
import { contextBoundaryOrdinal, isScheduledFreshRun } from "../contextBoundary.ts";
import { modelSwitchSince } from "../modelSwitch.ts";
import { isBufferedProviderNotification } from "../NotificationMailbox.ts";
import { combinePullRequestWatchWakes, type PullRequestWatchWake } from "../pullRequestWatch.ts";
import { queuedRunsInDeliveryOrder } from "../QueuedRunOrder.ts";
import { continuationStartRetryDelayMs } from "../RestartBackgroundNote.ts";
import {
  contextSourcePointForRun,
  followsCurrentConversation,
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  type OrchestratorShared,
  type OrchestratorV2DispatchResult,
  type OrchestratorV2Error,
  pullRequestSnapshotEndsWatch,
  queuedRunCancellationEvents,
  queuedRunModelSelection,
  usageLimitHoldsQueue,
  worktreeSetupPending,
} from "./orchestratorShared.ts";

/** Run ordinals can skip values: a queued run moves past newer runs when it starts. */
export function nextRunOrdinal(projection: Pick<OrchestrationV2ThreadProjection, "runs">): number {
  return projection.runs.reduce((max, run) => Math.max(max, run.ordinal), 0) + 1;
}

/**
 * Stamp at wake start; queued prompts lack start times and delegated results jump the queue.
 * Auto-drained agent messages continue active work; explicit queue starts reset it.
 */
export function wakeWorkStartedAt(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "subagents">,
  trigger: Pick<
    OrchestrationV2ConversationMessage,
    "createdBy" | "creationSource" | "senderThreadId"
  > & {
    readonly notification?: unknown;
    readonly delegatedCompletion?: unknown;
    readonly restartContinuationOfRunId?: RunId | undefined;
  },
  delivery: "immediate" | "automatic-queue" | "explicit-queue" = "immediate",
): Pick<OrchestrationV2Run, "workStartedAt"> {
  if (
    trigger.notification === undefined &&
    trigger.delegatedCompletion === undefined &&
    trigger.restartContinuationOfRunId === undefined &&
    !(
      trigger.createdBy === "agent" &&
      trigger.creationSource === "mcp" &&
      trigger.senderThreadId !== undefined &&
      (delivery === "automatic-queue" ||
        (delivery === "immediate" &&
          projection.subagents.some(
            (subagent) =>
              subagent.origin === "app_owned" && subagent.childThreadId === trigger.senderThreadId,
          )))
    )
  ) {
    return {};
  }
  const previous = projection.runs
    .flatMap((run) => (run.startedAt === null ? [] : [{ run, startedAt: run.startedAt }]))
    .toSorted(
      (left, right) =>
        DateTime.Order(right.startedAt, left.startedAt) || right.run.ordinal - left.run.ordinal,
    )[0]?.run;
  return previous === undefined ? {} : { workStartedAt: orchestrationV2RunWorkStartedAt(previous) };
}

function nextQueuedRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
): OrchestrationV2Run | undefined {
  return queuedRunsInDeliveryOrder(projection).find((run) => run.queueHeld !== true);
}

type MonitorPullRequestStamp = NonNullable<
  Extract<OrchestrationV2Notification["source"], { readonly kind: "monitor" }>["pullRequest"]
>;

function monitorPullRequestStamps(
  source: OrchestrationV2Notification["source"] | undefined,
): ReadonlyArray<MonitorPullRequestStamp> {
  if (source?.kind !== "monitor" || source.pullRequest === undefined) return [];
  return [source.pullRequest, ...(source.otherPullRequests ?? [])];
}

function isStalePullRequestWatchStamp(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "messages">,
  stamp: MonitorPullRequestStamp,
): boolean {
  const link = threadPullRequestsOf(projection.thread).find(
    (candidate) =>
      candidate.source !== "stack-dismissed" && threadPullRequestKeysEqual(candidate, stamp),
  );
  if (link === undefined) return true;
  if (stamp.watchEnded === true) {
    // The final notice outlives its watch, but a replacement watch supersedes it.
    const latestWatch = link.watch ?? link.endedWatch;
    return latestWatch?.startedAt !== stamp.watchStartedAt;
  }
  if (link.watch === undefined) {
    // A watch the server ended with a final notice still owes the wakes it queued before it.
    const endedWithNotice = projection.messages.some((message) =>
      monitorPullRequestStamps(message.notification?.source).some(
        (ending) =>
          ending.watchEnded === true &&
          ending.watchStartedAt === stamp.watchStartedAt &&
          threadPullRequestKeysEqual(ending, stamp),
      ),
    );
    return (
      !endedWithNotice ||
      link.endedWatch?.startedAt !== stamp.watchStartedAt ||
      pullRequestSnapshotEndsWatch(link.snapshot, stamp.watchStartedAt)
    );
  }
  return (
    link.watch.startedAt !== stamp.watchStartedAt ||
    (stamp.headSha !== null && link.watch.headSha !== stamp.headSha) ||
    pullRequestSnapshotEndsWatch(link.snapshot, link.watch.startedAt)
  );
}

function isStalePullRequestWatchWake(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "messages">,
  run: OrchestrationV2Run,
): boolean {
  const stamps = monitorPullRequestStamps(
    projection.messages.find((message) => message.id === run.userMessageId)?.notification?.source,
  );
  return (
    stamps.length > 0 && stamps.every((stamp) => isStalePullRequestWatchStamp(projection, stamp))
  );
}

function withoutSection({ section: _, ...stamp }: MonitorPullRequestStamp) {
  return stamp;
}

/**
 * A queued wake covering several pull requests, rebuilt from the ones still current, or
 * undefined when it needs no change.
 */
function currentPullRequestWatchWake(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "messages">,
  run: OrchestrationV2Run,
): OrchestrationV2ConversationMessage | undefined {
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  const stamps = monitorPullRequestStamps(message?.notification?.source);
  if (message === undefined || stamps.length < 2) return undefined;
  const current = stamps.filter((stamp) => !isStalePullRequestWatchStamp(projection, stamp));
  const [first, ...rest] = current;
  if (first === undefined || rest.length === stamps.length - 1) return undefined;
  const sections = current.flatMap(({ section }) => (section === undefined ? [] : [section]));
  if (sections.length !== current.length) return undefined;
  const wake = combinePullRequestWatchWakes(
    sections.map(({ text, outcome, summary }) => ({
      text,
      notification: { source: { kind: "monitor" }, outcome, summary },
    })) as [PullRequestWatchWake, ...Array<PullRequestWatchWake>],
  );
  return {
    ...message,
    text: wake.text,
    notification: {
      ...wake.notification,
      source: {
        kind: "monitor",
        pullRequest: rest.length === 0 ? withoutSection(first) : first,
        ...(rest.length === 0 ? {} : { otherPullRequests: rest }),
      },
    },
  };
}

export function pendingForkTransferForThread(
  projection: Pick<OrchestrationV2ThreadProjection, "contextTransfers" | "thread">,
): OrchestrationV2ContextTransfer | undefined {
  return projection.contextTransfers.find(
    (transfer) =>
      transfer.type === "fork" &&
      transfer.targetThreadId === projection.thread.id &&
      transfer.status === "pending",
  );
}

/** A fork transfer still pending when a fresh run starts would bring the parent's context back. */
export function forkTransferSupersededEvent(
  transfer: OrchestrationV2ContextTransfer,
  runId: RunId,
  providerInstanceId: ProviderInstanceId,
  now: DateTime.Utc,
): Omit<OrchestrationV2DomainEvent, "id"> {
  return {
    type: "context-transfer.updated",
    threadId: transfer.targetThreadId,
    runId,
    providerInstanceId,
    occurredAt: now,
    payload: {
      ...transfer,
      status: "superseded",
      error: "Superseded by a fresh session.",
      updatedAt: now,
    },
  };
}

export function appendContextHandoffId(
  handoffIds: OrchestrationV2ProviderThread["handoffIds"],
  handoffId: OrchestrationV2ContextHandoff["id"] | null,
): OrchestrationV2ProviderThread["handoffIds"] {
  return handoffId === null ? handoffIds : Array.from(new Set([...handoffIds, handoffId]));
}

/** Threads with no started run (imported, or reserved by another queued run) never cross it. */
function providerThreadPredatesBoundary(
  providerThread: Pick<OrchestrationV2ProviderThread, "firstRunOrdinal">,
  boundary: number,
): boolean {
  return (
    boundary > 0 &&
    (providerThread.firstRunOrdinal === null || providerThread.firstRunOrdinal < boundary)
  );
}

/** The provider thread a message continues: the active one, unless a fresh-session schedule run started it or it predates the latest fresh start. */
function conversationProviderThread(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "providerThreads" | "runs" | "turnItems"
  >,
): OrchestrationV2ProviderThread | undefined {
  const startedByScheduledFreshRun = (providerThread: OrchestrationV2ProviderThread) =>
    projection.runs.some(
      (run) =>
        run.ordinal === providerThread.firstRunOrdinal &&
        isScheduledFreshRun(run, projection.turnItems),
    );
  const active = projection.providerThreads.find(
    (candidate) => candidate.id === projection.thread.activeProviderThreadId,
  );
  if (active === undefined) return active;
  const boundary = contextBoundaryOrdinal(projection);
  // A pre-clear session that is still alive (background work) can become active again on its updates.
  if (!startedByScheduledFreshRun(active) && !providerThreadPredatesBoundary(active, boundary)) {
    return active;
  }
  return (
    projection.providerThreads
      .filter(
        (candidate) =>
          candidate.appThreadId === projection.thread.id &&
          candidate.ownerNodeId === null &&
          candidate.lastRunOrdinal !== null &&
          !providerThreadPredatesBoundary(candidate, boundary) &&
          !startedByScheduledFreshRun(candidate),
      )
      .toSorted((left, right) => (right.lastRunOrdinal ?? 0) - (left.lastRunOrdinal ?? 0))[0] ??
    active
  );
}

/** Wakes and fresh starts act on the active session; a message continues the conversation. */
export function dispatchProviderThread(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "providerThreads" | "runs" | "turnItems"
  >,
  message: Pick<OrchestrationV2ConversationMessage, "notification" | "delegatedCompletion">,
  freshContext: boolean,
): OrchestrationV2ProviderThread | undefined {
  return freshContext ||
    message.notification !== undefined ||
    message.delegatedCompletion !== undefined
    ? projection.providerThreads.find(
        (candidate) => candidate.id === projection.thread.activeProviderThreadId,
      )
    : conversationProviderThread(projection);
}

/** A provider that hosts one native thread per session keeps the old conversation alive otherwise. */
export function sessionsReleasedByFreshContext(
  projection: Pick<OrchestrationV2ThreadProjection, "providerSessions">,
  activeProviderThread: OrchestrationV2ProviderThread | undefined,
): ReadonlyArray<OrchestrationV2ProviderSession> {
  const sessionId = activeProviderThread?.providerSessionId ?? null;
  return projection.providerSessions.filter(
    (session) =>
      session.id === sessionId &&
      session.status !== "stopped" &&
      session.status !== "error" &&
      !session.capabilities.sessions.supportsMultipleProviderThreadsPerSession,
  );
}

export const FRESH_CONTEXT_DETACH_REASON = "Started a fresh session.";

export function uniqueSessions(
  sessions: ReadonlyArray<OrchestrationV2ProviderSession>,
): ReadonlyArray<OrchestrationV2ProviderSession> {
  return Array.from(new Map(sessions.map((session) => [session.id, session])).values());
}

export function rootProviderThreadsForProvider(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "providerThreads" | "thread" | "runs" | "turnItems"
  >,
  providerInstanceId: ModelSelection["instanceId"],
): ReadonlyArray<OrchestrationV2ProviderThread> {
  const boundary = contextBoundaryOrdinal(projection);
  return projection.providerThreads
    .filter(
      (providerThread) =>
        providerThread.providerInstanceId === providerInstanceId &&
        providerThread.appThreadId === projection.thread.id &&
        providerThread.ownerNodeId === null &&
        !providerThreadPredatesBoundary(providerThread, boundary),
    )
    .toSorted(
      (left, right) =>
        (right.lastRunOrdinal ?? 0) - (left.lastRunOrdinal ?? 0) ||
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );
}

export function isHandoffSourceRun(run: OrchestrationV2Run): boolean {
  return (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "interrupted" ||
    // A queued request cancelled before it started never reached any provider.
    (run.status === "cancelled" && run.startedAt !== null)
  );
}

export function lastDeliveredRunForProviderThread(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">,
  providerThreadId: OrchestrationV2ProviderThread["id"],
): OrchestrationV2Run | undefined {
  return projection.runs.findLast(
    (run) =>
      isHandoffSourceRun(run) &&
      run.providerThreadId === providerThreadId &&
      (run.status === "completed" ||
        projection.providerTurns.some(
          (turn) => turn.runAttemptId === run.activeAttemptId && isDeliveredProviderTurn(turn),
        )),
  );
}

interface QueueRunnerCallbacks {
  readonly dispatchWithReceiptEffect: (
    command: OrchestrationV2ServerCommand,
    sideChatIds?: ReadonlyArray<ThreadId>,
    cancelledTask?: OrchestrationV2Subagent,
  ) => Effect.Effect<OrchestratorV2DispatchResult, OrchestratorV2Error>;
}

export function makeQueueRunner(shared: OrchestratorShared, callbacks: QueueRunnerCallbacks) {
  const {
    checkpointService,
    commandPolicy,
    contextHandoffService,
    effectOutbox,
    idAllocator,
    projectionStore,
    providerAdapters,
    providerSwitchService,
    runtimeModeCeiling,
    runtimePolicy,
    serverSettings,
    threadDispatch,
    awaitsCheckpointCapture,
    emitQueuedRunCancellation,
    ensureGoalCommandSupported,
    nextTurnItemOrdinal,
    notificationTasks,
    providerSessionIdFor,
    readCommandProjection,
    readHandoffItems,
    readInheritedItems,
    sessionHasBackgroundWork,
    writeSystemEvents,
  } = shared;

  const failQueuedRunStart = Effect.fn("Orchestrator.failQueuedRunStart")(function* (
    threadId: ThreadId,
    cause: unknown,
    queuedRunId?: RunId,
  ) {
    const projection = yield* projectionStore.getThreadRecords(
      threadId,
      ["runs", "nodes", "attempts", "providerThreads", "turnItems", "messages"],
      { turnItemTypes: ["user_message"], messageRoles: ["user"] },
    );
    const queuedRun =
      queuedRunId === undefined
        ? nextQueuedRun(projection)
        : projection.runs.find((run) => run.id === queuedRunId && run.status === "queued");
    if (queuedRun === undefined) return;
    // A steer that fell back to the queue keeps its user item, hidden while the
    // run is queued. Republish it before the failure so clients whose bounded
    // snapshot omitted it can show the prompt beside the error.
    const retainedUserItems = projection.turnItems.filter(
      (item) => item.type === "user_message" && item.runId === queuedRun.id,
    );
    const now = yield* DateTime.now;
    const rootNode = projection.nodes.find((node) => node.id === queuedRun.rootNodeId);
    const attempt = projection.attempts.find((entry) => entry.id === queuedRun.activeAttemptId);
    const providerThread = projection.providerThreads.find(
      (entry) => entry.id === queuedRun.providerThreadId,
    );
    const handoffUnsupported =
      typeof cause === "object" &&
      cause !== null &&
      "_tag" in cause &&
      cause._tag === "CommandPolicyCapabilityUnsupportedError";
    const failureCause =
      typeof cause === "object" &&
      cause !== null &&
      "_tag" in cause &&
      cause._tag === "OrchestratorDispatchError" &&
      "cause" in cause
        ? cause.cause
        : cause;
    const failure = makeProviderFailure({
      cause: failureCause,
      code: handoffUnsupported ? "context_handoff_unsupported" : "queued_start_failed",
      class: handoffUnsupported ? "validation_error" : "unknown",
    });
    yield* writeSystemEvents([
      ...retainedUserItems.map((item) => ({
        type: "turn-item.updated" as const,
        threadId,
        runId: queuedRun.id,
        ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
        providerInstanceId: queuedRun.providerInstanceId,
        occurredAt: now,
        payload: { ...item, status: "failed" as const, completedAt: now, updatedAt: now },
      })),
      ...(attempt !== undefined && rootNode !== undefined
        ? [
            {
              type: "run-attempt.updated" as const,
              threadId,
              runId: queuedRun.id,
              nodeId: rootNode.id,
              providerInstanceId: queuedRun.providerInstanceId,
              occurredAt: now,
              payload: { ...attempt, status: "failed" as const, completedAt: now },
            },
          ]
        : []),
      ...(rootNode === undefined
        ? []
        : [
            {
              type: "node.updated" as const,
              threadId,
              runId: queuedRun.id,
              nodeId: rootNode.id,
              providerInstanceId: queuedRun.providerInstanceId,
              occurredAt: now,
              payload: { ...rootNode, status: "failed" as const, completedAt: now },
            },
          ]),
      ...(rootNode === undefined || providerThread === undefined
        ? []
        : [
            {
              type: "turn-item.updated" as const,
              threadId,
              runId: queuedRun.id,
              nodeId: rootNode.id,
              providerInstanceId: queuedRun.providerInstanceId,
              occurredAt: now,
              payload: {
                id: idAllocator.derive.turnItemFromProviderItem({
                  driver: providerThread.driver,
                  nativeItemId: `queued-start-failure:${queuedRun.id}`,
                }),
                threadId,
                runId: queuedRun.id,
                nodeId: rootNode.id,
                providerThreadId: providerThread.id,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: yield* nextTurnItemOrdinal(projection),
                status: "failed" as const,
                title: "Queued provider could not start",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "error" as const,
                failure,
              },
            },
          ]),
      {
        type: "run.updated",
        threadId,
        runId: queuedRun.id,
        ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
        providerInstanceId: queuedRun.providerInstanceId,
        occurredAt: now,
        payload: { ...queuedRun, status: "failed", queuePosition: null, completedAt: now },
      },
    ]);
  });

  const isStaleQuestionWake = Effect.fn("Orchestrator.isStaleQuestionWake")(function* (
    projection: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents">,
    messageId: MessageId,
    notification: OrchestrationV2ThreadProjection["messages"][number]["notification"],
  ) {
    if (notification?.source.kind !== "delegated_task" || notification.outcome !== "updated")
      return false;
    const source = notification.source;
    const threadId = projection.thread.id;
    const task =
      projection.subagents.find((candidate) => source.taskIds.includes(candidate.id)) ??
      // Command projections omit settled tasks whose result was already handed over.
      (yield* projectionStore
        .getThreadRecords(threadId, ["subagents"], { subagentIds: source.taskIds })
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))))
        .subagents[0];
    // An unknown task gives no evidence the question is obsolete.
    if (task === undefined) return false;
    const childThreadId = task.childThreadId;
    if (
      childThreadId === null ||
      ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
    )
      return true;
    const child = yield* projectionStore
      .getThreadRecords(childThreadId, ["runtimeRequests"])
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: childThreadId, cause }),
        ),
      );
    return !child.runtimeRequests.some(
      (request) =>
        request.kind === "user_input" &&
        request.status === "pending" &&
        messageId === `message:delegated-task-question:${threadId}:${request.id}`,
    );
  });

  const cancelStaleQuestionWakes = Effect.fn("Orchestrator.cancelStaleQuestionWakes")(function* (
    projection: OrchestrationV2ThreadProjection,
  ) {
    const events = yield* Ref.make<Array<OrchestrationV2DomainEvent>>([]);
    for (const run of projection.runs) {
      if (run.status !== "queued") continue;
      const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
      if (
        message === undefined ||
        !(yield* isStaleQuestionWake(projection, message.id, message.notification).pipe(
          // A child thread read must not fail the parent's unrelated next queued run.
          Effect.catchTags({
            OrchestratorProjectionError: (cause) =>
              Effect.logWarning("Failed to check a queued task question wake", {
                runId: run.id,
                cause,
              }).pipe(Effect.as(false)),
          }),
        ))
      )
        continue;
      yield* emitQueuedRunCancellation({
        command: {
          type: "queued-run.cancel",
          commandId: CommandId.make(`command:system:stale-question:${run.id}`),
          threadId: projection.thread.id,
          runId: run.id,
        },
        events,
        projection,
        run,
        now: yield* DateTime.now,
      });
    }
    const cancellations = yield* Ref.get(events);
    if (cancellations.length === 0) return false;
    yield* writeSystemEvents(cancellations);
    return true;
  });

  const startNextQueuedRunOnce = Effect.fn("Orchestrator.startNextQueuedRun")(
    function* (
      threadId: ThreadId,
      options?: {
        readonly failedRunId?: RunId;
        readonly endedRunId?: RunId;
        readonly queuedRunId?: RunId;
        /** Treat the latest executed run as the one that just ended, as its run-end handler would. */
        readonly latestRunEnded?: boolean;
        readonly userStarted?: boolean;
      },
    ) {
      if (!(yield* projectionStore.canStartQueuedRun(threadId))) return;
      let projection = yield* readCommandProjection(threadId);
      if (
        projection.thread.archivedAt !== null ||
        projection.thread.deletedAt !== null ||
        projection.runs.some(isActiveRun)
      ) {
        return;
      }

      if (yield* cancelStaleQuestionWakes(projection)) {
        projection = yield* readCommandProjection(threadId);
      }
      let storedQueuedRun =
        options?.queuedRunId === undefined
          ? nextQueuedRun(projection)
          : projection.runs.find(
              (run) => run.id === options.queuedRunId && run.status === "queued",
            );
      while (
        storedQueuedRun !== undefined &&
        isStalePullRequestWatchWake(projection, storedQueuedRun)
      ) {
        yield* writeSystemEvents(
          queuedRunCancellationEvents(projection, storedQueuedRun, yield* DateTime.now),
        );
        projection = yield* readCommandProjection(threadId);
        storedQueuedRun = nextQueuedRun(projection);
      }
      // A wake that outlived some of its pull requests tells only the current ones.
      const currentWake =
        storedQueuedRun === undefined
          ? undefined
          : currentPullRequestWatchWake(projection, storedQueuedRun);
      if (storedQueuedRun !== undefined && currentWake !== undefined) {
        const now = yield* DateTime.now;
        yield* writeSystemEvents([
          {
            type: "message.updated",
            threadId,
            runId: storedQueuedRun.id,
            ...(storedQueuedRun.rootNodeId === null ? {} : { nodeId: storedQueuedRun.rootNodeId }),
            providerInstanceId: storedQueuedRun.providerInstanceId,
            occurredAt: now,
            payload: { ...currentWake, updatedAt: now },
          },
        ]);
        const runId = storedQueuedRun.id;
        projection = yield* readCommandProjection(threadId);
        storedQueuedRun = projection.runs.find((run) => run.id === runId);
      }
      if (storedQueuedRun === undefined) {
        return;
      }
      const queuedMessage = projection.messages.find(
        (candidate) => candidate.id === storedQueuedRun.userMessageId,
      );
      const modelSelection = queuedRunModelSelection(projection, storedQueuedRun);
      const queuedRun = {
        ...storedQueuedRun,
        modelSelection,
        providerInstanceId: modelSelection.instanceId,
      };
      // A limited provider would fail and consume every waiting message.
      if (
        usageLimitHoldsQueue(
          projection,
          queuedRun.providerInstanceId,
          options?.userStarted === true ? undefined : yield* DateTime.now,
        )
      ) {
        return;
      }
      // Waits without a hold: lowering the thread's mode starts the queue again.
      if (isRuntimeModeAbove(projection.thread.runtimeMode, runtimeModeCeiling?.maxRuntimeMode)) {
        return;
      }
      // Failed worktree creation would run queued work in the project checkout; wait for the user.
      const failedRun = latestExecutedRun(projection.runs);
      const endedRunId = options?.latestRunEnded === true ? failedRun?.id : options?.endedRunId;
      const failedRunId =
        options?.latestRunEnded === true && failedRun?.status === "failed"
          ? failedRun.id
          : options?.failedRunId;
      const failureClass =
        failedRun && failedRunId !== undefined && failedRun.id === failedRunId
          ? latestRootProviderFailure(failedRun, projection.turnItems)?.class
          : undefined;
      const worktreeMissing =
        endedRunId !== undefined &&
        failedRun?.id === endedRunId &&
        failedRun.startedAt === null &&
        failedRun.workspacePreparation?.type === "worktree" &&
        projection.thread.worktreePath === null;
      const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
      const projectOverride =
        settings.projectSettingsOverrides[projection.thread.projectId]?.providerInstances?.[
          queuedRun.providerInstanceId
        ]?.enabled;
      const machineInstance = Object.hasOwn(
        settings.providerInstances,
        queuedRun.providerInstanceId,
      )
        ? settings.providerInstances[queuedRun.providerInstanceId]
        : undefined;
      const instanceDisabledForProject =
        projectOverride !== undefined
          ? !projectOverride
          : machineInstance !== undefined && !resolveProviderInstanceEnabled(machineInstance);
      const providerFailed =
        failureClass !== undefined &&
        failureClass !== "validation_error" &&
        failedRun?.providerInstanceId === queuedRun.providerInstanceId;
      if (worktreeMissing || instanceDisabledForProject || providerFailed) {
        // A buffered wake prompts nothing: it replays output the CLI already produced.
        const wakes =
          worktreeMissing || instanceDisabledForProject
            ? []
            : queuedRunsInDeliveryOrder(projection).filter((run) => {
                const message = projection.messages.find(
                  (candidate) => candidate.id === run.userMessageId,
                );
                return (
                  run.queueHeld !== true &&
                  message !== undefined &&
                  isBufferedProviderNotification(message)
                );
              });
        const now = yield* DateTime.now;
        yield* writeSystemEvents(
          projection.runs
            .filter((run) => run.status === "queued" && !wakes.some((wake) => wake.id === run.id))
            .map((run) => ({
              type: "run.updated" as const,
              threadId,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: { ...run, queueHeld: true },
            })),
        );
        return wakes.length > 0;
      }
      // Move queued ordinals after runs that started while they waited to preserve transcript and checkpoint order.
      // Started runs have prompts; cancelled queued messages do not.
      const newerRunIds = projection.runs
        .filter((run) => run.status !== "queued" && run.ordinal > queuedRun.ordinal)
        .map((run) => run.id);
      const startedAhead =
        newerRunIds.length > 0 &&
        (yield* projectionStore.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["user_message", "notification"],
          turnItemRunIds: newerRunIds,
        })).turnItems.length > 0;
      const ordinal = startedAhead ? nextRunOrdinal(projection) : queuedRun.ordinal;
      const commandId = CommandId.make(`command:system:start-queued:${queuedRun.id}`);
      const rootNodeId = queuedRun.rootNodeId;
      const attemptId = queuedRun.activeAttemptId;
      const providerThreadId = queuedRun.providerThreadId;
      if (rootNodeId === null || attemptId === null || providerThreadId === null) {
        return yield* new OrchestratorDispatchError({
          commandId,
          commandType: "message.dispatch",
          cause: `Queued run ${queuedRun.id} is missing execution identity.`,
        });
      }

      const rootNode = projection.nodes.find((candidate) => candidate.id === rootNodeId);
      const attempt = projection.attempts.find((candidate) => candidate.id === attemptId);
      const legacyQueuedTurnItem = projection.turnItems.find(
        (
          candidate,
        ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> =>
          candidate.type === "user_message" &&
          candidate.runId === queuedRun.id &&
          candidate.messageId === queuedRun.userMessageId,
      );
      const storedProviderThread = projection.providerThreads.find(
        (candidate) => candidate.id === providerThreadId,
      );
      const storedCheckpointScope = projection.checkpointScopes.find(
        (scope) => scope.id === rootNode?.checkpointScopeId,
      );
      if (
        rootNode === undefined ||
        attempt === undefined ||
        queuedMessage === undefined ||
        storedProviderThread === undefined ||
        (rootNode.checkpointScopeId !== null && storedCheckpointScope === undefined)
      ) {
        return yield* new OrchestratorDispatchError({
          commandId,
          commandType: "message.dispatch",
          cause: `Queued run ${queuedRun.id} is missing projection state.`,
        });
      }
      // A scheduled delivery starts on the thread's current pick, so /goal must suit that provider.
      yield* ensureGoalCommandSupported(
        { commandId, type: "message.dispatch" },
        queuedMessage,
        queuedRun.providerInstanceId,
      );

      const now = yield* DateTime.now;
      const targetAdapter = yield* providerAdapters.get(queuedRun.providerInstanceId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId,
              commandType: "message.dispatch",
              cause,
            }),
        ),
      );
      const followsCurrent = followsCurrentConversation(queuedMessage);
      const freshContext = queuedRun.freshContext === true;
      // A scheduled fresh run is a side conversation, so it must not drop the fork's context.
      const supersededForkTransfer =
        freshContext && queuedMessage.scheduledTaskId === undefined
          ? pendingForkTransferForThread(projection)
          : undefined;
      const activeProviderThread = dispatchProviderThread(projection, queuedMessage, freshContext);
      const contextBoundary = freshContext ? ordinal : contextBoundaryOrdinal(projection);
      // A run queued before a fresh run started is bound to the conversation that run left behind.
      const followsLatestContext =
        !freshContext &&
        (followsCurrent ||
          storedProviderThread.providerInstanceId !== queuedRun.providerInstanceId ||
          providerThreadPredatesBoundary(storedProviderThread, contextBoundary));
      const targetProviderThread = followsLatestContext
        ? activeProviderThread?.providerInstanceId === queuedRun.providerInstanceId &&
          !providerThreadPredatesBoundary(activeProviderThread, contextBoundary)
          ? activeProviderThread
          : rootProviderThreadsForProvider(projection, queuedRun.providerInstanceId)[0]
        : freshContext &&
            // The reserved row belongs to the instance the run queued on, which may have changed.
            (storedProviderThread.providerInstanceId !== queuedRun.providerInstanceId ||
              storedProviderThread.firstRunOrdinal !== null ||
              storedProviderThread.nativeThreadRef !== null)
          ? undefined
          : storedProviderThread;
      const queuedProviderThread: OrchestrationV2ProviderThread = targetProviderThread ?? {
        id: idAllocator.derive.providerThread({
          driver: targetAdapter.driver,
          // The queue reserved `pending:<run>` for this run; another run may have taken it. An edit
          // that moved the run to another instance of the same driver must not replace that row.
          nativeThreadId: freshContext
            ? `pending:${queuedRun.id}:fresh`
            : storedProviderThread.providerInstanceId === queuedRun.providerInstanceId
              ? `pending:${queuedRun.id}`
              : `pending:${queuedRun.id}:${queuedRun.providerInstanceId}`,
        }),
        driver: targetAdapter.driver,
        providerInstanceId: queuedRun.providerInstanceId,
        providerSessionId: null,
        appThreadId: threadId,
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
      const selectionChanged = !modelSelectionsEqual(
        projection.thread.modelSelection,
        queuedRun.modelSelection,
      );
      // The picker may already have moved ahead of the native conversation.
      const switchFromActiveProvider =
        followsCurrent &&
        activeProviderThread !== undefined &&
        activeProviderThread.providerInstanceId !== queuedRun.providerInstanceId;
      const switchPlan =
        selectionChanged || switchFromActiveProvider
          ? yield* providerSwitchService
              .plan({
                projection: switchFromActiveProvider
                  ? {
                      ...projection,
                      thread: {
                        ...projection.thread,
                        modelSelection: {
                          ...projection.thread.modelSelection,
                          instanceId: activeProviderThread.providerInstanceId,
                        },
                      },
                    }
                  : projection,
                targetModelSelection: queuedRun.modelSelection,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorDispatchError({
                      commandId,
                      commandType: "message.dispatch",
                      cause,
                    }),
                ),
              )
          : null;
      const releasableSessions = uniqueSessions([
        ...projection.providerSessions.filter(
          (session) =>
            switchPlan?.releaseProviderSessionIds.includes(session.id) &&
            session.status !== "stopped" &&
            session.status !== "error",
        ),
        ...(freshContext ? sessionsReleasedByFreshContext(projection, activeProviderThread) : []),
      ]);
      const busySessionIds = new Set<ProviderSessionId>();
      for (const session of releasableSessions) {
        if (yield* sessionHasBackgroundWork(session, projection.providerThreads)) {
          busySessionIds.add(session.id);
        }
      }
      // Nobody waits on a queued start to refuse it. A handoff runs in its own session, so a
      // busy one stays up; a restart resumes the busy session's native thread, so wait instead.
      // A fresh run resumes nothing, so it never waits.
      if (
        busySessionIds.size > 0 &&
        !freshContext &&
        switchPlan?.transition.type === "restart_and_resume"
      ) {
        yield* Effect.logInfo(
          "Holding the queue: the replaced provider session still runs background work",
          { threadId, runId: queuedRun.id, providerSessionIds: Array.from(busySessionIds) },
        );
        yield* writeSystemEvents(
          projection.runs
            .filter((run) => run.status === "queued")
            .map((run) => ({
              type: "run.updated" as const,
              threadId,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: { ...run, queueHeld: true },
            })),
        );
        return;
      }
      const sessionsToDetach = releasableSessions.filter(
        (session) => !busySessionIds.has(session.id),
      );
      const canResumeAcrossInstances =
        !freshContext &&
        switchPlan?.instanceChanged === true &&
        switchPlan.transition.type === "restart_and_resume" &&
        activeProviderThread !== undefined &&
        activeProviderThread.nativeThreadRef !== null;
      const deliveryProviderThread = canResumeAcrossInstances
        ? {
            ...queuedProviderThread,
            status: activeProviderThread.status,
            nativeThreadRef: activeProviderThread.nativeThreadRef,
            nativeConversationHeadRef: activeProviderThread.nativeConversationHeadRef,
            nativeMetadata: activeProviderThread.nativeMetadata,
          }
        : queuedProviderThread;
      const targetCapabilities = yield* targetAdapter.getCapabilities().pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId,
              commandType: "message.dispatch",
              cause,
            }),
        ),
      );
      const latestCompletedRun = projection.runs.findLast((run) => run.status === "completed");
      const latestHandoffRun = projection.runs.findLast(isHandoffSourceRun);
      const targetLastCompletedRun = lastDeliveredRunForProviderThread(
        projection,
        queuedProviderThread.id,
      );
      const coveredRuns =
        freshContext ||
        canResumeAcrossInstances ||
        latestHandoffRun === undefined ||
        latestHandoffRun.providerInstanceId === queuedRun.providerInstanceId
          ? []
          : projection.runs.filter(
              (run) =>
                isHandoffSourceRun(run) &&
                run.ordinal >= contextBoundary &&
                run.ordinal > (targetLastCompletedRun?.ordinal ?? 0) &&
                run.ordinal <= latestHandoffRun.ordinal,
            );
      const needsFullContext = deliveryProviderThread.nativeThreadRef === null;
      const legacyImportItems =
        projection.thread.historyOrigin === "v1_import" && contextBoundary === 0
          ? yield* readHandoffItems(threadId, [null])
          : [];
      const handoffStrategy = needsFullContext
        ? ("full_thread_summary" as const)
        : ("delta_since_target_last_seen" as const);
      const transferId =
        coveredRuns.length === 0
          ? null
          : yield* idAllocator.allocate
              .contextTransfer({
                sourceThreadId: threadId,
                targetThreadId: threadId,
                type: "provider_handoff",
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorDispatchError({
                      commandId,
                      commandType: "message.dispatch",
                      cause,
                    }),
                ),
              );
      if (transferId !== null) {
        yield* commandPolicy.ensureContextHandoff({
          commandId,
          threadId,
          providerInstanceId: queuedRun.providerInstanceId,
          capabilities: targetCapabilities,
          strategy: needsFullContext ? "full_thread_summary" : "delta_context",
        });
      }
      const handoff =
        transferId === null || latestHandoffRun === undefined
          ? null
          : yield* contextHandoffService
              .prepareProviderHandoff({
                threadId,
                targetRunId: queuedRun.id,
                transferId,
                fromProviderThreadIds: Array.from(
                  new Set(
                    coveredRuns.flatMap((run) =>
                      run.providerThreadId === null ? [] : [run.providerThreadId],
                    ),
                  ),
                ),
                toProviderThreadId: queuedProviderThread.id,
                fromProviderInstanceId: latestHandoffRun.providerInstanceId,
                toProviderInstanceId: queuedRun.providerInstanceId,
                coveredRunOrdinals: {
                  from: coveredRuns[0]!.ordinal,
                  to: coveredRuns.at(-1)!.ordinal,
                },
                runs: projection.runs,
                strategy: handoffStrategy,
                items: [
                  ...(needsFullContext && contextBoundary === 0
                    ? yield* readInheritedItems(projection.thread)
                    : []),
                  ...(needsFullContext && latestCompletedRun !== undefined
                    ? legacyImportItems
                    : []),
                  ...(yield* readHandoffItems(
                    threadId,
                    coveredRuns.map((run) => run.id),
                  )),
                ],
                createdAt: now,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorDispatchError({
                      commandId,
                      commandType: "message.dispatch",
                      cause,
                    }),
                ),
              );
      const legacyImportRecoveryHandoff =
        latestCompletedRun === undefined && needsFullContext && legacyImportItems.length > 0
          ? yield* contextHandoffService
              .prepareLegacyImport({
                threadId,
                targetRunId: queuedRun.id,
                toProviderThreadId: queuedProviderThread.id,
                toProviderInstanceId: queuedRun.providerInstanceId,
                items: legacyImportItems,
                createdAt: now,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorDispatchError({
                      commandId,
                      commandType: "message.dispatch",
                      cause,
                    }),
                ),
              )
          : null;
      const activeHandoff = handoff ?? legacyImportRecoveryHandoff;
      const mapQueuedStartError = Effect.mapError(
        (cause: unknown) =>
          new OrchestratorDispatchError({
            commandId,
            commandType: "message.dispatch",
            cause,
          }),
      );
      const executionCwd =
        storedCheckpointScope !== undefined &&
        storedCheckpointScope.cwd === projection.thread.worktreePath
          ? storedCheckpointScope.cwd
          : yield* runtimePolicy
              .resolve({ thread: projection.thread, modelSelection: queuedRun.modelSelection })
              .pipe(
                Effect.map(
                  (resolvedRuntimePolicy) =>
                    resolvedRuntimePolicy.cwd ?? projection.thread.worktreePath ?? process.cwd(),
                ),
                mapQueuedStartError,
              );
      // The thread may have moved between worktree and checkout while this message waited.
      const reusableCheckpointScope =
        storedCheckpointScope?.cwd === executionCwd ? storedCheckpointScope : undefined;
      const checkpointScope =
        reusableCheckpointScope ??
        (yield* checkpointService
          .prepareRootRunScope({
            threadId,
            runId: queuedRun.id,
            rootNodeId: rootNode.id,
            providerThreadId: queuedProviderThread.id,
            cwd: executionCwd,
            createdAt: now,
          })
          .pipe(mapQueuedStartError));
      const providerSessionId =
        (!canResumeAcrossInstances &&
        queuedProviderThread.providerSessionId !== null &&
        !switchPlan?.releaseProviderSessionIds.includes(queuedProviderThread.providerSessionId)
          ? queuedProviderThread.providerSessionId
          : null) ??
        (yield* providerAdapters.get(queuedRun.providerInstanceId).pipe(
          Effect.flatMap((adapter) =>
            providerSessionIdFor({
              adapter,
              providerInstanceId: queuedRun.providerInstanceId,
              threadId,
            }),
          ),
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId,
                commandType: "message.dispatch",
                cause,
              }),
          ),
        ));
      const providerThread: OrchestrationV2ProviderThread = {
        ...deliveryProviderThread,
        providerSessionId,
        status: deliveryProviderThread.status === "error" ? "error" : "not_loaded",
        firstRunOrdinal: queuedProviderThread.firstRunOrdinal ?? ordinal,
        lastRunOrdinal: ordinal,
        handoffIds: appendContextHandoffId(
          appendContextHandoffId(queuedProviderThread.handoffIds, handoff?.id ?? null),
          legacyImportRecoveryHandoff?.id ?? null,
        ),
        updatedAt: now,
      };
      // Resume can clear the hold before the stopped run ends; its Stop marker still makes the drain explicit.
      const queueDelivery =
        endedRunId === undefined ||
        queuedRun.queueHeld === true ||
        (yield* projectionStore
          .getThreadRecords(threadId, ["turnItems"], {
            turnItemTypes: ["run_interrupt_request"],
            turnItemRunIds: [endedRunId],
          })
          .pipe(
            Effect.map(({ turnItems }) => turnItems.length > 0),
            Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })),
          ))
          ? "explicit-queue"
          : "automatic-queue";
      const startingRun: OrchestrationV2Run = {
        ...queuedRun,
        providerThreadId: queuedProviderThread.id,
        ordinal,
        status: "starting",
        queuePosition: null,
        startedAt: null,
        contextHandoffId: activeHandoff?.id ?? null,
        ...wakeWorkStartedAt(
          projection,
          {
            createdBy: queuedMessage.createdBy,
            creationSource: queuedMessage.creationSource,
            senderThreadId: queuedMessage.senderThreadId,
            notification: queuedMessage.notification,
            delegatedCompletion: queuedMessage.delegatedCompletion,
            restartContinuationOfRunId: queuedRun.restartContinuationOfRunId,
          },
          queueDelivery,
        ),
      };
      const userTurnItem: OrchestrationV2TurnItem = {
        ...(legacyQueuedTurnItem ?? {
          id: idAllocator.derive.userTurnItem({ messageId: queuedMessage.id }),
          threadId,
          runId: queuedRun.id,
          nodeId: rootNodeId,
          providerThreadId: queuedProviderThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinal * 100,
          status: "completed",
          title: null,
          type: "user_message",
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
        }),
        ...(freshContext ? { freshContext: true } : {}),
        providerThreadId: queuedProviderThread.id,
        inputIntent: "queued_turn",
        status: "completed",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        ...(activeHandoff === null ? modelSwitchSince(projection, queuedRun.modelSelection) : {}),
      };
      const handoffTurnItem: OrchestrationV2TurnItem | null =
        activeHandoff === null
          ? null
          : {
              id: idAllocator.derive.runSignalTurnItem({
                runId: queuedRun.id,
                signal: `context-handoff:${activeHandoff.id}`,
              }),
              threadId,
              runId: queuedRun.id,
              nodeId: rootNodeId,
              providerThreadId: queuedProviderThread.id,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: ordinal * 100 - 1,
              status: "completed",
              title: handoff === null ? "Imported context" : "Provider handoff",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "handoff",
              contextHandoffId: activeHandoff.id,
              fromProviderThreadIds: activeHandoff.fromProviderThreadIds,
              toProviderThreadId: activeHandoff.toProviderThreadId,
              fromProviderInstanceIds: Array.from(
                new Set(coveredRuns.map((run) => run.providerInstanceId)),
              ),
              toProviderInstanceId: queuedRun.providerInstanceId,
              fromModelSelections: Array.from(
                new Map(
                  coveredRuns.map((run) => [
                    `${run.modelSelection.instanceId}\0${run.modelSelection.model}`,
                    run.modelSelection,
                  ]),
                ).values(),
              ),
              toModel: queuedRun.modelSelection.model,
              strategy: activeHandoff.strategy,
              summary: activeHandoff.summaryText,
            };
      const executionIdentityEvents: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">> =
        reusableCheckpointScope === undefined ||
        storedProviderThread.id !== queuedProviderThread.id ||
        attempt.providerInstanceId !== queuedRun.providerInstanceId
          ? [
              {
                type: "checkpoint-scope.created",
                threadId,
                runId: queuedRun.id,
                nodeId: rootNodeId,
                providerInstanceId: queuedRun.providerInstanceId,
                occurredAt: now,
                payload: { ...checkpointScope, providerThreadId: queuedProviderThread.id },
              },
              {
                type: "node.updated",
                threadId,
                runId: queuedRun.id,
                nodeId: rootNodeId,
                providerInstanceId: queuedRun.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...rootNode,
                  providerThreadId: queuedProviderThread.id,
                  checkpointScopeId: checkpointScope.id,
                },
              },
              {
                type: "run-attempt.updated",
                threadId,
                runId: queuedRun.id,
                nodeId: rootNodeId,
                providerInstanceId: queuedRun.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...attempt,
                  providerInstanceId: queuedRun.providerInstanceId,
                  providerThreadId: queuedProviderThread.id,
                },
              },
            ]
          : [];
      const detachReason = freshContext
        ? FRESH_CONTEXT_DETACH_REASON
        : "Provider or model selection changed.";
      yield* writeSystemEvents(
        [
          ...(selectionChanged
            ? [
                {
                  type:
                    queuedRun.providerInstanceId === projection.thread.providerInstanceId
                      ? ("thread.model-selection-updated" as const)
                      : ("thread.provider-switched" as const),
                  threadId,
                  providerInstanceId: queuedRun.providerInstanceId,
                  occurredAt: now,
                  payload: {
                    ...projection.thread,
                    providerInstanceId: queuedRun.providerInstanceId,
                    modelSelection: queuedRun.modelSelection,
                    updatedAt: now,
                  },
                },
              ]
            : []),
          ...(handoff === null || transferId === null || latestHandoffRun === undefined
            ? []
            : [
                {
                  type: "context-transfer.created" as const,
                  threadId,
                  runId: queuedRun.id,
                  providerInstanceId: queuedRun.providerInstanceId,
                  occurredAt: now,
                  payload: {
                    id: transferId,
                    type: "provider_handoff" as const,
                    sourceThreadId: threadId,
                    targetThreadId: threadId,
                    sourcePoint: contextSourcePointForRun(projection, latestHandoffRun),
                    basePoint:
                      needsFullContext || targetLastCompletedRun === undefined
                        ? null
                        : contextSourcePointForRun(projection, targetLastCompletedRun),
                    sourceProviderInstanceId: latestHandoffRun.providerInstanceId,
                    targetProviderInstanceId: queuedRun.providerInstanceId,
                    targetRunId: queuedRun.id,
                    status: "consumed" as const,
                    resolution: {
                      strategy: needsFullContext
                        ? ("portable_context" as const)
                        : ("delta_context" as const),
                      contextHandoffId: handoff.id,
                    },
                    createdBy: queuedMessage.createdBy,
                    error: null,
                    createdAt: now,
                    updatedAt: now,
                    consumedAt: now,
                  },
                },
                {
                  type: "context-handoff.updated" as const,
                  threadId,
                  runId: queuedRun.id,
                  providerInstanceId: queuedRun.providerInstanceId,
                  occurredAt: now,
                  payload: handoff,
                },
              ]),
          ...(legacyImportRecoveryHandoff === null
            ? []
            : [
                {
                  type: "context-handoff.updated" as const,
                  threadId,
                  runId: queuedRun.id,
                  providerInstanceId: queuedRun.providerInstanceId,
                  occurredAt: now,
                  payload: legacyImportRecoveryHandoff,
                },
              ]),
          ...(supersededForkTransfer === undefined
            ? []
            : [
                forkTransferSupersededEvent(
                  supersededForkTransfer,
                  queuedRun.id,
                  queuedRun.providerInstanceId,
                  now,
                ),
              ]),
          ...(handoffTurnItem === null
            ? []
            : [
                {
                  type: "turn-item.updated" as const,
                  threadId,
                  runId: queuedRun.id,
                  nodeId: rootNodeId,
                  providerInstanceId: queuedRun.providerInstanceId,
                  occurredAt: now,
                  payload: handoffTurnItem,
                },
              ]),
          ...sessionsToDetach.map((session) => ({
            type: "provider-session.detached" as const,
            threadId,
            driver: session.driver,
            providerInstanceId: session.providerInstanceId,
            occurredAt: now,
            payload: {
              providerSessionId: session.id,
              detachedAt: now,
              reason: detachReason,
            },
          })),
          ...executionIdentityEvents,
          {
            type: "provider-thread.updated",
            threadId,
            providerInstanceId: queuedRun.providerInstanceId,
            occurredAt: now,
            payload: providerThread,
          },
          {
            type: "turn-item.updated",
            threadId,
            runId: queuedRun.id,
            nodeId: rootNodeId,
            providerInstanceId: queuedRun.providerInstanceId,
            occurredAt: now,
            payload: notificationTurnItem(
              userTurnItem,
              queuedMessage,
              yield* notificationTasks(threadId, queuedMessage, projection.subagents),
            ),
          },
          {
            type: "run.updated",
            threadId,
            runId: queuedRun.id,
            nodeId: rootNodeId,
            providerInstanceId: queuedRun.providerInstanceId,
            occurredAt: now,
            payload: startingRun,
          },
        ],
        [
          ...sessionsToDetach.map((session) => ({
            id: `effect:${commandId}:provider-session.detach:${session.id}`,
            commandId,
            threadId,
            request: {
              type: "provider-session.detach" as const,
              providerSessionId: session.id,
              detail: detachReason,
            },
          })),
          {
            // A restart can return this run to the queue after its previous start effect was cancelled.
            id: `effect:${commandId}:provider-turn.start:${queuedRun.id}:${yield* idAllocator.allocate.event({ threadId, commandId })}`,
            commandId,
            threadId,
            request: { type: "provider-turn.start", runId: queuedRun.id },
          },
        ],
      );
    },
    (effect, threadId, options?) =>
      effect.pipe(
        Effect.catch((cause) => failQueuedRunStart(threadId, cause, options?.queuedRunId)),
      ),
  );

  // A provider failure hold leaves buffered wakes unheld, so a second pass starts the first one.
  const startNextQueuedRun = (...args: Parameters<typeof startNextQueuedRunOnce>) =>
    startNextQueuedRunOnce(...args).pipe(
      Effect.flatMap((wakeLeftUnheld) =>
        wakeLeftUnheld === true ? startNextQueuedRunOnce(args[0]) : Effect.void,
      ),
    );

  // Under load a resumed provider can time out before taking the prompt; the restart still owes the turn.
  const retryContinuationStart = Effect.fn("Orchestrator.retryContinuationStart")(function* (
    threadId: ThreadId,
    runId: RunId,
  ) {
    const projection = yield* projectionStore.getThreadRecords(
      threadId,
      ["runs", "providerTurns", "turnItems"],
      { turnItemTypes: ["error"], turnItemRunIds: [runId] },
    );
    const run = projection.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) return;
    const delayMs = continuationStartRetryDelayMs(run, projection);
    if (delayMs === undefined) return;
    const commandId = CommandId.make(`command:restart-continuation-retry:${run.id}`);
    // A start retry is not a crash: carry the crash budget forward unchanged.
    const previous =
      run.restartContinuationOfRunId === undefined
        ? undefined
        : Option.getOrUndefined(
            yield* effectOutbox.get(
              `effect:restart-continuation:${run.restartContinuationOfRunId}`,
            ),
          )?.request;
    const processLossCount =
      previous?.type === "provider-runtime.continue" ? previous.processLossCount : undefined;
    yield* writeSystemEvents(
      [],
      [
        {
          id: `effect:restart-continuation:${run.id}`,
          commandId,
          threadId,
          request: {
            type: "provider-runtime.continue",
            sourceRunId: run.id,
            ...(processLossCount === undefined ? {} : { processLossCount }),
          },
          availableAt: DateTime.add(yield* DateTime.now, { milliseconds: delayMs }),
        },
      ],
    );
  });

  // A hold waits for a person to review what they queued. Nobody reviews messages from agents,
  // the server or scheduled tasks, so a later completed run releases those unless it was stopped.
  const releaseUnattendedHolds = Effect.fn("Orchestrator.releaseUnattendedHolds")(function* (
    threadId: ThreadId,
    completedRunId: RunId,
  ) {
    const held = yield* projectionStore.getHeldQueuedRuns(threadId);
    if (held.length === 0) return;
    const projection = yield* projectionStore.getThreadRecords(
      threadId,
      ["runs", "messages", "turnItems"],
      {
        messageIds: held.map((run) => run.userMessageId),
        turnItemTypes: ["run_interrupt_request"],
        turnItemRunIds: [completedRunId],
      },
    );
    // Only the newest run completing shows the thread moved past the hold; a late or
    // bookkeeping update to an older run, overtaken by a failure or Stop, does not.
    if (
      latestExecutedRun(projection.runs)?.id !== completedRunId ||
      projection.turnItems.length > 0 ||
      worktreeSetupPending(projection)
    )
      return;
    const { messages } = projection;
    const unattended = new Set(
      messages
        .filter((message) => message.createdBy !== "user" || message.scheduledTaskId !== undefined)
        .map((message) => message.id),
    );
    const now = yield* DateTime.now;
    const released = held.filter((run) => unattended.has(run.userMessageId));
    if (released.length === 0) return;
    yield* writeSystemEvents(
      released.map((run) => ({
        type: "run.updated" as const,
        threadId,
        runId: run.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: { ...run, queueHeld: false },
      })),
    );
  });

  // A steer still pending after its run ended was never read: the provider marks one it read
  // completed, and one Stop dropped cancelled. It runs next, in its place among waiting messages.
  const requeueUnreadSteers = Effect.fn("Orchestrator.requeueUnreadSteers")(function* (
    threadId: ThreadId,
    runIds?: ReadonlyArray<RunId>,
  ) {
    const { turnItems } = yield* projectionStore.getThreadRecords(threadId, ["turnItems"], {
      turnItemTypes: ["user_message"],
      turnItemStatuses: ["pending"],
      ...(runIds === undefined ? {} : { turnItemRunIds: runIds }),
    });
    const unread = turnItems.filter(
      (item) =>
        item.type === "user_message" &&
        (item.inputIntent === "steer" || item.inputIntent === "promoted_queued_to_steer"),
    );
    if (unread.length === 0) return;
    const projection = yield* projectionStore.getThreadRecords(threadId, ["runs", "messages"], {
      messageIds: unread.flatMap((item) => (item.type === "user_message" ? [item.messageId] : [])),
    });
    const placed = [];
    for (const item of unread) {
      const run = projection.runs.find((candidate) => candidate.id === item.runId);
      const message = projection.messages.find(
        (candidate) =>
          item.type === "user_message" &&
          candidate.id === item.messageId &&
          candidate.runId === item.runId,
      );
      if (
        run === undefined ||
        message === undefined ||
        isActiveRun(run) ||
        (yield* awaitsCheckpointCapture(run))
      ) {
        continue;
      }
      // Stop drops a steer it reached; say so, as the adapter does for steers it still held.
      if (yield* projectionStore.hasRunInterruptRequest(threadId, run.id)) {
        const now = yield* DateTime.now;
        yield* writeSystemEvents([
          {
            type: "turn-item.updated",
            threadId,
            runId: run.id,
            ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...item, status: "cancelled" as const, completedAt: now, updatedAt: now },
          },
          {
            type: "turn-item.updated",
            threadId,
            runId: run.id,
            ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: {
              id: idAllocator.derive.runSignalTurnItem({
                runId: run.id,
                signal: `unread-steer:${message.id}`,
              }),
              threadId,
              runId: run.id,
              nodeId: item.nodeId,
              providerThreadId: item.providerThreadId ?? null,
              providerTurnId: item.providerTurnId ?? null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: item.ordinal,
              type: "system_notice" as const,
              status: "completed" as const,
              title: "Steer delivery not confirmed",
              message: `The agent did not confirm reading your steer before Stop. It may not have been delivered. Resend it if needed: "${message.text}"`,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          },
        ]);
        continue;
      }
      // The message's first steer effect recorded which runs were queued before it was sent; a
      // queued message that was promoted also stays behind only the runs queued before its own.
      const firstSteer = Option.getOrUndefined(
        yield* effectOutbox.firstSteer(threadId, message.id),
      )?.request;
      const steer = firstSteer?.type === "provider-turn.steer" ? firstSteer : undefined;
      const afterRunOrdinal = Math.max(
        0,
        Math.min(
          steer?.steerFollowUpAfterRunOrdinal ??
            Math.max(...projection.runs.map((candidate) => candidate.ordinal)),
          ...projection.runs.flatMap((candidate) =>
            candidate.userMessageId === message.id ? [candidate.ordinal - 1] : [],
          ),
        ),
      );
      placed.push({ item, run, message, steer, afterRunOrdinal });
    }
    // Each requeue starts the queue once it commits, so earlier places go first.
    placed.sort(
      (left, right) =>
        left.afterRunOrdinal - right.afterRunOrdinal || left.item.ordinal - right.item.ordinal,
    );
    for (const { run, message, steer, afterRunOrdinal } of placed) {
      yield* callbacks
        .dispatchWithReceiptEffect({
          type: "message.dispatch",
          commandId: CommandId.make(`command:unread-steer:${run.id}:${message.id}`),
          threadId,
          messageId: message.id,
          steerFollowUpOfRunId: run.id,
          steerFollowUpAfterRunOrdinal: afterRunOrdinal,
          ...(message.followsThreadSelection === true
            ? {}
            : { modelSelection: steer?.modelSelection ?? run.modelSelection }),
          text: message.text,
          ...(message.context ? { context: message.context } : {}),
          attachments: message.attachments,
          ...(message.delegatedCompletion === undefined
            ? {}
            : { delegatedCompletion: message.delegatedCompletion }),
          ...(message.notification === undefined ? {} : { notification: message.notification }),
          dispatchMode: { type: "queue_after_active" },
          createdBy: message.createdBy,
          creationSource: message.creationSource,
          ...(message.scheduledTaskId === undefined
            ? {}
            : { scheduledTaskId: message.scheduledTaskId }),
          ...(message.senderThreadId === undefined
            ? {}
            : { senderThreadId: message.senderThreadId }),
          ...(message.linkedSender === undefined ? {} : { linkedSender: message.linkedSender }),
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to requeue an unread steer", {
              threadId,
              messageId: message.id,
              cause,
            }),
          ),
        );
    }
  });

  const resumeQueuedRuns = Effect.gen(function* () {
    const threadIds = yield* projectionStore.getRecoveryThreadIds("queued-runs");
    let resumed = 0;
    for (const threadId of threadIds) {
      const resumedThread = yield* Effect.gen(function* () {
        if (!(yield* projectionStore.canStartQueuedRun(threadId))) return false;
        yield* threadDispatch.withLock(threadId, startNextQueuedRun(threadId));
        return true;
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to resume queued V2 run after recovery", {
            threadId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (resumedThread) {
        resumed += 1;
      }
    }
    return resumed;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestratorDispatchError({
          commandId: CommandId.make("command:system:resume-queued-runs"),
          commandType: "message.dispatch",
          cause,
        }),
    ),
  );

  return {
    isStaleQuestionWake,
    startNextQueuedRun,
    retryContinuationStart,
    releaseUnattendedHolds,
    requeueUnreadSteers,
    resumeQueuedRuns,
  };
}
