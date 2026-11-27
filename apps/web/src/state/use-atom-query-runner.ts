import { RegistryContext } from "@effect/atom-react";
import { createAtomQueryInvoker } from "@zerocode/client-runtime/state/atom-invokers";
import type { AtomCommandResult, AtomQueryOptions } from "@zerocode/client-runtime/state/runtime";
import type { AsyncResult, Atom } from "effect/reactivity";
import { useContext } from "react";

export function useAtomQueryRunner<T, A, E>(
  family: (target: T) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options?: string | Omit<AtomQueryOptions, "signal">,
): (target: T, call?: Pick<AtomQueryOptions, "signal">) => Promise<AtomCommandResult<A, E>> {
  return createAtomQueryInvoker(useContext(RegistryContext), family, options);
}
