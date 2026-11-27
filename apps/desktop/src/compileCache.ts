// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { enablePreparedCompileCache } from "../../../scripts/lib/server-compile-cache.ts";

// Linux /tmp is shared; macOS and Windows temp dirs are per user.
// AppImage mounts change paths each launch, so only the symlinked prepared cache applies there.
try {
  const cacheRoot =
    // oxlint-disable-next-line zerocode/no-global-process-runtime -- Loads before any Effect runtime.
    process.platform === "linux"
      ? process.env.XDG_CACHE_HOME || NodePath.join(NodeOS.homedir(), ".cache")
      : NodeOS.tmpdir();
  const directory = NodePath.join(cacheRoot, "zerocode", "compile-cache");
  const isServerProcess = process.env.ELECTRON_RUN_AS_NODE === "1";
  const entry = isServerProcess
    ? (process.argv[1] ?? "")
    : typeof __filename === "string"
      ? __filename
      : "";
  const prepared = enablePreparedCompileCache(
    entry,
    directory,
    isServerProcess ? "server" : "main",
  );
  if (!prepared && !process.env.APPIMAGE) {
    NodeModule.enableCompileCache({ directory, portable: true });
  }
} catch {}
