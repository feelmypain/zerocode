import { errorDisplayMessage } from "@zerocode/client-runtime/errors";
import { useAtomValue } from "@effect/atom-react";
import { msg } from "gt-react";
import {
  type CheckpointDiffTarget,
  type ComposerPathSearchTarget,
} from "@zerocode/client-runtime/state/threads";
import {
  INITIAL_BRANCH_CURSORS,
  VCS_REF_LIST_LIMIT,
  appendPaginatedBranchCursor,
  boundProjectPathSearchQuery,
  buildCheckpointDiffTargets,
  canSearchThreads,
  createOlderSettledThreadSearchAtoms,
  mergePaginatedVcsRefResults,
  normalizeComposerPathSearchQuery,
  normalizeThreadSearchQuery,
  settledThreadSearchReady,
  vcsRefPageInput,
} from "@zerocode/client-runtime/state/query-helpers";
import {
  makeThreadSearchKey,
  visibleThreadSearch,
  type EnvironmentThreadSearchMatch,
  type SettledThreadSearch,
  type ThreadSearchScope,
} from "@zerocode/client-runtime/state/thread-search";
import {
  ProjectSearchContentsError,
  PROJECT_SEARCH_CONTENTS_QUERY_MAX_LENGTH,
} from "@zerocode/contracts";
import { type VcsRefTarget } from "@zerocode/client-runtime/state/vcs";
import type {
  EnvironmentId,
  OrchestrationV2GetTurnItemResult,
  ProjectContentMatch,
  ProjectEntry,
  ProjectEntryKind,
  ThreadId,
  TurnItemId,
} from "@zerocode/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { Atom, type AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import { m, type MessageResolver } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useFilesystemReadAccess } from "./filesystem";
import { orchestrationEnvironment } from "./orchestration";
import { olderSettledThreads, threadFamilies } from "./threads";
import { projectContentSearch, projectEnvironment } from "./projects";
import { useEnvironmentQuery } from "./query";
import { vcsEnvironment } from "./vcs";

const PROJECT_PATH_SEARCH_DEBOUNCE_MS = 120;
const COMPOSER_PATH_SEARCH_LIMIT = 80;
const PROJECT_CONTENT_SEARCH_DEBOUNCE_MS = 120;
const PROJECT_CONTENT_SEARCH_LIMIT = 500;
const PROJECT_CONTENT_SEARCH_SCAN_RETRY_MS = 30_000;
const isProjectSearchContentsError = Schema.is(ProjectSearchContentsError);
const THREAD_SEARCH_DEBOUNCE_MS = 120;
const EMPTY_PROJECT_ENTRIES: ReadonlyArray<ProjectEntry> = [];
const EMPTY_CONTENT_MATCHES: ReadonlyArray<ProjectContentMatch> = [];
const threadSearch = createOlderSettledThreadSearchAtoms({
  getOlderSettledAtom: (environmentId) => olderSettledThreads.olderSettledAtom(environmentId),
  getLiveSearchAtom: (environmentId, input) =>
    orchestrationEnvironment.threadSearch({ environmentId, input }),
  getOlderSearchAtom: (environmentId, input) =>
    olderSettledThreads.searchAtom(environmentId, input),
  labelPrefix: "web",
});

export function useDebouncedValue<A>(value: A, delayMs: number): A {
  const [debounced, setDebounced] = useState(value);

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- debounce timer that publishes the value after delayMs
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [delayMs, value]);

  return debounced;
}

/**
 * Server matches for a thread search: message hits, and on environments that leave older settled
 * threads out of the shell, the rows of the best older matches, mounted into the thread list while
 * they show so the caller's own ranking finds them.
 */
export function useThreadSearch(
  environmentIds: ReadonlyArray<EnvironmentId>,
  query: string,
  scope: ThreadSearchScope = {},
): {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly query: string;
  readonly isPending: boolean;
  /** No environment could run the search for the current query, so an empty result is not "no matches". */
  readonly failed: boolean;
} {
  // A pasted wall of text searches by its start rather than failing the request.
  const normalizedQuery = normalizeThreadSearchQuery(query);
  const debouncedQuery = useDebouncedValue(normalizedQuery, THREAD_SEARCH_DEBOUNCE_MS);
  const anyOlderSettled = useAtomValue(
    threadSearch.anyOlderSettledAtom(JSON.stringify(environmentIds)),
  );
  // Messages need a word of three or more letters; older settled titles match from two.
  const canSearch = canSearchThreads({ environmentIds, normalizedQuery, scope, anyOlderSettled });
  const settledQuery = canSearch && normalizedQuery === debouncedQuery ? debouncedQuery : null;
  const searchKeyOf = (searchQuery: string) =>
    makeThreadSearchKey(environmentIds, searchQuery, scope);
  const searchKey = settledQuery === null ? null : searchKeyOf(settledQuery);
  const result = useAtomValue(
    searchKey === null ? threadSearch.emptyResultsAtom : threadSearch.results(searchKey),
  );
  const isPending = canSearch && (normalizedQuery !== debouncedQuery || result.isLoading);
  const failed = settledQuery !== null && !result.isLoading && result.failed;
  // What fast environments returned shows without waiting for a slow one;
  // callers keep shown rows in place with `nextShownOrder`.
  const ready = settledThreadSearchReady(settledQuery, result);
  // Kept from earlier renders: React's pattern for information from previous renders.
  const [previous, setPrevious] = useState<SettledThreadSearch | null>(null);
  if (ready !== null && previous?.matches !== ready.matches) setPrevious(ready);
  const visible = canSearch
    ? visibleThreadSearch(normalizedQuery, ready, previous)
    : { query: "", matches: threadSearch.emptyMatches };
  // The shown results' rows stay mounted until newer results replace them.
  const shownKey = visible.query === "" ? null : searchKeyOf(visible.query);
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- mounts the shown search results' rows into the thread family registry until newer results replace them
  useEffect(() => {
    if (shownKey === null) return;
    const environments = (JSON.parse(shownKey) as [ReadonlyArray<EnvironmentId>])[0];
    const releases = environments.map((environmentId) =>
      threadFamilies.mountRows(
        appAtomRegistry,
        environmentId,
        `search:${shownKey}`,
        threadSearch.rows(shownKey, environmentId),
      ),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [shownKey]);
  return {
    matches: visible.matches,
    query: visible.query,
    isPending,
    failed,
  };
}

function vcsRefPageAtom(targetKey: string, cursor: number | undefined) {
  const [environmentId, cwd, query] = JSON.parse(targetKey) as [EnvironmentId, string, string];
  return vcsEnvironment.listRefs({
    environmentId,
    input: vcsRefPageInput(cwd, query, cursor, VCS_REF_LIST_LIMIT),
  });
}

const EMPTY_VCS_REF_PAGES_ATOM = Atom.make<
  ReadonlyArray<Atom.Type<ReturnType<typeof vcsRefPageAtom>>>
>([]).pipe(Atom.withLabel("web:vcs-ref-pages:empty"));

const vcsRefPagesAtom = Atom.family((pagesKey: string) => {
  const [targetKey, cursors] = JSON.parse(pagesKey) as [string, Array<number | null>];
  const pageAtoms = cursors.map((cursor) => vcsRefPageAtom(targetKey, cursor ?? undefined));
  return Atom.make((get) => pageAtoms.map((atom) => get(atom))).pipe(
    Atom.withLabel(`web:vcs-ref-pages:${pagesKey}`),
  );
});

export function usePaginatedBranches(target: VcsRefTarget, resolve: MessageResolver = m) {
  // Leave unkeyed; mismatches already reset cursors, and a seeded key would break caching across the hook.
  const [pagination, setPagination] = useState<{
    readonly targetKey: string | null;
    readonly cursors: ReadonlyArray<number | undefined>;
  }>({
    targetKey: null,
    cursors: INITIAL_BRANCH_CURSORS,
  });
  const { environmentId, cwd } = target;
  const query = target.query?.trim() ?? "";
  const targetKey =
    environmentId !== null && cwd !== null ? JSON.stringify([environmentId, cwd, query]) : null;
  const cursors = pagination.targetKey === targetKey ? pagination.cursors : INITIAL_BRANCH_CURSORS;
  const pagesKey = targetKey === null ? null : JSON.stringify([targetKey, cursors]);
  const results = useAtomValue(
    pagesKey === null ? EMPTY_VCS_REF_PAGES_ATOM : vcsRefPagesAtom(pagesKey),
  );
  const { data, refs, isPending, isFetchingNextPage, failed } =
    mergePaginatedVcsRefResults(results);
  const error =
    failed !== undefined
      ? (() => {
          const cause = Cause.squash(failed.cause);
          return (
            (cause instanceof Error ? errorDisplayMessage(cause, resolve) : null) ??
            resolve(msg("Failed to load refs."))
          );
        })()
      : null;
  const refresh = () => {
    setPagination({ targetKey, cursors: INITIAL_BRANCH_CURSORS });
    if (targetKey !== null) {
      appAtomRegistry.refresh(vcsRefPageAtom(targetKey, undefined));
    }
  };
  const nextCursor = data?.nextCursor;
  const loadNext = () => {
    if (targetKey === null || nextCursor === null || nextCursor === undefined) {
      return;
    }
    setPagination((current) => appendPaginatedBranchCursor(current, targetKey, nextCursor));
  };

  return {
    data,
    refs,
    error,
    isPending,
    isFetchingNextPage,
    refresh,
    loadNext,
  };
}

type ProjectPathSearchTarget = ComposerPathSearchTarget & {
  readonly kind?: ProjectEntryKind | undefined;
  readonly imageOnly?: boolean | undefined;
};

function areProjectPathSearchTargetsEqual(
  left: ProjectPathSearchTarget,
  right: ProjectPathSearchTarget,
): boolean {
  return (
    left.environmentId === right.environmentId &&
    left.cwd === right.cwd &&
    left.query === right.query &&
    left.kind === right.kind &&
    left.imageOnly === right.imageOnly
  );
}

export function useProjectPathSearch(
  target: ProjectPathSearchTarget,
  limit: number,
  options?: { readonly allowEmptyQuery?: boolean },
  resolve: MessageResolver = m,
) {
  const allowEmptyQuery = options?.allowEmptyQuery === true;
  const normalizedTarget = {
    environmentId: target.environmentId,
    cwd: target.cwd,
    query: normalizeComposerPathSearchQuery(target.query),
    kind: target.kind,
    imageOnly: target.imageOnly,
  };
  const debouncedTarget = useDebouncedValue(normalizedTarget, PROJECT_PATH_SEARCH_DEBOUNCE_MS);
  const fileAccess = useFilesystemReadAccess(debouncedTarget.environmentId, resolve);
  const { canReadFiles } = fileAccess;
  const searchTarget =
    debouncedTarget.environmentId !== null &&
    debouncedTarget.cwd !== null &&
    debouncedTarget.query !== null &&
    (allowEmptyQuery || debouncedTarget.query.length > 0)
      ? {
          environmentId: debouncedTarget.environmentId,
          input: {
            cwd: debouncedTarget.cwd,
            query: boundProjectPathSearchQuery(debouncedTarget.query),
            limit,
            ...(debouncedTarget.kind ? { kind: debouncedTarget.kind } : {}),
            ...(debouncedTarget.imageOnly ? { imageOnly: true } : {}),
          },
        }
      : null;
  const result = useEnvironmentQuery(
    canReadFiles && searchTarget !== null ? projectEnvironment.searchEntries(searchTarget) : null,
    resolve,
  );
  const hasTarget = searchTarget !== null;

  return {
    entries: result.data?.entries ?? EMPTY_PROJECT_ENTRIES,
    error:
      !hasTarget || fileAccess.isPending
        ? null
        : canReadFiles
          ? result.error
          : (fileAccess.error ?? resolve(msg("This connection cannot search host files."))),
    isPending:
      !areProjectPathSearchTargetsEqual(normalizedTarget, debouncedTarget) ||
      (hasTarget && (fileAccess.isPending || result.isPending)),
    searchedTarget: debouncedTarget,
    searchedQuery: debouncedTarget.query ?? "",
    truncated: result.data?.truncated ?? false,
    refresh: result.refresh,
  };
}

export function useComposerPathSearch(
  target: ComposerPathSearchTarget,
  resolve: MessageResolver = m,
) {
  return useProjectPathSearch(
    target,
    COMPOSER_PATH_SEARCH_LIMIT,
    { allowEmptyQuery: true },
    resolve,
  );
}

interface ProjectContentSearchTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly useRegex: boolean;
}

export function useProjectContentSearch(
  target: ProjectContentSearchTarget,
  resolve: MessageResolver = m,
) {
  const hasTarget = target.environmentId !== null && target.cwd !== null;
  const fileAccess = useFilesystemReadAccess(target.environmentId, resolve);
  const canReadFiles = hasTarget && fileAccess.canReadFiles;
  const isCheckingAccess = hasTarget && fileAccess.isPending;
  // Preserve query whitespace; trim only to detect blank input.
  const query = target.query;
  const hasQuery = query.trim().length > 0;
  const queryTooLong = query.length > PROJECT_SEARCH_CONTENTS_QUERY_MAX_LENGTH;
  const debouncedQuery = useDebouncedValue(query, PROJECT_CONTENT_SEARCH_DEBOUNCE_MS);
  const result = useEnvironmentQuery(
    canReadFiles &&
      target.environmentId !== null &&
      target.cwd !== null &&
      hasQuery &&
      !queryTooLong &&
      debouncedQuery.trim().length > 0 &&
      debouncedQuery.length <= PROJECT_SEARCH_CONTENTS_QUERY_MAX_LENGTH
      ? projectContentSearch({
          environmentId: target.environmentId,
          input: {
            cwd: target.cwd,
            query: debouncedQuery,
            limit: PROJECT_CONTENT_SEARCH_LIMIT,
            caseSensitive: target.caseSensitive,
            wholeWord: target.wholeWord,
            useRegex: target.useRegex,
          },
        })
      : null,
    resolve,
  );
  // Only once the timeout has come back: a refresh restarts a search still in flight.
  const settledScanTimeout =
    !result.isPending &&
    isProjectSearchContentsError(result.failure) &&
    result.failure.failure === "search_index_scan_timed_out"
      ? result.failure
      : null;
  const { refresh } = result;
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- retry timer: nothing tells the client when the server's first scan ends
  useEffect(() => {
    if (settledScanTimeout === null) return;
    const timer = window.setTimeout(refresh, PROJECT_CONTENT_SEARCH_SCAN_RETRY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [refresh, settledScanTimeout]);

  return {
    canReadFiles,
    isCheckingAccess,
    matches: result.data?.matches ?? EMPTY_CONTENT_MATCHES,
    error:
      !hasTarget || isCheckingAccess
        ? null
        : !canReadFiles
          ? (fileAccess.error ?? resolve(msg("This connection cannot search host files.")))
          : queryTooLong
            ? resolve(
                msg("Search is limited to {count} characters.", {
                  count: PROJECT_SEARCH_CONTENTS_QUERY_MAX_LENGTH,
                }),
              )
            : result.error,
    isPending:
      isCheckingAccess ||
      (canReadFiles && hasQuery && !queryTooLong && (query !== debouncedQuery || result.isPending)),
    hasQuery,
    truncated: result.data?.truncated ?? false,
    invalidRegex: target.useRegex && result.data?.regexFallbackError !== undefined,
  };
}

export function useCheckpointDiff(
  target: CheckpointDiffTarget,
  options?: { readonly enabled?: boolean },
) {
  const targets = buildCheckpointDiffTargets(target, options);
  const fullThread = useEnvironmentQuery(
    targets.fullThread === null
      ? null
      : orchestrationEnvironment.fullThreadDiff(targets.fullThread),
  );
  const turn = useEnvironmentQuery(
    targets.turn === null ? null : orchestrationEnvironment.turnDiff(targets.turn),
  );
  return targets.fullThread === null ? turn : fullThread;
}

/** Reads one item's detail from somewhere other than the environment, as the guest page does. */
export type TurnItemDetailSource = (input: {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly revision: string;
}) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2GetTurnItemResult, unknown>>;

export function useTurnItemDetail(
  target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
    readonly revision: string;
  } | null,
  source?: TurnItemDetailSource,
) {
  const input =
    target === null
      ? null
      : { threadId: target.threadId, itemId: target.itemId, revision: target.revision };
  return useEnvironmentQuery<OrchestrationV2GetTurnItemResult, unknown>(
    target === null || input === null
      ? null
      : source
        ? source(input)
        : orchestrationEnvironment.turnItem({ environmentId: target.environmentId, input }),
  );
}
