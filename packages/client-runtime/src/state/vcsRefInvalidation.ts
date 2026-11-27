import type { EnvironmentId } from "@zerocode/contracts";
import * as Effect from "effect/Effect";
import * as PartitionedSemaphore from "effect/PartitionedSemaphore";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as Persistence from "../platform/persistence.ts";

export interface VcsRefsInvalidationTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd?: string;
}

export interface CachedVcsRefsInvalidationTarget extends VcsRefsInvalidationTarget {
  readonly cwd: string;
}

export interface VcsRefsCacheState {
  readonly revision: number;
  readonly persistedCacheReadable: boolean;
}

function vcsRefsTargetKey(environmentId: EnvironmentId, cwd: string): string {
  return JSON.stringify([environmentId, cwd]);
}

const stateByEnvironment = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<VcsRefsCacheState>({
    revision: 0,
    persistedCacheReadable: true,
  }).pipe(Atom.keepAlive, Atom.withLabel(`environment-data:vcs:list-refs-state:${environmentId}`)),
);
const stateByCwd = Atom.family((key: string) =>
  Atom.make<VcsRefsCacheState>({
    revision: 0,
    persistedCacheReadable: true,
  }).pipe(Atom.keepAlive, Atom.withLabel(`environment-data:vcs:list-refs-cwd-state:${key}`)),
);
const effectiveStateByCwd = Atom.family((key: string) => {
  const [environmentId] = JSON.parse(key) as [EnvironmentId, string];
  const envAtom = stateByEnvironment(environmentId);
  const cwdAtom = stateByCwd(key);
  return Atom.make((get): VcsRefsCacheState => {
    const env = get(envAtom);
    const scoped = get(cwdAtom);
    return {
      revision: env.revision + scoped.revision,
      persistedCacheReadable: env.persistedCacheReadable && scoped.persistedCacheReadable,
    };
  }).pipe(Atom.withLabel(`environment-data:vcs:list-refs-effective-state:${key}`));
});
const persistenceLock = PartitionedSemaphore.makeUnsafe<string>({ permits: 1 });

export function vcsRefsCacheStateAtom(
  target: VcsRefsInvalidationTarget,
): Atom.Atom<VcsRefsCacheState> {
  return target.cwd === undefined
    ? stateByEnvironment(target.environmentId)
    : effectiveStateByCwd(vcsRefsTargetKey(target.environmentId, target.cwd));
}

export function vcsRefsEnvironmentCacheStateAtom(environmentId: EnvironmentId) {
  return stateByEnvironment(environmentId);
}

export function vcsRefsScopedCacheStateAtom(target: CachedVcsRefsInvalidationTarget) {
  return stateByCwd(vcsRefsTargetKey(target.environmentId, target.cwd));
}

export function invalidateVcsRefs(
  registry: AtomRegistry.AtomRegistry,
  target: VcsRefsInvalidationTarget,
  persistedCacheReadable?: boolean,
): void {
  const atom =
    target.cwd === undefined
      ? stateByEnvironment(target.environmentId)
      : stateByCwd(vcsRefsTargetKey(target.environmentId, target.cwd));
  registry.update(atom, (state) => ({
    revision: state.revision + 1,
    persistedCacheReadable: persistedCacheReadable ?? state.persistedCacheReadable,
  }));
}

export function withVcsRefsPersistenceLock<A, E, R>(
  target: CachedVcsRefsInvalidationTarget,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return persistenceLock.withPermit(vcsRefsTargetKey(target.environmentId, target.cwd))(effect);
}

/**
 * Clearing first prevents the restarted stream from rehydrating the invalidated
 * snapshot. A refresh that wins the lock is cleared afterward; one that loses
 * observes the new revision and cannot repersist its pre-mutation result.
 */
export const invalidateCachedVcsRefs = Effect.fn("VcsRefsState.invalidateCached")(function* (
  registry: AtomRegistry.AtomRegistry,
  target: CachedVcsRefsInvalidationTarget,
) {
  const cache = yield* Persistence.EnvironmentCacheStore;
  yield* withVcsRefsPersistenceLock(
    target,
    Effect.gen(function* () {
      const persistedCacheReadable = yield* cache
        .removeVcsRefs(target.environmentId, target.cwd)
        .pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("Could not remove invalidated cached Git refs.").pipe(
              Effect.annotateLogs({
                environmentId: target.environmentId,
                cwd: target.cwd,
                ...safeErrorLogAttributes(error),
              }),
              Effect.as(false),
            ),
          ),
        );
      invalidateVcsRefs(registry, target, persistedCacheReadable);
    }),
  );
});

// Ref digests from each cwd's last status refresh; the cached branch list is at least that new.
const refsDigestsByEnvironment = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<ReadonlyMap<string, string>>(new Map()).pipe(
    Atom.keepAlive,
    Atom.withLabel(`environment-data:vcs:refs-digests:${environmentId}`),
  ),
);

/** Skips the branch list reload when a status refresh saw the same refs as the last one. */
export const invalidateCachedVcsRefsIfChanged = Effect.fn("VcsRefsState.invalidateCachedIfChanged")(
  function* (
    registry: AtomRegistry.AtomRegistry,
    target: CachedVcsRefsInvalidationTarget,
    refsDigest: string | undefined,
  ) {
    const digestsAtom = refsDigestsByEnvironment(target.environmentId);
    if (refsDigest !== undefined && registry.get(digestsAtom).get(target.cwd) === refsDigest) {
      return;
    }
    registry.update(digestsAtom, (digests) => {
      const next = new Map(digests);
      if (refsDigest === undefined) next.delete(target.cwd);
      else next.set(target.cwd, refsDigest);
      return next;
    });
    yield* invalidateCachedVcsRefs(registry, target);
  },
);
