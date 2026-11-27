import { assert, it } from "@effect/vitest";
import { RunId, ThreadId, TurnItemId } from "@zerocode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const layerTest = TurnItemPositionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect("reuses an item's position without attempting another allocation insert", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const input = {
      threadId: ThreadId.make("thread:position-reuse"),
      turnItemId: TurnItemId.make("item:streaming"),
      runId: null,
    };
    const first = yield* positions.allocate(input);
    assert.equal(first, 1);

    // BEFORE INSERT runs even when ON CONFLICT would discard the allocation.
    yield* sql`
      CREATE TEMP TRIGGER reject_redundant_position_insert
      BEFORE INSERT ON orchestration_v2_turn_item_positions
      WHEN EXISTS (
        SELECT 1 FROM orchestration_v2_turn_item_positions
        WHERE thread_id = NEW.thread_id AND turn_item_id = NEW.turn_item_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Existing item positions must be reused');
      END
    `;

    const next = yield* positions.allocate({
      ...input,
      turnItemId: TurnItemId.make("item:next"),
    });
    assert.equal(next, first + 1);
    assert.equal(yield* positions.allocate(input), first);
    assert.equal(
      yield* positions.allocate({
        ...input,
        runId: RunId.make("run:moved"),
        runOrdinal: 2,
      }),
      2_000_001,
    );
    assert.equal(
      yield* positions.allocate({ ...input, threadId: ThreadId.make("thread:other") }),
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("places a run-start item ahead of the run's items, then appends once taken", () =>
  Effect.gen(function* () {
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const threadId = ThreadId.make("thread:run-start");
    const allocate = (id: string, placement?: "run_start") =>
      positions.allocate({
        threadId,
        turnItemId: TurnItemId.make(id),
        runId: RunId.make("run:2"),
        runOrdinal: 2,
        ...(placement === undefined ? {} : { placement }),
      });
    const message = yield* allocate("item:message");
    const recovery = yield* allocate("item:recovery", "run_start");
    assert.isBelow(recovery, message);
    assert.isAbove(recovery, 1_999_999);
    assert.equal(yield* allocate("item:retry-recovery", "run_start"), message + 1);
    assert.equal(yield* allocate("item:reply"), message + 2);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("serves repeated allocations from cache without querying SQLite", () =>
  Effect.gen(function* () {
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const threadId = ThreadId.make("thread:cached-hits");
    const runId = RunId.make("run:cached");
    const input = {
      threadId,
      turnItemId: TurnItemId.make("item:streaming"),
      runId,
      runOrdinal: 1,
    };
    const first = yield* positions.allocate(input);
    assert.equal(first, 1_000_001);

    let statements = 0;
    const countStatements: Statement.Transformer = (statement) =>
      Effect.sync(() => {
        statements += 1;
        return statement;
      });

    const cached = yield* positions
      .allocate({ threadId, turnItemId: input.turnItemId, runId })
      .pipe(Effect.provideService(Statement.CurrentTransformer, countStatements));
    assert.equal(cached, first);
    assert.equal(statements, 0);

    yield* positions.invalidateThread(threadId);
    const reloaded = yield* positions
      .allocate({ threadId, turnItemId: input.turnItemId, runId, runOrdinal: 1 })
      .pipe(Effect.provideService(Statement.CurrentTransformer, countStatements));
    assert.equal(reloaded, first);
    assert.equal(statements, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("does not keep cached positions from a rolled-back transaction", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const threadId = ThreadId.make("thread:rollback");
    const turnItemId = TurnItemId.make("item:rolled-back");

    const failed = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const allocated = yield* positions.allocate({
            threadId,
            turnItemId,
            runId: null,
          });
          assert.equal(allocated, 1);
          return yield* Effect.fail("rollback");
        }),
      )
      .pipe(Effect.flip);
    assert.equal(failed, "rollback");

    const other = yield* positions.allocate({
      threadId,
      turnItemId: TurnItemId.make("item:committed"),
      runId: null,
    });
    assert.equal(other, 1);

    // If the rolled-back position stayed cached, this would collide at 1 instead of allocating 2.
    const retried = yield* positions.allocate({
      threadId,
      turnItemId,
      runId: null,
    });
    assert.equal(retried, 2);
  }).pipe(Effect.provide(layerTest)),
);
