import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  coalesceShellApplicationEvents,
  makeThreadShellChangeFilter,
  shellStreamItemFromThreadShell,
  shouldPublishShellApplicationEvent,
  toShellApplicationEvent,
  type ShellApplicationEvent,
  type ShellDelta,
} from "./ShellStream.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export class ShellProjectionBroadcasterError extends Schema.TaggedError<ShellProjectionBroadcasterError>()(
  "ShellProjectionBroadcasterError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

type ShellBroadcastMessage =
  | { readonly _tag: "Delta"; readonly item: ShellDelta }
  | { readonly _tag: "Error"; readonly error: ShellProjectionBroadcasterError };

export class ShellProjectionBroadcaster extends Context.Service<
  ShellProjectionBroadcaster,
  {
    /**
     * Subscribes to the shared server-wide shell delta stream. Acquire before loading a client's
     * initial snapshot or replay high-water mark so no live delta after that cursor is missed.
     */
    readonly subscribe: Effect.Effect<
      Stream.Stream<ShellDelta, ShellProjectionBroadcasterError>,
      ShellProjectionBroadcasterError,
      Scope.Scope
    >;
  }
>()("zerocode/orchestration-v2/ShellProjectionBroadcaster") {}

const make = Effect.gen(function* () {
  const serviceScope = yield* Effect.scope;
  const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projectService = yield* ProjectService.ProjectService;
  const output = yield* PubSub.unbounded<ShellBroadcastMessage>();
  const lifecycleLock = yield* Semaphore.make(1);

  let subscriberCount = 0;
  let pumpScope: Scope.Closeable | null = null;

  const projectItem = Effect.fnUntraced(function* (
    stored: Extract<ShellApplicationEvent, { readonly aggregateKind: "project" }>,
  ) {
    if (stored.type === "project.deleted") {
      return {
        kind: "project.removed" as const,
        sequence: stored.sequence,
        projectId: stored.aggregateId,
      };
    }
    const project = yield* projectService.getShell(stored.aggregateId);
    return Option.match(project, {
      onNone: () => ({
        kind: "project.removed" as const,
        sequence: stored.sequence,
        projectId: stored.aggregateId,
      }),
      onSome: (value) => ({
        kind: "project.updated" as const,
        sequence: stored.sequence,
        project: value,
      }),
    });
  });

  const projectShellItems = Effect.fn("ShellProjectionBroadcaster.projectShellItems")(function* (
    events: ReadonlyArray<ShellApplicationEvent>,
  ) {
    const coalesced = coalesceShellApplicationEvents(events);
    const threadIds = coalesced.flatMap((stored) =>
      "aggregateKind" in stored ? [] : [stored.event.threadId],
    );
    // A failed batch can't name its thread, so the scalar reads below report which one is bad.
    const batch =
      threadIds.length > 1
        ? yield* threadManagement
            .getShellSnapshot({ threadIds })
            .pipe(Effect.orElseSucceed(() => null))
        : null;
    const batchedShells =
      batch === null
        ? null
        : new Map(
            [...batch.threads, ...batch.archivedThreads].map((shell) => [shell.id, shell] as const),
          );
    return yield* Effect.forEach(
      coalesced,
      (stored) =>
        Effect.gen(function* () {
          if ("aggregateKind" in stored) {
            return yield* projectItem(stored);
          }
          const threadId = stored.event.threadId;
          const shell =
            batchedShells === null
              ? yield* threadManagement.getThreadShell(threadId)
              : (batchedShells.get(threadId) ?? null);
          return shellStreamItemFromThreadShell({ stored, shell });
        }),
      { concurrency: 8 },
    );
  });

  const startPump = Effect.fn("ShellProjectionBroadcaster.startPump")(function* () {
    const scope = yield* Scope.fork(serviceScope);
    return yield* Effect.gen(function* () {
      const subagentThreadIds = new Set<string>(
        yield* threadManagement.listActiveSubagentThreadIds(),
      );
      const startSequence = yield* applicationEvents.latestApplicationSequence;
      const rawUpstream = applicationEvents.streamProjectedApplicationEvents({
        afterSequence: startSequence,
        project: toShellApplicationEvent,
        filter: (stored) => shouldPublishShellApplicationEvent(stored, subagentThreadIds),
      });
      // Pull setup subscribes to OrchestrationEventStore synchronously before subscribe() returns.
      const rawPull = yield* Stream.toPull(rawUpstream).pipe(Scope.provide(scope));
      const changeFilter = makeThreadShellChangeFilter();
      const pump = Stream.fromPull(Effect.succeed(rawPull)).pipe(
        Stream.groupedWithin(512, Duration.millis(50)),
        Stream.runForEach((batch) =>
          projectShellItems(Array.from(batch)).pipe(
            Effect.flatMap((items) =>
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                const messages: Array<ShellBroadcastMessage> = [];
                for (const item of items) {
                  if (changeFilter.shouldEmit(item, now)) {
                    messages.push({ _tag: "Delta", item });
                  }
                }
                if (messages.length > 0) {
                  yield* PubSub.publishAll(output, messages);
                }
              }),
            ),
            Effect.catch((cause) =>
              Effect.sync(() => changeFilter.clear()).pipe(
                Effect.andThen(
                  PubSub.publish(output, {
                    _tag: "Error",
                    error: new ShellProjectionBroadcasterError({
                      message: "Failed to project shell delta",
                      cause,
                    }),
                  }),
                ),
                Effect.asVoid,
              ),
            ),
          ),
        ),
        Effect.catch((cause) =>
          PubSub.publish(output, {
            _tag: "Error",
            error: new ShellProjectionBroadcasterError({
              message: "Failed to read shell application events",
              cause,
            }),
          }).pipe(Effect.asVoid),
        ),
      );
      yield* Effect.forkIn(pump, scope, { startImmediately: true });
      pumpScope = scope;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ShellProjectionBroadcasterError({
            message: "Failed to start shell projection broadcaster",
            cause,
          }),
      ),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
  });

  const stopPump = Effect.fnUntraced(function* () {
    const scope = pumpScope;
    pumpScope = null;
    if (scope !== null) {
      yield* Scope.close(scope, Exit.void);
    }
  });

  const subscribe: ShellProjectionBroadcaster["Service"]["subscribe"] = Effect.gen(function* () {
    const subscription = yield* Effect.acquireRelease(
      lifecycleLock.withPermit(
        Effect.gen(function* () {
          if (subscriberCount === 0) {
            yield* startPump();
          }
          subscriberCount += 1;
          return yield* PubSub.subscribe(output);
        }),
      ),
      () =>
        lifecycleLock.withPermit(
          Effect.gen(function* () {
            subscriberCount = Math.max(0, subscriberCount - 1);
            if (subscriberCount === 0) {
              yield* stopPump();
            }
          }),
        ),
    );
    return Stream.fromSubscription(subscription).pipe(
      Stream.mapEffect((message) =>
        message._tag === "Delta" ? Effect.succeed(message.item) : Effect.fail(message.error),
      ),
    );
  }).pipe(Effect.withSpan("ShellProjectionBroadcaster.subscribe"));

  return ShellProjectionBroadcaster.of({ subscribe });
});

export const layer = Layer.effect(ShellProjectionBroadcaster, make);
