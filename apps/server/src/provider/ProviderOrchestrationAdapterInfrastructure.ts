import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import type * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type * as PortScanner from "../preview/PortScanner.ts";
import * as ProviderProcesses from "../process/providerProcesses.ts";
import type * as CursorAgentSdk from "@zerocode/provider-cursor/server/CursorAgentSdk";
import * as CursorSdk from "@zerocode/provider-cursor/server/CursorSdk";
import * as IdAllocator from "@zerocode/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@zerocode/provider-core/server/ProviderContinuationRequests";
import type * as ProviderEventLoggers from "@zerocode/provider-core/server/ProviderEventLoggers";
import * as HostProcess from "@zerocode/shared/HostProcess";

export type ProviderOrchestrationAdapterInfrastructure =
  | ClaudeAdapterV2.ClaudeAgentSdkQueryRunner
  | CodexAdapterV2.CodexAppServerClientFactory
  | CursorAgentSdk.CursorAgentSdkRunner
  | CursorSdk.CursorSdk
  | IdAllocator.IdAllocatorV2;

// Keys match the service identifiers in the lazily imported adapter modules so
// Context lookups and test overrides resolve the same slot without eager imports.
const ClaudeAgentSdkQueryRunnerKey = Context.Service<
  ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
  ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape
>("zerocode/orchestration-v2/Adapters/ClaudeAdapterV2/ClaudeAgentSdkQueryRunner");

const CodexAppServerClientFactoryKey = Context.Service<
  CodexAdapterV2.CodexAppServerClientFactory,
  CodexAdapterV2.CodexAppServerClientFactoryShape
>("zerocode/orchestration-v2/Adapters/CodexAdapterV2/CodexAppServerClientFactory");

const CursorAgentSdkRunnerKey = Context.Service<
  CursorAgentSdk.CursorAgentSdkRunner,
  CursorAgentSdk.CursorAgentSdkRunner["Service"]
>("@zerocode/provider-cursor/server/CursorAgentSdk/CursorAgentSdkRunner");

// Subagent threads created before short ids keep their stored id when an adapter resumes them.
export const layerIdAllocator = Layer.unwrap(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId" FROM orchestration_v2_projection_threads
      WHERE thread_id LIKE 'thread:provider:%'
    `.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("orchestration-v2.legacy-subagent-thread-ids-unavailable", {
          cause,
        }).pipe(Effect.as([])),
      ),
    );
    return IdAllocator.layerWithLegacySubagentThreads(new Set(rows.map((row) => row.threadId)));
  }),
);

const resolveCursorWorkerLaunch = Effect.gen(function* () {
  const path = yield* Path.Path;
  const command = yield* HostProcess.ExecutablePath;
  const isExecutable = yield* HostProcess.IsExecutable;
  const providerProcesses = yield* ProviderProcesses.ProviderProcesses;
  // In a bundle import.meta.url is bin.mjs; development and tests use this source module.
  const entry = yield* path
    .fromFileUrl(
      new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "./bin.mjs", import.meta.url),
    )
    .pipe(Effect.orDie);
  return {
    command,
    args: [...(isExecutable ? [] : [entry]), "__cursor-sdk-worker"],
    ...(providerProcesses.register === undefined
      ? {}
      : { registerProcess: providerProcesses.register }),
  };
});

const layerLazyClaudeQueryRunner: Layer.Layer<
  ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | Path.Path
  | PortScanner.PortDiscovery
  | ProviderEventLoggers.ProviderEventLoggers
> = Layer.effect(
  ClaudeAgentSdkQueryRunnerKey,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      | ChildProcessSpawner.ChildProcessSpawner
      | SecureRandom.SecureRandom
      | Path.Path
      | PortScanner.PortDiscovery
      | ProviderEventLoggers.ProviderEventLoggers
    >();
    const layerScope = yield* Scope.Scope;
    const lock = yield* Semaphore.make(1);
    let resolved: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape | undefined;

    const resolve = Effect.suspend(() => {
      if (resolved !== undefined) return Effect.succeed(resolved);
      return lock.withPermits(1)(
        Effect.suspend(() => {
          if (resolved !== undefined) return Effect.succeed(resolved);
          return Effect.promise(
            () => import("../orchestration-v2/Adapters/ClaudeAdapterV2.ts"),
          ).pipe(
            Effect.flatMap((ClaudeAdapterV2) =>
              Layer.buildWithScope(ClaudeAdapterV2.layerQueryRunner, layerScope).pipe(
                Effect.map((built) =>
                  Context.get(built, ClaudeAdapterV2.ClaudeAgentSdkQueryRunner),
                ),
              ),
            ),
            Effect.provideContext(context),
            Effect.tap((service) =>
              Effect.sync(() => {
                resolved = service;
              }),
            ),
          );
        }),
      );
    });

    return ClaudeAgentSdkQueryRunnerKey.of({
      allocateSessionId: resolve.pipe(Effect.flatMap((service) => service.allocateSessionId)),
      open: Effect.fnUntraced(function* (input) {
        const service = yield* resolve;
        return yield* service.open(input);
      }),
      forkSession: Effect.fnUntraced(function* (input) {
        const service = yield* resolve;
        return yield* service.forkSession(input);
      }),
      subagentLaunchToolUseId: Effect.fnUntraced(function* (input) {
        const service = yield* resolve;
        return yield* service.subagentLaunchToolUseId(input);
      }),
      subagentModel: Effect.fnUntraced(function* (input) {
        const service = yield* resolve;
        return yield* service.subagentModel(input);
      }),
      assertComplete: resolve.pipe(Effect.flatMap((service) => service.assertComplete)),
    });
  }),
);

const layerLazyCodexAppServerClientFactory: Layer.Layer<
  CodexAdapterV2.CodexAppServerClientFactory,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | PortScanner.PortDiscovery
  | ProviderEventLoggers.ProviderEventLoggers
> = Layer.effect(
  CodexAppServerClientFactoryKey,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      | ChildProcessSpawner.ChildProcessSpawner
      | PortScanner.PortDiscovery
      | ProviderEventLoggers.ProviderEventLoggers
    >();
    const layerScope = yield* Scope.Scope;
    const lock = yield* Semaphore.make(1);
    let resolved: CodexAdapterV2.CodexAppServerClientFactoryShape | undefined;

    const resolve = Effect.suspend(() => {
      if (resolved !== undefined) return Effect.succeed(resolved);
      return lock.withPermits(1)(
        Effect.suspend(() => {
          if (resolved !== undefined) return Effect.succeed(resolved);
          return Effect.promise(
            () => import("../orchestration-v2/Adapters/CodexAdapterV2.ts"),
          ).pipe(
            Effect.flatMap((CodexAdapterV2) =>
              Layer.buildWithScope(CodexAdapterV2.layerAppServerClientFactory, layerScope).pipe(
                Effect.map((built) =>
                  Context.get(built, CodexAdapterV2.CodexAppServerClientFactory),
                ),
              ),
            ),
            Effect.provideContext(context),
            Effect.tap((service) =>
              Effect.sync(() => {
                resolved = service;
              }),
            ),
          );
        }),
      );
    });

    return CodexAppServerClientFactoryKey.of({
      open: Effect.fnUntraced(function* (input) {
        const service = yield* resolve;
        return yield* service.open(input);
      }),
    });
  }),
);

const layerLazyCursorAgentSdkProcessRunner: Layer.Layer<
  CursorAgentSdk.CursorAgentSdkRunner,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Path.Path | ProviderEventLoggers.ProviderEventLoggers
> = Layer.effect(
  CursorAgentSdkRunnerKey,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      | ChildProcessSpawner.ChildProcessSpawner
      | Path.Path
      | ProviderEventLoggers.ProviderEventLoggers
    >();
    const path = yield* Path.Path;
    const layerScope = yield* Scope.Scope;
    const lock = yield* Semaphore.make(1);
    let resolved: CursorAgentSdk.CursorAgentSdkRunner["Service"] | undefined;

    const resolve = Effect.suspend(() => {
      if (resolved !== undefined) return Effect.succeed(resolved);
      return lock.withPermits(1)(
        Effect.suspend(() => {
          if (resolved !== undefined) return Effect.succeed(resolved);
          return Effect.promise(
            () => import("@zerocode/provider-cursor/server/CursorAgentSdkProcessRunner"),
          ).pipe(
            Effect.flatMap((CursorAgentSdkProcessRunner) =>
              Layer.buildWithScope(
                CursorAgentSdkProcessRunner.layer(
                  resolveCursorWorkerLaunch.pipe(Effect.provideService(Path.Path, path)),
                ),
                layerScope,
              ),
            ),
            Effect.provideContext(context),
            Effect.map((built) => {
              const service = Context.get(built, CursorAgentSdkRunnerKey);
              resolved = service;
              return service;
            }),
          );
        }),
      );
    });

    return CursorAgentSdkRunnerKey.of({
      open: Effect.fnUntraced(function* (input) {
        const service = yield* resolve;
        return yield* service.open(input);
      }),
      assertComplete: resolve.pipe(Effect.flatMap((service) => service.assertComplete)),
      textGenerate: Effect.fnUntraced(function* (input) {
        const service = yield* resolve;
        return yield* service.textGenerate!(input);
      }),
    });
  }),
);

/** Reuse the continuation worker's exact layer reference so memoization shares one queue. */
export const layer = Layer.mergeAll(
  layerLazyClaudeQueryRunner,
  layerLazyCodexAppServerClientFactory,
  layerLazyCursorAgentSdkProcessRunner,
  CursorSdk.layer,
  layerIdAllocator,
  ProviderContinuationRequests.layer,
);
