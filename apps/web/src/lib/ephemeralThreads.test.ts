import { EPHEMERAL_THREADS_CLEANUP_PATH, EnvironmentId, ThreadId } from "@zerocode/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@zerocode/client-runtime/state/runtime", () => ({
  runAtomCommand: vi.fn(),
}));

vi.mock("../state/entities", () => ({
  readThreadShell: vi.fn(),
}));

vi.mock("../state/session", () => ({
  readPreparedConnection: vi.fn(),
}));

vi.mock("../state/threads", () => ({
  threadEnvironment: { delete: { tag: "thread.delete" } },
}));

import { runAtomCommand } from "@zerocode/client-runtime/state/runtime";
import { readThreadShell } from "../state/entities";
import { readPreparedConnection } from "../state/session";
import {
  clearTrackedSessionEphemeralThreads,
  deleteSessionEphemeralThreadOnLeave,
  flushPendingEphemeralLeaveDeletion,
  flushSessionEphemeralThreadsCleanup,
  isTrackedSessionEphemeralThread,
  listTrackedSessionEphemeralThreads,
  markSessionEphemeralThreadKept,
  trackSessionEphemeralThread,
  unmarkSessionEphemeralThreadKept,
  untrackSessionEphemeralThread,
} from "./ephemeralThreads";

const ENV_ID = EnvironmentId.make("env:ephemeral-test");
const THREAD_A = ThreadId.make("thread:ephemeral-a");
const THREAD_B = ThreadId.make("thread:ephemeral-b");
const THREAD_KEPT = ThreadId.make("thread:ephemeral-kept");

describe("ephemeralThreads exit cleanup", () => {
  afterEach(() => {
    clearTrackedSessionEphemeralThreads();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("sends keepalive cleanup for still-ephemeral tracked threads and skips promoted threads", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.mocked(readPreparedConnection).mockReturnValue({
      httpBaseUrl: "http://127.0.0.1:3773",
      httpAuthorization: { _tag: "Bearer", token: "secret-token" },
    } as never);
    vi.mocked(readThreadShell).mockImplementation(({ threadId }) => {
      if (threadId === THREAD_KEPT) return { id: threadId, ephemeral: false } as never;
      return { id: threadId, ephemeral: true } as never;
    });

    trackSessionEphemeralThread({ environmentId: ENV_ID, threadId: THREAD_A });
    trackSessionEphemeralThread({ environmentId: ENV_ID, threadId: THREAD_B });
    trackSessionEphemeralThread({ environmentId: ENV_ID, threadId: THREAD_KEPT });
    untrackSessionEphemeralThread({ environmentId: ENV_ID, threadId: THREAD_B });

    flushSessionEphemeralThreadsCleanup();

    expect(listTrackedSessionEphemeralThreads()).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`http://127.0.0.1:3773${EPHEMERAL_THREADS_CLEANUP_PATH}`);
    expect(init).toMatchObject({
      method: "POST",
      keepalive: true,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
      },
      body: JSON.stringify({ threadIds: [THREAD_A] }),
    });
  });

  it("uses credentialed keepalive fetch for cookie-authenticated environments", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.mocked(readPreparedConnection).mockReturnValue({
      httpBaseUrl: "https://zerocode.local",
      httpAuthorization: null,
    } as never);
    vi.mocked(readThreadShell).mockReturnValue({ id: THREAD_A, ephemeral: true } as never);

    trackSessionEphemeralThread({ environmentId: ENV_ID, threadId: THREAD_A });
    flushSessionEphemeralThreadsCleanup();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`https://zerocode.local${EPHEMERAL_THREADS_CLEANUP_PATH}`);
    expect(init).toMatchObject({
      method: "POST",
      keepalive: true,
      credentials: "include",
    });
  });

  it("chunks cleanup requests into batches of at most 256 thread ids", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.mocked(readPreparedConnection).mockReturnValue({
      httpBaseUrl: "http://127.0.0.1:3773",
      httpAuthorization: { _tag: "Bearer", token: "secret-token" },
    } as never);
    vi.mocked(readThreadShell).mockReturnValue({ id: THREAD_A, ephemeral: true } as never);

    for (let index = 0; index < 260; index += 1) {
      trackSessionEphemeralThread({
        environmentId: ENV_ID,
        threadId: ThreadId.make(`thread:ephemeral-${index}`),
      });
    }

    flushSessionEphemeralThreadsCleanup();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
      threadIds: string[];
    };
    const secondBody = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body)) as {
      threadIds: string[];
    };
    expect(firstBody.threadIds).toHaveLength(256);
    expect(secondBody.threadIds).toHaveLength(4);
  });

  it("deletes an ephemeral thread on leave and falls back to RPC delete for non-Bearer auth", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.mocked(readPreparedConnection).mockReturnValue({
      httpBaseUrl: "http://127.0.0.1:3773",
      httpAuthorization: { _tag: "Bearer", token: "secret-token" },
    } as never);
    vi.mocked(readThreadShell).mockReturnValue({ id: THREAD_A, ephemeral: true } as never);

    const refA = { environmentId: ENV_ID, threadId: THREAD_A };
    trackSessionEphemeralThread(refA);
    expect(isTrackedSessionEphemeralThread(refA)).toBe(true);

    deleteSessionEphemeralThreadOnLeave(refA);

    expect(isTrackedSessionEphemeralThread(refA)).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      threadIds: [THREAD_A],
    });

    vi.mocked(readPreparedConnection).mockReturnValue({
      httpBaseUrl: "http://127.0.0.1:3773",
      httpAuthorization: { _tag: "DPoP" },
    } as never);
    vi.mocked(readThreadShell).mockReturnValue({ id: THREAD_B, ephemeral: true } as never);

    deleteSessionEphemeralThreadOnLeave({ environmentId: ENV_ID, threadId: THREAD_B });

    expect(runAtomCommand).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      environmentId: ENV_ID,
      input: { threadId: THREAD_B },
    });
  });

  it("does not delete a thread marked kept before server metadata echoes ephemeral: false", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.mocked(readPreparedConnection).mockReturnValue({
      httpBaseUrl: "http://127.0.0.1:3773",
      httpAuthorization: { _tag: "Bearer", token: "secret-token" },
    } as never);
    // Server shell still reports ephemeral: true while updateMetadata is in flight.
    vi.mocked(readThreadShell).mockReturnValue({ id: THREAD_KEPT, ephemeral: true } as never);

    const ref = { environmentId: ENV_ID, threadId: THREAD_KEPT };
    trackSessionEphemeralThread(ref);
    markSessionEphemeralThreadKept(ref);

    deleteSessionEphemeralThreadOnLeave(ref);
    flushSessionEphemeralThreadsCleanup();
    expect(fetchSpy).not.toHaveBeenCalled();

    // Reverting after a failed keep-chat RPC restores leave deletion.
    unmarkSessionEphemeralThreadKept(ref);
    trackSessionEphemeralThread(ref);
    deleteSessionEphemeralThreadOnLeave(ref);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("flushes a pending leave deletion once in-flight thread creation finishes", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.mocked(readPreparedConnection).mockReturnValue({
      httpBaseUrl: "http://127.0.0.1:3773",
      httpAuthorization: { _tag: "Bearer", token: "secret-token" },
    } as never);
    // Thread shell does not exist yet while launchThread is in flight.
    vi.mocked(readThreadShell).mockReturnValue(null);

    const ref = { environmentId: ENV_ID, threadId: THREAD_A };
    trackSessionEphemeralThread(ref);
    deleteSessionEphemeralThreadOnLeave(ref);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Server commits the ephemeral thread and startThreadTurn resolves.
    vi.mocked(readThreadShell).mockReturnValue({ id: THREAD_A, ephemeral: true } as never);
    flushPendingEphemeralLeaveDeletion(ref);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Subsequent flushes are no-ops.
    flushPendingEphemeralLeaveDeletion(ref);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
