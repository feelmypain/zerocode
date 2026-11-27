import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import {
  sanitizeTerminalHistoryChunk,
  shouldOffloadVtSanitization,
  VT_SANITIZER_OFFLOAD_THRESHOLD,
} from "./TerminalVtSanitizer.ts";
import { createTerminalVtSanitizerWorker } from "./TerminalVtSanitizerWorker.ts";

it("bypasses escape scanning for escape-free ASCII and UTF-8 chunks", () => {
  const ascii = "plain output line\r\n".repeat(2_000);
  const utf8 = "café 漢字 🚀 \u009b6n \u0007\r\n".repeat(1_000);

  expect(ascii.length).toBeGreaterThan(VT_SANITIZER_OFFLOAD_THRESHOLD);
  expect(shouldOffloadVtSanitization("", ascii)).toBe(false);
  expect(shouldOffloadVtSanitization("", utf8)).toBe(false);
  expect(sanitizeTerminalHistoryChunk("", ascii)).toEqual({
    visibleText: ascii,
    pendingControlSequence: "",
  });
  expect(sanitizeTerminalHistoryChunk("", utf8)).toEqual({
    visibleText: utf8,
    pendingControlSequence: "",
  });
});

it("sanitizes CSI, OSC, DCS, APC, and ESC queries while keeping visual setters", () => {
  const input =
    "start " +
    "\u001b[32mgreen\u001b[0m" +
    "\u001b[6n\u001b[12;34R\u001b[>c\u001b[?2026$p\u001b[?2026;2$y\u001b[>0q\u001b[?u" +
    "\u001b[4 q\u001b[!p\u001b[u" +
    "\u001b]10;?\u0007\u001b]11;rgb:ffff/ffff/ffff\u001b\\" +
    "\u001b]11;rgb:12/34/56\u0007\u001b]0;Title\u0007\u001b]52;c;YWJj\u0007" +
    "\u001b]4;1;?;2;?\u0007\u001b]4;1;red;2;?\u0007" +
    "\u001bP$q m\u001b\\\u001bP+q544e\u001b\\\u001bPq#0;2;0;0;0\u001b\\" +
    "\u001b_Ga=q,i=1;AAAA\u001b\\" +
    "\u001bZ\u001b7\u001b(B\u001b8 end\n";

  const expected =
    "start " +
    "\u001b[32mgreen\u001b[0m" +
    "\u001b[4 q\u001b[!p\u001b[u" +
    "\u001b]11;rgb:12/34/56\u0007\u001b]0;Title\u0007\u001b]52;c;YWJj\u0007" +
    "\u001b\\\u001b]4;1;red;2;?\u0007" +
    "\u001bPq#0;2;0;0;0\u001b\\" +
    "\u001b_Ga=q,i=1;AAAA\u001b\\" +
    "\u001b7\u001b(B\u001b8 end\n";

  expect(sanitizeTerminalHistoryChunk("", input)).toEqual({
    visibleText: expected,
    pendingControlSequence: "",
  });

  // Feeding the exact same payload across arbitrary 1- and 5-char chunk boundaries must match.
  for (const step of [1, 5, 13]) {
    let pending = "";
    let visible = "";
    for (let offset = 0; offset < input.length; offset += step) {
      const next = sanitizeTerminalHistoryChunk(pending, input.slice(offset, offset + step));
      pending = next.pendingControlSequence;
      visible += next.visibleText;
    }
    expect(pending).toBe("");
    expect(visible).toBe(expected);
  }
});

it.effect(
  "lazily spawns the offload worker only for heavy escape bursts and matches inline parity",
  () =>
    Effect.gen(function* () {
      const worker = createTerminalVtSanitizerWorker();
      yield* Effect.addFinalizer(() => Effect.sync(() => worker.close()));

      expect(worker.isRunning()).toBe(false);

      // Interactive small chunks and large escape-free bursts stay inline without spawning a thread.
      const small = yield* worker.sanitize("", "\u001b[31mhi\u001b[0m\u001b[6n");
      expect(small).toEqual({ visibleText: "\u001b[31mhi\u001b[0m", pendingControlSequence: "" });
      expect(worker.isRunning()).toBe(false);

      const plainBurst = "x".repeat(VT_SANITIZER_OFFLOAD_THRESHOLD + 1_024);
      const plainResult = yield* worker.sanitize("", plainBurst);
      expect(plainResult).toEqual({ visibleText: plainBurst, pendingControlSequence: "" });
      expect(worker.isRunning()).toBe(false);

      // A heavy burst containing ANSI escapes triggers worker offload and matches inline parity.
      const unit =
        "\u001b[38;5;196mERR\u001b[0m \u001b[?2026$p\u001b]11;?\u0007\u001bP$q m\u001b\\" +
        "\u001b]0;build\u0007\u001b_apc\u001b\\café🚀\r\n";
      const burst =
        unit.repeat(Math.ceil((VT_SANITIZER_OFFLOAD_THRESHOLD + 4_096) / unit.length)) +
        "\u001b[?2026";

      expect(shouldOffloadVtSanitization("", burst)).toBe(true);
      const expectedBurst = sanitizeTerminalHistoryChunk("", burst);
      const workerBurst = yield* worker.sanitize("", burst);
      expect(workerBurst).toEqual(expectedBurst);
      expect(worker.isRunning()).toBe(true);

      // Continuing the split query from the burst across a second heavy burst preserves exact state.
      const continuation = "$p" + burst;
      const expectedContinuation = sanitizeTerminalHistoryChunk(
        expectedBurst.pendingControlSequence,
        continuation,
      );
      const workerContinuation = yield* worker.sanitize(
        workerBurst.pendingControlSequence,
        continuation,
      );
      expect(workerContinuation).toEqual(expectedContinuation);
    }),
);

it.effect("terminates an idle offload worker after inactivity and respawns on the next burst", () =>
  Effect.gen(function* () {
    const firstExited = yield* Deferred.make<void>();
    let exitCount = 0;
    const worker = createTerminalVtSanitizerWorker({
      idleTimeoutMs: 25,
      onWorkerExit: () => {
        exitCount += 1;
        if (exitCount === 1) {
          Deferred.doneUnsafe(firstExited, Effect.void);
        }
      },
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => worker.close()));

    const burst = "\u001b[32m".padEnd(VT_SANITIZER_OFFLOAD_THRESHOLD + 256, "a") + "\u001b[6n";
    const expected = sanitizeTerminalHistoryChunk("", burst);

    expect(yield* worker.sanitize("", burst)).toEqual(expected);
    expect(worker.isRunning()).toBe(true);

    yield* Deferred.await(firstExited);
    expect(worker.isRunning()).toBe(false);

    expect(yield* worker.sanitize("", burst)).toEqual(expected);
    expect(worker.isRunning()).toBe(true);
  }),
);

it.effect("falls back cleanly to inline sanitization when worker threads are unavailable", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const worker = createTerminalVtSanitizerWorker({
      createWorker: () => {
        attempts += 1;
        throw new Error("worker threads unavailable");
      },
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => worker.close()));

    const burst = "\u001b[31m" + "a".repeat(VT_SANITIZER_OFFLOAD_THRESHOLD) + "\u001b[6n\u001b[0m";
    const expected = sanitizeTerminalHistoryChunk("", burst);

    expect(yield* worker.sanitize("", burst)).toEqual(expected);
    expect(yield* worker.sanitize("", burst)).toEqual(expected);
    expect(attempts).toBe(1);
    expect(worker.isRunning()).toBe(false);
  }),
);
