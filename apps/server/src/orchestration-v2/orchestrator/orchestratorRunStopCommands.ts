import {
  CommandId,
  isOrchestrationV2WorkActive,
  type NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type RunId,
  type ThreadId,
} from "@zerocode/contracts";
import {
  endOrphanedNativeSubagent,
  endRunlessRootTurns,
} from "@zerocode/provider-core/server/subagentProjection";
import {
  derivePendingBackgroundWork,
  pendingBackgroundTurnItems,
} from "@zerocode/shared/orchestrationV2PendingBackgroundWork";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@zerocode/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type {
  OrchestrationEffectRequestV2,
  PendingOrchestrationEffectV2,
} from "../EffectOutbox.ts";
import { isBufferedProviderNotification } from "../NotificationMailbox.ts";
import { isAutomaticCompletionRun, queuedRunsInDeliveryOrder } from "../QueuedRunOrder.ts";
import * as RunExecutionService from "../RunExecutionService.ts";
import { makeInterruptResultTurnItem } from "../runInterruptResult.ts";
import {
  cancelledAppOwnedTask,
  delegatedTasksStopEffect,
  hasLiveRun,
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorProviderAdapterError,
  type OrchestratorShared,
  type OrchestratorV2Error,
  withPullRequestWatch,
  WORKSPACE_PREPARATION_INPUT,
} from "./orchestratorShared.ts";

type DyingNativeSubagent = {
  readonly projection: Pick<OrchestrationV2ThreadProjection, "nodes" | "subagents" | "turnItems">;
  readonly subagent: Pick<
    Extract<OrchestrationV2TurnItem, { readonly type: "subagent" }>,
    "subagentId" | "origin" | "childThreadId" | "providerInstanceId"
  >;
};

const nativeSubagentRef = (subagent: OrchestrationV2Subagent): DyingNativeSubagent["subagent"] => ({
  subagentId: subagent.id,
  origin: subagent.origin,
  childThreadId: subagent.childThreadId,
  providerInstanceId: subagent.providerInstanceId,
});

interface RunStopCommandCallbacks {
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
  readonly closePendingLinkRequests: (input: {
    readonly command: OrchestrationV2ServerCommand;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly threadId: ThreadId;
    readonly now: DateTime.Utc;
  }) => Effect.Effect<void, OrchestratorDispatchError>;
  readonly dispatchQueuedRunCancel: (
    command: Extract<OrchestrationV2Command, { readonly type: "queued-run.cancel" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    disposes?: "wake" | "cohort",
  ) => Effect.Effect<void, OrchestratorV2Error>;
  readonly writeAppOwnedTask: (input: {
    readonly command: Extract<
      OrchestrationV2ServerCommand,
      { readonly type: "run.interrupt" | "thread.stop" | "subagent.stop" }
    >;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly task: OrchestrationV2Subagent;
    readonly nodes: ReadonlyArray<OrchestrationV2ExecutionNode>;
    readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly now: DateTime.Utc;
  }) => Effect.Effect<void, OrchestratorDispatchError>;
  readonly cancelIdleOrphans: (input: {
    readonly command: Extract<
      OrchestrationV2ServerCommand,
      { readonly type: "run.interrupt" | "thread.stop" }
    >;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly projection: Pick<OrchestrationV2ThreadProjection, "subagents" | "turnItems">;
  }) => Effect.Effect<void, OrchestratorProjectionError>;
}

export function makeRunStopCommands(
  shared: OrchestratorShared,
  callbacks: RunStopCommandCallbacks,
) {
  const {
    commandPolicy,
    idAllocator,
    projectionStore,
    providerSessions,
    awaitsRestartContinuation,
    emit,
    getProjectionWithPendingEvents,
    loadProjectionForCommand,
    mapDispatchError,
    nextTurnItemOrdinal,
    stopReachedRun,
  } = shared;

  // Ends each native subagent's record, its own thread's runless root turns, and the
  // subagents it started there, which a provider can record on that thread rather than its parent's.
  const endNativeSubagentTrees = Effect.fn("Orchestrator.endNativeSubagentTrees")(
    function* (input: {
      readonly command: Extract<
        OrchestrationV2ServerCommand,
        { readonly type: "run.interrupt" | "thread.background-work.settle" | "thread.stop" }
      >;
      readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
      readonly dying: ReadonlyArray<DyingNativeSubagent>;
      readonly childThreadIds: Set<ThreadId>;
      readonly now: DateTime.Utc;
    }) {
      const allocateEventId = () =>
        idAllocator.allocate.event({
          threadId: input.command.threadId,
          commandId: input.command.commandId,
        });
      const dying = [...input.dying];
      const { childThreadIds } = input;
      for (const { projection, subagent } of dying) {
        const ended = yield* endOrphanedNativeSubagent({
          projection,
          subagentId: subagent.subagentId,
          status: "interrupted",
          now: input.now,
          emitted: yield* Ref.get(input.events),
          allocateEventId,
        }).pipe(mapDispatchError(input.command));
        yield* Ref.update(input.events, (events) => [...events, ...ended]);
        const childThreadId = subagent.childThreadId;
        if (
          subagent.origin !== "provider_native" ||
          childThreadId === null ||
          childThreadIds.has(childThreadId)
        ) {
          continue;
        }
        childThreadIds.add(childThreadId);
        const child = yield* projectionStore
          .getThreadRecords(childThreadId, ["nodes", "providerTurns", "subagents", "turnItems"], {
            // Runless items are the subagent's; any run there is the user's own.
            turnItemRunIds: [null],
            turnItemStatuses: ["pending", "running", "waiting"],
          })
          .pipe(
            Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
            mapDispatchError(input.command),
          );
        if (child === null) continue;
        const childEnded = yield* endRunlessRootTurns({
          threadId: childThreadId,
          providerInstanceId: subagent.providerInstanceId,
          projection: child,
          status: "interrupted",
          now: input.now,
          emitted: yield* Ref.get(input.events),
          allocateEventId,
        }).pipe(mapDispatchError(input.command));
        yield* Ref.update(input.events, (events) => [...events, ...childEnded]);
        for (const nested of child.turnItems) {
          if (nested.type === "subagent") dying.push({ projection: child, subagent: nested });
        }
        for (const nested of child.subagents) {
          if (nested.origin === "provider_native" && nested.runId === null) {
            dying.push({ projection: child, subagent: nativeSubagentRef(nested) });
          }
        }
      }
    },
  );

  const settleBackgroundWork = Effect.fn("Orchestrator.settleBackgroundWork")(function* (input: {
    readonly command: Extract<
      OrchestrationV2ServerCommand,
      { readonly type: "run.interrupt" | "thread.background-work.settle" }
    >;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly projection: Pick<
      OrchestrationV2ThreadProjection,
      "runs" | "nodes" | "subagents" | "turnItems" | "providerThreads"
    >;
    readonly stoppedProviderThreadId: OrchestrationV2ProviderThread["id"] | null;
    readonly throughRunOrdinal: number;
    readonly now: DateTime.Utc;
  }) {
    const emitEvent = emit(input.events, input.command);
    const runOrdinals = new Map(input.projection.runs.map((run) => [run.id, run.ordinal]));
    const childThreadIds = new Set<ThreadId>();
    const liveness = new Map<string, boolean>();
    const hasLiveSession = Effect.fn("Orchestrator.hasLiveSession")(function* (
      providerThreadId: OrchestrationV2ProviderThread["id"],
    ) {
      const known = liveness.get(providerThreadId);
      if (known !== undefined) return known;
      const sessionId = input.projection.providerThreads.find(
        (candidate) => candidate.id === providerThreadId,
      )?.providerSessionId;
      const live =
        sessionId !== null &&
        sessionId !== undefined &&
        Option.isSome(
          yield* providerSessions.get(sessionId).pipe(Effect.orElseSucceed(() => Option.none())),
        );
      liveness.set(providerThreadId, live);
      return live;
    });
    const stillReportsBackgroundWork = Effect.fnUntraced(function* (
      providerThread: OrchestrationV2ProviderThread,
    ) {
      if (providerThread.providerSessionId == null) return false;
      const session = yield* providerSessions
        .get(providerThread.providerSessionId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(session) || session.value.hasPendingBackgroundWorkForThread === undefined) {
        return false;
      }
      return yield* (
        session.value
          .hasPendingBackgroundWorkForThread(providerThread)
          // A failed probe cannot confirm that the work ended.
          .pipe(Effect.catchCause(() => Effect.succeed(true)))
      );
    });
    for (const item of pendingBackgroundTurnItems({
      turnItems: input.projection.turnItems,
      runs: input.projection.runs,
    })) {
      const itemRunOrdinal = item.runId === null ? undefined : runOrdinals.get(item.runId);
      if (itemRunOrdinal !== undefined && itemRunOrdinal > input.throughRunOrdinal) continue;
      const providerThreadId = item.providerThreadId ?? null;
      if (
        providerThreadId !== null &&
        providerThreadId !== input.stoppedProviderThreadId &&
        (yield* hasLiveSession(providerThreadId))
      ) {
        continue;
      }
      const run = input.projection.runs.find((candidate) => candidate.id === item.runId);
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: input.command.threadId,
        ...(item.runId === null ? {} : { runId: item.runId }),
        ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
        ...(run === undefined ? {} : { providerInstanceId: run.providerInstanceId }),
        occurredAt: input.now,
        payload: {
          ...item,
          status: "interrupted",
          completedAt: input.now,
          updatedAt: input.now,
        },
      });
      if (item.type !== "subagent") continue;
      // A native subagent died with the process too.
      yield* endNativeSubagentTrees({
        command: input.command,
        events: input.events,
        dying: [{ projection: input.projection, subagent: item }],
        childThreadIds,
        now: input.now,
      });
    }
    for (const providerThread of input.projection.providerThreads) {
      if ((providerThread.pendingBackgroundTasks?.length ?? 0) === 0) continue;
      if (providerThread.id === input.stoppedProviderThreadId) {
        // A refused newer start can take ownership and reject the stopped
        // turn's roster clear. Reconcile it without hiding surviving work.
        if (yield* stillReportsBackgroundWork(providerThread)) continue;
      } else if (yield* hasLiveSession(providerThread.id)) {
        continue;
      }
      yield* emitEvent({
        type: "provider-thread.updated",
        threadId: input.command.threadId,
        driver: providerThread.driver,
        providerInstanceId: providerThread.providerInstanceId,
        occurredAt: input.now,
        payload: {
          ...providerThread,
          status:
            providerThread.status === "active" &&
            providerThread.lastRunOrdinal !== null &&
            providerThread.lastRunOrdinal <= input.throughRunOrdinal
              ? "idle"
              : providerThread.status,
          pendingBackgroundTasks: [],
          updatedAt: input.now,
        },
      });
    }
  });

  const runInterruptReason = Effect.fnUntraced(function* (
    command: Extract<
      OrchestrationV2ServerCommand,
      { readonly type: "run.interrupt" | "thread.background-work.settle" }
    >,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    runId: RunId,
  ) {
    const isRequest = (
      item: OrchestrationV2TurnItem,
    ): item is Extract<OrchestrationV2TurnItem, { readonly type: "run_interrupt_request" }> =>
      item.runId === runId && item.type === "run_interrupt_request";
    const pending = (yield* Ref.get(events))
      .flatMap((event) => (event.type === "turn-item.updated" ? [event.payload] : []))
      .findLast(isRequest);
    if (pending !== undefined) return pending.message;
    const { turnItems } = yield* projectionStore
      .getThreadRecords(command.threadId, ["turnItems"], {
        turnItemTypes: ["run_interrupt_request"],
        turnItemRunIds: [runId],
      })
      .pipe(mapDispatchError(command));
    return turnItems.find(isRequest)?.message;
  });

  // A successful Stop may have no terminal event to ingest: the session or
  // native turn already died, or its final write failed when storage filled.
  const settleInterruptedRun = Effect.fn("Orchestrator.settleInterruptedRun")(function* (input: {
    readonly command: Extract<
      OrchestrationV2ServerCommand,
      { readonly type: "run.interrupt" | "thread.background-work.settle" }
    >;
    readonly projection: Pick<
      OrchestrationV2ThreadProjection,
      | "runs"
      | "attempts"
      | "nodes"
      | "subagents"
      | "runtimeRequests"
      | "messages"
      | "turnItems"
      | "providerThreads"
    >;
    readonly providerTurn: OrchestrationV2ProviderTurn;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>;
    readonly now: DateTime.Utc;
  }) {
    const attempt = input.projection.attempts.find(
      (candidate) => candidate.id === input.providerTurn.runAttemptId,
    );
    const run = input.projection.runs.find((candidate) => candidate.id === attempt?.runId);
    const rootNode = input.projection.nodes.find((candidate) => candidate.id === run?.rootNodeId);
    if (
      attempt === undefined ||
      run === undefined ||
      rootNode === undefined ||
      run.activeAttemptId !== attempt.id ||
      run.status !== "running" ||
      attempt.status === "pending"
    )
      return;
    const emitEvent = emit(input.events, input.command);
    const base = {
      threadId: input.command.threadId,
      runId: run.id,
      nodeId: rootNode.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: input.now,
    };
    if (input.providerTurn.status === "running") {
      yield* emitEvent({
        ...base,
        type: "provider-turn.updated",
        payload: {
          ...input.providerTurn,
          status: "interrupted",
          completedAt: input.now,
        },
      });
    }
    // An attempt that already ended keeps its status; only its run was left running.
    if (attempt.status === "running") {
      yield* emitEvent({
        ...base,
        type: "run-attempt.updated",
        payload: {
          ...attempt,
          status: "interrupted",
          completedAt: input.now,
        },
      });
    }
    const providerThread = input.projection.providerThreads.find(
      (candidate) => candidate.id === input.providerTurn.providerThreadId,
    );
    if (providerThread?.status === "active" && providerThread.lastRunOrdinal === run.ordinal) {
      yield* emitEvent({
        ...base,
        type: "provider-thread.updated",
        payload: { ...providerThread, status: "idle", updatedAt: input.now },
      });
    }
    for (const message of input.projection.messages) {
      if (message.runId !== run.id || !message.streaming) continue;
      yield* emitEvent({
        ...base,
        ...(message.nodeId === null ? {} : { nodeId: message.nodeId }),
        type: "message.updated",
        payload: { ...message, streaming: false, updatedAt: input.now },
      });
    }
    const delegatedNodeIds = new Set(
      input.projection.subagents
        .filter((subagent) => subagent.origin === "app_owned")
        .map((subagent) => subagent.id),
    );
    // Callers load only tool and message items; the request cards close with the requests below.
    const requestCards = yield* projectionStore
      .getThreadRecords(run.threadId, ["turnItems"], {
        turnItemTypes: ["approval_request", "user_input_request"],
        turnItemRunIds: [run.id],
        turnItemStatuses: ["waiting"],
      })
      .pipe(mapDispatchError(input.command));
    const cascaded = yield* RunExecutionService.cascadeTerminalizeRunOwnedSubagents({
      run,
      status: "interrupted",
      completedAt: input.now,
      allocateEventId: () =>
        idAllocator.allocate.event({
          threadId: input.command.threadId,
          commandId: input.command.commandId,
        }),
      open: {
        subagents: new Map(
          input.projection.subagents
            .filter((task) => task.runId === run.id && task.origin !== "app_owned")
            .map((task) => [task.id, task]),
        ),
        nodes: new Map(
          input.projection.nodes
            .filter((node) => node.runId === run.id && !delegatedNodeIds.has(node.id))
            .map((node) => [node.id, node]),
        ),
        turnItems: new Map(),
        childTurnItems: new Map(
          [
            ...input.projection.turnItems.filter(
              (item) =>
                item.runId === run.id &&
                (item.type === "assistant_message" || item.type === "reasoning"),
            ),
            ...requestCards.turnItems,
          ].map((item) => [item.id, item]),
        ),
        linkedChildThreadIds: new Set([run.threadId]),
      },
    }).pipe(mapDispatchError(input.command));
    yield* Ref.update(input.events, (events) => [...events, ...cascaded]);
    for (const request of input.projection.runtimeRequests) {
      if (
        request.status !== "pending" ||
        !input.projection.nodes.some((node) => node.id === request.nodeId && node.runId === run.id)
      )
        continue;
      yield* emitEvent({
        ...base,
        nodeId: request.nodeId,
        type: "runtime-request.updated",
        payload: {
          ...request,
          status: "cancelled",
          resolvedAt: input.now,
          responseCapability: { type: "not_resumable", reason: "The run was interrupted." },
        },
      });
    }
    if (providerThread !== undefined) {
      yield* emitEvent({
        ...base,
        type: "turn-item.updated",
        payload: makeInterruptResultTurnItem({
          idAllocator,
          run,
          rootNode,
          providerThread,
          reason:
            (input.command.type === "thread.background-work.settle"
              ? input.command.reason
              : undefined) ?? (yield* runInterruptReason(input.command, input.events, run.id)),
          completedAt: input.now,
        }),
      });
    }
    const { delegatedCompletion: _delegatedCompletion, ...runWithoutDelegatedCompletion } = run;
    yield* emitEvent({
      ...base,
      type: "run.updated",
      payload: {
        ...runWithoutDelegatedCompletion,
        status: "interrupted",
        completedAt: input.now,
      },
    });
    const scopeId = rootNode.checkpointScopeId;
    if (scopeId !== null) {
      yield* Ref.update(input.effects, (effects) => [
        ...effects,
        {
          id: `effect:checkpoint.capture:${run.id}`,
          commandId: CommandId.make(`command:effect:checkpoint.capture:${run.id}`),
          threadId: input.command.threadId,
          request: {
            type: "checkpoint.capture",
            runId: run.id,
            scopeId,
          },
        } satisfies PendingOrchestrationEffectV2,
      ]);
    }
  });

  const markStoppedRun = Effect.fnUntraced(function* (input: {
    readonly command: Extract<
      OrchestrationV2ServerCommand,
      { readonly type: "run.interrupt" | "thread.stop" }
    >;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly thread: OrchestrationV2AppThread;
    readonly run: OrchestrationV2Run;
    readonly now: DateTime.Utc;
  }) {
    const { command, events, thread, run, now } = input;
    if (run.rootNodeId === null || run.providerThreadId === null) return;
    const pendingItems = (yield* Ref.get(events)).flatMap((event) =>
      event.type === "turn-item.updated" ? [event.payload] : [],
    );
    if (
      pendingItems.some((item) => item.runId === run.id && item.type === "run_interrupt_request") ||
      (yield* stopReachedRun(command, thread.id, run.id))
    ) {
      return;
    }
    yield* emit(
      events,
      command,
    )({
      type: "turn-item.updated",
      threadId: thread.id,
      runId: run.id,
      nodeId: run.rootNodeId,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: {
        id: idAllocator.derive.runSignalTurnItem({ runId: run.id, signal: "interrupt-request" }),
        threadId: thread.id,
        runId: run.id,
        nodeId: run.rootNodeId,
        providerThreadId: run.providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: yield* nextTurnItemOrdinal({ thread, turnItems: pendingItems }),
        status: "completed",
        title: "Interrupt requested",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "run_interrupt_request",
        message: command.reason ?? RunExecutionService.USER_STOP_REASON,
      },
    });
  });

  const holdStoppedThread = Effect.fn("Orchestrator.holdStoppedThread")(function* (input: {
    readonly command: Extract<
      OrchestrationV2ServerCommand,
      { readonly type: "run.interrupt" | "thread.stop" }
    >;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "subagents">;
    readonly cohortRunIds: ReadonlyArray<RunId>;
    readonly now: DateTime.Utc;
  }) {
    const emitEvent = emit(input.events, input.command);
    const { runs, subagents } = input.projection;
    let { thread } = input.projection;
    let recovery = thread.limitRecovery;
    const latest = latestExecutedRun(runs);
    if (latest?.status === "failed") {
      const { turnItems } = yield* projectionStore
        .getThreadRecords(thread.id, ["turnItems"], {
          turnItemTypes: ["error"],
          turnItemRunIds: [latest.id],
        })
        .pipe(mapDispatchError(input.command));
      const failure = latestRootProviderFailure(latest, turnItems);
      if (
        failure?.class === "usage_limit" &&
        failure.resetAt != null &&
        Number.isFinite(Date.parse(failure.resetAt)) &&
        (recovery?.runId !== latest.id || recovery.resetAt !== failure.resetAt)
      ) {
        recovery = {
          runId: latest.id,
          resetAt: failure.resetAt,
          autoResume: false,
          snooze: false,
        };
      }
    }
    if (recovery && (recovery !== thread.limitRecovery || recovery.autoResume)) {
      thread = {
        ...thread,
        limitRecovery: {
          ...recovery,
          autoResume: false,
          requestId: input.command.commandId,
        },
        updatedAt: input.now,
      };
      yield* emitEvent({
        type: "thread.metadata-updated",
        threadId: thread.id,
        occurredAt: input.now,
        payload: thread,
      });
    }
    const queuedRuns = runs.filter((run) => run.status === "queued");
    const queuedMessages =
      queuedRuns.length === 0
        ? []
        : (yield* projectionStore
            .getThreadRecords(thread.id, ["messages"], {
              messageIds: queuedRuns.map((run) => run.userMessageId),
            })
            .pipe(
              Effect.mapError(
                (cause) => new OrchestratorProjectionError({ threadId: thread.id, cause }),
              ),
            )).messages;
    const bufferedMessageIds = new Set(
      queuedMessages.filter(isBufferedProviderNotification).map((message) => message.id),
    );
    for (const run of runs) {
      // A resumed queue can have a lower ordinal than a pending continuation source.
      // Stop must reach those sources even when interrupting the resumed run succeeds.
      if (
        (run.status === "cancelled" ||
          (run.status === "failed" && run.restartContinuationOfRunId !== undefined)) &&
        (yield* awaitsRestartContinuation(run).pipe(mapDispatchError(input.command)))
      ) {
        yield* markStoppedRun({ ...input, thread, run });
      }
      if (run.status !== "queued") continue;
      if (bufferedMessageIds.has(run.userMessageId)) {
        yield* callbacks.dispatchQueuedRunCancel(
          {
            type: "queued-run.cancel",
            commandId: input.command.commandId,
            threadId: thread.id,
            runId: run.id,
          },
          input.events,
        );
        continue;
      }
      if (run.queueHeld === true) continue;
      yield* emitEvent({
        type: "run.updated",
        threadId: thread.id,
        runId: run.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: input.now,
        payload: { ...run, queueHeld: true },
      });
    }
    const pullRequests = thread.pullRequests ?? [];
    if (pullRequests.some((link) => link.watch !== undefined)) {
      yield* emitEvent({
        type: "thread.pull-request-synced",
        threadId: thread.id,
        providerInstanceId: thread.providerInstanceId,
        occurredAt: input.now,
        payload: {
          ...thread,
          pullRequests: pullRequests.map((link) => withPullRequestWatch(link, undefined)),
        },
      });
    }
    const cohortRunIds = new Set(input.cohortRunIds);
    for (const run of runs) {
      if (run.delegatedCompletion?.delivery != null) cohortRunIds.add(run.id);
    }
    for (const task of subagents) {
      const delivery = task.completionDelivery?.state;
      if (
        task.origin === "app_owned" &&
        task.runId !== null &&
        delivery !== "acknowledged" &&
        delivery !== "delivered" &&
        delivery !== "disposed"
      ) {
        cohortRunIds.add(task.runId);
      }
    }
    // Each disposal reads the events the ones before it wrote.
    for (const parentRunId of cohortRunIds) {
      yield* callbacks.disposeDelegatedCompletionCohort({
        command: input.command,
        events: input.events,
        projection: yield* getProjectionWithPendingEvents(thread.id, input.events),
        parentRunId,
        disposition: "stopped",
        now: input.now,
      });
    }
    yield* callbacks.closePendingLinkRequests({ ...input, threadId: thread.id });
  });

  const dispatchInterruptUnresponsive = Effect.fn("Orchestrator.dispatchInterruptUnresponsive")(
    function* (
      command: Extract<
        OrchestrationV2InternalCommand,
        { readonly type: "thread.interrupt.unresponsive" }
      >,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    ) {
      const { providerTurn } = yield* projectionStore
        .getProviderControlContext(command.threadId, {
          providerThreadId: command.providerThreadId,
          providerTurnId: command.providerTurnId,
        })
        .pipe(mapDispatchError(command));
      const { runs } = yield* projectionStore
        .getThreadRecords(command.threadId, ["runs"])
        .pipe(mapDispatchError(command));
      const run = runs.find(
        (candidate) =>
          providerTurn !== undefined && candidate.activeAttemptId === providerTurn.runAttemptId,
      );
      // A settled run still counts: Stop may have targeted its background work.
      if (run === undefined) return;
      const { turnItems } = yield* projectionStore
        .getThreadRecords(command.threadId, ["turnItems"], {
          turnItemTypes: ["run_interrupt_request", "run_interrupt_result"],
          turnItemRunIds: [run.id],
        })
        .pipe(mapDispatchError(command));
      // A provider that stopped late already wrote the result; it needs no Force stop.
      if (turnItems.some((item) => item.type === "run_interrupt_result")) return;
      const request = turnItems.find((item) => item.type === "run_interrupt_request");
      if (request?.type !== "run_interrupt_request" || request.unresponsiveAt !== undefined) return;
      const now = yield* DateTime.now;
      yield* emit(
        events,
        command,
      )({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: run.id,
        ...(request.nodeId === null ? {} : { nodeId: request.nodeId }),
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: { ...request, unresponsiveAt: now, updatedAt: now },
      });
    },
  );

  const dispatchBackgroundWorkSettle = Effect.fn("Orchestrator.dispatchBackgroundWorkSettle")(
    function* (
      command: Extract<
        OrchestrationV2InternalCommand,
        { readonly type: "thread.background-work.settle" }
      >,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
      effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    ) {
      const [projection, stopped] = yield* Effect.all([
        projectionStore.getThreadRecords(
          command.threadId,
          [
            "runs",
            "attempts",
            "nodes",
            "subagents",
            "runtimeRequests",
            "turnItems",
            "providerThreads",
          ],
          {
            turnItemTypes: [
              "command_execution",
              "dynamic_tool",
              "subagent",
              "assistant_message",
              "reasoning",
            ],
            turnItemStatuses: ["pending", "running", "waiting"],
          },
        ),
        projectionStore.getProviderControlContext(command.threadId, {
          providerThreadId: command.providerThreadId,
          providerTurnId: command.providerTurnId,
        }),
      ]).pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
        ),
      );
      if (command.subagent !== undefined) {
        const outcome = command.subagent.outcome;
        const subagent = projection.subagents.find((task) => task.id === command.subagent?.id);
        if (
          subagent?.origin !== "provider_native" ||
          !["pending", "running", "waiting"].includes(subagent.status) ||
          (subagent.startedAt !== null &&
            DateTime.toEpochMillis(subagent.startedAt) >
              DateTime.toEpochMillis(command.subagent.stoppedAt))
        )
          return;
        const now = yield* DateTime.now;
        const allocateEventId = () =>
          idAllocator.allocate.event({
            threadId: command.threadId,
            commandId: command.commandId,
          });
        const ended = yield* endOrphanedNativeSubagent({
          projection,
          subagentId: subagent.id,
          result: outcome.result,
          status: outcome.status,
          completedAt: outcome.completedAt,
          now,
          emitted: yield* Ref.get(events),
          allocateEventId,
        }).pipe(mapDispatchError(command));
        yield* Ref.update(events, (current) => [...current, ...ended]);
        if (subagent.childThreadId !== null) {
          const child = yield* projectionStore
            .getThreadRecords(subagent.childThreadId, ["nodes", "providerTurns", "turnItems"], {
              turnItemRunIds: [null],
              turnItemStatuses: ["pending", "running", "waiting"],
            })
            .pipe(
              Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
              mapDispatchError(command),
            );
          if (child !== null) {
            const childEnded = yield* endRunlessRootTurns({
              threadId: subagent.childThreadId,
              providerInstanceId: subagent.providerInstanceId,
              projection: child,
              status: outcome.status,
              completedAt: outcome.completedAt,
              now,
              emitted: yield* Ref.get(events),
              allocateEventId,
            }).pipe(mapDispatchError(command));
            yield* Ref.update(events, (current) => [...current, ...childEnded]);
          }
        }
        return;
      }
      const stoppedRunId = projection.attempts.find(
        (attempt) => attempt.id === stopped.providerTurn?.runAttemptId,
      )?.runId;
      const stoppedRun = projection.runs.find((run) => run.id === stoppedRunId);
      if (
        stoppedRun === undefined ||
        (["preparing", "starting", "running"].includes(stoppedRun.status) &&
          stoppedRun.activeAttemptId !== stopped.providerTurn?.runAttemptId)
      )
        return;
      const now = yield* DateTime.now;
      if (stopped.providerTurn !== undefined && stoppedRun.status === "running") {
        const output = yield* projectionStore
          .getThreadRecords(command.threadId, ["messages"], {
            messageRunIds: [stoppedRun.id],
            messageRoles: ["assistant"],
          })
          .pipe(mapDispatchError(command));
        yield* settleInterruptedRun({
          command,
          projection: { ...projection, messages: output.messages },
          providerTurn: stopped.providerTurn,
          events,
          effects,
          now,
        });
      }
      // A new turn may have started since Stop; its work is not this Stop's.
      if (
        projection.runs.some(
          (run) =>
            run.id !== stoppedRun.id &&
            (run.status === "preparing" || run.status === "starting" || run.status === "running"),
        )
      ) {
        return;
      }
      yield* settleBackgroundWork({
        command,
        events,
        projection,
        stoppedProviderThreadId: command.providerThreadId,
        throughRunOrdinal: stoppedRun.ordinal,
        now,
      });
    },
  );

  const dispatchSubagentStop = Effect.fn("Orchestrator.dispatchSubagentStop")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "subagent.stop" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const projection = yield* loadProjectionForCommand(command, [
      "runs",
      "subagents",
      "providerThreads",
      "providerTurns",
    ]);
    const run = projection.runs.find((candidate) => candidate.id === command.runId);
    const subagent = projection.subagents.find((candidate) => candidate.id === command.subagentId);
    // User Stop cancels app-owned tasks with no bound child run unless they are the child's
    // original task, regardless of other child work. Bound runs keep their settlement path
    // because results may still arrive; the client's next child stop interrupts the run.
    // Rewrite ended tasks so clients with stale copies see them end.
    if (
      subagent?.origin === "app_owned" &&
      subagent.childThreadId !== null &&
      subagent.runId === command.runId
    ) {
      const childThreadId = subagent.childThreadId;
      const child = yield* projectionStore.getThreadRecords(childThreadId, ["runs"]).pipe(
        Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: childThreadId, cause }),
        ),
      );
      const active = isOrchestrationV2WorkActive(subagent.status);
      if (
        active &&
        child !== null &&
        ((child.thread.forkedFrom?.type === "node" &&
          child.thread.forkedFrom.nodeId === subagent.id) ||
          child.runs.some((run) => run.delegatedTaskId === subagent.id))
      )
        return;
      const records = yield* loadProjectionForCommand(command, ["nodes", "turnItems"], {
        turnItemTypes: ["subagent"],
        turnItemRunIds: [subagent.runId],
        omitSettledLeafNodes: true,
      });
      const now = yield* DateTime.now;
      return yield* callbacks.writeAppOwnedTask({
        command,
        events,
        task: active ? cancelledAppOwnedTask(subagent, now) : subagent,
        nodes: records.nodes,
        turnItems: records.turnItems,
        now,
      });
    }
    if (
      subagent === undefined ||
      subagent.runId !== command.runId ||
      subagent.origin !== "provider_native" ||
      subagent.driver !== "claudeAgent" ||
      subagent.nativeTaskRef?.strength !== "strong" ||
      subagent.nativeTaskRef.nativeId === null
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "The requested native subagent cannot be stopped on this run.",
      });
    }
    if (!["pending", "running", "waiting"].includes(subagent.status)) return;
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === run?.providerThreadId,
    );
    const providerTurn = projection.providerTurns.findLast(
      (candidate) => candidate.providerThreadId === providerThread?.id,
    );
    if (
      providerThread?.providerSessionId == null ||
      providerTurn === undefined ||
      providerThread.driver !== subagent.driver ||
      providerThread.providerInstanceId !== subagent.providerInstanceId
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "The requested native subagent has no owning provider session.",
      });
    }
    const providerSessionId = providerThread.providerSessionId;
    const nativeTaskId = subagent.nativeTaskRef.nativeId;
    const now = yield* DateTime.now;
    yield* emit(
      events,
      command,
    )({
      type: "subagent.updated",
      threadId: command.threadId,
      runId: command.runId,
      nodeId: subagent.id,
      providerInstanceId: subagent.providerInstanceId,
      occurredAt: now,
      payload: { ...subagent, updatedAt: now },
    });
    yield* Ref.update(effects, (existing) => [
      ...existing,
      {
        id: `effect:${command.commandId}:subagent.stop:${subagent.id}`,
        commandId: command.commandId,
        threadId: command.threadId,
        request: {
          type: "provider-turn.interrupt",
          providerSessionId,
          providerThreadId: providerThread.id,
          providerTurnId: providerTurn.id,
          subagent: { id: subagent.id, nativeTaskId },
        },
      } satisfies PendingOrchestrationEffectV2,
    ]);
    return;
  });

  const dispatchRunInterrupt = Effect.fn("Orchestrator.dispatchRunInterrupt")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "run.interrupt" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const projection = yield* loadProjectionForCommand(
      command,
      [
        "runs",
        "nodes",
        "providerThreads",
        "providerTurns",
        "messages",
        "attempts",
        "turnItems",
        "subagents",
        "runtimeRequests",
      ],
      // Thread-wide, like the Waiting strip: a settled thread's background
      // work can belong to an earlier run than the one Stop targets.
      {
        turnItemTypes: [
          "command_execution",
          "dynamic_tool",
          "subagent",
          "assistant_message",
          "reasoning",
        ],
        turnItemStatuses: ["pending", "running", "waiting"],
        // Stop reads root nodes and ends open ones; a settled leaf has nothing left to end.
        omitSettledLeafNodes: true,
      },
    );
    const run = projection.runs.find((candidate) => candidate.id === command.runId);
    const rootNode =
      run?.rootNodeId === null
        ? undefined
        : projection.nodes.find((candidate) => candidate.id === run?.rootNodeId);
    const providerThread =
      run?.providerThreadId === null
        ? undefined
        : projection.providerThreads.find((candidate) => candidate.id === run?.providerThreadId);
    const hasBackgroundWork =
      run?.id === projection.runs.findLast((candidate) => candidate.status !== "queued")?.id &&
      derivePendingBackgroundWork({
        latestRun: run,
        providerThreads: projection.providerThreads,
        turnItems: projection.turnItems,
        activeProviderThreadId: projection.thread.activeProviderThreadId,
        runs: projection.runs,
      }).length > 0;
    // A failed start has no provider turn. Background work still belongs
    // to the provider thread, so Stop reaches its latest accepted turn.
    const providerTurn =
      projection.providerTurns.findLast(
        (candidate) =>
          candidate.runAttemptId === run?.activeAttemptId &&
          (run?.status === "running" || candidate.status === "running" || hasBackgroundWork),
      ) ??
      (hasBackgroundWork
        ? projection.providerTurns.findLast(
            (candidate) => candidate.providerThreadId === run?.providerThreadId,
          )
        : undefined);
    if (run === undefined || rootNode === undefined || providerThread === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Run ${command.runId} is not interruptible.`,
      });
    }
    const now = yield* DateTime.now;
    const completionMessage = projection.messages.find(
      (candidate) => candidate.id === run.userMessageId,
    );
    const completionCohortRunId = completionMessage?.delegatedCompletion?.parentRunId ?? run.id;
    const stopRemainingWork = () =>
      command.holdQueue === true
        ? holdStoppedThread({
            command,
            events,
            projection,
            cohortRunIds: [completionCohortRunId],
            now,
          })
        : Effect.gen(function* () {
            for (const parentRunId of new Set([completionCohortRunId, run.id])) {
              yield* callbacks.disposeDelegatedCompletionCohort({
                command,
                events,
                projection: yield* getProjectionWithPendingEvents(command.threadId, events),
                parentRunId,
                disposition: "stopped",
                now,
                ...(parentRunId !== run.id && completionMessage?.delegatedCompletion !== undefined
                  ? { interruptedWakeTaskIds: completionMessage.delegatedCompletion.taskIds }
                  : {}),
              });
            }
          });

    const emitEvent = emit(events, command);
    const interruptRequestItem: OrchestrationV2TurnItem = {
      id: idAllocator.derive.runSignalTurnItem({
        runId: run.id,
        signal: "interrupt-request",
      }),
      threadId: command.threadId,
      runId: run.id,
      nodeId: rootNode.id,
      providerThreadId: providerThread.id,
      providerTurnId: providerTurn?.id ?? null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: yield* nextTurnItemOrdinal(projection),
      status: "completed",
      title: "Interrupt requested",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "run_interrupt_request",
      message: command.reason ?? RunExecutionService.USER_STOP_REASON,
    };

    const otherProviderInterrupts: Array<PendingOrchestrationEffectV2> = [];
    if (hasBackgroundWork || command.holdQueue === true) {
      const runOrdinals = new Map(
        projection.runs.map((candidate) => [candidate.id, candidate.ordinal]),
      );
      const runOrdinalOf = (item: (typeof projection.turnItems)[number]) =>
        item.runId === null ? -1 : (runOrdinals.get(item.runId) ?? -1);
      // Interrupt each provider thread at its latest pending turn so settlement covers all its work.
      // Use the item's provider turn: native subagent items name the child thread but the parent turn,
      // and interrupting the parent turn reaches the subagent.
      const latestTurnByProviderThread = new Map<
        OrchestrationV2ProviderThread["id"],
        { readonly turn: (typeof projection.providerTurns)[number]; readonly runOrdinal: number }
      >();
      for (const item of pendingBackgroundTurnItems({
        turnItems: projection.turnItems,
        runs: projection.runs,
      })) {
        const turn = projection.providerTurns.find(
          (candidate) => candidate.id === item.providerTurnId,
        );
        if (turn === undefined || turn.providerThreadId === providerThread.id) continue;
        const runOrdinal = runOrdinalOf(item);
        const latest = latestTurnByProviderThread.get(turn.providerThreadId);
        if (latest === undefined || runOrdinal > latest.runOrdinal) {
          latestTurnByProviderThread.set(turn.providerThreadId, { turn, runOrdinal });
        }
      }
      for (const { turn } of latestTurnByProviderThread.values()) {
        const owner = projection.providerThreads.find(
          (candidate) => candidate.id === turn.providerThreadId,
        );
        if (owner === undefined || owner.providerSessionId === null) continue;
        const ownerSession = yield* providerSessions
          .get(owner.providerSessionId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(ownerSession)) continue;
        otherProviderInterrupts.push({
          id: `effect:${command.commandId}:provider-turn.interrupt:${turn.id}`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: {
            type: "provider-turn.interrupt",
            providerSessionId: owner.providerSessionId,
            providerThreadId: owner.id,
            providerTurnId: turn.id,
          },
        });
      }
    }

    if (
      providerTurn === undefined &&
      (run.status === "preparing" || run.status === "starting" || run.status === "running")
    ) {
      const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      if (attempt === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} has no active attempt to interrupt.`,
        });
      }
      const interruptResultItem: OrchestrationV2TurnItem = {
        id: idAllocator.derive.runSignalTurnItem({
          runId: run.id,
          signal: "interrupt-result",
        }),
        threadId: command.threadId,
        runId: run.id,
        nodeId: rootNode.id,
        providerThreadId: providerThread.id,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: interruptRequestItem.id,
        ordinal: interruptRequestItem.ordinal + 1,
        status: "interrupted",
        title: "Interrupted",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "run_interrupt_result",
        message: "Run interrupted before provider start",
      };
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: run.id,
        nodeId: rootNode.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: interruptRequestItem,
      });
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: run.id,
        nodeId: rootNode.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: interruptResultItem,
      });
      const preparationItem = projection.turnItems.find(
        (
          candidate,
        ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }> =>
          candidate.runId === run.id &&
          candidate.type === "command_execution" &&
          candidate.input === WORKSPACE_PREPARATION_INPUT &&
          candidate.status === "running",
      );
      if (preparationItem !== undefined) {
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: {
            ...preparationItem,
            status: "interrupted",
            title: "Workspace preparation interrupted",
            output: command.reason ?? "Interrupted before provider start",
            completedAt: now,
            updatedAt: now,
          },
        });
      }
      yield* emitEvent({
        type: "run-attempt.updated",
        threadId: command.threadId,
        runId: run.id,
        nodeId: rootNode.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: { ...attempt, status: "interrupted", completedAt: now },
      });
      yield* emitEvent({
        type: "node.updated",
        threadId: command.threadId,
        runId: run.id,
        nodeId: rootNode.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: { ...rootNode, status: "interrupted", completedAt: now },
      });
      yield* emitEvent({
        type: "run.updated",
        threadId: command.threadId,
        runId: run.id,
        nodeId: rootNode.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: { ...run, status: "interrupted", completedAt: now },
      });
      // Stop cancels a pending restart, so it must end the turn that restart could not stop.
      const supersededTurn = projection.providerTurns.findLast(
        (candidate) =>
          candidate.status === "running" &&
          projection.attempts.some(
            (attempt) => attempt.id === candidate.runAttemptId && attempt.runId === run.id,
          ),
      );
      const supersededOwner =
        supersededTurn === undefined
          ? undefined
          : projection.providerThreads.find(
              (candidate) => candidate.id === supersededTurn.providerThreadId,
            );
      if (
        supersededTurn !== undefined &&
        supersededOwner !== undefined &&
        supersededOwner.providerSessionId !== null &&
        Option.isSome(
          yield* providerSessions
            .get(supersededOwner.providerSessionId)
            .pipe(Effect.orElseSucceed(() => Option.none())),
        )
      ) {
        const id = `effect:${command.commandId}:provider-turn.interrupt:${supersededTurn.id}`;
        if (!otherProviderInterrupts.some((effect) => effect.id === id)) {
          otherProviderInterrupts.push({
            id,
            commandId: command.commandId,
            threadId: command.threadId,
            request: {
              type: "provider-turn.interrupt",
              providerSessionId: supersededOwner.providerSessionId,
              providerThreadId: supersededOwner.id,
              providerTurnId: supersededTurn.id,
            },
          });
        }
      }
      yield* stopRemainingWork();
      yield* Ref.update(effects, (existing) => [...existing, ...otherProviderInterrupts]);
      return {
        effectTypes: ["provider-turn.start", "provider-turn.restart"],
        reason: `Run ${run.id} was interrupted before its provider turn started.`,
      } satisfies {
        readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
        readonly reason: string;
      };
    }

    if (providerTurn === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Run ${command.runId} is not interruptible.`,
      });
    }
    const sessionOption =
      providerThread.providerSessionId === null
        ? Option.none()
        : yield* providerSessions.get(providerThread.providerSessionId).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorProviderAdapterError({
                  commandId: command.commandId,
                  providerInstanceId: run.providerInstanceId,
                  cause,
                }),
            ),
          );
    if (Option.isNone(sessionOption)) {
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: run.id,
        nodeId: rootNode.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: interruptRequestItem,
      });
      yield* stopRemainingWork();
      yield* settleInterruptedRun({ command, projection, providerTurn, events, effects, now });
      yield* settleBackgroundWork({
        command,
        events,
        projection,
        stoppedProviderThreadId: providerThread.id,
        throughRunOrdinal: run.ordinal,
        now,
      });
      yield* Ref.update(effects, (existing) => [...existing, ...otherProviderInterrupts]);
      return undefined;
    }
    if (providerThread.providerSessionId === null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Provider thread ${providerThread.id} has no active provider session.`,
      });
    }
    const providerSessionId = providerThread.providerSessionId;
    yield* mapDispatchError(command)(
      commandPolicy.ensureInterrupt({
        commandId: command.commandId,
        threadId: command.threadId,
        providerInstanceId: run.providerInstanceId,
        capabilities: sessionOption.value.providerSession.capabilities,
      }),
    );

    yield* emitEvent({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId: run.id,
      nodeId: rootNode.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: interruptRequestItem,
    });
    yield* stopRemainingWork();
    yield* Ref.update(effects, (existing) => [
      ...existing,
      {
        id: `effect:${command.commandId}:provider-turn.interrupt:${providerTurn.id}`,
        commandId: command.commandId,
        threadId: command.threadId,
        request: {
          type: "provider-turn.interrupt",
          providerSessionId,
          providerThreadId: providerThread.id,
          providerTurnId: providerTurn.id,
        },
      } satisfies PendingOrchestrationEffectV2,
      ...otherProviderInterrupts,
    ]);
    return undefined;
  });

  /** Puts a queued command first and, given a target, stops the run in its way. */
  const stopRunForQueuedCommand = Effect.fn("Orchestrator.stopRunForQueuedCommand")(
    function* (input: {
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
    }) {
      const { command, events, effects, projection, now, targetRunId } = input;
      const others = queuedRunsInDeliveryOrder(projection).filter(
        (run) => run.id !== input.queuedRunId && !isAutomaticCompletionRun(projection, run),
      );
      for (const [index, run] of others.entries()) {
        const queuePosition = index + 2;
        if (run.queuePosition === queuePosition) continue;
        yield* emit(
          events,
          command,
        )({
          type: "run.updated",
          threadId: command.threadId,
          runId: run.id,
          ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, queuePosition },
        });
      }
      if (targetRunId === undefined) return undefined;
      const interruptEvents = yield* Ref.make<Array<OrchestrationV2DomainEvent>>([]);
      const interruptEffects = yield* Ref.make<Array<PendingOrchestrationEffectV2>>([]);
      const interrupted = yield* Effect.exit(
        dispatchRunInterrupt(
          {
            type: "run.interrupt",
            commandId: command.commandId,
            threadId: command.threadId,
            runId: targetRunId,
            reason: input.reason,
          },
          interruptEvents,
          interruptEffects,
        ),
      );
      // A failed interrupt may have written part of its events, so they are kept apart.
      // The queued command then waits for the turn to end.
      if (Exit.isFailure(interrupted)) {
        yield* Effect.logWarning("queued command could not stop the running turn", {
          threadId: command.threadId,
          runId: targetRunId,
          cause: interrupted.cause,
        });
        return undefined;
      }
      const written = yield* Ref.get(interruptEvents);
      const enqueued = yield* Ref.get(interruptEffects);
      yield* Ref.update(events, (existing) => [...existing, ...written]);
      yield* Ref.update(effects, (existing) => [...existing, ...enqueued]);
      // Like Stop: a run stopped before its provider started also abandons that start.
      return interrupted.value;
    },
  );

  const dispatchThreadStop = Effect.fn("Orchestrator.dispatchThreadStop")(function* (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "thread.stop" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const projection = yield* projectionStore
      .getThreadRecords(command.threadId, ["runs", "providerThreads", "turnItems", "subagents"], {
        turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
        turnItemStatuses: ["pending", "running", "waiting"],
      })
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
        ),
      );
    if (projection.thread.deletedAt !== null) return undefined;
    // Queued after the interrupt, since a thread's effects run in order.
    const stopDelegatedTasks =
      command.stopDelegatedTasks === false ||
      !projection.subagents.some(
        (task) =>
          task.origin === "app_owned" &&
          (task.childThreadId !== null || task.remoteChild !== undefined),
      )
        ? Effect.void
        : Ref.update(effects, (existing) => [...existing, delegatedTasksStopEffect(command)]);
    const latestRun = projection.runs.findLast((run) => run.status !== "queued");
    const target =
      projection.runs.findLast(
        (run) =>
          run.status === "preparing" || run.status === "starting" || run.status === "running",
      ) ??
      (derivePendingBackgroundWork({
        latestRun,
        providerThreads: projection.providerThreads,
        turnItems: projection.turnItems,
        activeProviderThreadId: projection.thread.activeProviderThreadId,
        runs: projection.runs,
      }).length > 0
        ? latestRun
        : undefined);
    if (target !== undefined) {
      const interruptEvents = yield* Ref.make<Array<OrchestrationV2DomainEvent>>([]);
      const interruptEffects = yield* Ref.make<Array<PendingOrchestrationEffectV2>>([]);
      const interrupted = yield* Effect.exit(
        dispatchRunInterrupt(
          {
            type: "run.interrupt",
            commandId: command.commandId,
            threadId: command.threadId,
            runId: target.id,
            holdQueue: true,
            ...(command.reason === undefined ? {} : { reason: command.reason }),
          },
          interruptEvents,
          interruptEffects,
        ),
      );
      // A failed interrupt may have written part of its events, so they are kept apart.
      if (Exit.isSuccess(interrupted)) {
        const written = yield* Ref.get(interruptEvents);
        const enqueued = yield* Ref.get(interruptEffects);
        yield* Ref.update(events, (existing) => [...existing, ...written]);
        yield* Ref.update(effects, (existing) => [...existing, ...enqueued]);
        yield* callbacks.cancelIdleOrphans({ command, events, projection });
        yield* stopDelegatedTasks;
        return interrupted.value;
      }
      yield* Effect.logWarning("thread.stop could not interrupt the running turn", {
        threadId: command.threadId,
        runId: target.id,
        cause: interrupted.cause,
      });
    }
    const now = yield* DateTime.now;
    // Record that Stop reached the turn it could not interrupt and the thread's last executed
    // run, so a late tool call from their agent starts nothing.
    const executed = latestExecutedRun(projection.runs);
    const reached = new Map<RunId, OrchestrationV2Run>();
    if (target !== undefined) reached.set(target.id, target);
    if (executed !== null && !hasLiveRun({ runs: [executed] })) reached.set(executed.id, executed);
    for (const run of reached.values()) {
      yield* markStoppedRun({ command, events, thread: projection.thread, run, now });
    }
    // Record and item are written together, so an active record without a live item lost its end.
    const staleNative = (target === undefined ? projection.subagents : []).filter(
      (subagent) =>
        subagent.origin === "provider_native" &&
        subagent.runId !== null &&
        isOrchestrationV2WorkActive(subagent.status) &&
        !projection.turnItems.some(
          (item) => item.type === "subagent" && item.subagentId === subagent.id,
        ),
    );
    if (staleNative.length > 0) {
      const { nodes } = yield* projectionStore
        .getThreadRecords(command.threadId, ["nodes"])
        .pipe(mapDispatchError(command));
      const threadProjection = {
        nodes,
        subagents: projection.subagents,
        turnItems: projection.turnItems,
      };
      yield* endNativeSubagentTrees({
        command,
        events,
        dying: staleNative.map((subagent) => ({
          projection: threadProjection,
          subagent: nativeSubagentRef(subagent),
        })),
        childThreadIds: new Set(),
        now,
      });
    }
    yield* holdStoppedThread({ command, events, projection, cohortRunIds: [], now });
    yield* callbacks.cancelIdleOrphans({ command, events, projection });
    yield* stopDelegatedTasks;
    return undefined;
  });

  return {
    dispatchInterruptUnresponsive,
    dispatchBackgroundWorkSettle,
    dispatchSubagentStop,
    dispatchRunInterrupt,
    stopRunForQueuedCommand,
    dispatchThreadStop,
  };
}
