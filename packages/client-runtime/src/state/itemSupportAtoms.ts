import type {
  EnvironmentId,
  OrchestrationV2ThreadProjection,
  ScopedThreadRef,
  ThreadId,
  TurnItemId,
} from "@zerocode/contracts";
import { Atom } from "effect/reactivity";

import { scopeThreadRef } from "../environment/index.ts";
import {
  EMPTY_V2_ITEM_SUPPORT,
  resolveV2ItemSupport,
  v2ItemSupportEqual,
  type V2ItemSupport,
} from "./itemSupport.ts";

export interface V2ItemSupportTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
}

export function createV2ItemSupportAtomFamily(
  threadAtom: (
    ref: ScopedThreadRef,
  ) => Atom.Atom<{ readonly projection: OrchestrationV2ThreadProjection } | null>,
  labelPrefix: string,
): (target: V2ItemSupportTarget) => Atom.Atom<V2ItemSupport> {
  const family = Atom.family((key: string) => {
    const target = JSON.parse(key) as V2ItemSupportTarget;
    const ref = scopeThreadRef(target.environmentId, target.threadId);
    let previous = EMPTY_V2_ITEM_SUPPORT;
    return Atom.make((get): V2ItemSupport => {
      const scoped = get(threadAtom(ref));
      if (scoped === null) return EMPTY_V2_ITEM_SUPPORT;
      const next = resolveV2ItemSupport(scoped.projection, target.itemId);
      if (v2ItemSupportEqual(previous, next)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`${labelPrefix}:${key}`));
  });

  return (target) => family(JSON.stringify(target));
}
