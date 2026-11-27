import type {
  EnvironmentId,
  OrchestrationV2ThreadFamily,
  OrchestrationV2ThreadShell,
  ProjectId,
} from "@zerocode/contracts";
import type { Atom, AtomRegistry } from "effect/reactivity";

import {
  unloadedOlderSettledCount,
  type OlderSettled,
  type OlderSettledScope,
  type OlderSettledShelfEnvironment,
} from "./olderSettledThreads.ts";

export const OLDER_SETTLED_NO_PAGES: ReadonlyMap<EnvironmentId, number> = new Map();

export interface OlderSettledShelfScopePage {
  readonly scope: OlderSettledScope;
  readonly pages: number;
}

export function olderSettledShelfScopes(
  scopes: ReadonlyArray<OlderSettledScope>,
  pages: ReadonlyMap<EnvironmentId, number>,
): ReadonlyArray<OlderSettledShelfScopePage> {
  return scopes.map((scope) => ({
    scope,
    pages: pages.get(scope.environmentId) ?? 0,
  }));
}

export function mountOlderSettledShelfPages(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly shelfScopes: ReadonlyArray<OlderSettledShelfScopePage>;
  readonly mountRows: (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    rowsKey: string,
    rowsAtom: Atom.Atom<ReadonlyArray<OrchestrationV2ThreadFamily>>,
  ) => () => void;
  readonly rowsKey: (scope: OlderSettledScope, pages: number) => string;
  readonly pageRowsAtom: (
    scope: OlderSettledScope,
    pages: number,
  ) => Atom.Atom<ReadonlyArray<OrchestrationV2ThreadFamily>>;
}): () => void {
  const releases = input.shelfScopes.flatMap(({ scope, pages }) =>
    pages === 0
      ? []
      : [
          input.mountRows(
            input.registry,
            scope.environmentId,
            input.rowsKey(scope, pages),
            input.pageRowsAtom(scope, pages),
          ),
        ],
  );
  return () => {
    for (const release of releases) release();
  };
}

export function retryOlderSettledShelfPages(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly shelfScopes: ReadonlyArray<OlderSettledShelfScopePage>;
  readonly retryPages: (
    registry: AtomRegistry.AtomRegistry,
    scope: OlderSettledScope,
    pages: number,
  ) => void;
}): void {
  for (const { scope, pages } of input.shelfScopes) {
    if (pages > 0) input.retryPages(input.registry, scope, pages);
  }
}

export function olderSettledShelfPagesStatus(
  shelf: ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment>,
  shelfScopes: ReadonlyArray<OlderSettledShelfScopePage>,
): {
  readonly loading: boolean;
  readonly failed: boolean;
} {
  let loading = false;
  let failed = false;
  for (const { scope, pages } of shelfScopes) {
    if (pages <= 0) continue;
    const status = shelf.get(scope.environmentId)?.pages.status;
    if (status === "pending") loading = true;
    else if (status === "failed") failed = true;
  }
  return { loading, failed };
}

type ProjectThreadRow = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly source: Pick<
    OrchestrationV2ThreadShell,
    "id" | "projectId" | "lineage" | "settledOverride" | "settledAt"
  >;
};

/** Unloaded older settled thread count across a set of environment/project pairs. */
export function readUnloadedProjectThreadCount(input: {
  readonly olderSettled: (environmentId: EnvironmentId) => OlderSettled | null;
  readonly members: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
  }>;
  readonly threads: ReadonlyArray<ProjectThreadRow>;
}): number {
  const environmentIds = [...new Set(input.members.map((member) => member.environmentId))];
  const scopes: OlderSettledScope[] = environmentIds.map((environmentId) => ({
    environmentId,
    projectIds: input.members.flatMap((member) =>
      member.environmentId === environmentId ? [member.id] : [],
    ),
  }));
  const threads = input.threads.filter((thread) =>
    input.members.some(
      (member) => member.environmentId === thread.environmentId && member.id === thread.projectId,
    ),
  );
  return unloadedOlderSettledCount({
    olderSettled: input.olderSettled,
    scopes,
    threads,
  });
}
