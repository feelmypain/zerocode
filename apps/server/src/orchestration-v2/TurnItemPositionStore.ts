import { OrchestrationV2TurnItem, RunId, ThreadId, TurnItemId } from "@zerocode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class TurnItemPositionStoreError extends Schema.TaggedError<TurnItemPositionStoreError>()(
  "TurnItemPositionStoreError",
  {
    threadId: ThreadId,
    turnItemId: TurnItemId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isTurnItemPositionStoreError = Schema.is(TurnItemPositionStoreError);

const MAX_CACHE_ENTRIES = 10_000;

const cacheKey = (threadId: ThreadId, id: string): string => `${threadId}\u0000${id}`;

const lruGet = <V>(cache: Map<string, V>, key: string): V | undefined => {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
};

const lruSet = <V>(cache: Map<string, V>, key: string, value: V): void => {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
};

export interface TurnItemPositionStoreV2Shape {
  readonly allocate: (input: {
    readonly threadId: ThreadId;
    readonly turnItemId: TurnItemId;
    readonly runId: RunId | null;
    readonly runOrdinal?: number;
    // `run_start` takes the run's unused first slot, ahead of its items, and appends once it is taken.
    readonly placement?: "append" | "run_start";
    // Keep an existing position even when it lies outside the run's range.
    readonly keepExisting?: boolean;
  }) => Effect.Effect<number, TurnItemPositionStoreError>;
  readonly normalize: (
    item: OrchestrationV2TurnItem,
    runOrdinal?: number,
  ) => Effect.Effect<OrchestrationV2TurnItem, TurnItemPositionStoreError>;
  readonly invalidateThread: (threadId: ThreadId) => Effect.Effect<void>;
}

export class TurnItemPositionStoreV2 extends Context.Service<
  TurnItemPositionStoreV2,
  TurnItemPositionStoreV2Shape
>()("zerocode/orchestration-v2/TurnItemPositionStore/TurnItemPositionStoreV2") {}

export const layer: Layer.Layer<TurnItemPositionStoreV2, never, SqlClient.SqlClient> = Layer.effect(
  TurnItemPositionStoreV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positionCache = new Map<string, number>();
    const runOrdinalCache = new Map<string, number>();

    const cacheAfterCommit = <V>(cache: Map<string, V>, key: string, value: V) =>
      sql.afterCommit(Effect.sync(() => lruSet(cache, key, value)));

    const resolveRunOrdinal = Effect.fnUntraced(function* (
      threadId: ThreadId,
      runId: RunId | null,
      suppliedRunOrdinal: number | undefined,
    ) {
      if (suppliedRunOrdinal !== undefined) {
        if (runId !== null) {
          yield* cacheAfterCommit(runOrdinalCache, cacheKey(threadId, runId), suppliedRunOrdinal);
        }
        return suppliedRunOrdinal;
      }
      if (runId === null) return null;
      const key = cacheKey(threadId, runId);
      const cached = lruGet(runOrdinalCache, key);
      if (cached !== undefined) return cached;
      const runRows = yield* sql<{ readonly ordinal: number }>`
        SELECT ordinal
        FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND run_id = ${runId}
        LIMIT 1
      `;
      const ordinal = runRows[0]?.ordinal ?? null;
      if (ordinal !== null) {
        yield* cacheAfterCommit(runOrdinalCache, key, ordinal);
      }
      return ordinal;
    });

    const moveExistingPosition = Effect.fnUntraced(function* (
      threadId: ThreadId,
      turnItemId: TurnItemId,
      itemKey: string,
      lowerBound: number,
      upperBound: number,
    ) {
      // Drop any cached position now so another call in the same uncommitted transaction re-reads SQLite.
      positionCache.delete(itemKey);
      const rows = yield* sql<{ readonly ordinal: number }>`
        UPDATE orchestration_v2_turn_item_positions
        SET ordinal = (
          SELECT COALESCE(MAX(ordinal), ${lowerBound}) + 1
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId}
            AND ordinal >= ${lowerBound}
            AND ordinal <= ${upperBound}
        )
        WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
        RETURNING ordinal
      `;
      const ordinal = rows[0]?.ordinal;
      if (ordinal === undefined) {
        return yield* new TurnItemPositionStoreError({
          threadId,
          turnItemId,
          cause: "Position allocation returned no row.",
        });
      }
      yield* cacheAfterCommit(positionCache, itemKey, ordinal);
      return ordinal;
    });

    const allocate: TurnItemPositionStoreV2Shape["allocate"] =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(
        function* ({
          threadId,
          turnItemId,
          runId,
          runOrdinal: suppliedRunOrdinal,
          placement = "append",
          keepExisting = false,
        }) {
          const itemKey = cacheKey(threadId, turnItemId);
          const cachedPosition = lruGet(positionCache, itemKey);
          if (cachedPosition !== undefined) {
            if (keepExisting || runId === null) {
              return cachedPosition;
            }
            const runOrdinal = yield* resolveRunOrdinal(threadId, runId, suppliedRunOrdinal);
            if (runOrdinal === null) {
              return cachedPosition;
            }
            const lowerBound = runOrdinal * 1_000_000;
            const upperBound = lowerBound + 999_999;
            // A steer that missed its turn starts the next run; it moves into that run's range.
            if (cachedPosition >= lowerBound && cachedPosition <= upperBound) {
              return cachedPosition;
            }
            return yield* moveExistingPosition(
              threadId,
              turnItemId,
              itemKey,
              lowerBound,
              upperBound,
            );
          }

          const existing = yield* sql<{ readonly ordinal: number }>`
            SELECT ordinal
            FROM orchestration_v2_turn_item_positions
            WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
            LIMIT 1
          `;
          const current = existing[0]?.ordinal;
          if (current !== undefined) {
            if (keepExisting || runId === null) {
              yield* cacheAfterCommit(positionCache, itemKey, current);
              return current;
            }
            const runOrdinal = yield* resolveRunOrdinal(threadId, runId, suppliedRunOrdinal);
            const lowerBound = runOrdinal === null ? 0 : runOrdinal * 1_000_000;
            const upperBound = runOrdinal === null ? 999_999 : lowerBound + 999_999;
            if (runOrdinal === null || (current >= lowerBound && current <= upperBound)) {
              yield* cacheAfterCommit(positionCache, itemKey, current);
              return current;
            }
            return yield* moveExistingPosition(
              threadId,
              turnItemId,
              itemKey,
              lowerBound,
              upperBound,
            );
          }

          const runOrdinal = yield* resolveRunOrdinal(threadId, runId, suppliedRunOrdinal);
          const lowerBound = runOrdinal === null ? 0 : runOrdinal * 1_000_000;
          const upperBound = runOrdinal === null ? 999_999 : lowerBound + 999_999;
          const rows = yield* sql<{ readonly ordinal: number }>`
            INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
            SELECT
              ${threadId},
              ${turnItemId},
              ${
                placement === "run_start"
                  ? sql`CASE WHEN COALESCE(MIN(ordinal), ${upperBound}) > ${lowerBound} THEN ${lowerBound} ELSE MAX(ordinal) + 1 END`
                  : sql`COALESCE(MAX(ordinal), ${lowerBound}) + 1`
              }
            FROM orchestration_v2_turn_item_positions
            WHERE thread_id = ${threadId}
              AND ordinal >= ${lowerBound}
              AND ordinal <= ${upperBound}
            ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET
              ordinal = orchestration_v2_turn_item_positions.ordinal
            RETURNING ordinal
          `;
          const ordinal = rows[0]?.ordinal;
          if (ordinal === undefined) {
            return yield* new TurnItemPositionStoreError({
              threadId,
              turnItemId,
              cause: "Position allocation returned no row.",
            });
          }
          yield* cacheAfterCommit(positionCache, itemKey, ordinal);
          return ordinal;
        },
        (effect, { threadId, turnItemId }) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isTurnItemPositionStoreError(cause)
                ? cause
                : new TurnItemPositionStoreError({ threadId, turnItemId, cause }),
            ),
          ),
      );

    const invalidateThread: TurnItemPositionStoreV2Shape["invalidateThread"] = (threadId) =>
      Effect.sync(() => {
        const prefix = `${threadId}\u0000`;
        for (const key of positionCache.keys()) {
          if (key.startsWith(prefix)) positionCache.delete(key);
        }
        for (const key of runOrdinalCache.keys()) {
          if (key.startsWith(prefix)) runOrdinalCache.delete(key);
        }
      });

    return TurnItemPositionStoreV2.of({
      allocate,
      // Per-event normalization shares the enclosing orchestration span.
      normalize: Effect.fnUntraced(function* (item, runOrdinal) {
        return yield* allocate({
          threadId: item.threadId,
          turnItemId: item.id,
          runId: item.runId,
          // Queued steers keep their submission order until their run starts (see Orchestrator).
          keepExisting: item.status === "pending",
          ...(runOrdinal === undefined ? {} : { runOrdinal }),
        }).pipe(Effect.map((ordinal) => (item.ordinal === ordinal ? item : { ...item, ordinal })));
      }),
      invalidateThread,
    });
  }),
);
