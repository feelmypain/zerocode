import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@zerocode/contracts";
import { MessageId, NodeId, RunId, ThreadId, TurnItemId } from "@zerocode/contracts";
import { unsentManualContinuationSource } from "@zerocode/shared/orchestrationV2ManualContinuation";
import { runRanAfter } from "@zerocode/shared/orchestrationV2ThreadError";
import { createOrchestrationV2TurnItemVisibility } from "@zerocode/shared/orchestrationV2Timeline";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { MCP_APP_OUTPUT_KEY } from "@zerocode/shared/mcpApp";
import { threadHtmlRenderAttachmentIds } from "../../attachmentStore.ts";
import {
  DEFERRED_COMMAND_MESSAGE_CONDITION,
  JAVASCRIPT_TRIM_WHITESPACE,
} from "../deferredCommandMessage.ts";
import { DELEGATED_TASK_MESSAGE_CONDITION } from "../delegatedTaskMessage.ts";
import {
  anchorsModelSwitch,
  isModelSwitchCandidate,
  isShownUserMessageItem,
} from "../modelSwitch.ts";
import { makeThreadFind } from "../ThreadFind.ts";
import {
  DEFERRED_WORK_ITEM_TYPES,
  THREAD_HISTORY_INLINE_WORK_ITEM_LIMIT,
  THREAD_HISTORY_MAX_RAW_TURNS,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT,
  type SelectTimelinePageResult,
  type ThreadHistoryPrefix,
  decodeThreadHistoryCursor,
  deferWorkHistoryRows,
  encodeThreadHistoryCursor,
  findCursorEndIndex,
  isConversationHistoryItem,
  isFoldableWorkItem,
  isThreadHistoryUserTurn,
  missingInterruptRequests,
  olderHistoryPagePolicy,
  selectDeferredWorkPage,
  selectHistoryPageFromCursor,
  selectRecentTimelineWindow,
} from "../threadHistoryPaging.ts";
import { projectTurnItemForWire } from "../WireProjection.ts";
import {
  ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
  PROMPT_NARROWING_BLOCKING_FILTERS,
  type PayloadRow,
  type ProjectionRecordField,
  type ProjectionRecordFilter,
  type ProjectionRecords,
  type ProjectionSqlHelpers,
  ProjectionStoreReadError,
  ProjectionStoreThreadNotFoundError,
  type ProjectionStoreV2Error,
  type ProjectionTimelinePage,
  type ProjectionTimelinePageOptions,
  type ProjectionWindow,
  type ProjectionWindowOptions,
  type TimelineIndex,
  type TimelineIndexCache,
  type TimelineIndexItem,
  type TimelineIndexRow,
  activeLocalTurnItems,
  buildVisibleTurnItems,
  controlReadError,
  createInheritedTurnItemVisibility,
  decodeCheckpointPayload,
  decodeCheckpointScopePayload,
  decodeContextHandoffPayload,
  decodeContextTransferPayload,
  decodeForkRunIds,
  decodeMessagePayload,
  decodeNodePayload,
  decodePlanJson,
  decodeProviderSessionPayload,
  decodeProviderThreadPayload,
  decodeProviderTurnPayload,
  decodeRows,
  decodeRunAttemptPayload,
  decodeRunPayload,
  decodeRuntimeRequestPayload,
  decodeSubagentPayload,
  decodeThreadPayload,
  decodeTurnItemPayload,
  encodeForkRunIds,
  encodeIdList,
  encodeTimelineSources,
  forkMemberRunOrdinals,
  inheritedRunFork,
  inheritsForkConversation,
  isProjectionStoreReadError,
  isProjectionStoreThreadNotFoundError,
  isTurnItemAtOrBeforeRun,
  makeForkMarkerTurnItem,
  matchesNothing,
  nullableStringField,
  sortMessagesByTurnItemOrder,
  withLocalVisibleTurnItems,
} from "./ProjectionRowDecoders.ts";

// Least recently used first; a few cover clients scrolling side by side without pinning every thread.
const TIMELINE_INDEX_CACHE_LIMIT = 8;

export const makeThreadWindowReadStore = Effect.fn("ProjectionStore.makeThreadWindowReadStore")(
  function* (
    sql: SqlClient.SqlClient,
    helpers: ProjectionSqlHelpers,
    timelineIndexes: TimelineIndexCache,
  ) {
    const {
      CONVERSATION_INDEX_EXCLUDED_TYPES,
      LIVE_NODES_INDEX,
      settledSubagent,
      unsettledSubagentRowids,
      todoListOfSettledRun,
      nodesOwningProviderThreads,
      presentedShellRunId,
      getThread,
    } = helpers;

    // Share selection so counting discarded ancestry preserves payload-read positions.
    const retainedWindowRows = Effect.fn("ProjectionStore.retainedWindowRows")(function* (
      threadId: ThreadId,
      window: ProjectionWindow,
    ) {
      const eligible = sql`
        WITH eligible AS NOT MATERIALIZED (
          SELECT item.rowid AS item_rowid, item.payload_json, item.ordinal, item.turn_item_id,
            item.run_id, item.node_id, item.type, item.status, item.inline_work_output,
            run.status AS run_status,
            attempt.attempt_id, attempt.status AS attempt_status
          FROM orchestration_v2_projection_turn_items AS item
          LEFT JOIN orchestration_v2_projection_runs AS run
            ON run.run_id = item.run_id
          LEFT JOIN orchestration_v2_projection_nodes AS node
            ON ${window.deferWork ? 1 : 0} = 1 AND node.node_id = item.node_id
          LEFT JOIN orchestration_v2_projection_run_attempts AS attempt
            ON ${window.deferWork ? 1 : 0} = 1 AND attempt.attempt_id = (
              SELECT attempt_id FROM orchestration_v2_projection_run_attempts
              WHERE run_id = item.run_id AND root_node_id = COALESCE(node.root_node_id, item.node_id)
              ORDER BY attempt_ordinal DESC LIMIT 1
            )
          WHERE item.thread_id = ${threadId}
            AND item.ordinal <= COALESCE(
              (
                SELECT ordinal
                FROM orchestration_v2_projection_turn_items
                WHERE thread_id = ${threadId}
                  AND turn_item_id = ${window.anchorItemId ?? null}
                LIMIT 1
              ),
              9223372036854775807
            )
            -- The fork cutoff below filters rewound runs; undelivered queued input stays hidden.
            AND (
              ${window.requiredRunId ?? null} IS NOT NULL
              OR run.status IS NULL
              OR run.status <> 'rolled_back'
            )
            AND NOT (
              item.type = 'user_message'
              AND (
                COALESCE(run.status IN ('queued', 'cancelled'), 0)
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
              AND json_extract(item.payload_json, '$.inputIntent') = 'queued_turn'
              AND (run.status = 'queued' OR json_extract(run.payload_json, '$.startedAt') IS NULL)
            )
            AND (
              ${window.requiredRunId ?? null} IS NULL
              OR (
                item.run_id IS NULL
                AND EXISTS (
                  SELECT 1
                  FROM orchestration_v2_projection_threads AS source_thread
                  WHERE source_thread.thread_id = item.thread_id
                    AND json_extract(source_thread.payload_json, '$.historyOrigin') = 'v1_import'
                )
              )
              OR (
                run.ordinal <= (
                  SELECT required_run.ordinal
                  FROM orchestration_v2_projection_runs AS required_run
                  WHERE required_run.thread_id = item.thread_id
                    AND required_run.run_id = ${window.requiredRunId ?? null}
                  LIMIT 1
                )
                AND run.run_id IN (SELECT value FROM json_each(${window.forkRunIdsJson ?? "[]"}))
              )
            )
            AND NOT (
              item.type = 'run_interrupt_result'
              AND EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_run_attempts AS attempt
                WHERE attempt.run_id = item.run_id
                  AND attempt.root_node_id = item.node_id
                  AND attempt.status = 'superseded'
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_turn_items AS request
                WHERE request.thread_id = item.thread_id
                  AND request.run_id = item.run_id
                  AND request.type = 'run_interrupt_request'
              )
            )
        )`;
      // Resolve anchors separately: repeated CTE expansion exceeds SQLite's subquery limit.
      const anchors = yield* sql<{ readonly ordinal: number; readonly latest: number | null }>`
        ${eligible}, run_starts AS (
          -- A wake (PR watch, task completion) starts its run with a
          -- notification instead of a user message. Read the first
          -- input of each run, newest run first, and add the
          -- notifications to the user-message turn starts. A run
          -- without an eligible first input (queued, rolled back) is
          -- skipped, so it cannot hide older turns. CROSS JOIN keeps
          -- the runs as the outer loop, and each probe reads only the
          -- first rows of a run.
          SELECT start.ordinal, start.type
          FROM orchestration_v2_projection_runs AS recent_run
          CROSS JOIN eligible AS start ON start.item_rowid = (
            SELECT first_input.rowid
            FROM orchestration_v2_projection_turn_items AS first_input
            WHERE first_input.run_id = recent_run.run_id
              AND first_input.type IN ('user_message', 'notification')
            ORDER BY first_input.ordinal
            LIMIT 1
          )
          WHERE recent_run.thread_id = ${threadId}
            AND recent_run.ordinal <= COALESCE(
              (
                SELECT anchor_run.ordinal
                FROM orchestration_v2_projection_turn_items AS anchor_item
                JOIN orchestration_v2_projection_runs AS anchor_run
                  ON anchor_run.run_id = anchor_item.run_id
                WHERE anchor_item.thread_id = ${threadId}
                  AND anchor_item.turn_item_id = ${window.anchorItemId ?? null}
                LIMIT 1
              ),
              9223372036854775807
            )
            AND ${window.userTurnLimit ?? null} IS NOT NULL
          ORDER BY recent_run.ordinal DESC
          LIMIT ${THREAD_HISTORY_MAX_RAW_TURNS + 2}
        ), turn_anchors AS (
          SELECT ordinal, payload_json
          FROM (
            SELECT ordinal, payload_json
            FROM eligible
            WHERE type = 'user_message'
              AND json_extract(payload_json, '$.inputIntent') IN ('turn_start', 'queued_turn')
              AND ${window.userTurnLimit ?? null} IS NOT NULL
            ORDER BY ordinal DESC
            LIMIT ${THREAD_HISTORY_MAX_RAW_TURNS + 2}
          )
          UNION ALL
          SELECT ordinal, NULL FROM run_starts WHERE type = 'notification'
          ORDER BY ordinal DESC
          LIMIT ${THREAD_HISTORY_MAX_RAW_TURNS + 2}
        ), user_anchors AS (
          SELECT ordinal
          FROM turn_anchors
          WHERE json_extract(payload_json, '$.createdBy') = 'user'
          ORDER BY ordinal DESC
          LIMIT ${(window.userTurnLimit ?? 0) + 2}
        ), boundary AS (
          SELECT CASE
            WHEN COUNT(*) >= ${(window.userTurnLimit ?? 0) + 2} THEN MIN(ordinal)
            WHEN (SELECT COUNT(*) FROM turn_anchors) >= ${THREAD_HISTORY_MAX_RAW_TURNS + 2}
              THEN (SELECT MIN(ordinal) FROM turn_anchors)
            ELSE 0
          END AS ordinal
          FROM user_anchors
        )
        SELECT ordinal, (SELECT MAX(ordinal) FROM user_anchors) AS latest FROM boundary
      `;
      const boundary = anchors[0]!;
      // Folding needs whole segments, so the window would walk every item since the boundary.
      // It stays above the newest `tailRows` rows that are sure to keep their own row. Start at
      // the latest segment start of each run that reaches that point, clamped to it so runless
      // rows below stay in the scan.
      const tailRows = Math.max(window.rowLimit, THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT);
      // The newest rows sure to keep their own row: conversation rows, and every row of the
      // running run, which folds nothing. More of them than a whole turn may hold means the
      // window pages from inside the newest turn with the row limit, so the tail shrinks to
      // that limit. A turn of thousands of rows is then not walked to return the newest few.
      const tailWorkStart = sql<{
        readonly ordinal: number | null;
        readonly long_turn: number;
      }>`
        ${eligible}, live_run AS (
          -- The oldest live run is the one at work; queued runs follow it.
          SELECT live.run_id FROM orchestration_v2_projection_runs AS live
          WHERE live.thread_id = ${threadId}
            AND live.status IN ('queued','preparing','starting','running','waiting')
            AND ${window.requiredRunId ?? null} IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_run_attempts
              WHERE run_id = live.run_id AND status = 'superseded'
            )
          ORDER BY +live.ordinal ASC LIMIT 1
        ), visible_tail AS (
          SELECT ordinal FROM (
            SELECT ordinal FROM eligible
            WHERE ordinal >= ${boundary.ordinal}
              AND type NOT IN ${CONVERSATION_INDEX_EXCLUDED_TYPES}
            ORDER BY ordinal DESC
            LIMIT ${tailRows}
          )
          UNION
          SELECT ordinal FROM (
            SELECT live_item.ordinal
            FROM orchestration_v2_projection_turn_items AS live_item
            -- The unary plus keeps this on the run index, whose ordinal order ends
            -- the walk at the limit.
            WHERE live_item.run_id = (SELECT run_id FROM live_run)
              AND +live_item.thread_id = ${threadId}
              AND live_item.ordinal >= ${boundary.ordinal}
              AND live_item.ordinal <= COALESCE(
                (
                  SELECT ordinal FROM orchestration_v2_projection_turn_items
                  WHERE thread_id = ${threadId}
                    AND turn_item_id = ${window.anchorItemId ?? null}
                  LIMIT 1
                ),
                9223372036854775807
              )
            ORDER BY live_item.ordinal DESC
            LIMIT ${tailRows}
          )
          ORDER BY ordinal DESC
          LIMIT ${tailRows}
        ), turn AS (
          SELECT (
            SELECT COUNT(*) FROM visible_tail WHERE ordinal >= ${boundary.latest}
          ) > ${THREAD_HISTORY_PAGE_POLICY.maxTurnItems} AS long_turn
        ), tail AS (
          SELECT visible_tail.ordinal FROM visible_tail
          ORDER BY visible_tail.ordinal DESC
          LIMIT 1 OFFSET (
            SELECT MAX(CASE WHEN long_turn THEN ${window.rowLimit} ELSE ${tailRows} END, 1) - 1
            FROM turn
          )
        ), tail_runs AS (
          SELECT DISTINCT item.run_id
          FROM tail CROSS JOIN eligible AS item
          WHERE item.ordinal >= tail.ordinal AND item.run_id IS NOT NULL
        )
        SELECT MIN(MIN(CASE
          -- Only a completed run or a superseded attempt folds work, and folding is
          -- what needs the whole segment. Any other run keeps every row.
          WHEN (
            SELECT status FROM orchestration_v2_projection_runs
            WHERE run_id = tail_runs.run_id
          ) IS NOT 'completed' AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_run_attempts
            WHERE run_id = tail_runs.run_id AND status = 'superseded'
          ) THEN tail.ordinal
          ELSE COALESCE(
            (
              SELECT start.ordinal FROM eligible AS start
              WHERE start.run_id = tail_runs.run_id AND start.type = 'user_message'
                AND start.ordinal <= tail.ordinal
              ORDER BY start.ordinal DESC LIMIT 1
            ),
            (
              SELECT MIN(first.ordinal) FROM orchestration_v2_projection_turn_items AS first
              WHERE first.thread_id = ${threadId} AND first.run_id = tail_runs.run_id
            ),
            tail.ordinal
          )
        END, tail.ordinal)) AS ordinal, (SELECT long_turn FROM turn) AS long_turn
        FROM tail LEFT JOIN tail_runs
      `;
      // A negative or fractional limit makes SQLite's LIMIT disagree with `tailRows`; keep the old start.
      const tail =
        window.deferWork === true &&
        boundary.latest !== null &&
        Number.isSafeInteger(window.rowLimit) &&
        window.rowLimit >= 0
          ? (yield* tailWorkStart)[0]
          : undefined;
      const longTurn = tail?.long_turn === 1;
      const workStart = Math.max(boundary.ordinal, tail?.ordinal ?? 0);
      return sql`
        ${eligible}, blocked_runs AS MATERIALIZED (
          SELECT DISTINCT run_id FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND run_id IS NOT NULL
            AND ${window.deferWork ? 1 : 0} = 1
            -- Only a run that can fold asks whether it is blocked. A live run cannot,
            -- and this check would read every row it ever wrote.
            AND run_id IN (
              SELECT run_id FROM eligible
              WHERE ordinal >= ${workStart} AND run_id IS NOT NULL
                AND (run_status = 'completed' OR attempt_status = 'superseded')
            )
            AND (type IN ('run_interrupt_request', 'run_interrupt_result')
              OR (type = 'error' AND status = 'failed' AND parent_item_id IS NULL))
        ), work_segments AS (
          SELECT item_rowid, ordinal, turn_item_id, run_id, type, attempt_id,
            MAX(CASE WHEN type = 'user_message' THEN ordinal ELSE 0 END)
              OVER (PARTITION BY run_id ORDER BY ordinal) AS segment,
            CASE WHEN status = 'completed' AND (run_status = 'completed' OR attempt_status = 'superseded')
              AND type IN ${sql.in(DEFERRED_WORK_ITEM_TYPES)}
              AND inline_work_output = 0
              AND run_id NOT IN (SELECT run_id FROM blocked_runs)
              THEN 1 ELSE 0 END AS can_defer
          FROM eligible AS item
          WHERE ${window.deferWork ? 1 : 0} = 1
            AND ${boundary.latest === null ? 0 : 1} = 1
            AND ordinal >= ${workStart}
        ), deferred_work AS (
          SELECT run_id, segment, attempt_id, MIN(ordinal) AS first_ordinal,
            MAX(ordinal) AS last_ordinal, COUNT(*) AS item_count
          FROM work_segments WHERE can_defer = 1
          GROUP BY run_id, segment, attempt_id HAVING COUNT(*) > ${THREAD_HISTORY_INLINE_WORK_ITEM_LIMIT}
        ), window_items AS NOT MATERIALIZED (
          SELECT item_rowid, ordinal, turn_item_id, run_id, type
          FROM eligible WHERE ${window.deferWork ? 1 : 0} = 0
            OR ${boundary.latest === null ? 1 : 0} = 1
          UNION ALL
          SELECT item.item_rowid, item.ordinal, item.turn_item_id, item.run_id, item.type
          FROM work_segments item LEFT JOIN deferred_work deferred
            ON deferred.run_id = item.run_id AND deferred.segment = item.segment
            AND deferred.attempt_id IS item.attempt_id
          WHERE item.can_defer = 0 OR deferred.run_id IS NULL OR item.ordinal = deferred.first_ordinal
        ), latest_user_turn AS (
          -- Mirrors selectOlderTimelinePage: whole turns while the
          -- newest user turn fits the turn row budget, otherwise the
          -- window pages from inside that turn with the row limit.
          SELECT COUNT(*) AS row_count
          FROM (
            SELECT 1
            FROM window_items
            WHERE ordinal >= ${boundary.latest}
            LIMIT ${THREAD_HISTORY_PAGE_POLICY.maxTurnItems + 1}
          )
        ), selected AS (
          -- Choose and sort rows by ID, then fetch payloads in that
          -- order. A turn window can hold megabytes of tool output, and
          -- carrying it through the union and sort cost about a second.
          SELECT item_rowid, ordinal, turn_item_id, run_id, type
          FROM window_items
          WHERE ordinal >= ${boundary.ordinal}
          ORDER BY ordinal DESC, turn_item_id DESC
          -- Every LIMIT here and in latest_user_turn must stay <= tailRows, or rows below workStart go missing.
          LIMIT CASE
            WHEN ${window.rowLimit} = 0 THEN 0
            WHEN ${longTurn ? 1 : 0} = 1 THEN ${window.rowLimit}
            WHEN (SELECT row_count FROM latest_user_turn)
              BETWEEN 1 AND ${THREAD_HISTORY_PAGE_POLICY.maxTurnItems}
              THEN ${THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT}
            ELSE ${window.rowLimit}
          END
        ), retained AS MATERIALIZED (
          SELECT item_rowid, ordinal, turn_item_id FROM selected
          UNION
          SELECT request.rowid AS item_rowid, request.ordinal, request.turn_item_id
          FROM orchestration_v2_projection_turn_items AS request
          WHERE request.run_id IN (
              SELECT run_id FROM selected
              WHERE type = 'run_interrupt_result' AND run_id IS NOT NULL
            )
            AND request.type = 'run_interrupt_request'
          UNION
          SELECT latest.item_rowid, latest.ordinal, latest.turn_item_id
          FROM (
            SELECT rowid AS item_rowid, ordinal, turn_item_id
            FROM orchestration_v2_projection_turn_items
            WHERE thread_id = ${threadId}
              AND ${window.anchorItemId ?? null} IS NULL
              AND ${window.requiredRunId ?? null} IS NULL
            ORDER BY ordinal DESC, turn_item_id DESC
            LIMIT 1
          ) AS latest
          ORDER BY ordinal ASC, turn_item_id ASC
        )
      `;
    });

    // An id filter reads by primary key. `+` keeps SQLite off the thread index, which walks
    // every row of the thread to find the few ids.
    const threadColumn = (ids: ReadonlyArray<unknown> | undefined, column = "thread_id") =>
      sql.literal(ids === undefined ? column : `+${column}`);

    const turnItemMatch = (threadId: ThreadId, filter: ProjectionRecordFilter | undefined) => sql`
      ${threadColumn(filter?.turnItemNodeIds)} = ${threadId}
        ${filter?.turnItemRequestIds === undefined ? sql`` : sql`AND json_extract(payload_json, '$.requestId') IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemRequestIds)}))`}
        ${filter?.turnItemTypes === undefined ? sql`` : sql`AND type IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemTypes)}))`}
        ${filter?.turnItemStatuses === undefined ? sql`` : sql`AND status IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemStatuses)}))`}
        ${filter?.turnItemRunId === undefined ? sql`` : sql`AND run_id = ${filter.turnItemRunId}`}
        ${filter?.turnItemNodeIds === undefined ? sql`` : sql`AND node_id IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemNodeIds)}))`}
        ${filter?.turnItemRunIds === undefined ? sql`` : sql`AND (run_id IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemRunIds.filter((id): id is RunId => id !== null))})) OR (${filter.turnItemRunIds.includes(null) ? 1 : 0} = 1 AND run_id IS NULL))`}
    `;

    /** The ids of the runs whose records a new message reads. Null when nothing was compacted. */
    const runIdsSinceLastCompaction = Effect.fn("ProjectionStore.runIdsSinceLastCompaction")(
      function* (
        threadId: ThreadId,
        keep: NonNullable<ProjectionRecordFilter["sinceLastCompaction"]>,
      ) {
        // A held queue can run out of ordinal order, so a run that ended after the compaction's
        // run was requested is recent too. Every run row is read anyway, so this scan reads no
        // extra pages.
        const recent = yield* sql<{ readonly run_id: RunId }>`
          WITH compaction AS (
            SELECT run.ordinal, run.requested_at
            FROM orchestration_v2_projection_turn_items AS item
              INDEXED BY orchestration_v2_projection_turn_items_conversation_idx
            INNER JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
            WHERE item.thread_id = ${threadId}
              AND item.type = 'compaction' AND item.status = 'completed'
              AND item.type NOT IN ${CONVERSATION_INDEX_EXCLUDED_TYPES}
              AND run.status <> 'rolled_back'
            ORDER BY item.ordinal DESC
            LIMIT 1
          )
          SELECT run.run_id
          FROM compaction
          INNER JOIN orchestration_v2_projection_runs AS run ON run.thread_id = ${threadId}
          WHERE run.ordinal >= compaction.ordinal
            OR run.completed_at IS NULL
            OR run.completed_at >= compaction.requested_at
            OR run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
          UNION
          SELECT message.run_id
          FROM compaction
          INNER JOIN orchestration_v2_projection_messages AS message
            ON message.message_id = ${keep.keepMessageId}
          WHERE message.thread_id = ${threadId} AND message.run_id IS NOT NULL
        `;
        // The compaction's own run is always recent, so no rows means no compaction.
        return recent.length === 0
          ? null
          : [...recent.map((row) => row.run_id), ...keep.keepRunIds];
      },
    );

    /**
     * What a command reads of a compacted thread's prompts and errors: the failed errors of every
     * run, and the prompts of the recent runs, of fresh-context runs, and of the newest runs back
     * to the one `modelSwitchSince` measures from. That one can be older than the compaction.
     */
    const commandTurnItems = Effect.fn("ProjectionStore.commandTurnItems")(function* (
      threadId: ThreadId,
      runs: ReadonlyArray<OrchestrationV2Run>,
      recentRunIds: ReadonlyArray<RunId>,
    ) {
      const errors = yield* sql<PayloadRow>`
        SELECT payload_json
        FROM orchestration_v2_projection_turn_items
          INDEXED BY orchestration_v2_projection_turn_items_failed_error_idx
        WHERE thread_id = ${threadId} AND type = 'error' AND status = 'failed'
      `.pipe(Effect.flatMap(decodeRows(decodeTurnItemPayload, threadId)));
      const readPrompts = (runIds: ReadonlyArray<string>) =>
        sql<PayloadRow>`
          SELECT payload_json
          FROM orchestration_v2_projection_turn_items
            INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
          WHERE thread_id = ${threadId} AND type = 'user_message'
            AND run_id IN (SELECT value FROM json_each(${encodeIdList(runIds)}))
        `.pipe(Effect.flatMap(decodeRows(decodeTurnItemPayload, threadId)));
      const read = new Set<string>(recentRunIds);
      for (const run of runs) if (run.freshContext === true) read.add(run.id);
      const prompts = yield* readPrompts([...read]);
      const shownMessageIds = new Set<string>();
      const showPrompts = (items: ReadonlyArray<OrchestrationV2TurnItem>) => {
        for (const item of items) {
          if (item.type === "user_message" && isShownUserMessageItem(item)) {
            shownMessageIds.add(item.messageId);
          }
        }
      };
      showPrompts(prompts);
      const newestFirst = runs
        .filter(isModelSwitchCandidate)
        .toSorted((left, right) => (runRanAfter(left, right) ? -1 : 1));
      // The batches double, so a thread with no such run takes few queries.
      for (let start = 0, size = 1; start < newestFirst.length; start += size, size *= 2) {
        const batch = newestFirst.slice(start, start + size);
        const unread = batch.filter((run) => !read.has(run.id));
        if (unread.length > 0) {
          for (const run of unread) read.add(run.id);
          const more = yield* readPrompts(unread.map((run) => run.id));
          showPrompts(more);
          prompts.push(...more);
        }
        if (batch.some((run) => anchorsModelSwitch(run, shownMessageIds))) break;
      }
      return [...errors, ...prompts].toSorted(
        (left, right) =>
          left.ordinal - right.ordinal || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      );
    });

    const getForkSourceRunIds = Effect.fn("ProjectionStore.getForkSourceRunIds")(
      function* (threadId: ThreadId) {
        const rows = yield* sql<{ readonly run_ids: string }>`
          SELECT COALESCE(fork.fork_run_ids_json, (
            SELECT json_group_array(run.run_id)
            FROM orchestration_v2_projection_runs AS run
            WHERE run.thread_id = json_extract(fork.payload_json, '$.forkedFrom.threadId')
              AND run.ordinal <= (
                SELECT ordinal FROM orchestration_v2_projection_runs
                WHERE run_id = json_extract(fork.payload_json, '$.forkedFrom.runId')
              )
              AND NOT COALESCE(
                run.status = 'rolled_back' AND julianday(run.completed_at) < julianday(fork.created_at), 0
              )
          )) AS run_ids
          FROM orchestration_v2_projection_threads AS fork WHERE fork.thread_id = ${threadId}
        `;
        return yield* decodeForkRunIds(rows[0]?.run_ids ?? "[]");
      },
      (effect, threadId) => effect.pipe(Effect.mapError(controlReadError(threadId))),
    );

    const readCanonicalProjection = Effect.fn("ProjectionStore.readCanonicalProjection")(
      function* (
        threadId: ThreadId,
        window?: ProjectionWindow,
        fields?: ReadonlyArray<ProjectionRecordField>,
        filter?: ProjectionRecordFilter,
      ) {
        const threadRows = yield* sql<PayloadRow>`
          SELECT payload_json
          FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId}
          LIMIT 1
        `;
        const threadRow = threadRows[0];
        if (!threadRow) {
          return yield* new ProjectionStoreThreadNotFoundError({ threadId });
        }
        const recentRuns =
          window === undefined && filter?.sinceLastCompaction !== undefined
            ? yield* runIdsSinceLastCompaction(threadId, filter.sinceLastCompaction)
            : null;
        const recentRunIds = recentRuns === null ? null : encodeIdList(recentRuns);
        const readsWholeHistory =
          (fields === undefined || fields.includes("runs")) &&
          PROMPT_NARROWING_BLOCKING_FILTERS.every((key) => filter?.[key] === undefined);
        const promptRuns = readsWholeHistory ? recentRuns : null;
        const inRecentRuns = (column: string) =>
          recentRunIds === null
            ? sql``
            : sql`AND ${sql.literal(column)} IN (SELECT value FROM json_each(${recentRunIds}))`;
        // Without the hint SQLite reads every row of the thread to find the recent runs' rows.
        const recentRunIndex = (index: string) =>
          recentRunIds === null
            ? sql``
            : sql`INDEXED BY ${sql.literal(`orchestration_v2_projection_${index}`)}`;

        type WindowPayloadRow = PayloadRow & {
          readonly work_last_id?: string | null;
          readonly work_last_ordinal?: number | null;
          readonly work_item_count?: number | null;
        };
        const boundedTurnItemRows: ReadonlyArray<WindowPayloadRow> =
          (fields !== undefined && !fields.includes("turnItems")) ||
          // A compacted thread reads its items once its runs are known.
          promptRuns !== null ||
          (window === undefined &&
            matchesNothing(
              filter?.turnItemRequestIds,
              filter?.turnItemTypes,
              filter?.turnItemStatuses,
              filter?.turnItemRunIds,
              filter?.turnItemNodeIds,
            ))
            ? []
            : window === undefined
              ? yield* sql<PayloadRow>`
                SELECT payload_json
                FROM orchestration_v2_projection_turn_items
                ${
                  filter?.turnItemTypes === undefined
                    ? sql`WHERE ${turnItemMatch(threadId, filter)}`
                    : // Seeks the type index. Sorted, SQLite would walk the thread by ordinal instead.
                      sql`WHERE rowid IN (
                    SELECT rowid FROM orchestration_v2_projection_turn_items
                    WHERE ${turnItemMatch(threadId, filter)}
                  )`
                }
                ORDER BY ordinal ASC, turn_item_id ASC
              `
              : yield* sql<PayloadRow>`
                ${yield* retainedWindowRows(threadId, window)}
                -- CROSS JOIN keeps the sorted IDs as the outer loop, so SQLite
                -- skips sorting again once the payloads are attached. Carry the
                -- rowid through selection to avoid a second string-key index lookup.
                SELECT item.payload_json, tail.turn_item_id AS work_last_id,
                  deferred.last_ordinal AS work_last_ordinal, deferred.item_count AS work_item_count
                FROM retained
                CROSS JOIN orchestration_v2_projection_turn_items AS item
                  ON item.rowid = retained.item_rowid
                LEFT JOIN deferred_work deferred ON deferred.run_id = item.run_id
                  AND deferred.first_ordinal = item.ordinal
                LEFT JOIN orchestration_v2_projection_turn_items tail
                  ON tail.turn_item_id = (
                    SELECT turn_item_id FROM orchestration_v2_projection_turn_items
                    WHERE thread_id = item.thread_id AND ordinal = deferred.last_ordinal
                    ORDER BY turn_item_id DESC LIMIT 1
                  )
                ORDER BY retained.ordinal ASC, retained.turn_item_id ASC
              `;
        // Decode items once for cohort ids and projection; repeated parsing duplicates retained tool output.
        const decodedTurnItems = yield* decodeRows(
          decodeTurnItemPayload,
          threadId,
        )(boundedTurnItemRows);
        const storedTurnItems = decodedTurnItems.map((item, index) => {
          const row = boundedTurnItemRows[index]!;
          return row.work_last_id == null ||
            row.work_item_count == null ||
            row.work_last_ordinal == null
            ? item
            : {
                ...item,
                deferredWork: {
                  cursor: encodeThreadHistoryCursor({
                    snapshotSequence: 0,
                    sourceThreadId: threadId,
                    sourceItemId: TurnItemId.make(row.work_last_id),
                    position: row.work_last_ordinal,
                    inclusive: true,
                  }),
                  itemCount: row.work_item_count,
                  lastOrdinal: row.work_last_ordinal,
                },
              };
        });
        const cohortJson = (field: string) =>
          JSON.stringify(
            storedTurnItems.flatMap((payload) => {
              const value = nullableStringField(payload, field);
              return value === null ? [] : [value];
            }),
          );
        const cohortRunIds = cohortJson("runId");
        const cohortNodeIds =
          window === undefined ||
          (fields !== undefined &&
            fields.every(
              (field) => field === "runs" || field === "attempts" || field === "turnItems",
            ))
            ? cohortJson("nodeId")
            : encodeIdList(
                (yield* sql<{ readonly node_id: string }>`
            WITH RECURSIVE retained(node_id) AS (
              SELECT value FROM json_each(${cohortJson("nodeId")})
              UNION
              SELECT node_id FROM orchestration_v2_projection_nodes AS live
                ${LIVE_NODES_INDEX}
              WHERE thread_id = ${threadId} AND status IN ('pending','starting','running','waiting')
                AND NOT ${todoListOfSettledRun(sql`live`)}
              UNION
              SELECT root_node_id FROM orchestration_v2_projection_run_attempts
              WHERE thread_id = ${threadId} AND (
                status IN ('pending','starting','running','waiting')
                OR run_id IN (SELECT value FROM json_each(${cohortRunIds}))
                OR run_id = ${window.requiredRunId ?? null})
              UNION
              SELECT json_extract(payload_json, '$.rootNodeId') FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId} AND (
                status IN ('queued','preparing','starting','running','waiting')
                OR run_id IN (SELECT value FROM json_each(${cohortRunIds}))
                OR run_id = ${window.requiredRunId ?? null})
              UNION
              SELECT node_id FROM orchestration_v2_projection_runtime_requests
              WHERE thread_id = ${threadId} AND status IN ('pending','waiting')
              UNION
              SELECT parent_node_id FROM orchestration_v2_projection_subagents
              WHERE thread_id = ${threadId} AND status IN ('pending','starting','running','waiting')
              UNION
              SELECT node_id FROM orchestration_v2_projection_provider_turns
              WHERE thread_id = ${threadId} AND status IN ('starting','running','waiting')
              UNION
              SELECT parent.parent_node_id FROM orchestration_v2_projection_nodes AS parent
              INNER JOIN retained ON parent.node_id = retained.node_id
              WHERE parent.thread_id = ${threadId} AND parent.parent_node_id IS NOT NULL
            )
            -- Sort IDs before fetching bodies, so large payloads never enter
            -- SQLite's temporary sort. The node read restores this order by key.
            SELECT retained.node_id
            FROM retained
            LEFT JOIN orchestration_v2_projection_nodes AS node
              ON node.node_id = retained.node_id AND node.thread_id = ${threadId}
            WHERE retained.node_id IS NOT NULL
            ORDER BY COALESCE(node.started_at, ''), retained.node_id ASC
          `).map((row) => row.node_id),
              );
        const cohortProviderThreadIds = cohortJson("providerThreadId");
        const cohortProviderTurnIds = cohortJson("providerTurnId");
        const cohortMessageIds = cohortJson("messageId");
        const cohortPlanIds = cohortJson("planId");
        const cohortCheckpointIds = cohortJson("checkpointId");
        const cohortHandoffIds = cohortJson("contextHandoffId");
        // A newer completion must keep an older active list from resurfacing after paging.
        const [latestTodoList] =
          window === undefined ||
          (fields !== undefined &&
            !fields.some(
              (field) => field === "plans" || field === "runs" || field === "providerThreads",
            ))
            ? []
            : yield* sql<{
                readonly plan_id: string;
                readonly run_id: string;
                readonly provider_thread_id: string | null;
                readonly last_plan_id: string;
              }>`
                WITH latest_owner AS MATERIALIZED (
                  SELECT plan.plan_id, owner.run_id, owner.provider_thread_id
                  FROM orchestration_v2_projection_plans AS plan
                  INNER JOIN orchestration_v2_projection_runs AS owner
                    ON owner.thread_id = plan.thread_id AND owner.run_id = plan.run_id
                  WHERE plan.thread_id = ${threadId}
                    AND plan.kind = 'todo_list' AND plan.status <> 'superseded'
                  ORDER BY owner.ordinal DESC, plan.plan_id DESC
                  LIMIT 1
                )
                SELECT COALESCE(CASE WHEN EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_plans
                  WHERE thread_id = ${threadId} AND run_id = owner.run_id
                    AND kind = 'todo_list' AND status <> 'superseded'
                    AND plan_id <> owner.plan_id
                ) THEN (
                  -- Plan UUIDs cannot order replacements within a run.
                  SELECT plan.plan_id
                  FROM orchestration_v2_projection_turn_items AS item
                  CROSS JOIN orchestration_v2_projection_plans AS plan
                    ON plan.plan_id = json_extract(item.payload_json, '$.planId')
                  WHERE item.run_id = owner.run_id AND item.thread_id = ${threadId}
                    AND item.type = 'todo_list'
                    AND plan.run_id = owner.run_id AND plan.thread_id = ${threadId}
                    AND plan.kind = 'todo_list' AND plan.status <> 'superseded'
                  ORDER BY item.ordinal DESC
                  LIMIT 1
                ) END, owner.plan_id) AS plan_id, owner.run_id, owner.provider_thread_id,
                (
                  SELECT MAX(plan_id) FROM orchestration_v2_projection_plans
                  WHERE thread_id = ${threadId} AND run_id = owner.run_id
                ) AS last_plan_id
                FROM latest_owner AS owner
              `;

        const [
          thread,
          runRows,
          attemptRows,
          nodeRows,
          subagentRows,
          providerSessionRows,
          providerThreadRows,
          providerTurnRows,
          runtimeRequestRows,
          messageRows,
          planRows,
          checkpointScopeRows,
          checkpointRows,
          contextHandoffRows,
          contextTransferRows,
        ] = yield* Effect.all([
          decodeThreadPayload(threadRow.payload_json),
          (fields !== undefined && !fields.includes("runs")) ||
          (window === undefined &&
            (matchesNothing(filter?.runIds) ||
              (matchesNothing(filter?.runStatuses) &&
                filter?.includeLatestRun !== true &&
                filter?.includeLatestExecutedRun !== true &&
                filter?.latestRunLimit === undefined)))
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_runs
            WHERE ${threadColumn(
              filter?.latestRunLimit === undefined && filter?.includeLatestExecutedRun !== true
                ? filter?.runIds
                : [],
            )} = ${threadId}
              ${filter?.runIds === undefined ? sql`` : sql`AND run_id IN (SELECT value FROM json_each(${encodeIdList(filter.runIds)}))`}
              ${
                filter?.latestRunLimit !== undefined
                  ? sql`AND run_id IN (
                      SELECT run_id FROM (
                        SELECT run_id FROM orchestration_v2_projection_runs
                        WHERE thread_id = ${threadId}
                        ORDER BY ordinal DESC
                        LIMIT ${filter.latestRunLimit}
                      )
                      ${
                        filter.runStatuses === undefined
                          ? sql``
                          : sql`UNION
                      SELECT run_id FROM orchestration_v2_projection_runs
                      WHERE thread_id = ${threadId}
                        AND status IN (SELECT value FROM json_each(${encodeIdList(filter.runStatuses)}))`
                      }
                    )
                    ORDER BY ordinal ASC`
                  : filter?.runStatuses === undefined
                    ? sql`ORDER BY ordinal ASC`
                    : filter.includeLatestRun !== true && filter.includeLatestExecutedRun !== true
                      ? // `+ordinal` stops SQLite from walking every run in the (thread_id, ordinal)
                        // index to skip a sort; a status index reads only matching runs.
                        sql`AND status IN (SELECT value FROM json_each(${encodeIdList(filter.runStatuses)}))
                    ORDER BY +ordinal ASC`
                      : filter.includeLatestExecutedRun === true
                        ? sql`AND run_id IN (
                      SELECT run_id FROM orchestration_v2_projection_runs
                      WHERE thread_id = ${threadId}
                        AND status IN (SELECT value FROM json_each(${encodeIdList(filter.runStatuses)}))
                      UNION
                      SELECT run_id FROM (
                        SELECT run_id FROM orchestration_v2_projection_runs
                        WHERE thread_id = ${threadId}
                          AND status <> 'queued'
                          AND NOT (
                            status = 'cancelled'
                            AND json_extract(payload_json, '$.startedAt') IS NULL
                          )
                        -- latestExecutedRun: the run that ended last (runRanAfter).
                        ORDER BY completed_at IS NULL DESC, completed_at DESC, ordinal DESC,
                          run_id DESC
                        LIMIT 1
                      )
                    )
                    ORDER BY ordinal ASC`
                        : sql`AND (status IN (SELECT value FROM json_each(${encodeIdList(filter.runStatuses)}))
                    OR run_id = (
                      SELECT run_id FROM orchestration_v2_projection_runs
                      WHERE thread_id = ${threadId}
                        AND (status <> 'cancelled' OR json_extract(payload_json, '$.startedAt') IS NOT NULL)
                      ORDER BY ordinal DESC
                      LIMIT 1
                    ))
                    ORDER BY ordinal ASC`
              }
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId}
              AND (status IN ('queued','preparing','starting','running','waiting')
                OR run_id IN (SELECT value FROM json_each(${cohortRunIds}))
                OR run_id = ${window.requiredRunId ?? null}
                ${
                  // Keep the shell's latest run even when its items are outside the newest window.
                  window.anchorItemId === undefined && window.requiredRunId === undefined
                    ? sql`OR run_id = ${presentedShellRunId(sql`${threadId}`)}`
                    : sql``
                }
                -- Queued or cancelled turns must not hide the latest actual session.
                OR run_id = ${latestTodoList?.run_id ?? null}
                OR run_id = (
                  SELECT run_id FROM orchestration_v2_projection_runs
                  WHERE thread_id = ${threadId}
                    AND provider_thread_id IS NOT NULL
                    AND json_extract(payload_json, '$.startedAt') IS NOT NULL
                    AND ${latestTodoList?.plan_id ?? null} IS NOT NULL
                  ORDER BY ordinal DESC
                  LIMIT 1
                ))
            ORDER BY ordinal ASC
          `,
          (fields !== undefined && !fields.includes("attempts")) ||
          (window === undefined && matchesNothing(filter?.attemptIds))
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_run_attempts
            WHERE ${threadColumn(filter?.attemptIds)} = ${threadId}
              ${filter?.attemptIds === undefined ? sql`` : sql`AND attempt_id IN (SELECT value FROM json_each(${encodeIdList(filter.attemptIds)}))`}
              ${inRecentRuns("run_id")}
            ORDER BY run_id ASC, attempt_ordinal ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_run_attempts
            WHERE thread_id = ${threadId}
              AND (status IN ('pending','starting','running','waiting')
                OR run_id IN (SELECT value FROM json_each(${cohortRunIds})))
            ORDER BY run_id ASC, attempt_ordinal ASC
          `,
          (fields !== undefined && !fields.includes("nodes")) ||
          (window === undefined && matchesNothing(filter?.nodeIds))
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_nodes AS node
            WHERE ${
              filter?.omitSettledLeafNodes === true
                ? // Seeks the kept nodes. One filter over the thread reads every settled leaf to
                  // drop it. The first predicate must match migration 083's index expression. A
                  // node's run is always a run of its own thread, and an active run is recent.
                  sql`node.rowid IN (
                    SELECT rowid FROM orchestration_v2_projection_nodes
                      ${recentRunIndex("nodes_thread_run_idx")}
                    WHERE thread_id = ${threadId}
                      AND (kind IN ('tool_call', 'assistant_message', 'reasoning')
                        AND status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
                        AND run_id IS NOT NULL) = 0
                      ${inRecentRuns("run_id")}
                    ${
                      filter.omitSettledSubagentRecords === true
                        ? // A subagent's node shares its id. Both indexes hold every column
                          // read here, so no settled subagent or node row is fetched.
                          sql`EXCEPT
                    SELECT settled_node.rowid
                    FROM orchestration_v2_projection_subagents AS settled
                      INDEXED BY orchestration_v2_projection_subagents_thread_idx
                    CROSS JOIN orchestration_v2_projection_nodes AS settled_node
                      ON settled_node.node_id = settled.subagent_id
                    WHERE settled.thread_id = ${threadId}
                      AND settled.rowid NOT IN (${unsettledSubagentRowids(threadId)})`
                        : sql``
                    }
                    UNION ALL
                    SELECT rowid FROM orchestration_v2_projection_nodes
                    WHERE thread_id = ${threadId}
                      AND run_id IN (
                        SELECT run_id FROM orchestration_v2_projection_runs
                        WHERE thread_id = ${threadId}
                          AND status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
                      )
                      AND kind IN ('tool_call', 'assistant_message', 'reasoning')
                      AND status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
                  )`
                : sql`${threadColumn(filter?.nodeIds, "node.thread_id")} = ${threadId}
                    ${inRecentRuns("node.run_id")}`
            }
              ${filter?.nodeIds === undefined ? sql`` : sql`AND node.node_id IN (SELECT value FROM json_each(${encodeIdList(filter.nodeIds)}))`}
            ORDER BY COALESCE(node.started_at, ''), node.node_id ASC
              `
              : sql<PayloadRow & { readonly position: number }>`
            -- Keep retained IDs outermost so SQLite looks up each node by its
            -- primary key instead of scanning every historical node in the thread.
            SELECT node.payload_json, retained.key AS position
            FROM json_each(${cohortNodeIds}) AS retained
            CROSS JOIN orchestration_v2_projection_nodes AS node
              ON node.node_id = retained.value
            WHERE node.thread_id = ${threadId}
          `.pipe(
                  Effect.map((rows) =>
                    rows.toSorted((left, right) => left.position - right.position),
                  ),
                ),
          (fields !== undefined && !fields.includes("subagents")) ||
          (window === undefined &&
            matchesNothing(
              filter?.subagentIds,
              filter?.subagentRunIds,
              filter?.subagentChildThreadIds,
            ))
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_subagents AS subagent
            WHERE ${threadColumn(filter?.subagentIds ?? filter?.subagentChildThreadIds)} = ${threadId}
              ${filter?.subagentIds === undefined ? sql`` : sql`AND subagent_id IN (SELECT value FROM json_each(${encodeIdList(filter.subagentIds)}))`}
              ${filter?.subagentChildThreadIds === undefined ? sql`` : sql`AND child_thread_id IN (SELECT value FROM json_each(${encodeIdList(filter.subagentChildThreadIds)}))`}
              ${filter?.subagentRunIds === undefined ? sql`` : sql`AND run_id IN (SELECT value FROM json_each(${encodeIdList(filter.subagentRunIds)}))`}
              ${
                filter?.omitSettledSubagents === true
                  ? sql`AND subagent.rowid IN (${unsettledSubagentRowids(threadId)})`
                  : filter?.omitSettledSubagents !== undefined
                    ? sql`AND (
                      subagent_id IN (SELECT value FROM json_each(${encodeIdList(filter.omitSettledSubagents.except)}))
                      OR NOT ${settledSubagent(sql`subagent`)}
                    )`
                    : sql``
              }
            ORDER BY COALESCE(started_at, ''), subagent_id ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_subagents
            WHERE thread_id = ${threadId}
              AND (status IN ('pending','starting','running','waiting')
                OR run_id IN (SELECT value FROM json_each(${cohortRunIds}))
                OR parent_node_id IN (SELECT value FROM json_each(${cohortNodeIds})))
            ORDER BY COALESCE(started_at, ''), subagent_id ASC
          `,
          fields !== undefined && !fields.includes("providerSessions")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT sessions.payload_json
            FROM orchestration_v2_projection_provider_sessions AS sessions
            INNER JOIN orchestration_v2_projection_provider_session_bindings AS bindings
              ON bindings.provider_session_id = sessions.provider_session_id
            WHERE bindings.thread_id = ${threadId}
            ORDER BY sessions.updated_at ASC, sessions.provider_session_id ASC
          `
              : sql<PayloadRow>`
            SELECT DISTINCT sessions.payload_json
            FROM orchestration_v2_projection_provider_sessions AS sessions
            INNER JOIN orchestration_v2_projection_provider_session_bindings AS bindings
              ON bindings.provider_session_id = sessions.provider_session_id
            LEFT JOIN orchestration_v2_projection_provider_threads AS threads
              ON threads.provider_session_id = sessions.provider_session_id
            WHERE bindings.thread_id = ${threadId}
              AND (sessions.status IN ('starting','running','waiting')
                OR threads.provider_thread_id IN (SELECT value FROM json_each(${cohortProviderThreadIds})))
            ORDER BY sessions.updated_at ASC, sessions.provider_session_id ASC
          `,
          (fields !== undefined && !fields.includes("providerThreads")) ||
          (window === undefined && matchesNothing(filter?.providerThreadIds))
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_provider_threads
            WHERE ${
              filter?.omitSettledSubagentRecords === true
                ? // A dispatcher's settled tasks' provider threads belong to the child threads;
                  // only a session this thread also uses is probed when it detaches. Most rows
                  // lack an owner or session, so ANALYZE rates those indexes as matching every
                  // row and SQLite scans for an OR of them; each union branch seeks instead.
                  sql`rowid IN (
              SELECT rowid FROM orchestration_v2_projection_provider_threads
              WHERE thread_id = ${threadId}
              UNION
              SELECT rowid FROM orchestration_v2_projection_provider_threads
                INDEXED BY orchestration_v2_projection_provider_threads_owner_idx
              WHERE owner_node_id IN (${nodesOwningProviderThreads(threadId)})
              UNION
              SELECT rowid FROM orchestration_v2_projection_provider_threads
              WHERE provider_thread_id IN (
                SELECT provider_thread_id
                FROM orchestration_v2_projection_subagents
                WHERE rowid IN (${unsettledSubagentRowids(threadId)})
                  AND provider_thread_id IS NOT NULL
              )
              UNION
              SELECT rowid FROM orchestration_v2_projection_provider_threads AS shared
                INDEXED BY orchestration_v2_projection_provider_threads_session_idx
              WHERE provider_session_id IN (
                  SELECT provider_session_id
                  FROM orchestration_v2_projection_provider_session_bindings
                  WHERE thread_id = ${threadId}
                )
                AND EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_subagents AS owner
                  WHERE owner.provider_thread_id = shared.provider_thread_id
                    AND owner.thread_id = ${threadId}
                )
            )`
                : sql`(thread_id = ${threadId}
               OR owner_node_id IN (${nodesOwningProviderThreads(threadId)})
               OR provider_thread_id IN (
                 SELECT provider_thread_id
                 FROM orchestration_v2_projection_subagents
                 WHERE thread_id = ${threadId}
                   AND provider_thread_id IS NOT NULL
               ))`
            }
              ${filter?.providerThreadIds === undefined ? sql`` : sql`AND provider_thread_id IN (SELECT value FROM json_each(${encodeIdList(filter.providerThreadIds)}))`}
            ORDER BY COALESCE(first_run_ordinal, 0), provider_thread_id ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_provider_threads
            WHERE (thread_id = ${threadId} AND status = 'active')
              OR provider_thread_id IN (SELECT value FROM json_each(${cohortProviderThreadIds}))
              OR owner_node_id IN (SELECT value FROM json_each(${cohortNodeIds}))
              OR (thread_id = ${threadId}
                AND provider_thread_id = ${latestTodoList?.provider_thread_id ?? null})
            ORDER BY COALESCE(first_run_ordinal, 0), provider_thread_id ASC
          `,
          (fields !== undefined && !fields.includes("providerTurns")) ||
          (window === undefined &&
            matchesNothing(
              filter?.providerTurnIds,
              filter?.providerTurnAttemptIds,
              filter?.providerTurnThreadIds,
            ))
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_provider_turns
            WHERE ${threadColumn(filter?.providerTurnIds ?? filter?.providerTurnAttemptIds)} = ${threadId}
              ${filter?.providerTurnIds === undefined ? sql`` : sql`AND provider_turn_id IN (SELECT value FROM json_each(${encodeIdList(filter.providerTurnIds)}))`}
              ${
                recentRunIds === null
                  ? sql``
                  : sql`AND run_attempt_id IN (
                      SELECT attempt_id FROM orchestration_v2_projection_run_attempts
                      WHERE thread_id = ${threadId} ${inRecentRuns("run_id")})`
              }
              ${filter?.providerTurnAttemptIds === undefined ? sql`` : sql`AND run_attempt_id IN (SELECT value FROM json_each(${encodeIdList(filter.providerTurnAttemptIds)}))`}
              ${filter?.providerTurnThreadIds === undefined ? sql`` : sql`AND provider_thread_id IN (SELECT value FROM json_each(${encodeIdList(filter.providerTurnThreadIds)}))`}
              ${
                filter?.latestProviderTurnUsageOnly === true
                  ? sql`AND json_valid(payload_json)
            AND json_extract(payload_json, '$.tokenUsage.updatedAt') IS NOT NULL
            ORDER BY json_extract(payload_json, '$.tokenUsage.updatedAt') DESC,
              provider_thread_id ASC, ordinal ASC
            LIMIT 1`
                  : sql`ORDER BY provider_thread_id ASC, ordinal ASC`
              }
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_provider_turns
            WHERE thread_id = ${threadId}
              AND (status IN ('starting','running','waiting')
                OR provider_turn_id IN (SELECT value FROM json_each(${cohortProviderTurnIds}))
                OR node_id IN (SELECT value FROM json_each(${cohortNodeIds})))
            ORDER BY provider_thread_id ASC, ordinal ASC
          `,
          (fields !== undefined && !fields.includes("runtimeRequests")) ||
          (window === undefined && matchesNothing(filter?.runtimeRequestStatuses))
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_runtime_requests
            WHERE thread_id = ${threadId}
              ${filter?.runtimeRequestStatuses === undefined ? sql`` : sql`AND status IN (SELECT value FROM json_each(${encodeIdList(filter.runtimeRequestStatuses)}))`}
            ORDER BY created_at ASC, runtime_request_id ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_runtime_requests
            WHERE thread_id = ${threadId}
              AND (status IN ('pending','waiting')
                OR node_id IN (SELECT value FROM json_each(${cohortNodeIds}))
                OR provider_turn_id IN (SELECT value FROM json_each(${cohortProviderTurnIds})))
            ORDER BY created_at ASC, runtime_request_id ASC
          `,
          (fields !== undefined && !fields.includes("messages")) ||
          (window === undefined &&
            matchesNothing(filter?.messageIds, filter?.messageRoles, filter?.messageRunIds))
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
                SELECT payload_json FROM orchestration_v2_projection_messages
                ${recentRunIndex("messages_run_idx")}
                WHERE ${recentRunIds === null ? threadColumn(filter?.messageIds) : sql.literal("thread_id")} = ${threadId}
                  ${inRecentRuns("run_id")}
                  ${filter?.messageIds === undefined ? sql`` : sql`AND message_id IN (SELECT value FROM json_each(${encodeIdList(filter.messageIds)}))`}
                  ${filter?.messageRoles === undefined ? sql`` : sql`AND role IN (SELECT value FROM json_each(${encodeIdList(filter.messageRoles)}))`}
                  ${filter?.monitorNotificationsOnly === true ? sql`AND json_extract(payload_json, '$.notification.source.kind') = 'monitor'` : sql``}
                  ${filter?.delegatedTaskMessagesOnly === true ? sql`AND ${sql.literal(DELEGATED_TASK_MESSAGE_CONDITION)}` : sql``}
                  ${filter?.messageRunIds === undefined ? sql`` : sql`AND run_id IN (SELECT value FROM json_each(${encodeIdList(filter.messageRunIds)}))`}
                ORDER BY created_at ASC, message_id ASC
              `
              : sql<PayloadRow>`
                -- Look the window's messages up by key and the live runs' by run. One filter
                -- over the thread reads every message the thread ever had.
                SELECT payload_json FROM (
                  SELECT message.payload_json, message.created_at, message.message_id
                  FROM json_each(${cohortMessageIds}) AS wanted
                  CROSS JOIN orchestration_v2_projection_messages AS message
                    ON message.message_id = wanted.value
                  WHERE message.thread_id = ${threadId}
                  UNION
                  SELECT message.payload_json, message.created_at, message.message_id
                  FROM orchestration_v2_projection_runs AS run
                  CROSS JOIN orchestration_v2_projection_messages AS message
                    ON message.run_id = run.run_id
                  WHERE run.thread_id = ${threadId}
                    AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                    AND message.thread_id = ${threadId}
                )
                ORDER BY created_at ASC, message_id ASC
              `,
          fields !== undefined && !fields.includes("plans")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
                SELECT payload_json FROM orchestration_v2_projection_plans
                WHERE thread_id = ${threadId} ORDER BY plan_id ASC
              `
              : sql<PayloadRow>`
                SELECT payload_json FROM orchestration_v2_projection_plans AS plan
                WHERE plan.thread_id = ${threadId}
                  AND (
                    (plan.status = 'active' AND NOT ${todoListOfSettledRun(sql`plan`)})
                    OR plan.plan_id = ${latestTodoList?.plan_id ?? null}
                    OR plan.plan_id IN (
                      SELECT value FROM json_each(${cohortPlanIds})
                    )
                  )
                -- Keep the selected artifact last within its run for equal-run consumers.
                ORDER BY CASE WHEN plan_id = ${latestTodoList?.plan_id ?? null}
                  THEN ${latestTodoList?.last_plan_id ?? null} ELSE plan_id END ASC,
                  plan_id = ${latestTodoList?.plan_id ?? null} ASC
              `,
          fields !== undefined && !fields.includes("checkpointScopes")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_checkpoint_scopes
            WHERE thread_id = ${threadId}
            ORDER BY ordinal_within_parent ASC, scope_id ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes
            WHERE thread_id = ${threadId}
              AND (run_id IN (SELECT value FROM json_each(${cohortRunIds}))
                OR node_id IN (SELECT value FROM json_each(${cohortNodeIds}))
                -- A repository scope names the run that first used it; every later run's
                -- checkpoints still need its label.
                OR kind = 'manual')
            ORDER BY ordinal_within_parent ASC, scope_id ASC
          `,
          fields !== undefined && !fields.includes("checkpoints")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_checkpoints
            WHERE thread_id = ${threadId}
            ORDER BY scope_id ASC, ordinal_within_scope ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_checkpoints
            WHERE thread_id = ${threadId}
              AND (status IN ('pending','capturing')
                OR (run_id IS NULL AND ordinal_within_scope = 0 AND status = 'ready')
                -- The diff of the last finished turn stays in reach while a long run is at work.
                OR checkpoint_id = (
                  SELECT checkpoint_id FROM orchestration_v2_projection_checkpoints
                  WHERE thread_id = ${threadId} AND status = 'ready'
                    AND app_run_ordinal IS NOT NULL
                  ORDER BY app_run_ordinal DESC LIMIT 1
                )
                OR checkpoint_id IN (SELECT value FROM json_each(${cohortCheckpointIds}))
                OR run_id IN (SELECT value FROM json_each(${cohortRunIds}))
                OR node_id IN (SELECT value FROM json_each(${cohortNodeIds})))
            ORDER BY scope_id ASC, ordinal_within_scope ASC
          `,
          fields !== undefined && !fields.includes("contextHandoffs")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
                SELECT payload_json FROM orchestration_v2_projection_context_handoffs
                WHERE thread_id = ${threadId} ORDER BY rowid ASC
              `
              : sql<PayloadRow>`
                -- Megabytes on a long thread, and projectContextHandoffForWire drops both.
                SELECT json_remove(payload_json, '$.history', '$.delivery') AS payload_json
                FROM orchestration_v2_projection_context_handoffs AS handoff
                WHERE handoff.thread_id = ${threadId}
                  AND (
                    handoff.status IN ('pending', 'ready')
                    OR handoff.context_handoff_id IN (
                      SELECT value FROM json_each(${cohortHandoffIds})
                    )
                  )
                ORDER BY rowid ASC
              `,
          (fields !== undefined && !fields.includes("contextTransfers")) ||
          (window === undefined && matchesNothing(filter?.contextTransferStatuses))
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_context_transfers
            WHERE ${
              filter?.contextTransferStatuses === undefined
                ? sql`(source_thread_id = ${threadId} OR target_thread_id = ${threadId})`
                : // Each side seeks its (thread, status) index. One OR over both sides checks the
                  // status on every row the thread ever sent or received.
                  sql`rowid IN (
                    SELECT rowid FROM orchestration_v2_projection_context_transfers
                    WHERE source_thread_id = ${threadId}
                      AND status IN (SELECT value FROM json_each(${encodeIdList(filter.contextTransferStatuses)}))
                    UNION
                    SELECT rowid FROM orchestration_v2_projection_context_transfers
                    WHERE target_thread_id = ${threadId}
                      AND status IN (SELECT value FROM json_each(${encodeIdList(filter.contextTransferStatuses)}))
                  )`
            }
            ORDER BY rowid ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_context_transfers
            WHERE (source_thread_id = ${threadId} OR target_thread_id = ${threadId})
              AND (status IN ('pending','running','waiting')
                OR target_run_id IN (SELECT value FROM json_each(${cohortRunIds}))
                OR json_extract(payload_json, '$.contextHandoffId') IN
                  (SELECT value FROM json_each(${cohortHandoffIds})))
            ORDER BY rowid ASC
          `,
        ]);

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
          plans,
          checkpointScopes,
          checkpoints,
          contextHandoffs,
          contextTransfers,
        ] = yield* Effect.all([
          decodeRows(decodeRunPayload, threadId)(runRows),
          decodeRows(decodeRunAttemptPayload, threadId)(attemptRows),
          decodeRows(decodeNodePayload, threadId)(nodeRows),
          decodeRows(decodeSubagentPayload, threadId)(subagentRows),
          decodeRows(decodeProviderSessionPayload, threadId)(providerSessionRows),
          decodeRows(decodeProviderThreadPayload, threadId)(providerThreadRows),
          decodeRows(decodeProviderTurnPayload, threadId)(providerTurnRows),
          decodeRows(decodeRuntimeRequestPayload, threadId)(runtimeRequestRows),
          decodeRows(decodeMessagePayload, threadId)(messageRows),
          decodeRows(decodePlanJson, threadId)(planRows),
          decodeRows(decodeCheckpointScopePayload, threadId)(checkpointScopeRows),
          decodeRows(decodeCheckpointPayload, threadId)(checkpointRows),
          decodeRows(decodeContextHandoffPayload, threadId)(contextHandoffRows),
          decodeRows(decodeContextTransferPayload, threadId)(contextTransferRows),
        ]);
        const turnItems =
          promptRuns === null || (fields !== undefined && !fields.includes("turnItems"))
            ? storedTurnItems
            : yield* commandTurnItems(threadId, runs, promptRuns);
        const messageOrdinals = new Map<string, number>();
        // Only user items can name a user message, so a user-only read needs no assistant items.
        const userOnly = messages.every((message) => message.role === "user");
        // The loaded items already order the messages when they hold every item the lookup reads.
        const loadsEveryItemOf = (type: OrchestrationV2TurnItem["type"]) =>
          window === undefined &&
          promptRuns === null &&
          (fields === undefined || fields.includes("turnItems")) &&
          filter?.turnItemRequestIds === undefined &&
          filter?.turnItemStatuses === undefined &&
          filter?.turnItemRunId === undefined &&
          filter?.turnItemRunIds === undefined &&
          filter?.turnItemNodeIds === undefined &&
          (filter?.turnItemTypes === undefined || filter.turnItemTypes.includes(type));
        if (
          fields !== undefined &&
          fields.includes("messages") &&
          messages.length > 1 &&
          !(loadsEveryItemOf("user_message") && (userOnly || loadsEveryItemOf("assistant_message")))
        ) {
          // Broad role reads keep the original query to avoid per-ID lookup overhead.
          const loadedMessageIds =
            filter?.messageIds === undefined &&
            filter?.messageRunIds === undefined &&
            (filter?.messageRoles === undefined ||
              (filter.messageRoles.includes("user") && filter.messageRoles.includes("assistant")))
              ? undefined
              : messages.map((message) => message.id);
          // Migration 94 indexes exactly this expression, type list and json_valid term: changing
          // any, even the IN order, silently drops the index. ProjectionStore.test.ts asserts the plan.
          const rows = yield* sql<{ message_id: string; ordinal: number }>`
            SELECT json_extract(payload_json, '$.messageId') AS message_id, MIN(ordinal) AS ordinal
            FROM orchestration_v2_projection_turn_items
            WHERE thread_id = ${threadId} AND type IN ('user_message', 'assistant_message')
              AND json_valid(payload_json)
              ${loadedMessageIds === undefined ? sql`` : sql`AND json_extract(payload_json, '$.messageId') IN (SELECT value FROM json_each(${encodeIdList(loadedMessageIds)}))`}
            GROUP BY json_extract(payload_json, '$.messageId')
          `;
          for (const row of rows) messageOrdinals.set(row.message_id, row.ordinal);
        }
        const orderedMessages = sortMessagesByTurnItemOrder(messages, turnItems, messageOrdinals);
        const projection = {
          thread,
          runs,
          attempts,
          nodes,
          subagents,
          providerSessions,
          providerThreads,
          providerTurns,
          runtimeRequests,
          messages: orderedMessages,
          plans,
          turnItems,
          checkpointScopes,
          checkpoints,
          contextHandoffs,
          contextTransfers,
          visibleTurnItems: [],
          updatedAt: thread.updatedAt,
        } satisfies OrchestrationV2ThreadProjection;
        return projection;
      },
      (effect, threadId, _window?, _fields?, _filter?) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause)
              ? cause
              : new ProjectionStoreReadError({
                  threadId,
                  cause,
                }),
          ),
        ),
    );

    const readProjection: (
      threadId: ThreadId,
      seenThreadIds: ReadonlySet<ThreadId>,
      window?: ProjectionWindow,
    ) => Effect.Effect<OrchestrationV2ThreadProjection, ProjectionStoreV2Error> = Effect.fn(
      "ProjectionStore.readProjection",
    )(
      function* (
        threadId: ThreadId,
        seenThreadIds: ReadonlySet<ThreadId>,
        window?: ProjectionWindow,
      ) {
        const localWindow =
          window?.suppressLocal === true ||
          (window?.historyAnchor !== undefined && window.historyAnchor.threadId !== threadId)
            ? { ...window, rowLimit: 0, anchorItemId: undefined }
            : window;
        const projection = yield* readCanonicalProjection(
          threadId,
          localWindow,
          window !== undefined && seenThreadIds.size > 0
            ? ["runs", "attempts", "turnItems"]
            : undefined,
        );
        const forkedFrom = inheritedRunFork(projection.thread);
        if (forkedFrom === null || seenThreadIds.has(forkedFrom.threadId)) {
          return withLocalVisibleTurnItems(projection);
        }

        // Page unanchored local segments fully before inherited turns affect the boundary.
        if (
          window?.userTurnLimit !== undefined &&
          localWindow !== undefined &&
          localWindow.rowLimit > 0 &&
          projection.turnItems.length >= localWindow.rowLimit &&
          !projection.turnItems.some(isThreadHistoryUserTurn)
        ) {
          return withLocalVisibleTurnItems(projection);
        }

        const inheritedRunIds = yield* getForkSourceRunIds(threadId);
        const sourceWindow =
          window === undefined
            ? undefined
            : yield* Effect.gen(function* () {
                const historyAnchor = window.historyAnchor;
                const anchorBelongsToSource = historyAnchor?.threadId === forkedFrom.threadId;
                const rows = yield* sql<{ readonly turn_item_id: string }>`
                  WITH fork_run AS (
                    SELECT ordinal
                    FROM orchestration_v2_projection_runs
                    WHERE thread_id = ${forkedFrom.threadId}
                      AND run_id = ${forkedFrom.runId}
                    LIMIT 1
                  ), fork_boundary AS (
                    SELECT (
                      SELECT item.ordinal
                      FROM orchestration_v2_projection_turn_items AS item
                      WHERE item.run_id = run.run_id
                      ORDER BY item.ordinal DESC
                      LIMIT 1
                    ) AS ordinal
                    FROM orchestration_v2_projection_runs AS run
                    WHERE run.thread_id = ${forkedFrom.threadId}
                      AND run.ordinal <= (SELECT ordinal FROM fork_run)
                      AND EXISTS (
                        SELECT 1
                        FROM orchestration_v2_projection_turn_items AS item
                        WHERE item.run_id = run.run_id
                        LIMIT 1
                      )
                    ORDER BY run.ordinal DESC
                    LIMIT 1
                  ), effective_boundary AS (
                    SELECT COALESCE(
                      (SELECT ordinal FROM fork_boundary),
                      (
                        SELECT ordinal
                        FROM orchestration_v2_projection_turn_items
                        WHERE thread_id = ${forkedFrom.threadId}
                          AND run_id IS NULL
                          AND json_extract(payload_json, '$.historyOrigin') = 'v1_import'
                        ORDER BY ordinal DESC, turn_item_id DESC
                        LIMIT 1
                      ),
                      -1
                    ) AS ordinal
                  )
                  SELECT turn_item_id
                  FROM orchestration_v2_projection_turn_items
                  WHERE thread_id = ${forkedFrom.threadId}
                    AND ordinal <= COALESCE(
                      (SELECT ordinal FROM effective_boundary),
                      -1
                    )
                    AND (
                      ${anchorBelongsToSource ? 1 : 0} = 0
                      OR ordinal <= COALESCE(
                        (SELECT ordinal FROM orchestration_v2_projection_turn_items
                         WHERE thread_id = ${forkedFrom.threadId}
                           AND turn_item_id = ${historyAnchor?.itemId ?? null}
                         LIMIT 1),
                        (SELECT ordinal FROM effective_boundary),
                        -1
                      )
                    )
                  ORDER BY ordinal DESC, turn_item_id DESC
                  LIMIT 1
                `;
                const anchor = rows[0]?.turn_item_id;
                const anchorIsInDescendant =
                  historyAnchor !== undefined &&
                  historyAnchor.threadId !== threadId &&
                  historyAnchor.threadId !== forkedFrom.threadId;
                return {
                  rowLimit: window.rowLimit,
                  userTurnLimit: window.userTurnLimit,
                  deferWork: window.deferWork,
                  requiredRunId: forkedFrom.runId,
                  forkRunIdsJson: yield* encodeForkRunIds(inheritedRunIds),
                  suppressLocal: anchor === undefined || anchorIsInDescendant,
                  ...(anchor === undefined || anchorIsInDescendant
                    ? {}
                    : { anchorItemId: TurnItemId.make(anchor) }),
                  ...(historyAnchor === undefined || historyAnchor.threadId === threadId
                    ? {}
                    : { historyAnchor }),
                };
              });

        // Filled local pages need only the inherited count for cursor positions.
        // Run-forked parents still need the recursive read to include their ancestry.
        if (
          window?.userTurnLimit !== undefined &&
          window.historyAnchor === undefined &&
          seenThreadIds.size === 0 &&
          sourceWindow !== undefined &&
          activeLocalTurnItems(projection).filter((row) => isThreadHistoryUserTurn(row.item))
            .length >= Math.max(window.userTurnLimit, THREAD_HISTORY_PAGE_POLICY.maxUserTurns)
        ) {
          const counted = yield* sql<{ readonly inherited_rows: number | null }>`
            ${yield* retainedWindowRows(forkedFrom.threadId, {
              ...sourceWindow,
              rowLimit: sourceWindow.suppressLocal ? 0 : sourceWindow.rowLimit,
            })}
            SELECT CASE
              WHEN json_extract(source.payload_json, '$.forkedFrom.type') = 'run' THEN NULL
              WHEN NOT EXISTS (
                SELECT 1 FROM orchestration_v2_projection_runs
                WHERE thread_id = source.thread_id AND run_id = ${forkedFrom.runId}
              ) THEN 0
              ELSE (SELECT COUNT(*) FROM retained)
            END AS inherited_rows
            FROM orchestration_v2_projection_threads AS source
            WHERE source.thread_id = ${forkedFrom.threadId}
          `;
          const inheritedRowCount = counted[0]?.inherited_rows ?? null;
          if (inheritedRowCount !== null) {
            return {
              ...projection,
              visibleTurnItems: buildVisibleTurnItems({
                projection,
                sourceProjection: null,
                inheritedRowCount,
              }),
            };
          }
        }

        const sourceProjection = yield* readProjection(
          forkedFrom.threadId,
          new Set([...seenThreadIds, threadId]),
          sourceWindow,
        );
        return {
          ...projection,
          visibleTurnItems: buildVisibleTurnItems({
            projection,
            sourceProjection,
            inheritedRunIds,
          }),
        };
      },
      (effect, threadId, _seenThreadIds, _window?) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        ),
    );

    const getTurnStartContext = (threadId: ThreadId, runId: RunId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const thread = yield* getThread(threadId);
            const runs = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId} ORDER BY ordinal ASC
            `.pipe(Effect.flatMap(decodeRows(decodeRunPayload, threadId)));
            const attempts = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_run_attempts
              WHERE thread_id = ${threadId} ORDER BY run_id ASC, attempt_ordinal ASC
            `.pipe(Effect.flatMap(decodeRows(decodeRunAttemptPayload, threadId)));
            const nodes = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_nodes
              -- Look up the root node by key, not every node in the thread.
              INDEXED BY sqlite_autoindex_orchestration_v2_projection_nodes_1
              WHERE thread_id = ${threadId} AND node_id IN (SELECT json_extract(payload_json, '$.rootNodeId') FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId} AND run_id = ${runId}) ORDER BY node_id ASC
            `.pipe(Effect.flatMap(decodeRows(decodeNodePayload, threadId)));
            // Only the completed provider-native ones are routed. A long thread holds thousands of delegated ones.
            const subagents = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_subagents
              WHERE thread_id = ${threadId} AND origin = 'provider_native' AND status = 'completed' ORDER BY subagent_id ASC
            `.pipe(Effect.flatMap(decodeRows(decodeSubagentPayload, threadId)));
            const providerThreads = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_provider_threads
              WHERE thread_id = ${threadId} ORDER BY COALESCE(first_run_ordinal, 0), provider_thread_id ASC
            `.pipe(Effect.flatMap(decodeRows(decodeProviderThreadPayload, threadId)));
            const providerTurns = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_provider_turns
              WHERE thread_id = ${threadId} ORDER BY provider_thread_id ASC, ordinal ASC
            `.pipe(Effect.flatMap(decodeRows(decodeProviderTurnPayload, threadId)));
            const checkpointScopes = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes
              WHERE thread_id = ${threadId} AND scope_id IN ${sql.in(nodes.flatMap((node) => (node.checkpointScopeId === null ? [] : [node.checkpointScopeId])))} ORDER BY ordinal_within_parent ASC, scope_id ASC
            `.pipe(Effect.flatMap(decodeRows(decodeCheckpointScopePayload, threadId)));
            const contextHandoffs = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_context_handoffs
              WHERE thread_id = ${threadId} ORDER BY rowid ASC
            `.pipe(Effect.flatMap(decodeRows(decodeContextHandoffPayload, threadId)));
            // The fork into this thread and the transfers its handoffs came from, not the thousands of delegated results.
            const contextTransfers = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_context_transfers
              WHERE (target_thread_id = ${threadId} AND type = 'fork')
                OR context_transfer_id IN (
                  SELECT json_extract(payload_json, '$.transferId')
                  FROM orchestration_v2_projection_context_handoffs WHERE thread_id = ${threadId}
                )
              ORDER BY rowid ASC
            `.pipe(Effect.flatMap(decodeRows(decodeContextTransferPayload, threadId)));
            const turnItems = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_turn_items
              -- Look up one run's items by key, not by walking the thread's whole history in ordinal order.
              INDEXED BY orchestration_v2_projection_turn_items_run_ordinal_idx
              WHERE thread_id = ${threadId} AND run_id = ${runId} ORDER BY ordinal ASC, turn_item_id ASC
            `.pipe(Effect.flatMap(decodeRows(decodeTurnItemPayload, threadId)));
            const providerSessions = yield* sql<PayloadRow>`
              SELECT sessions.payload_json FROM orchestration_v2_projection_provider_sessions AS sessions
              INNER JOIN orchestration_v2_projection_provider_session_bindings AS bindings
                ON bindings.provider_session_id = sessions.provider_session_id
              WHERE bindings.thread_id = ${threadId}
              ORDER BY sessions.updated_at ASC, sessions.provider_session_id ASC
            `.pipe(Effect.flatMap(decodeRows(decodeProviderSessionPayload, threadId)));
            const run = runs.find((source) => source.id === runId);
            const unsentSource = unsentManualContinuationSource(run, {
              runs,
              attempts,
              providerTurns,
            });
            const messageIds = [run, unsentSource].flatMap((source) =>
              source === undefined ? [] : [source.userMessageId],
            );
            // Earlier slash command turns defer context too; isSlashCommandMessage narrows the match.
            const messages = yield* sql<PayloadRow>`
              SELECT payload_json FROM (
                SELECT payload_json, created_at, message_id FROM orchestration_v2_projection_messages
                WHERE thread_id = ${threadId} AND message_id IN ${sql.in(messageIds)}
                UNION
                SELECT payload_json, created_at, message_id FROM orchestration_v2_projection_messages
                WHERE thread_id = ${threadId} AND ${sql.literal(DEFERRED_COMMAND_MESSAGE_CONDITION)}
              ) ORDER BY created_at ASC, message_id ASC
            `.pipe(Effect.flatMap(decodeRows(decodeMessagePayload, threadId)));
            const conversation = yield* sql<{ present: number }>`
              SELECT EXISTS(
                SELECT 1 FROM orchestration_v2_projection_messages
                WHERE thread_id = ${threadId} AND role = 'user'
                    AND (lower(trim(json_extract(payload_json, '$.text'), ${JAVASCRIPT_TRIM_WHITESPACE})) <> '/compact'
                      OR json_array_length(payload_json, '$.attachments') > 0)
              ) AS present
            `;
            return {
              hasConversation:
                conversation[0]?.present === 1 ||
                inheritsForkConversation({ thread, contextTransfers, contextHandoffs }),
              thread,
              runs,
              attempts,
              nodes,
              subagents,
              providerSessions,
              providerThreads,
              providerTurns,
              messages,
              checkpointScopes,
              contextHandoffs,
              contextTransfers,
              turnItems,
            };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        );

    const getTurnStartHistory = Effect.fn("ProjectionStore.getTurnStartHistory")(
      function* (threadId: ThreadId, runIds?: ReadonlyArray<RunId>) {
        const rows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId}
            AND type IN ('user_message','assistant_message','command_execution','error',
              'run_interrupt_result','file_change','proposed_plan')
            AND ${runIds === undefined ? sql`1` : sql`run_id IN ${sql.in(runIds)}`}
          ORDER BY ordinal ASC, turn_item_id ASC
        `;
        return yield* decodeRows(decodeTurnItemPayload, threadId)(rows);
      },
      (effect, threadId, _runIds) =>
        effect.pipe(Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause }))),
    );

    const getThreadProjection = (threadId: ThreadId) =>
      sql
        .withTransaction(readProjection(threadId, new Set()))
        .pipe(
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        );

    const getMessageCount = (threadId: ThreadId) =>
      sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId}`.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
        Effect.mapError(controlReadError(threadId)),
      );

    // Tool output reaches the export unchanged, so the bytes of its text, also inside a structured
    // result, are a floor for the export. Other stored bytes are not: decoding drops fields. A
    // rolled back run is the only way the export hides a tool row, and rows a fork inherits only
    // add to it. The output sum parses payloads, so it runs only when the tool rows exceed `limit`.
    const getTranscriptByteFloor = (threadId: ThreadId, limit: number) =>
      sql<{ bytes: number }>`
        WITH tool_rows AS (
          SELECT payload_json FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId}
            AND type IN ('command_execution', 'dynamic_tool')
            AND (run_id IS NULL OR run_id NOT IN (
              SELECT run_id FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId} AND status = 'rolled_back'
            ))
        )
        SELECT CASE
          WHEN (SELECT COALESCE(SUM(octet_length(payload_json)), 0) FROM tool_rows) <= ${limit}
            THEN 0
          ELSE (
            -- json_valid is false past SQLite's nesting limit, where json_tree would fail.
            SELECT COALESCE(SUM(CASE WHEN json_valid(payload_json) THEN (
              SELECT COALESCE(SUM(octet_length(leaf.value)), 0)
              FROM json_tree(tool_rows.payload_json, '$.output') AS leaf
              WHERE leaf.type = 'text'
            ) ELSE 0 END), 0)
            FROM tool_rows
          )
        END AS bytes
      `.pipe(
        Effect.map((rows) => rows[0]?.bytes ?? 0),
        Effect.mapError(controlReadError(threadId)),
      );

    const getRunCount = (threadId: ThreadId) =>
      sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}`.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
        Effect.mapError(controlReadError(threadId)),
      );

    const getSubagentCount = (threadId: ThreadId) =>
      sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId}`.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
        Effect.mapError(controlReadError(threadId)),
      );

    const listAppOwnedChildThreadIds = (threadId: ThreadId) =>
      sql<{ readonly child_thread_id: string }>`SELECT child_thread_id
        FROM orchestration_v2_projection_subagents
        WHERE thread_id = ${threadId} AND origin = 'app_owned' AND child_thread_id IS NOT NULL
        ORDER BY COALESCE(started_at, ''), subagent_id ASC`.pipe(
        Effect.map((rows) => [...new Set(rows.map((row) => ThreadId.make(row.child_thread_id)))]),
        Effect.mapError(controlReadError(threadId)),
      );

    const hasPendingDelegatedCompletion = Effect.fn(
      "ProjectionStore.hasPendingDelegatedCompletion",
    )((childThreadId: ThreadId) =>
      sql`SELECT 1 FROM orchestration_v2_projection_subagents AS task
        LEFT JOIN orchestration_v2_projection_runs AS owner ON owner.run_id = task.run_id
        WHERE task.child_thread_id = ${childThreadId} AND task.origin = 'app_owned'
          AND (json_extract(task.payload_json, '$.result') IS NULL
            OR (task.completion_delivery_state = 'claimed'
              AND json_extract(owner.payload_json, '$.delegatedCompletion.disposition') = 'open'
              AND json_type(owner.payload_json, '$.delegatedCompletion.delivery') = 'object'))
        LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(controlReadError(childThreadId)),
      ),
    );

    const getNextTurnItemOrdinal = (threadId: ThreadId) =>
      sql<{ ordinal: number | null }>`SELECT MAX(ordinal) AS ordinal
        FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}`.pipe(
        Effect.map((rows) => (rows[0]?.ordinal ?? 0) + 1),
        Effect.mapError(controlReadError(threadId)),
      );

    const getTurnItem = ({
      threadId,
      itemId,
    }: {
      readonly threadId: ThreadId;
      readonly itemId: TurnItemId;
    }) =>
      sql<{ payload_json: string }>`SELECT payload_json
        FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id = ${itemId} AND thread_id = ${threadId}`.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.succeed(null)
            : decodeTurnItemPayload(rows[0].payload_json),
        ),
        Effect.mapError(controlReadError(threadId)),
      );

    // A run fork shows its source's history through the fork run without copying it, and every
    // run fork below it shows that history too. Returns the last source run live forks show, with
    // and without `leavingForkId`.
    const lastRunsShownByLiveForks = (threadId: ThreadId, leavingForkId: ThreadId) =>
      sql<{ with_fork: number | null; without_fork: number | null }>`
        WITH RECURSIVE showing(thread_id, deleted_at, through) AS (
          SELECT fork.thread_id, fork.deleted_at, fork_run.ordinal
          FROM orchestration_v2_projection_context_transfers AS transfer
          JOIN orchestration_v2_projection_threads AS fork
            ON fork.thread_id = transfer.target_thread_id
          JOIN orchestration_v2_projection_runs AS fork_run
            ON fork_run.run_id = json_extract(fork.payload_json, '$.forkedFrom.runId')
          WHERE transfer.source_thread_id = ${threadId}
            AND transfer.type = 'fork'
            AND fork_run.thread_id = ${threadId}
            AND json_extract(fork.payload_json, '$.forkedFrom.type') = 'run'
            AND json_extract(fork.payload_json, '$.forkedFrom.threadId') = ${threadId}
            AND json_extract(fork.payload_json, '$.lineage.sideChat') IS NOT 1
          UNION
          SELECT child.thread_id, child.deleted_at, showing.through
          FROM showing
          JOIN orchestration_v2_projection_context_transfers AS transfer
            ON transfer.source_thread_id = showing.thread_id AND transfer.type = 'fork'
          JOIN orchestration_v2_projection_threads AS child
            ON child.thread_id = transfer.target_thread_id
          WHERE json_extract(child.payload_json, '$.forkedFrom.type') = 'run'
            AND json_extract(child.payload_json, '$.forkedFrom.threadId') = showing.thread_id
            AND json_extract(child.payload_json, '$.lineage.sideChat') IS NOT 1
        )
        SELECT
          MAX(through) AS with_fork,
          MAX(CASE WHEN thread_id <> ${leavingForkId} THEN through END) AS without_fork
        FROM showing
        WHERE deleted_at IS NULL
      `.pipe(Effect.map((rows) => rows[0] ?? { with_fork: null, without_fork: null }));

    // A row with no run predates every run (-1), so any live fork shows it.
    const runOrdinalBetween = (runIdColumn: string, from: number, through: number) => sql`
      COALESCE((
        SELECT run.ordinal FROM orchestration_v2_projection_runs AS run
        WHERE run.run_id = ${sql.literal(runIdColumn)}
      ), -1) BETWEEN ${from} AND ${through}
    `;

    const runAttachmentIds = Effect.fn("ProjectionStore.runAttachmentIds")(function* (
      threadId: ThreadId,
      from: number,
      through: number,
    ) {
      const [messages, renders, answerFiles] = yield* Effect.all([
        sql<{ id: string }>`
      SELECT DISTINCT json_extract(attachment.value, '$.id') AS id
      FROM orchestration_v2_projection_messages AS message,
        json_each(message.payload_json, '$.attachments') AS attachment
      WHERE message.thread_id = ${threadId}
        AND ${runOrdinalBetween("message.run_id", from, through)}
    `,
        sql<{ payload_json: string }>`
      SELECT item.payload_json
      FROM orchestration_v2_projection_turn_items AS item
      WHERE item.thread_id = ${threadId}
        AND item.type = 'dynamic_tool'
        AND (item.payload_json LIKE '%htmlRender%'
          OR item.payload_json LIKE ${`%${MCP_APP_OUTPUT_KEY}%`}
          OR item.payload_json LIKE '%preview_recording_stop%')
        AND ${runOrdinalBetween("item.run_id", from, through)}
    `,
        sql<{ id: string }>`
      SELECT DISTINCT json_extract(attachment.value, '$.id') AS id
      FROM orchestration_v2_projection_turn_items AS item,
        json_each(item.payload_json, '$.questionAnswer.attachmentsByQuestionId') AS question,
        json_each(question.value) AS attachment
      WHERE item.thread_id = ${threadId}
        AND item.type = 'user_input_request'
        AND ${runOrdinalBetween("item.run_id", from, through)}
    `,
      ]);
      return [
        ...messages.map((row) => row.id),
        ...answerFiles.map((row) => row.id),
        ...threadHtmlRenderAttachmentIds(
          threadId,
          renders.map((row) => {
            const item = JSON.parse(row.payload_json) as Record<string, unknown>;
            return {
              toolName: typeof item.toolName === "string" ? item.toolName : null,
              output: item.output,
            };
          }),
        ),
      ];
    });

    const unshownRunAttachmentIds = Effect.fn("ProjectionStore.unshownRunAttachmentIds")(function* (
      threadId: ThreadId,
      from: number,
      through: number,
    ) {
      const candidates = yield* runAttachmentIds(threadId, from, through);
      if (from <= -1 || candidates.length === 0) return candidates;
      const retained = new Set(yield* runAttachmentIds(threadId, -1, from - 1));
      return candidates.filter((id) => !retained.has(id));
    });

    // Deleting a fork also frees what its deleted sources kept only for it.
    const getThreadAttachmentIds = Effect.fn("ProjectionStore.getThreadAttachmentIds")(
      function* (threadId: ThreadId, options?: { readonly includeShownByLiveFork?: boolean }) {
        const deletedSources = yield* sql<{ thread_id: ThreadId }>`
          WITH RECURSIVE source(thread_id) AS (
            SELECT json_extract(thread.payload_json, '$.forkedFrom.threadId')
            FROM orchestration_v2_projection_threads AS thread
            WHERE thread.thread_id = ${threadId}
              AND json_extract(thread.payload_json, '$.forkedFrom.type') = 'run'
              AND json_extract(thread.payload_json, '$.lineage.sideChat') IS NOT 1
            UNION
            SELECT json_extract(thread.payload_json, '$.forkedFrom.threadId')
            FROM orchestration_v2_projection_threads AS thread
            JOIN source USING (thread_id)
            WHERE thread.deleted_at IS NOT NULL
              AND json_extract(thread.payload_json, '$.forkedFrom.type') = 'run'
              AND json_extract(thread.payload_json, '$.lineage.sideChat') IS NOT 1
          )
          SELECT thread.thread_id
          FROM source
          JOIN orchestration_v2_projection_threads AS thread USING (thread_id)
          WHERE thread.deleted_at IS NOT NULL
        `;
        const afterRun = (ordinal: number | null) => (ordinal === null ? -1 : ordinal + 1);
        const own = yield* lastRunsShownByLiveForks(threadId, threadId);
        const released = yield* Effect.forEach(
          options?.includeShownByLiveFork ? [] : deletedSources,
          ({ thread_id: source }) =>
            lastRunsShownByLiveForks(source, threadId).pipe(
              Effect.flatMap((shown) =>
                shown.with_fork === null
                  ? Effect.succeed([])
                  : unshownRunAttachmentIds(source, afterRun(shown.without_fork), shown.with_fork),
              ),
            ),
        );
        // A guest's waiting files are pending uploads that no message row holds yet.
        const guestFiles = yield* sql<{ id: string }>`
          SELECT DISTINCT json_extract(attachment.value, '$.id') AS id
          FROM orchestration_v2_projection_threads AS thread,
            json_each(thread.payload_json, '$.guestShare.messages') AS message,
            json_each(message.value, '$.attachments') AS attachment
          WHERE thread.thread_id = ${threadId}
            AND json_extract(message.value, '$.status') = 'pending'
        `;
        return [
          ...new Set([
            ...(yield* unshownRunAttachmentIds(
              threadId,
              options?.includeShownByLiveFork ? -1 : afterRun(own.with_fork),
              Number.MAX_SAFE_INTEGER,
            )),
            ...guestFiles.map((row) => row.id),
            ...released.flat(),
          ]),
        ];
      },
      (effect, threadId) =>
        effect.pipe(Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause }))),
    );

    const getMessagesById = Effect.fn("ProjectionStore.getMessagesById")(
      function* (threadId: ThreadId, messageIds: ReadonlyArray<MessageId>) {
        if (messageIds.length === 0)
          return new Map<MessageId, OrchestrationV2ConversationMessage>();
        const rows = yield* sql<PayloadRow>`
          SELECT message.payload_json
          FROM json_each(${encodeIdList([...new Set(messageIds)])}) AS requested
          CROSS JOIN orchestration_v2_projection_messages AS message
            ON message.message_id = requested.value
          WHERE message.thread_id = ${threadId}
        `;
        const messages = yield* decodeRows(decodeMessagePayload, threadId)(rows);
        return new Map(messages.map((message) => [message.id, message]));
      },
      (effect, threadId) => effect.pipe(Effect.mapError(controlReadError(threadId))),
    );

    const getThreadRecords = <K extends ProjectionRecordField>(
      threadId: ThreadId,
      fields: ReadonlyArray<K>,
      filter?: ProjectionRecordFilter,
    ): Effect.Effect<ProjectionRecords<K>, ProjectionStoreV2Error> =>
      sql.withTransaction(readCanonicalProjection(threadId, undefined, fields, filter)).pipe(
        Effect.map(
          (projection) =>
            Object.fromEntries([
              ["thread", projection.thread],
              ...fields.map((field) => [field, projection[field]]),
            ]) as ProjectionRecords<K>,
        ),
        Effect.mapError(controlReadError(threadId)),
      );

    const getRunProviderRecords = Effect.fn("ProjectionStore.getRunProviderRecords")(
      function* (threadId: ThreadId, runId: RunId, nodeId: NodeId) {
        const controls = yield* getThreadRecords(threadId, ["runs", "nodes"], {
          runIds: [runId],
          nodeIds: [nodeId],
        });
        const run = controls.runs[0];
        const attemptIds = run?.activeAttemptId == null ? [] : [run.activeAttemptId];
        const records = yield* getThreadRecords(
          threadId,
          ["providerThreads", "providerTurns", "attempts"],
          {
            providerThreadIds: run?.providerThreadId == null ? [] : [run.providerThreadId],
            providerTurnAttemptIds: attemptIds,
            attemptIds,
          },
        );
        const attemptTurnId = records.attempts[0]?.providerTurnId;
        if (records.providerTurns.length > 0 || attemptTurnId == null)
          return { ...controls, ...records };
        // A steered run's attempt can point at a provider turn that another attempt started.
        const { providerTurns } = yield* getThreadRecords(threadId, ["providerTurns"], {
          providerTurnIds: [attemptTurnId],
        });
        return { ...controls, ...records, providerTurns };
      },
      (effect, threadId, _runId, _nodeId) =>
        sql.withTransaction(effect).pipe(Effect.mapError(controlReadError(threadId))),
    );

    const getRunCardRecords = Effect.fn("ProjectionStore.getRunCardRecords")(
      function* (
        threadId: ThreadId,
        runId: RunId,
        nodeId: NodeId,
        cardType: "secret_request" | "link_request",
      ) {
        const records = yield* getRunProviderRecords(threadId, runId, nodeId);
        const { turnItems } = yield* getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: [cardType],
        });
        return { ...records, turnItems };
      },
      (effect, threadId) =>
        sql.withTransaction(effect).pipe(Effect.mapError(controlReadError(threadId))),
    );

    const getThreadSnapshot = (threadId: ThreadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const projection = yield* getThreadProjection(threadId);
            // Deletion keeps the rows for surviving forks; a client reads the thread as gone.
            if (projection.thread.deletedAt !== null)
              return yield* new ProjectionStoreThreadNotFoundError({ threadId });
            const rows = yield* sql<{ readonly snapshot_sequence: number | null }>`
            SELECT MAX(sequence) AS snapshot_sequence
            FROM orchestration_events
            WHERE application_event_version = 2
              AND aggregate_kind = 'thread'
              AND stream_id = ${threadId}
          `;
            return {
              schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
              snapshotSequence: rows[0]?.snapshot_sequence ?? 0,
              projection,
            };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        );

    const readTimelineIndex: (
      threadId: ThreadId,
      seen: ReadonlySet<ThreadId>,
      includeAttempts?: boolean,
    ) => Effect.Effect<TimelineIndex, ProjectionStoreV2Error> = Effect.fn(
      "ProjectionStore.readTimelineIndex",
    )(
      function* (threadId: ThreadId, seen: ReadonlySet<ThreadId>, includeAttempts = false) {
        const records = yield* getThreadRecords(threadId, ["runs", "attempts"]);
        const rows = yield* sql<{
          turn_item_id: string;
          run_id: string | null;
          node_id: string | null;
          parent_item_id: string | null;
          type: OrchestrationV2TurnItem["type"];
          input_intent: NonNullable<TimelineIndexItem["inputIntent"]> | null;
          created_by: "user" | "agent" | "system" | null;
          message_id: string | null;
          status: OrchestrationV2TurnItem["status"];
          ordinal: number;
          attempt_id: string | null;
          attempt_status: string | null;
        }>`SELECT item.turn_item_id, item.run_id, item.node_id, item.parent_item_id, item.type, item.status, item.ordinal,
          ${includeAttempts ? sql`attempt.attempt_id` : sql`NULL`} AS attempt_id,
          ${includeAttempts ? sql`attempt.status` : sql`NULL`} AS attempt_status,
          CASE WHEN item.type = 'user_message' THEN json_extract(item.payload_json, '$.inputIntent') END AS input_intent,
          CASE WHEN item.type = 'user_message' THEN json_extract(item.payload_json, '$.createdBy') END AS created_by,
          CASE WHEN item.type IN ('user_message', 'assistant_message') THEN json_extract(item.payload_json, '$.messageId') END AS message_id
        FROM orchestration_v2_projection_turn_items AS item
        ${
          includeAttempts
            ? sql`LEFT JOIN orchestration_v2_projection_nodes AS node ON node.node_id = item.node_id
        LEFT JOIN orchestration_v2_projection_run_attempts AS attempt ON attempt.attempt_id = (
          SELECT attempt_id FROM orchestration_v2_projection_run_attempts
          WHERE run_id = item.run_id AND root_node_id = COALESCE(node.root_node_id, item.node_id)
          ORDER BY attempt_ordinal DESC LIMIT 1
        )`
            : sql``
        }
        WHERE item.thread_id = ${threadId}
        ORDER BY item.ordinal ASC, item.turn_item_id ASC`;
        const runStatuses = new Map(records.runs.map((run) => [String(run.id), run.status]));
        const items: Array<TimelineIndexItem> = rows.map((row) => ({
          id: TurnItemId.make(row.turn_item_id),
          threadId,
          runId: row.run_id === null ? null : RunId.make(row.run_id),
          nodeId: row.node_id === null ? null : NodeId.make(row.node_id),
          parentItemId: row.parent_item_id === null ? null : TurnItemId.make(row.parent_item_id),
          type: row.type,
          status: row.status,
          ordinal: row.ordinal,
          runStatus: row.run_id === null ? undefined : runStatuses.get(row.run_id),
          attemptId: row.attempt_id,
          attemptStatus: row.attempt_status,
          ...(row.input_intent === null ? {} : { inputIntent: row.input_intent }),
          ...(row.created_by === null ? {} : { createdBy: row.created_by }),
          ...(row.message_id === null ? {} : { messageId: MessageId.make(row.message_id) }),
        }));
        const local: Array<TimelineIndexRow> = items.map((item) => ({
          sourceThreadId: threadId,
          sourceItemId: item.id,
          visibility: "local",
          item,
        }));
        const isVisible = createOrchestrationV2TurnItemVisibility({
          runs: records.runs,
          attempts: records.attempts,
          items,
        });
        const visible = local.filter((row) => isVisible(row.item));
        const fork = inheritedRunFork(records.thread);
        if (fork === null || seen.has(fork.threadId))
          return { records, threadIds: [threadId], local, visible };
        const source = yield* readTimelineIndex(
          fork.threadId,
          new Set([...seen, threadId]),
          includeAttempts,
        );
        const sourceRun = source.records.runs.find((run) => run.id === fork.runId);
        let inherited: Array<TimelineIndexRow> = [];
        if (sourceRun !== undefined) {
          const ordinals = forkMemberRunOrdinals(
            source.records.runs,
            yield* getForkSourceRunIds(threadId),
          );
          const isInheritedVisible = createInheritedTurnItemVisibility({
            runs: source.records.runs,
            attempts: source.records.attempts,
            items: source.local.map((row) => row.item),
          });
          inherited = [
            ...source.visible.filter(
              (row) => row.item.threadId !== fork.threadId || row.item.type === "fork",
            ),
            ...source.local.filter(
              (row) =>
                isInheritedVisible(row.item) &&
                isTurnItemAtOrBeforeRun({
                  historyOrigin: source.records.thread.historyOrigin,
                  itemRunId: row.item.runId,
                  runOrdinalById: ordinals,
                  sourceRunOrdinal: sourceRun.ordinal,
                }),
            ),
          ].map((row) => ({ ...row, visibility: "inherited" }));
        }
        const marker = makeForkMarkerTurnItem({
          targetProjection: records,
          sourceThreadId: fork.threadId,
          sourceRunId: fork.runId,
        });
        return {
          records,
          threadIds: [threadId, ...source.threadIds],
          local,
          visible: [
            ...inherited,
            {
              sourceThreadId: fork.threadId,
              sourceItemId: marker.id,
              visibility: "synthetic" as const,
              item: marker,
              synthetic: marker,
            },
            ...visible,
          ],
        };
      },
      (effect, threadId, _seen) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        ),
    );

    // Every committed projection write appends a thread event, so the newest event across the
    // index's threads identifies its snapshot; apply also drops entries for replayed writes. Call
    // inside the read transaction. Without the index hint SQLite walks every newer V2 event.
    const latestThreadEventSequence = (threadId: ThreadId, threadIds: ReadonlyArray<ThreadId>) =>
      sql<{ sequence: number }>`SELECT COALESCE(MAX(sequence), 0) AS sequence
        FROM orchestration_events INDEXED BY idx_orchestration_events_agent_stream_sequence
        WHERE application_event_version = 2
        AND aggregate_kind = 'thread' AND stream_id IN ${sql.in(threadIds)}`.pipe(
        Effect.map((rows) => rows[0]?.sequence ?? 0),
        Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })),
      );
    const readSnapshotTimelineIndex = Effect.fn("ProjectionStore.readSnapshotTimelineIndex")(
      function* (threadId: ThreadId, includeAttempts: boolean) {
        const key = `${includeAttempts ? "work" : "plain"}:${threadId}`;
        const cached = timelineIndexes.get(key);
        const index =
          cached !== undefined &&
          (yield* latestThreadEventSequence(threadId, cached.index.threadIds)) === cached.sequence
            ? cached.index
            : yield* readTimelineIndex(threadId, new Set(), includeAttempts);
        const sequence =
          index === cached?.index
            ? cached.sequence
            : yield* latestThreadEventSequence(threadId, index.threadIds);
        timelineIndexes.delete(key);
        timelineIndexes.set(key, { sequence, index });
        const oldest = timelineIndexes.keys().next();
        if (timelineIndexes.size > TIMELINE_INDEX_CACHE_LIMIT && oldest.done !== true)
          timelineIndexes.delete(oldest.value);
        return index;
      },
    );

    const { searchThread, searchThreadStream } = yield* makeThreadFind((threadId) =>
      readTimelineIndex(threadId, new Set()).pipe(Effect.map((index) => index.visible)),
    );

    /**
     * Index columns of the thread's own turn items that `where` selects, in timeline order. The
     * same columns as `readTimelineIndex`, which reads every row and stays as it is.
     */
    const readTimelineWindow = Effect.fn("ProjectionStore.readTimelineWindow")(function* (
      threadId: ThreadId,
      includePersistentOutput: boolean,
      where: Statement.Fragment,
      limit: Statement.Fragment = sql``,
    ) {
      const rows = yield* sql<{
        turn_item_id: string;
        run_id: string | null;
        node_id: string | null;
        parent_item_id: string | null;
        type: OrchestrationV2TurnItem["type"];
        input_intent: NonNullable<TimelineIndexItem["inputIntent"]> | null;
        created_by: "user" | "agent" | "system" | null;
        message_id: string | null;
        status: OrchestrationV2TurnItem["status"];
        ordinal: number;
        persistent_output: number;
        attempt_id: string | null;
        attempt_status: string | null;
        run_status: OrchestrationV2Run["status"] | null;
      }>`SELECT item.turn_item_id, item.run_id, item.node_id, item.parent_item_id, item.type, item.status, item.ordinal,
          run.status AS run_status,
          ${includePersistentOutput ? sql`attempt.attempt_id` : sql`NULL`} AS attempt_id,
          ${includePersistentOutput ? sql`attempt.status` : sql`NULL`} AS attempt_status,
          ${includePersistentOutput ? sql`item.inline_work_output` : sql`0`} AS persistent_output,
          CASE WHEN item.type = 'user_message' THEN json_extract(item.payload_json, '$.inputIntent') END AS input_intent,
          CASE WHEN item.type = 'user_message' THEN json_extract(item.payload_json, '$.createdBy') END AS created_by,
          CASE WHEN item.type IN ('user_message', 'assistant_message') THEN json_extract(item.payload_json, '$.messageId') END AS message_id
        FROM orchestration_v2_projection_turn_items AS item
        LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
        ${
          includePersistentOutput
            ? sql`LEFT JOIN orchestration_v2_projection_nodes AS node ON node.node_id = item.node_id
        LEFT JOIN orchestration_v2_projection_run_attempts AS attempt ON attempt.attempt_id = (
          SELECT attempt_id FROM orchestration_v2_projection_run_attempts
          WHERE run_id = item.run_id AND root_node_id = COALESCE(node.root_node_id, item.node_id)
          ORDER BY attempt_ordinal DESC LIMIT 1
        )`
            : sql``
        }
        WHERE item.thread_id = ${threadId} ${where}
        ORDER BY item.ordinal ASC, item.turn_item_id ASC ${limit}`;
      return rows.map((row): TimelineIndexItem => ({
        id: TurnItemId.make(row.turn_item_id),
        threadId,
        runId: row.run_id === null ? null : RunId.make(row.run_id),
        nodeId: row.node_id === null ? null : NodeId.make(row.node_id),
        parentItemId: row.parent_item_id === null ? null : TurnItemId.make(row.parent_item_id),
        type: row.type,
        status: row.status,
        ordinal: row.ordinal,
        runStatus: row.run_status ?? undefined,
        attemptId: row.attempt_id,
        attemptStatus: row.attempt_status,
        persistentOutput: row.persistent_output === 1,
        ...(row.input_intent === null ? {} : { inputIntent: row.input_intent }),
        ...(row.created_by === null ? {} : { createdBy: row.created_by }),
        ...(row.message_id === null ? {} : { messageId: MessageId.make(row.message_id) }),
      }));
    });
    const localTimelineRow = (item: TimelineIndexItem): TimelineIndexRow => ({
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      visibility: "local",
      item,
    });

    /**
     * Reads parts of a thread's own timeline without indexing all of it. Null when callers read
     * the full index instead: the thread shows fork ancestry, so its rows come from other threads,
     * or a full index of this snapshot is cached already.
     */
    const openLocalTimeline = Effect.fn("ProjectionStore.openLocalTimeline")(function* (
      threadId: ThreadId,
      includePersistentOutput = false,
    ) {
      // A read that only the full index can answer left it cached, and it answers faster than
      // a window. The key is the one `readSnapshotTimelineIndex` uses.
      const cached = timelineIndexes.get(
        `${includePersistentOutput ? "work" : "plain"}:${threadId}`,
      );
      if (
        cached !== undefined &&
        (yield* latestThreadEventSequence(threadId, cached.index.threadIds)) === cached.sequence
      )
        return null;
      // Checked in SQL, so a fork loads no runs and no thread here before the full index does.
      const ownRowsOnly = yield* sql`
        SELECT 1 FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId}
          AND NOT (json_extract(payload_json, '$.forkedFrom.type') IS 'run'
            AND json_extract(payload_json, '$.lineage.sideChat') IS NOT 1)`;
      if (ownRowsOnly.length === 0) return null;
      const records = yield* getThreadRecords(threadId, []);
      if (inheritedRunFork(records.thread) !== null) return null;
      // Only these runs and attempts can hide rows, and their columns are all visibility reads.
      const [hidingRuns, superseded] = yield* Effect.all([
        sql<{ id: RunId; status: OrchestrationV2Run["status"] }>`
          SELECT run_id AS id, status FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId}
            AND (status IN ('rolled_back', 'queued')
              OR (status = 'cancelled' AND json_extract(payload_json, '$.startedAt') IS NULL))`,
        sql<{ runId: RunId; rootNodeId: NodeId; status: "superseded" }>`
          SELECT run_id AS runId, root_node_id AS rootNodeId, status
          FROM orchestration_v2_projection_run_attempts
          WHERE thread_id = ${threadId} AND status = 'superseded'`,
      ]);
      const stopRequests =
        superseded.length === 0
          ? []
          : yield* sql<{ run_id: string | null }>`
              SELECT DISTINCT run_id FROM orchestration_v2_projection_turn_items
              WHERE thread_id = ${threadId} AND type = 'run_interrupt_request'`;
      const isVisible = createOrchestrationV2TurnItemVisibility({
        runs: hidingRuns,
        attempts: superseded,
        items: stopRequests.map((row) => ({
          type: "run_interrupt_request" as const,
          runId: row.run_id === null ? null : RunId.make(row.run_id),
          nodeId: null,
        })),
      });
      // Only these runs can hide rows: every row of a rolled-back run, the queued turn of a
      // queued run or a cancelled one that never started, and the stop result of a replaced attempt.
      // So the hidden rows are found without reading the thread.
      const stoppedRuns = new Set(stopRequests.map((row) => row.run_id));
      const runsWithStatus = (...statuses: ReadonlyArray<OrchestrationV2Run["status"]>) =>
        hidingRuns.flatMap((run) => (statuses.includes(run.status) ? [String(run.id)] : []));
      const rolledBack = runsWithStatus("rolled_back");
      const heldInput = runsWithStatus("queued", "cancelled");
      const steered = [...new Set(superseded.map((attempt) => String(attempt.runId)))].filter(
        (runId) => !stoppedRuns.has(runId) && !rolledBack.includes(runId),
      );
      type HiddenCandidate = {
        turn_item_id: string;
        run_id: string;
        node_id: string | null;
        type: OrchestrationV2TurnItem["type"];
        ordinal: number;
        input_intent: NonNullable<TimelineIndexItem["inputIntent"]> | null;
      };
      const candidateColumns = sql`item.turn_item_id, item.run_id, item.node_id, item.type,
        item.ordinal, CASE WHEN item.type = 'user_message'
          THEN json_extract(item.payload_json, '$.inputIntent') END AS input_intent`;
      const [rolledBackRows, conversationRows] = yield* Effect.all([
        rolledBack.length === 0
          ? Effect.succeed([])
          : sql<HiddenCandidate>`
              SELECT ${candidateColumns}
              FROM json_each(${encodeIdList(rolledBack)}) AS wanted
              CROSS JOIN orchestration_v2_projection_turn_items AS item
                INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
                ON item.thread_id = ${threadId} AND item.run_id = wanted.value`,
        // The conversation index holds the type and run of these rows, so only the matches are
        // fetched. Through the run index, every row of each such run would be.
        heldInput.length + steered.length === 0
          ? Effect.succeed([])
          : sql<HiddenCandidate>`
              SELECT ${candidateColumns}
              FROM orchestration_v2_projection_turn_items AS item
                INDEXED BY orchestration_v2_projection_turn_items_conversation_idx
              WHERE item.thread_id = ${threadId}
                AND item.type NOT IN ${CONVERSATION_INDEX_EXCLUDED_TYPES}
                AND ((item.type = 'user_message'
                    AND item.run_id IN (SELECT value FROM json_each(${encodeIdList(heldInput)})))
                  OR (item.type = 'run_interrupt_result'
                    AND item.run_id IN (SELECT value FROM json_each(${encodeIdList(steered)}))))`,
      ]);
      const hidden = [...rolledBackRows, ...conversationRows].filter(
        (row) =>
          !isVisible({
            type: row.type,
            runId: RunId.make(row.run_id),
            nodeId: row.node_id === null ? null : NodeId.make(row.node_id),
            ...(row.input_intent === null ? {} : { inputIntent: row.input_intent }),
          }),
      );
      /** Counts the visible rows that sort before the given ordinal and item id. */
      const visibleBefore = Effect.fn("ProjectionStore.countVisibleTimelineRows")(function* (
        ordinal: number,
        itemId = "",
      ) {
        const rows = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND (ordinal, turn_item_id) < (${ordinal}, ${itemId})`;
        const hiddenBefore = hidden.filter(
          (row) =>
            row.ordinal < ordinal ||
            (row.ordinal === ordinal &&
              Buffer.compare(Buffer.from(row.turn_item_id), Buffer.from(itemId)) < 0),
        );
        return (rows[0]?.count ?? 0) - hiddenBefore.length;
      });
      return {
        records,
        isVisible,
        hidden,
        visibleBefore,
        read: (where: Statement.Fragment, limit?: Statement.Fragment) =>
          readTimelineWindow(threadId, includePersistentOutput, where, limit),
      };
    });
    type LocalTimeline = NonNullable<Effect.Success<ReturnType<typeof openLocalTimeline>>>;
    type IndexedTimelineRow = TimelineIndexRow & {
      readonly position: number;
      readonly canonicalPosition: number;
    };

    /** True when a visible user turn starts before the ordinal. Reads the nearest user messages. */
    const olderUserTurn = (local: LocalTimeline, ordinal: number) =>
      sql<{
        run_id: string | null;
        node_id: string | null;
        input_intent: NonNullable<TimelineIndexItem["inputIntent"]>;
      }>`
        SELECT item.run_id, item.node_id,
          json_extract(item.payload_json, '$.inputIntent') AS input_intent
        FROM orchestration_v2_projection_turn_items AS item
          INDEXED BY orchestration_v2_projection_turn_items_user_message_idx
        WHERE item.thread_id = ${local.records.thread.id} AND item.type = 'user_message'
          AND item.ordinal < ${ordinal}
          AND json_extract(item.payload_json, '$.inputIntent') IN ('turn_start', 'queued_turn')
          AND json_extract(item.payload_json, '$.createdBy') = 'user'
        ORDER BY item.ordinal DESC, item.turn_item_id DESC
        LIMIT ${local.hidden.length + 1}`.pipe(
        Effect.map((rows) =>
          rows.some((row) =>
            local.isVisible({
              type: "user_message",
              runId: row.run_id === null ? null : RunId.make(row.run_id),
              nodeId: row.node_id === null ? null : NodeId.make(row.node_id),
              inputIntent: row.input_intent,
            }),
          ),
        ),
      );

    /**
     * A notification starts a turn only as its run's first input. For each run whose first input
     * in `rows` is a notification, this finds whether an input row sits before the ordinal.
     */
    const runsStartedBefore = Effect.fn("ProjectionStore.runsStartedBefore")(function* (
      local: LocalTimeline,
      ordinal: number,
      rows: ReadonlyArray<TimelineIndexRow>,
    ) {
      const seen = new Set<string>();
      const unknown = new Set<string>();
      for (const { item } of rows) {
        if (item.runId === null) continue;
        if (item.type !== "user_message" && item.type !== "notification") continue;
        if (item.type === "notification" && !seen.has(item.runId)) unknown.add(item.runId);
        seen.add(item.runId);
      }
      if (unknown.size === 0) return new Set<string>();
      const counts = yield* sql<{ run_id: string; inputs: number }>`
        SELECT wanted.value AS run_id, (
          SELECT COUNT(*) FROM orchestration_v2_projection_turn_items AS input
            INDEXED BY orchestration_v2_projection_turn_items_conversation_idx
          WHERE input.thread_id = ${local.records.thread.id}
            AND input.ordinal >= (
              SELECT MIN(ordinal) FROM orchestration_v2_projection_turn_items
              WHERE run_id = wanted.value
            )
            AND input.ordinal < ${ordinal}
            AND input.type NOT IN ${CONVERSATION_INDEX_EXCLUDED_TYPES}
            AND input.type IN ('user_message', 'notification')
            AND input.run_id = wanted.value
        ) AS inputs
        FROM json_each(${encodeIdList([...unknown])}) AS wanted`;
      const isHiddenInput = (row: LocalTimeline["hidden"][number], runId: string) =>
        row.run_id === runId &&
        row.ordinal < ordinal &&
        (row.type === "user_message" || row.type === "notification");
      return new Set(
        counts.flatMap((row) =>
          row.inputs > local.hidden.filter((hidden) => isHiddenInput(hidden, row.run_id)).length
            ? [row.run_id]
            : [],
        ),
      );
    });

    /**
     * Selects an older history page from the rows near its cursor. The window grows until the
     * page ends inside rows whose inputs are all known, so `select` gives the page it gives on
     * the full index. Null when the cursor names no visible row, which needs the full index.
     */
    const selectHistoryPageInWindow = Effect.fn("ProjectionStore.selectHistoryPageInWindow")(
      function* <
        Selection extends {
          readonly page: SelectTimelinePageResult<IndexedTimelineRow>;
          readonly historyItems: ReadonlyArray<IndexedTimelineRow>;
        },
      >(
        local: LocalTimeline,
        input: {
          readonly cursor: string;
          readonly throughEntryId: string | undefined;
          readonly workMode: "deferred" | "work" | undefined;
        },
        select: (
          indexed: ReadonlyArray<IndexedTimelineRow>,
          prefix?: ThreadHistoryPrefix,
        ) => Effect.Effect<Selection, ProjectionStoreV2Error>,
      ) {
        const threadId = local.records.thread.id;
        const decoded = Result.try(() => decodeThreadHistoryCursor(input.cursor));
        if (Result.isFailure(decoded) || decoded.success.st !== threadId) return null;
        const cursor = decoded.success;
        // Looked up by key alone: with the thread in the query, SQLite scans the thread's index.
        const ends = (yield* sql<{ turn_item_id: string; thread_id: string; ordinal: number }>`
          SELECT turn_item_id, thread_id, ordinal FROM orchestration_v2_projection_turn_items
          WHERE turn_item_id IN (${cursor.si}, ${input.throughEntryId ?? cursor.si})`).filter(
          (row) => row.thread_id === threadId,
        );
        const upper = ends.find((row) => row.turn_item_id === cursor.si)?.ordinal;
        if (upper === undefined) return null;
        /* Runs for each window this operation tries; the operation owns the span. */
        const indexFrom = Effect.fnUntraced(function* (
          items: ReadonlyArray<TimelineIndexItem>,
          from: number | null,
        ) {
          const base = from === null ? 0 : yield* local.visibleBefore(from);
          return items.filter(local.isVisible).map((item, offset): IndexedTimelineRow => ({
            ...localTimelineRow(item),
            position: base + offset,
            canonicalPosition: base + offset,
          }));
        });
        const isCursorRow = (row: TimelineIndexRow) => row.sourceItemId === cursor.si;
        // The ordinals come from the stop request index, so this does not walk the thread.
        const interruptRequests = local
          .read(
            sql`AND item.type = 'run_interrupt_request' AND item.ordinal IN (
              SELECT ordinal FROM orchestration_v2_projection_turn_items
                INDEXED BY orchestration_v2_projection_turn_items_stop_request_idx
              WHERE thread_id = ${threadId} AND type = 'run_interrupt_request')`,
          )
          .pipe(Effect.flatMap((items) => indexFrom(items, null)));

        if (input.workMode === "work") {
          // A work group lies between its first row and the cursor, so that range is the read.
          const lower = ends.find((row) => row.turn_item_id === input.throughEntryId)?.ordinal;
          if (lower === undefined) return null;
          const indexed = yield* indexFrom(
            yield* local.read(sql`AND item.ordinal >= ${lower} AND item.ordinal <= ${upper}`),
            lower,
          );
          if (!indexed.some(isCursorRow)) return null;
          if (!indexed.some((row) => row.sourceItemId === input.throughEntryId)) return null;
          return {
            indexed,
            selection: yield* select(indexed),
            olderUserTurn: olderUserTurn(local, lower),
            interruptRequests,
          };
        }

        const rowsBelow = (ordinal: number, count: number) =>
          sql<{ ordinal: number }>`
            SELECT ordinal FROM orchestration_v2_projection_turn_items
            WHERE thread_id = ${threadId} AND ordinal < ${ordinal}
            ORDER BY ordinal DESC LIMIT 1 OFFSET ${count - 1}`.pipe(
            Effect.map((rows) => rows[0]?.ordinal ?? null),
          );
        // `trusted` is the lowest ordinal the page may reach. `lower` can sit below it, because
        // a run that folds work is read whole.
        let step = THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT;
        let trusted = yield* rowsBelow(upper, step);
        let lower = trusted;
        let higher = upper;
        let items = yield* local.read(
          lower === null
            ? sql`AND item.ordinal <= ${upper}`
            : sql`AND item.ordinal >= ${lower} AND item.ordinal <= ${upper}`,
        );
        const wholeRuns = new Set<string>();
        while (true) {
          if (input.workMode === "deferred") {
            // Folding needs every row of a run: its stop and error rows, and its group sizes.
            const folding = new Set<string>();
            for (const item of items) {
              if (item.runId === null || wholeRuns.has(item.runId)) continue;
              if (item.ordinal > upper || (trusted !== null && item.ordinal < trusted)) continue;
              if (isFoldableWorkItem(item) && local.isVisible(item)) folding.add(item.runId);
            }
            if (folding.size > 0) {
              const runs = encodeIdList([...folding]);
              const [extent] = yield* sql<{ lower: number; higher: number }>`
                SELECT MIN(run.lower) AS lower, MAX(run.higher) AS higher FROM (
                  SELECT
                    (SELECT MIN(ordinal) FROM orchestration_v2_projection_turn_items
                      WHERE run_id = wanted.value) AS lower,
                    (SELECT MAX(ordinal) FROM orchestration_v2_projection_turn_items
                      WHERE run_id = wanted.value) AS higher
                  FROM json_each(${runs}) AS wanted
                ) AS run`;
              if (extent !== undefined && lower !== null && extent.lower < lower) {
                const below = yield* local.read(
                  sql`AND item.ordinal >= ${extent.lower} AND item.ordinal < ${lower}`,
                );
                items = below.concat(items);
                lower = extent.lower;
              }
              if (extent !== undefined && extent.higher > higher) {
                const newer = yield* local.read(
                  sql`AND item.ordinal > ${higher} AND item.ordinal <= ${extent.higher}`,
                );
                items = items.concat(newer);
                higher = extent.higher;
              }
              for (const runId of folding) wholeRuns.add(runId);
            }
          }
          const indexed = yield* indexFrom(items, lower);
          const end = indexed.findIndex(isCursorRow);
          if (end < 0) return null;
          const older = lower === null ? Effect.succeed(false) : olderUserTurn(local, lower);
          const prefix: ThreadHistoryPrefix | undefined =
            lower === null
              ? undefined
              : {
                  hasUserTurn: indexed
                    .slice(0, end)
                    .some((row) => isThreadHistoryUserTurn(row.item))
                    ? false
                    : yield* older,
                  startedRuns: yield* runsStartedBefore(local, lower, indexed),
                };
          const selection = yield* select(indexed, prefix);
          // Without its row the cursor falls back to a position, which only the full index has.
          if (!selection.historyItems.some(isCursorRow)) return null;
          const oldest = selection.page.oldestScanned;
          if (
            lower === null ||
            (trusted !== null &&
              oldest !== undefined &&
              oldest !== selection.historyItems[0] &&
              oldest.item.ordinal >= trusted)
          ) {
            return { indexed, selection, olderUserTurn: older, interruptRequests };
          }
          step *= 2;
          trusted = trusted === null ? null : yield* rowsBelow(trusted, step);
          if (trusted === null || trusted < lower) {
            const below = yield* local.read(
              trusted === null
                ? sql`AND item.ordinal < ${lower}`
                : sql`AND item.ordinal >= ${trusted} AND item.ordinal < ${lower}`,
            );
            items = below.concat(items);
            lower = trusted;
          }
        }
      },
    );

    const getThreadHistoryPage = (
      threadId: ThreadId,
      cursor: string,
      throughEntryId?: string,
      conversationOnly?: boolean,
      workMode?: "deferred" | "work",
    ): Effect.Effect<OrchestrationV2ThreadHistoryPage, ProjectionStoreV2Error> =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const withWork = workMode !== undefined;
            // A jump to a target entry selects from the whole index.
            const local =
              (workMode === "work") === (throughEntryId !== undefined)
                ? yield* openLocalTimeline(threadId, withWork)
                : null;
            const full =
              local === null ? yield* readSnapshotTimelineIndex(threadId, withWork) : null;
            if ((local ?? full)?.records.thread.deletedAt !== null)
              return yield* new ProjectionStoreThreadNotFoundError({ threadId });
            const revisions = yield* sql<{
              sequence: number;
            }>`SELECT COALESCE(MAX(sequence), 0) AS sequence
          FROM orchestration_events WHERE application_event_version = 2
          AND aggregate_kind = 'thread' AND stream_id = ${threadId}`;
            const snapshotSequence = revisions[0]?.sequence ?? 0;
            const select = (
              indexed: ReadonlyArray<IndexedTimelineRow>,
              prefix?: ThreadHistoryPrefix,
            ) =>
              Effect.try({
                try: () => {
                  const historyItems =
                    workMode === "deferred" ? deferWorkHistoryRows(indexed) : indexed;
                  const policy = olderHistoryPagePolicy({ items: indexed, cursor, throughEntryId });
                  // Folding can hide the cursor's row: a snapshot folds no work in a thread with no
                  // user turn. The page then ends at the first row kept from the cursor on.
                  const cursorRow =
                    indexed[findCursorEndIndex(indexed, decodeThreadHistoryCursor(cursor))];
                  const end =
                    cursorRow === undefined
                      ? -1
                      : historyItems.findIndex(
                          (row) => row.canonicalPosition >= cursorRow.canonicalPosition,
                        );
                  const page =
                    workMode === "work"
                      ? selectDeferredWorkPage({
                          items: indexed,
                          cursor,
                          throughEntryId,
                          snapshotSequence,
                          rowEncodedBytes: () => 0,
                        })
                      : selectHistoryPageFromCursor({
                          items: historyItems,
                          cursor,
                          exclusiveEndIndex: end === -1 ? historyItems.length : end,
                          snapshotSequence,
                          rowEncodedBytes: () => 0,
                          policy,
                          prefix,
                        });
                  return { policy, page, historyItems };
                },
                catch: (cause) => new ProjectionStoreReadError({ threadId, cause }),
              });
            const window =
              local === null
                ? null
                : yield* selectHistoryPageInWindow(
                    local,
                    { cursor, throughEntryId, workMode },
                    select,
                  );
            const whole = Effect.gen(function* () {
              const index = full ?? (yield* readSnapshotTimelineIndex(threadId, withWork));
              const indexed = index.visible.map((row, position): IndexedTimelineRow => ({
                ...row,
                position,
                canonicalPosition: position,
              }));
              let selection = yield* select(indexed);
              // The full index does not say which rows hold inline output: finding it scans
              // payloads, which costs a whole long thread several seconds. Scan only the runs
              // the page spans, then select again with what they hold.
              const scannedRuns = new Set<string>();
              const persistentOutputs = new Set<string>();
              // Rows hidden in a work group move the page, so the scan always reaches the
              // cursor's own row, or the row its stale position falls back to.
              const cursorPosition =
                workMode === undefined
                  ? -1
                  : Math.min(
                      findCursorEndIndex(indexed, decodeThreadHistoryCursor(cursor)),
                      indexed.length - 1,
                    );
              while (workMode !== undefined) {
                const { page } = selection;
                const span = [...page.items.slice(0, 1), ...page.items.slice(-1)].map(
                  (row) => row.canonicalPosition,
                );
                if (cursorPosition >= 0) span.push(cursorPosition);
                if (span.length === 0) break;
                const runs = new Map(
                  // A work page holds rows of one run, which can be the rows that have no run.
                  (workMode === "work"
                    ? page.items.slice(0, 1)
                    : indexed.slice(Math.min(...span), Math.max(...span) + 1)
                  ).flatMap(({ sourceThreadId, item }) =>
                    (workMode === "work" ||
                      (item.runId !== null &&
                        (item.runStatus === "completed" || item.attemptStatus === "superseded"))) &&
                    !scannedRuns.has(`${sourceThreadId}:${item.runId}`)
                      ? [
                          [
                            `${sourceThreadId}:${item.runId}`,
                            { threadId: sourceThreadId, id: item.runId },
                          ] as const,
                        ]
                      : [],
                  ),
                );
                if (runs.size === 0) break;
                for (const run of runs.keys()) scannedRuns.add(run);
                const found = yield* sql<{ thread_id: string; turn_item_id: string }>`
          SELECT item.thread_id, item.turn_item_id
          FROM json_each(${yield* encodeTimelineSources([...runs.values()])}) AS wanted
          CROSS JOIN orchestration_v2_projection_turn_items AS item
            ON item.thread_id = json_extract(wanted.value, '$.threadId')
            AND item.run_id IS json_extract(wanted.value, '$.id')
          WHERE item.status = 'completed' AND item.inline_work_output = 1`;
                if (found.length === 0) break;
                for (const row of found)
                  persistentOutputs.add(`${row.thread_id}:${row.turn_item_id}`);
                selection = yield* select(
                  indexed.map((row) =>
                    persistentOutputs.has(`${row.sourceThreadId}:${row.sourceItemId}`)
                      ? { ...row, item: { ...row.item, persistentOutput: true } }
                      : row,
                  ),
                );
              }
              return {
                indexed,
                selection,
                olderUserTurn: Effect.succeed(false),
                interruptRequests: Effect.succeed(indexed),
              };
            });
            const { indexed, selection, olderUserTurn, interruptRequests } =
              window ?? (yield* whole);
            const { page } = selection;
            const policy = workMode === "work" ? THREAD_HISTORY_PAGE_POLICY : selection.policy;
            const end = (page.items.at(-1)?.canonicalPosition ?? -1) + 1;
            const hasUserTurns =
              conversationOnly === true &&
              (indexed.some(
                (row) => row.canonicalPosition < end && isThreadHistoryUserTurn(row.item),
              ) ||
                (yield* olderUserTurn));
            const materialize = Effect.fn("ProjectionStore.materializeHistoryRows")(function* (
              rows: ReadonlyArray<IndexedTimelineRow>,
            ) {
              if (rows.length === 0) return [];
              const sources = yield* encodeTimelineSources(
                rows
                  .filter((row) => !row.synthetic)
                  .map((row) => ({ threadId: row.sourceThreadId, id: row.sourceItemId })),
              );
              const payloads = yield* sql<{
                thread_id: string;
                turn_item_id: string;
                payload_json: string;
              }>`
          SELECT item.thread_id, item.turn_item_id, item.payload_json
          FROM orchestration_v2_projection_turn_items item JOIN json_each(${sources}) wanted
          ON item.thread_id = json_extract(wanted.value, '$.threadId')
            AND item.turn_item_id = json_extract(wanted.value, '$.id')`;
              const byIdentity = new Map(
                payloads.map((row) => [`${row.thread_id}:${row.turn_item_id}`, row.payload_json]),
              );
              return yield* Effect.forEach(rows, (row) =>
                Effect.gen(function* () {
                  const payload = byIdentity.get(`${row.sourceThreadId}:${row.sourceItemId}`);
                  const item =
                    row.synthetic ??
                    (payload === undefined
                      ? yield* new ProjectionStoreReadError({ threadId })
                      : yield* decodeTurnItemPayload(payload));
                  return {
                    position: row.canonicalPosition,
                    visibility: row.visibility,
                    sourceThreadId: row.sourceThreadId,
                    sourceItemId: row.sourceItemId,
                    item: projectTurnItemForWire(
                      row.item.deferredWork === undefined
                        ? item
                        : { ...item, deferredWork: row.item.deferredWork },
                    ),
                  };
                }),
              );
            });
            const items = yield* materialize(
              hasUserTurns
                ? page.items.filter((row) => isConversationHistoryItem(row.item))
                : page.items,
            );
            const bounded = selectRecentTimelineWindow({ items, snapshotSequence, policy });
            const requests =
              workMode === "work"
                ? []
                : yield* materialize(
                    missingInterruptRequests(
                      bounded.items.some((row) => row.item.type === "run_interrupt_result")
                        ? yield* interruptRequests
                        : [],
                      bounded.items,
                    ),
                  );
            const pageItems = [...requests, ...bounded.items].map((row, position) => ({
              ...row,
              position,
            }));
            const rows = conversationOnly
              ? pageItems.filter((row) => isConversationHistoryItem(row.item))
              : pageItems;
            // A bounded snapshot keeps only recent or active subagents.
            const subagentIds = rows.flatMap(({ sourceThreadId, item }) =>
              item.type === "subagent" && sourceThreadId === threadId ? [item.subagentId] : [],
            );
            const subagents =
              subagentIds.length === 0
                ? []
                : yield* sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_subagents
            WHERE thread_id = ${threadId}
              AND subagent_id IN (SELECT value FROM json_each(${encodeIdList(subagentIds)}))
            ORDER BY COALESCE(started_at, ''), subagent_id ASC
          `.pipe(Effect.flatMap(decodeRows(decodeSubagentPayload, threadId)));
            return {
              snapshotSequence,
              items: rows,
              nextCursor: bounded.hasMoreHistory ? bounded.nextCursor : page.nextCursor,
              hasMoreHistory: bounded.hasMoreHistory || page.hasMoreHistory,
              ...(subagents.length === 0 ? {} : { subagents }),
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    /**
     * The rows `getTimelinePage` matches, cut after the first `limit + 1`, with their positions
     * in the full visible index. Reads only the rows from the start position to the page end.
     */
    const matchLocalTimelineRows = Effect.fn("ProjectionStore.matchLocalTimelineRows")(function* (
      local: LocalTimeline,
      options: ProjectionTimelinePageOptions,
      totalItems: number,
    ) {
      const threadId = local.records.thread.id;
      if (options.itemId !== undefined) {
        const found = (yield* local.read(sql`AND item.turn_item_id = ${options.itemId}`)).filter(
          local.isVisible,
        );
        const matching = yield* Effect.forEach(found, (item) =>
          local
            .visibleBefore(item.ordinal, item.id)
            .pipe(Effect.map((position) => ({ ...localTimelineRow(item), position }))),
        );
        return { matching, totalItems, hasEarlier: false };
      }
      const afterPosition = options.afterPosition ?? -1;
      const firstPosition = Math.max(afterPosition + 1, 0);
      // The row at this raw offset sorts at or before the first wanted row: hidden rows only
      // push visible rows to later offsets.
      const starts = yield* sql<{ ordinal: number }>`
        SELECT ordinal FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId}
        ORDER BY ordinal ASC, turn_item_id ASC LIMIT 1 OFFSET ${firstPosition}`;
      const start = starts[0]?.ordinal;
      if (start === undefined) return { matching: [], totalItems, hasEarlier: false };
      const base = yield* local.visibleBefore(start);
      const hiddenAfter = local.hidden.filter((row) => row.ordinal >= start).length;
      const messagesOnly = options.view !== "activity";
      const candidates = (yield* local.read(
        messagesOnly
          ? sql`AND item.ordinal >= ${start}
              AND item.type IN ('user_message', 'assistant_message', 'proposed_plan')`
          : sql`AND item.ordinal >= ${start}`,
        sql`LIMIT ${firstPosition - base + Math.min(options.limit, totalItems) + 1 + hiddenAfter}`,
      )).filter(local.isVisible);
      const positions = new Map<string, number>();
      const last = candidates.at(-1);
      if (messagesOnly && last !== undefined) {
        const hiddenIds = new Set(local.hidden.map((row) => row.turn_item_id));
        const span = yield* sql<{ turn_item_id: string }>`
          SELECT turn_item_id FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND ordinal >= ${start} AND ordinal <= ${last.ordinal}
          ORDER BY ordinal ASC, turn_item_id ASC`;
        for (const row of span) {
          if (!hiddenIds.has(row.turn_item_id))
            positions.set(row.turn_item_id, base + positions.size);
        }
      }
      const rows = candidates.map((item, offset) => ({
        ...localTimelineRow(item),
        position: messagesOnly ? (positions.get(item.id) ?? -1) : base + offset,
      }));
      const matching = rows.filter((row) => row.position > afterPosition);
      // At most `hidden.length` of the first matches before the start are hidden.
      const hasEarlier =
        matching.length < rows.length ||
        (base > 0 &&
          (!messagesOnly ||
            (yield* local.read(
              sql`AND item.ordinal < ${start}
                AND item.type IN ('user_message', 'assistant_message', 'proposed_plan')`,
              sql`LIMIT ${local.hidden.length + 1}`,
            )).some(local.isVisible)));
      return { matching, totalItems, hasEarlier };
    });

    /**
     * A `getTimelinePage` page from `matchLocalTimelineRows`. A backward page reads forward from
     * ever earlier starts until it holds `limit` matches or reaches `afterPosition`.
     */
    const readLocalTimelinePage = Effect.fn("ProjectionStore.readLocalTimelinePage")(function* (
      local: LocalTimeline,
      options: ProjectionTimelinePageOptions,
    ) {
      const totals = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${local.records.thread.id}`;
      const totalItems = (totals[0]?.count ?? 0) - local.hidden.length;
      if (options.beforePosition === undefined || options.itemId !== undefined) {
        const { matching, hasEarlier } = yield* matchLocalTimelineRows(local, options, totalItems);
        return {
          page: matching.slice(0, options.limit),
          totalItems,
          hasMore: matching.length > options.limit,
          hasEarlier,
        };
      }
      const afterPosition = options.afterPosition ?? -1;
      const end = Math.min(options.beforePosition, totalItems);
      let span = Math.max(options.limit, 1);
      while (true) {
        // The `span` positions before `end` hold at most `span` matches, so a forward read of
        // `span + 1` from the start holds all of them and shows whether any follow.
        const from = Math.max(afterPosition, end - span - 1);
        const read = yield* matchLocalTimelineRows(
          local,
          { ...options, afterPosition: from, limit: span },
          totalItems,
        );
        const before = read.matching.filter((row) => row.position < end);
        if (before.length >= options.limit || from === afterPosition) {
          const page = before.slice(Math.max(0, before.length - options.limit));
          return {
            page,
            totalItems,
            hasMore: read.matching.length > before.length,
            hasEarlier: read.hasEarlier || before.length > page.length,
          };
        }
        span *= 2;
      }
    });

    const getTimelinePage = (
      threadId: ThreadId,
      options: ProjectionTimelinePageOptions,
    ): Effect.Effect<ProjectionTimelinePage, ProjectionStoreV2Error> =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const local =
              options.attachmentId === undefined &&
              Number.isSafeInteger(options.limit) &&
              options.limit >= 0 &&
              Number.isSafeInteger(options.afterPosition ?? -1) &&
              (options.beforePosition === undefined ||
                options.beforePosition === Number.POSITIVE_INFINITY ||
                Number.isSafeInteger(options.beforePosition))
                ? yield* openLocalTimeline(threadId)
                : null;
            const whole = Effect.gen(function* () {
              const index = yield* readSnapshotTimelineIndex(threadId, false);
              const attachmentOwners =
                options.attachmentId === undefined
                  ? undefined
                  : new Set(
                      (yield* sql<{ thread_id: string; turn_item_id: string }>`
          SELECT item.thread_id, item.turn_item_id
          FROM orchestration_v2_projection_turn_items AS item,
            json_each(item.payload_json, '$.attachments') AS attachment
          WHERE item.thread_id IN ${sql.in([...new Set(index.visible.map((row) => row.sourceThreadId))])}
            AND item.type = 'user_message'
            AND json_extract(attachment.value, '$.id') = ${options.attachmentId}`).map(
                        (row) => `${row.thread_id}:${row.turn_item_id}`,
                      ),
                    );
              const inView = index.visible
                .map((row, position) => ({ ...row, position }))
                .filter((row) =>
                  options.itemId === undefined
                    ? options.view === "activity" ||
                      ["user_message", "assistant_message", "proposed_plan"].includes(row.item.type)
                    : row.sourceItemId === options.itemId,
                )
                .filter(
                  (row) =>
                    attachmentOwners?.has(`${row.sourceThreadId}:${row.sourceItemId}`) ?? true,
                );
              const before = options.beforePosition ?? Number.POSITIVE_INFINITY;
              const matching =
                options.itemId === undefined
                  ? inView.filter(
                      (row) =>
                        row.position > (options.afterPosition ?? -1) && row.position < before,
                    )
                  : inView;
              const page =
                options.beforePosition === undefined
                  ? matching.slice(0, options.limit)
                  : matching.slice(Math.max(0, matching.length - options.limit));
              const pageStart = page[0]?.position ?? (options.afterPosition ?? -1) + 1;
              return {
                page,
                totalItems: index.visible.length,
                hasMore:
                  options.beforePosition === undefined
                    ? matching.length > page.length
                    : (inView.at(-1)?.position ?? -1) >= before,
                hasEarlier: (inView[0]?.position ?? Number.POSITIVE_INFINITY) < pageStart,
              };
            });
            const { page, totalItems, hasMore, hasEarlier } =
              local === null ? yield* whole : yield* readLocalTimelinePage(local, options);
            const sources = yield* encodeTimelineSources(
              page
                .filter((row) => row.synthetic === undefined)
                .map((row) => ({ threadId: row.sourceThreadId, id: row.sourceItemId })),
            );
            const payloads = yield* sql<{
              thread_id: string;
              turn_item_id: string;
              payload_json: string;
            }>`
          SELECT item.thread_id, item.turn_item_id, item.payload_json
          FROM orchestration_v2_projection_turn_items item JOIN json_each(${sources}) wanted
          ON item.thread_id = json_extract(wanted.value, '$.threadId')
            AND item.turn_item_id = json_extract(wanted.value, '$.id')`;
            const byIdentity = new Map(
              payloads.map((row) => [`${row.thread_id}:${row.turn_item_id}`, row.payload_json]),
            );
            const items = yield* Effect.forEach(page, (row) =>
              Effect.gen(function* () {
                if (row.synthetic !== undefined)
                  return {
                    position: row.position,
                    sourceThreadId: row.sourceThreadId,
                    sourceItemId: row.sourceItemId,
                    visibility: row.visibility,
                    item: row.synthetic,
                  };
                const payload = byIdentity.get(`${row.sourceThreadId}:${row.sourceItemId}`);
                if (payload === undefined)
                  return yield* new ProjectionStoreReadError({
                    threadId,
                    cause: "Timeline item disappeared during snapshot",
                  });
                const item = yield* decodeTurnItemPayload(payload).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProjectionStoreReadError({ threadId: row.sourceThreadId, cause }),
                  ),
                );
                return {
                  position: row.position,
                  sourceThreadId: row.sourceThreadId,
                  sourceItemId: row.sourceItemId,
                  visibility: row.visibility,
                  item,
                };
              }),
            );
            return { items, totalItems, hasMore, hasEarlier };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        );

    const getThreadSnapshotWindow = (threadId: ThreadId, options: ProjectionWindowOptions) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const historyAnchor =
              options.anchorItemId === undefined
                ? undefined
                : {
                    itemId: options.anchorItemId,
                    threadId:
                      options.anchorThreadId ??
                      (yield* sql<{ readonly thread_id: string }>`
                        SELECT thread_id
                        FROM orchestration_v2_projection_turn_items
                        WHERE turn_item_id = ${options.anchorItemId}
                        LIMIT 1
                      `).map((row) => ThreadId.make(row.thread_id))[0] ??
                      threadId,
                  };
            const projection = yield* readProjection(threadId, new Set(), {
              rowLimit: options.rowLimit,
              userTurnLimit: options.userTurnLimit,
              deferWork: options.deferWork,
              ...(historyAnchor?.threadId === threadId
                ? { anchorItemId: historyAnchor.itemId }
                : {}),
              ...(historyAnchor === undefined ? {} : { historyAnchor }),
            });
            if (projection.thread.deletedAt !== null)
              return yield* new ProjectionStoreThreadNotFoundError({ threadId });
            // Pending requests outlive their turn's window; clients read their prompt from the card.
            const retainedIds = new Set(projection.turnItems.map((item) => item.id));
            const pendingCards = (yield* decodeRows(
              decodeTurnItemPayload,
              threadId,
            )(
              yield* sql<PayloadRow>`
                SELECT item.payload_json
                FROM orchestration_v2_projection_runtime_requests AS request
                CROSS JOIN orchestration_v2_projection_turn_items AS item
                  ON item.node_id = request.node_id
                  AND item.type IN ('approval_request', 'user_input_request')
                  AND json_extract(item.payload_json, '$.requestId') = request.runtime_request_id
                WHERE request.thread_id = ${threadId} AND request.status = 'pending'
                  AND item.thread_id = ${threadId}
              `,
            )).filter((item) => !retainedIds.has(item.id));
            const windowProjection =
              pendingCards.length === 0
                ? projection
                : {
                    ...projection,
                    turnItems: [...projection.turnItems, ...pendingCards].toSorted(
                      (left, right) =>
                        left.ordinal - right.ordinal || left.id.localeCompare(right.id),
                    ),
                  };
            const rows = yield* sql<{ readonly snapshot_sequence: number | null }>`
              SELECT MAX(sequence) AS snapshot_sequence
              FROM orchestration_events
              WHERE application_event_version = 2
                AND aggregate_kind = 'thread'
                AND stream_id = ${threadId}
            `;
            return {
              schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
              snapshotSequence: rows[0]?.snapshot_sequence ?? 0,
              projection: windowProjection,
            };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        );

    return {
      getThreadProjection,
      getTurnStartContext,
      getTurnStartHistory,
      getRunProviderRecords,
      getRunCardRecords,
      getMessageCount,
      getTranscriptByteFloor,
      getSubagentCount,
      getRunCount,
      listAppOwnedChildThreadIds,
      hasPendingDelegatedCompletion,
      getNextTurnItemOrdinal,
      getTurnItem,
      getMessagesById,
      getForkSourceRunIds,
      getThreadRecords,
      getThreadSnapshot,
      getThreadSnapshotWindow,
      getTimelinePage,
      getThreadHistoryPage,
      searchThread,
      searchThreadStream,
      getThreadAttachmentIds,
    };
  },
);
