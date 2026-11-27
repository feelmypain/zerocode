import type { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  executeAtomQuery,
  runAtomCommand,
  type AtomCommand,
  type AtomCommandOptions,
  type AtomCommandResult,
  type AtomQueryOptions,
} from "./runtime.ts";

export function createAtomCommandInvoker<A, E, W>(
  registry: AtomRegistry.AtomRegistry,
  command: AtomCommand<W, A, E>,
  options?: string | Omit<AtomCommandOptions, "signal">,
): (value: W, call?: Pick<AtomCommandOptions, "signal">) => Promise<AtomCommandResult<A, E>> {
  const label = typeof options === "string" ? options : (options?.label ?? command.label);
  const reportFailure = typeof options === "string" ? true : (options?.reportFailure ?? true);
  const reportDefect = typeof options === "string" ? true : (options?.reportDefect ?? true);

  return (value, call) =>
    runAtomCommand(registry, command, value, { label, reportFailure, reportDefect, ...call });
}

export function createAtomQueryInvoker<T, A, E>(
  registry: AtomRegistry.AtomRegistry,
  family: (target: T) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options?: string | Omit<AtomQueryOptions, "signal">,
): (target: T, call?: Pick<AtomQueryOptions, "signal">) => Promise<AtomCommandResult<A, E>> {
  const explicitLabel = typeof options === "string" ? options : options?.label;
  const reportFailure = typeof options === "string" ? true : (options?.reportFailure ?? true);
  const reportDefect = typeof options === "string" ? true : (options?.reportDefect ?? true);
  const refresh = typeof options === "string" ? false : (options?.refresh ?? false);

  return (target, call) => {
    const atom = family(target);
    return executeAtomQuery(registry, atom, {
      label: explicitLabel ?? atom.label?.[0] ?? "atom query",
      reportFailure,
      reportDefect,
      refresh,
      ...call,
    });
  };
}
