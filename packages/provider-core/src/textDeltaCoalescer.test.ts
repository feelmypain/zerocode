import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaUpdate,
} from "./textDeltaCoalescer.ts";

describe("makeProviderTextDeltaCoalescer", () => {
  it.effect("coalesces deltas per interval and flushes remaining updates on flush/complete", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<ProviderTextDeltaUpdate>>([]);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "item-1", delta: "Hello" });
      yield* coalescer.append({ turnId: "turn-1", itemId: "item-1", delta: ", " });
      yield* coalescer.append({ turnId: "turn-1", itemId: "item-1", delta: "world" });
      assert.deepEqual(yield* Ref.get(updates), []);

      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;
      assert.deepEqual(yield* Ref.get(updates), [
        { turnId: "turn-1", itemId: "item-1", text: "Hello, world", completed: false },
      ]);

      yield* coalescer.append({ turnId: "turn-1", itemId: "item-1", delta: "!" });
      yield* coalescer.flush("turn-1");
      assert.deepEqual(yield* Ref.get(updates), [
        { turnId: "turn-1", itemId: "item-1", text: "Hello, world", completed: false },
        { turnId: "turn-1", itemId: "item-1", text: "Hello, world!", completed: false },
      ]);

      const completed = yield* coalescer.complete({ turnId: "turn-1", itemId: "item-1" });
      assert.equal(completed, "Hello, world!");
      assert.deepEqual(yield* Ref.get(updates), [
        { turnId: "turn-1", itemId: "item-1", text: "Hello, world", completed: false },
        { turnId: "turn-1", itemId: "item-1", text: "Hello, world!", completed: false },
        { turnId: "turn-1", itemId: "item-1", text: "Hello, world!", completed: true },
      ]);
    }),
  );

  it.effect("schedules a follow-up flush when deltas arrive while an emit is in flight", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const updates: Array<ProviderTextDeltaUpdate> = [];
      let emitCount = 0;

      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) =>
          Effect.gen(function* () {
            emitCount += 1;
            if (emitCount === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            updates.push(update);
          }),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "item-1", delta: "part-1" });
      yield* TestClock.adjust("50 millis");
      yield* Deferred.await(firstStarted);

      yield* coalescer.append({ turnId: "turn-1", itemId: "item-1", delta: "-part-2" });
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Effect.yieldNow;

      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;

      assert.deepEqual(updates, [
        { turnId: "turn-1", itemId: "item-1", text: "part-1", completed: false },
        { turnId: "turn-1", itemId: "item-1", text: "part-1-part-2", completed: false },
      ]);
    }),
  );

  it.effect("serializes complete behind an in-flight streaming emit", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const updates: Array<ProviderTextDeltaUpdate> = [];

      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) =>
          Effect.gen(function* () {
            if (!update.completed) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            updates.push(update);
          }),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "item-1", delta: "draft" });
      yield* TestClock.adjust("50 millis");
      yield* Deferred.await(firstStarted);

      yield* coalescer.append({ turnId: "turn-1", itemId: "item-1", delta: " final" });
      const completing = yield* coalescer
        .complete({ turnId: "turn-1", itemId: "item-1" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(releaseFirst, undefined);
      const text = yield* Fiber.join(completing);

      assert.equal(text, "draft final");
      assert.deepEqual(updates, [
        { turnId: "turn-1", itemId: "item-1", text: "draft", completed: false },
        { turnId: "turn-1", itemId: "item-1", text: "draft final", completed: true },
      ]);
    }),
  );
});
