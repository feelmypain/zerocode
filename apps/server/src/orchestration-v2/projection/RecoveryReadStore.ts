import type {
  CheckpointId,
  CheckpointScopeId,
  NodeId,
  OrchestrationV2Run,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RuntimeRequestId,
  TurnItemId,
} from "@zerocode/contracts";
import { RunId, ThreadId } from "@zerocode/contracts";
import { threadErrorSummary } from "@zerocode/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import {
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
  type ProjectionSqlHelpers,
  ProjectionStoreReadError,
  ProjectionStoreSetupError,
  ProjectionStoreThreadNotFoundError,
  type ProjectionStoreV2Error,
  type ProjectionThreadProviderContext,
  booleanInt,
  controlReadError,
  decodeCheckpointContext,
  decodeCheckpointPayload,
  decodeCheckpointScopePayload,
  decodeContextHandoffPayload,
  decodeContextTransferPayload,
  decodeMessagePayload,
  decodeNodePayload,
  decodePlanJson,
  decodeProviderSessionPayload,
  decodeProviderThreadPayload,
  decodeProviderTurnPayload,
  decodeRollbackTargetAttempts,
  decodeRows,
  decodeRunAttemptPayload,
  decodeRunPayload,
  decodeRuntimeRequestPayload,
  decodeSubagentPayload,
  decodeThreadPayload,
  decodeTurnItemPayload,
  encodeIdList,
  isProjectionStoreThreadNotFoundError,
} from "./ProjectionRowDecoders.ts";

export function makeRecoveryReadStore(
  sql: SqlClient.SqlClient,
  helpers: ProjectionSqlHelpers,
  getThreadRecords: <K extends ProjectionRecordField>(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, ProjectionStoreV2Error>,
) {
  const { LIVE_NODES_INDEX, nodesOwningProviderThreads, getThread, requireThread } = helpers;

  const getLimitRecoveryCandidates = Effect.fn("ProjectionStore.getLimitRecoveryCandidates")(
    function* (options: {
      readonly now: DateTime.Utc;
      readonly autoResume: boolean;
      readonly snooze: boolean;
    }) {
      const rows = yield* sql<{
        readonly payload_json: string;
        readonly run_id: string;
        readonly completed_at: string | null;
        readonly failure_payload_json: string;
        readonly last_error: string | null;
      }>`
        SELECT t.payload_json, r.run_id, r.completed_at,
          item.payload_json AS failure_payload_json,
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
          ) AS last_error
        FROM orchestration_v2_projection_threads t
        INNER JOIN orchestration_v2_projection_runs r ON r.run_id = (
          SELECT latest.run_id FROM orchestration_v2_projection_runs latest
          WHERE latest.thread_id = t.thread_id
            AND latest.status <> 'queued'
            AND NOT (
              latest.status = 'cancelled'
              AND json_extract(latest.payload_json, '$.startedAt') IS NULL
            )
          -- latestExecutedRun: the run that ended last (runRanAfter).
          ORDER BY latest.completed_at IS NULL DESC, latest.completed_at DESC,
            latest.ordinal DESC, latest.run_id DESC
          LIMIT 1
        ) AND r.status = 'failed'
        INNER JOIN orchestration_v2_projection_turn_items item ON item.turn_item_id = (
          SELECT error.turn_item_id FROM orchestration_v2_projection_turn_items error
          WHERE error.thread_id = t.thread_id AND error.run_id = r.run_id
            AND error.type = 'error' AND error.status = 'failed'
            AND error.node_id IS json_extract(r.payload_json, '$.rootNodeId')
          ORDER BY error.updated_at DESC, error.ordinal DESC, error.turn_item_id DESC
          LIMIT 1
        )
        WHERE t.deleted_at IS NULL
          -- The sweep runs every scheduler tick. Without this list the latest-run
          -- lookup above sorts every run of every thread, tens of milliseconds
          -- for one long thread; only threads with a usage-limit failure qualify.
          AND t.thread_id IN (
            SELECT failure.thread_id FROM orchestration_v2_projection_turn_items failure
            -- Spelled as in 099_BackgroundRecoveryIndexes so the partial index serves it.
            WHERE failure.type = 'error' AND failure.status = 'failed'
              AND CASE WHEN json_valid(failure.payload_json) THEN
                json_extract(failure.payload_json, '$.failure.class') = 'usage_limit'
                ELSE 0 END
          )
          AND t.archived_at IS NULL
          AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'
          AND json_valid(item.payload_json)
          AND json_extract(item.payload_json, '$.failure.class') = 'usage_limit'
          AND json_extract(item.payload_json, '$.failure.resetAt') IS NOT NULL
          AND julianday(json_extract(item.payload_json, '$.failure.resetAt')) > julianday(COALESCE(r.completed_at, json_extract(t.payload_json, '$.updatedAt')))
          AND (
            (
              json_extract(t.payload_json, '$.limitRecovery.runId') IS r.run_id
              AND json_extract(t.payload_json, '$.limitRecovery.resetAt') IS json_extract(item.payload_json, '$.failure.resetAt')
              AND json_extract(t.payload_json, '$.limitRecovery.autoResume') = 1
              AND julianday(json_extract(item.payload_json, '$.failure.resetAt')) <= julianday(${DateTime.formatIso(options.now)})
              AND (
                json_extract(t.payload_json, '$.snoozedUntil') IS NULL
                OR julianday(json_extract(t.payload_json, '$.snoozedUntil')) <= julianday(${DateTime.formatIso(options.now)})
              )
            )
            OR (
              (
                json_extract(t.payload_json, '$.limitRecovery.runId') IS NOT r.run_id
                OR json_extract(t.payload_json, '$.limitRecovery.resetAt') IS NOT json_extract(item.payload_json, '$.failure.resetAt')
              )
              AND (
                ${booleanInt(options.autoResume)}
                OR (${booleanInt(options.snooze)} AND julianday(json_extract(item.payload_json, '$.failure.resetAt')) > julianday(${DateTime.formatIso(options.now)}))
              )
              -- A subagent of a settled, archived or deleted parent is abandoned work.
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_v2_projection_threads parent
                WHERE json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
                  AND parent.thread_id = json_extract(t.payload_json, '$.lineage.parentThreadId')
                  AND (
                    json_extract(parent.payload_json, '$.settledOverride') = 'settled'
                    OR json_extract(parent.payload_json, '$.archivedAt') IS NOT NULL
                    OR parent.deleted_at IS NOT NULL
                  )
              )
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runtime_requests request
            WHERE request.thread_id = t.thread_id AND request.status = 'pending'
          )
        ORDER BY t.thread_id
      `;
      const candidates: Array<ProjectionLimitRecoveryCandidate> = [];
      for (const row of rows) {
        const thread = yield* decodeThreadPayload(row.payload_json);
        const item = yield* decodeTurnItemPayload(row.failure_payload_json);
        const summary = threadErrorSummary(
          item.type === "error" ? item.failure : null,
          row.last_error,
        );
        if (summary.lastErrorClass !== "usage_limit") continue;
        candidates.push({
          id: thread.id,
          status: "failed",
          lastErrorClass: summary.lastErrorClass,
          usageLimitResetAt: summary.usageLimitResetAt,
          latestRunId: RunId.make(row.run_id),
          latestRunCompletedAt:
            row.completed_at === null ? null : DateTime.makeUnsafe(row.completed_at),
          updatedAt: thread.updatedAt,
          archivedAt: thread.archivedAt,
          settledOverride: thread.settledOverride,
          pendingRuntimeRequest: null,
          limitRecovery: thread.limitRecovery ?? null,
          snoozedUntil: thread.snoozedUntil ?? null,
        });
      }
      return candidates;
    },
    Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
  );

  const getLimitRecoveryWakeAt = Effect.fn("ProjectionStore.getLimitRecoveryWakeAt")(
    function* (now: DateTime.Utc) {
      const nowIso = DateTime.formatIso(now);
      const rows = yield* sql<{
        readonly reset_ms: number | null;
        readonly snooze_ms: number | null;
      }>`
        SELECT
          MIN(CASE WHEN julianday(reset_at) > julianday(${nowIso})
            THEN (julianday(reset_at) - 2440587.5) * 86400000 END) AS reset_ms,
          MIN(CASE WHEN julianday(snoozed_until) > julianday(${nowIso})
            THEN (julianday(snoozed_until) - 2440587.5) * 86400000 END) AS snooze_ms
        FROM (
          SELECT json_extract(payload_json, '$.limitRecovery.resetAt') AS reset_at,
            json_extract(payload_json, '$.snoozedUntil') AS snoozed_until
          FROM orchestration_v2_projection_threads
          WHERE deleted_at IS NULL
            AND json_extract(payload_json, '$.limitRecovery.autoResume') = 1
        )
      `;
      const wakes = [rows[0]?.reset_ms, rows[0]?.snooze_ms].filter(
        (value): value is number => value != null,
      );
      return wakes.length === 0 ? null : Math.round(Math.min(...wakes));
    },
    Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
  );

  const getRecoveryThreadIds = Effect.fn("ProjectionStore.getRecoveryThreadIds")(
    function* (
      kind: ProjectionRecoveryKind,
      projects?: {
        readonly include?: ReadonlyArray<string>;
        readonly exclude?: ReadonlyArray<string>;
      },
    ) {
      const candidates = (() => {
        switch (kind) {
          case "queued-runs":
            return sql`
              SELECT thread_id FROM orchestration_v2_projection_runs
              WHERE status = 'queued'
                AND NOT EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_runs AS active
                  WHERE active.thread_id = orchestration_v2_projection_runs.thread_id
                    AND active.status IN ('preparing', 'starting', 'running', 'waiting')
                )
            `;
          case "unread-steers":
            return sql`
              SELECT item.thread_id FROM orchestration_v2_projection_turn_items AS item
              JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
              WHERE item.type = 'user_message' AND item.status = 'pending'
                AND run.status IN ('completed', 'interrupted', 'failed', 'cancelled')
                AND CASE WHEN json_valid(item.payload_json)
                  THEN json_extract(item.payload_json, '$.inputIntent') IN ('steer', 'promoted_queued_to_steer')
                  ELSE 0 END
            `;
          case "delegated-completions":
            return sql`
              SELECT thread_id FROM orchestration_v2_projection_runs
              WHERE CASE WHEN json_valid(payload_json)
                THEN json_type(payload_json, '$.delegatedCompletion.delivery') = 'object'
                ELSE 0 END
            `;
          case "subagent-results":
            return sql`
              SELECT child.thread_id FROM orchestration_v2_projection_threads AS child
              WHERE CASE WHEN json_valid(child.payload_json) THEN
                json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
                AND json_extract(child.payload_json, '$.lineage.parentThreadId') IS NOT NULL
                AND json_extract(child.payload_json, '$.forkedFrom.type') = 'node'
                ELSE 0 END
                AND (EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_runs AS requested
                  JOIN orchestration_v2_projection_subagents AS task
                    ON task.subagent_id = json_extract(requested.payload_json, '$.delegatedTaskId')
                  WHERE requested.thread_id = child.thread_id
                    AND requested.status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
                    AND task.child_thread_id = child.thread_id
                    AND json_extract(task.payload_json, '$.origin') = 'app_owned'
                    AND json_extract(task.payload_json, '$.result') IS NULL
                ) OR (
                  -- The original task still waits for the latest unheld work.
                  (SELECT status FROM orchestration_v2_projection_runs
                   WHERE thread_id = child.thread_id
                     AND NOT (status = 'queued' AND json_extract(payload_json, '$.queueHeld') IS 1)
                   ORDER BY ordinal DESC LIMIT 1
                  ) IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
                  AND NOT EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_context_transfers
                  WHERE source_thread_id = child.thread_id
                    AND target_thread_id = json_extract(child.payload_json, '$.lineage.parentThreadId')
                    AND type = 'subagent_result'
                )))
            `;
          case "restart-continuations":
            return sql`
              SELECT thread_id FROM (
                SELECT bindings.thread_id
                FROM orchestration_v2_projection_provider_sessions AS sessions
                JOIN orchestration_v2_projection_provider_session_bindings AS bindings
                  ON bindings.provider_session_id = sessions.provider_session_id
                WHERE sessions.status NOT IN ('stopped', 'error')
                UNION
                SELECT thread_id FROM orchestration_v2_projection_provider_sessions AS sessions
                WHERE status NOT IN ('stopped', 'error') AND thread_id IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_provider_session_bindings AS bindings
                    WHERE bindings.provider_session_id = sessions.provider_session_id
                  )
              )
              -- A live session alone continues nothing: restartContinuationRun
              -- also needs an active provider thread or open background work.
              WHERE thread_id IN (
                SELECT thread_id FROM orchestration_v2_projection_provider_threads
                WHERE status = 'active'
                  OR CASE WHEN json_valid(payload_json)
                    THEN json_array_length(payload_json, '$.pendingBackgroundTasks') > 0
                    ELSE 0 END
                UNION
                SELECT thread_id FROM orchestration_v2_projection_turn_items
                WHERE type IN ('command_execution', 'dynamic_tool', 'subagent')
                  AND status IN ('pending', 'running', 'waiting')
              )
              UNION
              SELECT thread_id FROM orchestration_v2_projection_runs
              WHERE status = 'starting'
                AND CASE WHEN json_valid(payload_json)
                  THEN json_extract(payload_json, '$.restartContinuationOfRunId') IS NOT NULL
                  ELSE 0 END
            `;
          case "runtime":
            return sql`
              WITH pending_provider_threads AS MATERIALIZED (
                SELECT provider_thread_id, thread_id, owner_node_id
                FROM orchestration_v2_projection_provider_threads
                WHERE status = 'active'
                  OR CASE WHEN json_valid(payload_json)
                    THEN json_array_length(payload_json, '$.pendingBackgroundTasks') > 0
                    ELSE 0 END
              )
              SELECT thread_id FROM orchestration_v2_projection_runs
              WHERE status IN ('preparing', 'starting', 'running', 'waiting')
              UNION
              -- A held queue already went through recovery; rereading it on
              -- every boot costs a projection read per held thread.
              SELECT thread_id FROM orchestration_v2_projection_runs
              WHERE status = 'queued'
                AND CASE WHEN json_valid(payload_json)
                  THEN json_extract(payload_json, '$.queueHeld') IS NOT 1
                  ELSE 1 END
              UNION
              SELECT thread_id FROM orchestration_v2_projection_runtime_requests
              WHERE status = 'pending'
              UNION
              -- One bound thread stops a session; the other arms select the
              -- bound threads with work, so idle threads on a shared session stay out.
              SELECT (
                SELECT bindings.thread_id
                FROM orchestration_v2_projection_provider_session_bindings AS bindings
                JOIN orchestration_v2_projection_threads AS threads
                  ON threads.thread_id = bindings.thread_id
                WHERE bindings.provider_session_id = sessions.provider_session_id
                  AND threads.deleted_at IS NULL
                ORDER BY bindings.thread_id LIMIT 1
              )
              FROM orchestration_v2_projection_provider_sessions AS sessions
              WHERE sessions.status NOT IN ('stopped', 'error')
                OR (sessions.status = 'error' AND CASE WHEN json_valid(sessions.payload_json)
                  THEN json_array_length(sessions.payload_json, '$.extensionStatuses') > 0
                  ELSE 0 END)
              UNION
              -- A detach drops the binding but keeps the session's status.
              SELECT sessions.thread_id
              FROM orchestration_v2_projection_provider_sessions AS sessions
              WHERE sessions.status NOT IN ('stopped', 'error')
                AND sessions.thread_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_provider_session_bindings AS bindings
                  WHERE bindings.provider_session_id = sessions.provider_session_id
                )
              UNION
              SELECT thread_id FROM pending_provider_threads
              UNION
              SELECT nodes.thread_id FROM pending_provider_threads
              CROSS JOIN orchestration_v2_projection_nodes AS nodes
                ON nodes.node_id = pending_provider_threads.owner_node_id
              UNION
              SELECT subagents.thread_id FROM pending_provider_threads
              CROSS JOIN orchestration_v2_projection_subagents AS subagents
                ON subagents.provider_thread_id = pending_provider_threads.provider_thread_id
              -- A delegated task's provider thread belongs to its child thread.
              WHERE subagents.origin = 'provider_native'
              UNION
              SELECT subagents.child_thread_id FROM orchestration_v2_projection_subagents AS subagents
              WHERE subagents.child_thread_id IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_nodes AS node
                    ${LIVE_NODES_INDEX}
                  WHERE node.thread_id = subagents.child_thread_id
                    AND node.status IN ('pending', 'starting', 'running', 'waiting')
                    AND node.run_id IS NULL
                    AND node.kind = 'root_turn'
                )
              UNION
              -- No native subagent outlives the provider process that ran it.
              SELECT thread_id FROM orchestration_v2_projection_subagents
              WHERE origin = 'provider_native'
                AND status IN ('pending', 'running', 'waiting')
              UNION
              SELECT item.thread_id FROM orchestration_v2_projection_turn_items AS item
              WHERE NOT EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_runs AS run
                  WHERE run.run_id = item.run_id AND run.status = 'rolled_back'
                )
                AND type IN ('command_execution', 'dynamic_tool', 'subagent')
                AND status IN ('pending', 'running', 'waiting')
              UNION
              SELECT thread_id FROM orchestration_v2_effect_outbox
              WHERE status IN ('pending', 'running')
            `;
        }
      })();
      const rows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL
          AND thread_id IN (${candidates})
          ${projects?.include === undefined ? sql`` : sql`AND project_id IN (SELECT value FROM json_each(${encodeIdList(projects.include)}))`}
          ${projects?.exclude === undefined ? sql`` : sql`AND project_id NOT IN (SELECT value FROM json_each(${encodeIdList(projects.exclude)}))`}
          ${kind === "queued-runs" ? sql`AND archived_at IS NULL` : sql``}
        ORDER BY updated_at ASC, thread_id ASC
      `;
      return rows.map((row) => ThreadId.make(row.thread_id));
    },
    Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
  );

  const getUnreadableThreadIds = Effect.fn("ProjectionStore.getUnreadableThreadIds")(
    function* () {
      const actualThreadIds = new Set<ThreadId>();
      const unreadable = new Set<ThreadId>();
      const forkChildren = new Map<ThreadId, Array<ThreadId>>();
      const tables: ReadonlyArray<{
        readonly name: string;
        readonly id: string;
        readonly decode: (
          payload: string,
          entityId: string,
        ) => Effect.Effect<unknown, Schema.SchemaError>;
      }> = [
        {
          name: "threads",
          id: "thread_id",
          decode: (payload: string, entityId: string) =>
            decodeThreadPayload(payload).pipe(
              Effect.tap((thread) =>
                Effect.sync(() => {
                  if (thread.forkedFrom?.type !== "run") return;
                  const sourceId = thread.forkedFrom.threadId;
                  const children = forkChildren.get(sourceId) ?? [];
                  children.push(ThreadId.make(entityId));
                  forkChildren.set(sourceId, children);
                }),
              ),
            ),
        },
        { name: "runs", id: "run_id", decode: (payload) => decodeRunPayload(payload) },
        {
          name: "run_attempts",
          id: "attempt_id",
          decode: (payload) => decodeRunAttemptPayload(payload),
        },
        { name: "nodes", id: "node_id", decode: (payload) => decodeNodePayload(payload) },
        {
          name: "subagents",
          id: "subagent_id",
          decode: (payload) => decodeSubagentPayload(payload),
        },
        {
          name: "provider_sessions",
          id: "provider_session_id",
          decode: (payload) => decodeProviderSessionPayload(payload),
        },
        {
          name: "provider_threads",
          id: "provider_thread_id",
          decode: (payload) => decodeProviderThreadPayload(payload),
        },
        {
          name: "provider_turns",
          id: "provider_turn_id",
          decode: (payload) => decodeProviderTurnPayload(payload),
        },
        {
          name: "runtime_requests",
          id: "runtime_request_id",
          decode: (payload) => decodeRuntimeRequestPayload(payload),
        },
        {
          name: "messages",
          id: "message_id",
          decode: (payload) => decodeMessagePayload(payload),
        },
        { name: "plans", id: "plan_id", decode: (payload) => decodePlanJson(payload) },
        {
          name: "turn_items",
          id: "turn_item_id",
          decode: (payload) => decodeTurnItemPayload(payload),
        },
        {
          name: "checkpoint_scopes",
          id: "scope_id",
          decode: (payload) => decodeCheckpointScopePayload(payload),
        },
        {
          name: "checkpoints",
          id: "checkpoint_id",
          decode: (payload) => decodeCheckpointPayload(payload),
        },
        {
          name: "context_handoffs",
          id: "context_handoff_id",
          decode: (payload) => decodeContextHandoffPayload(payload),
        },
        {
          name: "context_transfers",
          id: "context_transfer_id",
          decode: (payload) => decodeContextTransferPayload(payload),
        },
      ];
      const pageSize = 500;
      for (const table of tables) {
        let afterRowId = 0;
        while (true) {
          const rows = yield* sql<{
            readonly row_id: number;
            readonly entity_id: string;
            readonly thread_id: string | null;
            readonly target_thread_id: string | null;
            readonly payload_json: string;
          }>`
            SELECT rowid AS row_id, ${sql(table.id)} AS entity_id,
              ${sql(table.name === "context_transfers" ? "source_thread_id" : "thread_id")} AS thread_id,
              ${table.name === "context_transfers" ? sql`target_thread_id` : sql`NULL`} AS target_thread_id,
              payload_json
            FROM ${sql(`orchestration_v2_projection_${table.name}`)}
            WHERE rowid > ${afterRowId}
            ORDER BY rowid ASC LIMIT ${pageSize}
          `;
          for (const row of rows) {
            if (table.name === "threads") actualThreadIds.add(ThreadId.make(row.entity_id));
            const decoded = yield* Effect.exit(
              Effect.suspend(() => table.decode(row.payload_json, row.entity_id)),
            );
            if (decoded._tag === "Success") continue;
            if (table.name === "provider_sessions") {
              const bindings = yield* sql<{ readonly thread_id: string }>`
                SELECT thread_id FROM orchestration_v2_projection_provider_session_bindings
                WHERE provider_session_id = ${row.entity_id}
              `;
              for (const binding of bindings) unreadable.add(ThreadId.make(binding.thread_id));
            } else {
              if (row.thread_id !== null) unreadable.add(ThreadId.make(row.thread_id));
              if (row.target_thread_id !== null)
                unreadable.add(ThreadId.make(row.target_thread_id));
            }
            if (table.name === "provider_threads") {
              const owners = yield* sql<{ readonly thread_id: string }>`
                SELECT thread_id FROM orchestration_v2_projection_nodes
                WHERE node_id = (
                  SELECT owner_node_id FROM orchestration_v2_projection_provider_threads
                  WHERE provider_thread_id = ${row.entity_id}
                )
                UNION
                SELECT thread_id FROM orchestration_v2_projection_subagents
                WHERE provider_thread_id = ${row.entity_id}
              `;
              for (const owner of owners) unreadable.add(ThreadId.make(owner.thread_id));
            }
          }
          if (rows.length < pageSize) break;
          afterRowId = rows[rows.length - 1]!.row_id;
          yield* Effect.yieldNow;
        }
      }
      const pending = [
        ...unreadable,
        ...[...forkChildren.keys()].filter((sourceId) => !actualThreadIds.has(sourceId)),
      ];
      for (let index = 0; index < pending.length; index += 1) {
        for (const childId of forkChildren.get(pending[index]!) ?? []) {
          if (unreadable.has(childId)) continue;
          unreadable.add(childId);
          pending.push(childId);
        }
      }
      return [...unreadable].filter((threadId) => actualThreadIds.has(threadId)).sort();
    },
    Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
  );

  const getRuntimeRecoveryProjection = Effect.fn("ProjectionStore.getRuntimeRecoveryProjection")(
    function* (threadId: ThreadId) {
      const threadRows = yield* sql<PayloadRow>`
        SELECT payload_json FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId}
      `;
      if (threadRows[0] === undefined) {
        return yield* new ProjectionStoreThreadNotFoundError({ threadId });
      }
      const thread = yield* decodeThreadPayload(threadRows[0].payload_json);
      // One worker round trip and one SQLite snapshot; decisions still read after the prior commit.
      const queries = {
        runs: sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_runs AS run
          WHERE run.thread_id = ${threadId}
            AND (
              run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
              OR run.run_id = (
                SELECT latest.run_id FROM orchestration_v2_projection_runs AS latest
                WHERE latest.thread_id = ${threadId}
                ORDER BY latest.ordinal DESC LIMIT 1
              )
              -- Retain the latest ended run for each provider thread with lost
              -- background work, including owners used before a handoff. An
              -- unfinished run is read above and may prove never started.
              OR run.run_id IN (
                SELECT (
                  SELECT ended.run_id FROM orchestration_v2_projection_runs AS ended
                  WHERE ended.thread_id = ${threadId}
                    AND ended.provider_thread_id = roster.provider_thread_id
                    AND ended.status NOT IN (
                      'queued', 'preparing', 'starting', 'running', 'waiting', 'rolled_back'
                    )
                    -- A run that never started (see neverStarted) owns no work.
                    AND NOT (
                      json_type(ended.payload_json, '$.startedAt') = 'null'
                      AND json_type(ended.payload_json, '$.restartContinuationOfRunId') IS NULL
                    )
                  ORDER BY ended.completed_at IS NULL DESC, ended.completed_at DESC,
                    ended.ordinal DESC
                  LIMIT 1
                )
                FROM orchestration_v2_projection_provider_threads AS roster
                WHERE roster.thread_id = ${threadId}
                  AND CASE WHEN json_valid(roster.payload_json)
                    THEN json_array_length(roster.payload_json, '$.pendingBackgroundTasks') > 0
                    ELSE 0 END
              )
              OR run.run_id IN (
                SELECT item.run_id FROM orchestration_v2_projection_turn_items AS item
                WHERE item.thread_id = ${threadId}
                  AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                  AND item.status IN ('pending', 'running', 'waiting')
                  AND item.run_id IS NOT NULL
              )
            )
          ORDER BY run.ordinal ASC
        `,
        attempts: sql<PayloadRow>`
          SELECT attempt.payload_json
          FROM orchestration_v2_projection_run_attempts AS attempt
          WHERE attempt.thread_id = ${threadId}
            AND attempt.run_id IN (
              SELECT run_id FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId}
                AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
            )
          ORDER BY attempt.run_id ASC, attempt.attempt_ordinal ASC
        `,
        nodes: sql<PayloadRow>`
          SELECT node.payload_json FROM orchestration_v2_projection_nodes AS node
            ${LIVE_NODES_INDEX}
          WHERE node.thread_id = ${threadId}
            AND node.status IN ('pending', 'starting', 'running', 'waiting')
            AND (
              (node.run_id IS NULL AND node.kind = 'root_turn')
              OR node.node_id IN (
                SELECT node_id FROM orchestration_v2_projection_runtime_requests
                WHERE thread_id = ${threadId} AND status = 'pending' AND kind = 'user_input'
              )
              OR node.run_id IN (
                SELECT run_id FROM orchestration_v2_projection_runs
                WHERE thread_id = ${threadId}
                  AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
              )
              OR node.node_id IN (
                SELECT item.node_id FROM orchestration_v2_projection_turn_items AS item
                WHERE item.thread_id = ${threadId}
                  AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                  AND item.status IN ('pending', 'running', 'waiting')
              )
              OR node.node_id IN (
                SELECT json_extract(item.payload_json, '$.subagentId')
                FROM orchestration_v2_projection_turn_items AS item
                WHERE item.thread_id = ${threadId} AND item.type = 'subagent'
                  AND item.status IN ('pending', 'running', 'waiting')
              )
              OR node.node_id IN (
                SELECT subagent_id FROM orchestration_v2_projection_subagents
                WHERE thread_id = ${threadId} AND origin = 'provider_native'
                  AND status IN ('pending', 'running', 'waiting')
              )
            )
          ORDER BY COALESCE(node.started_at, ''), node.node_id ASC
        `,
        subagents: sql<PayloadRow>`
          SELECT subagent.payload_json FROM orchestration_v2_projection_subagents AS subagent
          WHERE subagent.thread_id = ${threadId}
            AND subagent.status IN ('pending', 'starting', 'running', 'waiting')
            AND (
              subagent.origin = 'provider_native'
              OR subagent.run_id IN (
                SELECT run_id FROM orchestration_v2_projection_runs
                WHERE thread_id = ${threadId}
                  AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
              )
              OR subagent.subagent_id IN (
                SELECT json_extract(item.payload_json, '$.subagentId')
                FROM orchestration_v2_projection_turn_items AS item
                WHERE item.thread_id = ${threadId} AND item.type = 'subagent'
                  AND item.status IN ('pending', 'running', 'waiting')
              )
            )
          ORDER BY COALESCE(subagent.started_at, ''), subagent.subagent_id ASC
        `,
        providerSessions: sql<PayloadRow>`
          SELECT session.payload_json
          FROM orchestration_v2_projection_provider_sessions AS session
          WHERE (
              session.provider_session_id IN (
                SELECT binding.provider_session_id
                FROM orchestration_v2_projection_provider_session_bindings AS binding
                WHERE binding.thread_id = ${threadId}
              )
              AND (
                session.status NOT IN ('stopped', 'error')
                OR (session.status = 'error' AND CASE WHEN json_valid(session.payload_json)
                  THEN json_array_length(session.payload_json, '$.extensionStatuses') > 0
                  ELSE 0 END)
                OR session.provider_session_id IN (
                  SELECT provider_thread.provider_session_id
                  FROM orchestration_v2_projection_provider_threads AS provider_thread
                  WHERE provider_thread.provider_thread_id IN (
                    SELECT run.provider_thread_id
                    FROM orchestration_v2_projection_runs AS run
                    WHERE run.thread_id = ${threadId}
                      AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                  )
                )
              )
            )
            -- This thread detached it, which keeps its status. Its process
            -- did not outlive the server either, so recovery stops it.
            OR (
              session.thread_id = ${threadId}
              AND session.status NOT IN ('stopped', 'error')
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_v2_projection_provider_session_bindings AS binding
                WHERE binding.provider_session_id = session.provider_session_id
              )
            )
          ORDER BY session.updated_at ASC, session.provider_session_id ASC
        `,
        providerThreads: sql<PayloadRow>`
          SELECT provider_thread.payload_json
          FROM orchestration_v2_projection_provider_threads AS provider_thread
          WHERE provider_thread.provider_thread_id IN (
              SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads
              WHERE thread_id = ${threadId}
              UNION
              -- Start with non-null owners; a thread can have a large settled node history.
              SELECT owned.provider_thread_id
              FROM orchestration_v2_projection_provider_threads AS owned
                INDEXED BY orchestration_v2_projection_provider_threads_owner_idx
              CROSS JOIN orchestration_v2_projection_nodes AS owner
                ON owner.node_id = owned.owner_node_id
              WHERE owned.owner_node_id IS NOT NULL AND owner.thread_id = ${threadId}
              UNION
              SELECT provider_thread_id FROM orchestration_v2_projection_subagents
              WHERE thread_id = ${threadId} AND provider_thread_id IS NOT NULL
                AND origin = 'provider_native'
            )
            AND (
              provider_thread.status = 'active'
              OR CASE WHEN json_valid(provider_thread.payload_json)
                THEN json_array_length(provider_thread.payload_json, '$.pendingBackgroundTasks') > 0
                ELSE 0 END
              OR provider_thread.provider_thread_id IN (
                SELECT run.provider_thread_id FROM orchestration_v2_projection_runs AS run
                WHERE run.thread_id = ${threadId}
                  AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
              )
              OR provider_thread.provider_thread_id IN (
                SELECT item.provider_thread_id
                FROM orchestration_v2_projection_turn_items AS item
                WHERE item.thread_id = ${threadId}
                  AND item.status IN ('pending', 'running', 'waiting')
              )
              -- A native subagent's item names its own provider thread; the
              -- run that waits on it (see awaitingProviderThreadId) is woken.
              OR provider_thread.provider_thread_id IN (
                SELECT run.provider_thread_id
                FROM orchestration_v2_projection_turn_items AS item
                JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
                WHERE item.thread_id = ${threadId}
                  AND item.status IN ('pending', 'running', 'waiting')
              )
            )
          ORDER BY COALESCE(provider_thread.first_run_ordinal, 0), provider_thread.provider_thread_id ASC
        `,
        providerTurns: sql<PayloadRow>`
          SELECT provider_turn.payload_json
          FROM orchestration_v2_projection_provider_turns AS provider_turn
          WHERE provider_turn.thread_id = ${threadId}
            AND provider_turn.status IN ('pending', 'starting', 'running', 'waiting')
            AND (
              provider_turn.run_attempt_id IN (
                SELECT attempt_id FROM orchestration_v2_projection_run_attempts
                WHERE thread_id = ${threadId}
                  AND run_id IN (
                    SELECT run_id FROM orchestration_v2_projection_runs
                    WHERE thread_id = ${threadId}
                      AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                  )
              )
              OR (
                provider_turn.run_attempt_id IS NULL
                AND provider_turn.node_id IN (
                  SELECT node_id FROM orchestration_v2_projection_nodes
                  WHERE thread_id = ${threadId}
                    AND run_id IS NULL
                    AND kind = 'root_turn'
                    AND status IN ('pending', 'running', 'waiting')
                )
              )
            )
          ORDER BY provider_turn.provider_thread_id ASC, provider_turn.ordinal ASC
        `,
        runtimeRequests: sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_runtime_requests
          WHERE thread_id = ${threadId} AND status = 'pending'
          ORDER BY created_at ASC, runtime_request_id ASC
        `,
        // CROSS JOIN keeps empty run cohorts out of message history; the run index bounds each lookup.
        messages: sql<PayloadRow>`
          SELECT message.payload_json FROM orchestration_v2_projection_runs AS message_run
          CROSS JOIN orchestration_v2_projection_messages AS message
            INDEXED BY orchestration_v2_projection_messages_run_idx ON message.run_id = message_run.run_id
          WHERE message_run.thread_id = ${threadId}
            AND message_run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
            AND message.thread_id = ${threadId} AND message.streaming = 1
          ORDER BY message.created_at ASC, message.message_id ASC
        `,
        turnItems: sql<PayloadRow>`
          SELECT item.payload_json FROM orchestration_v2_projection_turn_items AS item
          WHERE item.thread_id = ${threadId}
            AND item.status IN ('pending', 'running', 'waiting')
            AND (
              item.run_id IN (
                SELECT run_id FROM orchestration_v2_projection_runs
                WHERE thread_id = ${threadId}
                  AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
              )
              OR item.type IN ('command_execution', 'dynamic_tool', 'subagent')
              OR (
                item.type = 'user_input_request'
                AND json_extract(item.payload_json, '$.requestId') IN (
                  SELECT runtime_request_id FROM orchestration_v2_projection_runtime_requests
                  WHERE thread_id = ${threadId} AND status = 'pending' AND kind = 'user_input'
                )
              )
              OR (
                item.run_id IS NULL
                AND item.node_id IN (
                  SELECT node_id FROM orchestration_v2_projection_nodes
                  WHERE thread_id = ${threadId}
                    AND run_id IS NULL
                    AND kind = 'root_turn'
                    AND status IN ('pending', 'running', 'waiting')
                )
              )
            )
          ORDER BY item.ordinal ASC, item.turn_item_id ASC
        `,
      };
      const sections = Object.entries(queries).map(
        ([section, query]) => sql`
          SELECT ${section} AS section, payload_json, row_number() OVER () AS position
          FROM (${query})
        `,
      );
      const rows = yield* sql<PayloadRow & { readonly section: string }>`
        ${sql.join(" UNION ALL ", false)(sections)}
        ORDER BY section, position
      `;
      const readRows = (section: keyof typeof queries) =>
        rows.filter((row) => row.section === section);
      const [
        runs,
        attempts,
        nodes,
        subagents,
        providerSessions,
        providerThreads,
        providerTurns,
        runtimeRequests,
        messages,
        turnItems,
      ] = yield* Effect.all([
        decodeRows(decodeRunPayload, threadId)(readRows("runs")),
        decodeRows(decodeRunAttemptPayload, threadId)(readRows("attempts")),
        decodeRows(decodeNodePayload, threadId)(readRows("nodes")),
        decodeRows(decodeSubagentPayload, threadId)(readRows("subagents")),
        decodeRows(decodeProviderSessionPayload, threadId)(readRows("providerSessions")),
        decodeRows(decodeProviderThreadPayload, threadId)(readRows("providerThreads")),
        decodeRows(decodeProviderTurnPayload, threadId)(readRows("providerTurns")),
        decodeRows(decodeRuntimeRequestPayload, threadId)(readRows("runtimeRequests")),
        decodeRows(decodeMessagePayload, threadId)(readRows("messages")),
        decodeRows(decodeTurnItemPayload, threadId)(readRows("turnItems")),
      ]);
      return {
        thread,
        runs,
        attempts,
        nodes,
        subagents,
        providerSessions,
        providerThreads,
        providerTurns,
        runtimeRequests,
        messages,
        turnItems,
      } satisfies ProjectionRuntimeRecoveryState;
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      ),
  );

  const getPendingNativeUserInputs = (
    threadId: ThreadId,
    providerTurnId: ProviderTurnId,
  ): Effect.Effect<ProjectionPendingUserInputs, ProjectionStoreV2Error> =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<PayloadRow>`
        SELECT payload_json FROM orchestration_v2_projection_runtime_requests
        WHERE thread_id = ${threadId} AND provider_turn_id = ${providerTurnId}
          AND kind = 'user_input' AND status = 'pending'
      `;
          const runtimeRequests = (yield* decodeRows(
            decodeRuntimeRequestPayload,
            threadId,
          )(rows)).filter((request) => request.responseCapability.type !== "message");
          if (runtimeRequests.length === 0) return { runtimeRequests, nodes: [], turnItems: [] };
          const nodeRows = yield* sql<PayloadRow>`
        SELECT payload_json FROM orchestration_v2_projection_nodes
        WHERE thread_id = ${threadId} AND ${sql.in(
          "node_id",
          runtimeRequests.map((request) => request.nodeId),
        )}
      `;
          const itemRows = yield* sql<PayloadRow>`
        SELECT payload_json FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND provider_turn_id = ${providerTurnId}
          AND type = 'user_input_request'
      `;
          const requestIds = new Set(runtimeRequests.map((request) => request.id));
          return {
            runtimeRequests,
            nodes: yield* decodeRows(decodeNodePayload, threadId)(nodeRows),
            turnItems: (yield* decodeRows(decodeTurnItemPayload, threadId)(itemRows)).filter(
              (item) => item.type === "user_input_request" && requestIds.has(item.requestId),
            ),
          };
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

  const getPlan = (threadId: ThreadId, planId: PlanId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThread(threadId);
          const rows =
            yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_plans
        WHERE thread_id = ${threadId} AND plan_id = ${planId}`;
          return rows[0] === undefined ? undefined : yield* decodePlanJson(rows[0].payload_json);
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

  const hasUnpairedRunInterruptRequest = Effect.fn(
    "ProjectionStore.hasUnpairedRunInterruptRequest",
  )(
    function* (threadId: ThreadId, requestId: TurnItemId, resultId: TurnItemId) {
      const rows = yield* sql<{ pending: number }>`
      SELECT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND turn_item_id = ${requestId}
      ) AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND turn_item_id = ${resultId}
      ) AS pending
    `;
      return rows[0]?.pending === 1;
    },
    (effect, threadId, _requestId, _resultId) =>
      effect.pipe(Effect.mapError(controlReadError(threadId))),
  );

  const hasRunInterruptRequest = Effect.fn("ProjectionStore.hasRunInterruptRequest")(
    function* (threadId: ThreadId, runId: RunId) {
      yield* requireThread(threadId);
      // The literal type lets SQLite use the partial stop-request index.
      const rows = yield* sql<{ readonly found: number }>`
        SELECT 1 AS found FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND run_id = ${runId} AND type = 'run_interrupt_request'
        LIMIT 1`;
      return rows.length > 0;
    },
    (effect, threadId, _runId) =>
      sql.withTransaction(effect).pipe(Effect.mapError(controlReadError(threadId))),
  );

  const getRuntimeRequest = (threadId: ThreadId, requestId: RuntimeRequestId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThread(threadId);
          const rows = yield* sql<PayloadRow>`
        SELECT payload_json FROM orchestration_v2_projection_runtime_requests
        WHERE thread_id = ${threadId} AND runtime_request_id = ${requestId}
      `;
          return rows[0] === undefined
            ? undefined
            : yield* decodeRuntimeRequestPayload(rows[0].payload_json);
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

  const getProviderControlContext = (
    threadId: ThreadId,
    target: ProjectionProviderControlTarget,
  ): Effect.Effect<ProjectionProviderControlContext, ProjectionStoreV2Error> =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThread(threadId);
          const [threadRows, turnRows, attemptRows, messageRows] = yield* Effect.all([
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads
          WHERE provider_thread_id = ${target.providerThreadId} AND (
            thread_id = ${threadId}
            OR owner_node_id IN (${nodesOwningProviderThreads(threadId)})
            OR provider_thread_id IN (SELECT provider_thread_id FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId})
          )`,
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_turns
          WHERE thread_id = ${threadId} AND provider_turn_id = ${target.providerTurnId}`,
            target.attemptId === undefined
              ? Effect.succeed([] as ReadonlyArray<PayloadRow>)
              : sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_run_attempts
            WHERE thread_id = ${threadId} AND attempt_id = ${target.attemptId}`,
            target.messageId === undefined
              ? Effect.succeed([] as ReadonlyArray<PayloadRow>)
              : sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_messages
            WHERE thread_id = ${threadId} AND message_id = ${target.messageId}`,
          ]);
          const providerThread =
            threadRows[0] === undefined
              ? undefined
              : yield* decodeProviderThreadPayload(threadRows[0].payload_json);
          const providerTurn =
            turnRows[0] === undefined
              ? undefined
              : yield* decodeProviderTurnPayload(turnRows[0].payload_json);
          const attempt =
            attemptRows[0] === undefined
              ? undefined
              : yield* decodeRunAttemptPayload(attemptRows[0].payload_json);
          const message =
            messageRows[0] === undefined
              ? undefined
              : yield* decodeMessagePayload(messageRows[0].payload_json);
          let run: OrchestrationV2Run | undefined;
          if (target.messageId !== undefined && providerTurn !== undefined) {
            const rows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId} AND json_extract(payload_json, '$.activeAttemptId') IS ${providerTurn.runAttemptId}
          ORDER BY ordinal ASC LIMIT 1`;
            if (rows[0] !== undefined) run = yield* decodeRunPayload(rows[0].payload_json);
          }
          return { providerThread, providerTurn, attempt, message, run };
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

  const getRunningTurnContext = (threadId: ThreadId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThread(threadId);
          const rows =
            yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND status = 'running' ORDER BY ordinal ASC LIMIT 1`;
          const run =
            rows[0] === undefined ? undefined : yield* decodeRunPayload(rows[0].payload_json);
          if (run === undefined) return { run, providerThread: undefined, providerTurn: undefined };
          const threadRows =
            yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${run.providerThreadId}`;
          const turnRows =
            yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_turns
        WHERE provider_thread_id = ${run.providerThreadId}
          AND run_attempt_id = ${run.activeAttemptId}
          AND node_id = ${run.rootNodeId}
          AND status = 'running'`;
          return {
            run,
            providerThread:
              threadRows[0] === undefined
                ? undefined
                : yield* decodeProviderThreadPayload(threadRows[0].payload_json),
            providerTurn:
              turnRows[0] === undefined
                ? undefined
                : yield* decodeProviderTurnPayload(turnRows[0].payload_json),
          };
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

  const getThreadProviderContext = (
    threadId: ThreadId,
    targetInstanceId?: ProviderInstanceId,
  ): Effect.Effect<ProjectionThreadProviderContext, ProjectionStoreV2Error> =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const thread = yield* getThread(threadId);
          const sessionRows = yield* sql<PayloadRow>`
        SELECT session.payload_json FROM orchestration_v2_projection_provider_sessions AS session
        JOIN orchestration_v2_projection_provider_session_bindings AS binding
          ON binding.provider_session_id = session.provider_session_id
        WHERE binding.thread_id = ${threadId}
        ORDER BY session.updated_at ASC, session.provider_session_id ASC
      `;
          const threadRows =
            targetInstanceId === undefined
              ? []
              : yield* sql<PayloadRow>`
        SELECT payload_json FROM orchestration_v2_projection_provider_threads
        WHERE provider_thread_id = ${thread.activeProviderThreadId}
           OR provider_thread_id = (
             SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads
             WHERE thread_id = ${threadId} AND owner_node_id IS NULL
               AND provider_instance_id = ${targetInstanceId}
             ORDER BY updated_at DESC, provider_thread_id ASC LIMIT 1
           )
        ORDER BY updated_at ASC, provider_thread_id ASC
      `;
          return {
            thread,
            providerSessions: yield* decodeRows(
              decodeProviderSessionPayload,
              threadId,
            )(sessionRows),
            providerThreads: yield* decodeRows(decodeProviderThreadPayload, threadId)(threadRows),
          };
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

  const getRuntimeResponseContext = (
    threadId: ThreadId,
    requestId: RuntimeRequestId,
  ): Effect.Effect<ProjectionRuntimeResponseContext, ProjectionStoreV2Error> =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThread(threadId);
          const request = yield* getRuntimeRequest(threadId, requestId);
          if (request === undefined)
            return { request, node: undefined, item: undefined, session: undefined };
          const nodeRows =
            yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_nodes
        WHERE thread_id = ${threadId} AND node_id = ${request.nodeId}`;
          const itemRows =
            yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND node_id = ${request.nodeId} AND type IN ('approval_request', 'user_input_request')
          AND json_extract(payload_json, '$.requestId') = ${requestId}
        ORDER BY ordinal ASC LIMIT 1`;
          const sessionRows =
            request.responseCapability.type !== "live"
              ? []
              : yield* sql<PayloadRow>`
        SELECT session.payload_json FROM orchestration_v2_projection_provider_sessions AS session
        JOIN orchestration_v2_projection_provider_session_bindings AS binding
          ON binding.provider_session_id = session.provider_session_id
        WHERE binding.thread_id = ${threadId} AND session.provider_session_id = ${request.responseCapability.providerSessionId}`;
          return {
            request,
            node:
              nodeRows[0] === undefined
                ? undefined
                : yield* decodeNodePayload(nodeRows[0].payload_json),
            item:
              itemRows[0] === undefined
                ? undefined
                : yield* decodeTurnItemPayload(itemRows[0].payload_json),
            session:
              sessionRows[0] === undefined
                ? undefined
                : yield* decodeProviderSessionPayload(sessionRows[0].payload_json),
          };
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

  const getCheckpointContext = (
    threadId: ThreadId,
  ): Effect.Effect<ProjectionCheckpointContext, ProjectionStoreV2Error> =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const threads = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId} LIMIT 1
        `;
          if (threads.length === 0) {
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          }
          // Select checkpoint metadata only; diffs need neither transcripts nor large run/checkpoint JSON.
          const [runs, checkpointScopes, checkpoints] = yield* Effect.all([
            sql`
            SELECT run_id AS id, ordinal, status
            FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId}
            ORDER BY ordinal ASC
          `,
            sql`
            SELECT scope_id AS id, run_id AS "runId", kind,
              json_extract(payload_json, '$.cwd') AS cwd,
              json_extract(payload_json, '$.label') AS label,
              json_extract(payload_json, '$.repositoryPath') AS "repositoryPath"
            FROM orchestration_v2_projection_checkpoint_scopes
            WHERE thread_id = ${threadId}
            ORDER BY ordinal_within_parent ASC, scope_id ASC
          `,
            sql`
            SELECT scope_id AS "scopeId", run_id AS "runId",
              ordinal_within_scope AS "ordinalWithinScope",
              app_run_ordinal AS "appRunOrdinal", status,
              json_extract(payload_json, '$.ref') AS ref
            FROM orchestration_v2_projection_checkpoints
            WHERE thread_id = ${threadId}
            ORDER BY scope_id ASC, ordinal_within_scope ASC
          `,
          ]);
          return yield* decodeCheckpointContext({ runs, checkpointScopes, checkpoints });
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      );

  const getCheckpointCaptureContext = (
    threadId: ThreadId,
    target: { readonly runId: RunId; readonly scopeId: CheckpointScopeId },
  ): Effect.Effect<ProjectionCheckpointCaptureContext, ProjectionStoreV2Error> =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const threadRows = yield* sql<{
            readonly side_chat: number | null;
            readonly project_id: ProjectId;
            readonly worktree_path: string | null;
          }>`
        SELECT json_extract(payload_json, '$.lineage.sideChat') AS side_chat,
          json_extract(payload_json, '$.projectId') AS project_id,
          json_extract(payload_json, '$.worktreePath') AS worktree_path
        FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} LIMIT 1`;
          if (threadRows[0] === undefined) {
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          }
          const runRows = yield* sql<PayloadRow>`
        SELECT payload_json FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND run_id = ${target.runId}`;
          const run =
            runRows[0] === undefined ? undefined : yield* decodeRunPayload(runRows[0].payload_json);
          const preservedCheckpoint = sql`(status = 'ready' OR (status IN ('missing', 'error') AND run_id IS NOT NULL))`;
          const [
            nodeRows,
            scopeRows,
            providerRows,
            preservedRows,
            repositoryScopeRows,
            repositoryBaselineRows,
          ] = yield* Effect.all([
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId} AND node_id = ${run?.rootNodeId ?? null}`,
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes
          WHERE thread_id = ${threadId} AND scope_id = ${target.scopeId}`,
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads
          WHERE provider_thread_id = ${run?.providerThreadId ?? null}
            AND (thread_id = ${threadId}
              OR owner_node_id IN (${nodesOwningProviderThreads(threadId)})
              OR provider_thread_id IN (SELECT provider_thread_id FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId}))`,
            sql<{ readonly ordinal: number }>`SELECT ordinal_within_scope AS ordinal
          FROM orchestration_v2_projection_checkpoints
          WHERE thread_id = ${threadId} AND scope_id = ${target.scopeId}
            AND ${preservedCheckpoint}`,
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes
          WHERE thread_id = ${threadId} AND kind = 'manual' ORDER BY scope_id ASC`,
            sql<{ readonly scope_id: CheckpointScopeId }>`SELECT scope_id
          FROM orchestration_v2_projection_checkpoints
          WHERE thread_id = ${threadId}
            AND ordinal_within_scope = ${Math.max(0, (run?.ordinal ?? 0) - 1)}
            AND scope_id IN (SELECT scope_id FROM orchestration_v2_projection_checkpoint_scopes
              WHERE thread_id = ${threadId} AND kind = 'manual')
            AND ${preservedCheckpoint}`,
          ]);
          return {
            run,
            rootNode:
              nodeRows[0] === undefined
                ? undefined
                : yield* decodeNodePayload(nodeRows[0].payload_json),
            scope:
              scopeRows[0] === undefined
                ? undefined
                : yield* decodeCheckpointScopePayload(scopeRows[0].payload_json),
            providerThread:
              providerRows[0] === undefined
                ? undefined
                : yield* decodeProviderThreadPayload(providerRows[0].payload_json),
            preservedCheckpointOrdinals: preservedRows.map(({ ordinal }) => ordinal),
            sideChat: threadRows[0].side_chat === 1,
            thread: {
              projectId: threadRows[0].project_id,
              worktreePath: threadRows[0].worktree_path,
            },
            repositoryScopes: yield* decodeRows(
              decodeCheckpointScopePayload,
              threadId,
            )(repositoryScopeRows),
            repositoryScopesWithBaseline: repositoryBaselineRows.map((row) => row.scope_id),
          };
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

  const getCheckpointRollbackContext = (
    threadId: ThreadId,
    target: {
      readonly providerThreadId: ProviderThreadId;
      readonly checkpointId: CheckpointId;
      readonly scopeId: CheckpointScopeId;
    },
  ): Effect.Effect<ProjectionCheckpointRollbackContext, ProjectionStoreV2Error> =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const thread = yield* getThread(threadId);
          const [providerRows, checkpointRows, scopeRows] = yield* Effect.all([
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads
          WHERE provider_thread_id = ${target.providerThreadId}
            AND (thread_id = ${threadId}
              OR owner_node_id IN (${nodesOwningProviderThreads(threadId)})
              OR provider_thread_id IN (SELECT provider_thread_id FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId}))`,
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_checkpoints
          WHERE thread_id = ${threadId} AND checkpoint_id = ${target.checkpointId}`,
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes
          WHERE thread_id = ${threadId} AND scope_id = ${target.scopeId}`,
          ]);
          const providerThread =
            providerRows[0] === undefined
              ? undefined
              : yield* decodeProviderThreadPayload(providerRows[0].payload_json);
          const checkpoint =
            checkpointRows[0] === undefined
              ? undefined
              : yield* decodeCheckpointPayload(checkpointRows[0].payload_json);
          const scope =
            scopeRows[0] === undefined
              ? undefined
              : yield* decodeCheckpointScopePayload(scopeRows[0].payload_json);
          const context: ProjectionCheckpointRollbackContext = {
            thread,
            providerThread,
            checkpoint,
            scope,
            providerSession: undefined,
            targetAttempt: undefined,
            providerTurns: [],
            rolledBackAttemptIds: [],
            runsToRollback: [],
            rootNodes: [],
            staleCheckpoints: [],
          };
          if (
            providerThread === undefined ||
            providerThread.providerSessionId === null ||
            checkpoint === undefined ||
            scope === undefined ||
            checkpoint.scopeId !== scope.id ||
            checkpoint.status === "stale" ||
            providerThread.id !== thread.activeProviderThreadId ||
            providerThread.providerInstanceId !== thread.modelSelection.instanceId
          )
            return context;

          const targetOrdinal = checkpoint.appRunOrdinal ?? 0;
          const [attemptRows, runRows, sessionRows, rolledBackAttempts, staleRows] =
            yield* Effect.all([
              sql`SELECT attempt.attempt_id AS id, attempt.provider_turn_id AS "providerTurnId"
          FROM orchestration_v2_projection_run_attempts AS attempt
          JOIN orchestration_v2_projection_runs AS run
            ON attempt.attempt_id = json_extract(run.payload_json, '$.activeAttemptId')
          WHERE run.thread_id = ${threadId} AND run.ordinal = ${targetOrdinal}
            AND run.status != 'rolled_back' AND attempt.thread_id = ${threadId}`,
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId} AND ordinal > ${targetOrdinal}
            AND status IN ('completed', 'interrupted', 'failed', 'cancelled')
          ORDER BY ordinal ASC`,
              sql<PayloadRow>`SELECT session.payload_json
          FROM orchestration_v2_projection_provider_sessions AS session
          JOIN orchestration_v2_projection_provider_session_bindings AS binding
            ON binding.provider_session_id = session.provider_session_id
          WHERE binding.thread_id = ${threadId}
            AND session.provider_session_id = ${providerThread.providerSessionId}`,
              sql<{ readonly id: RunAttemptId }>`SELECT attempt.attempt_id AS id
          FROM orchestration_v2_projection_run_attempts AS attempt
          JOIN orchestration_v2_projection_runs AS run ON run.run_id = attempt.run_id
          WHERE run.thread_id = ${threadId} AND run.status = 'rolled_back'
            AND attempt.thread_id = ${threadId}`,
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_checkpoints
          WHERE thread_id = ${threadId} AND status = 'ready'
            AND ((scope_id = ${scope.id} AND app_run_ordinal > ${targetOrdinal})
              -- Repository checkpoints carry no app run ordinal; theirs is the run's ordinal.
              OR (ordinal_within_scope > ${targetOrdinal} AND scope_id IN (
                SELECT scope_id FROM orchestration_v2_projection_checkpoint_scopes
                WHERE thread_id = ${threadId} AND kind = 'manual')))
          ORDER BY scope_id = ${scope.id} DESC, scope_id ASC, ordinal_within_scope ASC`,
            ]);
          const targetAttempt = (yield* decodeRollbackTargetAttempts(attemptRows))[0];
          const runsToRollback = yield* decodeRows(decodeRunPayload, threadId)(runRows);
          const [nodeRows, turnRows] = yield* Effect.all([
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId} AND ${sql.in(
            "node_id",
            runsToRollback.map((run) => run.rootNodeId),
          )}
          ORDER BY node_id ASC`,
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_turns
          WHERE thread_id = ${threadId} AND (
            provider_thread_id = ${providerThread.id}
            OR provider_turn_id = ${targetAttempt?.providerTurnId ?? null}
            OR run_attempt_id = ${targetAttempt?.id ?? null})
          ORDER BY provider_thread_id ASC, ordinal ASC`,
          ]);
          return {
            ...context,
            targetAttempt,
            runsToRollback,
            providerSession:
              sessionRows[0] === undefined
                ? undefined
                : yield* decodeProviderSessionPayload(sessionRows[0].payload_json),
            rolledBackAttemptIds: rolledBackAttempts.map(({ id }) => id),
            rootNodes: yield* decodeRows(decodeNodePayload, threadId)(nodeRows),
            providerTurns: yield* decodeRows(decodeProviderTurnPayload, threadId)(turnRows),
            staleCheckpoints: yield* decodeRows(decodeCheckpointPayload, threadId)(staleRows),
          };
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

  const getRunMessage = (threadId: ThreadId, runId: RunId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThread(threadId);
          const rows = yield* sql<PayloadRow>`
        SELECT message.payload_json FROM orchestration_v2_projection_messages AS message
        JOIN orchestration_v2_projection_runs AS run
          ON message.message_id = json_extract(run.payload_json, '$.userMessageId')
        WHERE run.thread_id = ${threadId} AND run.run_id = ${runId}
          AND message.thread_id = ${threadId}`;
          return rows[0] === undefined
            ? undefined
            : yield* decodeMessagePayload(rows[0].payload_json);
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

  const getDelegatedChildControls = (
    threadId: ThreadId,
    {
      taskIds,
      windowSize,
    }: { readonly taskIds: ReadonlyArray<NodeId>; readonly windowSize: number },
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const records = yield* getThreadRecords(
            threadId,
            ["messages", "subagents", "providerThreads"],
            { messageRoles: ["user"], delegatedTaskMessagesOnly: true },
          );
          // Spells migration 84's order and predicate so the window walks that index.
          const windowRows = yield* sql<PayloadRow & { readonly completed_at: string | null }>`
            SELECT payload_json, completed_at FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId}
              AND status <> 'queued'
              AND NOT (status = 'cancelled' AND json_extract(payload_json, '$.startedAt') IS NULL)
            ORDER BY (completed_at IS NULL) DESC, completed_at DESC, ordinal DESC, run_id DESC
            LIMIT ${windowSize}
          `;
          const window = yield* decodeRows(decodeRunPayload, threadId)(windowRows);
          const last = window.length < windowSize ? undefined : window.at(-1);
          const floorCompletedAt = windowRows.at(-1)?.completed_at ?? null;
          // A window ending in unfinished runs bounds nothing, so read the whole thread.
          const floor = floorCompletedAt === null ? undefined : last;
          const rest = yield* (
            last !== undefined && floor === undefined
              ? sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId}`
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId}
              AND status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
            UNION
            SELECT payload_json FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} AND json_valid(payload_json)
              AND json_extract(payload_json, '$.delegatedTaskId') IS NOT NULL
              AND json_extract(payload_json, '$.delegatedTaskId')
                IN (SELECT value FROM json_each(${encodeIdList(taskIds)}))
            UNION
            -- Unstarted cancelled runs are outside the window's index.
            SELECT payload_json FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} AND status = 'cancelled'
              ${floor === undefined ? sql`` : sql`AND (completed_at IS NULL OR completed_at >= ${floorCompletedAt})`}`
          ).pipe(Effect.flatMap(decodeRows(decodeRunPayload, threadId)));
          const runs = new Map([...window, ...rest].map((run) => [run.id, run]));
          const requested = new Set<RunId>();
          for (;;) {
            const wakeRunIds = [
              ...new Set(
                records.messages.flatMap((message) =>
                  message.runId !== null &&
                  message.delegatedCompletion !== undefined &&
                  runs.has(message.delegatedCompletion.parentRunId) &&
                  !runs.has(message.runId) &&
                  !requested.has(message.runId)
                    ? [message.runId]
                    : [],
                ),
              ),
            ];
            if (wakeRunIds.length === 0) break;
            for (const id of wakeRunIds) requested.add(id);
            const wakes = yield* getThreadRecords(threadId, ["runs"], { runIds: wakeRunIds });
            for (const run of wakes.runs) runs.set(run.id, run);
          }
          return {
            ...records,
            runs: [...runs.values()].toSorted((a, b) => a.ordinal - b.ordinal),
            runsFloor: floor,
          };
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

  const getRun = (threadId: ThreadId, runId: RunId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThread(threadId);
          const rows = yield* sql<PayloadRow>`
        SELECT payload_json FROM orchestration_v2_projection_runs
        WHERE run_id = ${runId} AND thread_id = ${threadId}`;
          return rows[0] === undefined ? undefined : yield* decodeRunPayload(rows[0].payload_json);
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

  const canStartQueuedRun = (threadId: ThreadId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThread(threadId);
          const rows = yield* sql<{ readonly ready: number }>`
        SELECT 1 AS ready FROM orchestration_v2_projection_threads AS thread
        WHERE thread.thread_id = ${threadId} AND thread.archived_at IS NULL AND thread.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} AND status = 'queued'
              AND json_extract(payload_json, '$.queueHeld') IS NOT 1)
          AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId}
              AND status IN ('preparing', 'starting', 'running', 'waiting'))`;
          return rows.length > 0;
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

  const getHeldQueuedRuns = (threadId: ThreadId) =>
    sql<PayloadRow>`
      SELECT payload_json FROM orchestration_v2_projection_runs
      WHERE thread_id = ${threadId} AND status = 'queued'
        AND json_extract(payload_json, '$.queueHeld') IS 1
      ORDER BY ordinal ASC
    `.pipe(
      Effect.flatMap(decodeRows(decodeRunPayload, threadId)),
      Effect.mapError(controlReadError(threadId)),
    );

  return {
    getRuntimeRecoveryProjection,
    getRunningTurnContext,
    getThreadProviderContext,
    getRuntimeResponseContext,
    getCheckpointContext,
    getCheckpointCaptureContext,
    getCheckpointRollbackContext,
    getRunMessage,
    getDelegatedChildControls,
    getRun,
    canStartQueuedRun,
    getHeldQueuedRuns,
    getPendingNativeUserInputs,
    hasUnpairedRunInterruptRequest,
    hasRunInterruptRequest,
    getRuntimeRequest,
    getPlan,
    getProviderControlContext,
    getLimitRecoveryCandidates,
    getLimitRecoveryWakeAt,
    getRecoveryThreadIds,
    getUnreadableThreadIds,
  };
}
