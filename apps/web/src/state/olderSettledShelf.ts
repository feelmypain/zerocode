import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@zerocode/client-runtime/state/models";
import {
  OLDER_SETTLED_NO_PAGES,
  mountOlderSettledShelfPages,
  olderSettledShelfPagesStatus,
  olderSettledShelfScopes,
  readUnloadedProjectThreadCount,
  retryOlderSettledShelfPages,
  type OlderSettledShelfScopePage,
} from "@zerocode/client-runtime/state/older-settled-shelf";
import {
  isListedSettledThread,
  settledShelfFrontier,
  sortOlderSettledScopes,
  unloadedOlderSettledCount,
  wantedOlderSettledPages,
  type OlderSettledScope,
} from "@zerocode/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@zerocode/contracts";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { olderSettledThreads, threadFamilies } from "./threads";

/**
 * The Settled shelf for one scope when shells leave older settled threads out: which rows it may
 * list, how many threads it holds in all, and the pages read below each environment's cut, whose
 * rows merge into the thread list. `useOlderSettledShelfGrowth` reads the next pages.
 */
export function useOlderSettledShelf(input: {
  readonly scopes: ReadonlyArray<OlderSettledScope>;
  /** A collapsed shelf mounts no pages, so a reconnect reads none; expanding restores them. */
  readonly expanded: boolean;
  /** Rows the shelf shows; pages are read until it lists that many. */
  readonly visibleCount: number;
}) {
  const scopes = sortOlderSettledScopes(input.scopes);
  const scopeKey = JSON.stringify(scopes);
  const [requested, setRequested] = useState({ scopeKey, pages: OLDER_SETTLED_NO_PAGES });
  const pages =
    requested.scopeKey === scopeKey && input.expanded ? requested.pages : OLDER_SETTLED_NO_PAGES;
  const shelfScopes = olderSettledShelfScopes(scopes, pages);
  const shelfKey = JSON.stringify(shelfScopes);
  const shelf = useAtomValue(olderSettledThreads.shelfAtom(shelfScopes));
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- mounts the requested older settled pages into the thread family registry while shown
  useEffect(
    () =>
      mountOlderSettledShelfPages({
        registry: appAtomRegistry,
        shelfScopes: JSON.parse(shelfKey) as ReadonlyArray<OlderSettledShelfScopePage>,
        mountRows: threadFamilies.mountRows,
        rowsKey: olderSettledThreads.rowsKey,
        pageRowsAtom: olderSettledThreads.pageRowsAtom,
      }),
    [shelfKey],
  );

  const olderOf = (environmentId: EnvironmentId) => shelf.get(environmentId)?.older ?? null;
  const frontier = settledShelfFrontier([...shelf.values()]);
  const { loading, failed } = olderSettledShelfPagesStatus(shelf, shelfScopes);
  return {
    environments: shelf,
    visibleCount: input.expanded ? input.visibleCount : 0,
    pages,
    grow: (next: ReadonlyMap<EnvironmentId, number>) => setRequested({ scopeKey, pages: next }),
    isListed: (thread: EnvironmentThreadShell) => isListedSettledThread(thread.source, frontier),
    /** Older settled threads in scope that are not local; add it to the local Settled rows. */
    unloadedCount: (threads: ReadonlyArray<EnvironmentThreadShell>) =>
      unloadedOlderSettledCount({ olderSettled: olderOf, scopes, threads }),
    loading,
    failed,
    retry: () =>
      retryOlderSettledShelfPages({
        registry: appAtomRegistry,
        shelfScopes,
        retryPages: olderSettledThreads.retryPages,
      }),
  };
}

/** Reads the next pages while the shelf lists fewer rows than it shows. */
export function useOlderSettledShelfGrowth(
  shelf: ReturnType<typeof useOlderSettledShelf>,
  listedSettledThreads: ReadonlyArray<EnvironmentThreadShell>,
) {
  const wanted = wantedOlderSettledPages({
    requested: shelf.pages,
    environments: shelf.environments,
    listedCount: listedSettledThreads.length,
    visibleCount: shelf.visibleCount,
  });
  const { grow, pages } = shelf;
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- requests more older settled pages when the listed threads cannot fill the visible count
  useEffect(() => {
    if (wanted !== pages) grow(wanted);
  }, [wanted, pages, grow]);
}

/**
 * Threads of these projects that this client does not hold (older settled threads), for counts
 * shown outside the shelf, such as a removal confirm.
 */
export function readUnloadedThreadCount(
  members: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ProjectId }>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): number {
  return readUnloadedProjectThreadCount({
    olderSettled: (environmentId) =>
      appAtomRegistry.get(olderSettledThreads.olderSettledAtom(environmentId)),
    members,
    threads,
  });
}
