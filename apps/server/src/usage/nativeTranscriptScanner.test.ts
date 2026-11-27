// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import {
  resolveTranscriptScannerBinaryPath,
  stopNativeTranscriptScanner,
} from "./nativeTranscriptScanner.ts";
import { TEST_FORMATS } from "./usageTestFormats.ts";
import { listTranscriptFiles, readTranscriptRecordsBatch } from "./usageTranscriptReader.ts";

let dir: string;
let savedDisabledEnv: string | undefined;

beforeEach(async () => {
  savedDisabledEnv = process.env.ZEROCODE_TRANSCRIPT_SCANNER_DISABLED;
  delete process.env.ZEROCODE_TRANSCRIPT_SCANNER_DISABLED;
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "zerocode-native-scanner-"));
});

afterEach(async () => {
  stopNativeTranscriptScanner();
  if (savedDisabledEnv === undefined) {
    delete process.env.ZEROCODE_TRANSCRIPT_SCANNER_DISABLED;
  } else {
    process.env.ZEROCODE_TRANSCRIPT_SCANNER_DISABLED = savedDisabledEnv;
  }
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

async function withFallback<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.ZEROCODE_TRANSCRIPT_SCANNER_DISABLED;
  process.env.ZEROCODE_TRANSCRIPT_SCANNER_DISABLED = "1";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.ZEROCODE_TRANSCRIPT_SCANNER_DISABLED;
    else process.env.ZEROCODE_TRANSCRIPT_SCANNER_DISABLED = prev;
  }
}

describe("nativeTranscriptScanner", () => {
  it("resolves the compiled Rust scanner binary and respects the disable switch", () => {
    const resolved = resolveTranscriptScannerBinaryPath();
    expect(resolved).not.toBeNull();
    expect(resolved).toMatch(/zerocode-transcript-scanner(\.exe)?$/);

    process.env.ZEROCODE_TRANSCRIPT_SCANNER_DISABLED = "1";
    expect(resolveTranscriptScannerBinaryPath()).toBeNull();
  });

  it("matches JS listTranscriptFiles across nested dirs, extensions, fileName filter, and mtime", async () => {
    const subA = NodePath.join(dir, "proj-a");
    const subB = NodePath.join(dir, "proj-b", "nested");
    await NodeFSP.mkdir(subA, { recursive: true });
    await NodeFSP.mkdir(subB, { recursive: true });

    const f1 = NodePath.join(subA, "old.jsonl");
    const f2 = NodePath.join(subA, "recent.jsonl");
    const f3 = NodePath.join(subB, "archive.jsonl.zst");
    const f4 = NodePath.join(subB, "events.jsonl");
    const ignored = NodePath.join(subB, "notes.txt");
    await NodeFSP.writeFile(f1, "{}\n");
    await NodeFSP.writeFile(f2, "{}\n");
    await NodeFSP.writeFile(f3, NodeZlib.zstdCompressSync(Buffer.from("{}\n")));
    await NodeFSP.writeFile(f4, "{}\n");
    await NodeFSP.writeFile(ignored, "ignore");

    const oldSec = Date.parse("2020-01-01T00:00:00Z") / 1000;
    await NodeFSP.utimes(f1, oldSec, oldSec);

    const cutoffMs = Date.parse("2025-01-01T00:00:00Z");
    const nativeAll = await listTranscriptFiles(dir, cutoffMs);
    const jsAll = await withFallback(() => listTranscriptFiles(dir, cutoffMs));

    expect(nativeAll.failedPaths).toBe(jsAll.failedPaths);
    expect(nativeAll.walked).toEqual(jsAll.walked);
    expect(nativeAll.files.map((f) => ({ path: f.path, size: f.size }))).toEqual(
      jsAll.files.map((f) => ({ path: f.path, size: f.size })),
    );
    for (let i = 0; i < nativeAll.files.length; i += 1) {
      expect(Math.abs(nativeAll.files[i]!.mtimeMs - jsAll.files[i]!.mtimeMs)).toBeLessThan(1);
    }

    const nativeFiltered = await listTranscriptFiles(dir, cutoffMs, { fileName: "events.jsonl" });
    const jsFiltered = await withFallback(() =>
      listTranscriptFiles(dir, cutoffMs, { fileName: "events.jsonl" }),
    );
    expect(nativeFiltered.walked).toEqual(jsFiltered.walked);
    expect(nativeFiltered.files.map((f) => f.path)).toEqual(jsFiltered.files.map((f) => f.path));
  });

  it("matches JS readTranscriptRecordsBatch across plain, zstd, corrupt, resume, CRLF, and streaming lines", async () => {
    const timestamp = "2026-08-01T10:00:00Z";
    const claude1 = JSON.stringify({
      type: "assistant",
      timestamp,
      sessionId: "s1",
      requestId: "r1",
      costUSD: 0.12,
      ignoredHeavy: "payload ".repeat(2_000),
      message: {
        id: "m1",
        model: "claude-fable-5",
        usage: { input_tokens: 100, output_tokens: 40 },
      },
    });
    const claude2 = JSON.stringify({
      type: "assistant",
      timestamp,
      sessionId: "s1",
      requestId: "r2",
      message: {
        id: "m2",
        model: "claude-fable-5",
        usage: { input_tokens: 50, output_tokens: 15 },
      },
    });
    const escapedAndOverflow =
      '{"type":"assistant","timestamp":"2026-08-01T10:00:01Z","sessionId":"s1","requestId":"r3","costUSD":1e400,"message":{"id":"m3","model":"claude-fable-5","\\u0075sage":{"input_tokens":1,"output_tokens":9},"usage":{"input_tokens":10,"output_tokens":20}}}';

    const plainPath = NodePath.join(dir, "plain.jsonl");
    const zstPath = NodePath.join(dir, "archive.jsonl.zst");
    const corruptPath = NodePath.join(dir, "corrupt.jsonl.zst");
    const missingPath = NodePath.join(dir, "missing.jsonl");

    await NodeFSP.writeFile(
      plainPath,
      `${claude1}\r\n{"type":"user","content":"no usage here"}\r\n{malformed\r\n${escapedAndOverflow}\n${claude2}`,
    );
    await NodeFSP.writeFile(
      zstPath,
      NodeZlib.zstdCompressSync(Buffer.from(`${claude1}\n${claude2}\n`)),
    );
    await NodeFSP.writeFile(corruptPath, "not a zstd frame");

    const batchReq = [
      { filePath: plainPath },
      { filePath: zstPath },
      { filePath: corruptPath },
      { filePath: missingPath },
    ];

    const nativeBatch = await readTranscriptRecordsBatch(batchReq, TEST_FORMATS.claude, {
      streamingThresholdBytes: 4096,
    });
    const jsBatch = await withFallback(() =>
      readTranscriptRecordsBatch(batchReq, TEST_FORMATS.claude, {
        streamingThresholdBytes: 4096,
      }),
    );

    expect(nativeBatch).toEqual(jsBatch);
    expect(nativeBatch[0]?.records).toHaveLength(2);
    expect(nativeBatch[0]?.tailRecords).toHaveLength(1);
    expect(nativeBatch[1]?.records).toHaveLength(2);
    expect(nativeBatch[2]).toBeNull();
    expect(nativeBatch[3]).toBeNull();

    // Verify clean restart after explicit shutdown + incremental resume parity.
    stopNativeTranscriptScanner();
    await NodeFSP.appendFile(plainPath, `\n${claude1}\n`);
    const resumeReq = [{ filePath: plainPath, resumeFrom: nativeBatch[0]!.position }];
    const [nativeResumed] = await readTranscriptRecordsBatch(resumeReq, TEST_FORMATS.claude);
    const [jsResumed] = await withFallback(() =>
      readTranscriptRecordsBatch(resumeReq, TEST_FORMATS.claude),
    );
    expect(nativeResumed).toEqual(jsResumed);
    expect(nativeResumed?.resumed).toBe(true);
    expect(nativeResumed?.records).toHaveLength(2);
  });
});
