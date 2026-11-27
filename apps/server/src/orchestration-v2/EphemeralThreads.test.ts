import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  CommandId,
  ContextTransferId,
  EPHEMERAL_THREADS_CLEANUP_PATH,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@zerocode/contracts";
import * as IdAllocator from "@zerocode/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@zerocode/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { HttpRouter } from "effect/http";
import * as RpcTest from "effect/rpc/RpcTest";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as GuestShareService from "../guest/GuestShareService.ts";
import * as ServerHttp from "../http.ts";
import { rpcInstrumentationLayer } from "../observability/RpcInstrumentation.ts";
import * as PeerClientPairing from "../peer/PeerClientPairing.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerThreadRelay from "../peer/PeerThreadRelay.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as WorkflowRuntime from "../workflows/WorkflowRuntime.ts";
import * as Workflows from "../workflows/Workflows.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import { makeOrchestrationHandlers } from "../ws/wsOrchestrationHandlers.ts";
import { OrchestrationWsRpcGroup } from "../ws/wsRpcShared.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as NativeChildWorkQuery from "./NativeChildWorkQuery.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadForkService from "./ThreadForkService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadSearch from "./ThreadSearch.ts";
import * as ThreadViewers from "./ThreadViewers.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:ephemeral");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const testProject = {
  id: projectId,
  title: "Ephemeral project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  trackedFolders: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

function makeTestLayer() {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "ephemeral-threads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest();
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagementService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerDatabase,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        EventStore.layer.pipe(Layer.provide(layerDatabase)),
        EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
        layerOrchestrator,
      ),
    ),
    Layer.provideMerge(layerServerSettings),
    Layer.provideMerge(layerReceipts),
  );
  const layerProjectService = Layer.mock(ProjectService.ProjectService)({
    getById: (id) => Effect.succeed(id === projectId ? Option.some(testProject) : Option.none()),
  });
  const layerLaunch = ThreadLaunchService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        WorktreeSetupTracker.layer,
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
        Layer.mock(TerminalManager.TerminalManager)({}),
        Layer.mock(CheckpointStore.CheckpointStore)({
          isGitRepository: () => Effect.succeed(true),
        }),
        layerProjectService,
        Layer.mock(GitWorkflow.GitWorkflowService)({ currentBranch: () => Effect.succeed(null) }),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
        Layer.mock(TextGeneration.TextGeneration)({}),
        layerServerSettings,
        ProviderRegistryMock.layer(),
        Layer.mock(TaskFolders.TaskFolders)({ plan: () => Effect.succeed(null) }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
          folderForThread: () => Effect.succeedNone,
        }),
        layerThreadManagement,
        layerReceipts,
        layerOrchestrator,
        IdAllocator.layer,
      ),
    ),
  );
  return Layer.mergeAll(layerThreadManagement, layerLaunch, layerProjectService);
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
      projectId,
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

  it.effect(
    "ws launchThread handler forwards ephemeral flag through ThreadLaunchService into projection",
    () =>
      Effect.gen(function* () {
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const baseContext = yield* Effect.context<
          | ThreadManagementService.ThreadManagementService
          | ThreadLaunchService.ThreadLaunchService
          | ProjectService.ProjectService
          | ServerSettings.ServerSettingsService
          | SqlClient.SqlClient
        >();
        const wsServices = Layer.mergeAll(
          Layer.succeedContext(baseContext),
          FileSystem.layerNoop({}),
          Path.layer,
          ServerConfig.layerTest(process.cwd(), "/tmp/ephemeral-test-state").pipe(
            Layer.provide(
              Layer.mergeAll(
                FileSystem.layerNoop({ makeDirectory: () => Effect.void }),
                Path.layer,
              ),
            ),
          ),
          Layer.mock(DocumentText.DocumentText)({}),
          Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
          Layer.mock(ProjectStore.ProjectStoreV2)({}),
          Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({}),
          Layer.mock(ThreadSearch.ThreadSearch)({}),
          Layer.mock(CommandOutputHub.CommandOutputHub)({}),
          Layer.mock(ThreadViewers.ThreadViewers)({
            isViewed: () => false,
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
          Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
          Layer.mock(Workflows.Workflows)({}),
          Layer.mock(WorkflowRuntime.WorkflowDefinitions)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(GuestShareService.GuestShareService)({}),
          Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
          Layer.mock(NativeChildWorkQuery.NativeChildWorkQuery)({}),
          Layer.mock(PeerLinks.PeerLinks)({}),
          Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
          Layer.mock(PeerThreadRelay.PeerThreadRelay)({}),
          Layer.mock(PeerClientPairing.PeerClientPairing)({}),
          Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
            enqueueCommand: (effect) => effect,
          }),
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
        );
        const client = yield* RpcTest.makeClient(OrchestrationWsRpcGroup).pipe(
          Effect.provide(
            Layer.effectContext(
              makeOrchestrationHandlers({
                sessionId: AuthSessionId.make("ephemeral-ws-test"),
                subject: "ephemeral-ws-test",
                method: "browser-session-cookie",
                scopes: [AuthOrchestrationOperateScope],
              }),
            ).pipe(
              Layer.provide(wsServices),
              Layer.merge(RpcAuthorization.layer([AuthOrchestrationOperateScope])),
              Layer.merge(rpcInstrumentationLayer),
            ),
          ),
        );

        const ephemeralId = ThreadId.make("thread:ws-launch-ephemeral");
        const permanentId = ThreadId.make("thread:ws-launch-permanent");
        const reusedId = ThreadId.make("thread:ws-launch-reused");

        const launchedEphemeral = yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread]({
          commandId: CommandId.make("ws-launch:ephemeral"),
          threadId: ephemeralId,
          projectId,
          title: "Temporary chat",
          ephemeral: true,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        });
        expect(launchedEphemeral.projection.thread.ephemeral).toBe(true);
        expect((yield* threads.getThreadShell(ephemeralId))?.ephemeral).toBe(true);

        const launchedPermanent = yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread]({
          commandId: CommandId.make("ws-launch:permanent"),
          threadId: permanentId,
          projectId,
          title: "Permanent chat",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        });
        expect(launchedPermanent.projection.thread.ephemeral).toBeUndefined();
        expect((yield* threads.getThreadShell(permanentId))?.ephemeral).toBeUndefined();

        // Reusing an existing empty thread also forwards `ephemeral: true`.
        yield* createThread({ threadId: reusedId });
        const launchedReused = yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread]({
          commandId: CommandId.make("ws-launch:reused"),
          threadId: reusedId,
          reuseExistingThread: true,
          projectId,
          title: "Reused temporary chat",
          ephemeral: true,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        });
        expect(launchedReused.projection.thread.ephemeral).toBe(true);
        expect((yield* threads.getThreadShell(reusedId))?.ephemeral).toBe(true);
        expect(new Set(yield* threads.listEphemeralThreadIds())).toEqual(
          new Set([ephemeralId, reusedId]),
        );
      }).pipe(Effect.scoped, Effect.provide(makeTestLayer())),
  );

  it.effect(
    "ThreadForkService.plan strips ephemeral when forking or creating a side chat from an ephemeral thread",
    () =>
      Effect.gen(function* () {
        const forkService = yield* ThreadForkService.ThreadForkServiceV2;
        const sourceThreadId = ThreadId.make("thread:ephemeral-fork-source");
        const sourceRunId = RunId.make("run:ephemeral-fork-source");
        const createdAt = DateTime.makeUnsafe("2026-07-24T09:00:00.000Z");
        const forkCreatedAt = DateTime.makeUnsafe("2026-07-24T09:10:00.000Z");
        const sourceThread: OrchestrationV2AppThread = {
          createdBy: "user",
          creationSource: "web",
          id: sourceThreadId,
          projectId,
          title: "Ephemeral source",
          ephemeral: true,
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: ProviderThreadId.make("provider-thread:ephemeral-fork-source"),
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: sourceThreadId,
          },
          forkedFrom: null,
          createdAt,
          updatedAt: createdAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          deletedAt: null,
        };
        const sourceRun: OrchestrationV2Run = {
          id: sourceRunId,
          threadId: sourceThreadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId: ProviderThreadId.make("provider-thread:ephemeral-fork-source"),
          userMessageId: MessageId.make("message:ephemeral-fork-source"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          queuePosition: null,
          requestedAt: createdAt,
          startedAt: createdAt,
          completedAt: createdAt,
          checkpointId: null,
          contextHandoffId: null,
        };

        const forkPlan = yield* forkService.plan({
          sourceProjection: { thread: sourceThread },
          sourceRun,
          sourceProviderThread: undefined,
          canonicalSourcePoint: { threadId: sourceThreadId, runId: sourceRunId },
          transferId: ContextTransferId.make("transfer:ephemeral-fork"),
          targetThreadId: ThreadId.make("thread:ephemeral-fork-target"),
          createdBy: "user",
          creationSource: "web",
          createdAt: forkCreatedAt,
        });
        expect(forkPlan.targetThread.ephemeral).toBeUndefined();
        expect("ephemeral" in forkPlan.targetThread).toBe(false);

        const sideChatPlan = yield* forkService.plan({
          sourceProjection: { thread: sourceThread },
          sourceRun: null,
          sourceProviderThread: undefined,
          canonicalSourcePoint: { threadId: sourceThreadId },
          transferId: ContextTransferId.make("transfer:ephemeral-side-chat"),
          targetThreadId: ThreadId.make("thread:ephemeral-side-chat-target"),
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
          createdAt: forkCreatedAt,
        });
        expect(sideChatPlan.targetThread.ephemeral).toBeUndefined();
        expect("ephemeral" in sideChatPlan.targetThread).toBe(false);
        expect(sideChatPlan.targetThread.lineage.sideChat).toBe(true);
      }).pipe(Effect.provide(ThreadForkService.layer)),
  );

  it.effect(
    "deleteEphemeralThreads skips already-deleted threads without inflating deletedCount or duplicating events",
    () =>
      Effect.gen(function* () {
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const eventStore = yield* EventStore.EventStoreV2;
        const parentId = ThreadId.make("thread:ephemeral-cascade-parent");
        const sideChatId = ThreadId.make("thread:ephemeral-cascade-side-chat");

        yield* createThread({ threadId: parentId, ephemeral: true });
        yield* threads.dispatch({
          type: "thread.fork",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("fork:ephemeral-cascade-side-chat"),
          sourceThreadId: parentId,
          targetThreadId: sideChatId,
          sourcePoint: { type: "latest_stable" },
          sideChat: true,
        });
        // Forking a side chat from an ephemeral parent does not inherit ephemeral.
        expect((yield* threads.getThreadShell(sideChatId))?.ephemeral).toBeUndefined();

        // Mark the side chat ephemeral too so both IDs appear in the cleanup list;
        // deleting the parent cascade-deletes the side chat before its own iteration runs.
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("mark-ephemeral:cascade-side-chat"),
          threadId: sideChatId,
          ephemeral: true,
        });
        expect(new Set(yield* threads.listEphemeralThreadIds())).toEqual(
          new Set([parentId, sideChatId]),
        );

        const result = yield* threads.deleteEphemeralThreads([parentId, sideChatId]);
        expect(result).toEqual({ deletedCount: 1 });
        expect([...(yield* threads.listEphemeralThreadIds())]).toEqual([]);

        const parentShell = yield* threads.getThreadShell(parentId);
        const sideChatShell = yield* threads.getThreadShell(sideChatId);
        expect(parentShell === null || parentShell.deletedAt !== null).toBe(true);
        expect(sideChatShell === null || sideChatShell.deletedAt !== null).toBe(true);

        const sideChatDeletedEvents = yield* eventStore
          .read({ threadId: sideChatId, eventType: "thread.deleted" })
          .pipe(Stream.runCollect);
        expect(Array.from(sideChatDeletedEvents)).toHaveLength(1);
      }).pipe(Effect.provide(makeTestLayer())),
  );
});
