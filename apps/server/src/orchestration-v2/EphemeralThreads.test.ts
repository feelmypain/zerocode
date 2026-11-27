import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EPHEMERAL_THREADS_CLEANUP_PATH,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@zerocode/contracts";
import type * as ProviderAdapter from "@zerocode/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerHttp from "../http.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

function makeTestLayer() {
  const layerDatabase = SqlitePersistence.layerMemory;
  return ThreadManagementService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerDatabase,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        EventStore.layer.pipe(Layer.provide(layerDatabase)),
        EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
        ProviderReplayHarness.layerWithRegistry(
          { name: "ephemeral-threads" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { databaseLayer: layerDatabase, runEffectWorker: false },
        ),
      ),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
}

const createThread = (input: { readonly threadId: ThreadId; readonly ephemeral?: boolean }) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`create:${input.threadId}`),
      threadId: input.threadId,
      projectId: ProjectId.make("project:ephemeral"),
      title: `Thread ${input.threadId}`,
      ...(input.ephemeral === true ? { ephemeral: true } : {}),
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
  });

describe("ephemeral threads", () => {
  it.effect(
    "persists ephemeral flag, supports promoting to permanent, and sweeps only ephemeral threads",
    () =>
      Effect.gen(function* () {
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const ephemeralToDelete = ThreadId.make("thread:ephemeral-delete");
        const ephemeralToKeep = ThreadId.make("thread:ephemeral-keep");
        const permanentThread = ThreadId.make("thread:permanent");

        yield* createThread({ threadId: ephemeralToDelete, ephemeral: true });
        yield* createThread({ threadId: ephemeralToKeep, ephemeral: true });
        yield* createThread({ threadId: permanentThread });

        expect((yield* threads.getThreadShell(ephemeralToDelete))?.ephemeral).toBe(true);
        expect((yield* threads.getThreadShell(ephemeralToKeep))?.ephemeral).toBe(true);
        expect((yield* threads.getThreadShell(permanentThread))?.ephemeral).toBeUndefined();
        expect(new Set(yield* threads.listEphemeralThreadIds())).toEqual(
          new Set([ephemeralToDelete, ephemeralToKeep]),
        );

        // Promote one ephemeral chat to permanent ("Keep chat").
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("keep:ephemeral-keep"),
          threadId: ephemeralToKeep,
          ephemeral: false,
        });
        expect((yield* threads.getThreadShell(ephemeralToKeep))?.ephemeral).toBeUndefined();
        expect([...(yield* threads.listEphemeralThreadIds())]).toEqual([ephemeralToDelete]);

        // Unfiltered sweep (server startup/shutdown) deletes only remaining ephemeral threads.
        const result = yield* threads.deleteEphemeralThreads();
        expect(result).toEqual({ deletedCount: 1 });
        expect([...(yield* threads.listEphemeralThreadIds())]).toEqual([]);

        const deletedShell = yield* threads.getThreadShell(ephemeralToDelete);
        expect(deletedShell === null || deletedShell.deletedAt !== null).toBe(true);
        expect((yield* threads.getThreadShell(ephemeralToKeep))?.deletedAt).toBeNull();
        expect((yield* threads.getThreadShell(permanentThread))?.deletedAt).toBeNull();
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "HTTP cleanup endpoint requires operate scope and refuses to delete non-ephemeral threads",
    () =>
      Effect.gen(function* () {
        const ephemeralId = ThreadId.make("thread:http-ephemeral");
        const permanentId = ThreadId.make("thread:http-permanent");

        let grantedScopes: ReadonlyArray<string> = [AuthOrchestrationOperateScope];
        const authLayer = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateHttpRequest: () =>
            Effect.succeed({
              scopes: grantedScopes,
            } as never),
        });

        const threads = yield* ThreadManagementService.ThreadManagementService;
        yield* createThread({ threadId: ephemeralId, ephemeral: true });
        yield* createThread({ threadId: permanentId });

        const routeApp = ServerHttp.layerEphemeralThreadsCleanupRoute.pipe(
          Layer.provideMerge(
            Layer.succeed(ThreadManagementService.ThreadManagementService, threads),
          ),
          Layer.provideMerge(authLayer),
        );
        const { handler, dispose } = HttpRouter.toWebHandler(routeApp, { disableLogger: true });
        try {
          // Read-only scope must be rejected and leave both threads untouched.
          grantedScopes = [AuthOrchestrationReadScope];
          const forbidden = yield* Effect.promise(() =>
            handler(
              new Request(`http://127.0.0.1:3773${EPHEMERAL_THREADS_CLEANUP_PATH}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ threadIds: [ephemeralId] }),
              }),
            ),
          );
          expect(forbidden.status).toBe(403);
          expect((yield* threads.getThreadShell(ephemeralId))?.deletedAt).toBeNull();

          // Operate scope deletes ONLY the ephemeral thread even when both IDs are sent.
          grantedScopes = [AuthOrchestrationOperateScope];
          const ok = yield* Effect.promise(() =>
            handler(
              new Request(`http://127.0.0.1:3773${EPHEMERAL_THREADS_CLEANUP_PATH}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ threadIds: [ephemeralId, permanentId] }),
              }),
            ),
          );
          expect(ok.status).toBe(204);
          const afterEphemeral = yield* threads.getThreadShell(ephemeralId);
          expect(afterEphemeral === null || afterEphemeral.deletedAt !== null).toBe(true);
          expect((yield* threads.getThreadShell(permanentId))?.deletedAt).toBeNull();

          // Malformed body returns 400.
          const badReq = yield* Effect.promise(() =>
            handler(
              new Request(`http://127.0.0.1:3773${EPHEMERAL_THREADS_CLEANUP_PATH}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "not-json",
              }),
            ),
          );
          expect(badReq.status).toBe(400);
        } finally {
          yield* Effect.promise(() => dispose());
        }
      }).pipe(Effect.provide(makeTestLayer())),
  );
});
