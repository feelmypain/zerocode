/* oxlint-disable zerocode/no-global-process-runtime -- Runs in the packaged engine before an Effect runtime exists. */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeV8 from "node:v8";
import * as NodeZlib from "node:zlib";
import * as NodeURL from "node:url";

export const runtimeIdentity = () =>
  [
    process.versions.electron,
    process.version,
    process.platform,
    process.arch,
    NodeV8.cachedDataVersionTag(),
  ].join("-");

export type CompileCacheModuleKind = "cjs" | "esm";
export type CompileCacheBucket = "server" | "main";

const CACHE_TYPE_BYTE: Readonly<Record<CompileCacheModuleKind, number>> = {
  cjs: 0,
  esm: 1,
};

const PREPARED_MODULE_PATTERN =
  /^(?:(?:app|server)\.asar\/apps\/server\/dist\/[^/\\]+\.mjs|app\.asar\/apps\/desktop\/dist-electron\/[^/\\]+\.cjs)$/;

const COMPILE_ONLY_ABORT = Symbol("zerocode.compileOnlyAbort");

// Node 24's portable key is CRC32 of the one-byte module type (0=CJS, 1=ESM) followed by the relative filename.
// Generation verifies this against files produced by the packaged engine before shipping them.
export const cacheKey = (active: string, filename: string, kind: CompileCacheModuleKind = "esm") =>
  NodeZlib.crc32(
    NodePath.relative(active, filename),
    NodeZlib.crc32(Buffer.from([CACHE_TYPE_BYTE[kind]])),
  )
    .toString(16)
    .padStart(8, "0");

export function seedPreparedCache(prepared: string, active: string, runtime: string): boolean {
  try {
    const manifest: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(prepared, "manifest.json"), "utf8"),
    );
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("format" in manifest) ||
      manifest.format !== 1 ||
      !("runtime" in manifest) ||
      manifest.runtime !== runtime ||
      !("entries" in manifest) ||
      !Array.isArray(manifest.entries) ||
      manifest.entries.length === 0
    )
      return false;
    for (const entry of manifest.entries) {
      if (
        typeof entry?.module !== "string" ||
        typeof entry?.file !== "string" ||
        !/^[a-f0-9]{8}$/.test(entry.file) ||
        !PREPARED_MODULE_PATTERN.test(entry.module)
      )
        return false;
      const source = NodePath.join(prepared, entry.file);
      const kind: CompileCacheModuleKind = entry.module.endsWith(".cjs") ? "cjs" : "esm";
      const destination = NodePath.join(
        active,
        cacheKey(active, NodePath.join(NodePath.dirname(prepared), entry.module), kind),
      );
      try {
        // Node replaces cache files atomically. A directory link would instead allow writes into signed resources.
        if (process.platform === "win32") NodeFS.linkSync(source, destination);
        else NodeFS.symlinkSync(source, destination);
      } catch {}
      if (!NodeFS.existsSync(destination)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function enablePreparedCompileCache(
  entry: string,
  cacheRoot: string,
  bucket: CompileCacheBucket = "server",
): boolean {
  try {
    const archive = entry.match(/^(.*[\\/](?:app|server)\.asar)[\\/]/)?.[1];
    if (!archive) return false;
    const resources = NodeFS.realpathSync(NodePath.dirname(archive));
    // Keep different installations and builds separate without reading or copying their source files.
    const prepared = NodePath.join(resources, "server-compile-cache");
    if (process.env.APPIMAGE && !NodeFS.existsSync(NodePath.join(prepared, "manifest.json")))
      return false;
    const identity = NodeZlib.crc32(resources).toString(16);
    const bucketDir = NodePath.join(cacheRoot, bucket);
    NodeFS.mkdirSync(bucketDir, { recursive: true });
    if (process.env.APPIMAGE) {
      try {
        for (const candidate of NodeFS.readdirSync(bucketDir, {
          withFileTypes: true,
        })) {
          if (!candidate.isDirectory() || !candidate.name.startsWith("appimage-")) continue;
          const abandoned = NodePath.join(bucketDir, candidate.name);
          let hasStaleLink = false;
          // Node nests files under an engine/UID directory and can replace links with regular files.
          const removable = NodeFS.readdirSync(abandoned, { withFileTypes: true }).every(
            (engine) =>
              engine.isDirectory() &&
              NodeFS.readdirSync(NodePath.join(abandoned, engine.name), {
                withFileTypes: true,
              }).every((file) => {
                if (!/^[a-f0-9]{8}$/.test(file.name)) return false;
                if (!file.isSymbolicLink()) return file.isFile();
                const target = NodeFS.readlinkSync(
                  NodePath.join(abandoned, engine.name, file.name),
                );
                const mount = target.match(/^(.*[\\/]\.mount_[^/\\]+)[\\/]/)?.[1];
                if (
                  !mount ||
                  !NodePath.isAbsolute(target) ||
                  NodePath.basename(NodePath.dirname(target)) !== "server-compile-cache" ||
                  !/^[a-f0-9]{8}$/.test(NodePath.basename(target))
                )
                  return false;
                if (NodeFS.lstatSync(mount, { throwIfNoEntry: false })) return false;
                hasStaleLink = true;
                return true;
              }),
          );
          if (removable && hasStaleLink) NodeFS.rmSync(abandoned, { recursive: true, force: true });
        }
      } catch {
        // Concurrent removal or restricted permissions must not prevent enabling this launch's cache.
      }
    }
    const directory = process.env.APPIMAGE
      ? NodeFS.mkdtempSync(NodePath.join(bucketDir, "appimage-"))
      : NodePath.join(bucketDir, identity);
    if (process.env.APPIMAGE) {
      // Each mount has different module paths; discard its links rather than accumulating caches.
      process.once("exit", () => {
        try {
          NodeFS.rmSync(directory, { recursive: true, force: true });
        } catch {}
      });
    }
    const result = NodeModule.enableCompileCache({
      directory,
      portable: true,
    });
    const active = NodeModule.getCompileCacheDir();
    if (result.status !== NodeModule.constants.compileCacheStatus.ENABLED || !active) return false;
    const seeded = seedPreparedCache(prepared, active, runtimeIdentity());
    if (seeded && bucket === "server") {
      Reflect.set(globalThis, Symbol.for("zerocode.preparedServerCache"), true);
    }
    return true;
  } catch {
    return false;
  }
}

export function enablePreparedServerCache(entry: string, cacheRoot: string): boolean {
  return enablePreparedCompileCache(entry, cacheRoot, "server");
}

// Node populates the CJS compile cache inside Module.prototype._compile before executing the
// wrapper body; aborting on the first require avoids executing Electron or startup side effects.
function warmCommonJsCompileCache(filename: string): void {
  const source = NodeFS.readFileSync(filename, "utf8");
  const mod = new NodeModule.Module(filename) as NodeModule.Module & {
    _compile: (content: string, filename: string) => unknown;
  };
  mod.filename = filename;
  mod.require = (() => {
    throw COMPILE_ONLY_ABORT;
  }) as unknown as NodeJS.Require;
  try {
    mod._compile(source, filename);
  } catch {
    // Aborted on first require (or Electron-only global); V8 already recorded the compile cache entry.
  }
}

export async function generatePreparedServerCache(resourcesInput: string): Promise<void> {
  const resources = NodeFS.realpathSync(resourcesInput);
  const prepared = NodePath.join(resources, "server-compile-cache");
  const archive = NodeFS.existsSync(NodePath.join(resources, "server.asar"))
    ? "server.asar"
    : "app.asar";
  const dist = NodePath.join(resources, archive, "apps/server/dist");
  NodeFS.mkdirSync(prepared, { recursive: true });
  const result = NodeModule.enableCompileCache({ directory: prepared, portable: true });
  if (result.status !== NodeModule.constants.compileCacheStatus.ENABLED)
    throw new Error("Cannot enable release compile cache");
  const files = NodeFS.readdirSync(dist);
  const cli = files.find((file) => /^binCli-.*\.mjs$/.test(file));
  if (!cli) throw new Error("Missing bundled server CLI");
  const servers = files.filter((file) => /^server-.*\.mjs$/.test(file));
  if (servers.length > 1) throw new Error("Ambiguous bundled server entry");
  const server = servers[0];
  if (!server) throw new Error("Missing bundled server entry");
  await import(NodeURL.pathToFileURL(NodePath.join(dist, cli)).href);
  // The CLI loads the server dynamically; importing its declarative layers does not launch them.
  await import(NodeURL.pathToFileURL(NodePath.join(dist, server)).href);
  const desktopDist = NodePath.join(resources, "app.asar", "apps/desktop/dist-electron");
  const desktopFiles = NodeFS.existsSync(desktopDist)
    ? NodeFS.readdirSync(desktopDist).filter(
        (file) => file === "main.cjs" || /^main-shared-.*\.cjs$/.test(file),
      )
    : [];
  for (const file of desktopFiles) {
    warmCommonJsCompileCache(NodePath.join(desktopDist, file));
  }
  NodeModule.flushCompileCache();
  const active = NodeModule.getCompileCacheDir()!;
  const serverEntries = files
    .filter((file) => file.endsWith(".mjs"))
    .flatMap((file) => {
      const key = cacheKey(active, NodePath.join(dist, file), "esm");
      if (!NodeFS.existsSync(NodePath.join(active, key))) return [];
      NodeFS.copyFileSync(NodePath.join(active, key), NodePath.join(prepared, key));
      return [{ module: `${archive}/apps/server/dist/${file}`, file: key }];
    });
  if (
    ![cli, server].every((file) => serverEntries.some((entry) => entry.module.endsWith(`/${file}`)))
  )
    throw new Error("Packaged engine cache key format is unsupported");
  const desktopEntries = desktopFiles.flatMap((file) => {
    const key = cacheKey(active, NodePath.join(desktopDist, file), "cjs");
    if (!NodeFS.existsSync(NodePath.join(active, key))) return [];
    NodeFS.copyFileSync(NodePath.join(active, key), NodePath.join(prepared, key));
    return [{ module: `app.asar/apps/desktop/dist-electron/${file}`, file: key }];
  });
  if (
    desktopFiles.length > 0 &&
    !desktopFiles.every((file) =>
      desktopEntries.some(
        (entry) => entry.module === `app.asar/apps/desktop/dist-electron/${file}`,
      ),
    )
  )
    throw new Error("Packaged desktop cache key format is unsupported");
  const entries = [...serverEntries, ...desktopEntries];
  NodeFS.writeFileSync(
    NodePath.join(prepared, "manifest.json"),
    JSON.stringify({ format: 1, runtime: runtimeIdentity(), entries }),
  );
  NodeFS.rmSync(active, { recursive: true });
}
