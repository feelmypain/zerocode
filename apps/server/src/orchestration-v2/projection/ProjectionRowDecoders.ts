import type {
  OrchestrationV2AppThread,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointScope,
  OrchestrationV2ContextTransfer,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  OrchestrationV2OlderSettledCount,
  OrchestrationV2OlderSettledCursor,
  OrchestrationV2PendingRuntimeRequestSummary,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ShellThreadStatus,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
} from "@zerocode/contracts";
import {
  CheckpointScopeId,
  IDLE_COMPACTION_TEXT,
  MessageId,
  NodeId,
  OrchestrationV2AppThreadJson as OrchestrationV2AppThreadJsonSchema,
  OrchestrationV2CheckpointJson as OrchestrationV2CheckpointJsonSchema,
  OrchestrationV2CheckpointScopeJson as OrchestrationV2CheckpointScopeJsonSchema,
  OrchestrationV2ContextHandoffJson as OrchestrationV2ContextHandoffJsonSchema,
  OrchestrationV2ContextTransferJson as OrchestrationV2ContextTransferJsonSchema,
  OrchestrationV2ConversationMessageJson as OrchestrationV2ConversationMessageJsonSchema,
  OrchestrationV2ExecutionNodeJson as OrchestrationV2ExecutionNodeJsonSchema,
  OrchestrationV2PlanArtifact as OrchestrationV2PlanArtifactSchema,
  OrchestrationV2ProviderSessionJson as OrchestrationV2ProviderSessionJsonSchema,
  OrchestrationV2ProviderThreadJson as OrchestrationV2ProviderThreadJsonSchema,
  OrchestrationV2ProviderTurnJson as OrchestrationV2ProviderTurnJsonSchema,
  OrchestrationV2RunAttemptJson as OrchestrationV2RunAttemptJsonSchema,
  OrchestrationV2RunJson as OrchestrationV2RunJsonSchema,
  OrchestrationV2RuntimeRequestJson as OrchestrationV2RuntimeRequestJsonSchema,
  OrchestrationV2SubagentJson as OrchestrationV2SubagentJsonSchema,
  OrchestrationV2TurnItemJson as OrchestrationV2TurnItemJsonSchema,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  idleCompactionOf,
  orchestrationV2RunWorkStartedAt,
  pendingGuestMessageCount,
} from "@zerocode/contracts";
import type { ProjectThreadAwarenessV2Input } from "@zerocode/shared/agentAwareness";
import { MCP_APP_OUTPUT_KEY } from "@zerocode/shared/mcpApp";
import {
  deriveBlockedOnThreadWait,
  derivePendingBackgroundWork,
} from "@zerocode/shared/orchestrationV2PendingBackgroundWork";
import {
  latestRootProviderFailure,
  latestUnheldRun,
  threadErrorSummary,
  usageLimitRunPresentedAsLatest,
} from "@zerocode/shared/orchestrationV2ThreadError";
import { createOrchestrationV2TurnItemVisibility } from "@zerocode/shared/orchestrationV2Timeline";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { threadPullRequestsOf } from "../../sourceControl/threadPullRequests.ts";
import { DEFERRED_WORK_ITEM_TYPES } from "../threadHistoryPaging.ts";

export class ProjectionStoreApplyEventError extends Schema.TaggedError<ProjectionStoreApplyEventError>()(
  "ProjectionStoreApplyEventError",
  {
    eventType: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to apply orchestration projection event ${this.eventType}.`;
  }
}

export class ProjectionStoreSetupError extends Schema.TaggedError<ProjectionStoreSetupError>()(
  "ProjectionStoreSetupError",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Failed to initialize orchestration projection store.";
  }
}

export class ProjectionStoreThreadNotFoundError extends Schema.TaggedError<ProjectionStoreThreadNotFoundError>()(
  "ProjectionStoreThreadNotFoundError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `No orchestration projection exists for thread ${this.threadId}.`;
  }
}

export class ProjectionStoreReadError extends Schema.TaggedError<ProjectionStoreReadError>()(
  "ProjectionStoreReadError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read orchestration projection for thread ${this.threadId}.`;
  }
}

export const ProjectionStoreV2Error = Schema.Union([
  ProjectionStoreSetupError,
  ProjectionStoreApplyEventError,
  ProjectionStoreThreadNotFoundError,
  ProjectionStoreReadError,
]);
export type ProjectionStoreV2Error = typeof ProjectionStoreV2Error.Type;

export const isProjectionStoreThreadNotFoundError = Schema.is(ProjectionStoreThreadNotFoundError);
export const isProjectionStoreReadError = Schema.is(ProjectionStoreReadError);

export const controlReadError = (threadId: ThreadId) => (cause: unknown) =>
  isProjectionStoreThreadNotFoundError(cause)
    ? cause
    : new ProjectionStoreReadError({ threadId, cause });

export type ProjectionRecoveryKind =
  | "queued-runs"
  | "runtime"
  | "restart-continuations"
  | "subagent-results"
  | "delegated-completions"
  | "unread-steers";

export type ProjectionLimitRecoveryCandidate = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "status"
  | "lastErrorClass"
  | "latestRunId"
  | "usageLimitResetAt"
  | "archivedAt"
  | "settledOverride"
  | "pendingRuntimeRequest"
  | "latestRunCompletedAt"
  | "updatedAt"
  | "limitRecovery"
  | "snoozedUntil"
>;

export type ProjectionThreadPullRequests = Pick<
  OrchestrationV2AppThread,
  "id" | "projectId" | "lineage" | "settledOverride" | "settledAt" | "pullRequests"
>;

export type ProjectionSettlementCandidate = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "projectId"
  | "branch"
  | "worktreePath"
  | "lineage"
  | "pullRequests"
  | "linkedPullRequest"
  | "branchPullRequest"
  | "createdAt"
  | "updatedAt"
  | "archivedAt"
  | "settledOverride"
  | "pinnedAt"
  | "autoSettleDisabledAt"
  | "snoozedUntil"
  | "snoozedAt"
  | "latestRunId"
  | "latestRunRequestedAt"
  | "latestRunStartedAt"
  | "latestRunCompletedAt"
  | "latestUserMessageAt"
  | "status"
  | "activityRunStartedAt"
  | "activityRunStatus"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
  | "pendingGuestMessageCount"
> &
  Pick<OrchestrationV2AppThread, "lastSnoozeWakeAt"> & {
    /** Latest user or MCP agent message; automatic server and provider wakes are excluded. */
    readonly latestResumingMessageAt: DateTime.Utc | null;
  };

const ProjectionCheckpointContext = Schema.Struct({
  runs: Schema.Array(
    OrchestrationV2RunJsonSchema.mapFields(({ id, ordinal, status }) => ({ id, ordinal, status })),
  ),
  checkpointScopes: Schema.Array(
    OrchestrationV2CheckpointScopeJsonSchema.mapFields(({ id, runId, kind, cwd }) => ({
      id,
      runId,
      kind,
      cwd,
      // SQLite reads an absent JSON key as null.
      label: Schema.optionalKey(Schema.NullOr(Schema.String)),
      repositoryPath: Schema.optionalKey(Schema.NullOr(Schema.String)),
    })),
  ),
  checkpoints: Schema.Array(
    OrchestrationV2CheckpointJsonSchema.mapFields(
      ({ scopeId, runId, ordinalWithinScope, appRunOrdinal, status, ref }) => ({
        scopeId,
        runId,
        ordinalWithinScope,
        appRunOrdinal,
        status,
        ref,
      }),
    ),
  ),
});
export type ProjectionCheckpointContext = typeof ProjectionCheckpointContext.Type;
export const decodeCheckpointContext = Schema.decodeUnknownEffect(ProjectionCheckpointContext);

export interface ProjectionCheckpointCaptureContext {
  readonly run: OrchestrationV2Run | undefined;
  readonly rootNode: OrchestrationV2ExecutionNode | undefined;
  readonly scope: OrchestrationV2CheckpointScope | undefined;
  readonly providerThread: OrchestrationV2ProviderThread | undefined;
  /**
   * Ordinals a runless baseline must not overwrite: ready snapshots, and missing checkpoints pinning
   * a run. Without file snapshots that run link is what rewind uses. Stale rows are rebaselined.
   */
  readonly preservedCheckpointOrdinals: ReadonlyArray<number>;
  /** Side chats share their parent's worktree and never snapshot it. */
  readonly sideChat: boolean;
  /** What resolves the tracked folders the thread reaches. */
  readonly thread: Pick<OrchestrationV2AppThread, "projectId" | "worktreePath"> | undefined;
  /** Every repository scope the thread has recorded so far. */
  readonly repositoryScopes: ReadonlyArray<OrchestrationV2CheckpointScope>;
  /** Repository scopes whose baseline for this run a runless baseline must not overwrite. */
  readonly repositoryScopesWithBaseline: ReadonlyArray<CheckpointScopeId>;
}

const RollbackTargetAttempts = Schema.Array(
  OrchestrationV2RunAttemptJsonSchema.mapFields(({ id, providerTurnId }) => ({
    id,
    providerTurnId,
  })),
);
export const decodeRollbackTargetAttempts = Schema.decodeUnknownEffect(RollbackTargetAttempts);

export interface ProjectionCheckpointRollbackContext {
  readonly thread: OrchestrationV2AppThread;
  readonly providerThread: OrchestrationV2ProviderThread | undefined;
  readonly providerSession: OrchestrationV2ThreadProjection["providerSessions"][number] | undefined;
  readonly checkpoint: OrchestrationV2Checkpoint | undefined;
  readonly scope: OrchestrationV2CheckpointScope | undefined;
  readonly targetAttempt: (typeof RollbackTargetAttempts.Type)[number] | undefined;
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly rolledBackAttemptIds: ReadonlyArray<RunAttemptId>;
  readonly runsToRollback: ReadonlyArray<OrchestrationV2Run>;
  readonly rootNodes: ReadonlyArray<OrchestrationV2ExecutionNode>;
  /** Ready checkpoints of the target scope and of repository scopes that the rollback discards. */
  readonly staleCheckpoints: ReadonlyArray<OrchestrationV2Checkpoint>;
}

export interface ProjectionProviderControlContext {
  readonly providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] | undefined;
  readonly providerTurn: OrchestrationV2ProviderTurn | undefined;
  readonly attempt: OrchestrationV2ThreadProjection["attempts"][number] | undefined;
  readonly message: OrchestrationV2ConversationMessage | undefined;
  readonly run: OrchestrationV2Run | undefined;
}

export interface ProjectionProviderControlTarget {
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly attemptId?: RunAttemptId;
  readonly messageId?: MessageId;
}

export type ProjectionRuntimeRecoveryState = Pick<
  OrchestrationV2ThreadProjection,
  | "thread"
  | "runs"
  | "attempts"
  | "nodes"
  | "subagents"
  | "providerSessions"
  | "providerThreads"
  | "providerTurns"
  | "runtimeRequests"
  | "messages"
  | "turnItems"
>;

export type ProjectionPendingUserInputs = Pick<
  OrchestrationV2ThreadProjection,
  "runtimeRequests" | "nodes" | "turnItems"
>;

export type ProjectionThreadProviderContext = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "providerSessions" | "providerThreads"
>;

export interface ProjectionRuntimeResponseContext {
  readonly request: OrchestrationV2ThreadProjection["runtimeRequests"][number] | undefined;
  readonly node: OrchestrationV2ThreadProjection["nodes"][number] | undefined;
  readonly item: OrchestrationV2ThreadProjection["turnItems"][number] | undefined;
  readonly session: OrchestrationV2ThreadProjection["providerSessions"][number] | undefined;
}

export const PROMPT_NARROWING_BLOCKING_FILTERS = [
  "runIds",
  "runStatuses",
  "latestRunLimit",
  "turnItemRunId",
  "turnItemRunIds",
  "turnItemNodeIds",
  "turnItemRequestIds",
  "turnItemStatuses",
] as const satisfies ReadonlyArray<keyof ProjectionRecordFilter>;

export interface ProjectionRecordFilter {
  readonly providerThreadIds?: ReadonlyArray<ProviderThreadId>;
  readonly providerTurnIds?: ReadonlyArray<ProviderTurnId>;
  readonly providerTurnAttemptIds?: ReadonlyArray<RunAttemptId>;
  readonly attemptIds?: ReadonlyArray<RunAttemptId>;
  readonly messageRoles?: ReadonlyArray<OrchestrationV2ConversationMessage["role"]>;
  readonly monitorNotificationsOnly?: boolean;
  /** User messages that are monitor notifications or delegated-completion wakes, through their partial index. */
  readonly delegatedTaskMessagesOnly?: true;
  readonly turnItemRunId?: RunId;
  readonly messageIds?: ReadonlyArray<MessageId>;
  readonly messageRunIds?: ReadonlyArray<RunId>;
  readonly turnItemRunIds?: ReadonlyArray<RunId | null>;
  readonly turnItemNodeIds?: ReadonlyArray<NodeId>;
  readonly runIds?: ReadonlyArray<RunId>;
  /** Without `includeLatestRun`, reads through a status index and sorts the matches, so keep it to statuses few runs hold. */
  readonly runStatuses?: ReadonlyArray<OrchestrationV2Run["status"]>;
  /** Keeps the thread's highest-ordinal run even when `runStatuses` excludes it. */
  readonly includeLatestRun?: true;
  /** The thread's N highest-ordinal runs, plus any run `runStatuses` matches. Ignores `includeLatestRun`. */
  readonly latestRunLimit?: number;
  /** Keeps the run `latestExecutedRun` picks even when `runStatuses` excludes it. Ignores `includeLatestRun`. */
  readonly includeLatestExecutedRun?: true;
  readonly providerTurnThreadIds?: ReadonlyArray<ProviderThreadId>;
  /** Only the provider turn whose token usage was updated last. */
  readonly latestProviderTurnUsageOnly?: true;
  readonly runtimeRequestStatuses?: ReadonlyArray<OrchestrationV2RuntimeRequest["status"]>;
  readonly contextTransferStatuses?: ReadonlyArray<OrchestrationV2ContextTransfer["status"]>;
  readonly subagentIds?: ReadonlyArray<NodeId>;
  readonly subagentRunIds?: ReadonlyArray<RunId>;
  readonly subagentChildThreadIds?: ReadonlyArray<ThreadId>;
  readonly nodeIds?: ReadonlyArray<NodeId>;
  readonly turnItemRequestIds?: ReadonlyArray<RuntimeRequestId>;
  readonly turnItemTypes?: ReadonlyArray<OrchestrationV2TurnItem["type"]>;
  readonly turnItemStatuses?: ReadonlyArray<OrchestrationV2TurnItem["status"]>;
  readonly omitSettledLeafNodes?: boolean;
  /**
   * Skips ended subagents whose completion was acknowledged, delivered or disposed, unless their
   * run is active or `except` names them.
   */
  readonly omitSettledSubagents?: true | { readonly except: ReadonlyArray<NodeId> };
  /**
   * Also skips the provider thread of each subagent that `omitSettledSubagents: true` skips, and
   * with `omitSettledLeafNodes` its node. A provider thread that shares a provider session with
   * the thread stays.
   */
  readonly omitSettledSubagentRecords?: boolean;
  /**
   * For a compacted thread, reads attempts, nodes, messages and provider turns of the recent runs
   * and the runs named here. Turn items are the failed errors of every run and the prompts of the
   * recent, fresh-context and model-switch runs. `turnItemTypes` does not apply. A read without `runs`, or with a run or turn-item
   * filter, keeps its filtered items. Runs stay whole.
   */
  readonly sinceLastCompaction?: {
    readonly keepRunIds: ReadonlyArray<RunId>;
    /** Keeps the run that already holds this message, for a message that is sent again. */
    readonly keepMessageId: MessageId;
  };
}

// A fork inherits its source's history before it has messages of its own,
// unless a portable handoff's budget left none of that history to deliver.
export const inheritsForkConversation = ({
  thread,
  contextTransfers,
  contextHandoffs,
}: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers" | "contextHandoffs">) => {
  if (thread.forkedFrom?.type !== "run") return false;
  const resolution = contextTransfers.find(
    (transfer) => transfer.type === "fork" && transfer.targetThreadId === thread.id,
  )?.resolution;
  return (
    resolution?.strategy !== "portable_context" ||
    contextHandoffs.some(
      (handoff) =>
        handoff.id === resolution.contextHandoffId && (handoff.history?.messages.length ?? 0) > 0,
    )
  );
};

export type ProjectionRecordField = Exclude<
  keyof OrchestrationV2ThreadProjection,
  "thread" | "updatedAt" | "visibleTurnItems"
>;
export type ProjectionRecords<K extends ProjectionRecordField> = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | K
>;

/**
 * A page holds the oldest matches after `afterPosition`, or with `beforePosition`,
 * the newest matches before it. `itemId` ignores both bounds.
 */
export interface ProjectionTimelinePageOptions {
  readonly afterPosition?: number;
  readonly beforePosition?: number;
  readonly itemId?: TurnItemId;
  readonly attachmentId?: string;
  readonly view?: "messages" | "activity";
  readonly limit: number;
}
export interface ProjectionTimelinePage {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly totalItems: number;
  /** Matches exist after the page. */
  readonly hasMore: boolean;
  /** Matches exist before the page. */
  readonly hasEarlier: boolean;
}

export interface ShellSnapshotOptions {
  readonly location?: "active" | "archive";
  readonly projectId?: ProjectId;
  readonly unsettledOnly?: boolean;
  /**
   * Only the threads sharing this thread's `lineage.rootThreadId`: the root, its forks, and their
   * subagent trees. The thread may be deleted: forks keep a deleted source's root.
   */
  readonly familyOf?: ThreadId;
  readonly worktreePath?: string;
  readonly threadIds?: ReadonlyArray<ThreadId>;
}

/** What a shell subscriber's trims read from an active thread, without building its shell. */
export interface ActiveShellIndexEntry extends Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "projectId"
  | "lineage"
  | "settledOverride"
  | "settledAt"
  | "pinnedAt"
  | "pinOrderKey"
  | "snoozedUntil"
> {
  /** False only when no run, request, work item, or watch can make the shell live. */
  readonly mayBeLive: boolean;
  /** Whether it delegated a task to a linked environment, whose clients nest that task under it. */
  readonly hasRemoteTasks: boolean;
}

/** What thread listings filter and order an active thread by, without building its shell. */
export type ActiveThreadListEntry = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "projectId"
  | "title"
  | "lineage"
  | "delegatedFrom"
  | "settledOverride"
  | "settledAt"
  | "snoozedUntil"
  | "updatedAt"
>;

export interface OlderSettledThreadsQuery {
  readonly before: OrchestrationV2OlderSettledCursor;
  readonly projectIds?: ReadonlyArray<ProjectId> | undefined;
  readonly limit: number;
}

export interface OlderSettledThreadsListing {
  readonly threadIds: ReadonlyArray<ThreadId>;
  /** Only for `limit: 0`. */
  readonly counts: ReadonlyArray<OrchestrationV2OlderSettledCount>;
}

export interface ProjectionWindowOptions {
  readonly rowLimit: number;
  readonly userTurnLimit?: number | undefined;
  readonly deferWork?: boolean | undefined;
  readonly anchorItemId?: TurnItemId | undefined;
  readonly anchorThreadId?: ThreadId | undefined;
  readonly requiredRunId?: RunId | undefined;
}

export type ProjectionWindow = Omit<ProjectionWindowOptions, "anchorThreadId"> & {
  readonly suppressLocal?: boolean | undefined;
  readonly forkRunIdsJson?: string | undefined;
  readonly historyAnchor?: { readonly threadId: ThreadId; readonly itemId: TurnItemId } | undefined;
};

export const ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION = 2;

export type PayloadRow = {
  readonly payload_json: string;
};

export type ShellPendingTurnItemRow = PayloadRow & {
  readonly thread_id: string;
  readonly owning_provider_instance_id: string | null;
};

export type AgentAwarenessThread = ProjectThreadAwarenessV2Input["thread"] &
  Pick<
    OrchestrationV2ThreadShell,
    | "projectId"
    | "creationSource"
    | "latestRunCompletedAt"
    | "archivedAt"
    | "snoozedUntil"
    | "snoozedAt"
    | "pendingGuestMessageCount"
    | "activeRunId"
    | "latestRunId"
    | "hasActionableProposedPlan"
  >;

export type ShellThreadRow = {
  readonly fork_run_ids_json: string | null;
  readonly thread_id: string;
  readonly payload_json: string;
  readonly forked_from_run_source_thread_id: string | null;
  readonly worktree_path: string | null;
  readonly latest_run_id: string | null;
  readonly latest_run_status: string | null;
  readonly latest_run_requested_at: string | null;
  readonly latest_run_started_at: string | null;
  readonly latest_run_completed_at: string | null;
  readonly latest_run_stop_requested: number;
  readonly latest_run_background_wake: number;
  readonly active_run_id: string | null;
  readonly active_run_status: string | null;
  readonly activity_run_status: string | null;
  readonly activity_run_started_at: string | null;
  readonly last_error: string | null;
  readonly terminal_failure_payload_json: string | null;
  readonly blocking_run_id: string | null;
  readonly blocking_run_requested_at: string | null;
  readonly blocking_run_started_at: string | null;
  readonly blocking_run_completed_at: string | null;
  readonly blocking_run_stop_requested: number;
  readonly blocking_run_background_wake: number;
  readonly blocking_failure_payload_json: string | null;
  readonly pending_request_payload_json: string | null;
  readonly pending_secret_request_payload_json: string | null;
  readonly pending_link_request_payload_json: string | null;
  readonly latest_user_message_at: string | null;
  readonly latest_user_authored_message_at: string | null;
  readonly has_actionable_proposed_plan: number;
};

export type ShellRunRow = {
  readonly thread_id: string;
  readonly run_id: string;
  readonly ordinal: number;
  readonly rolled_back_at: string | null;
};

export type ShellRun = {
  readonly ordinal: number;
  readonly rolledBackAt: DateTime.Utc | null;
};

export type SettlementThreadRow = Pick<
  ShellThreadRow,
  | "thread_id"
  | "payload_json"
  | "latest_run_id"
  | "latest_run_status"
  | "latest_run_requested_at"
  | "latest_run_started_at"
  | "latest_run_completed_at"
  | "latest_user_message_at"
> & {
  readonly latest_resuming_message_at: string | null;
};

export type ShellRunItemCountRow = {
  readonly thread_id: string;
  readonly run_id: string;
  readonly item_count: number;
};

export type ShellItemCountRow = {
  readonly thread_id: string;
  readonly item_count: number;
  readonly runless_item_count: number;
};

export type TimelineIndexItem = Pick<
  OrchestrationV2TurnItem,
  "id" | "threadId" | "runId" | "nodeId" | "parentItemId" | "type" | "status" | "ordinal"
> & {
  readonly inputIntent?: Extract<OrchestrationV2TurnItem, { type: "user_message" }>["inputIntent"];
  readonly createdBy?: "user" | "agent" | "system";
  readonly messageId?: MessageId;
  readonly runStatus?: string | undefined;
  readonly attemptId?: string | null;
  readonly attemptStatus?: string | null;
  readonly persistentOutput?: boolean;
  readonly deferredWork?: OrchestrationV2TurnItem["deferredWork"];
};

export type TimelineIndexRow = {
  readonly sourceThreadId: ThreadId;
  readonly sourceItemId: TurnItemId;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
  readonly item: TimelineIndexItem;
  readonly synthetic?: OrchestrationV2TurnItem;
};

export type TimelineIndex = {
  readonly records: ProjectionRecords<"runs" | "attempts">;
  /** The thread and every fork source the index read. */
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly local: ReadonlyArray<TimelineIndexRow>;
  readonly visible: ReadonlyArray<TimelineIndexRow>;
};

export type TimelineIndexCache = Map<
  string,
  { readonly sequence: number; readonly index: TimelineIndex }
>;

export const encodeTimelineSources = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ threadId: Schema.String, id: Schema.NullOr(Schema.String) })),
  ),
);

export const shellIndexLineage = (row: {
  readonly relationship_to_parent: string | null;
  readonly parent_thread_id: string | null;
  readonly root_thread_id: string;
  readonly side_chat: number | null;
}): OrchestrationV2ThreadShell["lineage"] => ({
  parentThreadId: row.parent_thread_id === null ? null : ThreadId.make(row.parent_thread_id),
  relationshipToParent:
    row.relationship_to_parent === "fork" || row.relationship_to_parent === "subagent"
      ? row.relationship_to_parent
      : null,
  rootThreadId: ThreadId.make(row.root_thread_id),
  ...(row.side_chat === null ? {} : { sideChat: row.side_chat === 1 }),
});

export const encodeIdList = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

// Empty filters still scan SQLite rows; short-circuit them, including turnItemTypes: [].
export const matchesNothing = (...filters: ReadonlyArray<ReadonlyArray<unknown> | undefined>) =>
  filters.some((values) => values?.length === 0);

export const encodeThreadPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJsonSchema),
);
export const encodeThreadUpdatedAt = Schema.encodeEffect(
  OrchestrationV2AppThreadJsonSchema.fields.updatedAt,
);
export const encodeRunPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2RunJsonSchema),
);
export const encodeRestartCancelledBackgroundWork = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2RunJsonSchema.fields.restartCancelledBackgroundWork),
);
export const encodeRunOutput = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2RunJsonSchema.fields.output),
);
export const encodeRunAttemptPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2RunAttemptJsonSchema),
);
export const encodeNodePayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ExecutionNodeJsonSchema),
);
export const encodeSubagentPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2SubagentJsonSchema),
);
export const encodeProviderSessionPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJsonSchema),
);
export const encodeProviderThreadPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJsonSchema),
);
export const encodeProviderTurnPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderTurnJsonSchema),
);
export const encodeRuntimeRequestPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2RuntimeRequestJsonSchema),
);
export const encodeMessagePayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJsonSchema),
);
export const encodePlanPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2PlanArtifactSchema),
);
export const encodeTurnItemPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJsonSchema),
);
export const encodeCheckpointScopePayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointScopeJsonSchema),
);
export const encodeCheckpointPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointJsonSchema),
);
export const encodeContextHandoffPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ContextHandoffJsonSchema),
);
export const encodeContextTransferPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ContextTransferJsonSchema),
);

export const PullRequestThread = OrchestrationV2AppThreadJsonSchema.mapFields(
  ({
    id,
    projectId,
    lineage,
    createdAt,
    updatedAt,
    branch,
    worktreePath,
    archivedAt,
    settledOverride,
    settledAt,
    linkedPullRequest,
    branchPullRequest,
    pullRequests,
  }) => ({
    id,
    projectId,
    lineage,
    createdAt,
    updatedAt,
    branch,
    worktreePath,
    archivedAt,
    settledOverride,
    settledAt,
    linkedPullRequest,
    branchPullRequest,
    pullRequests,
  }),
);
export const decodePullRequestThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PullRequestThread),
);

const forkRunIdsJson = Schema.fromJsonString(Schema.Array(RunId));
export const decodeForkRunIds = Schema.decodeUnknownEffect(forkRunIdsJson);
export const encodeForkRunIds = Schema.encodeEffect(forkRunIdsJson);

export const decodeThreadPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJsonSchema),
);
export const decodeRunPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RunJsonSchema),
);
export const decodeRunAttemptPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RunAttemptJsonSchema),
);
export const decodeNodePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ExecutionNodeJsonSchema),
);
export const decodeSubagentPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2SubagentJsonSchema),
);
export const decodeProviderSessionPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJsonSchema),
);
export const decodeProviderThreadPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJsonSchema),
);
export const decodeProviderTurnPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderTurnJsonSchema),
);
export const decodeRuntimeRequestPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RuntimeRequestJsonSchema),
);
export const decodeMessagePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJsonSchema),
);
export const decodePlanJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2PlanArtifactSchema),
);
export const decodeTurnItemPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJsonSchema),
);
export const decodeCheckpointScopePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointScopeJsonSchema),
);
export const decodeCheckpointPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointJsonSchema),
);
export const decodeContextHandoffPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ContextHandoffJsonSchema),
);
export const decodeContextTransferPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ContextTransferJsonSchema),
);

export function formatNullableIso(value: DateTime.Utc | null): string | null {
  return value === null ? null : DateTime.formatIso(value);
}

export function nullableStringField(
  payload: Record<string, unknown>,
  field: string,
): string | null {
  const value = payload[field];
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : String(value);
}

export function booleanInt(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export const decodeRows =
  <A, E>(decode: (json: string) => Effect.Effect<A, E>, threadId: ThreadId) =>
  (rows: ReadonlyArray<PayloadRow>): Effect.Effect<Array<A>, ProjectionStoreReadError> =>
    Effect.forEach(rows, (row) => decode(row.payload_json)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectionStoreReadError({
            threadId,
            cause,
          }),
      ),
    );

function messageIdForTurnItem(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
      return item.messageId;
    default:
      return null;
  }
}

export function sortMessagesByTurnItemOrder(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  messageOrdinals = new Map<string, number>(),
): Array<OrchestrationV2ConversationMessage> {
  for (const turnItem of turnItems) {
    const messageId = messageIdForTurnItem(turnItem);
    if (messageId === null) {
      continue;
    }
    const existing = messageOrdinals.get(messageId);
    if (existing === undefined || turnItem.ordinal < existing) {
      messageOrdinals.set(messageId, turnItem.ordinal);
    }
  }

  return messages.toSorted((left, right) => {
    const leftOrdinal = messageOrdinals.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrdinal = messageOrdinals.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrdinal !== rightOrdinal) {
      return leftOrdinal - rightOrdinal;
    }

    const leftCreatedAt = DateTime.toEpochMillis(left.createdAt);
    const rightCreatedAt = DateTime.toEpochMillis(right.createdAt);
    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }

    return left.id.localeCompare(right.id);
  });
}

export function activeLocalTurnItems(
  projection: OrchestrationV2ThreadProjection,
): Array<OrchestrationV2ProjectedTurnItem> {
  const isVisible = createOrchestrationV2TurnItemVisibility({
    runs: projection.runs,
    attempts: projection.attempts,
    items: projection.turnItems,
  });
  return projection.turnItems.filter(isVisible).map((item, position) => ({
    position,
    visibility: "local" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  }));
}

function localVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): Array<OrchestrationV2ProjectedTurnItem> {
  return activeLocalTurnItems(projection);
}

function inheritedVisibleTurnItemsFromLocalItems(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): Array<Omit<OrchestrationV2ProjectedTurnItem, "position">> {
  return items.map((item) => ({
    visibility: "inherited" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  }));
}

export function withLocalVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  return {
    ...projection,
    visibleTurnItems: localVisibleTurnItems(projection),
  };
}

function renumberVisibleTurnItems(
  rows: ReadonlyArray<Omit<OrchestrationV2ProjectedTurnItem, "position">>,
  offset = 0,
): Array<OrchestrationV2ProjectedTurnItem> {
  return rows.map((row, position) => ({ ...row, position: position + offset }));
}

export function makeForkMarkerTurnItem(input: {
  readonly targetProjection: Pick<OrchestrationV2ThreadProjection, "thread">;
  readonly sourceThreadId: ThreadId;
  readonly sourceRunId: NonNullable<OrchestrationV2TurnItem["runId"]>;
}): Extract<OrchestrationV2TurnItem, { type: "fork" }> {
  const createdAt = input.targetProjection.thread.createdAt;
  return {
    id: TurnItemId.make(`turn-item:fork:${input.targetProjection.thread.id}`),
    threadId: input.targetProjection.thread.id,
    runId: null,
    nodeId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: "Forked from conversation",
    startedAt: null,
    completedAt: createdAt,
    updatedAt: createdAt,
    type: "fork",
    source: { type: "run", threadId: input.sourceThreadId, runId: input.sourceRunId },
    targetThreadId: input.targetProjection.thread.id,
  };
}

export function isTurnItemAtOrBeforeRun(input: {
  readonly historyOrigin: OrchestrationV2ThreadProjection["thread"]["historyOrigin"];
  readonly itemRunId: OrchestrationV2TurnItem["runId"];
  readonly runOrdinalById: ReadonlyMap<NonNullable<OrchestrationV2TurnItem["runId"]>, number>;
  readonly sourceRunOrdinal: number;
}): boolean {
  if (input.itemRunId === null) {
    return input.historyOrigin === "v1_import";
  }
  const ordinal = input.runOrdinalById.get(input.itemRunId);
  return ordinal !== undefined && ordinal <= input.sourceRunOrdinal;
}

// Run ordinals enforce the fork cutoff; this keeps later rollbacks from hiding
// inherited history while retaining cancellation evidence for undelivered input.
export function createInheritedTurnItemVisibility(
  source: Parameters<typeof createOrchestrationV2TurnItemVisibility>[0],
) {
  const cancelledRunIds = new Set(
    source.attempts
      .filter((attempt) => attempt.status === "cancelled")
      .map((attempt) => attempt.runId),
  );
  return createOrchestrationV2TurnItemVisibility({
    ...source,
    runs: source.runs.flatMap((run) =>
      run.status !== "rolled_back"
        ? [run]
        : cancelledRunIds.has(run.id)
          ? [{ ...run, status: "cancelled" as const }]
          : [],
    ),
  });
}

// Rollback stamps completedAt; a fork made after the rewind never received that run.
function runRolledBackAt(run: Pick<OrchestrationV2Run, "status" | "completedAt">) {
  return run.status === "rolled_back" ? run.completedAt : null;
}

function isRolledBackBeforeFork(
  rolledBackAt: DateTime.Utc | null,
  forkCreatedAt: DateTime.Utc,
): boolean {
  return rolledBackAt !== null && DateTime.isLessThan(rolledBackAt, forkCreatedAt);
}

export function forkInheritedRunOrdinals(
  runs: ReadonlyArray<OrchestrationV2Run>,
  forkCreatedAt: DateTime.Utc,
): Map<RunId, number> {
  return new Map(
    runs
      .filter((run) => !isRolledBackBeforeFork(runRolledBackAt(run), forkCreatedAt))
      .map((run) => [run.id, run.ordinal]),
  );
}

export function forkMemberRunOrdinals(
  runs: ReadonlyArray<OrchestrationV2Run>,
  inheritedRunIds: ReadonlyArray<RunId>,
): Map<RunId, number> {
  const membership = new Set(inheritedRunIds);
  return new Map(runs.filter((run) => membership.has(run.id)).map((run) => [run.id, run.ordinal]));
}

function visibleTurnItemsThroughRun(input: {
  readonly sourceProjection: OrchestrationV2ThreadProjection;
  readonly sourceRunId: NonNullable<OrchestrationV2TurnItem["runId"]>;
  readonly inheritedRunIds: ReadonlyArray<RunId>;
}): Array<Omit<OrchestrationV2ProjectedTurnItem, "position">> {
  const sourceRun = input.sourceProjection.runs.find((run) => run.id === input.sourceRunId);
  if (sourceRun === undefined) {
    return [];
  }

  const runOrdinalById = forkMemberRunOrdinals(input.sourceProjection.runs, input.inheritedRunIds);
  const isVisible = createInheritedTurnItemVisibility({
    runs: input.sourceProjection.runs,
    attempts: input.sourceProjection.attempts,
    items: input.sourceProjection.turnItems,
  });
  const inheritedPrefix = input.sourceProjection.visibleTurnItems
    .filter(
      (row) => row.item.threadId !== input.sourceProjection.thread.id || row.item.type === "fork",
    )
    .map((row) => ({
      visibility: "inherited" as const,
      sourceThreadId: row.sourceThreadId,
      sourceItemId: row.sourceItemId,
      item: row.item,
    }));
  const localPrefix = inheritedVisibleTurnItemsFromLocalItems(
    input.sourceProjection.turnItems.filter(
      (item) =>
        isVisible(item) &&
        isTurnItemAtOrBeforeRun({
          historyOrigin: input.sourceProjection.thread.historyOrigin,
          itemRunId: item.runId,
          runOrdinalById,
          sourceRunOrdinal: sourceRun.ordinal,
        }),
    ),
  );

  return [...inheritedPrefix, ...localPrefix];
}

// Side chats show only their own rows; the fork transfer carries the parent's context to the model.
export function inheritedRunFork(thread: Pick<OrchestrationV2AppThread, "forkedFrom" | "lineage">) {
  return thread.forkedFrom?.type === "run" && thread.lineage.sideChat !== true
    ? thread.forkedFrom
    : null;
}

export function buildVisibleTurnItems(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly sourceProjection: OrchestrationV2ThreadProjection | null;
  readonly inheritedRowCount?: number;
  readonly inheritedRunIds?: ReadonlyArray<RunId>;
}): Array<OrchestrationV2ProjectedTurnItem> {
  const forkedFrom = inheritedRunFork(input.projection.thread);
  if (
    forkedFrom === null ||
    (input.sourceProjection === null && input.inheritedRowCount === undefined)
  ) {
    return localVisibleTurnItems(input.projection);
  }

  const inherited =
    input.sourceProjection === null
      ? []
      : visibleTurnItemsThroughRun({
          sourceProjection: input.sourceProjection,
          sourceRunId: forkedFrom.runId,
          inheritedRunIds: input.inheritedRunIds ?? [],
        });
  const markerItem = makeForkMarkerTurnItem({
    targetProjection: input.projection,
    sourceThreadId: forkedFrom.threadId,
    sourceRunId: forkedFrom.runId,
  });
  const local = activeLocalTurnItems(input.projection).map((row) => ({
    visibility: "local" as const,
    sourceThreadId: row.sourceThreadId,
    sourceItemId: row.sourceItemId,
    item: row.item,
  }));

  return renumberVisibleTurnItems(
    [
      ...inherited,
      {
        visibility: "synthetic",
        sourceThreadId: forkedFrom.threadId,
        sourceItemId: markerItem.id,
        item: markerItem,
      },
      ...local,
    ],
    input.inheritedRowCount ?? 0,
  );
}

export function pendingRuntimeRequestSummary(
  request: OrchestrationV2ThreadProjection["runtimeRequests"][number] | null,
): OrchestrationV2PendingRuntimeRequestSummary | null {
  if (request === null) return null;
  return {
    id: request.id,
    kind: request.kind,
    createdAt: request.createdAt,
    blocking: request.responseCapability.type !== "message",
  };
}

export function secretRequestAsPendingInput(
  item: OrchestrationV2TurnItem | null,
): OrchestrationV2PendingRuntimeRequestSummary | null {
  if ((item?.type !== "secret_request" && item?.type !== "link_request") || item.nodeId === null)
    return null;
  return {
    id: RuntimeRequestId.make(item.id),
    kind: "user_input",
    createdAt: item.startedAt ?? item.updatedAt,
    blocking: true,
    userOnly: true,
  };
}

/**
 * A secret card is answered while its agent waits in the run. A link card's
 * agent asked without waiting, so the card waits on the user after its run,
 * until the user writes in the thread again and so has moved past it.
 */
const waitsOnUser = (
  item: OrchestrationV2TurnItem,
  liveRunIds: ReadonlySet<RunId>,
  latestUserAuthoredMessageAt: DateTime.Utc | null,
) =>
  (item.type === "link_request" && linkCardStillAsks(item, latestUserAuthoredMessageAt)) ||
  (item.type === "secret_request" && item.runId !== null && liveRunIds.has(item.runId));

export const linkCardStillAsks = (
  item: OrchestrationV2TurnItem,
  latestUserAuthoredMessageAt: DateTime.Utc | null,
) =>
  latestUserAuthoredMessageAt === null ||
  !DateTime.isGreaterThan(latestUserAuthoredMessageAt, item.startedAt ?? item.updatedAt);

export function threadShellFromProjection(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadShell {
  const providerSession =
    projection.providerSessions
      .filter((session) => session.providerInstanceId === projection.thread.providerInstanceId)
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
      )[0] ?? null;
  // ZeroCode's own idle compactions stay out of the shell unless they fail, so thread lists,
  // notifications and the relay keep presenting the user's last turn.
  const runs = projection.runs.filter((run) => !isSilentRunForShell(run, projection));
  const latestRun =
    usageLimitRunPresentedAsLatest(
      runs,
      projection.turnItems,
      providerSession?.lastError ?? null,
    ) ?? latestUnheldRun(runs);
  const activeRun =
    runs
      .filter(isInterruptibleRunForShell)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null;
  const activityRun =
    runs.filter(isActivityRunForShell).toSorted((left, right) => right.ordinal - left.ordinal)[0] ??
    null;
  const liveRunIds = new Set(runs.filter(isActivityRunForShell).map((run) => run.id));
  let pendingRuntimeRequest = pendingRuntimeRequestSummary(
    projection.runtimeRequests
      .filter((request) => request.status === "pending")
      .toSorted(
        (left, right) =>
          Number(left.kind === "user_input") - Number(right.kind === "user_input") ||
          DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
      )[0] ?? null,
  );

  const userMessages = projection.messages
    .filter((message) => message.role === "user" && idleCompactionOf(message) === undefined)
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );
  const latestUserAuthoredMessageAt =
    userMessages.find((message) => message.createdBy === "user")?.updatedAt ?? null;
  if (pendingRuntimeRequest === null || pendingRuntimeRequest.kind === "user_input") {
    const waitingCard = secretRequestAsPendingInput(
      projection.turnItems
        .filter(
          (item) =>
            item.status === "waiting" && waitsOnUser(item, liveRunIds, latestUserAuthoredMessageAt),
        )
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
        )[0] ?? null,
    );
    if (
      waitingCard !== null &&
      (pendingRuntimeRequest === null ||
        DateTime.toEpochMillis(waitingCard.createdAt) >=
          DateTime.toEpochMillis(pendingRuntimeRequest.createdAt))
    ) {
      pendingRuntimeRequest = waitingCard;
    }
  }
  const latestUserMessage = userMessages[0] ?? null;
  const pendingBackgroundTasks = derivePendingBackgroundWork({
    latestRun,
    providerThreads: projection.providerThreads,
    turnItems: projection.turnItems,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    runs,
    pullRequests: projection.thread.pullRequests,
  });
  return {
    createdBy: projection.thread.createdBy,
    creationSource: projection.thread.creationSource,
    id: projection.thread.id,
    projectId: projection.thread.projectId,
    title: projection.thread.title,
    providerInstanceId: projection.thread.providerInstanceId,
    modelSelection: projection.thread.modelSelection,
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
    branch: projection.thread.branch,
    worktreePath: projection.thread.worktreePath,
    pullRequests: threadPullRequestsOf(projection.thread),
    ...(projection.thread.linkedPullRequest === undefined
      ? {}
      : { linkedPullRequest: projection.thread.linkedPullRequest }),
    ...(projection.thread.branchPullRequest === undefined
      ? {}
      : { branchPullRequest: projection.thread.branchPullRequest }),
    ...(projection.thread.issues === undefined ? {} : { issues: projection.thread.issues }),
    ...(projection.thread.activeOrderKey === undefined
      ? {}
      : { activeOrderKey: projection.thread.activeOrderKey }),
    lineage: projection.thread.lineage,
    forkedFrom: projection.thread.forkedFrom,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    ...(projection.thread.historyOrigin === undefined
      ? {}
      : { historyOrigin: projection.thread.historyOrigin }),
    ...(projection.thread.linkOrigin === undefined
      ? {}
      : { linkOrigin: projection.thread.linkOrigin }),
    ...(projection.thread.delegatedFrom === undefined
      ? {}
      : { delegatedFrom: projection.thread.delegatedFrom }),
    ...(projection.thread.workflowRun === undefined
      ? {}
      : { workflowRun: projection.thread.workflowRun }),
    latestRunId: latestRun?.id ?? null,
    latestRunRequestedAt: latestRun?.requestedAt ?? null,
    latestRunStartedAt: latestRun?.startedAt ?? null,
    latestRunCompletedAt: latestRun?.completedAt ?? null,
    latestRunStopRequested:
      latestRun != null &&
      projection.turnItems.some(
        (item) => item.runId === latestRun.id && item.type === "run_interrupt_request",
      ),
    latestRunBackgroundWake:
      latestRun != null && isBackgroundWakeRunForShell(latestRun, projection),
    activeRunId: activeRun?.id ?? null,
    blockedOnThreadWait: deriveBlockedOnThreadWait({ activeRun, turnItems: projection.turnItems }),
    activityRunStatus: activityRun?.status ?? null,
    activityRunStartedAt:
      activityRun === null ? null : orchestrationV2RunWorkStartedAt(activityRun),
    status: latestRun?.status ?? "idle",
    ...threadErrorSummary(
      latestRootProviderFailure(latestRun, projection.turnItems),
      providerSession?.lastError ?? null,
    ),
    pendingRuntimeRequest,
    pendingGuestMessageCount: pendingGuestMessageCount(projection.thread.guestShare),
    // Thread detail owns message bodies. Keeping them out of shell rows makes
    // initial hydration and streaming updates independent of transcript size.
    latestVisibleMessage: null,
    latestUserMessageAt: latestUserMessage?.updatedAt ?? null,
    latestUserAuthoredMessageAt,
    hasActionableProposedPlan: projection.plans.some(
      (plan) => plan.kind === "proposed_plan" && plan.status === "active",
    ),
    pendingBackgroundTasks: [...pendingBackgroundTasks],
    providerInstanceHistory: providerInstanceHistoryForShell({
      threadId: projection.thread.id,
      providerThreads: projection.providerThreads,
    }),
    goal: activeProviderGoalForShell(
      projection.providerThreads,
      projection.thread.activeProviderThreadId,
    ),
    itemCount: activeLocalTurnItems(projection).length,
    visibleItemCount: projection.visibleTurnItems.length,
    createdAt: projection.thread.createdAt,
    updatedAt: projection.thread.updatedAt,
    archivedAt: projection.thread.archivedAt,
    settledOverride: projection.thread.settledOverride,
    settledAt: projection.thread.settledAt,
    unsettledAt: projection.thread.unsettledAt ?? null,
    snoozedUntil: projection.thread.snoozedUntil ?? null,
    snoozedAt: projection.thread.snoozedAt ?? null,
    pinnedAt: projection.thread.pinnedAt ?? null,

    autoSettleDisabledAt: projection.thread.autoSettleDisabledAt ?? null,
    pinOrderKey: projection.thread.pinOrderKey ?? null,
    ...(projection.thread.tags?.length ? { tags: projection.thread.tags } : {}),
    lastVisitedAt: projection.thread.lastVisitedAt,
    opens: projection.thread.opens ?? null,
    titleRegeneration: projection.thread.titleRegeneration ?? null,
    lastTitleRegeneration: projection.thread.lastTitleRegeneration ?? null,
    limitRecovery: projection.thread.limitRecovery ?? null,
    deletedAt: projection.thread.deletedAt,
  };
}

export function providerInstanceHistoryForShell(input: {
  readonly threadId: ThreadId;
  readonly providerThreads: ReadonlyArray<
    OrchestrationV2ThreadProjection["providerThreads"][number]
  >;
}): ReadonlyArray<ProviderInstanceId> {
  const history: Array<ProviderInstanceId> = [];
  for (const providerThread of input.providerThreads
    .filter((thread) => thread.appThreadId === input.threadId && thread.ownerNodeId === null)
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
        left.id.localeCompare(right.id),
    )) {
    if (!history.includes(providerThread.providerInstanceId)) {
      history.push(providerThread.providerInstanceId);
    }
  }
  return history;
}

export function activeProviderGoalForShell(
  providerThreads: ReadonlyArray<OrchestrationV2ThreadProjection["providerThreads"][number]>,
  activeProviderThreadId: OrchestrationV2ThreadProjection["thread"]["activeProviderThreadId"],
): OrchestrationV2ThreadShell["goal"] {
  return providerThreads.find((thread) => thread.id === activeProviderThreadId)?.goal ?? null;
}

function isSilentRunForShell(
  run: OrchestrationV2ThreadProjection["runs"][number],
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems">,
): boolean {
  return (
    run.status !== "failed" &&
    projection.messages.some(
      (message) => message.id === run.userMessageId && idleCompactionOf(message) !== undefined,
    ) &&
    !projection.turnItems.some(
      (item) => item.runId === run.id && item.type === "compaction" && item.status === "failed",
    )
  );
}

const BACKGROUND_WAKE_SOURCE_KINDS = new Set(["background_task", "command", "monitor"]);

function isBackgroundWakeRunForShell(
  run: OrchestrationV2ThreadProjection["runs"][number],
  projection: Pick<OrchestrationV2ThreadProjection, "messages">,
): boolean {
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  return (
    message?.delegatedCompletion === undefined &&
    // Only progress wakes; a terminal one ("Command … finished") is the work reporting its end.
    message?.notification?.outcome === "updated" &&
    BACKGROUND_WAKE_SOURCE_KINDS.has(message.notification.source.kind) &&
    // A follow-up the user steered into the wake makes the run theirs.
    !projection.messages.some(
      (candidate) => candidate.runId === run.id && candidate.createdBy === "user",
    )
  );
}

function isInterruptibleRunForShell(run: OrchestrationV2ThreadProjection["runs"][number]): boolean {
  return run.status === "preparing" || run.status === "starting" || run.status === "running";
}

type ShellActivityRunStatus = "preparing" | "running" | "starting" | "waiting";

function isActivityRunForShell(
  run: OrchestrationV2ThreadProjection["runs"][number],
): run is OrchestrationV2ThreadProjection["runs"][number] & {
  readonly status: ShellActivityRunStatus;
} {
  return isInterruptibleRunForShell(run) || run.status === "waiting";
}

export type ShellThreadState = {
  readonly thread: OrchestrationV2ThreadProjection["thread"];
  readonly latestRunId: RunId | null;
  readonly latestRunStatus: OrchestrationV2ShellThreadStatus;
  readonly latestRunRequestedAt: DateTime.Utc | null;
  readonly latestRunStartedAt: DateTime.Utc | null;
  readonly latestRunCompletedAt: DateTime.Utc | null;
  readonly latestRunStopRequested: boolean;
  readonly latestRunBackgroundWake: boolean;
  readonly activeRunId: RunId | null;
  readonly blockedOnThreadWait: boolean;
  readonly activityRunStatus: ShellActivityRunStatus | null;
  readonly activityRunStartedAt: DateTime.Utc | null;
  readonly lastError: string | null;
  readonly lastErrorClass: OrchestrationV2ThreadShell["lastErrorClass"];
  readonly lastErrorCode: OrchestrationV2ThreadShell["lastErrorCode"];
  readonly usageLimitResetAt: OrchestrationV2ThreadShell["usageLimitResetAt"];
  readonly pendingRuntimeRequest: OrchestrationV2PendingRuntimeRequestSummary | null;
  readonly latestUserMessageAt: DateTime.Utc | null;
  readonly latestUserAuthoredMessageAt: DateTime.Utc | null;
  readonly hasActionableProposedPlan: boolean;
  readonly pendingBackgroundTasks: OrchestrationV2ThreadShell["pendingBackgroundTasks"];
  readonly providerInstanceHistory: OrchestrationV2ThreadShell["providerInstanceHistory"];
  readonly goal: OrchestrationV2ThreadShell["goal"];
  readonly itemCount: number;
  readonly runlessItemCount: number;
  readonly updatedAt: OrchestrationV2ThreadProjection["updatedAt"];
  readonly runsById: ReadonlyMap<RunId, ShellRun>;
  readonly inheritedRunIds: ReadonlySet<RunId> | null;
  readonly itemCountByRunId: ReadonlyMap<RunId, number>;
};

export function shellStatusFromStoredRunStatus(
  status: string | null,
): OrchestrationV2ShellThreadStatus {
  switch (status) {
    case null:
      return "idle";
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
    case "completed":
    case "interrupted":
    case "failed":
    case "cancelled":
    case "rolled_back":
      return status;
    default:
      return "failed";
  }
}

function itemCountThroughRun(input: {
  readonly state: ShellThreadState;
  readonly runId: RunId;
  readonly forkCreatedAt: DateTime.Utc;
  readonly inheritedRunIds: ReadonlySet<RunId> | null;
}): number {
  const runOrdinal = input.state.runsById.get(input.runId)?.ordinal;
  if (runOrdinal === undefined) {
    return 0;
  }

  let count = input.state.thread.historyOrigin === "v1_import" ? input.state.runlessItemCount : 0;
  for (const [runId, itemCount] of input.state.itemCountByRunId) {
    const itemRun = input.state.runsById.get(runId);
    if (
      itemRun !== undefined &&
      itemRun.ordinal <= runOrdinal &&
      (input.inheritedRunIds?.has(runId) ??
        !isRolledBackBeforeFork(itemRun.rolledBackAt, input.forkCreatedAt))
    ) {
      count += itemCount;
    }
  }
  return count;
}

export function shellForkSourceIds(
  rows: ReadonlyArray<{ readonly forked_from_run_source_thread_id: string | null }>,
): ReadonlyArray<ThreadId> {
  return [
    ...new Set(
      rows.flatMap((row) =>
        row.forked_from_run_source_thread_id === null
          ? []
          : [ThreadId.make(row.forked_from_run_source_thread_id)],
      ),
    ),
  ];
}

export function visibleItemCountForShell(input: {
  readonly threadId: ThreadId;
  readonly statesByThreadId: ReadonlyMap<ThreadId, ShellThreadState>;
  readonly seenThreadIds?: ReadonlySet<ThreadId>;
}): number {
  const state = input.statesByThreadId.get(input.threadId);
  if (state === undefined) {
    return 0;
  }

  const forkedFrom = inheritedRunFork(state.thread);
  if (forkedFrom === null) {
    return state.itemCount;
  }

  const seenThreadIds = input.seenThreadIds ?? new Set<ThreadId>();
  if (seenThreadIds.has(state.thread.id)) {
    return state.itemCount;
  }

  const sourceState = input.statesByThreadId.get(forkedFrom.threadId);
  if (sourceState === undefined) {
    return state.itemCount;
  }

  const inheritedPrefixCount =
    inheritedRunFork(sourceState.thread) !== null
      ? visibleItemCountForShell({
          threadId: sourceState.thread.id,
          statesByThreadId: input.statesByThreadId,
          seenThreadIds: new Set([...seenThreadIds, state.thread.id]),
        }) - sourceState.itemCount
      : 0;

  return (
    inheritedPrefixCount +
    itemCountThroughRun({
      state: sourceState,
      runId: forkedFrom.runId,
      forkCreatedAt: state.thread.createdAt,
      inheritedRunIds: state.inheritedRunIds,
    }) +
    1 +
    state.itemCount
  );
}

export function shellFromState(input: {
  readonly state: ShellThreadState;
  readonly visibleItemCount: number;
}): OrchestrationV2ThreadShell {
  return {
    createdBy: input.state.thread.createdBy,
    creationSource: input.state.thread.creationSource,
    id: input.state.thread.id,
    projectId: input.state.thread.projectId,
    title: input.state.thread.title,
    providerInstanceId: input.state.thread.providerInstanceId,
    modelSelection: input.state.thread.modelSelection,
    runtimeMode: input.state.thread.runtimeMode,
    interactionMode: input.state.thread.interactionMode,
    branch: input.state.thread.branch,
    worktreePath: input.state.thread.worktreePath,
    pullRequests: threadPullRequestsOf(input.state.thread),
    ...(input.state.thread.linkedPullRequest === undefined
      ? {}
      : { linkedPullRequest: input.state.thread.linkedPullRequest }),
    ...(input.state.thread.branchPullRequest === undefined
      ? {}
      : { branchPullRequest: input.state.thread.branchPullRequest }),
    ...(input.state.thread.issues === undefined ? {} : { issues: input.state.thread.issues }),
    ...(input.state.thread.activeOrderKey === undefined
      ? {}
      : { activeOrderKey: input.state.thread.activeOrderKey }),
    lineage: input.state.thread.lineage,
    forkedFrom: input.state.thread.forkedFrom,
    activeProviderThreadId: input.state.thread.activeProviderThreadId,
    ...(input.state.thread.historyOrigin === undefined
      ? {}
      : { historyOrigin: input.state.thread.historyOrigin }),
    ...(input.state.thread.linkOrigin === undefined
      ? {}
      : { linkOrigin: input.state.thread.linkOrigin }),
    ...(input.state.thread.delegatedFrom === undefined
      ? {}
      : { delegatedFrom: input.state.thread.delegatedFrom }),
    ...(input.state.thread.workflowRun === undefined
      ? {}
      : { workflowRun: input.state.thread.workflowRun }),
    latestRunId: input.state.latestRunId,
    latestRunRequestedAt: input.state.latestRunRequestedAt,
    latestRunStartedAt: input.state.latestRunStartedAt,
    latestRunCompletedAt: input.state.latestRunCompletedAt,
    latestRunStopRequested: input.state.latestRunStopRequested,
    latestRunBackgroundWake: input.state.latestRunBackgroundWake,
    activeRunId: input.state.activeRunId,
    blockedOnThreadWait: input.state.blockedOnThreadWait,
    activityRunStatus: input.state.activityRunStatus,
    activityRunStartedAt: input.state.activityRunStartedAt,
    status: input.state.latestRunStatus,
    lastError: input.state.lastError,
    lastErrorClass: input.state.lastErrorClass,
    lastErrorCode: input.state.lastErrorCode,
    usageLimitResetAt: input.state.usageLimitResetAt,
    pendingRuntimeRequest: input.state.pendingRuntimeRequest,
    pendingGuestMessageCount: pendingGuestMessageCount(input.state.thread.guestShare),
    latestVisibleMessage: null,
    latestUserMessageAt: input.state.latestUserMessageAt,
    latestUserAuthoredMessageAt: input.state.latestUserAuthoredMessageAt,
    hasActionableProposedPlan: input.state.hasActionableProposedPlan,
    pendingBackgroundTasks: input.state.pendingBackgroundTasks,
    providerInstanceHistory: input.state.providerInstanceHistory,
    goal: input.state.goal,
    itemCount: input.state.itemCount,
    visibleItemCount: input.visibleItemCount,
    createdAt: input.state.thread.createdAt,
    updatedAt: input.state.updatedAt,
    archivedAt: input.state.thread.archivedAt,
    settledOverride: input.state.thread.settledOverride,
    settledAt: input.state.thread.settledAt,
    unsettledAt: input.state.thread.unsettledAt ?? null,
    snoozedUntil: input.state.thread.snoozedUntil ?? null,
    snoozedAt: input.state.thread.snoozedAt ?? null,
    pinnedAt: input.state.thread.pinnedAt ?? null,

    autoSettleDisabledAt: input.state.thread.autoSettleDisabledAt ?? null,
    pinOrderKey: input.state.thread.pinOrderKey ?? null,
    ...(input.state.thread.tags?.length ? { tags: input.state.thread.tags } : {}),
    lastVisitedAt: input.state.thread.lastVisitedAt,
    opens: input.state.thread.opens ?? null,
    titleRegeneration: input.state.thread.titleRegeneration ?? null,
    lastTitleRegeneration: input.state.thread.lastTitleRegeneration ?? null,
    limitRecovery: input.state.thread.limitRecovery ?? null,
    deletedAt: input.state.thread.deletedAt,
  };
}

// Dynamic tool output the client renders inline (HTML, MCP apps, viewed images, delegated
// tasks, messages sent to the user), so its work group never defers. Mirrors the LIKE backfill
// in migration 095, where a tool name counts anywhere after the first toolName. Searching from
// that first one once avoids rescanning the payload for every nested toolName.
const INLINE_WORK_OUTPUT = new RegExp(
  `htmlRender|${MCP_APP_OUTPUT_KEY}|"viewedImagePath"|sentMessage`,
  "i",
);
const TOOL_NAME_PREFIX = /"toolName":"/i;
const INLINE_TOOL_NAME = /(?:delegate.task|send.to.user)"/is;

export const isInlineWorkOutput = (payloadJson: string) => {
  if (INLINE_WORK_OUTPUT.test(payloadJson)) return true;
  const toolName = TOOL_NAME_PREFIX.exec(payloadJson);
  return (
    toolName !== null &&
    INLINE_TOOL_NAME.test(payloadJson.slice(toolName.index + toolName[0].length))
  );
};

export function makeProjectionSqlHelpers(sql: SqlClient.SqlClient) {
  // SQLite uses the partial conversation index of migration 082 only for this exact predicate.
  const CONVERSATION_INDEX_EXCLUDED_TYPES = sql.literal(
    `(${DEFERRED_WORK_ITEM_TYPES.map((type) => `'${type}'`).join(", ")})`,
  );

  // Other node indexes also start with thread_id. Without this hint SQLite reads a thread's live
  // nodes through one of them and fetches every node of the thread to check its status. The
  // query must filter on the same status list as the index of migration 060.
  const LIVE_NODES_INDEX = sql.literal("INDEXED BY orchestration_v2_projection_nodes_live_idx");

  // An ended task whose completion was acknowledged, delivered or disposed, outside an active run.
  const settledSubagent = (row: Statement.Fragment) => sql`(
    ${row}.status IN ('completed', 'failed', 'cancelled', 'interrupted')
    AND COALESCE(${row}.completion_delivery_state, '') IN ('acknowledged', 'delivered', 'disposed')
    AND NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_runs AS run
        INDEXED BY orchestration_v2_projection_runs_run_status_idx
      WHERE run.run_id = ${row}.run_id
        AND run.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
    )
  )`;

  // The settled index holds every column the check reads, so the settled tasks are dropped
  // there and their rows, each with a full prompt, stay unread.
  const unsettledSubagentRowids = (threadId: ThreadId) => sql`
    SELECT candidate.rowid
    FROM orchestration_v2_projection_subagents AS candidate
      INDEXED BY orchestration_v2_projection_subagents_settled_idx
    WHERE candidate.thread_id = ${threadId}
      AND NOT ${settledSubagent(sql`candidate`)}
  `;

  // A todo list is never closed when its run ends, so a long thread holds an active one per
  // old run. Counting those as live work drags each run's nodes and subagents into every window.
  const todoListOfSettledRun = (row: Statement.Fragment) => sql`(
    ${row}.kind = 'todo_list' AND ${row}.run_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_runs AS todo_run
        INDEXED BY orchestration_v2_projection_runs_run_status_idx
      WHERE todo_run.run_id = ${row}.run_id
        AND todo_run.status IN ('queued','preparing','starting','running','waiting')
    ))`;

  // Start from the few owned provider threads; a thread can have a large settled node history.
  const nodesOwningProviderThreads = (threadId: ThreadId) => sql`
    SELECT owner.node_id
    FROM orchestration_v2_projection_provider_threads AS owned
      INDEXED BY orchestration_v2_projection_provider_threads_owner_idx
    CROSS JOIN orchestration_v2_projection_nodes AS owner
      ON owner.node_id = owned.owner_node_id
    WHERE owned.owner_node_id IS NOT NULL AND owner.thread_id = ${threadId}
  `;

  // Mirror idleCompactionOf, including JavaScript trim whitespace.
  const isIdleCompactionMessage = (alias: string) => {
    const payload = sql.literal(`${alias}.payload_json`);
    return sql`(
      ${sql.literal(`${alias}.role`)} = 'user'
      AND lower(trim(json_extract(${payload}, '$.text'),
        char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195,
          8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)
      )) = ${IDLE_COMPACTION_TEXT}
      AND coalesce(json_array_length(${payload}, '$.attachments'), 0) = 0
      AND (
        json_extract(${payload}, '$.idleCompaction') IS NOT NULL
        OR (
          json_extract(${payload}, '$.createdBy') = 'agent'
          AND json_extract(${payload}, '$.creationSource') = 'server'
        )
      )
    )`;
  };

  // Mirrors isSilentRunForShell.
  const isSilentShellRun = (alias: string) => {
    const run = sql.literal(alias);
    return sql`(
      ${run}.status <> 'failed'
      AND EXISTS (
        SELECT 1 FROM orchestration_v2_projection_messages prompt
        WHERE prompt.message_id = json_extract(${run}.payload_json, '$.userMessageId')
          AND ${isIdleCompactionMessage("prompt")}
      ) AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items compaction
        WHERE compaction.thread_id = ${run}.thread_id AND compaction.run_id = ${run}.run_id
          AND compaction.type = 'compaction'
          AND compaction.status = 'failed'
      )
    )`;
  };

  // The newest run not held or outlived before it started, matching latestUnheldRun.
  const presentedShellRunId = (threadId: Statement.Fragment) => sql`(
    SELECT candidate.run_id
    FROM orchestration_v2_projection_runs candidate
    WHERE candidate.thread_id = ${threadId}
      AND NOT (
        candidate.status = 'queued'
        AND json_extract(candidate.payload_json, '$.queueHeld') IS 1
      )
      AND NOT (
        candidate.status = 'cancelled'
        AND json_extract(candidate.payload_json, '$.startedAt') IS NULL
        AND candidate.completed_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs earlier
          WHERE earlier.thread_id = candidate.thread_id
            AND earlier.ordinal < candidate.ordinal
            AND earlier.status <> 'queued'
            AND NOT ${isSilentShellRun("earlier")}
            AND (
              earlier.completed_at IS NULL
              OR julianday(earlier.completed_at) >= julianday(candidate.completed_at)
            )
        )
      )
      AND NOT ${isSilentShellRun("candidate")}
    ORDER BY candidate.ordinal DESC, candidate.run_id DESC
    LIMIT 1
  )`;

  // Mirrors isBackgroundWakeRunForShell. Stored sources keep the legacy encoding, where a
  // command is background_command and a subagent is background_task with work "subagent".
  const isBackgroundWakeShellRun = (alias: string) => {
    const run = sql.literal(alias);
    return sql`EXISTS (
      SELECT 1 FROM orchestration_v2_projection_messages wake
      WHERE wake.message_id = json_extract(${run}.payload_json, '$.userMessageId')
        AND json_extract(wake.payload_json, '$.notification.source.kind')
          IN ('background_task', 'background_command', 'command', 'monitor')
        AND json_extract(wake.payload_json, '$.notification.source.work') IS NULL
        AND json_extract(wake.payload_json, '$.notification.outcome') = 'updated'
        AND json_extract(wake.payload_json, '$.delegatedCompletion') IS NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_messages steer
      WHERE steer.run_id = ${run}.run_id
        AND json_extract(steer.payload_json, '$.createdBy') = 'user'
    )`;
  };

  const selectThread = (threadId: ThreadId) =>
    sql<PayloadRow>`
      SELECT payload_json FROM orchestration_v2_projection_threads
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(null) : decodeThreadPayload(rows[0].payload_json),
      ),
      Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })),
    );

  const getThread = Effect.fn("ProjectionStore.getThread")(function* (threadId: ThreadId) {
    const thread = yield* selectThread(threadId);
    if (thread === null) return yield* new ProjectionStoreThreadNotFoundError({ threadId });
    return thread;
  });

  const findThread = Effect.fn("ProjectionStore.findThread")(selectThread);

  const requireThread = Effect.fn("ProjectionStore.requireThread")(function* (threadId: ThreadId) {
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} LIMIT 1
    `;
    if (rows.length === 0) return yield* new ProjectionStoreThreadNotFoundError({ threadId });
  });

  return {
    CONVERSATION_INDEX_EXCLUDED_TYPES,
    LIVE_NODES_INDEX,
    settledSubagent,
    unsettledSubagentRowids,
    todoListOfSettledRun,
    nodesOwningProviderThreads,
    isIdleCompactionMessage,
    isSilentShellRun,
    presentedShellRunId,
    isBackgroundWakeShellRun,
    getThread,
    findThread,
    requireThread,
  };
}

export type ProjectionSqlHelpers = ReturnType<typeof makeProjectionSqlHelpers>;
