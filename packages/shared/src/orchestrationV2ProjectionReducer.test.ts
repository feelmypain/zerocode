import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  IsoDateTime,
  MessageId,
  NodeId,
  PositiveInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type ThreadPullRequestLink,
} from "@zerocode/contracts";
import * as DateTime from "effect/DateTime";

import {
  attributePendingBackgroundTasks,
  createEmptyOrchestrationV2ThreadProjection,
  reduceOrchestrationV2ThreadProjection,
  upsertProviderTurn,
} from "./orchestrationV2ProjectionReducer.ts";

const createdAt = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const later = DateTime.makeUnsafe("2026-06-20T00:05:00.000Z");
const threadId = ThreadId.make("thread-shared-reducer");
const runId = RunId.make("run-shared-reducer");
const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");

const baseThread: OrchestrationV2AppThread = {
  id: threadId,
  projectId: ProjectId.make("project-shared-reducer"),
  title: TrimmedNonEmptyString.make("Shared reducer"),
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt,
  updatedAt: createdAt,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};

const emptyProjection = createEmptyOrchestrationV2ThreadProjection({
  id: EventId.make("event-created"),
  type: "thread.created",
  threadId,
  occurredAt: createdAt,
  payload: baseThread,
});

const applyPullRequestLink = (thread: OrchestrationV2AppThread, link: ThreadPullRequestLink) => ({
  ...thread,
  pullRequests: [link],
});

const baseRun: OrchestrationV2Run = {
  id: runId,
  threadId,
  ordinal: PositiveInt.make(1),
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
  providerThreadId: null,
  userMessageId: MessageId.make("message-user"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "running",
  requestedAt: createdAt,
  startedAt: createdAt,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};

describe("reduceOrchestrationV2ThreadProjection", () => {
  it("preserves orchestrator activity timestamps on non-activity thread metadata events", () => {
    const link: ThreadPullRequestLink = {
      host: "github.com",
      repository: "feelmypain/zerocode",
      number: 7,
      url: "https://github.com/feelmypain/zerocode/pull/7",
      source: "manual",
      linkedAt: DateTime.formatIso(createdAt),
      snapshot: null,
      stack: null,
    };

    const nonActivityEvents: ReadonlyArray<OrchestrationV2DomainEvent> = [
      {
        id: EventId.make("event-pr-link"),
        type: "thread.pull-request-link-updated",
        threadId,
        occurredAt: later,
        payload: link,
      },
      {
        id: EventId.make("event-reorder"),
        type: "thread.active-reordered",
        threadId,
        occurredAt: later,
        payload: { ...baseThread, activeOrderKey: TrimmedNonEmptyString.make("a0") },
      },
      {
        id: EventId.make("event-tags"),
        type: "thread.tags-updated",
        threadId,
        occurredAt: later,
        payload: { ...baseThread, tags: [] },
      },
      {
        id: EventId.make("event-pr-sync"),
        type: "thread.pull-request-synced",
        threadId,
        occurredAt: later,
        payload: { ...baseThread, pullRequests: [link] },
      },
      {
        id: EventId.make("event-issue-sync"),
        type: "thread.issue-synced",
        threadId,
        occurredAt: later,
        payload: baseThread,
      },
      {
        id: EventId.make("event-visited"),
        type: "thread.visited",
        threadId,
        occurredAt: later,
        payload: { ...baseThread, lastVisitedAt: later },
      },
      {
        id: EventId.make("event-unread"),
        type: "thread.marked-unread",
        threadId,
        occurredAt: later,
        payload: baseThread,
      },
    ];

    for (const touchThreadUpdatedAt of [true, false]) {
      for (const event of nonActivityEvents) {
        const result = reduceOrchestrationV2ThreadProjection(emptyProjection, event, {
          applyThreadPullRequestLinkUpdate: applyPullRequestLink,
          touchThreadUpdatedAt,
        });
        expect(result.projection.updatedAt).toEqual(createdAt);
        expect(result.projection.thread.updatedAt).toEqual(createdAt);
      }
    }
  });

  it("preserves run recorded fields across lifecycle updates in both server and client modes", () => {
    const seeded = {
      ...emptyProjection,
      runs: [
        {
          ...baseRun,
          delegatedCompletion: {
            disposition: "open" as const,
            nextGeneration: PositiveInt.make(2),
            delivery: null,
          },
          restartCancelledBackgroundWork: [
            { kind: "shell" as const, label: TrimmedNonEmptyString.make("dev server") },
          ],
          output: {
            value: { ok: true },
            submittedAt: IsoDateTime.make(DateTime.formatIso(createdAt)),
          },
        },
      ],
    };

    for (const visibleTurnItemsMode of ["local-rebuild", "incremental"] as const) {
      const reduced = reduceOrchestrationV2ThreadProjection(
        seeded,
        {
          id: EventId.make("event-run-complete"),
          type: "run.updated",
          threadId,
          runId,
          occurredAt: later,
          payload: { ...baseRun, status: "completed", completedAt: later },
        },
        {
          applyThreadPullRequestLinkUpdate: applyPullRequestLink,
          touchThreadUpdatedAt: visibleTurnItemsMode === "local-rebuild",
          visibleTurnItemsMode,
        },
      );
      expect(reduced.projection.runs[0]?.status).toBe("completed");
      expect(reduced.projection.runs[0]?.delegatedCompletion).toEqual(
        seeded.runs[0]!.delegatedCompletion,
      );
      expect(reduced.projection.runs[0]?.restartCancelledBackgroundWork).toEqual(
        seeded.runs[0]!.restartCancelledBackgroundWork,
      );
      expect(reduced.projection.runs[0]?.output).toEqual(seeded.runs[0]!.output);
    }
  });

  it("preserves subagent completionDelivery while restoring deduped bodies", () => {
    const subagentId = NodeId.make("subagent-1");
    const existing: OrchestrationV2Subagent = {
      id: subagentId,
      threadId,
      runId,
      parentNodeId: NodeId.make("root-node"),
      origin: "app_owned",
      createdBy: "agent",
      driver,
      providerInstanceId,
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "full prompt",
      title: null,
      model: null,
      status: "completed",
      result: "full result",
      completionDelivery: { state: "acknowledged", observedByRunId: runId },
      startedAt: createdAt,
      completedAt: createdAt,
      updatedAt: createdAt,
    };
    const seeded = { ...emptyProjection, subagents: [existing] };

    const reduced = reduceOrchestrationV2ThreadProjection(
      seeded,
      {
        id: EventId.make("event-subagent"),
        type: "subagent.updated",
        threadId,
        runId,
        occurredAt: later,
        payload: {
          ...existing,
          prompt: "",
          promptOmitted: true,
          completionDelivery: undefined,
          updatedAt: later,
        },
      },
      {
        applyThreadPullRequestLinkUpdate: applyPullRequestLink,
        visibleTurnItemsMode: "incremental",
      },
    );

    expect(reduced.projection.subagents[0]?.prompt).toBe("full prompt");
    expect(reduced.projection.subagents[0]?.completionDelivery).toEqual(
      existing.completionDelivery,
    );
  });

  it("attributes pending background tasks to the run they first appeared under", () => {
    const firstRun = RunId.make("run-1");
    const secondRun = RunId.make("run-2");
    const taskA = TrimmedNonEmptyString.make("task-a");
    const taskB = TrimmedNonEmptyString.make("task-b");
    const providerThread: OrchestrationV2ProviderThread = {
      id: ProviderThreadId.make("pt-1"),
      driver,
      providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: PositiveInt.make(1),
      lastRunOrdinal: PositiveInt.make(1),
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [{ taskId: taskA, kind: "command" }],
      createdAt,
      updatedAt: createdAt,
    };

    const first = attributePendingBackgroundTasks(providerThread, undefined, firstRun);
    expect(first.pendingBackgroundTasks?.[0]?.runId).toBe(firstRun);

    const second = attributePendingBackgroundTasks(
      {
        ...providerThread,
        pendingBackgroundTasks: [
          { taskId: taskA, kind: "command" },
          { taskId: taskB, kind: "monitor" },
        ],
      },
      first,
      secondRun,
    );
    expect(second.pendingBackgroundTasks).toEqual([
      { taskId: taskA, kind: "command", runId: firstRun },
      { taskId: taskB, kind: "monitor", runId: secondRun },
    ]);
  });

  it("preserves provider-turn tokenUsage when subsequent updates omit it", () => {
    const turn = {
      id: ProviderTurnId.make("turn-1"),
      providerThreadId: ProviderThreadId.make("pt-1"),
      nodeId: NodeId.make("node-1"),
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: PositiveInt.make(1),
      status: "running" as const,
      startedAt: createdAt,
      completedAt: null,
      tokenUsage: {
        usedTokens: 1200,
        maxTokens: 100_000,
        updatedAt: IsoDateTime.make(DateTime.formatIso(createdAt)),
      },
    };
    const updated = upsertProviderTurn([turn], {
      ...turn,
      status: "completed",
      completedAt: later,
      tokenUsage: undefined,
    });
    expect(updated[0]?.tokenUsage).toEqual(turn.tokenUsage);
  });

  it("respects touchThreadUpdatedAt for server vs client activity updates", () => {
    const event: OrchestrationV2DomainEvent = {
      id: EventId.make("event-run"),
      type: "run.created",
      threadId,
      runId,
      occurredAt: later,
      payload: baseRun,
    };

    const server = reduceOrchestrationV2ThreadProjection(emptyProjection, event, {
      applyThreadPullRequestLinkUpdate: applyPullRequestLink,
      touchThreadUpdatedAt: true,
    });
    expect(server.projection.thread.updatedAt).toEqual(later);
    expect(server.projection.updatedAt).toEqual(later);

    const client = reduceOrchestrationV2ThreadProjection(emptyProjection, event, {
      applyThreadPullRequestLinkUpdate: applyPullRequestLink,
      touchThreadUpdatedAt: false,
      visibleTurnItemsMode: "incremental",
    });
    expect(client.projection.thread).toBe(emptyProjection.thread);
    expect(client.projection.updatedAt).toEqual(later);
  });
});
