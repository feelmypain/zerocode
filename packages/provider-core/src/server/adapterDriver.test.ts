import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@zerocode/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { ACP_BASE_PROVIDER_CAPABILITIES, makeLazyProviderAdapter } from "./adapterDriver.ts";
import * as ProviderAdapter from "./ProviderAdapter.ts";
import { acpSelectionTransition } from "./selectionTransition.ts";

const makeSessionInput = (
  instanceId: ProviderInstanceId,
  sessionName: string,
): ProviderAdapter.ProviderAdapterV2OpenSessionInput => ({
  threadId: ThreadId.make(`thread-${sessionName}`),
  providerSessionId: ProviderSessionId.make(sessionName),
  modelSelection: { instanceId, model: "synthetic-model" },
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: "/workspace",
  }),
});

it.effect(
  "makeLazyProviderAdapter defers load until openSession, single-flights concurrency, retries failures, and delegates post-load capabilities",
  () =>
    Effect.gen(function* () {
      const DriverTag = Context.Service<{ readonly token: string }>("test/LazyProviderTag");
      const driver = ProviderDriverKind.make("kiro");
      const instanceId = ProviderInstanceId.make("lazy-kiro");
      let loadCalls = 0;
      let openCalls = 0;
      let shouldFailLoad = true;
      let seenToken: string | undefined;
      let driverFinalizersClosed = 0;
      let sessionFinalizersClosed = 0;
      let runtimeNativeGoals = false;
      const loadEntered = yield* Deferred.make<void>();
      const releaseLoad = yield* Deferred.make<void>();

      const adapter = yield* makeLazyProviderAdapter({
        instanceId,
        driver,
        checksVersionAtHandshake: true,
        getCapabilities: () => Effect.succeed(ACP_BASE_PROVIDER_CAPABILITIES),
        planSelectionTransition: (input) => Effect.succeed(acpSelectionTransition(input)),
        load: () =>
          Effect.gen(function* () {
            loadCalls += 1;
            if (shouldFailLoad) {
              shouldFailLoad = false;
              return yield* Effect.fail("transient-import-error");
            }
            seenToken = (yield* DriverTag).token;
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                driverFinalizersClosed += 1;
              }),
            );
            yield* Deferred.succeed(loadEntered, undefined);
            yield* Deferred.await(releaseLoad);
            return ProviderAdapter.ProviderAdapterV2.of({
              instanceId,
              driver,
              getCapabilities: () =>
                Effect.succeed({
                  ...ACP_BASE_PROVIDER_CAPABILITIES,
                  turns: {
                    ...ACP_BASE_PROVIDER_CAPABILITIES.turns,
                    supportsNativeGoals: runtimeNativeGoals,
                  },
                }),
              planSelectionTransition: (input) => Effect.succeed(acpSelectionTransition(input)),
              openSession: (openInput) =>
                Effect.gen(function* () {
                  openCalls += 1;
                  runtimeNativeGoals = true;
                  yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                      sessionFinalizersClosed += 1;
                    }),
                  );
                  const now = yield* DateTime.now;
                  return {
                    instanceId,
                    driver,
                    providerSessionId: openInput.providerSessionId,
                    providerSession: {
                      id: openInput.providerSessionId,
                      providerInstanceId: instanceId,
                      driver,
                      status: "ready",
                      cwd: TrimmedNonEmptyString.make(openInput.runtimePolicy.cwd ?? "/workspace"),
                      model: null,
                      capabilities: ACP_BASE_PROVIDER_CAPABILITIES,
                      createdAt: now,
                      updatedAt: now,
                      lastError: null,
                    },
                    events: Stream.empty,
                    ensureThread: () => Effect.die("unused"),
                    resumeThread: () => Effect.die("unused"),
                    startTurn: () => Effect.die("unused"),
                    steerTurn: () => Effect.die("unused"),
                    interruptTurn: () => Effect.die("unused"),
                    respondToRuntimeRequest: () => Effect.die("unused"),
                    readThreadSnapshot: () => Effect.die("unused"),
                    rollbackThread: () => Effect.die("unused"),
                    forkThread: () => Effect.die("unused"),
                  } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
                }),
            });
          }),
      }).pipe(Effect.provideService(DriverTag, { token: "captured-context" }));

      assert.equal(adapter.checksVersionAtHandshake, true);
      assert.deepStrictEqual(yield* adapter.getCapabilities(), ACP_BASE_PROVIDER_CAPABILITIES);
      assert.equal(loadCalls, 0);

      const failure = yield* adapter
        .openSession(makeSessionInput(instanceId, "failed-load"))
        .pipe(Effect.scoped, Effect.flip);
      assert.equal(failure._tag, "ProviderAdapterOpenSessionError");
      assert.equal(loadCalls, 1);

      const first = yield* adapter
        .openSession(makeSessionInput(instanceId, "session-1"))
        .pipe(Effect.scoped, Effect.forkChild);
      yield* Deferred.await(loadEntered);
      const second = yield* adapter
        .openSession(makeSessionInput(instanceId, "session-2"))
        .pipe(Effect.scoped, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseLoad, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);

      assert.equal(loadCalls, 2);
      assert.equal(openCalls, 2);
      assert.equal(seenToken, "captured-context");
      assert.equal(sessionFinalizersClosed, 2);
      assert.equal(driverFinalizersClosed, 0);
      assert.isTrue((yield* adapter.getCapabilities()).turns.supportsNativeGoals);
    }),
);
