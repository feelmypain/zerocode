import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadFamily,
  type OrchestrationV2ThreadShell,
} from "@zerocode/contracts";
import * as DateTime from "effect/DateTime";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  mountOlderSettledShelfPages,
  olderSettledShelfPagesStatus,
  olderSettledShelfScopes,
  readUnloadedProjectThreadCount,
  retryOlderSettledShelfPages,
} from "./olderSettledShelf.ts";
import type { OlderSettled, OlderSettledShelfEnvironment } from "./olderSettledThreads.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

describe("olderSettledShelf helpers", () => {
  it("mounts and retries only scopes with requested pages and reports pending/failed status", () => {
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    const scopes = [
      { environmentId: envA, projectIds: [projectA] },
      { environmentId: envB, projectIds: null },
    ];
    const shelfScopes = olderSettledShelfScopes(scopes, new Map([[envA, 2]]));
    expect(shelfScopes.map((entry) => entry.pages)).toEqual([2, 0]);

    const releaseA = vi.fn();
    const mountRows = vi.fn(() => releaseA);
    const rowsAtom = Atom.make<ReadonlyArray<OrchestrationV2ThreadFamily>>([]);
    const unmount = mountOlderSettledShelfPages({
      registry,
      shelfScopes,
      mountRows,
      rowsKey: (scope, pages) => `${scope.environmentId}:${pages}`,
      pageRowsAtom: () => rowsAtom,
    });
    expect(mountRows).toHaveBeenCalledExactlyOnceWith(registry, envA, `${envA}:2`, rowsAtom);
    unmount();
    expect(releaseA).toHaveBeenCalledOnce();

    const retryPages = vi.fn();
    retryOlderSettledShelfPages({ registry, shelfScopes, retryPages });
    expect(retryPages).toHaveBeenCalledExactlyOnceWith(registry, scopes[0], 2);

    const shelf = new Map<EnvironmentId, OlderSettledShelfEnvironment>([
      [envA, { older: null, pages: { reads: [], frontier: null, status: "pending" } }],
      [envB, { older: null, pages: { reads: [], frontier: null, status: "failed" } }],
    ]);
    expect(olderSettledShelfPagesStatus(shelf, shelfScopes)).toEqual({
      loading: true,
      failed: false,
    });
  });

  it("counts unloaded older settled threads scoped to the requested projects", () => {
    const beforeMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-05-01T00:00:00.000Z"));
    const older: OlderSettled = {
      before: "2026-05-01T00:00:00.000Z",
      beforeMs,
      counts: new Map([
        [projectA, 5],
        [projectB, 10],
      ]),
    };
    const makeRow = (id: string, projectId: ProjectId) => ({
      environmentId: envA,
      projectId,
      source: {
        id: ThreadId.make(id),
        projectId,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: ThreadId.make(id),
        },
        settledOverride: "settled",
        settledAt: DateTime.makeUnsafe(beforeMs - 10_000),
      } as unknown as Pick<
        OrchestrationV2ThreadShell,
        "id" | "projectId" | "lineage" | "settledOverride" | "settledAt"
      >,
    });

    expect(
      readUnloadedProjectThreadCount({
        olderSettled: (id) => (id === envA ? older : null),
        members: [{ environmentId: envA, id: projectA }],
        threads: [makeRow("t-1", projectA), makeRow("t-2", projectB)],
      }),
    ).toBe(4);
  });
});
