import { EPHEMERAL_THREADS_CLEANUP_PATH, EnvironmentId, ThreadId } from "@zerocode/contracts";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  preparedConnection: { _tag: "None" } as unknown,
  shellByThreadId: new Map<
    string,
    { readonly id: ThreadId; readonly ephemeral?: boolean } | null
  >(),
  runAtomCommand: vi.fn(),
  deleteCommand: { label: "thread.delete" },
}));

vi.mock("@zerocode/client-runtime/state/runtime", () => ({
  runAtomCommand: (...args: ReadonlyArray<unknown>) => mocks.runAtomCommand(...args),
}));

vi.mock("../state/session", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentSession: {
      preparedConnectionValueAtom: () => Atom.make(mocks.preparedConnection),
    },
  };
});

vi.mock("../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentThreadShells: {
      threadShellAtom: (ref: { readonly threadId: ThreadId }) =>
        Atom.make(mocks.shellByThreadId.get(ref.threadId) ?? null),
    },
    threadEnvironment: {
      delete: mocks.deleteCommand,
    },
  };
});

import { appAtomRegistry } from "../state/atom-registry";
import {
  clearTrackedMobileEphemeralThreads,
  deleteMobileEphemeralThreadOnLeave,
  flushPendingMobileEphemeralDeletion,
  isTrackedMobileEphemeralThread,
  markMobileEphemeralThreadKept,
  trackMobileEphemeralThread,
  unmarkMobileEphemeralThreadKept,
  untrackMobileEphemeralThread,
} from "./ephemeralThreads";

const ENV_ID = EnvironmentId.make("env:mobile-ephemeral-test");
const THREAD_A = ThreadId.make("thread:mobile-ephemeral-a");
const THREAD_B = ThreadId.make("thread:mobile-ephemeral-b");
const THREAD_KEPT = ThreadId.make("thread:mobile-ephemeral-kept");

describe("mobile ephemeralThreads leave cleanup", () => {
  afterEach(() => {
    clearTrackedMobileEphemeralThreads();
    mocks.shellByThreadId.clear();
    mocks.preparedConnection = Option.none();
    mocks.runAtomCommand.mockReset();
    vi.restoreAllMocks();
  });

  it("posts bearer-authenticated cleanup for an ephemeral thread on leave", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    mocks.preparedConnection = Option.some({
      httpBaseUrl: "http://127.0.0.1:3773",
      httpAuthorization: { _tag: "Bearer", token: "secret-token" },
    });
    mocks.shellByThreadId.set(THREAD_A, { id: THREAD_A, ephemeral: true });

    const ref = { environmentId: ENV_ID, threadId: THREAD_A };
    trackMobileEphemeralThread(ref);
    expect(isTrackedMobileEphemeralThread(ref)).toBe(true);

    deleteMobileEphemeralThreadOnLeave(ref);

    expect(isTrackedMobileEphemeralThread(ref)).toBe(false);
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
    expect(mocks.runAtomCommand).not.toHaveBeenCalled();
  });

  it("uses credentialed cleanup fetch for cookie-authenticated connections", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    mocks.preparedConnection = Option.some({
      httpBaseUrl: "https://zerocode.local",
      httpAuthorization: null,
    });
    mocks.shellByThreadId.set(THREAD_A, { id: THREAD_A, ephemeral: true });

    deleteMobileEphemeralThreadOnLeave({ environmentId: ENV_ID, threadId: THREAD_A });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`https://zerocode.local${EPHEMERAL_THREADS_CLEANUP_PATH}`);
    expect(init).toMatchObject({
      method: "POST",
      keepalive: true,
      credentials: "include",
    });
  });

  it("falls back to threadEnvironment.delete when HTTP connection is absent or uses DPoP", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mocks.preparedConnection = Option.some({
      httpBaseUrl: "https://relay.zerocode.test",
      httpAuthorization: { _tag: "Dpop", accessToken: "dpop-token", expiresAtEpochMs: 1 },
    });
    mocks.shellByThreadId.set(THREAD_A, { id: THREAD_A, ephemeral: true });

    deleteMobileEphemeralThreadOnLeave({ environmentId: ENV_ID, threadId: THREAD_A });

    mocks.preparedConnection = Option.none();
    mocks.shellByThreadId.set(THREAD_B, { id: THREAD_B, ephemeral: true });
    deleteMobileEphemeralThreadOnLeave({ environmentId: ENV_ID, threadId: THREAD_B });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.runAtomCommand).toHaveBeenCalledTimes(2);
    expect(mocks.runAtomCommand).toHaveBeenNthCalledWith(
      1,
      appAtomRegistry,
      mocks.deleteCommand,
      { environmentId: ENV_ID, input: { threadId: THREAD_A } },
      { reportFailure: false },
    );
    expect(mocks.runAtomCommand).toHaveBeenNthCalledWith(
      2,
      appAtomRegistry,
      mocks.deleteCommand,
      { environmentId: ENV_ID, input: { threadId: THREAD_B } },
      { reportFailure: false },
    );
  });

  it("skips promoted threads and threads marked kept, but deletes again if keep is reverted", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    mocks.preparedConnection = Option.some({
      httpBaseUrl: "http://127.0.0.1:3773",
      httpAuthorization: { _tag: "Bearer", token: "secret-token" },
    });
    mocks.shellByThreadId.set(THREAD_KEPT, { id: THREAD_KEPT, ephemeral: false });
    mocks.shellByThreadId.set(THREAD_A, { id: THREAD_A, ephemeral: true });

    const promotedRef = { environmentId: ENV_ID, threadId: THREAD_KEPT };
    trackMobileEphemeralThread(promotedRef);
    deleteMobileEphemeralThreadOnLeave(promotedRef);
    expect(fetchSpy).not.toHaveBeenCalled();

    const refA = { environmentId: ENV_ID, threadId: THREAD_A };
    trackMobileEphemeralThread(refA);
    markMobileEphemeralThreadKept(refA);
    deleteMobileEphemeralThreadOnLeave(refA);
    expect(fetchSpy).not.toHaveBeenCalled();

    unmarkMobileEphemeralThreadKept(refA);
    deleteMobileEphemeralThreadOnLeave(refA);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("flushes pending leave deletion once in-flight creation finishes", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    mocks.preparedConnection = Option.some({
      httpBaseUrl: "http://127.0.0.1:3773",
      httpAuthorization: { _tag: "Bearer", token: "secret-token" },
    });

    const refA = { environmentId: ENV_ID, threadId: THREAD_A };
    const refB = { environmentId: ENV_ID, threadId: THREAD_B };

    // Untracked thread without a shell is ignored.
    deleteMobileEphemeralThreadOnLeave(refB);
    flushPendingMobileEphemeralDeletion(refB);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Tracked ephemeral thread whose shell has not arrived yet: leaving marks pending deletion.
    trackMobileEphemeralThread(refA);
    deleteMobileEphemeralThreadOnLeave(refA);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Outbox creation finishes afterwards and flushes the pending deletion once.
    flushPendingMobileEphemeralDeletion(refA);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Subsequent flushes are no-ops.
    flushPendingMobileEphemeralDeletion(refA);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Explicit untrack clears tracking before leave.
    trackMobileEphemeralThread(refB);
    untrackMobileEphemeralThread(refB);
    deleteMobileEphemeralThreadOnLeave(refB);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
