import type {
  CheckpointId,
  CheckpointScopeId,
  GuestShareId,
  MessageId,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
  OrchestrationV2ExecutionNode,
  OrchestrationV2PlanArtifact,
  OrchestrationV2Run,
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadLinkMetadata,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2TurnItem,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@zerocode/contracts";
import {
  applyOrchestrationV2ThreadVisit,
  isQueuedProviderThreadPlaceholder,
} from "@zerocode/contracts";
import * as NodeSqliteClient from "@zerocode/shared/nodeSqliteClient";
import {
  attributePendingBackgroundTasks,
  createEmptyOrchestrationV2ThreadProjection,
  reduceOrchestrationV2ThreadProjection,
  upsertProviderTurn,
} from "@zerocode/shared/orchestrationV2ProjectionReducer";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import type * as Stream from "effect/Stream";

import { applyThreadPullRequestLinkUpdate } from "../sourceControl/threadPullRequests.ts";
import { readableSearchText } from "./messageSearchIndex.ts";
import {
  type ActiveShellIndexEntry,
  type ActiveThreadListEntry,
  type AgentAwarenessThread,
  ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
  type OlderSettledThreadsListing,
  type OlderSettledThreadsQuery,
  type PayloadRow,
  type ProjectionCheckpointCaptureContext,
  type ProjectionCheckpointContext,
  type ProjectionCheckpointRollbackContext,
  type ProjectionLimitRecoveryCandidate,
  type ProjectionPendingUserInputs,
  type ProjectionProviderControlContext,
  type ProjectionProviderControlTarget,
  type ProjectionRecordField,
  type ProjectionRecordFilter,
  type ProjectionRecords,
  type ProjectionRecoveryKind,
  type ProjectionRuntimeRecoveryState,
  type ProjectionRuntimeResponseContext,
  type ProjectionSettlementCandidate,
  ProjectionStoreApplyEventError,
  ProjectionStoreReadError,
  ProjectionStoreSetupError,
  ProjectionStoreThreadNotFoundError,
  ProjectionStoreV2Error,
  type ProjectionThreadProviderContext,
  type ProjectionThreadPullRequests,
  type ProjectionTimelinePage,
  type ProjectionTimelinePageOptions,
  type ProjectionWindowOptions,
  type PullRequestThread,
  type ShellSnapshotOptions,
  type TimelineIndexCache,
  booleanInt,
  controlReadError,
  decodeProviderThreadPayload,
  decodeProviderTurnPayload,
  decodeThreadPayload,
  encodeCheckpointPayload,
  encodeCheckpointScopePayload,
  encodeContextHandoffPayload,
  encodeContextTransferPayload,
  encodeMessagePayload,
  encodeNodePayload,
  encodePlanPayload,
  encodeProviderSessionPayload,
  encodeProviderThreadPayload,
  encodeProviderTurnPayload,
  encodeRestartCancelledBackgroundWork,
  encodeRunAttemptPayload,
  encodeRunOutput,
  encodeRunPayload,
  encodeRuntimeRequestPayload,
  encodeSubagentPayload,
  encodeThreadPayload,
  encodeThreadUpdatedAt,
  encodeTurnItemPayload,
  forkInheritedRunOrdinals,
  formatNullableIso,
  isInlineWorkOutput,
  makeProjectionSqlHelpers,
  threadShellFromProjection,
} from "./projection/ProjectionRowDecoders.ts";
import { makeRecoveryReadStore } from "./projection/RecoveryReadStore.ts";
import { makeShellProjectionReadStore } from "./projection/ShellProjectionReadStore.ts";
import { makeThreadWindowReadStore } from "./projection/ThreadWindowReadStore.ts";

export {
  type ActiveShellIndexEntry,
  type ActiveThreadListEntry,
  type AgentAwarenessThread,
  ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
  type OlderSettledThreadsListing,
  type OlderSettledThreadsQuery,
  type ProjectionCheckpointCaptureContext,
  type ProjectionCheckpointContext,
  type ProjectionCheckpointRollbackContext,
  type ProjectionLimitRecoveryCandidate,
  type ProjectionPendingUserInputs,
  type ProjectionProviderControlContext,
  type ProjectionProviderControlTarget,
  type ProjectionRecordField,
  type ProjectionRecordFilter,
  type ProjectionRecords,
  type ProjectionRecoveryKind,
  type ProjectionRuntimeRecoveryState,
  type ProjectionRuntimeResponseContext,
  type ProjectionSettlementCandidate,
  ProjectionStoreApplyEventError,
  ProjectionStoreReadError,
  ProjectionStoreSetupError,
  ProjectionStoreThreadNotFoundError,
  ProjectionStoreV2Error,
  type ProjectionThreadProviderContext,
  type ProjectionThreadPullRequests,
  type ProjectionTimelinePage,
  type ProjectionTimelinePageOptions,
  type ShellSnapshotOptions,
  encodeProviderThreadPayload,
  encodeSubagentPayload,
  encodeTurnItemPayload,
  forkInheritedRunOrdinals,
  threadShellFromProjection,
};

export interface ProjectionStoreV2Shape {
  readonly searchThreadStream: (
    input: OrchestrationV2SearchThreadInput,
  ) => Stream.Stream<OrchestrationV2SearchThreadResult, ProjectionStoreV2Error>;
  readonly searchThread: (
    input: OrchestrationV2SearchThreadInput,
  ) => Effect.Effect<OrchestrationV2SearchThreadResult, ProjectionStoreV2Error>;
  /** Files thread deletion may remove; `includeShownByLiveFork` adds ones a live fork shows. */
  readonly getThreadAttachmentIds: (
    threadId: ThreadId,
    options?: { readonly includeShownByLiveFork?: boolean },
  ) => Effect.Effect<ReadonlyArray<string>, ProjectionStoreV2Error>;
  readonly getThreadHistoryPage: (
    threadId: ThreadId,
    cursor: string,
    throughEntryId?: string,
    conversationOnly?: boolean,
    workMode?: "deferred" | "work",
  ) => Effect.Effect<OrchestrationV2ThreadHistoryPage, ProjectionStoreV2Error>;
  readonly getTimelinePage: (
    threadId: ThreadId,
    options: ProjectionTimelinePageOptions,
  ) => Effect.Effect<ProjectionTimelinePage, ProjectionStoreV2Error>;
  readonly getMessageCount: (threadId: ThreadId) => Effect.Effect<number, ProjectionStoreV2Error>;
  /** Bytes of tool output a transcript export is sure to hold, or 0 when it can fit in `limit`. */
  readonly getTranscriptByteFloor: (
    threadId: ThreadId,
    limit: number,
  ) => Effect.Effect<number, ProjectionStoreV2Error>;
  readonly getSubagentCount: (threadId: ThreadId) => Effect.Effect<number, ProjectionStoreV2Error>;
  readonly getRunCount: (threadId: ThreadId) => Effect.Effect<number, ProjectionStoreV2Error>;
  /** Child threads of the thread's app-owned tasks, in task order, without decoding the tasks. */
  readonly listAppOwnedChildThreadIds: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionStoreV2Error>;
  readonly hasPendingDelegatedCompletion: (
    childThreadId: ThreadId,
  ) => Effect.Effect<boolean, ProjectionStoreV2Error>;
  readonly getNextTurnItemOrdinal: (
    threadId: ThreadId,
  ) => Effect.Effect<number, ProjectionStoreV2Error>;
  readonly getTurnItem: (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) => Effect.Effect<OrchestrationV2TurnItem | null, ProjectionStoreV2Error>;
  readonly getMessagesById: (
    threadId: ThreadId,
    messageIds: ReadonlyArray<MessageId>,
  ) => Effect.Effect<
    ReadonlyMap<MessageId, OrchestrationV2ConversationMessage>,
    ProjectionStoreV2Error
  >;
  readonly getThreadRecords: <K extends ProjectionRecordField>(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, ProjectionStoreV2Error>;

  readonly getForkSourceRunIds: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<RunId>, ProjectionStoreV2Error>;

  readonly apply: (
    event: OrchestrationV2DomainEvent,
  ) => Effect.Effect<void, ProjectionStoreV2Error>;
  readonly getPullRequestSnapshot: (options: {
    readonly threadId?: ThreadId;
    readonly unsettledOnly?: boolean;
  }) => Effect.Effect<
    {
      readonly snapshotSequence: number;
      readonly threads: ReadonlyArray<typeof PullRequestThread.Type>;
    },
    ProjectionStoreV2Error
  >;
  readonly getAgentAwarenessSnapshot: (
    threadId?: ThreadId,
  ) => Effect.Effect<
    { readonly snapshotSequence: number; readonly threads: ReadonlyArray<AgentAwarenessThread> },
    ProjectionStoreV2Error
  >;
  readonly getShellSnapshot: (
    options?: ShellSnapshotOptions,
  ) => Effect.Effect<OrchestrationV2ThreadShellSnapshot, ProjectionStoreV2Error>;
  readonly listActiveSubagentThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProjectionStoreV2Error
  >;
  readonly listEphemeralThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProjectionStoreV2Error
  >;
  /** Threads that are not deleted, archived ones included. */
  readonly countThreads: () => Effect.Effect<number, ProjectionStoreV2Error>;
  /** Every active thread, in shell order. */
  readonly listActiveShellIndex: () => Effect.Effect<
    ReadonlyArray<ActiveShellIndexEntry>,
    ProjectionStoreV2Error
  >;
  /** Every active thread, or one project's. */
  readonly listActiveThreads: (
    projectId?: ProjectId,
  ) => Effect.Effect<ReadonlyArray<ActiveThreadListEntry>, ProjectionStoreV2Error>;
  /** Older settled thread ids below a cursor, newest settle first, and per-project counts. */
  readonly listOlderSettledThreads: (
    query: OlderSettledThreadsQuery,
  ) => Effect.Effect<OlderSettledThreadsListing, ProjectionStoreV2Error>;
  /**
   * Callers that combine the shell with other reads run this inside their own
   * transaction and the returned decode after it commits, so the shared
   * connection is not held while thousands of rows are converted.
   */
  readonly readShellSnapshot: (
    options?: ShellSnapshotOptions,
  ) => Effect.Effect<
    Effect.Effect<OrchestrationV2ThreadShellSnapshot, ProjectionStoreV2Error>,
    ProjectionStoreV2Error
  >;
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell | null, ProjectionStoreV2Error>;
  /** The thread whose current guest share has this id. Scans thread rows; only redeem uses it. */
  readonly findGuestShareThreadId: (
    shareId: GuestShareId,
  ) => Effect.Effect<ThreadId | null, ProjectionStoreV2Error>;
  readonly getThread: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2AppThread, ProjectionStoreV2Error>;
  /** Like getThread, but a missing thread is null, so an expected miss is not an error span. */
  readonly findThread: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2AppThread | null, ProjectionStoreV2Error>;
  readonly getLimitRecoveryCandidates: (options: {
    readonly now: DateTime.Utc;
    readonly autoResume: boolean;
    readonly snooze: boolean;
  }) => Effect.Effect<ReadonlyArray<ProjectionLimitRecoveryCandidate>, ProjectionStoreV2Error>;
  /** Epoch ms of the next armed reset or snooze end after `now`, when a waiting thread becomes a candidate. */
  readonly getLimitRecoveryWakeAt: (
    now: DateTime.Utc,
  ) => Effect.Effect<number | null, ProjectionStoreV2Error>;
  readonly getSettlementCandidates: (
    threadId?: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ProjectionSettlementCandidate>, ProjectionStoreV2Error>;
  readonly getThreadsWithPullRequests: (
    threadId?: ThreadId,
    options?: { readonly includeArchived?: boolean },
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadPullRequests>, ProjectionStoreV2Error>;
  /** Titles of the given threads that exist, archived ones included. */
  readonly getThreadLinkMetadata: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<Record<ThreadId, OrchestrationV2ThreadLinkMetadata>, ProjectionStoreV2Error>;
  readonly getThreadTitles: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<Record<ThreadId, string>, ProjectionStoreV2Error>;
  readonly getThreadWorktreePaths: (options?: {
    readonly includeArchived?: boolean;
  }) => Effect.Effect<
    ReadonlyArray<{ readonly threadId: ThreadId; readonly worktreePath: string }>,
    ProjectionStoreV2Error
  >;
  /**
   * Delegated tasks in a linked environment with work left for this one: no
   * result yet, or cancelled or stopped here without that stop reaching there,
   * including a Stop after the task had its result.
   */
  readonly getOpenRemoteDelegatedTasks: Effect.Effect<
    ReadonlyArray<{ readonly parentThreadId: ThreadId; readonly taskId: NodeId }>,
    ProjectionStoreV2Error
  >;
  readonly getTurnStartContext: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<
    Pick<
      OrchestrationV2ThreadProjection,
      | "thread"
      | "runs"
      | "attempts"
      | "nodes"
      | "subagents"
      | "providerSessions"
      | "providerThreads"
      | "providerTurns"
      | "messages"
      | "checkpointScopes"
      | "contextHandoffs"
      | "contextTransfers"
      | "turnItems"
    > & { readonly hasConversation: boolean },
    ProjectionStoreV2Error
  >;
  readonly getTurnStartHistory: (
    threadId: ThreadId,
    runIds?: ReadonlyArray<RunId>,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2TurnItem>, ProjectionStoreV2Error>;
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, ProjectionStoreV2Error>;
  readonly getRuntimeRecoveryProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectionRuntimeRecoveryState, ProjectionStoreV2Error>;
  readonly getPendingNativeUserInputs: (
    threadId: ThreadId,
    providerTurnId: ProviderTurnId,
  ) => Effect.Effect<ProjectionPendingUserInputs, ProjectionStoreV2Error>;
  readonly getPlan: (
    threadId: ThreadId,
    planId: PlanId,
  ) => Effect.Effect<OrchestrationV2PlanArtifact | undefined, ProjectionStoreV2Error>;
  readonly hasUnpairedRunInterruptRequest: (
    threadId: ThreadId,
    requestId: TurnItemId,
    resultId: TurnItemId,
  ) => Effect.Effect<boolean, ProjectionStoreV2Error>;
  /** Whether Stop reached the run. Reads one index entry, however long the thread is. */
  readonly hasRunInterruptRequest: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<boolean, ProjectionStoreV2Error>;
  /** One run and node with the run's provider thread, active attempt and provider turn, read together. */
  readonly getRunProviderRecords: (
    threadId: ThreadId,
    runId: RunId,
    nodeId: NodeId,
  ) => Effect.Effect<
    ProjectionRecords<"runs" | "nodes" | "providerThreads" | "providerTurns" | "attempts">,
    ProjectionStoreV2Error
  >;
  /** `getRunProviderRecords` and the thread's cards of one type, read together. */
  readonly getRunCardRecords: (
    threadId: ThreadId,
    runId: RunId,
    nodeId: NodeId,
    cardType: "secret_request" | "link_request",
  ) => Effect.Effect<
    ProjectionRecords<
      "runs" | "nodes" | "providerThreads" | "providerTurns" | "attempts" | "turnItems"
    >,
    ProjectionStoreV2Error
  >;
  readonly isNodeStored: (
    node: OrchestrationV2ExecutionNode,
  ) => Effect.Effect<boolean, ProjectionStoreV2Error>;
  readonly getRuntimeRequest: (
    threadId: ThreadId,
    requestId: RuntimeRequestId,
  ) => Effect.Effect<
    OrchestrationV2ThreadProjection["runtimeRequests"][number] | undefined,
    ProjectionStoreV2Error
  >;
  readonly getProviderControlContext: (
    threadId: ThreadId,
    target: ProjectionProviderControlTarget,
  ) => Effect.Effect<ProjectionProviderControlContext, ProjectionStoreV2Error>;
  readonly getRunningTurnContext: (
    threadId: ThreadId,
  ) => Effect.Effect<
    Pick<ProjectionProviderControlContext, "run" | "providerThread" | "providerTurn">,
    ProjectionStoreV2Error
  >;
  readonly getThreadProviderContext: (
    threadId: ThreadId,
    targetInstanceId?: ProviderInstanceId,
  ) => Effect.Effect<ProjectionThreadProviderContext, ProjectionStoreV2Error>;
  readonly getRuntimeResponseContext: (
    threadId: ThreadId,
    requestId: RuntimeRequestId,
  ) => Effect.Effect<ProjectionRuntimeResponseContext, ProjectionStoreV2Error>;
  readonly getCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectionCheckpointContext, ProjectionStoreV2Error>;
  readonly getCheckpointCaptureContext: (
    threadId: ThreadId,
    target: { readonly runId: RunId; readonly scopeId: CheckpointScopeId },
  ) => Effect.Effect<ProjectionCheckpointCaptureContext, ProjectionStoreV2Error>;
  readonly getCheckpointRollbackContext: (
    threadId: ThreadId,
    target: {
      readonly providerThreadId: ProviderThreadId;
      readonly checkpointId: CheckpointId;
      readonly scopeId: CheckpointScopeId;
    },
  ) => Effect.Effect<ProjectionCheckpointRollbackContext, ProjectionStoreV2Error>;
  readonly getRunMessage: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<OrchestrationV2ConversationMessage | undefined, ProjectionStoreV2Error>;
  readonly getRun: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<OrchestrationV2Run | undefined, ProjectionStoreV2Error>;
  /**
   * One snapshot: the `windowSize` runs that ended last, unfinished runs, the runs of `taskIds` and
   * their wakes. `runsFloor` is set when older runs were left out; every run that ran after it is
   * in `runs`.
   */
  readonly getDelegatedChildControls: (
    threadId: ThreadId,
    input: { readonly taskIds: ReadonlyArray<NodeId>; readonly windowSize: number },
  ) => Effect.Effect<
    ProjectionRecords<"runs" | "messages" | "subagents" | "providerThreads"> & {
      readonly runsFloor: OrchestrationV2Run | undefined;
    },
    ProjectionStoreV2Error
  >;
  readonly canStartQueuedRun: (
    threadId: ThreadId,
  ) => Effect.Effect<boolean, ProjectionStoreV2Error>;
  readonly getHeldQueuedRuns: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2Run>, ProjectionStoreV2Error>;
  readonly getRecoveryThreadIds: (
    kind: ProjectionRecoveryKind,
    projects?: {
      readonly include?: ReadonlyArray<string>;
      readonly exclude?: ReadonlyArray<string>;
    },
  ) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionStoreV2Error>;
  readonly getUnreadableThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProjectionStoreV2Error
  >;
  readonly getThreadSnapshot: (threadId: ThreadId) => Effect.Effect<
    {
      readonly schemaVersion: number;
      readonly snapshotSequence: number;
      readonly projection: OrchestrationV2ThreadProjection;
    },
    ProjectionStoreV2Error
  >;
  /** Context handoffs come without `history` and `delivery`; no window reader uses them. */
  readonly getThreadSnapshotWindow: (
    threadId: ThreadId,
    options: ProjectionWindowOptions,
  ) => Effect.Effect<
    {
      readonly schemaVersion: number;
      readonly snapshotSequence: number;
      readonly projection: OrchestrationV2ThreadProjection;
    },
    ProjectionStoreV2Error
  >;
}

export class ProjectionStoreV2 extends Context.Service<ProjectionStoreV2, ProjectionStoreV2Shape>()(
  "zerocode/orchestration-v2/ProjectionStore/ProjectionStoreV2",
) {}

// The provider batch owns the writer, so no other write can change these rows before it commits.
export interface ProviderBatchProjection {
  readonly nodeReads: Map<NodeId, string | undefined>;
  /** Thread `updated_at` bumps, written once by `writeThreadTouches` before the batch commits. */
  readonly threadTouches: Map<ThreadId, string>;
}
export class ProviderBatchProjectionState extends Context.Reference<
  ProviderBatchProjection | undefined
>("zerocode/orchestration-v2/ProjectionStore/ProviderBatchProjectionState", {
  defaultValue: () => undefined,
}) {}

// Runs per projected event or once per batch; the projection or batch commit span traces it.
export const writeThreadTouches = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  touches: ReadonlyMap<ThreadId, string>,
) {
  for (const [threadId, updatedAt] of touches) {
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET
        updated_at = ${updatedAt},
        payload_json = json_set(payload_json, '$.updatedAt', ${updatedAt})
      WHERE thread_id = ${threadId}
    `;
  }
});

export function emptyProjection(
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }>,
): OrchestrationV2ThreadProjection {
  return createEmptyOrchestrationV2ThreadProjection(event);
}

export function applyToProjection(
  projection: OrchestrationV2ThreadProjection,
  event: OrchestrationV2DomainEvent,
): OrchestrationV2ThreadProjection {
  return reduceOrchestrationV2ThreadProjection(projection, event, {
    applyThreadPullRequestLinkUpdate,
    touchThreadUpdatedAt: true,
    visibleTurnItemsMode: "local-rebuild",
  }).projection;
}

export const layer: Layer.Layer<ProjectionStoreV2, never, SqlClient.SqlClient> = Layer.effect(
  ProjectionStoreV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const helpers = makeProjectionSqlHelpers(sql);
    const { getThread, findThread } = helpers;

    const keepRecordedRunField = (payload: Statement.Fragment, path: string) => sql`
      CASE
        WHEN json_type(excluded.payload_json, ${path}) IS NULL
          AND json_type(orchestration_v2_projection_runs.payload_json, ${path}) IS NOT NULL
        THEN json_set(
          ${payload},
          ${path},
          json_extract(orchestration_v2_projection_runs.payload_json, ${path})
        )
        ELSE ${payload}
      END
    `;
    // Only a submission sets the output; a lifecycle write carries it as it was when read.
    const keepRecordedRunOutput = (payload: Statement.Fragment) => sql`
      CASE
        WHEN json_type(orchestration_v2_projection_runs.payload_json, '$.output') IS NOT NULL
        THEN json_set(
          ${payload},
          '$.output',
          json_extract(orchestration_v2_projection_runs.payload_json, '$.output')
        )
        ELSE ${payload}
      END
    `;

    const timelineIndexes: TimelineIndexCache = new Map();

    const apply: ProjectionStoreV2Shape["apply"] =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(
        function* (event) {
          for (const [key, cached] of timelineIndexes) {
            if (cached.index.threadIds.includes(event.threadId)) timelineIndexes.delete(key);
          }
          const batch = yield* ProviderBatchProjectionState;
          // These rewrite the thread row from what they read, so a deferred bump must land first.
          const rewrittenThreadId = event.type.startsWith("thread.")
            ? event.threadId
            : event.type === "provider-thread.updated"
              ? event.payload.appThreadId
              : null;
          const deferredUpdatedAt =
            rewrittenThreadId === null ? undefined : batch?.threadTouches.get(rewrittenThreadId);
          if (
            batch !== undefined &&
            rewrittenThreadId !== null &&
            deferredUpdatedAt !== undefined
          ) {
            batch.threadTouches.delete(rewrittenThreadId);
            yield* writeThreadTouches(sql, new Map([[rewrittenThreadId, deferredUpdatedAt]]));
          }
          switch (event.type) {
            case "thread.pull-request-link-updated": {
              const thread = yield* getThread(event.threadId);
              yield* apply({
                ...event,
                type: "thread.pull-request-synced",
                payload: applyThreadPullRequestLinkUpdate(thread, event.payload),
              });
              break;
            }
            case "thread.visit-recorded": {
              const thread = yield* getThread(event.threadId);
              yield* apply({
                ...event,
                type: "thread.visited",
                payload: applyOrchestrationV2ThreadVisit(thread, event.payload),
              });
              break;
            }
            case "thread.created":
            case "thread.archived":
            case "thread.unarchived":
            case "thread.deleted":
            case "thread.settled":
            case "thread.unsettled":
            case "thread.snoozed":
            case "thread.unsnoozed":
            case "thread.auto-settle-set":
            case "thread.pinned":
            case "thread.unpinned":
            case "thread.pin-reordered":
            case "thread.active-reordered":
            case "thread.tags-updated":
            case "thread.visited":
            case "thread.marked-unread":
            case "thread.metadata-updated":
            case "thread.pull-request-synced":
            case "thread.issue-synced":
            case "thread.runtime-mode-updated":
            case "thread.interaction-mode-updated":
            case "thread.model-selection-updated":
            case "thread.provider-switched":
            case "thread.guest-share-updated": {
              const payloadJson = yield* encodeThreadPayload(event.payload);
              yield* sql`
              INSERT INTO orchestration_v2_projection_threads (
                thread_id,
                project_id,
                title,
                default_provider,
                provider_instance_id,
                runtime_mode,
                interaction_mode,
                active_provider_thread_id,
                created_at,
                updated_at,
                archived_at,
                deleted_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.projectId},
                ${event.payload.title},
                ${event.payload.providerInstanceId},
                ${event.payload.providerInstanceId},
                ${event.payload.runtimeMode},
                ${event.payload.interactionMode},
                ${event.payload.activeProviderThreadId},
                ${DateTime.formatIso(event.payload.createdAt)},
                ${DateTime.formatIso(event.payload.updatedAt)},
                ${formatNullableIso(event.payload.archivedAt)},
                ${formatNullableIso(event.payload.deletedAt)},
                ${payloadJson}
              )
              ON CONFLICT(thread_id)
              DO UPDATE SET
                project_id = excluded.project_id,
                title = excluded.title,
                default_provider = excluded.default_provider,
                provider_instance_id = excluded.provider_instance_id,
                runtime_mode = excluded.runtime_mode,
                interaction_mode = excluded.interaction_mode,
                active_provider_thread_id = excluded.active_provider_thread_id,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                archived_at = excluded.archived_at,
                deleted_at = excluded.deleted_at,
                payload_json = excluded.payload_json
            `;
              // EventSink applies committed events serially; retries retain the original membership.
              if (event.type === "thread.created" && event.payload.forkedFrom?.type === "run") {
                const fork = event.payload.forkedFrom;
                yield* sql`
                  UPDATE orchestration_v2_projection_threads
                  SET fork_run_ids_json = (
                    SELECT json_group_array(run_id)
                    FROM orchestration_v2_projection_runs
                    WHERE thread_id = ${fork.threadId}
                      AND ordinal <= (
                        SELECT ordinal FROM orchestration_v2_projection_runs
                        WHERE thread_id = ${fork.threadId} AND run_id = ${fork.runId}
                      )
                      AND status <> 'rolled_back'
                  )
                  WHERE thread_id = ${event.threadId} AND fork_run_ids_json IS NULL
                `;
              }
              break;
            }
            case "run.created":
            case "run.updated": {
              const payloadJson = yield* encodeRunPayload(event.payload);
              yield* sql`
              INSERT INTO orchestration_v2_projection_runs (
                run_id,
                thread_id,
                ordinal,
                provider,
                provider_instance_id,
                provider_thread_id,
                status,
                requested_at,
                completed_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.ordinal},
                ${event.payload.providerInstanceId},
                ${event.payload.providerInstanceId},
                ${event.payload.providerThreadId},
                ${event.payload.status},
                ${DateTime.formatIso(event.payload.requestedAt)},
                ${formatNullableIso(event.payload.completedAt)},
                ${payloadJson}
              )
              ON CONFLICT(run_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                ordinal = excluded.ordinal,
                provider = excluded.provider,
                provider_instance_id = excluded.provider_instance_id,
                provider_thread_id = excluded.provider_thread_id,
                status = excluded.status,
                requested_at = excluded.requested_at,
                completed_at = excluded.completed_at,
                payload_json = ${keepRecordedRunOutput(
                  keepRecordedRunField(
                    keepRecordedRunField(sql`excluded.payload_json`, "$.delegatedCompletion"),
                    "$.restartCancelledBackgroundWork",
                  ),
                )}
            `;
              break;
            }
            case "run.background-work-cancelled": {
              // Only this field changes, so a concurrent lifecycle write is never regressed.
              const workJson = yield* encodeRestartCancelledBackgroundWork(
                event.payload.restartCancelledBackgroundWork,
              );
              yield* sql`
              UPDATE orchestration_v2_projection_runs
              SET payload_json = json_set(
                payload_json,
                '$.restartCancelledBackgroundWork',
                json(${workJson})
              )
              WHERE run_id = ${event.payload.runId} AND thread_id = ${event.threadId}
            `;
              break;
            }
            case "run.output-submitted": {
              // Only this field changes, so a concurrent lifecycle write is never regressed.
              const outputJson = yield* encodeRunOutput(event.payload.output);
              yield* sql`
              UPDATE orchestration_v2_projection_runs
              SET payload_json = json_set(payload_json, '$.output', json(${outputJson}))
              WHERE run_id = ${event.payload.runId} AND thread_id = ${event.threadId}
            `;
              break;
            }
            case "run-attempt.created":
            case "run-attempt.updated": {
              const payloadJson = yield* encodeRunAttemptPayload(event.payload);
              yield* sql`
              INSERT INTO orchestration_v2_projection_run_attempts (
                attempt_id,
                thread_id,
                run_id,
                attempt_ordinal,
                root_node_id,
                provider,
                provider_instance_id,
                provider_thread_id,
                provider_turn_id,
                status,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${event.payload.runId},
                ${event.payload.attemptOrdinal},
                ${event.payload.rootNodeId},
                ${event.payload.providerInstanceId},
                ${event.payload.providerInstanceId},
                ${event.payload.providerThreadId},
                ${event.payload.providerTurnId},
                ${event.payload.status},
                ${payloadJson}
              )
              ON CONFLICT(attempt_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                attempt_ordinal = excluded.attempt_ordinal,
                root_node_id = excluded.root_node_id,
                provider = excluded.provider,
                provider_instance_id = excluded.provider_instance_id,
                provider_thread_id = excluded.provider_thread_id,
                provider_turn_id = excluded.provider_turn_id,
                status = excluded.status,
                payload_json = excluded.payload_json
            `;
              break;
            }
            case "node.updated": {
              const payloadJson = yield* encodeNodePayload(event.payload);
              yield* sql`
              INSERT INTO orchestration_v2_projection_nodes (
                node_id,
                thread_id,
                run_id,
                parent_node_id,
                root_node_id,
                kind,
                status,
                provider_thread_id,
                provider_turn_id,
                started_at,
                completed_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.parentNodeId},
                ${event.payload.rootNodeId},
                ${event.payload.kind},
                ${event.payload.status},
                ${event.payload.providerThreadId},
                ${event.payload.providerTurnId},
                ${formatNullableIso(event.payload.startedAt)},
                ${formatNullableIso(event.payload.completedAt)},
                ${payloadJson}
              )
              ON CONFLICT(node_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                parent_node_id = excluded.parent_node_id,
                root_node_id = excluded.root_node_id,
                kind = excluded.kind,
                status = excluded.status,
                provider_thread_id = excluded.provider_thread_id,
                provider_turn_id = excluded.provider_turn_id,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                payload_json = excluded.payload_json
            `;
              batch?.nodeReads.set(event.payload.id, payloadJson);
              break;
            }
            case "subagent.updated": {
              const payloadJson = yield* encodeSubagentPayload(event.payload);
              yield* sql`
              INSERT INTO orchestration_v2_projection_subagents (
                subagent_id,
                thread_id,
                run_id,
                parent_node_id,
                provider,
                driver,
                provider_instance_id,
                provider_thread_id,
                child_thread_id,
                origin,
                status,
                started_at,
                completed_at,
                updated_at,
                completion_delivery_state,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.parentNodeId},
                ${event.payload.providerInstanceId},
                ${event.payload.driver},
                ${event.payload.providerInstanceId},
                ${event.payload.providerThreadId},
                ${event.payload.childThreadId},
                ${event.payload.origin},
                ${event.payload.status},
                ${formatNullableIso(event.payload.startedAt)},
                ${formatNullableIso(event.payload.completedAt)},
                ${DateTime.formatIso(event.payload.updatedAt)},
                ${event.payload.completionDelivery?.state ?? null},
                ${payloadJson}
              )
              ON CONFLICT(subagent_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                parent_node_id = excluded.parent_node_id,
                provider = excluded.provider,
                driver = excluded.driver,
                provider_instance_id = excluded.provider_instance_id,
                provider_thread_id = excluded.provider_thread_id,
                child_thread_id = excluded.child_thread_id,
                origin = excluded.origin,
                status = excluded.status,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                updated_at = excluded.updated_at,
                completion_delivery_state = COALESCE(
                  excluded.completion_delivery_state,
                  orchestration_v2_projection_subagents.completion_delivery_state
                ),
                payload_json = CASE
                  WHEN json_type(excluded.payload_json, '$.completionDelivery') IS NULL
                    AND json_type(orchestration_v2_projection_subagents.payload_json, '$.completionDelivery') IS NOT NULL
                  THEN json_set(
                    excluded.payload_json,
                    '$.completionDelivery',
                    json_extract(
                      orchestration_v2_projection_subagents.payload_json,
                      '$.completionDelivery'
                    )
                  )
                  ELSE excluded.payload_json
                END
            `;
              break;
            }
            case "provider-session.attached":
            case "provider-session.updated": {
              const payloadJson = yield* encodeProviderSessionPayload(event.payload);
              yield* sql`
              INSERT INTO orchestration_v2_projection_provider_sessions (
                provider_session_id,
                thread_id,
                provider,
                driver,
                provider_instance_id,
                status,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${event.payload.providerInstanceId},
                ${event.payload.driver},
                ${event.payload.providerInstanceId},
                ${event.payload.status},
                ${DateTime.formatIso(event.payload.updatedAt)},
                ${payloadJson}
              )
              ON CONFLICT(provider_session_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                provider = excluded.provider,
                driver = excluded.driver,
                provider_instance_id = excluded.provider_instance_id,
                status = excluded.status,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
              if (event.type === "provider-session.attached") {
                yield* sql`
                INSERT OR IGNORE INTO orchestration_v2_projection_provider_session_bindings (
                  provider_session_id,
                  thread_id
                )
                VALUES (${event.payload.id}, ${event.threadId})
              `;
              }
              break;
            }
            case "provider-session.detached": {
              yield* sql`
              DELETE FROM orchestration_v2_projection_provider_session_bindings
              WHERE provider_session_id = ${event.payload.providerSessionId}
                AND thread_id = ${event.threadId}
            `;
              break;
            }
            case "provider-thread.updated": {
              const existingRows = (event.payload.pendingBackgroundTasks ?? []).some(
                (task) => task.runId === undefined,
              )
                ? yield* sql<PayloadRow>`
                    SELECT payload_json
                    FROM orchestration_v2_projection_provider_threads
                    WHERE provider_thread_id = ${event.payload.id}
                    LIMIT 1
                  `
                : [];
              const existing = existingRows[0];
              const payloadJson = yield* encodeProviderThreadPayload(
                attributePendingBackgroundTasks(
                  event.payload,
                  existing === undefined
                    ? undefined
                    : yield* decodeProviderThreadPayload(existing.payload_json),
                  event.runId,
                ),
              );
              yield* sql`
              INSERT INTO orchestration_v2_projection_provider_threads (
                provider_thread_id,
                thread_id,
                owner_node_id,
                provider,
                driver,
                provider_instance_id,
                provider_session_id,
                status,
                first_run_ordinal,
                last_run_ordinal,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.appThreadId},
                ${event.payload.ownerNodeId},
                ${event.payload.providerInstanceId},
                ${event.payload.driver},
                ${event.payload.providerInstanceId},
                ${event.payload.providerSessionId},
                ${event.payload.status},
                ${event.payload.firstRunOrdinal},
                ${event.payload.lastRunOrdinal},
                ${DateTime.formatIso(event.payload.updatedAt)},
                ${payloadJson}
              )
              ON CONFLICT(provider_thread_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                owner_node_id = excluded.owner_node_id,
                provider = excluded.provider,
                driver = excluded.driver,
                provider_instance_id = excluded.provider_instance_id,
                provider_session_id = excluded.provider_session_id,
                status = excluded.status,
                first_run_ordinal = excluded.first_run_ordinal,
                last_run_ordinal = excluded.last_run_ordinal,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
              if (
                event.payload.appThreadId !== null &&
                !isQueuedProviderThreadPlaceholder(event.payload)
              ) {
                const threadRows = yield* sql<PayloadRow>`
                SELECT payload_json
                FROM orchestration_v2_projection_threads
                WHERE thread_id = ${event.payload.appThreadId}
                LIMIT 1
              `;
                const threadRow = threadRows[0];
                if (threadRow !== undefined) {
                  const thread = yield* decodeThreadPayload(threadRow.payload_json);
                  const updatedThread = {
                    ...thread,
                    activeProviderThreadId: event.payload.id,
                    updatedAt: event.payload.updatedAt,
                  };
                  const updatedThreadPayloadJson = yield* encodeThreadPayload(updatedThread);
                  yield* sql`
                  UPDATE orchestration_v2_projection_threads
                  SET
                    active_provider_thread_id = ${event.payload.id},
                    updated_at = ${DateTime.formatIso(updatedThread.updatedAt)},
                    payload_json = ${updatedThreadPayloadJson}
                  WHERE thread_id = ${event.payload.appThreadId}
                `;
                }
              }
              break;
            }
            case "provider-turn.updated": {
              const existingRows =
                event.payload.tokenUsage === undefined
                  ? yield* sql<PayloadRow>`
                    SELECT payload_json
                    FROM orchestration_v2_projection_provider_turns
                    WHERE provider_turn_id = ${event.payload.id}
                    LIMIT 1
                  `
                  : [];
              const existing = existingRows[0];
              const providerTurn =
                existing === undefined
                  ? event.payload
                  : upsertProviderTurn(
                      [yield* decodeProviderTurnPayload(existing.payload_json)],
                      event.payload,
                    )[0]!;
              const payloadJson = yield* encodeProviderTurnPayload(providerTurn);
              yield* sql`
              INSERT INTO orchestration_v2_projection_provider_turns (
                provider_turn_id,
                thread_id,
                provider_thread_id,
                node_id,
                run_attempt_id,
                ordinal,
                status,
                started_at,
                completed_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${providerTurn.providerThreadId},
                ${providerTurn.nodeId},
                ${providerTurn.runAttemptId},
                ${providerTurn.ordinal},
                ${providerTurn.status},
                ${formatNullableIso(providerTurn.startedAt)},
                ${formatNullableIso(providerTurn.completedAt)},
                ${payloadJson}
              )
              ON CONFLICT(provider_turn_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                provider_thread_id = excluded.provider_thread_id,
                node_id = excluded.node_id,
                run_attempt_id = excluded.run_attempt_id,
                ordinal = excluded.ordinal,
                status = excluded.status,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                payload_json = excluded.payload_json
            `;
              break;
            }
            case "runtime-request.updated": {
              const payloadJson = yield* encodeRuntimeRequestPayload(event.payload);
              yield* sql`
              INSERT INTO orchestration_v2_projection_runtime_requests (
                runtime_request_id,
                thread_id,
                node_id,
                provider_turn_id,
                kind,
                status,
                created_at,
                resolved_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${event.payload.nodeId},
                ${event.payload.providerTurnId},
                ${event.payload.kind},
                ${event.payload.status},
                ${DateTime.formatIso(event.payload.createdAt)},
                ${formatNullableIso(event.payload.resolvedAt)},
                ${payloadJson}
              )
              ON CONFLICT(runtime_request_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                node_id = excluded.node_id,
                provider_turn_id = excluded.provider_turn_id,
                kind = excluded.kind,
                status = excluded.status,
                created_at = excluded.created_at,
                resolved_at = excluded.resolved_at,
                payload_json = excluded.payload_json
            `;
              break;
            }
            case "message.updated": {
              const payloadJson = yield* encodeMessagePayload(event.payload);
              const createdAt = DateTime.formatIso(event.payload.createdAt);
              const updatedAt = DateTime.formatIso(event.payload.updatedAt);
              const searchText = event.payload.streaming
                ? null
                : readableSearchText(event.payload.text);
              yield* sql`
              INSERT INTO orchestration_v2_projection_messages (
                message_id,
                thread_id,
                run_id,
                node_id,
                role,
                streaming,
                created_at,
                updated_at,
                payload_json,
                search_text
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.role},
                ${booleanInt(event.payload.streaming)},
                ${createdAt},
                ${updatedAt},
                ${payloadJson},
                ${searchText}
              )
              ON CONFLICT(message_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                role = excluded.role,
                streaming = excluded.streaming,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json,
                search_text = CASE
                  WHEN excluded.streaming = 1 THEN orchestration_v2_projection_messages.search_text
                  ELSE excluded.search_text
                END
            `;
              break;
            }
            case "plan.updated": {
              const payloadJson = yield* encodePlanPayload(event.payload);
              yield* sql`
              INSERT INTO orchestration_v2_projection_plans (
                plan_id,
                thread_id,
                run_id,
                node_id,
                kind,
                status,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.kind},
                ${event.payload.status},
                ${payloadJson}
              )
              ON CONFLICT(plan_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                kind = excluded.kind,
                status = excluded.status,
                payload_json = excluded.payload_json
            `;
              break;
            }
            case "turn-item.updated": {
              const payloadJson = yield* encodeTurnItemPayload(event.payload);
              const updatedAt = DateTime.formatIso(event.payload.updatedAt);
              yield* sql`
              INSERT INTO orchestration_v2_projection_turn_items (
                turn_item_id,
                thread_id,
                run_id,
                node_id,
                provider_thread_id,
                provider_turn_id,
                parent_item_id,
                ordinal,
                type,
                status,
                updated_at,
                payload_json,
                inline_work_output
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.providerThreadId},
                ${event.payload.providerTurnId},
                ${event.payload.parentItemId},
                ${event.payload.ordinal},
                ${event.payload.type},
                ${event.payload.status},
                ${updatedAt},
                ${payloadJson},
                ${event.payload.type === "dynamic_tool" && isInlineWorkOutput(payloadJson) ? 1 : 0}
              )
              ON CONFLICT(turn_item_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                provider_thread_id = excluded.provider_thread_id,
                provider_turn_id = excluded.provider_turn_id,
                parent_item_id = excluded.parent_item_id,
                ordinal = excluded.ordinal,
                type = excluded.type,
                status = excluded.status,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json,
                inline_work_output = excluded.inline_work_output
            `;
              break;
            }
            case "checkpoint-scope.created": {
              const payloadJson = yield* encodeCheckpointScopePayload(event.payload);
              yield* sql`
              INSERT INTO orchestration_v2_projection_checkpoint_scopes (
                scope_id,
                thread_id,
                run_id,
                node_id,
                provider_thread_id,
                kind,
                ordinal_within_parent,
                advances_app_run_count,
                created_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.providerThreadId},
                ${event.payload.kind},
                ${event.payload.ordinalWithinParent},
                ${booleanInt(event.payload.advancesAppRunCount)},
                ${DateTime.formatIso(event.payload.createdAt)},
                ${payloadJson}
              )
              ON CONFLICT(scope_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                provider_thread_id = excluded.provider_thread_id,
                kind = excluded.kind,
                ordinal_within_parent = excluded.ordinal_within_parent,
                advances_app_run_count = excluded.advances_app_run_count,
                created_at = excluded.created_at,
                payload_json = excluded.payload_json
            `;
              break;
            }
            case "checkpoint.captured": {
              const payloadJson = yield* encodeCheckpointPayload(event.payload);
              yield* sql`
              INSERT INTO orchestration_v2_projection_checkpoints (
                checkpoint_id,
                thread_id,
                scope_id,
                run_id,
                node_id,
                ordinal_within_scope,
                app_run_ordinal,
                status,
                captured_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.scopeId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.ordinalWithinScope},
                ${event.payload.appRunOrdinal},
                ${event.payload.status},
                ${DateTime.formatIso(event.payload.capturedAt)},
                ${payloadJson}
              )
              ON CONFLICT(checkpoint_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                scope_id = excluded.scope_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                ordinal_within_scope = excluded.ordinal_within_scope,
                app_run_ordinal = excluded.app_run_ordinal,
                status = excluded.status,
                captured_at = excluded.captured_at,
                payload_json = excluded.payload_json
            `;
              break;
            }
            case "checkpoint.rollback-requested":
              break;
            case "context-handoff.updated": {
              const payloadJson = yield* encodeContextHandoffPayload(event.payload);
              yield* sql`
              INSERT INTO orchestration_v2_projection_context_handoffs (
                context_handoff_id,
                thread_id,
                target_run_id,
                to_provider_thread_id,
                strategy,
                status,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.targetRunId},
                ${event.payload.toProviderThreadId},
                ${event.payload.strategy},
                ${event.payload.status},
                ${DateTime.formatIso(event.payload.updatedAt)},
                ${payloadJson}
              )
              ON CONFLICT(context_handoff_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                target_run_id = excluded.target_run_id,
                to_provider_thread_id = excluded.to_provider_thread_id,
                strategy = excluded.strategy,
                status = excluded.status,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
              break;
            }
            case "context-transfer.created":
            case "context-transfer.updated": {
              const payloadJson = yield* encodeContextTransferPayload(event.payload);
              yield* sql`
              INSERT INTO orchestration_v2_projection_context_transfers (
                context_transfer_id,
                source_thread_id,
                target_thread_id,
                target_run_id,
                type,
                status,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.sourceThreadId},
                ${event.payload.targetThreadId},
                ${event.payload.targetRunId},
                ${event.payload.type},
                ${event.payload.status},
                ${DateTime.formatIso(event.payload.updatedAt)},
                ${payloadJson}
              )
              ON CONFLICT(context_transfer_id)
              DO UPDATE SET
                source_thread_id = excluded.source_thread_id,
                target_thread_id = excluded.target_thread_id,
                target_run_id = excluded.target_run_id,
                type = excluded.type,
                status = excluded.status,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
              break;
            }
          }

          if (
            event.type !== "thread.created" &&
            event.type !== "thread.archived" &&
            event.type !== "thread.unarchived" &&
            event.type !== "thread.deleted" &&
            event.type !== "thread.settled" &&
            event.type !== "thread.unsettled" &&
            event.type !== "thread.snoozed" &&
            event.type !== "thread.unsnoozed" &&
            event.type !== "thread.auto-settle-set" &&
            event.type !== "thread.pinned" &&
            event.type !== "thread.unpinned" &&
            event.type !== "thread.pin-reordered" &&
            event.type !== "thread.active-reordered" &&
            event.type !== "thread.tags-updated" &&
            event.type !== "thread.visited" &&
            event.type !== "thread.visit-recorded" &&
            event.type !== "thread.marked-unread" &&
            event.type !== "thread.metadata-updated" &&
            event.type !== "thread.pull-request-synced" &&
            event.type !== "thread.issue-synced" &&
            event.type !== "thread.pull-request-link-updated" &&
            event.type !== "thread.runtime-mode-updated" &&
            event.type !== "thread.interaction-mode-updated" &&
            event.type !== "thread.model-selection-updated" &&
            event.type !== "thread.provider-switched" &&
            event.type !== "thread.guest-share-updated"
          ) {
            const updatedAt = yield* encodeThreadUpdatedAt(event.occurredAt);
            if (batch !== undefined) batch.threadTouches.set(event.threadId, updatedAt);
            else yield* writeThreadTouches(sql, new Map([[event.threadId, updatedAt]]));
          }
        },
        (effect, event) =>
          effect.pipe(
            Effect.mapError(
              (cause) =>
                new ProjectionStoreApplyEventError({
                  eventType: event.type,
                  cause,
                }),
            ),
          ),
      );

    const isNodeStored: ProjectionStoreV2Shape["isNodeStored"] = Effect.fn(
      "ProjectionStore.isNodeStored",
    )(
      function* (node) {
        const payloadJson = yield* encodeNodePayload(node);
        const cache = (yield* ProviderBatchProjectionState)?.nodeReads;
        if (cache?.has(node.id)) return cache.get(node.id) === payloadJson;
        const rows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id = ${node.id}
        `;
        cache?.set(node.id, rows[0]?.payload_json);
        return rows[0]?.payload_json === payloadJson;
      },
      (effect, node) => effect.pipe(Effect.mapError(controlReadError(node.threadId))),
    );

    const shellReads = makeShellProjectionReadStore(sql, helpers);
    const windowReads = yield* makeThreadWindowReadStore(sql, helpers, timelineIndexes);
    const recoveryReads = makeRecoveryReadStore(sql, helpers, windowReads.getThreadRecords);

    const readOnReader =
      <Args extends ReadonlyArray<unknown>, A, E, R>(
        method: (...args: Args) => Effect.Effect<A, E, R>,
      ) =>
      (...args: Args): Effect.Effect<A, E, R> =>
        method(...args).pipe(NodeSqliteClient.readOnly);

    return {
      apply,
      getAgentAwarenessSnapshot: readOnReader(shellReads.getAgentAwarenessSnapshot),
      getShellSnapshot: readOnReader(shellReads.getShellSnapshot),
      getPullRequestSnapshot: readOnReader(shellReads.getPullRequestSnapshot),
      listActiveSubagentThreadIds: readOnReader(shellReads.listActiveSubagentThreadIds),
      listEphemeralThreadIds: readOnReader(shellReads.listEphemeralThreadIds),
      countThreads: readOnReader(shellReads.countThreads),
      listActiveShellIndex: readOnReader(shellReads.listActiveShellIndex),
      listActiveThreads: readOnReader(shellReads.listActiveThreads),
      readShellSnapshot: readOnReader(shellReads.readShellSnapshot),
      listOlderSettledThreads: readOnReader(shellReads.listOlderSettledThreads),
      getThreadShell: readOnReader(shellReads.getThreadShell),
      findGuestShareThreadId: readOnReader(shellReads.findGuestShareThreadId),
      getThread: readOnReader(getThread),
      findThread: readOnReader(findThread),
      getSettlementCandidates: readOnReader(shellReads.getSettlementCandidates),
      getThreadsWithPullRequests: readOnReader(shellReads.getThreadsWithPullRequests),
      getThreadTitles: readOnReader(shellReads.getThreadTitles),
      getThreadLinkMetadata: readOnReader(shellReads.getThreadLinkMetadata),
      getThreadWorktreePaths: readOnReader(shellReads.getThreadWorktreePaths),
      getOpenRemoteDelegatedTasks: shellReads.getOpenRemoteDelegatedTasks.pipe(
        NodeSqliteClient.readOnly,
      ),
      getThreadProjection: readOnReader(windowReads.getThreadProjection),
      getTurnStartContext: readOnReader(windowReads.getTurnStartContext),
      getTurnStartHistory: readOnReader(windowReads.getTurnStartHistory),
      getRuntimeRecoveryProjection: readOnReader(recoveryReads.getRuntimeRecoveryProjection),
      getRunningTurnContext: readOnReader(recoveryReads.getRunningTurnContext),
      getThreadProviderContext: readOnReader(recoveryReads.getThreadProviderContext),
      getRuntimeResponseContext: readOnReader(recoveryReads.getRuntimeResponseContext),
      getCheckpointContext: readOnReader(recoveryReads.getCheckpointContext),
      getCheckpointCaptureContext: readOnReader(recoveryReads.getCheckpointCaptureContext),
      getCheckpointRollbackContext: readOnReader(recoveryReads.getCheckpointRollbackContext),
      getRunMessage: readOnReader(recoveryReads.getRunMessage),
      getDelegatedChildControls: readOnReader(recoveryReads.getDelegatedChildControls),
      getRun: readOnReader(recoveryReads.getRun),
      canStartQueuedRun: readOnReader(recoveryReads.canStartQueuedRun),
      getHeldQueuedRuns: readOnReader(recoveryReads.getHeldQueuedRuns),
      getPendingNativeUserInputs: readOnReader(recoveryReads.getPendingNativeUserInputs),
      hasUnpairedRunInterruptRequest: readOnReader(recoveryReads.hasUnpairedRunInterruptRequest),
      hasRunInterruptRequest: readOnReader(recoveryReads.hasRunInterruptRequest),
      getRunProviderRecords: readOnReader(windowReads.getRunProviderRecords),
      getRunCardRecords: readOnReader(windowReads.getRunCardRecords),
      isNodeStored: readOnReader(isNodeStored),
      getMessageCount: readOnReader(windowReads.getMessageCount),
      getTranscriptByteFloor: readOnReader(windowReads.getTranscriptByteFloor),
      getSubagentCount: readOnReader(windowReads.getSubagentCount),
      getRunCount: readOnReader(windowReads.getRunCount),
      listAppOwnedChildThreadIds: readOnReader(windowReads.listAppOwnedChildThreadIds),
      hasPendingDelegatedCompletion: readOnReader(windowReads.hasPendingDelegatedCompletion),
      getNextTurnItemOrdinal: readOnReader(windowReads.getNextTurnItemOrdinal),
      getTurnItem: readOnReader(windowReads.getTurnItem),
      getMessagesById: readOnReader(windowReads.getMessagesById),
      getForkSourceRunIds: readOnReader(windowReads.getForkSourceRunIds),
      getThreadRecords: (threadId, fields, filter) =>
        windowReads.getThreadRecords(threadId, fields, filter).pipe(NodeSqliteClient.readOnly),
      getRuntimeRequest: readOnReader(recoveryReads.getRuntimeRequest),
      getPlan: readOnReader(recoveryReads.getPlan),
      getProviderControlContext: readOnReader(recoveryReads.getProviderControlContext),
      getLimitRecoveryCandidates: readOnReader(recoveryReads.getLimitRecoveryCandidates),
      getLimitRecoveryWakeAt: readOnReader(recoveryReads.getLimitRecoveryWakeAt),
      getRecoveryThreadIds: readOnReader(recoveryReads.getRecoveryThreadIds),
      getUnreadableThreadIds: readOnReader(recoveryReads.getUnreadableThreadIds),
      getThreadSnapshot: readOnReader(windowReads.getThreadSnapshot),
      getThreadSnapshotWindow: readOnReader(windowReads.getThreadSnapshotWindow),
      getTimelinePage: readOnReader(windowReads.getTimelinePage),
      getThreadHistoryPage: readOnReader(windowReads.getThreadHistoryPage),
      searchThread: readOnReader(windowReads.searchThread),
      searchThreadStream: windowReads.searchThreadStream,
      getThreadAttachmentIds: readOnReader(windowReads.getThreadAttachmentIds),
    } satisfies ProjectionStoreV2Shape;
  }),
);
