import { Atom, AtomRegistry } from "effect/reactivity";
import { useSyncExternalStore } from "react";

const unsubscribeNothing = () => {};

/**
 * Feed-scoped reactive store for per-row volatile interaction state.
 * Keeps copy feedback, row disclosures, and setup-sheet toggles out of LegendList `extraData`
 * so toggling one row only re-renders the affected row.
 */
export interface ThreadFeedInteractionStore {
  readonly isRowCopied: (rowId: string) => boolean;
  readonly setCopiedRowId: (rowId: string | null) => void;
  readonly isRowExpanded: (rowId: string) => boolean;
  readonly toggleWorkRow: (rowId: string) => boolean;
  readonly getSetupDetailsThreadId: () => string | null;
  readonly setSetupDetailsThreadId: (threadId: string | null) => void;
  readonly subscribeRowCopied: (rowId: string, listener: () => void) => () => void;
  readonly subscribeRowExpanded: (rowId: string, listener: () => void) => () => void;
  readonly subscribeSetupDetailsThreadId: (listener: () => void) => () => void;
  readonly dispose: () => void;
}

export function createThreadFeedInteractionStore(): ThreadFeedInteractionStore {
  const registry = AtomRegistry.make();
  const copiedRowAtoms = new Map<string, Atom.Writable<boolean>>();
  const expandedRowAtoms = new Map<string, Atom.Writable<boolean>>();
  const setupDetailsThreadIdAtom = Atom.make<string | null>(null);
  let currentCopiedRowId: string | null = null;

  const copiedAtom = (rowId: string): Atom.Writable<boolean> => {
    let atom = copiedRowAtoms.get(rowId);
    if (!atom) {
      atom = Atom.make(currentCopiedRowId === rowId);
      copiedRowAtoms.set(rowId, atom);
    }
    return atom;
  };

  const expandedAtom = (rowId: string): Atom.Writable<boolean> => {
    let atom = expandedRowAtoms.get(rowId);
    if (!atom) {
      atom = Atom.make(false);
      expandedRowAtoms.set(rowId, atom);
    }
    return atom;
  };

  return {
    isRowCopied: (rowId) => currentCopiedRowId === rowId,
    setCopiedRowId: (rowId) => {
      if (currentCopiedRowId === rowId) return;
      const previous = currentCopiedRowId;
      currentCopiedRowId = rowId;
      if (previous !== null) {
        const previousAtom = copiedRowAtoms.get(previous);
        if (previousAtom) registry.set(previousAtom, false);
      }
      if (rowId !== null) {
        const nextAtom = copiedRowAtoms.get(rowId);
        if (nextAtom) registry.set(nextAtom, true);
      }
    },
    isRowExpanded: (rowId) => {
      const atom = expandedRowAtoms.get(rowId);
      return atom ? registry.get(atom) : false;
    },
    toggleWorkRow: (rowId) => {
      const atom = expandedAtom(rowId);
      const next = !registry.get(atom);
      registry.set(atom, next);
      return next;
    },
    getSetupDetailsThreadId: () => registry.get(setupDetailsThreadIdAtom),
    setSetupDetailsThreadId: (threadId) => {
      if (registry.get(setupDetailsThreadIdAtom) !== threadId) {
        registry.set(setupDetailsThreadIdAtom, threadId);
      }
    },
    subscribeRowCopied: (rowId, listener) =>
      registry.subscribe(copiedAtom(rowId), () => listener()),
    subscribeRowExpanded: (rowId, listener) =>
      registry.subscribe(expandedAtom(rowId), () => listener()),
    subscribeSetupDetailsThreadId: (listener) =>
      registry.subscribe(setupDetailsThreadIdAtom, () => listener()),
    dispose: () => {
      registry.dispose();
      copiedRowAtoms.clear();
      expandedRowAtoms.clear();
    },
  };
}

export function useFeedRowCopied(store: ThreadFeedInteractionStore, rowId: string): boolean {
  return useSyncExternalStore(
    (notify) => store.subscribeRowCopied(rowId, notify),
    () => store.isRowCopied(rowId),
    () => store.isRowCopied(rowId),
  );
}

export function useFeedRowExpanded(
  store: ThreadFeedInteractionStore,
  rowId: string | null,
): boolean {
  return useSyncExternalStore(
    (notify) => (rowId === null ? unsubscribeNothing : store.subscribeRowExpanded(rowId, notify)),
    () => (rowId === null ? false : store.isRowExpanded(rowId)),
    () => (rowId === null ? false : store.isRowExpanded(rowId)),
  );
}

export function useFeedSetupDetailsOpen(
  store: ThreadFeedInteractionStore,
  threadId: string,
  hasWorktreeSetup: boolean,
): boolean {
  return useSyncExternalStore(
    (notify) =>
      hasWorktreeSetup ? store.subscribeSetupDetailsThreadId(notify) : unsubscribeNothing,
    () => hasWorktreeSetup && store.getSetupDetailsThreadId() === threadId,
    () => hasWorktreeSetup && store.getSetupDetailsThreadId() === threadId,
  );
}
