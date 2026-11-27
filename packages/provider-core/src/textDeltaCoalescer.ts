import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

export interface ProviderTextDeltaUpdate {
  readonly turnId: string;
  readonly itemId: string;
  readonly text: string;
  readonly completed: boolean;
}

export interface ProviderTextDeltaCoalescer {
  readonly append: (input: {
    readonly turnId: string;
    readonly itemId: string;
    readonly delta: string;
  }) => Effect.Effect<void>;
  readonly complete: (input: {
    readonly turnId: string;
    readonly itemId: string;
    readonly finalText?: string;
    readonly emitEmpty?: boolean;
  }) => Effect.Effect<string>;
  readonly flush: (turnId?: string) => Effect.Effect<void>;
  readonly flushTurn: (turnId: string) => Effect.Effect<void>;
}

interface BufferedProviderText {
  readonly turnId: string;
  readonly itemId: string;
  text: string;
  dirty: boolean;
}

function providerTextBufferKey(turnId: string, itemId: string): string {
  return `${turnId}\u0000${itemId}`;
}

export const makeProviderTextDeltaCoalescer = Effect.fn("makeProviderTextDeltaCoalescer")(
  function* (input: {
    readonly flushIntervalMs: number;
    readonly emit: (update: ProviderTextDeltaUpdate) => Effect.Effect<void>;
  }): Effect.fn.Return<ProviderTextDeltaCoalescer, never, Scope.Scope> {
    const buffered = new Map<string, BufferedProviderText>();
    let flushScheduled = false;
    const flushLock = yield* Semaphore.make(1);
    const coalescerScope = yield* Effect.scope;
    const flushInterval = Duration.millis(Math.max(1, input.flushIntervalMs));

    const drain = (options: {
      readonly predicate: (message: BufferedProviderText) => boolean;
      readonly completed: boolean;
      readonly onlyDirty: boolean;
      readonly releaseSchedule?: boolean;
    }) =>
      flushLock.withPermit(
        Effect.suspend(() => {
          const updates: Array<ProviderTextDeltaUpdate> = [];
          for (const [key, message] of buffered) {
            if (!options.predicate(message) || (options.onlyDirty && !message.dirty)) {
              continue;
            }
            updates.push({
              turnId: message.turnId,
              itemId: message.itemId,
              text: message.text,
              completed: options.completed,
            });
            if (options.completed) {
              buffered.delete(key);
            } else {
              message.dirty = false;
            }
          }
          if (options.releaseSchedule === true) {
            flushScheduled = false;
          }
          return updates.length === 0
            ? Effect.void
            : Effect.forEach(updates, input.emit, { discard: true });
        }),
      );

    const flushDirty = drain({
      predicate: () => true,
      completed: false,
      onlyDirty: true,
      releaseSchedule: true,
    });

    return {
      append: ({ turnId, itemId, delta }) =>
        delta.length === 0
          ? Effect.void
          : Effect.uninterruptible(
              Effect.suspend(() => {
                const key = providerTextBufferKey(turnId, itemId);
                const existing = buffered.get(key);
                if (existing === undefined) {
                  buffered.set(key, { turnId, itemId, text: delta, dirty: true });
                } else {
                  existing.text += delta;
                  existing.dirty = true;
                }
                if (flushScheduled) {
                  return Effect.void;
                }
                flushScheduled = true;
                return Effect.sleep(flushInterval).pipe(
                  Effect.andThen(flushDirty),
                  Effect.interruptible,
                  Effect.forkIn(coalescerScope),
                  Effect.asVoid,
                );
              }),
            ),
      complete: ({ turnId, itemId, finalText, emitEmpty = true }) =>
        flushLock.withPermit(
          Effect.suspend(() => {
            const key = providerTextBufferKey(turnId, itemId);
            const existing = buffered.get(key);
            buffered.delete(key);
            const text = finalText !== undefined ? finalText : (existing?.text ?? "");
            return emitEmpty || text.length > 0
              ? input.emit({ turnId, itemId, text, completed: true }).pipe(Effect.as(text))
              : Effect.succeed(text);
          }),
        ),
      flush: (turnId) =>
        drain({
          predicate: turnId === undefined ? () => true : (message) => message.turnId === turnId,
          completed: false,
          onlyDirty: true,
        }),
      flushTurn: (turnId) =>
        drain({
          predicate: (message) => message.turnId === turnId,
          completed: true,
          onlyDirty: false,
        }),
    };
  },
);
