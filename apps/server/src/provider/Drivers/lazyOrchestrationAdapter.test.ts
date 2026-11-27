import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@zerocode/contracts";
import * as McpProviderSessions from "@zerocode/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@zerocode/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@zerocode/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@zerocode/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@zerocode/provider-core/server/ProviderLatestVersions";
import { turnScopedSelectionTransition } from "@zerocode/provider-core/server/selectionTransition";
import type { ProviderTextGeneration } from "@zerocode/provider-core/server/textGeneration";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AntigravityInstallation from "../AntigravityInstallation.ts";
import * as CodexInstallation from "../CodexInstallation.ts";
import * as CodexManagedTokenBroker from "../CodexManagedTokenBroker.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import * as ProviderInstallationGate from "../ProviderInstallationGate.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "../ProviderOrchestrationAdapterInfrastructure.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import { AntigravityDriver } from "./AntigravityDriver.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";
import { CodexDriver } from "./CodexDriver.ts";
import {
  ANTIGRAVITY_PROVIDER_CAPABILITIES,
  CLAUDE_PROVIDER_CAPABILITIES,
  CODEX_PROVIDER_CAPABILITIES,
  makeLazyOrchestrationAdapter,
  makeLazyTextGeneration,
} from "./lazyOrchestrationAdapter.ts";

const hooks = vi.hoisted(() => ({
  loaded: [] as Array<string>,
}));

vi.mock("../../orchestration-v2/Adapters/ClaudeAdapterV2.ts", async (importOriginal) => {
  hooks.loaded.push("ClaudeAdapterV2");
  return await importOriginal<
    typeof import("../../orchestration-v2/Adapters/ClaudeAdapterV2.ts")
  >();
});

vi.mock("../../orchestration-v2/Adapters/CodexAdapterV2.ts", async (importOriginal) => {
  hooks.loaded.push("CodexAdapterV2");
  return await importOriginal<typeof import("../../orchestration-v2/Adapters/CodexAdapterV2.ts")>();
});

vi.mock("../../orchestration-v2/Adapters/AntigravityAdapterV2.ts", async (importOriginal) => {
  hooks.loaded.push("AntigravityAdapterV2");
  return await importOriginal<
    typeof import("../../orchestration-v2/Adapters/AntigravityAdapterV2.ts")
  >();
});

vi.mock("../../textGeneration/ClaudeTextGeneration.ts", async (importOriginal) => {
  hooks.loaded.push("ClaudeTextGeneration");
  return await importOriginal<typeof import("../../textGeneration/ClaudeTextGeneration.ts")>();
});

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("Disabled provider drivers must not spawn processes"),
);

const layerBaseDeps = ServerConfig.layerTest(process.cwd(), {
  prefix: "zerocode-lazy-driver-",
}).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, noSpawn)),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(PortScanner.layerTest),
  Layer.provideMerge(ProviderInstallationGate.layer),
  Layer.provideMerge(
    Layer.mock(CodexInstallation.CodexInstallation)({
      managedDirectory: "unused-managed-installation",
      compatibility: () => Effect.undefined,
    }),
  ),
  Layer.provideMerge(
    Layer.mock(AntigravityInstallation.AntigravityInstallation)({
      managedDirectory: "unused-managed-installation",
      resolve: () => Effect.die("unused"),
      acquire: () => Effect.die("unused"),
      compatibility: () => Effect.undefined,
    }),
  ),
  Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
  Layer.provideMerge(
    Layer.mock(CodexManagedTokenBroker.CodexManagedTokenBroker)({
      endpoint: Effect.succeed("unused-private-pipe"),
      awaitIdle: Effect.void,
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
    }),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(ResetCreditCoordinator.layerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled drivers must not make HTTP requests")),
    ),
  ),
);

const layerDriverTest = ProviderOrchestrationAdapterInfrastructure.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provideMerge(ProviderHostLive.layer.pipe(Layer.provideMerge(layerBaseDeps))),
);

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
    cwd: process.cwd(),
  }),
});

it.effect(
  "makeLazyOrchestrationAdapter loads once across concurrent opens and retries failures",
  () =>
    Effect.gen(function* () {
      const DriverTag = Context.Service<{ readonly token: string }>("test/LazyAdapterTag");
      const driver = ProviderDriverKind.make("codex");
      const instanceId = ProviderInstanceId.make("lazy-instance");
      let loadCalls = 0;
      let openCalls = 0;
      let shouldFailLoad = true;
      const loadEntered = yield* Deferred.make<void>();
      const releaseLoad = yield* Deferred.make<void>();
      let seenToken: string | undefined;
      let closedSessionScopes = 0;

      const adapter = yield* makeLazyOrchestrationAdapter({
        instanceId,
        driver,
        checksVersionAtHandshake: true,
        getCapabilities: () => Effect.succeed(CODEX_PROVIDER_CAPABILITIES),
        planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
        load: () =>
          Effect.gen(function* () {
            loadCalls += 1;
            if (shouldFailLoad) {
              shouldFailLoad = false;
              return yield* Effect.fail("transient-load-failure");
            }
            seenToken = (yield* DriverTag).token;
            yield* Deferred.succeed(loadEntered, undefined);
            yield* Deferred.await(releaseLoad);
            return ProviderAdapter.ProviderAdapterV2.of({
              instanceId,
              driver,
              getCapabilities: () => Effect.succeed(CODEX_PROVIDER_CAPABILITIES),
              planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
              openSession: (openInput) =>
                Effect.gen(function* () {
                  openCalls += 1;
                  yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                      closedSessionScopes += 1;
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
                      cwd: TrimmedNonEmptyString.make(openInput.runtimePolicy.cwd ?? process.cwd()),
                      model: null,
                      capabilities: CODEX_PROVIDER_CAPABILITIES,
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
      }).pipe(Effect.provideService(DriverTag, { token: "captured-driver-context" }));

      assert.equal(adapter.checksVersionAtHandshake, true);
      assert.deepEqual(yield* adapter.getCapabilities(), CODEX_PROVIDER_CAPABILITIES);
      assert.deepEqual(
        yield* adapter.planSelectionTransition({
          current: { instanceId, model: "a" },
          target: { instanceId, model: "b" },
          sessionCapabilities: CODEX_PROVIDER_CAPABILITIES,
        }),
        { type: "apply_on_next_turn" },
      );
      assert.equal(loadCalls, 0);

      const firstFailure = yield* adapter
        .openSession(makeSessionInput(instanceId, "failed-load"))
        .pipe(Effect.scoped, Effect.flip);
      assert.equal(firstFailure._tag, "ProviderAdapterOpenSessionError");
      assert.equal(loadCalls, 1);

      const openA = yield* adapter
        .openSession(makeSessionInput(instanceId, "s1"))
        .pipe(Effect.scoped, Effect.forkChild);
      yield* Deferred.await(loadEntered);
      const openB = yield* adapter
        .openSession(makeSessionInput(instanceId, "s2"))
        .pipe(Effect.scoped, Effect.forkChild);
      yield* Deferred.succeed(releaseLoad, undefined);
      const [sessionA, sessionB] = yield* Effect.all([Fiber.join(openA), Fiber.join(openB)]);

      assert.equal(sessionA.providerSessionId, ProviderSessionId.make("s1"));
      assert.equal(sessionB.providerSessionId, ProviderSessionId.make("s2"));
      assert.equal(loadCalls, 2);
      assert.equal(openCalls, 2);
      assert.equal(seenToken, "captured-driver-context");
      assert.equal(closedSessionScopes, 2);
    }).pipe(Effect.scoped),
);

it.effect("makeLazyTextGeneration loads on first call and caches the implementation", () =>
  Effect.gen(function* () {
    let loads = 0;
    const textGeneration = yield* makeLazyTextGeneration(() =>
      Effect.sync(() => {
        loads += 1;
        return {
          generateTranscriptionPostProcessing: () => Effect.succeed({ transcription: "ok" }),
          generateCommitMessage: () => Effect.succeed({ subject: "s", body: "b" }),
          generatePrContent: () => Effect.succeed({ title: "t", body: "b" }),
          generateBranchName: () => Effect.succeed({ branch: "feat/test" }),
          generateThreadTitle: () => Effect.succeed({ title: "Title" }),
          generateReviewGuide: () => Effect.die("unused"),
        } satisfies ProviderTextGeneration;
      }),
    );

    assert.equal(loads, 0);
    const branch = yield* textGeneration.generateBranchName({
      cwd: process.cwd(),
      message: "test",
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" },
    });
    const title = yield* textGeneration.generateThreadTitle({
      cwd: process.cwd(),
      message: "test",
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" },
    });
    assert.equal(branch.branch, "feat/test");
    assert.equal(title.title, "Title");
    assert.equal(loads, 1);
  }),
);

it.layer(layerDriverTest)("lazy provider drivers and adapter infrastructure", (it) => {
  it.effect(
    "creates Claude, Codex, and Antigravity drivers without importing heavy adapter modules",
    () =>
      Effect.gen(function* () {
        assert.deepEqual(hooks.loaded, []);

        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "zerocode-lazy-drivers-" });
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;

        const claudeId = ProviderInstanceId.make("claude-lazy");
        const codexId = ProviderInstanceId.make("codex-lazy");
        const antigravityId = ProviderInstanceId.make("antigravity-lazy");

        const claude = yield* ClaudeDriver.create({
          instanceId: claudeId,
          displayName: "Claude",
          enabled: false,
          environment: [],
          config: ClaudeDriver.defaultConfig(),
        });
        const codex = yield* CodexDriver.create({
          instanceId: codexId,
          displayName: "Codex",
          enabled: false,
          environment: [],
          config: { ...CodexDriver.defaultConfig(), homePath: tempDir },
        });
        const antigravity = yield* AntigravityDriver.create({
          instanceId: antigravityId,
          displayName: "Antigravity",
          enabled: false,
          environment: [],
          config: AntigravityDriver.defaultConfig(),
        });

        assert.deepEqual(
          yield* claude.orchestrationAdapter.getCapabilities(),
          CLAUDE_PROVIDER_CAPABILITIES,
        );
        assert.deepEqual(
          yield* codex.orchestrationAdapter.getCapabilities(),
          CODEX_PROVIDER_CAPABILITIES,
        );
        assert.deepEqual(yield* antigravity.orchestrationAdapter.getCapabilities(), {
          ...ANTIGRAVITY_PROVIDER_CAPABILITIES,
          turns: {
            ...ANTIGRAVITY_PROVIDER_CAPABILITIES.turns,
            supportsNativeGoals: false,
          },
        });
        assert.isTrue(yield* mcpSessions.areApprovalRequestsShown(claudeId));
        assert.isTrue(yield* mcpSessions.areApprovalRequestsShown(codexId));
        assert.deepEqual(hooks.loaded, []);

        const [ClaudeAdapterV2, CodexAdapterV2, AntigravityAdapterV2] = yield* Effect.promise(() =>
          Promise.all([
            import("../../orchestration-v2/Adapters/ClaudeAdapterV2.ts"),
            import("../../orchestration-v2/Adapters/CodexAdapterV2.ts"),
            import("../../orchestration-v2/Adapters/AntigravityAdapterV2.ts"),
          ]),
        );

        assert.deepEqual(
          CLAUDE_PROVIDER_CAPABILITIES,
          ClaudeAdapterV2.ClaudeProviderCapabilitiesV2,
        );
        assert.deepEqual(CODEX_PROVIDER_CAPABILITIES, CodexAdapterV2.CodexProviderCapabilitiesV2);

        const antigravityFlavor = AntigravityAdapterV2.makeAntigravityAcpAdapterFlavor({
          instanceId: antigravityId,
          selfInvocation: { command: process.execPath, entrypoint: undefined },
          makeRuntime: () => Effect.die("unused"),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
          random: yield* SecureRandom.SecureRandom,
          fileSystem: yield* FileSystem.FileSystem,
          path: yield* Path.Path,
          host: yield* ProviderHost.ProviderHost,
        });
        assert.deepEqual<unknown>(
          ANTIGRAVITY_PROVIDER_CAPABILITIES,
          antigravityFlavor.capabilities,
        );

        // Lazy infrastructure services occupy the exact Context keys read by the real adapters.
        const queryRunner = yield* Effect.exit(
          Effect.service(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner),
        );
        const codexFactory = yield* Effect.exit(
          Effect.service(CodexAdapterV2.CodexAppServerClientFactory),
        );
        assert.isTrue(Exit.isSuccess(queryRunner));
        assert.isTrue(Exit.isSuccess(codexFactory));
      }).pipe(Effect.scoped),
  );
});
