import {
  THREAD_SEARCH_QUERY_MAX_LENGTH,
  type EnvironmentId,
  type OrchestrationV2SearchThreadsInput,
  type OrchestrationV2SearchThreadsResult,
  type ThreadId,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsRef,
} from "@zerocode/contracts";
import { messageSearchTokens } from "@zerocode/shared/paletteSearch";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { OlderSettled } from "./olderSettledThreads.ts";
import {
  createThreadSearchResultsAtomFamily,
  type EnvironmentThreadSearchMatch,
  type SettledThreadSearch,
  type ThreadSearchResultsState,
  type ThreadSearchScope,
} from "./threadSearch.ts";

export const VCS_REF_LIST_LIMIT = 100;
export const INITIAL_BRANCH_CURSORS: ReadonlyArray<number | undefined> = Object.freeze([undefined]);
const EMPTY_VCS_REFS: ReadonlyArray<VcsRef> = Object.freeze([]);
const EMPTY_THREAD_SEARCH_MATCHES: ReadonlyArray<EnvironmentThreadSearchMatch> = Object.freeze([]);

export function vcsRefPageInput(
  cwd: string,
  query: string,
  cursor: number | undefined,
  limit = VCS_REF_LIST_LIMIT,
): VcsListRefsInput {
  return {
    cwd,
    ...(query.length > 0 ? { query } : {}),
    ...(cursor === undefined ? {} : { cursor }),
    limit,
  };
}

export interface PaginatedVcsRefState<E> {
  readonly data: VcsListRefsResult | null;
  readonly refs: ReadonlyArray<VcsRef>;
  readonly isPending: boolean;
  readonly isFetchingNextPage: boolean;
  readonly failed: AsyncResult.Failure<VcsListRefsResult, E> | undefined;
}

export function mergePaginatedVcsRefResults<E>(
  results: ReadonlyArray<AsyncResult.AsyncResult<VcsListRefsResult, E>>,
): PaginatedVcsRefState<E> {
  const values: VcsListRefsResult[] = [];
  let isPending = false;
  let failed: AsyncResult.Failure<VcsListRefsResult, E> | undefined;
  for (const result of results) {
    if (result.waiting) isPending = true;
    if (failed === undefined && result._tag === "Failure") failed = result;
    const value = AsyncResult.getOrElse(result, () => null);
    if (value !== null) values.push(value);
  }
  const first = values[0] ?? null;
  const last = values.at(-1) ?? null;
  let data: VcsListRefsResult | null = null;
  if (first !== null && last !== null) {
    const refs = new Map<string, VcsRef>();
    let totalCount = first.totalCount;
    for (const value of values) {
      if (value.totalCount > totalCount) totalCount = value.totalCount;
      for (const ref of value.refs) {
        refs.set(ref.name, ref);
      }
    }
    data = {
      refs: [...refs.values()],
      isRepo: first.isRepo,
      hasPrimaryRemote: first.hasPrimaryRemote,
      nextCursor: last.nextCursor,
      totalCount,
    };
  }
  const lastResult = results.at(-1);
  const isFetchingNextPage =
    results.length > 1 &&
    lastResult?.waiting === true &&
    Option.isNone(AsyncResult.value(lastResult));
  return {
    data,
    refs: data?.refs ?? EMPTY_VCS_REFS,
    isPending,
    isFetchingNextPage,
    failed,
  };
}

export interface BranchPaginationState {
  readonly targetKey: string | null;
  readonly cursors: ReadonlyArray<number | undefined>;
}

export function appendPaginatedBranchCursor(
  current: BranchPaginationState,
  targetKey: string,
  nextCursor: number,
): BranchPaginationState {
  const currentCursors = current.targetKey === targetKey ? current.cursors : INITIAL_BRANCH_CURSORS;
  return currentCursors.includes(nextCursor)
    ? { targetKey, cursors: currentCursors }
    : { targetKey, cursors: [...currentCursors, nextCursor] };
}

export function normalizeComposerPathSearchQuery(query: string | null | undefined): string | null {
  return query == null ? null : query.trim();
}

/** Bounds a path search query to 256 UTF-16 code units without splitting a trailing surrogate pair. */
export function boundProjectPathSearchQuery(query: string): string {
  return query.slice(0, 256).replace(/[\uD800-\uDBFF]$/, "");
}

export interface CheckpointDiffTargetInput {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly fromTurnCount: number | null;
  readonly toTurnCount: number | null;
  readonly ignoreWhitespace: boolean;
}

export function buildCheckpointDiffTargets(
  target: CheckpointDiffTargetInput,
  options?: { readonly enabled?: boolean },
) {
  if (
    options?.enabled === false ||
    target.environmentId === null ||
    target.threadId === null ||
    target.fromTurnCount === null ||
    target.toTurnCount === null
  ) {
    return { fullThread: null, turn: null } as const;
  }

  if (target.fromTurnCount === 0) {
    return {
      fullThread: {
        environmentId: target.environmentId,
        input: {
          threadId: target.threadId,
          toTurnCount: target.toTurnCount,
          ignoreWhitespace: target.ignoreWhitespace,
        },
      },
      turn: null,
    } as const;
  }

  return {
    fullThread: null,
    turn: {
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        fromTurnCount: target.fromTurnCount,
        toTurnCount: target.toTurnCount,
        ignoreWhitespace: target.ignoreWhitespace,
      },
    },
  } as const;
}

export function normalizeThreadSearchQuery(query: string): string {
  return query.trim().slice(0, THREAD_SEARCH_QUERY_MAX_LENGTH).trim();
}

export function canSearchThreads(input: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly normalizedQuery: string;
  readonly scope: ThreadSearchScope;
  readonly anyOlderSettled: boolean;
}): boolean {
  return (
    input.environmentIds.length > 0 &&
    ((input.scope.titlesOnly !== true &&
      messageSearchTokens(input.normalizedQuery).long.length > 0) ||
      (input.anyOlderSettled && input.normalizedQuery.length >= 2))
  );
}

export function settledThreadSearchReady(
  settledQuery: string | null,
  result: ThreadSearchResultsState,
): SettledThreadSearch | null {
  return settledQuery !== null &&
    (!result.isLoading || result.matches.length > 0 || result.rows.length > 0)
    ? { query: settledQuery, matches: result.matches }
    : null;
}

export function createOlderSettledThreadSearchAtoms<E>(options: {
  readonly getOlderSettledAtom: (environmentId: EnvironmentId) => Atom.Atom<OlderSettled | null>;
  readonly getLiveSearchAtom: (
    environmentId: EnvironmentId,
    input: OrchestrationV2SearchThreadsInput,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2SearchThreadsResult, E>>;
  readonly getOlderSearchAtom: (
    environmentId: EnvironmentId,
    input: OrchestrationV2SearchThreadsInput,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2SearchThreadsResult, E>>;
  readonly labelPrefix: string;
}) {
  const emptyResultsAtom = Atom.make<ThreadSearchResultsState>({
    matches: EMPTY_THREAD_SEARCH_MATCHES,
    isLoading: false,
    failed: false,
    rows: [],
  }).pipe(Atom.withLabel(`${options.labelPrefix}:thread-search:empty`));

  const olderSettledBeforeAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(options.getOlderSettledAtom(environmentId))?.before ?? null).pipe(
      Atom.withLabel(`${options.labelPrefix}:older-settled-before:${environmentId}`),
    ),
  );

  const anyOlderSettledAtom = Atom.family((environmentIdsKey: string) =>
    Atom.make((get) =>
      (JSON.parse(environmentIdsKey) as ReadonlyArray<EnvironmentId>).some(
        (environmentId) => get(olderSettledBeforeAtom(environmentId)) !== null,
      ),
    ).pipe(Atom.withLabel(`${options.labelPrefix}:any-older-settled:${environmentIdsKey}`)),
  );

  const threadSearch = createThreadSearchResultsAtomFamily({
    getSearchAtom: (environmentId, input) =>
      input.olderSettledBefore === undefined
        ? options.getLiveSearchAtom(environmentId, input)
        : options.getOlderSearchAtom(environmentId, input),
    olderSettledBefore: olderSettledBeforeAtom,
    labelPrefix: `${options.labelPrefix}:thread-search`,
  });

  return {
    emptyMatches: EMPTY_THREAD_SEARCH_MATCHES,
    emptyResultsAtom,
    anyOlderSettledAtom,
    results: threadSearch.results,
    rows: threadSearch.rows,
  };
}
