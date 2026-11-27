import { EnvironmentId, ThreadId, type VcsListRefsResult } from "@zerocode/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  INITIAL_BRANCH_CURSORS,
  appendPaginatedBranchCursor,
  boundProjectPathSearchQuery,
  buildCheckpointDiffTargets,
  canSearchThreads,
  mergePaginatedVcsRefResults,
  normalizeComposerPathSearchQuery,
  normalizeThreadSearchQuery,
  settledThreadSearchReady,
  vcsRefPageInput,
} from "./queryHelpers.ts";

const FIRST_PAGE: VcsListRefsResult = {
  refs: [
    {
      name: "main",
      current: true,
      isDefault: true,
      isRemote: false,
      worktreePath: null,
    },
  ],
  isRepo: true,
  hasPrimaryRemote: true,
  nextCursor: 100,
  totalCount: 150,
};

const LAST_PAGE: VcsListRefsResult = {
  ...FIRST_PAGE,
  refs: [
    {
      name: "feature/a",
      current: false,
      isDefault: false,
      isRemote: false,
      worktreePath: null,
    },
  ],
  nextCursor: null,
};

describe("paginated VCS ref helpers", () => {
  it("does not report fetching next page on a first-page background refresh", () => {
    const merged = mergePaginatedVcsRefResults([
      AsyncResult.success(FIRST_PAGE, { waiting: true }),
    ]);
    expect(merged.isPending).toBe(true);
    expect(merged.isFetchingNextPage).toBe(false);
    expect(merged.refs.map((ref) => ref.name)).toEqual(["main"]);
  });

  it("reports fetching next page only while an appended cursor has no value and merges deduplicated refs", () => {
    expect(
      mergePaginatedVcsRefResults([
        AsyncResult.success(FIRST_PAGE),
        AsyncResult.initial<VcsListRefsResult>(true),
      ]).isFetchingNextPage,
    ).toBe(true);

    const complete = mergePaginatedVcsRefResults([
      AsyncResult.success(FIRST_PAGE),
      AsyncResult.success(LAST_PAGE),
    ]);
    expect(complete.isFetchingNextPage).toBe(false);
    expect(complete.data).toMatchObject({
      isRepo: true,
      hasPrimaryRemote: true,
      nextCursor: null,
      totalCount: 150,
    });
    expect(complete.refs.map((ref) => ref.name)).toEqual(["main", "feature/a"]);

    const failed = mergePaginatedVcsRefResults([
      AsyncResult.failure<VcsListRefsResult, Error>(Cause.fail(new Error("boom"))),
    ]);
    expect(failed.failed?._tag).toBe("Failure");
  });

  it("appends cursors without duplicates and resets on target change", () => {
    const first = appendPaginatedBranchCursor(
      { targetKey: "k1", cursors: INITIAL_BRANCH_CURSORS },
      "k1",
      100,
    );
    expect(first).toEqual({ targetKey: "k1", cursors: [undefined, 100] });
    expect(appendPaginatedBranchCursor(first, "k1", 100)).toEqual(first);
    expect(appendPaginatedBranchCursor(first, "k2", 100)).toEqual({
      targetKey: "k2",
      cursors: [undefined, 100],
    });
    expect(vcsRefPageInput("/repo", "", undefined)).toEqual({ cwd: "/repo", limit: 100 });
    expect(vcsRefPageInput("/repo", "feat", 100)).toEqual({
      cwd: "/repo",
      query: "feat",
      cursor: 100,
      limit: 100,
    });
  });
});

describe("path, checkpoint, and thread search query helpers", () => {
  it("normalizes and bounds path search queries without splitting trailing surrogates", () => {
    expect(normalizeComposerPathSearchQuery(null)).toBeNull();
    expect(normalizeComposerPathSearchQuery("  src/index.ts  ")).toBe("src/index.ts");
    expect(boundProjectPathSearchQuery(`${"a".repeat(255)}😀/x`)).toBe("a".repeat(255));
    expect(boundProjectPathSearchQuery(`${"a".repeat(254)}😀/x`)).toBe(`${"a".repeat(254)}😀`);
  });

  it("builds full-thread vs turn checkpoint diff targets", () => {
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-1");
    expect(
      buildCheckpointDiffTargets({
        environmentId,
        threadId,
        fromTurnCount: 0,
        toTurnCount: 2,
        ignoreWhitespace: true,
      }),
    ).toEqual({
      fullThread: { environmentId, input: { threadId, toTurnCount: 2, ignoreWhitespace: true } },
      turn: null,
    });
    expect(
      buildCheckpointDiffTargets({
        environmentId,
        threadId,
        fromTurnCount: 1,
        toTurnCount: 2,
        ignoreWhitespace: false,
      }),
    ).toEqual({
      fullThread: null,
      turn: {
        environmentId,
        input: { threadId, fromTurnCount: 1, toTurnCount: 2, ignoreWhitespace: false },
      },
    });
    expect(
      buildCheckpointDiffTargets(
        {
          environmentId,
          threadId,
          fromTurnCount: 0,
          toTurnCount: 2,
          ignoreWhitespace: false,
        },
        { enabled: false },
      ),
    ).toEqual({ fullThread: null, turn: null });
  });

  it("gates thread search queries and computes ready settled results", () => {
    const env = [EnvironmentId.make("env-1")];
    expect(normalizeThreadSearchQuery("  hello world  ")).toBe("hello world");
    expect(
      canSearchThreads({
        environmentIds: env,
        normalizedQuery: "ab",
        scope: {},
        anyOlderSettled: false,
      }),
    ).toBe(false);
    expect(
      canSearchThreads({
        environmentIds: env,
        normalizedQuery: "ab",
        scope: { titlesOnly: true },
        anyOlderSettled: true,
      }),
    ).toBe(true);
    expect(
      canSearchThreads({
        environmentIds: env,
        normalizedQuery: "abc",
        scope: {},
        anyOlderSettled: false,
      }),
    ).toBe(true);
    expect(
      settledThreadSearchReady("abc", {
        matches: [],
        isLoading: true,
        failed: false,
        rows: [],
      }),
    ).toBeNull();
    expect(
      settledThreadSearchReady("abc", {
        matches: [],
        isLoading: false,
        failed: false,
        rows: [],
      }),
    ).toEqual({ query: "abc", matches: [] });
  });
});
