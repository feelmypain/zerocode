import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { CheckpointRef } from "@zerocode/contracts";
import * as HostProcess from "@zerocode/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import {
  isMutatingGitArgs,
  makeGitRepoMetadataCache,
  resolveHeadFromGitDirs,
} from "./GitRepoMetadataCache.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import * as VcsProcess from "./VcsProcess.ts";

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "zerocode-git-metadata-cache-test-",
});
const layerTest = Layer.mergeAll(GitVcsDriver.layer, GitVcsDriver.layerVcs).pipe(
  Layer.provideMerge(layerServerConfig),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    return (yield* driver.execute({
      operation: "GitRepoMetadataCache.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    })).stdout.trim();
  });

const initCommittedRepo = Effect.fn("test.initCommittedRepo")(function* (cwd: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* runGit(cwd, ["init", "-b", "main"]);
  yield* runGit(cwd, ["config", "user.name", "Cache Tester"]);
  yield* runGit(cwd, ["config", "user.email", "cache@example.test"]);
  yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "hello\n");
  yield* runGit(cwd, ["add", "README.md"]);
  yield* runGit(cwd, ["commit", "-m", "initial"]);
});

const gitSubcommand = (args: ReadonlyArray<string>): string | undefined => {
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (arg === "-C" || arg === "-c" || arg === "--git-dir") {
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    return arg;
  }
  return undefined;
};

describe("GitRepoMetadataCache", () => {
  it.effect(
    "trims warm local status refresh to two parallel spawns and caches repeated config reads",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "zerocode-warm-status-",
          });
          yield* initCommittedRepo(cwd);
          yield* runGit(cwd, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
          yield* runGit(cwd, ["config", "zerocode.custom", "enabled"]);

          const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
          const spawnedArgs: Array<ReadonlyArray<string>> = [];
          const spawner = ChildProcessSpawner.make((command) => {
            if (ChildProcess.isStandardCommand(command)) {
              spawnedArgs.push(command.args.map(String));
            }
            return delegate.spawn(command);
          });
          const driver = yield* makeGitVcsDriverCore().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );

          const cold = yield* driver.statusDetailsLocal(cwd);
          assert.isTrue(cold.isRepo);
          assert.strictEqual(cold.branch, "main");
          assert.isTrue(cold.hasOriginRemote);
          assert.isTrue(spawnedArgs.some((args) => gitSubcommand(args) === "rev-parse"));
          assert.isTrue(spawnedArgs.some((args) => gitSubcommand(args) === "config"));

          spawnedArgs.length = 0;
          const warm = yield* driver.statusDetailsLocal(cwd);
          assert.isTrue(warm.isRepo);
          assert.strictEqual(warm.branch, "main");
          assert.sameMembers(spawnedArgs.map(gitSubcommand), ["status", "diff-index"]);

          // Adding a file mutates cwd's directory mtime without invalidating repository metadata.
          yield* fileSystem.writeFileString(path.join(cwd, "added.txt"), "new\n");
          spawnedArgs.length = 0;
          const afterEdit = yield* driver.statusDetailsLocal(cwd);
          assert.isTrue(afterEdit.hasWorkingTreeChanges);
          assert.sameMembers(spawnedArgs.map(gitSubcommand), ["status", "diff-index"]);

          spawnedArgs.length = 0;
          assert.strictEqual(yield* driver.readConfigValue(cwd, "user.name"), "Cache Tester");
          assert.strictEqual(
            yield* driver.readConfigValue(cwd, "user.email"),
            "cache@example.test",
          );
          assert.strictEqual(
            yield* driver.readConfigValue(cwd, "remote.origin.url"),
            "https://example.invalid/repo.git",
          );
          assert.strictEqual(yield* driver.readConfigValue(cwd, "zerocode.custom"), "enabled");
          assert.deepStrictEqual(spawnedArgs, []);
        }),
      ).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "invalidates cached git config immediately when .git/config, config.worktree, or global config changes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "zerocode-config-mtime-",
          });
          const worktreeParent = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "zerocode-config-wt-",
          });
          const worktreePath = path.join(worktreeParent, "linked");
          const globalConfigDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "zerocode-global-cfg-",
          });
          const globalConfigPath = path.join(globalConfigDir, "gitconfig");
          yield* fileSystem.writeFileString(globalConfigPath, "[zerocode]\n\tglobalKey = first\n");

          yield* initCommittedRepo(cwd);
          yield* runGit(cwd, ["worktree", "add", "-b", "wt-branch", worktreePath, "HEAD"]);
          yield* runGit(cwd, ["config", "extensions.worktreeConfig", "true"]);

          const hostEnv = yield* HostProcess.Environment;
          const envWithGlobal = {
            ...hostEnv,
            GIT_CONFIG_GLOBAL: globalConfigPath,
            GIT_CONFIG_NOSYSTEM: "1",
          };

          const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
          const spawnedArgs: Array<ReadonlyArray<string>> = [];
          const spawner = ChildProcessSpawner.make((command) => {
            if (ChildProcess.isStandardCommand(command)) {
              spawnedArgs.push(command.args.map(String));
            }
            return delegate.spawn(command);
          });
          const driver = yield* makeGitVcsDriverCore().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );

          yield* Effect.gen(function* () {
            assert.strictEqual(yield* driver.readConfigValue(cwd, "zerocode.globalKey"), "first");
            assert.strictEqual(
              yield* driver.readConfigValue(worktreePath, "zerocode.globalKey"),
              "first",
            );
            spawnedArgs.length = 0;
            assert.strictEqual(yield* driver.readConfigValue(cwd, "zerocode.globalKey"), "first");
            assert.strictEqual(
              yield* driver.readConfigValue(worktreePath, "zerocode.globalKey"),
              "first",
            );
            assert.deepStrictEqual(spawnedArgs, []);

            const repoConfigPath = path.join(cwd, ".git", "config");
            const originalConfig = yield* fileSystem.readFileString(repoConfigPath);
            yield* fileSystem.writeFileString(
              repoConfigPath,
              `${originalConfig}\n[zerocode]\n\tshared = updated\n`,
            );
            yield* fileSystem.utimes(repoConfigPath, 1_900_000_000, 1_900_000_000);
            assert.strictEqual(yield* driver.readConfigValue(cwd, "zerocode.shared"), "updated");
            assert.strictEqual(
              yield* driver.readConfigValue(worktreePath, "zerocode.shared"),
              "updated",
            );

            spawnedArgs.length = 0;
            const worktreeGitDir = yield* runGit(worktreePath, [
              "rev-parse",
              "--path-format=absolute",
              "--git-dir",
            ]);
            const worktreeConfigPath = path.join(worktreeGitDir, "config.worktree");
            yield* fileSystem.writeFileString(
              worktreeConfigPath,
              "[zerocode]\n\tshared = wt-only\n",
            );
            assert.strictEqual(
              yield* driver.readConfigValue(worktreePath, "zerocode.shared"),
              "wt-only",
            );
            assert.strictEqual(
              spawnedArgs.filter((args) => gitSubcommand(args) === "config").length,
              1,
            );
            spawnedArgs.length = 0;
            assert.strictEqual(yield* driver.readConfigValue(cwd, "zerocode.shared"), "updated");
            assert.deepStrictEqual(spawnedArgs, []);

            yield* fileSystem.writeFileString(
              globalConfigPath,
              "[zerocode]\n\tglobalKey = second\n",
            );
            yield* fileSystem.utimes(globalConfigPath, 1_900_000_100, 1_900_000_100);
            assert.strictEqual(yield* driver.readConfigValue(cwd, "zerocode.globalKey"), "second");
            assert.strictEqual(
              yield* driver.readConfigValue(worktreePath, "zerocode.globalKey"),
              "second",
            );
          }).pipe(Effect.provideService(HostProcess.Environment, envWithGlobal));
        }),
      ).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "drops cached metadata on repo re-init, worktree removal, nested init, and explicit mutations",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "zerocode-meta-invalidation-",
          });
          const worktreeParent = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "zerocode-meta-wt-",
          });
          const worktreePath = path.join(worktreeParent, "wt");
          yield* initCommittedRepo(cwd);
          yield* runGit(cwd, ["worktree", "add", "-b", "temp-wt", worktreePath, "HEAD"]);

          const nestedDir = path.join(cwd, "nested");
          yield* fileSystem.makeDirectory(nestedDir, { recursive: true });

          const driver = yield* makeGitVcsDriverCore();

          assert.isTrue((yield* driver.statusDetailsLocal(cwd)).isRepo);
          const nestedBefore = yield* driver.statusDetailsLocal(nestedDir);
          assert.isTrue(nestedBefore.isRepo);
          assert.strictEqual(
            yield* fileSystem.realPath(nestedBefore.workingTree.rootPath!),
            yield* fileSystem.realPath(cwd),
          );
          assert.isTrue((yield* driver.statusDetailsLocal(worktreePath)).isRepo);

          yield* driver.removeWorktree({ cwd, path: worktreePath, force: true });
          assert.isFalse((yield* driver.statusDetailsLocal(worktreePath)).isRepo);

          yield* runGit(nestedDir, ["init", "-b", "nested-main"]);
          const nestedAfter = yield* driver.statusDetailsLocal(nestedDir);
          assert.isTrue(nestedAfter.isRepo);
          assert.strictEqual(nestedAfter.branch, "nested-main");
          assert.strictEqual(
            yield* fileSystem.realPath(nestedAfter.workingTree.rootPath!),
            yield* fileSystem.realPath(nestedDir),
          );

          assert.strictEqual(yield* driver.readConfigValue(cwd, "zerocode.flag"), null);
          yield* driver.writeConfigValue({ cwd, key: "zerocode.flag", value: "yes" });
          assert.strictEqual(yield* driver.readConfigValue(cwd, "zerocode.flag"), "yes");

          yield* fileSystem.remove(path.join(cwd, ".git"), { recursive: true });
          assert.isFalse((yield* driver.statusDetailsLocal(cwd)).isRepo);
          yield* runGit(cwd, ["init", "-b", "reborn"]);
          const reborn = yield* driver.statusDetailsLocal(cwd);
          assert.isTrue(reborn.isRepo);
          assert.strictEqual(reborn.branch, "reborn");
        }),
      ).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["main", "worktree"] as const)(
    "avoids redundant rev-parse and config spawns on warm checkpoint capture (%s)",
    (mode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const repoDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: `zerocode-warm-checkpoint-${mode}-`,
          });
          yield* initCommittedRepo(repoDir);
          let captureCwd = repoDir;
          if (mode === "worktree") {
            const wtParent = yield* fileSystem.makeTempDirectoryScoped({
              prefix: "zerocode-warm-checkpoint-wt-",
            });
            captureCwd = path.join(wtParent, "linked");
            yield* runGit(repoDir, ["worktree", "add", "-b", "wt-cap", captureCwd, "HEAD"]);
          }

          const liveProcess = yield* VcsProcess.VcsProcess;
          const commands: Array<string | undefined> = [];
          const vcsDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
            Effect.provideService(VcsProcess.VcsProcess, {
              run: (input) => {
                commands.push(gitSubcommand(input.args));
                return liveProcess.run(input);
              },
            }),
          );

          const ref1 = CheckpointRef.make("refs/zerocode/checkpoints/warm/1");
          const ref2 = CheckpointRef.make("refs/zerocode/checkpoints/warm/2");
          const ref3 = CheckpointRef.make("refs/zerocode/checkpoints/warm/3");

          yield* vcsDriver.checkpoints.captureCheckpoint({ cwd: captureCwd, checkpointRef: ref1 });
          assert.strictEqual(commands.filter((cmd) => cmd === "rev-parse").length, 1);
          assert.strictEqual(commands.filter((cmd) => cmd === "config").length, 1);

          commands.length = 0;
          assert.isTrue(yield* vcsDriver.isInsideWorkTree(captureCwd));
          assert.isNotNull(yield* vcsDriver.detectRepository(captureCwd));
          assert.deepStrictEqual(commands, []);

          yield* fileSystem.writeFileString(path.join(captureCwd, "README.md"), "second commit\n");
          yield* runGit(captureCwd, ["add", "README.md"]);
          yield* runGit(captureCwd, ["commit", "-m", "second"]);
          const expectedHead = yield* runGit(captureCwd, ["rev-parse", "HEAD"]);
          yield* fileSystem.writeFileString(path.join(captureCwd, "draft.txt"), "warm capture\n");

          commands.length = 0;
          yield* vcsDriver.checkpoints.captureCheckpoint({
            cwd: captureCwd,
            checkpointRef: ref2,
            previousCheckpointRef: ref1,
          });
          assert.strictEqual(commands.filter((cmd) => cmd === "rev-parse").length, 0);
          assert.strictEqual(commands.filter((cmd) => cmd === "config").length, 0);
          assert.strictEqual(
            yield* runGit(captureCwd, ["show", `${ref2}:draft.txt`]),
            "warm capture",
          );
          const parents = (yield* runGit(captureCwd, ["rev-list", "--parents", "-n", "1", ref2]))
            .split(" ")
            .slice(1);
          assert.deepStrictEqual(parents, [expectedHead]);

          yield* runGit(captureCwd, ["config", "core.autocrlf", "false"]);
          commands.length = 0;
          yield* vcsDriver.checkpoints.captureCheckpoint({
            cwd: captureCwd,
            checkpointRef: ref3,
            previousCheckpointRef: ref2,
          });
          assert.strictEqual(commands.filter((cmd) => cmd === "rev-parse").length, 0);
          assert.strictEqual(commands.filter((cmd) => cmd === "config").length, 1);
        }),
      ).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "enforces LRU bounds and resolves HEAD across loose, packed, detached, and unborn refs",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const hostPlatform = yield* HostProcess.Platform;

          const cache = makeGitRepoMetadataCache({
            fileSystem,
            path,
            hostPlatform,
            metadataCapacity: 2,
            configCapacity: 2,
          });

          const repos = yield* Effect.forEach(["a", "b", "c"], (label) =>
            Effect.gen(function* () {
              const dir = yield* fileSystem.makeTempDirectoryScoped({
                prefix: `zerocode-lru-${label}-`,
              });
              yield* runGit(dir, ["init", "-b", "main"]);
              const gitDir = yield* fileSystem.realPath(path.join(dir, ".git"));
              const worktreeRoot = yield* fileSystem.realPath(dir);
              return {
                dir,
                metadata: {
                  gitCommonDir: gitDir,
                  gitDir,
                  indexPath: path.join(gitDir, "index"),
                  worktreeRoot,
                  prefix: "",
                  isAtRepositoryRoot: true,
                },
              };
            }),
          );

          const [repoA, repoB, repoC] = repos as [
            (typeof repos)[number],
            (typeof repos)[number],
            (typeof repos)[number],
          ];

          yield* cache.setMetadata(repoA.dir, repoA.metadata);
          yield* cache.setMetadata(repoB.dir, repoB.metadata);
          assert.isNotNull(yield* cache.getMetadata(repoA.dir));
          yield* cache.setMetadata(repoC.dir, repoC.metadata);

          assert.strictEqual(cache.metadataSize, 2);
          assert.isNotNull(yield* cache.getMetadata(repoA.dir));
          assert.isNull(yield* cache.getMetadata(repoB.dir));
          assert.isNotNull(yield* cache.getMetadata(repoC.dir));

          let configLoads = 0;
          const loadConfig = (label: string) =>
            Effect.sync(() => {
              configLoads += 1;
              return {
                exitCode: 0,
                stdout: `file:${label}\0zerocode.repo\n${label}\0`,
                stdoutTruncated: false,
              };
            });
          yield* cache.getOrLoadConfigSnapshot(repoA.dir, () => loadConfig(repoA.dir));
          yield* cache.getOrLoadConfigSnapshot(repoB.dir, () => loadConfig(repoB.dir));
          yield* cache.getOrLoadConfigSnapshot(repoA.dir, () => loadConfig(repoA.dir));
          yield* cache.getOrLoadConfigSnapshot(repoC.dir, () => loadConfig(repoC.dir));
          assert.strictEqual(cache.configSize, 2);
          assert.strictEqual(configLoads, 3);
          yield* cache.getOrLoadConfigSnapshot(repoA.dir, () => loadConfig(repoA.dir));
          assert.strictEqual(configLoads, 3);
          yield* cache.getOrLoadConfigSnapshot(repoB.dir, () => loadConfig(repoB.dir));
          assert.strictEqual(configLoads, 4);

          cache.invalidate(repoA.metadata.gitCommonDir);
          assert.isNull(yield* cache.getMetadata(repoA.dir));
          assert.strictEqual(cache.metadataSize, 1);
          assert.strictEqual(cache.configSize, 1);

          const headDir = repoA.dir;
          const headGitDir = repoA.metadata.gitDir;
          assert.deepStrictEqual(
            yield* resolveHeadFromGitDirs(fileSystem, path, headGitDir, headGitDir),
            { headExists: false, head: undefined },
          );

          yield* runGit(headDir, ["config", "user.name", "Head Tester"]);
          yield* runGit(headDir, ["config", "user.email", "head@example.test"]);
          yield* runGit(headDir, ["commit", "--allow-empty", "-m", "first"]);
          const firstOid = yield* runGit(headDir, ["rev-parse", "HEAD"]);
          assert.deepStrictEqual(
            yield* resolveHeadFromGitDirs(fileSystem, path, headGitDir, headGitDir),
            { headExists: true, head: firstOid },
          );

          yield* runGit(headDir, ["pack-refs", "--all"]);
          assert.deepStrictEqual(
            yield* resolveHeadFromGitDirs(fileSystem, path, headGitDir, headGitDir),
            { headExists: true, head: firstOid },
          );

          yield* runGit(headDir, ["checkout", "--detach", firstOid]);
          assert.deepStrictEqual(
            yield* resolveHeadFromGitDirs(fileSystem, path, headGitDir, headGitDir),
            { headExists: true, head: firstOid },
          );
        }),
      ).pipe(Effect.provide(layerTest)),
  );

  it("classifies read-only vs mutating git subcommands accurately", () => {
    assert.isFalse(isMutatingGitArgs(["status", "--porcelain=2"]));
    assert.isFalse(isMutatingGitArgs(["rev-parse", "--git-common-dir"]));
    assert.isFalse(isMutatingGitArgs(["config", "--get", "user.name"]));
    assert.isFalse(isMutatingGitArgs(["config", "--list", "--show-origin", "-z"]));
    assert.isFalse(isMutatingGitArgs(["config", "--bool", "core.sparseCheckout"]));
    assert.isFalse(isMutatingGitArgs(["remote", "-v"]));
    assert.isFalse(isMutatingGitArgs(["remote", "get-url", "--", "origin"]));
    assert.isFalse(isMutatingGitArgs(["branch", "--list"]));
    assert.isFalse(isMutatingGitArgs(["branch", "--show-current"]));
    assert.isFalse(isMutatingGitArgs(["worktree", "list", "--porcelain"]));
    assert.isFalse(isMutatingGitArgs(["worktree", "add", "-h"]));
    assert.isFalse(isMutatingGitArgs(["submodule", "foreach", "--quiet", "echo hi"]));

    assert.isTrue(isMutatingGitArgs(["init"]));
    assert.isTrue(isMutatingGitArgs(["clone", "https://example.invalid/repo.git"]));
    assert.isTrue(isMutatingGitArgs(["-C", "/repo", "checkout", "main"]));
    assert.isTrue(isMutatingGitArgs(["switch", "-c", "feat"]));
    assert.isTrue(isMutatingGitArgs(["config", "user.name", "Alice"]));
    assert.isTrue(isMutatingGitArgs(["config", "--unset", "user.name"]));
    assert.isTrue(isMutatingGitArgs(["config", "--add", "remote.origin.fetch", "+refs/*:refs/*"]));
    assert.isTrue(
      isMutatingGitArgs(["remote", "add", "origin", "https://example.invalid/repo.git"]),
    );
    assert.isTrue(isMutatingGitArgs(["branch", "-d", "old"]));
    assert.isTrue(isMutatingGitArgs(["branch", "--set-upstream-to=origin/main", "main"]));
    assert.isTrue(isMutatingGitArgs(["worktree", "add", "/tmp/wt", "HEAD"]));
    assert.isTrue(isMutatingGitArgs(["worktree", "remove", "/tmp/wt"]));
    assert.isTrue(isMutatingGitArgs(["sparse-checkout", "set", "src"]));
  });
});
