import { RegistryContext } from "@effect/atom-react";
import { createAtomCommandInvoker } from "@zerocode/client-runtime/state/atom-invokers";
import type {
  AtomCommand,
  AtomCommandOptions,
  AtomCommandResult,
} from "@zerocode/client-runtime/state/runtime";
import { useContext } from "react";

export function useAtomCommand<A, E, W>(
  command: AtomCommand<W, A, E>,
  options?: string | Omit<AtomCommandOptions, "signal">,
): (value: W, call?: Pick<AtomCommandOptions, "signal">) => Promise<AtomCommandResult<A, E>> {
  return createAtomCommandInvoker(useContext(RegistryContext), command, options);
}
