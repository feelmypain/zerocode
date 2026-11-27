import type {
  GuestShareId,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2TurnItem,
} from "@zerocode/contracts";
import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  pendingGuestMessageCount,
} from "@zerocode/contracts";
import {
  deriveBlockedOnThreadWait,
  derivePendingBackgroundWork,
} from "@zerocode/shared/orchestrationV2PendingBackgroundWork";
import { threadErrorSummary } from "@zerocode/shared/orchestrationV2ThreadError";
import { normalizeProjectPathForComparison } from "@zerocode/shared/path";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import { threadPullRequestsOf } from "../../sourceControl/threadPullRequests.ts";
import {
  type ActiveShellIndexEntry,
  type ActiveThreadListEntry,
  type AgentAwarenessThread,
  ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
  type OlderSettledThreadsListing,
  type OlderSettledThreadsQuery,
  type PayloadRow,
  type ProjectionSettlementCandidate,
  type ProjectionSqlHelpers,
  ProjectionStoreReadError,
  ProjectionStoreSetupError,
  type ProjectionStoreV2Error,
  type ProjectionThreadPullRequests,
  type SettlementThreadRow,
  type ShellItemCountRow,
  type ShellPendingTurnItemRow,
  type ShellRun,
  type ShellRunItemCountRow,
  type ShellRunRow,
  type ShellSnapshotOptions,
  type ShellThreadRow,
  type ShellThreadState,
  activeProviderGoalForShell,
  decodeForkRunIds,
  decodeProviderThreadPayload,
  decodePullRequestThread,
  decodeRuntimeRequestPayload,
  decodeThreadPayload,
  decodeTurnItemPayload,
  encodeIdList,
  linkCardStillAsks,
  pendingRuntimeRequestSummary,
  providerInstanceHistoryForShell,
  secretRequestAsPendingInput,
  shellForkSourceIds,
  shellFromState,
  shellIndexLineage,
  shellStatusFromStoredRunStatus,
  visibleItemCountForShell,
} from "./ProjectionRowDecoders.ts";

export function makeShellProjectionReadStore(
  sql: SqlClient.SqlClient,
  helpers: ProjectionSqlHelpers,
) {
  const {
    isIdleCompactionMessage,
    isSilentShellRun,
    presentedShellRunId,
    isBackgroundWakeShellRun,
  } = helpers;

  const selectShellThreadRows = (
    threadId?: ThreadId,
    {
      location,
      projectId,
      unsettledOnly = false,
      familyOf,
      worktreePath,
      threadIds,
      listedOnly = false,
      includeDeleted = false,
    }: ShellSnapshotOptions & {
      readonly listedOnly?: boolean;
      // A retained fork still shows the history of a deleted source run.
      readonly includeDeleted?: boolean;
    } = {},
  ) =>
    sql<ShellThreadRow>`
      SELECT
        t.thread_id,
        t.payload_json,
        t.fork_run_ids_json,
        CASE
          WHEN json_extract(t.payload_json, '$.forkedFrom.type') = 'run'
            AND json_extract(t.payload_json, '$.lineage.sideChat') IS NOT 1
            THEN json_extract(t.payload_json, '$.forkedFrom.threadId')
          ELSE NULL
        END AS forked_from_run_source_thread_id,
        json_extract(t.payload_json, '$.worktreePath') AS worktree_path,
        presented.run_id AS latest_run_id,
        presented.status AS latest_run_status,
        presented.requested_at AS latest_run_requested_at,
        json_extract(presented.payload_json, '$.startedAt') AS latest_run_started_at,
        presented.completed_at AS latest_run_completed_at,
        EXISTS (
          SELECT 1 FROM orchestration_v2_projection_turn_items stop_request
          WHERE stop_request.thread_id = t.thread_id AND stop_request.run_id = presented.run_id
            AND stop_request.type = 'run_interrupt_request'
        ) AS latest_run_stop_requested,
        ${isBackgroundWakeShellRun("presented")} AS latest_run_background_wake,
        active.run_id AS active_run_id,
        active.status AS active_run_status,
        (
          SELECT r.status
          -- Read active runs by status. Walking the ordinal index to skip this sort
          -- reads every run of a thread with none active.
          FROM orchestration_v2_projection_runs r
            INDEXED BY orchestration_v2_projection_runs_thread_status_idx
          WHERE r.thread_id = t.thread_id
            AND r.status IN ('preparing', 'starting', 'running', 'waiting')
            AND NOT ${isSilentShellRun("r")}
          ORDER BY r.ordinal DESC, r.run_id DESC
          LIMIT 1
        ) AS activity_run_status,
        (
          -- Mirrors orchestrationV2RunWorkStartedAt.
          SELECT COALESCE(
            json_extract(r.payload_json, '$.workStartedAt'),
            json_extract(r.payload_json, '$.startedAt'),
            r.requested_at
          )
          FROM orchestration_v2_projection_runs r
            INDEXED BY orchestration_v2_projection_runs_thread_status_idx
          WHERE r.thread_id = t.thread_id
            AND r.status IN ('preparing', 'starting', 'running', 'waiting')
            AND NOT ${isSilentShellRun("r")}
          ORDER BY r.ordinal DESC, r.run_id DESC
          LIMIT 1
        ) AS activity_run_started_at,
        (
          SELECT json_extract(session.payload_json, '$.lastError')
          -- Keep bindings outermost: one provider instance can hold every session.
          FROM orchestration_v2_projection_provider_session_bindings binding
          CROSS JOIN orchestration_v2_projection_provider_sessions session
            ON session.provider_session_id = binding.provider_session_id
          WHERE binding.thread_id = t.thread_id
            AND session.provider_instance_id = t.provider_instance_id
          ORDER BY session.updated_at DESC, session.provider_session_id DESC
          LIMIT 1
        ) AS last_error,
        (
          SELECT item.payload_json
          FROM orchestration_v2_projection_turn_items item
          WHERE presented.status = 'failed'
            AND item.thread_id = t.thread_id
            AND item.run_id = presented.run_id
            AND item.type = 'error' AND item.status = 'failed'
            AND item.node_id IS json_extract(presented.payload_json, '$.rootNodeId')
          ORDER BY item.updated_at DESC, item.ordinal DESC, item.turn_item_id DESC
          LIMIT 1
        ) AS terminal_failure_payload_json,
        blocked.run_id AS blocking_run_id,
        blocked.requested_at AS blocking_run_requested_at,
        json_extract(blocked.payload_json, '$.startedAt') AS blocking_run_started_at,
        blocked.completed_at AS blocking_run_completed_at,
        EXISTS (
          SELECT 1 FROM orchestration_v2_projection_turn_items stop_request
          WHERE stop_request.thread_id = t.thread_id AND stop_request.run_id = blocked.run_id
            AND stop_request.type = 'run_interrupt_request'
        ) AS blocking_run_stop_requested,
        ${isBackgroundWakeShellRun("blocked")} AS blocking_run_background_wake,
        (
          SELECT item.payload_json
          FROM orchestration_v2_projection_turn_items item
          WHERE item.thread_id = t.thread_id
            AND item.run_id = blocked.run_id
            AND item.type = 'error' AND item.status = 'failed'
            AND item.node_id IS json_extract(blocked.payload_json, '$.rootNodeId')
          ORDER BY item.updated_at DESC, item.ordinal DESC, item.turn_item_id DESC
          LIMIT 1
        ) AS blocking_failure_payload_json,
        (
          SELECT request.payload_json
          FROM orchestration_v2_projection_runtime_requests request
          WHERE request.thread_id = t.thread_id
            AND request.status = 'pending'
          ORDER BY (request.kind = 'user_input') ASC,
            request.created_at DESC, request.runtime_request_id DESC
          LIMIT 1
        ) AS pending_request_payload_json,
        (
          SELECT secret.payload_json
          -- Keep runs outermost so completed history is never scanned for a pending secret.
          FROM orchestration_v2_projection_runs r
            INDEXED BY orchestration_v2_projection_runs_thread_status_idx
          CROSS JOIN orchestration_v2_projection_turn_items secret
            INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
          WHERE r.thread_id = t.thread_id
            AND r.status IN ('preparing', 'starting', 'running', 'waiting')
            AND secret.thread_id = t.thread_id AND secret.run_id = r.run_id
            AND secret.type = 'secret_request' AND secret.status = 'waiting'
          ORDER BY secret.updated_at DESC, secret.turn_item_id DESC
          LIMIT 1
        ) AS pending_secret_request_payload_json,
        (
          SELECT link.payload_json
          FROM orchestration_v2_projection_turn_items link
            INDEXED BY orchestration_v2_projection_turn_items_waiting_link_idx
          WHERE link.thread_id = t.thread_id
            AND link.type = 'link_request' AND link.status = 'waiting'
          ORDER BY link.updated_at DESC, link.turn_item_id DESC
          LIMIT 1
        ) AS pending_link_request_payload_json,
        (
          SELECT message.updated_at
          FROM orchestration_v2_projection_messages message
          WHERE message.thread_id = t.thread_id
            AND message.role = 'user'
            AND NOT ${isIdleCompactionMessage("message")}
          ORDER BY message.updated_at DESC, message.message_id DESC
          LIMIT 1
        ) AS latest_user_message_at,
        (
          SELECT message.updated_at
          FROM orchestration_v2_projection_messages message
          WHERE message.thread_id = t.thread_id
            AND message.role = 'user'
            AND json_extract(message.payload_json, '$.createdBy') = 'user'
            AND NOT ${isIdleCompactionMessage("message")}
          ORDER BY message.updated_at DESC, message.message_id DESC
          LIMIT 1
        ) AS latest_user_authored_message_at,
        EXISTS (
          SELECT 1
          FROM orchestration_v2_projection_plans plan
          WHERE plan.thread_id = t.thread_id
            AND plan.kind = 'proposed_plan'
            AND plan.status = 'active'
        ) AS has_actionable_proposed_plan
      FROM orchestration_v2_projection_threads t
      LEFT JOIN orchestration_v2_projection_runs active ON active.run_id = (
        SELECT r.run_id
        FROM orchestration_v2_projection_runs r
          INDEXED BY orchestration_v2_projection_runs_thread_status_idx
        WHERE r.thread_id = t.thread_id
          AND r.status IN ('preparing', 'starting', 'running')
          AND NOT ${isSilentShellRun("r")}
        ORDER BY r.ordinal DESC, r.run_id DESC
        LIMIT 1
      )
      LEFT JOIN orchestration_v2_projection_runs presented
        ON presented.run_id = ${presentedShellRunId(sql.literal("t.thread_id"))}
      LEFT JOIN orchestration_v2_projection_runs blocked ON blocked.run_id = (
        SELECT candidate.run_id
        FROM orchestration_v2_projection_runs candidate
        WHERE candidate.thread_id = t.thread_id
          AND candidate.status <> 'queued'
          AND NOT (
            candidate.status = 'cancelled'
            AND json_extract(candidate.payload_json, '$.startedAt') IS NULL
          )
        -- latestExecutedRun: the run that ended last (runRanAfter).
        ORDER BY candidate.completed_at IS NULL DESC, candidate.completed_at DESC,
          candidate.ordinal DESC, candidate.run_id DESC
        LIMIT 1
      ) AND blocked.status = 'failed'
      WHERE ${includeDeleted ? sql`1 = 1` : sql`t.deleted_at IS NULL`}${
        listedOnly
          ? sql` AND json_extract(t.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'
              AND json_extract(t.payload_json, '$.lineage.sideChat') IS NOT 1`
          : sql``
      }${threadId === undefined ? sql`` : sql` AND t.thread_id = ${threadId}`}${
        projectId === undefined ? sql`` : sql` AND t.project_id = ${projectId}`
      }${
        location === "active"
          ? sql` AND t.archived_at IS NULL`
          : location === "archive"
            ? sql` AND t.archived_at IS NOT NULL`
            : sql``
      }${
        unsettledOnly
          ? sql` AND json_extract(t.payload_json, '$.settledAt') IS NULL AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'`
          : sql``
      }${
        familyOf === undefined
          ? sql``
          : sql` AND CASE WHEN json_valid(t.payload_json)
              THEN json_extract(t.payload_json, '$.lineage.rootThreadId') END = (
              SELECT json_extract(member.payload_json, '$.lineage.rootThreadId')
              FROM orchestration_v2_projection_threads member
              WHERE member.thread_id = ${familyOf}
            )`
      }${
        worktreePath === undefined
          ? sql``
          : // Matches orchestration_v2_projection_threads_worktree_path_key_idx, so this never
            // scans. SQLite lower() folds only ASCII: Windows paths differing only in the case
            // of another letter are not found. readShellSnapshotRows keeps the exact comparison.
            sql` AND CASE WHEN json_valid(t.payload_json)
              THEN lower(rtrim(replace(trim(json_extract(t.payload_json, '$.worktreePath')), '\\', '/'), '/'))
            END = lower(rtrim(replace(trim(${worktreePath}), '\\', '/'), '/'))`
      }${threadIds === undefined ? sql`` : sql` AND t.thread_id IN (SELECT value FROM json_each(${encodeIdList(threadIds)}))`}
      ORDER BY t.updated_at ASC, t.thread_id ASC
    `;

  const selectShellRunRows = (threadIds?: ReadonlyArray<ThreadId>) =>
    threadIds === undefined
      ? sql<ShellRunRow>`
          SELECT thread_id, run_id, ordinal,
            CASE WHEN status = 'rolled_back' THEN completed_at END AS rolled_back_at
          FROM orchestration_v2_projection_runs
        `
      : sql<ShellRunRow>`
          SELECT thread_id, run_id, ordinal,
            CASE WHEN status = 'rolled_back' THEN completed_at END AS rolled_back_at
          FROM orchestration_v2_projection_runs
          WHERE thread_id IN (SELECT value FROM json_each(${encodeIdList(threadIds)}))
        `;

  // Forks do not inherit undelivered queued input, including from cancelled runs
  // rolled back later. Checking the run first limits sparse-index seeks to those few runs.
  const selectShellRunItemCounts = (threadIds: ReadonlyArray<ThreadId>) =>
    sql<ShellRunItemCountRow>`
      SELECT per_run.thread_id, per_run.run_key AS run_id,
        per_run.item_count - CASE
          WHEN EXISTS (
            SELECT 1
            FROM orchestration_v2_projection_runs AS run
              INDEXED BY orchestration_v2_projection_runs_run_status_idx
            WHERE run.run_id = per_run.run_key
              AND (
                run.status IN ('queued', 'cancelled')
                OR (
                  run.status = 'rolled_back'
                  AND EXISTS (
                    SELECT 1
                    FROM orchestration_v2_projection_run_attempts AS attempt
                    WHERE attempt.run_id = run.run_id
                      AND attempt.status = 'cancelled'
                  )
                )
              )
          ) THEN (
            SELECT COUNT(*)
            FROM orchestration_v2_projection_turn_items AS held
              INDEXED BY orchestration_v2_projection_turn_items_queued_input_idx
            WHERE held.run_id = per_run.run_key
              AND held.type = 'user_message'
              AND json_valid(held.payload_json)
              AND json_extract(held.payload_json, '$.inputIntent') = 'queued_turn'
              -- A started run delivered its queued input; only held rows load the run's payload.
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_v2_projection_runs AS started
                WHERE started.run_id = held.run_id
                  AND started.status <> 'queued'
                  AND json_extract(started.payload_json, '$.startedAt') IS NOT NULL
              )
          )
          ELSE 0
        END AS item_count
      FROM orchestration_v2_projection_turn_item_counts AS per_run
      WHERE per_run.run_key <> '' AND per_run.thread_id IN (SELECT value FROM json_each(${encodeIdList(threadIds)}))
    `;

  const selectShellItemCounts = (threadIds: ReadonlyArray<ThreadId>) =>
    sql<ShellItemCountRow>`
      -- Only the thread's hidden runs are visited, so settled history costs nothing here.
      SELECT totals.thread_id,
        totals.item_count - COALESCE((
          SELECT SUM(CASE WHEN r.status = 'rolled_back' THEN counts.item_count ELSE (
            SELECT COUNT(*)
            FROM orchestration_v2_projection_turn_items held
            INDEXED BY orchestration_v2_projection_turn_items_queued_input_idx
            WHERE held.run_id = counts.run_key
              AND held.type = 'user_message'
              AND json_valid(held.payload_json)
              AND json_extract(held.payload_json, '$.inputIntent') = 'queued_turn'
              -- A started run delivered its queued input; only held rows load the run's payload.
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_v2_projection_runs AS started
                WHERE started.run_id = held.run_id
                  AND started.status <> 'queued'
                  AND json_extract(started.payload_json, '$.startedAt') IS NOT NULL
              )
          ) END)
          FROM orchestration_v2_projection_runs r
            INDEXED BY orchestration_v2_projection_runs_hidden_items_idx
          JOIN orchestration_v2_projection_turn_item_counts counts
            ON counts.thread_id = r.thread_id AND counts.run_key = r.run_id
          WHERE r.thread_id = totals.thread_id
            AND r.status IN ('rolled_back', 'queued', 'cancelled')
        ), 0) AS item_count,
        COALESCE((
          SELECT runless.item_count
          FROM orchestration_v2_projection_turn_item_counts runless
          WHERE runless.thread_id = totals.thread_id AND runless.run_key = ''
        ), 0) AS runless_item_count
      FROM orchestration_v2_projection_thread_item_counts totals
      WHERE totals.thread_id IN (SELECT value FROM json_each(${encodeIdList(threadIds)}))
    `;

  const selectShellProviderThreadRows = (threadIds?: ReadonlyArray<ThreadId>) =>
    threadIds === undefined
      ? sql<PayloadRow & { readonly thread_id: string }>`
          SELECT thread_id, payload_json
          FROM orchestration_v2_projection_provider_threads
          WHERE thread_id IS NOT NULL
        `
      : sql<PayloadRow & { readonly thread_id: string }>`
          SELECT thread_id, payload_json
          FROM orchestration_v2_projection_provider_threads
          WHERE thread_id IN (SELECT value FROM json_each(${encodeIdList(threadIds)}))
        `;

  const selectShellPendingTurnItemRows = (
    threadIds?: ReadonlyArray<ThreadId>,
    activeRunIds: ReadonlyArray<string> = [],
  ) => sql<ShellPendingTurnItemRow>`
    SELECT i.thread_id, i.payload_json, p.provider_instance_id AS owning_provider_instance_id
    FROM orchestration_v2_projection_turn_items i
      INDEXED BY orchestration_v2_projection_turn_items_shell_pending_idx
    LEFT JOIN orchestration_v2_projection_provider_threads p
      ON p.provider_thread_id = i.provider_thread_id
    LEFT JOIN orchestration_v2_projection_runs r
      ON r.run_id = i.run_id
    WHERE i.type IN ('command_execution', 'dynamic_tool', 'subagent')
      AND i.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
      AND (i.run_id IS NULL OR r.status <> 'rolled_back')
      ${threadIds === undefined ? sql`` : sql`AND i.thread_id IN (SELECT value FROM json_each(${encodeIdList(threadIds)}))`}
    ${
      activeRunIds.length === 0
        ? sql``
        : sql`
      -- Preserve the pending-item partial index; read other work only from running runs.
      UNION ALL
      SELECT i.thread_id, i.payload_json, NULL AS owning_provider_instance_id
      FROM orchestration_v2_projection_turn_items i
      WHERE i.run_id IN (SELECT value FROM json_each(${encodeIdList(activeRunIds)}))
        AND i.type IN ('file_change', 'file_search', 'web_search', 'compaction')
        AND i.status IN ('running', 'waiting')
    `
    }
  `;

  const runMapsByThreadId = (input: {
    readonly runRows: ReadonlyArray<ShellRunRow>;
    readonly itemCountRows: ReadonlyArray<ShellRunItemCountRow>;
  }) => {
    const runsByThreadId = new Map<ThreadId, Map<RunId, ShellRun>>();
    for (const row of input.runRows) {
      const threadId = ThreadId.make(row.thread_id);
      const runId = RunId.make(row.run_id);
      const existing = runsByThreadId.get(threadId) ?? new Map<RunId, ShellRun>();
      existing.set(runId, {
        ordinal: row.ordinal,
        rolledBackAt: row.rolled_back_at === null ? null : DateTime.makeUnsafe(row.rolled_back_at),
      });
      runsByThreadId.set(threadId, existing);
    }
    const itemCountsByThreadId = new Map<ThreadId, Map<RunId, number>>();
    for (const row of input.itemCountRows) {
      const threadId = ThreadId.make(row.thread_id);
      const runId = RunId.make(row.run_id);
      const existing = itemCountsByThreadId.get(threadId) ?? new Map<RunId, number>();
      existing.set(runId, row.item_count);
      itemCountsByThreadId.set(threadId, existing);
    }
    return { runsByThreadId, itemCountsByThreadId };
  };

  const shellItemCountMap = (rows: ReadonlyArray<ShellItemCountRow>) =>
    new Map(
      rows.map(
        (row) =>
          [
            ThreadId.make(row.thread_id),
            { itemCount: row.item_count, runlessItemCount: row.runless_item_count },
          ] as const,
      ),
    );

  const pendingBackgroundDataByThreadId = Effect.fn(
    "ProjectionStore.pendingBackgroundDataByThreadId",
  )(function* (input: {
    readonly providerThreadRows: ReadonlyArray<PayloadRow & { readonly thread_id: string }>;
    readonly pendingTurnItemRows: ReadonlyArray<ShellPendingTurnItemRow>;
  }) {
    const providerThreadsByThreadId = new Map<
      ThreadId,
      Array<OrchestrationV2ThreadProjection["providerThreads"][number]>
    >();
    for (const row of input.providerThreadRows) {
      const providerThread = yield* decodeProviderThreadPayload(row.payload_json);
      const threadId =
        row.thread_id.length > 0 ? ThreadId.make(row.thread_id) : providerThread.appThreadId;
      if (threadId === null) {
        continue;
      }
      const existing = providerThreadsByThreadId.get(threadId) ?? [];
      existing.push(providerThread);
      providerThreadsByThreadId.set(threadId, existing);
    }

    const pendingTurnItemsByThreadId = new Map<ThreadId, Array<OrchestrationV2TurnItem>>();
    for (const row of input.pendingTurnItemRows) {
      const turnItem = {
        ...(yield* decodeTurnItemPayload(row.payload_json)),
        ...(row.owning_provider_instance_id === null
          ? {}
          : {
              owningProviderInstanceId: ProviderInstanceId.make(row.owning_provider_instance_id),
            }),
      };
      const threadId = ThreadId.make(row.thread_id);
      const existing = pendingTurnItemsByThreadId.get(threadId) ?? [];
      existing.push(turnItem);
      pendingTurnItemsByThreadId.set(threadId, existing);
    }

    return { providerThreadsByThreadId, pendingTurnItemsByThreadId };
  });

  const getSettlementCandidates = (
    threadId?: ThreadId,
  ): Effect.Effect<ReadonlyArray<ProjectionSettlementCandidate>, ProjectionStoreV2Error> =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<SettlementThreadRow>`
          SELECT t.thread_id, t.payload_json,
            r.run_id AS latest_run_id,
            r.status AS latest_run_status,
            r.requested_at AS latest_run_requested_at,
            json_extract(r.payload_json, '$.startedAt') AS latest_run_started_at,
            r.completed_at AS latest_run_completed_at,
            (
              SELECT message.updated_at
              FROM orchestration_v2_projection_messages message
              WHERE message.thread_id = t.thread_id AND message.role = 'user'
                AND NOT ${isIdleCompactionMessage("message")}
              ORDER BY message.updated_at DESC, message.message_id DESC
              LIMIT 1
            ) AS latest_user_message_at,
            (
              SELECT message.updated_at
              FROM orchestration_v2_projection_messages message
              WHERE message.thread_id = t.thread_id AND message.role = 'user'
                AND NOT ${isIdleCompactionMessage("message")}
                AND (
                  json_extract(message.payload_json, '$.createdBy') = 'user'
                  OR (
                    json_extract(message.payload_json, '$.createdBy') = 'agent'
                    AND json_extract(message.payload_json, '$.creationSource') = 'mcp'
                  )
                )
              ORDER BY message.updated_at DESC, message.message_id DESC
              LIMIT 1
            ) AS latest_resuming_message_at
          FROM orchestration_v2_projection_threads t
          LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = (
            SELECT latest.run_id FROM orchestration_v2_projection_runs latest
            WHERE latest.thread_id = t.thread_id
              AND NOT ${isSilentShellRun("latest")}
            ORDER BY latest.ordinal DESC, latest.run_id DESC
            LIMIT 1
          )
          WHERE t.deleted_at IS NULL${threadId === undefined ? sql`` : sql` AND t.thread_id = ${threadId}`}
            AND json_extract(t.payload_json, '$.archivedAt') IS NULL
            AND json_extract(t.payload_json, '$.settledOverride') IS NULL
            AND json_extract(t.payload_json, '$.pinnedAt') IS NULL
            AND json_extract(t.payload_json, '$.autoSettleDisabledAt') IS NULL
            AND (
              json_extract(t.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'
              OR NOT EXISTS (
                SELECT 1 FROM orchestration_v2_projection_threads parent
                WHERE parent.thread_id = json_extract(t.payload_json, '$.lineage.parentThreadId')
                  AND parent.deleted_at IS NULL
                  AND json_extract(parent.payload_json, '$.archivedAt') IS NULL
                  AND json_extract(parent.payload_json, '$.settledOverride') IS NOT 'settled'
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runs active
              WHERE active.thread_id = t.thread_id
                AND active.status IN ('preparing', 'starting', 'running', 'waiting')
            )
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runtime_requests request
              WHERE request.thread_id = t.thread_id AND request.status = 'pending'
            )
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_turn_items link
                INDEXED BY orchestration_v2_projection_turn_items_waiting_link_idx
              WHERE link.thread_id = t.thread_id
                AND link.type = 'link_request' AND link.status = 'waiting'
                -- linkCardStillAsks: once the user writes after the card, it stops asking.
                AND NOT EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_messages message
                  WHERE message.thread_id = t.thread_id AND message.role = 'user'
                    AND json_extract(message.payload_json, '$.createdBy') = 'user'
                    AND NOT ${isIdleCompactionMessage("message")}
                    AND message.updated_at > COALESCE(
                      json_extract(link.payload_json, '$.startedAt'), link.updated_at
                    )
                )
            )
          ORDER BY t.updated_at ASC, t.thread_id ASC
        `;
          if (rows.length === 0) return [];
          const threadIds = rows.map((row) => ThreadId.make(row.thread_id));
          const { providerThreadsByThreadId, pendingTurnItemsByThreadId } =
            yield* pendingBackgroundDataByThreadId({
              providerThreadRows: yield* selectShellProviderThreadRows(threadIds),
              pendingTurnItemRows: yield* selectShellPendingTurnItemRows(threadIds),
            });
          return yield* Effect.forEach(rows, (row) =>
            Effect.gen(function* () {
              const thread = yield* decodeThreadPayload(row.payload_json);
              const status = shellStatusFromStoredRunStatus(row.latest_run_status);
              const latestRunId = row.latest_run_id === null ? null : RunId.make(row.latest_run_id);
              return {
                ...thread,
                pinnedAt: thread.pinnedAt ?? null,

                autoSettleDisabledAt: thread.autoSettleDisabledAt ?? null,
                snoozedUntil: thread.snoozedUntil ?? null,
                snoozedAt: thread.snoozedAt ?? null,
                status,
                latestRunId,
                latestRunRequestedAt:
                  row.latest_run_requested_at === null
                    ? null
                    : DateTime.makeUnsafe(row.latest_run_requested_at),
                latestRunStartedAt:
                  row.latest_run_started_at === null
                    ? null
                    : DateTime.makeUnsafe(row.latest_run_started_at),
                latestRunCompletedAt:
                  row.latest_run_completed_at === null
                    ? null
                    : DateTime.makeUnsafe(row.latest_run_completed_at),
                latestUserMessageAt:
                  row.latest_user_message_at === null
                    ? null
                    : DateTime.makeUnsafe(row.latest_user_message_at),
                latestResumingMessageAt:
                  row.latest_resuming_message_at === null
                    ? null
                    : DateTime.makeUnsafe(row.latest_resuming_message_at),
                activityRunStatus: null,
                activityRunStartedAt: null,
                pendingRuntimeRequest: null,
                pendingGuestMessageCount: pendingGuestMessageCount(thread.guestShare),
                pendingBackgroundTasks: derivePendingBackgroundWork({
                  latestRun:
                    latestRunId === null || status === "idle"
                      ? null
                      : { id: latestRunId, ordinal: 0, status },
                  providerThreads: providerThreadsByThreadId.get(thread.id) ?? [],
                  turnItems: pendingTurnItemsByThreadId.get(thread.id) ?? [],
                  activeProviderThreadId: thread.activeProviderThreadId,
                  hasActiveRun: false,
                  pullRequests: thread.pullRequests,
                }),
              } satisfies ProjectionSettlementCandidate;
            }),
          );
        }),
      )
      .pipe(Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })));

  const getOpenRemoteDelegatedTasks: Effect.Effect<
    ReadonlyArray<{ readonly parentThreadId: ThreadId; readonly taskId: NodeId }>,
    ProjectionStoreV2Error
  > = sql<{
    readonly thread_id: string;
    readonly subagent_id: string;
  }>`
    SELECT thread_id, subagent_id FROM orchestration_v2_projection_subagents
    WHERE origin = 'app_owned'
      AND child_thread_id IS NULL
      AND json_type(payload_json, '$.remoteChild') = 'object'
      AND (
        json_type(payload_json, '$.result') = 'null'
        OR (
          json_extract(payload_json, '$.status') IN ('cancelled', 'interrupted')
          AND json_type(payload_json, '$.remoteChild.stoppedThere') IS NOT 'true'
        )
        OR json_type(payload_json, '$.remoteChild.stoppedThere') = 'false'
      )
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        parentThreadId: ThreadId.make(row.thread_id),
        taskId: NodeId.make(row.subagent_id),
      })),
    ),
    Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
  );

  const getThreadsWithPullRequests = Effect.fn("ProjectionStore.getThreadsWithPullRequests")(
    function* (threadId?: ThreadId, options?: { readonly includeArchived?: boolean }) {
      const rows = yield* sql<PayloadRow>`
      SELECT payload_json
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL${threadId === undefined ? sql`` : sql` AND thread_id = ${threadId}`}
        ${options?.includeArchived === true ? sql`` : sql`AND json_extract(payload_json, '$.archivedAt') IS NULL`}
        AND json_array_length(payload_json, '$.pullRequests') > 0
      ORDER BY updated_at ASC, thread_id ASC
    `;
      return yield* Effect.forEach(rows, (row) =>
        decodeThreadPayload(row.payload_json).pipe(
          Effect.map((thread): ProjectionThreadPullRequests => ({
            id: thread.id,
            projectId: thread.projectId,
            lineage: thread.lineage,
            settledOverride: thread.settledOverride,
            settledAt: thread.settledAt,
            pullRequests: thread.pullRequests ?? [],
          })),
        ),
      );
    },
    Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
  );

  const getThreadWorktreePaths = (options?: { readonly includeArchived?: boolean }) =>
    sql<{ readonly thread_id: string; readonly worktree_path: string }>`
      SELECT thread_id, json_extract(payload_json, '$.worktreePath') AS worktree_path
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
        ${options?.includeArchived === true ? sql`` : sql`AND archived_at IS NULL`}
        AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
    `.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          threadId: ThreadId.make(row.thread_id),
          worktreePath: row.worktree_path,
        })),
      ),
      Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
    );

  const shellThreadStateFromRow =
    /* Runs once per shell row; the enclosing snapshot or thread read owns the span. */
    Effect.fnUntraced(function* (input: {
      readonly row: ShellThreadRow;
      readonly runsByThreadId: ReadonlyMap<ThreadId, Map<RunId, ShellRun>>;
      readonly itemCountsByThreadId: ReadonlyMap<ThreadId, Map<RunId, number>>;
      readonly shellItemCountsByThreadId: ReadonlyMap<
        ThreadId,
        { readonly itemCount: number; readonly runlessItemCount: number }
      >;
      readonly providerThreadsByThreadId: ReadonlyMap<
        ThreadId,
        ReadonlyArray<OrchestrationV2ThreadProjection["providerThreads"][number]>
      >;
      readonly pendingTurnItemsByThreadId: ReadonlyMap<
        ThreadId,
        ReadonlyArray<OrchestrationV2TurnItem>
      >;
    }) {
      const {
        row,
        runsByThreadId,
        itemCountsByThreadId,
        shellItemCountsByThreadId,
        providerThreadsByThreadId,
        pendingTurnItemsByThreadId,
      } = input;
      const thread = yield* decodeThreadPayload(row.payload_json);
      const latestUserAuthoredMessageAt =
        row.latest_user_authored_message_at === null
          ? null
          : DateTime.makeUnsafe(row.latest_user_authored_message_at);
      const waitingCards = [
        row.pending_secret_request_payload_json === null
          ? null
          : yield* decodeTurnItemPayload(row.pending_secret_request_payload_json),
        row.pending_link_request_payload_json === null
          ? null
          : yield* decodeTurnItemPayload(row.pending_link_request_payload_json),
      ]
        .filter((item) => item !== null)
        .filter(
          (item) =>
            item.type !== "link_request" || linkCardStillAsks(item, latestUserAuthoredMessageAt),
        );
      let pendingRuntimeRequest =
        row.pending_request_payload_json !== null
          ? pendingRuntimeRequestSummary(
              yield* decodeRuntimeRequestPayload(row.pending_request_payload_json),
            )
          : null;
      if (
        (pendingRuntimeRequest === null || pendingRuntimeRequest.kind === "user_input") &&
        waitingCards.length > 0
      ) {
        const waitingCard = secretRequestAsPendingInput(
          waitingCards.toSorted(
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
      let terminalFailureItem =
        row.terminal_failure_payload_json === null
          ? null
          : yield* decodeTurnItemPayload(row.terminal_failure_payload_json);
      let latestRunId = row.latest_run_id === null ? null : RunId.make(row.latest_run_id);
      let latestRunStatus = shellStatusFromStoredRunStatus(row.latest_run_status);
      let latestRunRequestedAt =
        row.latest_run_requested_at === null
          ? null
          : DateTime.makeUnsafe(row.latest_run_requested_at);
      let latestRunStartedAt =
        row.latest_run_started_at === null ? null : DateTime.makeUnsafe(row.latest_run_started_at);
      let latestRunCompletedAt =
        row.latest_run_completed_at === null
          ? null
          : DateTime.makeUnsafe(row.latest_run_completed_at);
      let latestRunStopRequested = row.latest_run_stop_requested === 1;
      let latestRunBackgroundWake = row.latest_run_background_wake === 1;
      if (row.blocking_run_id !== null && row.blocking_failure_payload_json !== null) {
        const blockingFailure = yield* decodeTurnItemPayload(
          row.blocking_failure_payload_json,
        ).pipe(Effect.orElseSucceed(() => null));
        const blocksQueue =
          threadErrorSummary(
            blockingFailure?.type === "error" ? blockingFailure.failure : null,
            row.last_error,
          ).lastErrorClass === "usage_limit";
        if (blocksQueue && blockingFailure !== null) {
          terminalFailureItem = blockingFailure;
          latestRunId = RunId.make(row.blocking_run_id);
          latestRunStopRequested = row.blocking_run_stop_requested === 1;
          latestRunBackgroundWake = row.blocking_run_background_wake === 1;
          latestRunStatus = "failed";
          latestRunRequestedAt =
            row.blocking_run_requested_at === null
              ? null
              : DateTime.makeUnsafe(row.blocking_run_requested_at);
          latestRunStartedAt =
            row.blocking_run_started_at === null
              ? null
              : DateTime.makeUnsafe(row.blocking_run_started_at);
          latestRunCompletedAt =
            row.blocking_run_completed_at === null
              ? null
              : DateTime.makeUnsafe(row.blocking_run_completed_at);
        }
      }
      const pendingBackgroundTasks = [
        ...derivePendingBackgroundWork({
          latestRun:
            latestRunId === null || latestRunStatus === "idle"
              ? null
              : {
                  id: latestRunId,
                  ordinal: 0,
                  status: latestRunStatus,
                },
          providerThreads: providerThreadsByThreadId.get(thread.id) ?? [],
          turnItems: pendingTurnItemsByThreadId.get(thread.id) ?? [],
          activeProviderThreadId: thread.activeProviderThreadId,
          hasActiveRun: row.active_run_id !== null,
          pullRequests: thread.pullRequests,
        }),
      ];
      return {
        thread,
        latestRunId,
        latestRunStatus,
        latestRunRequestedAt,
        latestRunStartedAt,
        latestRunCompletedAt,
        latestRunStopRequested,
        latestRunBackgroundWake,
        activeRunId: row.active_run_id === null ? null : RunId.make(row.active_run_id),
        blockedOnThreadWait: deriveBlockedOnThreadWait({
          activeRun:
            row.active_run_id === null || row.active_run_status !== "running"
              ? null
              : { id: RunId.make(row.active_run_id), status: "running" },
          turnItems: pendingTurnItemsByThreadId.get(thread.id) ?? [],
        }),
        activityRunStartedAt:
          row.activity_run_started_at === null
            ? null
            : DateTime.makeUnsafe(row.activity_run_started_at),
        activityRunStatus:
          row.activity_run_status === "preparing" ||
          row.activity_run_status === "starting" ||
          row.activity_run_status === "running" ||
          row.activity_run_status === "waiting"
            ? row.activity_run_status
            : null,
        ...threadErrorSummary(
          terminalFailureItem?.type === "error" ? terminalFailureItem.failure : null,
          row.last_error,
        ),
        pendingRuntimeRequest,
        latestUserMessageAt:
          row.latest_user_message_at === null
            ? null
            : DateTime.makeUnsafe(row.latest_user_message_at),
        latestUserAuthoredMessageAt,
        hasActionableProposedPlan: row.has_actionable_proposed_plan === 1,
        pendingBackgroundTasks,
        providerInstanceHistory: providerInstanceHistoryForShell({
          threadId: thread.id,
          providerThreads: providerThreadsByThreadId.get(thread.id) ?? [],
        }),
        goal: activeProviderGoalForShell(
          providerThreadsByThreadId.get(thread.id) ?? [],
          thread.activeProviderThreadId,
        ),
        itemCount: shellItemCountsByThreadId.get(thread.id)?.itemCount ?? 0,
        runlessItemCount: shellItemCountsByThreadId.get(thread.id)?.runlessItemCount ?? 0,
        updatedAt: thread.updatedAt,
        runsById: runsByThreadId.get(ThreadId.make(row.thread_id)) ?? new Map(),
        inheritedRunIds:
          row.fork_run_ids_json === null
            ? null
            : new Set(yield* decodeForkRunIds(row.fork_run_ids_json)),
        itemCountByRunId: itemCountsByThreadId.get(ThreadId.make(row.thread_id)) ?? new Map(),
      } satisfies ShellThreadState;
    });

  const shellSnapshotReadError = (cause: unknown) =>
    new ProjectionStoreReadError({ threadId: ThreadId.make("thread:shell"), cause });

  const readShellSnapshotRows = Effect.fn("ProjectionStore.readShellSnapshotRows")(function* (
    options: ShellSnapshotOptions | undefined,
  ) {
    const worktreeKey =
      options?.worktreePath === undefined
        ? undefined
        : normalizeProjectPathForComparison(options.worktreePath);
    const targetThreadRows = (yield* selectShellThreadRows(undefined, options)).filter(
      (row) =>
        worktreeKey === undefined ||
        (row.worktree_path !== null &&
          normalizeProjectPathForComparison(row.worktree_path) === worktreeKey),
    );
    const targetThreadIds = new Set(targetThreadRows.map((row) => ThreadId.make(row.thread_id)));
    const rowsByThreadId = new Map(
      targetThreadRows.map((row) => [ThreadId.make(row.thread_id), row] as const),
    );
    const pendingSourceIds = targetThreadRows.flatMap((row) =>
      row.forked_from_run_source_thread_id === null
        ? []
        : [ThreadId.make(row.forked_from_run_source_thread_id)],
    );
    while (pendingSourceIds.length > 0) {
      const sourceId = pendingSourceIds.pop();
      if (sourceId === undefined || rowsByThreadId.has(sourceId)) continue;
      const source = (yield* selectShellThreadRows(sourceId, { includeDeleted: true }))[0];
      if (source === undefined) continue;
      rowsByThreadId.set(sourceId, source);
      if (source.forked_from_run_source_thread_id !== null) {
        pendingSourceIds.push(ThreadId.make(source.forked_from_run_source_thread_id));
      }
    }
    const threadRows = [...rowsByThreadId.values()];
    const threadIds = [...rowsByThreadId.keys()];
    const forkSourceIds = shellForkSourceIds(threadRows);
    const readForThreadIds = <A, E>(
      read: (ids: ReadonlyArray<ThreadId>) => Effect.Effect<ReadonlyArray<A>, E>,
      ids: ReadonlyArray<ThreadId> = threadIds,
    ): Effect.Effect<ReadonlyArray<A>, E> =>
      ids.length === 0 ? Effect.succeed([] as ReadonlyArray<A>) : read(ids);
    const [
      runRows,
      itemCountRows,
      shellItemCountRows,
      sequenceRows,
      providerThreadRows,
      pendingTurnItemRows,
    ] = yield* Effect.all([
      readForThreadIds(selectShellRunRows, forkSourceIds),
      readForThreadIds(selectShellRunItemCounts, forkSourceIds),
      readForThreadIds(selectShellItemCounts),
      sql<{ readonly snapshot_sequence: number | null }>`
      SELECT MAX(sequence) AS snapshot_sequence
      FROM orchestration_events
      WHERE application_event_version = 2
        AND aggregate_kind = 'thread'
    `,
      readForThreadIds(selectShellProviderThreadRows),
      readForThreadIds((ids) =>
        selectShellPendingTurnItemRows(
          ids,
          threadRows.flatMap((row) =>
            row.active_run_id !== null && row.active_run_status === "running"
              ? [row.active_run_id]
              : [],
          ),
        ),
      ),
    ]);
    return {
      targetThreadIds,
      threadRows,
      runRows,
      itemCountRows,
      shellItemCountRows,
      sequenceRows,
      providerThreadRows,
      pendingTurnItemRows,
    };
  });

  const decodeShellSnapshot = Effect.fn("ProjectionStore.decodeShellSnapshot")(function* ({
    targetThreadIds,
    threadRows,
    runRows,
    itemCountRows,
    shellItemCountRows,
    sequenceRows,
    providerThreadRows,
    pendingTurnItemRows,
  }: Effect.Success<ReturnType<typeof readShellSnapshotRows>>) {
    const { runsByThreadId, itemCountsByThreadId } = runMapsByThreadId({
      runRows,
      itemCountRows,
    });
    const shellItemCountsByThreadId = shellItemCountMap(shellItemCountRows);
    const { providerThreadsByThreadId, pendingTurnItemsByThreadId } =
      yield* pendingBackgroundDataByThreadId({ providerThreadRows, pendingTurnItemRows });
    const states = yield* Effect.forEach(threadRows, (row) =>
      shellThreadStateFromRow({
        row,
        runsByThreadId,
        itemCountsByThreadId,
        shellItemCountsByThreadId,
        providerThreadsByThreadId,
        pendingTurnItemsByThreadId,
      }),
    );
    const statesByThreadId = new Map(states.map((state) => [state.thread.id, state]));

    const shells = states
      .filter((state) => targetThreadIds.has(state.thread.id))
      .map((state) =>
        shellFromState({
          state,
          visibleItemCount: visibleItemCountForShell({
            threadId: state.thread.id,
            statesByThreadId,
          }),
        }),
      );

    return {
      schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
      snapshotSequence: sequenceRows[0]?.snapshot_sequence ?? 0,
      threads: shells.filter((thread) => thread.archivedAt === null),
      archivedThreads: shells.filter((thread) => thread.archivedAt !== null),
    };
  }, Effect.mapError(shellSnapshotReadError));

  const readShellSnapshot = (
    options?: ShellSnapshotOptions,
  ): Effect.Effect<
    Effect.Effect<OrchestrationV2ThreadShellSnapshot, ProjectionStoreV2Error>,
    ProjectionStoreV2Error
  > =>
    readShellSnapshotRows(options).pipe(
      Effect.mapError(shellSnapshotReadError),
      Effect.map(decodeShellSnapshot),
    );

  const getPullRequestSnapshot = Effect.fn("ProjectionStore.getPullRequestSnapshot")(function* ({
    threadId,
    unsettledOnly = false,
  }: {
    readonly threadId?: ThreadId;
    readonly unsettledOnly?: boolean;
  }) {
    const { rows, sequenceRows } = yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<PayloadRow>`
        SELECT t.payload_json FROM orchestration_v2_projection_threads t
        WHERE t.deleted_at IS NULL${
          threadId === undefined
            ? sql` AND t.archived_at IS NULL`
            : sql` AND t.thread_id = ${threadId}`
        }${
          unsettledOnly
            ? sql` AND json_extract(t.payload_json, '$.settledAt') IS NULL
              AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'`
            : sql``
        }
        ORDER BY t.updated_at ASC, t.thread_id ASC
      `;
        const sequenceRows = yield* sql<{ readonly snapshot_sequence: number | null }>`
        SELECT MAX(sequence) AS snapshot_sequence FROM orchestration_events
        WHERE application_event_version = 2 AND aggregate_kind = 'thread'
      `;
        return { rows, sequenceRows };
      }),
    );
    // Decode after releasing the reader, keeping rows and sequence from the same transaction.
    const threads = yield* Effect.forEach(rows, (row) =>
      decodePullRequestThread(row.payload_json).pipe(
        Effect.map((thread) => ({ ...thread, pullRequests: threadPullRequestsOf(thread) })),
      ),
    );
    return { snapshotSequence: sequenceRows[0]?.snapshot_sequence ?? 0, threads };
  }, Effect.mapError(shellSnapshotReadError));

  const getAgentAwarenessSnapshot = Effect.fn("ProjectionStore.getAgentAwarenessSnapshot")(
    function* (threadId?: ThreadId) {
      const { threadRows, providerThreadRows, pendingTurnItemRows, sequenceRows } =
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const threadRows = yield* selectShellThreadRows(
              threadId,
              threadId === undefined ? { location: "active", listedOnly: true } : {},
            );
            const ids = threadRows.map((row) => ThreadId.make(row.thread_id));
            const providerThreadRows =
              ids.length === 0 ? [] : yield* selectShellProviderThreadRows(ids);
            const pendingTurnItemRows =
              ids.length === 0
                ? []
                : yield* selectShellPendingTurnItemRows(
                    ids,
                    threadRows.flatMap((row) =>
                      row.active_run_id !== null && row.active_run_status === "running"
                        ? [row.active_run_id]
                        : [],
                    ),
                  );
            const sequenceRows = yield* sql<{ readonly snapshot_sequence: number | null }>`
            SELECT MAX(sequence) AS snapshot_sequence FROM orchestration_events
            WHERE application_event_version = 2 AND aggregate_kind = 'thread'
          `;
            return { threadRows, providerThreadRows, pendingTurnItemRows, sequenceRows };
          }),
        );
      const { providerThreadsByThreadId, pendingTurnItemsByThreadId } =
        yield* pendingBackgroundDataByThreadId({ providerThreadRows, pendingTurnItemRows });
      const threads = yield* Effect.forEach(threadRows, (row) =>
        shellThreadStateFromRow({
          row,
          // Awareness never consumes timeline counts or inherited fork history.
          runsByThreadId: new Map(),
          itemCountsByThreadId: new Map(),
          shellItemCountsByThreadId: new Map(),
          providerThreadsByThreadId,
          pendingTurnItemsByThreadId,
        }).pipe(
          Effect.map((state): AgentAwarenessThread => ({
            id: state.thread.id,
            projectId: state.thread.projectId,
            creationSource: state.thread.creationSource,
            archivedAt: state.thread.archivedAt,
            snoozedUntil: state.thread.snoozedUntil ?? null,
            snoozedAt: state.thread.snoozedAt ?? null,
            pendingGuestMessageCount: pendingGuestMessageCount(state.thread.guestShare),
            activeRunId: state.activeRunId,
            latestRunId: state.latestRunId,
            hasActionableProposedPlan: state.hasActionableProposedPlan,
            title: state.thread.title,
            lineage: state.thread.lineage,
            modelSelection: state.thread.modelSelection,
            settledOverride: state.thread.settledOverride,
            updatedAt: state.updatedAt,
            status: state.latestRunStatus,
            activityRunStatus: state.activityRunStatus,
            latestRunCompletedAt: state.latestRunCompletedAt,
            latestRunStopRequested: state.latestRunStopRequested,
            latestRunBackgroundWake: state.latestRunBackgroundWake,
            pendingRuntimeRequest: state.pendingRuntimeRequest,
            pendingBackgroundTasks: state.pendingBackgroundTasks,
          })),
        ),
      );
      return { snapshotSequence: sequenceRows[0]?.snapshot_sequence ?? 0, threads };
    },
    Effect.mapError(shellSnapshotReadError),
  );

  const getShellSnapshot = (
    options?: ShellSnapshotOptions,
  ): Effect.Effect<OrchestrationV2ThreadShellSnapshot, ProjectionStoreV2Error> =>
    sql
      .withTransaction(readShellSnapshotRows(options))
      .pipe(Effect.mapError(shellSnapshotReadError), Effect.flatMap(decodeShellSnapshot));

  const listActiveSubagentThreadIds = Effect.fn("ProjectionStore.listActiveSubagentThreadIds")(
    function* () {
      const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
        AND archived_at IS NULL
        AND json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
    `;
      return rows.map((row) => ThreadId.make(row.thread_id));
    },
    Effect.mapError(shellSnapshotReadError),
  );

  const listEphemeralThreadIds = Effect.fn("ProjectionStore.listEphemeralThreadIds")(function* () {
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
        AND json_extract(payload_json, '$.ephemeral') = 1
    `;
    return rows.map((row) => ThreadId.make(row.thread_id));
  }, Effect.mapError(shellSnapshotReadError));

  const countThreads = Effect.fn("ProjectionStore.countThreads")(function* () {
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL
    `;
    return rows[0]?.count ?? 0;
  }, Effect.mapError(shellSnapshotReadError));

  // Migration 98 indexes these exact expressions, so the read takes them from the index instead
  // of parsing every active thread's payload. Changing one here needs a matching index change.
  const indexedField = (path: string, read: "json_extract" | "json_type" = "json_extract") =>
    sql.literal(`CASE WHEN json_valid(t.payload_json) THEN ${read}(t.payload_json, '${path}') END`);
  // The planner otherwise scans the whole (thread_id, type, status) index for this list.
  const PENDING_ITEMS_INDEX = sql.literal(
    "INDEXED BY orchestration_v2_projection_turn_items_shell_pending_idx",
  );
  const listActiveShellIndex = Effect.fn("ProjectionStore.listActiveShellIndex")(function* () {
    const rows = yield* sql<{
      readonly thread_id: string;
      readonly project_id: string;
      readonly relationship_to_parent: string | null;
      readonly parent_thread_id: string | null;
      readonly root_thread_id: string;
      readonly side_chat: number | null;
      readonly settled_override: string | null;
      readonly settled_at: string | null;
      readonly pinned_at: string | null;
      readonly pin_order_key: string | null;
      readonly snoozed_until: string | null;
      readonly may_be_live: number;
      readonly has_remote_tasks: number;
    }>`
      SELECT
        t.thread_id,
        t.project_id,
        ${indexedField("$.lineage.relationshipToParent")} AS relationship_to_parent,
        ${indexedField("$.lineage.parentThreadId")} AS parent_thread_id,
        ${indexedField("$.lineage.rootThreadId")} AS root_thread_id,
        ${indexedField("$.lineage.sideChat")} AS side_chat,
        ${indexedField("$.settledOverride")} AS settled_override,
        ${indexedField("$.settledAt")} AS settled_at,
        ${indexedField("$.pinnedAt")} AS pinned_at,
        ${indexedField("$.pinOrderKey")} AS pin_order_key,
        ${indexedField("$.snoozedUntil")} AS snoozed_until,
        -- A superset of isLiveSubagentShell: the sources of its run status, pending request,
        -- and pending background work. Each source is one list for the whole read, found
        -- through its partial index, so finished threads cost no lookups.
        (
          t.thread_id IN (
            SELECT r.thread_id FROM orchestration_v2_projection_runs r
            WHERE r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
          )
          OR t.thread_id IN (
            SELECT request.thread_id FROM orchestration_v2_projection_runtime_requests request
            WHERE request.status = 'pending'
          )
          -- Same predicates as the shell's pending item and link reads, for their partial indexes.
          OR t.thread_id IN (
            SELECT item.thread_id
            FROM orchestration_v2_projection_turn_items item ${PENDING_ITEMS_INDEX}
            WHERE item.type IN ('command_execution', 'dynamic_tool', 'subagent')
              AND item.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
          )
          OR t.thread_id IN (
            SELECT link_request.thread_id FROM orchestration_v2_projection_turn_items link_request
            WHERE link_request.type = 'link_request' AND link_request.status = 'waiting'
          )
          OR t.thread_id IN (
            SELECT provider_thread.thread_id
            FROM orchestration_v2_projection_provider_threads provider_thread
            WHERE CASE WHEN json_valid(provider_thread.payload_json)
              THEN json_array_length(provider_thread.payload_json, '$.pendingBackgroundTasks') > 0
              ELSE 0 END
          )
          -- Only a thread with a pull request link reads its payload. CASE, not AND: SQLite
          -- 3.50 evaluates both AND operands here.
          OR CASE WHEN ${indexedField("$.pullRequests[0]", "json_type")} IS NOT NULL
            THEN EXISTS (
              SELECT 1 FROM json_each(t.payload_json, '$.pullRequests') link
              WHERE json_type(link.value, '$.watch') IS NOT NULL
            )
            ELSE 0 END
        ) AS may_be_live,
        -- One list for the whole read, found through the child_thread_id index. A lookup per
        -- thread would parse the payload of every subagent row.
        t.thread_id IN (
          SELECT subagent.thread_id FROM orchestration_v2_projection_subagents subagent
          WHERE subagent.origin = 'app_owned'
            AND subagent.child_thread_id IS NULL
            AND json_type(subagent.payload_json, '$.remoteChild') = 'object'
        ) AS has_remote_tasks
      FROM orchestration_v2_projection_threads t
      WHERE t.deleted_at IS NULL
        AND t.archived_at IS NULL
      ORDER BY t.updated_at ASC, t.thread_id ASC
    `;
    return rows.map((row): ActiveShellIndexEntry => ({
      id: ThreadId.make(row.thread_id),
      projectId: ProjectId.make(row.project_id),
      lineage: shellIndexLineage(row),
      settledOverride:
        row.settled_override === "settled" || row.settled_override === "active"
          ? row.settled_override
          : null,
      settledAt: row.settled_at === null ? null : DateTime.makeUnsafe(row.settled_at),
      pinnedAt: row.pinned_at === null ? null : DateTime.makeUnsafe(row.pinned_at),
      pinOrderKey: row.pin_order_key,
      snoozedUntil: row.snoozed_until === null ? null : DateTime.makeUnsafe(row.snoozed_until),
      mayBeLive: row.may_be_live === 1,
      hasRemoteTasks: row.has_remote_tasks === 1,
    }));
  }, Effect.mapError(shellSnapshotReadError));

  const listActiveThreads = Effect.fn("ProjectionStore.listActiveThreads")(function* (
    projectId?: ProjectId,
  ) {
    const rows = yield* sql<{
      readonly thread_id: string;
      readonly project_id: string;
      readonly title: string;
      readonly updated_at: string;
      readonly relationship_to_parent: string | null;
      readonly parent_thread_id: string | null;
      readonly root_thread_id: string;
      readonly side_chat: number | null;
      readonly workflow_step: number | null;
      readonly delegated_from_environment_id: string | null;
      readonly delegated_from_thread_id: string | null;
      readonly delegated_from_title: string | null;
      readonly settled_override: string | null;
      readonly settled_at: string | null;
      readonly snoozed_until: string | null;
    }>`
      SELECT
        t.thread_id,
        t.project_id,
        t.title,
        t.updated_at,
        json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationship_to_parent,
        json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
        json_extract(t.payload_json, '$.lineage.rootThreadId') AS root_thread_id,
        json_extract(t.payload_json, '$.lineage.sideChat') AS side_chat,
        json_extract(t.payload_json, '$.lineage.workflowStep') AS workflow_step,
        json_extract(t.payload_json, '$.delegatedFrom.environmentId') AS delegated_from_environment_id,
        json_extract(t.payload_json, '$.delegatedFrom.threadId') AS delegated_from_thread_id,
        json_extract(t.payload_json, '$.delegatedFrom.title') AS delegated_from_title,
        json_extract(t.payload_json, '$.settledOverride') AS settled_override,
        json_extract(t.payload_json, '$.settledAt') AS settled_at,
        json_extract(t.payload_json, '$.snoozedUntil') AS snoozed_until
      FROM orchestration_v2_projection_threads t
      WHERE t.deleted_at IS NULL
        AND t.archived_at IS NULL${projectId === undefined ? sql`` : sql` AND t.project_id = ${projectId}`}
    `;
    return rows.map((row): ActiveThreadListEntry => ({
      id: ThreadId.make(row.thread_id),
      projectId: ProjectId.make(row.project_id),
      title: row.title,
      lineage: {
        ...shellIndexLineage(row),
        ...(row.workflow_step === 1 ? { workflowStep: true } : {}),
      },
      ...(row.delegated_from_environment_id === null || row.delegated_from_thread_id === null
        ? {}
        : {
            delegatedFrom: {
              environmentId: EnvironmentId.make(row.delegated_from_environment_id),
              threadId: ThreadId.make(row.delegated_from_thread_id),
              title: row.delegated_from_title ?? "",
            },
          }),
      settledOverride:
        row.settled_override === "settled" || row.settled_override === "active"
          ? row.settled_override
          : null,
      settledAt: row.settled_at === null ? null : DateTime.makeUnsafe(row.settled_at),
      snoozedUntil: row.snoozed_until === null ? null : DateTime.makeUnsafe(row.snoozed_until),
      updatedAt: DateTime.makeUnsafe(row.updated_at),
    }));
  }, Effect.mapError(shellSnapshotReadError));

  const getThreadLinkMetadata = Effect.fn("ProjectionStore.getThreadLinkMetadata")(function* (
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    if (threadIds.length === 0) return {};
    const rows = yield* sql<{
      readonly thread_id: ThreadId;
      readonly title: string;
      readonly project_id: ProjectId;
    }>`
      SELECT thread_id, title, project_id
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND thread_id IN ${sql.in(threadIds)}
    `;
    return Object.fromEntries(
      rows.map((row) => [row.thread_id, { title: row.title, projectId: row.project_id }]),
    );
  }, Effect.mapError(shellSnapshotReadError));

  const getThreadTitles = Effect.fn("ProjectionStore.getThreadTitles")(function* (
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    if (threadIds.length === 0) return {};
    const rows = yield* sql<{ readonly thread_id: ThreadId; readonly title: string }>`
      SELECT thread_id, title
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND thread_id IN ${sql.in(threadIds)}
    `;
    return Object.fromEntries(rows.map((row) => [row.thread_id, row.title]));
  }, Effect.mapError(shellSnapshotReadError));

  const findGuestShareThreadId = Effect.fn("ProjectionStore.findGuestShareThreadId")(function* (
    shareId: GuestShareId,
  ) {
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id
      FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.guestShare.id') = ${shareId}
      LIMIT 1
    `;
    return rows[0] === undefined ? null : ThreadId.make(rows[0].thread_id);
  }, Effect.mapError(shellSnapshotReadError));

  const listOlderSettledThreads = Effect.fn("ProjectionStore.listOlderSettledThreads")(function* ({
    before,
    projectIds,
    limit,
  }: OlderSettledThreadsQuery): Effect.fn.Return<OlderSettledThreadsListing, unknown> {
    // ISO strings in one format, so string order is time order.
    // Match migration 98's expressions so SQLite serves this query from the active shell index.
    const older = sql`
      SELECT t.thread_id, t.project_id,
        ${indexedField("$.settledAt")} AS settled_at
      FROM orchestration_v2_projection_threads t
      WHERE t.deleted_at IS NULL
        AND t.archived_at IS NULL
        AND ${indexedField("$.lineage.relationshipToParent")} IS NOT 'subagent'
        AND ${indexedField("$.lineage.sideChat")} IS NOT 1
        AND ${indexedField("$.settledOverride")} = 'settled'
        AND ${indexedField("$.settledAt")} IS NOT NULL${
          projectIds === undefined ? sql`` : sql` AND t.project_id IN ${sql.in(projectIds)}`
        }
    `;
    const belowCursor =
      before.threadId === undefined
        ? sql`older.settled_at < ${before.settledAt}`
        : sql`(older.settled_at < ${before.settledAt}
            OR (older.settled_at = ${before.settledAt} AND older.thread_id > ${before.threadId}))`;
    const pageRows =
      limit === 0
        ? []
        : yield* sql<{ readonly thread_id: string }>`
            WITH older AS (${older})
            SELECT older.thread_id FROM older
            WHERE ${belowCursor}
            ORDER BY older.settled_at DESC, older.thread_id ASC
            LIMIT ${limit}
          `;
    const countRows =
      limit !== 0
        ? []
        : yield* sql<{ readonly project_id: string; readonly count: number }>`
            WITH older AS (${older})
            SELECT older.project_id, COUNT(*) AS count FROM older
            WHERE ${belowCursor}
            GROUP BY older.project_id
          `;
    return {
      threadIds: pageRows.map((row) => ThreadId.make(row.thread_id)),
      counts: countRows.map((row) => ({
        projectId: ProjectId.make(row.project_id),
        count: row.count,
      })),
    };
  }, Effect.mapError(shellSnapshotReadError));

  const getThreadShell = (
    threadId: ThreadId,
  ): Effect.Effect<OrchestrationV2ThreadShell | null, ProjectionStoreV2Error> =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rowsByThreadId = new Map<ThreadId, ShellThreadRow>();
          const pending: Array<ThreadId> = [threadId];
          while (pending.length > 0) {
            const nextId = pending.pop();
            if (nextId === undefined || rowsByThreadId.has(nextId)) {
              continue;
            }
            const rows = yield* selectShellThreadRows(nextId, {
              includeDeleted: nextId !== threadId,
            });
            const row = rows[0];
            if (row === undefined) {
              continue;
            }
            rowsByThreadId.set(nextId, row);
            if (row.forked_from_run_source_thread_id !== null) {
              pending.push(ThreadId.make(row.forked_from_run_source_thread_id));
            }
          }
          if (!rowsByThreadId.has(threadId)) {
            return null;
          }

          const threadIds = [...rowsByThreadId.keys()];
          const forkSourceIds = shellForkSourceIds([...rowsByThreadId.values()]);
          const [
            runRows,
            itemCountRows,
            shellItemCountRows,
            providerThreadRows,
            pendingTurnItemRows,
          ] = yield* Effect.all([
            forkSourceIds.length === 0
              ? Effect.succeed([] as ReadonlyArray<ShellRunRow>)
              : selectShellRunRows(forkSourceIds),
            forkSourceIds.length === 0
              ? Effect.succeed([] as ReadonlyArray<ShellRunItemCountRow>)
              : selectShellRunItemCounts(forkSourceIds),
            selectShellItemCounts(threadIds),
            selectShellProviderThreadRows(threadIds),
            selectShellPendingTurnItemRows(
              threadIds,
              [...rowsByThreadId.values()].flatMap((row) =>
                row.active_run_id !== null && row.active_run_status === "running"
                  ? [row.active_run_id]
                  : [],
              ),
            ),
          ]);
          return {
            rowsByThreadId,
            runRows,
            itemCountRows,
            shellItemCountRows,
            providerThreadRows,
            pendingTurnItemRows,
          };
        }),
      )
      .pipe(
        Effect.flatMap((snapshot) =>
          snapshot === null
            ? Effect.succeed(null)
            : Effect.gen(function* () {
                const { runsByThreadId, itemCountsByThreadId } = runMapsByThreadId({
                  runRows: snapshot.runRows,
                  itemCountRows: snapshot.itemCountRows,
                });
                const shellItemCountsByThreadId = shellItemCountMap(snapshot.shellItemCountRows);
                const { providerThreadsByThreadId, pendingTurnItemsByThreadId } =
                  yield* pendingBackgroundDataByThreadId({
                    providerThreadRows: snapshot.providerThreadRows,
                    pendingTurnItemRows: snapshot.pendingTurnItemRows,
                  });

                const states = yield* Effect.forEach([...snapshot.rowsByThreadId.values()], (row) =>
                  shellThreadStateFromRow({
                    row,
                    runsByThreadId,
                    itemCountsByThreadId,
                    shellItemCountsByThreadId,
                    providerThreadsByThreadId,
                    pendingTurnItemsByThreadId,
                  }),
                );
                const statesByThreadId = new Map(states.map((state) => [state.thread.id, state]));
                const state = statesByThreadId.get(threadId);
                if (state === undefined) {
                  return null;
                }
                return shellFromState({
                  state,
                  visibleItemCount: visibleItemCountForShell({ threadId, statesByThreadId }),
                });
              }),
        ),
        Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })),
      );

  return {
    getAgentAwarenessSnapshot,
    getShellSnapshot,
    getPullRequestSnapshot,
    listActiveSubagentThreadIds,
    listEphemeralThreadIds,
    countThreads,
    listActiveShellIndex,
    listActiveThreads,
    readShellSnapshot,
    listOlderSettledThreads,
    getThreadShell,
    findGuestShareThreadId,
    getSettlementCandidates,
    getThreadsWithPullRequests,
    getThreadTitles,
    getThreadLinkMetadata,
    getThreadWorktreePaths,
    getOpenRemoteDelegatedTasks,
  };
}
