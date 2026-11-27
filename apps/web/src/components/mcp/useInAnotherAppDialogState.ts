import type { EnvironmentId } from "@zerocode/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

export const otherAppDialogRequestAtom = Atom.make<{
  readonly environmentId: EnvironmentId | null;
} | null>(null).pipe(Atom.keepAlive, Atom.withLabel("mcp:use-in-another-app"));

/** Opens the wizard for `environmentId`, or for the one Sharing & access picks when null. */
export function openUseInAnotherApp(environmentId: EnvironmentId | null): void {
  appAtomRegistry.set(otherAppDialogRequestAtom, { environmentId });
}

export function closeUseInAnotherApp(): void {
  appAtomRegistry.set(otherAppDialogRequestAtom, null);
}
