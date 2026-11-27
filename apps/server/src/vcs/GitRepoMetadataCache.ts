import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

import * as HostProcess from "@zerocode/shared/HostProcess";

const DEFAULT_CACHE_CAPACITY = 256;
const MAX_PACKED_REFS_BYTES = 8 * 1024 * 1024;
const HEX_OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const INCLUDE_IF_PATH_PATTERN = /^includeif\..+\.path$/;
const GIT_TRUE_PATTERN = /^(?:true|yes|on)$/i;
const GIT_FALSE_PATTERN = /^(?:false|no|off)$/i;
const GIT_INTEGER_PATTERN = /^\s*[+-]?(?:0x([\da-f]+)|([1-9]\d*|0[0-7]*))[kmg]?$/i;

const GIT_GLOBAL_FLAGS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
]);

const CONFIG_READ_FLAGS = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "--list",
  "-l",
  "-h",
  "--help",
]);

const CONFIG_WRITE_FLAGS = new Set([
  "--add",
  "--unset",
  "--unset-all",
  "--replace-all",
  "--rename-section",
  "--remove-section",
  "--edit",
  "-e",
]);

const CONFIG_FLAGS_WITH_VALUE = new Set([
  "-f",
  "--file",
  "--blob",
  "--type",
  "--default",
  "--fixed-value",
]);

const BRANCH_READ_FLAGS = new Set([
  "--list",
  "-l",
  "--show-current",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "-h",
  "--help",
]);

const REMOTE_READ_SUBCOMMANDS = new Set(["show", "get-url"]);
const SPARSE_READ_SUBCOMMANDS = new Set(["list", "check-rules"]);
const SUBMODULE_READ_SUBCOMMANDS = new Set(["status", "foreach", "summary"]);

interface GitRepoMetadata {
  readonly gitCommonDir: string;
  readonly gitDir: string;
  readonly indexPath: string;
  readonly worktreeRoot: string | null;
  readonly prefix: string;
  readonly isAtRepositoryRoot: boolean | undefined;
  readonly rawMetadataPath?: string | null;
}

interface GitConfigEntry {
  readonly key: string;
  readonly value: string | null;
}

interface GitConfigSnapshot {
  readonly rawListOutput: string;
  readonly entries: ReadonlyArray<GitConfigEntry>;
  readonly getLast: (key: string) => string | null | undefined;
  readonly getAll: (key: string) => ReadonlyArray<string | null>;
  readonly getBool: (key: string) => boolean | undefined;
  readonly matchRegexpNull: (pattern: RegExp) => {
    readonly exitCode: number;
    readonly stdout: string;
  };
}

interface GitConfigCommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
}

interface GitRepoMetadataCacheOptions {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly hostPlatform: NodeJS.Platform;
  readonly metadataCapacity?: number;
  readonly configCapacity?: number;
}

interface WatchedFile {
  readonly filePath: string;
  readonly token: string;
}

interface MetadataCacheEntry {
  readonly metadata: GitRepoMetadata;
  readonly watchedFiles: ReadonlyArray<WatchedFile>;
}

interface ConfigCacheEntry {
  readonly gitCommonDir: string;
  readonly gitDir: string;
  readonly envFingerprint: string;
  readonly watchedFiles: ReadonlyArray<WatchedFile>;
  readonly associatedCwds: Set<string>;
  readonly snapshot: GitConfigSnapshot;
}

interface InFlightLoad<A, E> {
  readonly generation: number;
  readonly deferred: Deferred.Deferred<A, E>;
}

class LruMap<K, V> {
  readonly #entries = new Map<K, V>();
  readonly #capacity: number;

  constructor(capacity: number) {
    this.#capacity = Math.max(1, capacity);
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  peek(key: K): V | undefined {
    return this.#entries.get(key);
  }

  set(key: K, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  deleteWhere(predicate: (value: V, key: K) => boolean): void {
    for (const [key, value] of this.#entries) {
      if (predicate(value, key)) this.#entries.delete(key);
    }
  }
}

function normalizeGitConfigKey(key: string): string {
  const firstDot = key.indexOf(".");
  if (firstDot === -1) return key.toLowerCase();
  const lastDot = key.lastIndexOf(".");
  if (firstDot === lastDot) return key.toLowerCase();
  return `${key.slice(0, firstDot).toLowerCase()}${key.slice(firstDot, lastDot)}${key.slice(lastDot).toLowerCase()}`;
}

function parseGitBool(value: string | null): boolean | undefined {
  if (value === null) return true;
  if (value === "" || GIT_FALSE_PATTERN.test(value)) return false;
  if (GIT_TRUE_PATTERN.test(value)) return true;
  const integer = GIT_INTEGER_PATTERN.exec(value);
  if (integer === null) return undefined;
  return /[1-9a-f]/i.test(integer[1] ?? integer[2]!);
}

function buildConfigSnapshot(entries: ReadonlyArray<GitConfigEntry>): GitConfigSnapshot {
  const valuesByKey = new Map<string, Array<string | null>>();
  const rawParts: Array<string> = [];
  for (const entry of entries) {
    let list = valuesByKey.get(entry.key);
    if (list === undefined) {
      list = [];
      valuesByKey.set(entry.key, list);
    }
    list.push(entry.value);
    rawParts.push(entry.value === null ? entry.key : `${entry.key}\n${entry.value}`);
  }
  const rawListOutput = rawParts.length === 0 ? "" : `${rawParts.join("\0")}\0`;

  return {
    rawListOutput,
    entries,
    getLast: (key) => valuesByKey.get(normalizeGitConfigKey(key))?.at(-1),
    getAll: (key) => valuesByKey.get(normalizeGitConfigKey(key)) ?? [],
    getBool: (key) => {
      const value = valuesByKey.get(normalizeGitConfigKey(key))?.at(-1);
      return value === undefined ? undefined : parseGitBool(value);
    },
    matchRegexpNull: (pattern) => {
      const matched: Array<string> = [];
      for (const entry of entries) {
        if (!pattern.test(entry.key)) continue;
        matched.push(entry.value === null ? entry.key : `${entry.key}\n${entry.value}`);
      }
      return matched.length === 0
        ? { exitCode: 1, stdout: "" }
        : { exitCode: 0, stdout: `${matched.join("\0")}\0` };
    },
  };
}

function parseConfigListWithOrigin(
  stdout: string,
  path: Path.Path,
  physicalCwd: string,
  homeDir: string,
): {
  readonly snapshot: GitConfigSnapshot;
  readonly discoveredFiles: ReadonlyArray<string>;
  readonly hasUnwatchableInclude: boolean;
} {
  const entries: Array<GitConfigEntry> = [];
  const discoveredFiles = new Set<string>();
  let hasUnwatchableInclude = false;

  const parts = stdout.split("\0");
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const origin = parts[index]!;
    const rawEntry = parts[index + 1]!;
    if (origin === "" && rawEntry === "") continue;

    let originFile: string | null = null;
    if (origin.startsWith("file:")) {
      const rawOriginPath = origin.slice("file:".length);
      if (rawOriginPath.length > 0) {
        originFile = path.isAbsolute(rawOriginPath)
          ? path.normalize(rawOriginPath)
          : path.resolve(physicalCwd, rawOriginPath);
        discoveredFiles.add(originFile);
      }
    }

    const newline = rawEntry.indexOf("\n");
    const key = newline === -1 ? rawEntry : rawEntry.slice(0, newline);
    const value = newline === -1 ? null : rawEntry.slice(newline + 1);
    entries.push({ key, value });

    if (
      value !== null &&
      value.length > 0 &&
      (key === "include.path" || INCLUDE_IF_PATH_PATTERN.test(key))
    ) {
      if (value.startsWith("~/")) {
        if (homeDir.length > 0) {
          discoveredFiles.add(path.join(homeDir, value.slice(2)));
        } else {
          hasUnwatchableInclude = true;
        }
      } else if (value.startsWith("~") || value.startsWith("%(prefix)/")) {
        hasUnwatchableInclude = true;
      } else if (path.isAbsolute(value)) {
        discoveredFiles.add(path.normalize(value));
      } else if (originFile !== null) {
        discoveredFiles.add(path.resolve(path.dirname(originFile), value));
      } else {
        hasUnwatchableInclude = true;
      }
    }
  }

  return {
    snapshot: buildConfigSnapshot(entries),
    discoveredFiles: [...discoveredFiles],
    hasUnwatchableInclude,
  };
}

function readEnvValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return env[name];
  const upper = name.toUpperCase();
  let value: string | undefined;
  for (const [key, candidate] of Object.entries(env)) {
    if (key.toUpperCase() === upper) value = candidate;
  }
  return value;
}

function buildConfigEnvFingerprint(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const relevant: Array<string> = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const normalized = platform === "win32" ? key.toUpperCase() : key;
    if (
      normalized === "HOME" ||
      normalized === "XDG_CONFIG_HOME" ||
      normalized === "GIT_CONFIG" ||
      normalized === "GIT_CONFIG_GLOBAL" ||
      normalized === "GIT_CONFIG_SYSTEM" ||
      normalized === "GIT_CONFIG_NOSYSTEM" ||
      normalized === "GIT_CONFIG_PARAMETERS" ||
      normalized === "GIT_CONFIG_COUNT" ||
      normalized.startsWith("GIT_CONFIG_KEY_") ||
      normalized.startsWith("GIT_CONFIG_VALUE_")
    ) {
      relevant.push(`${normalized}=${value}`);
    }
  }
  relevant.sort();
  return relevant.join("\0");
}

function isSameOrSubpath(path: Path.Path, candidate: string, parent: string): boolean {
  if (candidate === parent) return true;
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

const statToken = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.stat(filePath).pipe(
    Effect.map((info): string | null => {
      const ino = Option.getOrElse(info.ino, () => "");
      if (info.type === "Directory") {
        // Directory mtime changes on temp files and commits; identity is type, device, inode and birthtime.
        const birthtime = Option.match(info.birthtime, {
          onNone: () => "",
          onSome: (date) => date.getTime(),
        });
        return `Directory:${info.dev}:${ino}:${birthtime}`;
      }
      const mtime = Option.match(info.mtime, {
        onNone: () => "",
        onSome: (date) => date.getTime(),
      });
      return `${info.type}:${info.dev}:${ino}:${info.size}:${mtime}`;
    }),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed<string | null>("-")),
    Effect.orElseSucceed((): string | null => null),
  );

// Reads HEAD directly from files-backend refs when unambiguous; returns null for reftable or symrefs.
export const resolveHeadFromGitDirs = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  gitDir: string,
  gitCommonDir: string,
): Effect.fn.Return<{ readonly headExists: boolean; readonly head: string | undefined } | null> {
  const headContent = yield* fileSystem
    .readFileString(path.join(gitDir, "HEAD"))
    .pipe(Effect.orElseSucceed(() => null));
  if (headContent === null) return null;
  const trimmed = headContent.replace(/\r?\n$/, "");
  if (HEX_OID_PATTERN.test(trimmed)) {
    return { headExists: true, head: trimmed };
  }
  if (!trimmed.startsWith("ref: ")) return null;
  const refName = trimmed.slice(5).trim();
  if (
    !refName.startsWith("refs/heads/") ||
    refName === "refs/heads/.invalid" ||
    refName.includes("..") ||
    refName.includes("\\") ||
    refName.includes("\0") ||
    refName.endsWith("/")
  ) {
    return null;
  }

  const loosePath = path.join(gitCommonDir, ...refName.split("/"));
  const looseResult = yield* fileSystem.readFileString(loosePath).pipe(
    Effect.map((content) => ({ found: true as const, content })),
    Effect.catchReason("PlatformError", "NotFound", () =>
      Effect.succeed({ found: false as const, content: "" }),
    ),
    Effect.orElseSucceed(() => null),
  );
  if (looseResult === null) return null;
  if (looseResult.found) {
    const looseOid = looseResult.content.replace(/\r?\n$/, "");
    return HEX_OID_PATTERN.test(looseOid) ? { headExists: true, head: looseOid } : null;
  }

  const hasReftable = yield* fileSystem
    .exists(path.join(gitCommonDir, "reftable", "tables.list"))
    .pipe(Effect.orElseSucceed(() => true));
  if (hasReftable) return null;

  const packedRefsPath = path.join(gitCommonDir, "packed-refs");
  const packedStat = yield* fileSystem.stat(packedRefsPath).pipe(
    Effect.map((info) => ({ found: true as const, size: Number(info.size) })),
    Effect.catchReason("PlatformError", "NotFound", () =>
      Effect.succeed({ found: false as const, size: 0 }),
    ),
    Effect.orElseSucceed(() => null),
  );
  if (packedStat === null) return null;
  if (!packedStat.found) return { headExists: false, head: undefined };
  if (packedStat.size > MAX_PACKED_REFS_BYTES) return null;

  const packedContent = yield* fileSystem
    .readFileString(packedRefsPath)
    .pipe(Effect.orElseSucceed(() => null));
  if (packedContent === null) return null;
  const needle = ` ${refName}`;
  for (const line of packedContent.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith("#") || line.startsWith("^")) continue;
    if (!line.endsWith(needle)) continue;
    const oid = line.slice(0, line.length - needle.length);
    if (HEX_OID_PATTERN.test(oid)) return { headExists: true, head: oid };
    return null;
  }
  return { headExists: false, head: undefined };
});

export function isMutatingGitArgs(args: ReadonlyArray<string>): boolean {
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (GIT_GLOBAL_FLAGS_WITH_VALUE.has(arg)) {
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  const subcommand = args[index];
  if (subcommand === undefined) return false;
  const rest = args.slice(index + 1);

  switch (subcommand) {
    case "init":
    case "clone":
    case "checkout":
    case "switch":
      return true;
    case "config": {
      let positionalCount = 0;
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i]!;
        if (CONFIG_WRITE_FLAGS.has(arg)) return true;
        if (CONFIG_READ_FLAGS.has(arg)) return false;
        if (arg === "--") {
          positionalCount += rest.length - i - 1;
          break;
        }
        if (CONFIG_FLAGS_WITH_VALUE.has(arg)) {
          i += 1;
          continue;
        }
        if (arg.startsWith("-")) continue;
        positionalCount += 1;
      }
      return positionalCount >= 2;
    }
    case "remote": {
      if (rest.includes("-h") || rest.includes("--help")) return false;
      const action = rest.find((arg) => !arg.startsWith("-"));
      return action !== undefined && !REMOTE_READ_SUBCOMMANDS.has(action);
    }
    case "branch": {
      if (rest.length === 0 || rest.some((arg) => BRANCH_READ_FLAGS.has(arg))) return false;
      return true;
    }
    case "worktree": {
      if (rest.includes("-h") || rest.includes("--help")) return false;
      const action = rest.find((arg) => !arg.startsWith("-"));
      return action !== undefined && action !== "list";
    }
    case "sparse-checkout": {
      if (rest.includes("-h") || rest.includes("--help")) return false;
      const action = rest.find((arg) => !arg.startsWith("-"));
      return action !== undefined && !SPARSE_READ_SUBCOMMANDS.has(action);
    }
    case "submodule": {
      if (rest.includes("-h") || rest.includes("--help")) return false;
      const action = rest.find((arg) => !arg.startsWith("-"));
      return action !== undefined && !SUBMODULE_READ_SUBCOMMANDS.has(action);
    }
    default:
      return false;
  }
}

export function makeGitRepoMetadataCache(options: GitRepoMetadataCacheOptions) {
  const { fileSystem, path, hostPlatform } = options;
  const metadataCache = new LruMap<string, MetadataCacheEntry>(
    options.metadataCapacity ?? DEFAULT_CACHE_CAPACITY,
  );
  const configCache = new LruMap<string, ConfigCacheEntry>(
    options.configCapacity ?? DEFAULT_CACHE_CAPACITY,
  );
  const inFlightConfig = new Map<string, InFlightLoad<GitConfigSnapshot | null, unknown>>();
  let generation = 0;

  const normalizeKey = (target: string) => path.normalize(path.resolve(target));
  const configCacheKey = (gitCommonDir: string, gitDir: string) => `${gitCommonDir}\0${gitDir}`;

  const snapshotWatchedFiles = Effect.fnUntraced(function* (filePaths: ReadonlyArray<string>) {
    const tokens = yield* Effect.forEach(filePaths, (filePath) => statToken(fileSystem, filePath), {
      concurrency: "unbounded",
    });
    const watched: Array<WatchedFile> = [];
    for (let index = 0; index < filePaths.length; index++) {
      const token = tokens[index];
      if (token === null || token === undefined) return null;
      watched.push({ filePath: filePaths[index]!, token });
    }
    return watched;
  });

  const watchedFilesMatch = Effect.fnUntraced(function* (watched: ReadonlyArray<WatchedFile>) {
    const tokens = yield* Effect.forEach(
      watched,
      ({ filePath }) => statToken(fileSystem, filePath),
      { concurrency: "unbounded" },
    );
    for (let index = 0; index < watched.length; index++) {
      const token = tokens[index];
      if (token === null || token !== watched[index]!.token) return false;
    }
    return true;
  });

  const buildMetadataWatchPaths = Effect.fnUntraced(function* (
    normalizedCwd: string,
    metadata: GitRepoMetadata,
  ) {
    const watchPaths = new Set<string>([normalizedCwd]);
    if (metadata.worktreeRoot !== null) {
      const rootGitPath = path.join(metadata.worktreeRoot, ".git");
      watchPaths.add(rootGitPath);
      const [physicalCwd, physicalRoot] = yield* Effect.all(
        [
          fileSystem.realPath(normalizedCwd).pipe(Effect.orElseSucceed(() => normalizedCwd)),
          fileSystem
            .realPath(metadata.worktreeRoot)
            .pipe(Effect.orElseSucceed(() => metadata.worktreeRoot!)),
        ],
        { concurrency: "unbounded" },
      );
      if (physicalCwd !== physicalRoot && isSameOrSubpath(path, physicalCwd, physicalRoot)) {
        let current = physicalCwd;
        while (current !== physicalRoot) {
          watchPaths.add(path.join(current, ".git"));
          const parent = path.dirname(current);
          if (parent === current) break;
          current = parent;
        }
      }
    }
    watchPaths.add(metadata.gitDir);
    watchPaths.add(metadata.gitCommonDir);
    return [...watchPaths];
  });

  const buildBaselineConfigWatchPaths = (
    gitCommonDir: string,
    gitDir: string,
    hostEnv: NodeJS.ProcessEnv,
    homeDir: string,
  ): ReadonlyArray<string> => {
    const watchPaths = new Set<string>([
      path.join(gitCommonDir, "config"),
      path.join(gitDir, "config.worktree"),
    ]);

    const gitConfigGlobal = readEnvValue(hostEnv, "GIT_CONFIG_GLOBAL", hostPlatform);
    if (gitConfigGlobal !== undefined) {
      if (gitConfigGlobal !== "" && gitConfigGlobal !== "/dev/null") {
        watchPaths.add(path.normalize(gitConfigGlobal));
      }
    } else {
      const effectiveHome = readEnvValue(hostEnv, "HOME", hostPlatform) || homeDir;
      if (effectiveHome.length > 0) {
        watchPaths.add(path.join(effectiveHome, ".gitconfig"));
      }
      const xdgConfigHome = readEnvValue(hostEnv, "XDG_CONFIG_HOME", hostPlatform);
      if (xdgConfigHome && xdgConfigHome.length > 0) {
        watchPaths.add(path.join(xdgConfigHome, "git", "config"));
      } else if (effectiveHome.length > 0) {
        watchPaths.add(path.join(effectiveHome, ".config", "git", "config"));
      }
    }

    const noSystem = readEnvValue(hostEnv, "GIT_CONFIG_NOSYSTEM", hostPlatform);
    if (!noSystem || !/^(?:1|true|yes|on)$/i.test(noSystem)) {
      const gitConfigSystem = readEnvValue(hostEnv, "GIT_CONFIG_SYSTEM", hostPlatform);
      if (gitConfigSystem !== undefined) {
        if (gitConfigSystem !== "" && gitConfigSystem !== "/dev/null") {
          watchPaths.add(path.normalize(gitConfigSystem));
        }
      } else if (hostPlatform !== "win32") {
        watchPaths.add("/etc/gitconfig");
      }
    }

    return [...watchPaths];
  };

  // Pure filesystem probe for .git so cold config reads avoid spawning rev-parse.
  const probeLocalGitDirs = Effect.fnUntraced(function* (cwd: string) {
    const physicalCwd = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => null));
    if (physicalCwd === null) return null;

    let current = physicalCwd;
    for (;;) {
      const dotGitPath = path.join(current, ".git");
      const info = yield* fileSystem.stat(dotGitPath).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
        Effect.orElseSucceed(() => null),
      );
      if (info !== null) {
        let gitDir: string | null = null;
        if (info.type === "Directory") {
          const hasHead = yield* fileSystem
            .exists(path.join(dotGitPath, "HEAD"))
            .pipe(Effect.orElseSucceed(() => false));
          if (hasHead) gitDir = dotGitPath;
        } else if (info.type === "File") {
          const raw = yield* fileSystem
            .readFileString(dotGitPath)
            .pipe(Effect.orElseSucceed(() => null));
          const match = raw === null ? null : /^gitdir:[ \t]*(.+?)\r?\n?$/.exec(raw);
          if (match?.[1]) {
            const resolvedGitDir = path.resolve(current, match[1]);
            const hasHead = yield* fileSystem
              .exists(path.join(resolvedGitDir, "HEAD"))
              .pipe(Effect.orElseSucceed(() => false));
            if (hasHead) gitDir = resolvedGitDir;
          }
        }
        if (gitDir !== null) {
          const physicalGitDir = yield* fileSystem
            .realPath(gitDir)
            .pipe(Effect.orElseSucceed(() => path.normalize(gitDir)));
          const commonDirRaw = yield* fileSystem
            .readFileString(path.join(physicalGitDir, "commondir"))
            .pipe(Effect.orElseSucceed(() => null));
          const resolvedCommonDir =
            commonDirRaw !== null && commonDirRaw.replace(/\r?\n$/, "").length > 0
              ? path.resolve(physicalGitDir, commonDirRaw.replace(/\r?\n$/, ""))
              : physicalGitDir;
          const physicalCommonDir = yield* fileSystem
            .realPath(resolvedCommonDir)
            .pipe(Effect.orElseSucceed(() => path.normalize(resolvedCommonDir)));
          return { gitCommonDir: physicalCommonDir, gitDir: physicalGitDir };
        }
      }
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  });

  const getMetadataWithStatus = Effect.fnUntraced(function* (cwd: string) {
    const key = normalizeKey(cwd);
    const entry = metadataCache.peek(key);
    if (entry === undefined) return { metadata: null, evicted: false } as const;
    const valid = yield* watchedFilesMatch(entry.watchedFiles);
    if (!valid) {
      metadataCache.delete(key);
      return { metadata: null, evicted: true } as const;
    }
    metadataCache.get(key);
    return { metadata: entry.metadata, evicted: false } as const;
  });

  const getMetadata = (cwd: string) =>
    getMetadataWithStatus(cwd).pipe(Effect.map((result) => result.metadata));

  const peekMetadata = (cwd: string): GitRepoMetadata | undefined =>
    metadataCache.peek(normalizeKey(cwd))?.metadata;

  const setMetadata = Effect.fnUntraced(function* (cwd: string, metadata: GitRepoMetadata) {
    const key = normalizeKey(cwd);
    const watchPaths = yield* buildMetadataWatchPaths(key, metadata);
    const watchedFiles = yield* snapshotWatchedFiles(watchPaths);
    if (watchedFiles === null) return;
    metadataCache.set(key, { metadata, watchedFiles });
  });

  const getOrLoadConfigSnapshot = Effect.fn("GitRepoMetadataCache.getOrLoadConfigSnapshot")(
    function* <E>(
      cwd: string,
      loadRaw: () => Effect.Effect<GitConfigCommandOutput, E>,
      knownGitDirs?: { readonly gitCommonDir: string; readonly gitDir: string },
    ): Effect.fn.Return<GitConfigSnapshot | null, E> {
      const hostEnv = yield* HostProcess.Environment;
      // GIT_CONFIG causes `git config` to ignore normal repository/global/system files.
      if ((readEnvValue(hostEnv, "GIT_CONFIG", hostPlatform) ?? "").length > 0) {
        return null;
      }

      const normalizedCwd = normalizeKey(cwd);
      const dirs = knownGitDirs ?? (yield* getMetadata(cwd)) ?? (yield* probeLocalGitDirs(cwd));
      if (dirs === null) return null;

      const { gitCommonDir, gitDir } = dirs;
      const cacheKey = configCacheKey(gitCommonDir, gitDir);
      const envFingerprint = buildConfigEnvFingerprint(hostEnv, hostPlatform);

      const existing = configCache.peek(cacheKey);
      if (existing !== undefined && existing.envFingerprint === envFingerprint) {
        if (yield* watchedFilesMatch(existing.watchedFiles)) {
          existing.associatedCwds.add(normalizedCwd);
          configCache.get(cacheKey);
          return existing.snapshot;
        }
        configCache.delete(cacheKey);
      }

      const homeDir = yield* HostProcess.HomeDirectory;
      const inFlightKey = `${cacheKey}\0${envFingerprint}`;

      for (;;) {
        const active = inFlightConfig.get(inFlightKey) as
          | InFlightLoad<GitConfigSnapshot | null, E>
          | undefined;
        if (active !== undefined && active.generation === generation) {
          const awaited = yield* Effect.exit(Deferred.await(active.deferred));
          if (Exit.isFailure(awaited)) {
            if (Cause.hasInterruptsOnly(awaited.cause)) continue;
            return yield* Effect.failCause(awaited.cause);
          }
          configCache.peek(cacheKey)?.associatedCwds.add(normalizedCwd);
          return awaited.value;
        }

        const startGeneration = generation;
        const baselinePaths = buildBaselineConfigWatchPaths(gitCommonDir, gitDir, hostEnv, homeDir);
        const baselineBefore = yield* snapshotWatchedFiles(baselinePaths);

        const deferred = yield* Deferred.make<GitConfigSnapshot | null, E>();
        const record: InFlightLoad<GitConfigSnapshot | null, unknown> = {
          generation: startGeneration,
          deferred: deferred as Deferred.Deferred<GitConfigSnapshot | null, unknown>,
        };
        inFlightConfig.set(inFlightKey, record);

        const loadSnapshot = Effect.gen(function* () {
          const result = yield* loadRaw();
          if (result.exitCode !== 0 || result.stdoutTruncated) return null;
          const physicalCwd = yield* fileSystem
            .realPath(cwd)
            .pipe(Effect.orElseSucceed(() => normalizedCwd));
          const effectiveHome = readEnvValue(hostEnv, "HOME", hostPlatform) || homeDir;
          const parsed = parseConfigListWithOrigin(result.stdout, path, physicalCwd, effectiveHome);
          if (
            generation === startGeneration &&
            !parsed.hasUnwatchableInclude &&
            baselineBefore !== null
          ) {
            const allPaths = [...new Set([...baselinePaths, ...parsed.discoveredFiles])];
            const watchedAfter = yield* snapshotWatchedFiles(allPaths);
            const baselineUnchanged =
              watchedAfter !== null &&
              baselineBefore.every((before, index) => watchedAfter[index]?.token === before.token);
            if (baselineUnchanged) {
              configCache.set(cacheKey, {
                gitCommonDir,
                gitDir,
                envFingerprint,
                watchedFiles: watchedAfter,
                associatedCwds: new Set([normalizedCwd]),
                snapshot: parsed.snapshot,
              });
            }
          }
          return parsed.snapshot;
        });

        return yield* loadSnapshot.pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              if (inFlightConfig.get(inFlightKey) === record) {
                inFlightConfig.delete(inFlightKey);
              }
              yield* Deferred.done(deferred, exit);
            }),
          ),
        );
      }
    },
  );

  const invalidateMetadata = (cwdOrCommonDir: string): void => {
    const target = normalizeKey(cwdOrCommonDir);
    generation += 1;
    metadataCache.delete(target);
    metadataCache.deleteWhere(
      (entry, key) =>
        isSameOrSubpath(path, key, target) ||
        entry.metadata.gitCommonDir === target ||
        entry.metadata.gitDir === target ||
        entry.metadata.worktreeRoot === target,
    );
  };

  const invalidate = (cwdOrCommonDir: string): void => {
    const target = normalizeKey(cwdOrCommonDir);
    generation += 1;
    const matchedCommonDirs = new Set<string>([target]);
    const direct = metadataCache.peek(target);
    if (direct !== undefined) {
      matchedCommonDirs.add(direct.metadata.gitCommonDir);
    }
    metadataCache.deleteWhere((entry, key) => {
      const matches =
        key === target ||
        isSameOrSubpath(path, key, target) ||
        entry.metadata.gitCommonDir === target ||
        entry.metadata.gitDir === target ||
        entry.metadata.worktreeRoot === target;
      if (matches) matchedCommonDirs.add(entry.metadata.gitCommonDir);
      return matches;
    });
    configCache.deleteWhere((entry) => {
      for (const associatedCwd of entry.associatedCwds) {
        if (isSameOrSubpath(path, associatedCwd, target)) {
          matchedCommonDirs.add(entry.gitCommonDir);
          return true;
        }
      }
      return false;
    });
    configCache.deleteWhere(
      (entry) =>
        matchedCommonDirs.has(entry.gitCommonDir) ||
        entry.gitDir === target ||
        isSameOrSubpath(path, entry.gitDir, target),
    );
  };

  return {
    getMetadata,
    getMetadataWithStatus,
    peekMetadata,
    setMetadata,
    getOrLoadConfigSnapshot,
    invalidateMetadata,
    invalidate,
    get metadataSize() {
      return metadataCache.size;
    },
    get configSize() {
      return configCache.size;
    },
  };
}
