import * as NodeWorkerThreads from "node:worker_threads";

import * as Effect from "effect/Effect";

import {
  sanitizeTerminalHistoryChunk,
  serializeVtSanitizerFactory,
  shouldOffloadVtSanitization,
  type SanitizedTerminalChunk,
} from "./TerminalVtSanitizer.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

type ToSanitizerWorker =
  | {
      readonly type: "sanitize";
      readonly id: number;
      readonly pendingControlSequence: string;
      readonly data: string;
    }
  | { readonly type: "close" };

type FromSanitizerWorker =
  | { readonly id: number; readonly result: SanitizedTerminalChunk }
  | { readonly id: number; readonly error: string };

export interface TerminalVtSanitizerWorkerOptions {
  readonly idleTimeoutMs?: number | undefined;
  readonly createWorker?:
    | ((source: string, workerData: { readonly idleTimeoutMs: number }) => NodeWorkerThreads.Worker)
    | undefined;
  readonly onWorkerExit?: (() => void) | undefined;
}

export interface TerminalVtSanitizerWorker {
  readonly sanitize: (
    pendingControlSequence: string,
    data: string,
  ) => Effect.Effect<SanitizedTerminalChunk>;
  readonly close: () => void;
  readonly isRunning: () => boolean;
}

let cachedWorkerSource: string | undefined;

// Inline eval source runs in tsdown bundles, vitest, asar archives, and SEA builds without URL lookups.
function getWorkerSource(): string {
  if (cachedWorkerSource !== undefined) return cachedWorkerSource;
  cachedWorkerSource = [
    '"use strict";',
    'const { parentPort, workerData } = require("node:worker_threads");',
    `const sanitize = ${serializeVtSanitizerFactory()};`,
    "let idleTimer;",
    "const armIdleTimer = () => {",
    "  if (idleTimer !== undefined) clearTimeout(idleTimer);",
    "  const timeoutMs = workerData.idleTimeoutMs;",
    "  if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {",
    "    idleTimer = setTimeout(() => { parentPort.close(); }, timeoutMs);",
    "  }",
    "};",
    'parentPort.on("message", (request) => {',
    "  if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined; }",
    '  if (request.type === "close") {',
    "    parentPort.close();",
    "    return;",
    "  }",
    "  try {",
    "    const result = sanitize(request.pendingControlSequence, request.data);",
    "    parentPort.postMessage({ id: request.id, result });",
    "  } catch (error) {",
    "    const message = String(error && error.message ? error.message : error);",
    "    parentPort.postMessage({ id: request.id, error: message });",
    "  }",
    "  armIdleTimer();",
    "});",
    "armIdleTimer();",
  ].join("\n");
  return cachedWorkerSource;
}

export function createTerminalVtSanitizerWorker(
  options?: TerminalVtSanitizerWorkerOptions,
): TerminalVtSanitizerWorker {
  const idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const createWorker =
    options?.createWorker ??
    ((source, workerData) =>
      new NodeWorkerThreads.Worker(source, {
        eval: true,
        workerData,
      }));

  let worker: NodeWorkerThreads.Worker | undefined;
  let closed = false;
  let workerUnavailable = false;
  let nextRequestId = 0;

  const pending = new Map<
    number,
    {
      readonly pendingControlSequence: string;
      readonly data: string;
      readonly resume: (result: SanitizedTerminalChunk) => void;
    }
  >();

  const ensureWorker = (): NodeWorkerThreads.Worker | undefined => {
    if (worker !== undefined) return worker;
    if (closed || workerUnavailable) return undefined;

    let instance: NodeWorkerThreads.Worker;
    try {
      instance = createWorker(getWorkerSource(), { idleTimeoutMs });
    } catch {
      workerUnavailable = true;
      return undefined;
    }

    let detached = false;
    const detach = (markUnavailable: boolean) => {
      if (detached) return;
      detached = true;
      if (worker === instance) {
        worker = undefined;
      }
      if (markUnavailable) {
        workerUnavailable = true;
      }
      const inFlight = [...pending.values()];
      pending.clear();
      for (const entry of inFlight) {
        entry.resume(sanitizeTerminalHistoryChunk(entry.pendingControlSequence, entry.data));
      }
      options?.onWorkerExit?.();
    };

    instance.on("message", (reply: FromSanitizerWorker) => {
      const entry = pending.get(reply.id);
      if (entry === undefined) return;
      pending.delete(reply.id);
      if (pending.size === 0 && worker === instance) {
        instance.unref();
      }
      if ("result" in reply) {
        entry.resume(reply.result);
      } else {
        entry.resume(sanitizeTerminalHistoryChunk(entry.pendingControlSequence, entry.data));
      }
    });
    instance.on("error", () => {
      detach(true);
      void instance.terminate();
    });
    instance.on("exit", (code) => {
      detach(code !== 0 && !closed);
    });
    instance.unref();
    worker = instance;
    return instance;
  };

  const sanitize = (
    pendingControlSequence: string,
    data: string,
  ): Effect.Effect<SanitizedTerminalChunk> => {
    if (!shouldOffloadVtSanitization(pendingControlSequence, data)) {
      return Effect.sync(() => sanitizeTerminalHistoryChunk(pendingControlSequence, data));
    }

    return Effect.callback<SanitizedTerminalChunk>((resume) => {
      const activeWorker = ensureWorker();
      if (activeWorker === undefined) {
        resume(Effect.succeed(sanitizeTerminalHistoryChunk(pendingControlSequence, data)));
        return;
      }

      const id = ++nextRequestId;
      pending.set(id, {
        pendingControlSequence,
        data,
        resume: (result) => resume(Effect.succeed(result)),
      });
      if (pending.size === 1) {
        activeWorker.ref();
      }

      const message: ToSanitizerWorker = {
        type: "sanitize",
        id,
        pendingControlSequence,
        data,
      };
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
        activeWorker.postMessage(message);
      } catch {
        pending.delete(id);
        if (pending.size === 0 && worker === activeWorker) {
          activeWorker.unref();
        }
        resume(Effect.succeed(sanitizeTerminalHistoryChunk(pendingControlSequence, data)));
        return;
      }

      return Effect.sync(() => {
        if (pending.delete(id) && pending.size === 0 && worker === activeWorker) {
          activeWorker.unref();
        }
      });
    });
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    const activeWorker = worker;
    worker = undefined;
    const inFlight = [...pending.values()];
    pending.clear();
    for (const entry of inFlight) {
      entry.resume(sanitizeTerminalHistoryChunk(entry.pendingControlSequence, entry.data));
    }
    if (activeWorker !== undefined) {
      void activeWorker.terminate();
    }
  };

  return {
    sanitize,
    close,
    isRunning: () => worker !== undefined,
  };
}
