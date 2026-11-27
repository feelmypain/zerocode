// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Persistent Rust worker IPC and idle shutdown timer live outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";

import * as HostProcess from "@zerocode/shared/HostProcess";
import type { SelectedFields } from "@zerocode/provider-core/server/usage";

export interface NativeTranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface NativeListResult {
  readonly files: readonly NativeTranscriptFile[];
  readonly walked: readonly string[];
  readonly failedPaths: number;
}

export interface NativeScanFileInput {
  readonly path: string;
  readonly resumeOffset: number;
  readonly guardLength: number;
  readonly guardHash: number;
}

export interface NativeScanFileResult {
  readonly ok: boolean;
  readonly resumed: boolean;
  readonly resumeOffset: number;
  readonly guardLength: number;
  readonly guardHash: number;
  readonly lines: readonly unknown[];
  readonly tail: unknown;
}

interface WorkerResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly result?: NativeListResult;
  readonly results?: readonly NativeScanFileResult[];
  readonly error?: string;
}

interface PendingRequest {
  readonly resolve: (response: WorkerResponse) => void;
  readonly reject: (error: Error) => void;
}

const PROTOCOL_VERSION = 1;
const IDLE_SHUTDOWN_MS = 30_000;
const NEWLINE = 0x0a;

function binaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "zerocode-transcript-scanner.exe" : "zerocode-transcript-scanner";
}

function platformKey(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): string | undefined {
  if (
    (platform !== "darwin" && platform !== "linux" && platform !== "win32") ||
    (architecture !== "arm64" && architecture !== "x64")
  ) {
    return undefined;
  }
  return `${platform}-${architecture}`;
}

function rustTarget(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): string | undefined {
  if (platform === "darwin") {
    return architecture === "arm64"
      ? "aarch64-apple-darwin"
      : architecture === "x64"
        ? "x86_64-apple-darwin"
        : undefined;
  }
  if (platform === "linux") {
    return architecture === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : architecture === "x64"
        ? "x86_64-unknown-linux-gnu"
        : undefined;
  }
  if (platform === "win32") {
    return architecture === "arm64"
      ? "aarch64-pc-windows-msvc"
      : architecture === "x64"
        ? "x86_64-pc-windows-msvc"
        : undefined;
  }
  return undefined;
}

function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = NodeFS.statSync(candidate);
    if (!stat.isFile()) return false;
    if (platform !== "win32" && (stat.mode & 0o111) === 0) return false;
    return true;
  } catch {
    return false;
  }
}

let cachedResolutionKey: string | undefined;
let cachedBinaryPath: string | null = null;

export function resolveTranscriptScannerBinaryPath(options?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
}): string | null {
  const env = options?.env ?? HostProcess.Environment.defaultValue();
  const platform = options?.platform ?? HostProcess.Platform.defaultValue();
  const architecture = options?.architecture ?? HostProcess.Architecture.defaultValue();
  const disabled = env.ZEROCODE_TRANSCRIPT_SCANNER_DISABLED === "1";
  const override = env.ZEROCODE_TRANSCRIPT_SCANNER_PATH?.trim() ?? "";
  const key = `${platform}:${architecture}:${disabled ? "1" : "0"}:${override}`;
  if (cachedResolutionKey === key) return cachedBinaryPath;

  if (disabled) {
    cachedResolutionKey = key;
    cachedBinaryPath = null;
    return null;
  }

  const executable = binaryName(platform);
  const candidates: string[] = [];
  if (override.length > 0) {
    candidates.push(override);
  } else {
    const pKey = platformKey(platform, architecture);
    const target = rustTarget(platform, architecture);
    if (pKey !== undefined) {
      candidates.push(
        NodePath.resolve(import.meta.dirname, "transcript-scanner", pKey, executable),
        NodePath.resolve(import.meta.dirname, "transcript-scanner", executable),
        NodePath.resolve(import.meta.dirname, "../transcript-scanner", executable),
      );
    }
    const crateRoots = [
      NodePath.resolve(import.meta.dirname, "../../../../native/transcript-scanner"),
      NodePath.resolve(import.meta.dirname, "../../../native/transcript-scanner"),
    ];
    for (const root of crateRoots) {
      if (target !== undefined) {
        candidates.push(NodePath.join(root, "target", target, "release", executable));
      }
      candidates.push(
        NodePath.join(root, "target", "release", executable),
        NodePath.join(root, "target", "debug", executable),
      );
    }
  }

  const resolved = candidates.find((candidate) => isExecutableFile(candidate, platform)) ?? null;
  cachedResolutionKey = key;
  cachedBinaryPath = resolved;
  return resolved;
}

class ScannerWorker {
  readonly binaryPath: string;
  private readonly child: NodeChildProcess.ChildProcessByStdio<
    NodeStream.Writable,
    NodeStream.Readable,
    null
  >;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private bufferedChunks: Buffer[] = [];
  private bufferedBytes = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(binaryPath: string, onDead: () => void) {
    this.binaryPath = binaryPath;
    this.child = NodeChildProcess.spawn(binaryPath, [], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });

    const failAll = (reason: string) => {
      if (this.closed) return;
      this.closed = true;
      this.clearIdleTimer();
      onDead();
      const error = new Error(reason);
      for (const req of this.pending.values()) req.reject(error);
      this.pending.clear();
    };

    this.child.on("error", (error) => failAll(`scanner error: ${error.message}`));
    this.child.on("exit", (code, signal) =>
      failAll(`scanner exited (code=${String(code)}, signal=${String(signal)})`),
    );
    this.child.stdin.on("error", (error) => failAll(`scanner stdin error: ${error.message}`));
    this.child.stdout.on("error", (error) => failAll(`scanner stdout error: ${error.message}`));
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdoutData(chunk, failAll));
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private scheduleIdleIfEmpty(): void {
    if (this.pending.size > 0 || this.closed) return;
    // Allow Node/Vitest/CLI to exit immediately while idle.
    this.child.unref();
    (this.child.stdout as unknown as { unref?: () => void }).unref?.();
    (this.child.stdin as unknown as { unref?: () => void }).unref?.();
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) this.shutdown();
    }, IDLE_SHUTDOWN_MS);
    this.idleTimer.unref();
  }

  private keepAliveForActiveRequest(): void {
    this.clearIdleTimer();
    this.child.ref();
    (this.child.stdout as unknown as { ref?: () => void }).ref?.();
    (this.child.stdin as unknown as { ref?: () => void }).ref?.();
  }

  private onStdoutData(chunk: Buffer, failAll: (reason: string) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newlineIndex = chunk.indexOf(NEWLINE, offset);
      if (newlineIndex === -1) {
        const slice = chunk.subarray(offset);
        this.bufferedChunks.push(slice);
        this.bufferedBytes += slice.length;
        return;
      }
      let lineStr: string;
      if (this.bufferedBytes === 0) {
        lineStr = chunk.toString("utf8", offset, newlineIndex);
      } else {
        const tail = chunk.subarray(offset, newlineIndex);
        this.bufferedChunks.push(tail);
        const combined = Buffer.concat(this.bufferedChunks, this.bufferedBytes + tail.length);
        this.bufferedChunks = [];
        this.bufferedBytes = 0;
        lineStr = combined.toString("utf8");
      }
      offset = newlineIndex + 1;
      if (lineStr.length === 0) continue;

      let response: WorkerResponse;
      try {
        response = JSON.parse(lineStr) as WorkerResponse;
      } catch (error) {
        failAll(`scanner invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        this.child.kill();
        return;
      }

      const request = this.pending.get(response.id);
      if (request !== undefined) {
        this.pending.delete(response.id);
        if (response.ok) request.resolve(response);
        else request.reject(new Error(response.error ?? "scanner request failed"));
        this.scheduleIdleIfEmpty();
      } else if (!response.ok) {
        failAll(response.error ?? "scanner protocol error");
        this.child.kill();
        return;
      }
    }
  }

  request(payload: Record<string, unknown>): Promise<WorkerResponse> {
    if (this.closed) {
      return Promise.reject(new Error("scanner worker closed"));
    }
    const id = this.nextId++;
    this.keepAliveForActiveRequest();
    const line = `${JSON.stringify({ version: PROTOCOL_VERSION, id, ...payload })}\n`;
    return new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child.stdin.write(line, "utf8");
      } catch (error) {
        this.pending.delete(id);
        this.scheduleIdleIfEmpty();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIdleTimer();
    try {
      this.child.stdin.end(
        `${JSON.stringify({ type: "shutdown", version: PROTOCOL_VERSION, id: 0 })}\n`,
        "utf8",
      );
    } catch {
      this.child.kill();
    }
    this.child.unref();
  }
}

let activeWorker: ScannerWorker | null = null;

function getWorker(): ScannerWorker | null {
  const binaryPath = resolveTranscriptScannerBinaryPath();
  if (binaryPath === null) {
    if (activeWorker !== null) {
      activeWorker.shutdown();
      activeWorker = null;
    }
    return null;
  }
  if (activeWorker !== null && activeWorker.binaryPath !== binaryPath) {
    activeWorker.shutdown();
    activeWorker = null;
  }
  if (activeWorker === null) {
    const created = new ScannerWorker(binaryPath, () => {
      if (activeWorker === created) activeWorker = null;
    });
    activeWorker = created;
  }
  return activeWorker;
}

export function stopNativeTranscriptScanner(): void {
  if (activeWorker !== null) {
    activeWorker.shutdown();
    activeWorker = null;
  }
}

export async function nativeListTranscriptFiles(
  root: string,
  sinceMs: number,
  options?: { readonly fileName?: string },
): Promise<NativeListResult | null> {
  const worker = getWorker();
  if (worker === null) return null;
  try {
    const response = await worker.request({
      type: "list",
      root,
      sinceMs: Number.isFinite(sinceMs)
        ? sinceMs
        : Number.NEGATIVE_INFINITY === sinceMs
          ? -1e308
          : 1e308,
      ...(options?.fileName === undefined ? {} : { fileName: options.fileName }),
    });
    const result = response.result;
    if (
      result === undefined ||
      !Array.isArray(result.files) ||
      !Array.isArray(result.walked) ||
      typeof result.failedPaths !== "number"
    ) {
      return null;
    }
    return {
      files: result.files,
      walked: result.walked,
      failedPaths: result.failedPaths,
    };
  } catch {
    return null;
  }
}

export async function nativeScanTranscriptBatch(
  files: readonly NativeScanFileInput[],
  usageMarkers: readonly [string, ...string[]],
  selectFields: SelectedFields,
  streamingThresholdBytes?: number,
): Promise<readonly NativeScanFileResult[] | null> {
  if (files.length === 0) return [];
  const worker = getWorker();
  if (worker === null) return null;
  try {
    const thresholdPayload =
      streamingThresholdBytes === undefined
        ? {}
        : Number.isFinite(streamingThresholdBytes)
          ? {
              streamingThresholdBytes: Math.min(
                0x7fff_ffff,
                Math.max(0, Math.floor(streamingThresholdBytes)),
              ),
            }
          : // Explicit Infinity disables streaming mode; cap at signed 32-bit max for 32/64-bit usize safety.
            { streamingThresholdBytes: 0x7fff_ffff };
    const response = await worker.request({
      type: "scanBatch",
      files,
      usageMarkers,
      selectFields,
      ...thresholdPayload,
    });
    if (!Array.isArray(response.results) || response.results.length !== files.length) {
      return null;
    }
    return response.results;
  } catch {
    return null;
  }
}
