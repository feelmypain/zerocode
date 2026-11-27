import { EPHEMERAL_THREADS_CLEANUP_PATH, EnvironmentId, ThreadId } from "@zerocode/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../state/entities", () => ({
  readThreadShell: vi.fn(),
}));

vi.mock("../state/session", () => ({
  readPreparedConnection: vi.fn(),
}));

vi.mock("../state/threads", () => ({
  threadEnvironment: { delete: {} },
}));

import { readThreadShell } from "../state/entities";
import { readPreparedConnection } from "../state/session";
import {
  clearTrackedSessionEphemeralThreads,
  flushSessionEphemeralThreadsCleanup,
  listTrackedSessionEphemeralThreads,
  trackSessionEphemeralThread,
  untrackSessionEphemeralThread,
} from "./ephemeralThreads";

const ENV_ID = EnvironmentId.make("env:ephemeral-test");
const THREAD_A = ThreadId.make("thread:ephemeral-a");
const THREAD_B = ThreadId.make("thread:ephemeral-b");
const THREAD_KEPT = ThreadId.make("thread:ephemeral-kept");

describe("ephemeralThreads exit cleanup", () => {
  afterEach(() => {
    clearTrackedSessionEphemeralThreads();
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
});
