import { environmentEndpointUrl } from "@zerocode/client-runtime/environment";
import { runAtomCommand } from "@zerocode/client-runtime/state/runtime";
import { EPHEMERAL_THREADS_CLEANUP_PATH, type ScopedThreadRef } from "@zerocode/contracts";
import * as Option from "effect/Option";

import { scopedThreadKey } from "./scopedEntities";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentSession } from "../state/session";
import { environmentThreadShells, threadEnvironment } from "../state/threads";

const trackedMobileEphemeralThreadKeys = new Set<string>();
const keptMobileEphemeralThreadKeys = new Set<string>();
const pendingLeaveDeletionKeys = new Set<string>();

export function trackMobileEphemeralThread(ref: ScopedThreadRef): void {
  const key = scopedThreadKey(ref.environmentId, ref.threadId);
  keptMobileEphemeralThreadKeys.delete(key);
  pendingLeaveDeletionKeys.delete(key);
  trackedMobileEphemeralThreadKeys.add(key);
}

export function untrackMobileEphemeralThread(ref: ScopedThreadRef): void {
  trackedMobileEphemeralThreadKeys.delete(scopedThreadKey(ref.environmentId, ref.threadId));
}

export function isTrackedMobileEphemeralThread(ref: ScopedThreadRef): boolean {
  return trackedMobileEphemeralThreadKeys.has(scopedThreadKey(ref.environmentId, ref.threadId));
}

export function markMobileEphemeralThreadKept(ref: ScopedThreadRef): void {
  const key = scopedThreadKey(ref.environmentId, ref.threadId);
  keptMobileEphemeralThreadKeys.add(key);
  pendingLeaveDeletionKeys.delete(key);
}

export function unmarkMobileEphemeralThreadKept(ref: ScopedThreadRef): void {
  keptMobileEphemeralThreadKeys.delete(scopedThreadKey(ref.environmentId, ref.threadId));
}

function dispatchMobileEphemeralThreadDeletion(ref: ScopedThreadRef): void {
  const prepared = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(ref.environmentId)),
  );
  if (
    prepared !== null &&
    (prepared.httpAuthorization === null || prepared.httpAuthorization._tag === "Bearer")
  ) {
    const url = environmentEndpointUrl(prepared.httpBaseUrl, EPHEMERAL_THREADS_CLEANUP_PATH);
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (prepared.httpAuthorization?._tag === "Bearer") {
      headers.authorization = `Bearer ${prepared.httpAuthorization.token}`;
    }
    try {
      void globalThis
        .fetch(url, {
          method: "POST",
          keepalive: true,
          ...(prepared.httpAuthorization === null ? { credentials: "include" as const } : {}),
          headers,
          body: JSON.stringify({ threadIds: [ref.threadId] }),
        })
        .catch(() => undefined);
    } catch {
      // Ignore teardown fetch failures; server startup/shutdown sweeps remaining ephemeral threads.
    }
    return;
  }

  try {
    void runAtomCommand(
      appAtomRegistry,
      threadEnvironment.delete,
      {
        environmentId: ref.environmentId,
        input: { threadId: ref.threadId },
      },
      { reportFailure: false },
    );
  } catch {
    // Ignore teardown failures on disconnected environments.
  }
}

export function deleteMobileEphemeralThreadOnLeave(ref: ScopedThreadRef): void {
  const key = scopedThreadKey(ref.environmentId, ref.threadId);
  if (keptMobileEphemeralThreadKeys.has(key)) {
    untrackMobileEphemeralThread(ref);
    return;
  }
  const shell = appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref));
  const eligible = shell !== null ? shell.ephemeral === true : isTrackedMobileEphemeralThread(ref);
  if (!eligible) {
    untrackMobileEphemeralThread(ref);
    return;
  }
  // Keep a pending marker in case outbox creation finishes after the user already left.
  pendingLeaveDeletionKeys.add(key);
  untrackMobileEphemeralThread(ref);
  dispatchMobileEphemeralThreadDeletion(ref);
}

export function flushPendingMobileEphemeralDeletion(ref: ScopedThreadRef): void {
  const key = scopedThreadKey(ref.environmentId, ref.threadId);
  if (!pendingLeaveDeletionKeys.delete(key)) {
    return;
  }
  if (keptMobileEphemeralThreadKeys.has(key)) {
    return;
  }
  const shell = appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref));
  if (shell !== null && shell.ephemeral !== true) {
    return;
  }
  dispatchMobileEphemeralThreadDeletion(ref);
}

export function clearTrackedMobileEphemeralThreads(): void {
  trackedMobileEphemeralThreadKeys.clear();
  keptMobileEphemeralThreadKeys.clear();
  pendingLeaveDeletionKeys.clear();
}
