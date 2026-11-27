import { environmentEndpointUrl } from "@zerocode/client-runtime/environment";
import { runAtomCommand } from "@zerocode/client-runtime/state/runtime";
import {
  EPHEMERAL_THREADS_CLEANUP_PATH,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@zerocode/contracts";
import { useEffect } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { readPreparedConnection } from "../state/session";
import { threadEnvironment } from "../state/threads";

const trackedEphemeralThreads = new Map<EnvironmentId, Set<ThreadId>>();

export function trackSessionEphemeralThread(threadRef: ScopedThreadRef): void {
  let ids = trackedEphemeralThreads.get(threadRef.environmentId);
  if (ids === undefined) {
    ids = new Set();
    trackedEphemeralThreads.set(threadRef.environmentId, ids);
  }
  ids.add(threadRef.threadId);
}

export function untrackSessionEphemeralThread(threadRef: ScopedThreadRef): void {
  const ids = trackedEphemeralThreads.get(threadRef.environmentId);
  if (ids === undefined) return;
  ids.delete(threadRef.threadId);
  if (ids.size === 0) {
    trackedEphemeralThreads.delete(threadRef.environmentId);
  }
}

export function listTrackedSessionEphemeralThreads(): ReadonlyArray<ScopedThreadRef> {
  const refs: Array<ScopedThreadRef> = [];
  for (const [environmentId, ids] of trackedEphemeralThreads) {
    for (const threadId of ids) {
      refs.push({ environmentId, threadId });
    }
  }
  return refs;
}

export function clearTrackedSessionEphemeralThreads(): void {
  trackedEphemeralThreads.clear();
}

export function flushSessionEphemeralThreadsCleanup(): void {
  if (trackedEphemeralThreads.size === 0) return;
  const pendingByEnvironment = new Map<EnvironmentId, Array<ThreadId>>();
  for (const [environmentId, ids] of trackedEphemeralThreads) {
    const stillEphemeral: Array<ThreadId> = [];
    for (const threadId of ids) {
      const shell = readThreadShell({ environmentId, threadId });
      if (shell !== null && shell.ephemeral !== true) continue;
      stillEphemeral.push(threadId);
    }
    if (stillEphemeral.length > 0) {
      pendingByEnvironment.set(environmentId, stillEphemeral);
    }
  }
  trackedEphemeralThreads.clear();

  for (const [environmentId, threadIds] of pendingByEnvironment) {
    const prepared = readPreparedConnection(environmentId);
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
            body: JSON.stringify({ threadIds }),
          })
          .catch(() => undefined);
      } catch {
        // Ignore unload-time fetch failures; server shutdown/startup sweeps remaining ephemeral threads.
      }
      continue;
    }

    for (const threadId of threadIds) {
      try {
        void runAtomCommand(appAtomRegistry, threadEnvironment.delete, {
          environmentId,
          input: { threadId },
        });
      } catch {
        // Ignore teardown failures on disconnected environments.
      }
    }
  }
}

export function EphemeralThreadsCleanupCoordinator() {
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- subscribes to browser pagehide events to delete session ephemeral threads when leaving the app
  useEffect(() => {
    const handlePageHide = () => {
      flushSessionEphemeralThreadsCleanup();
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, []);

  return null;
}
