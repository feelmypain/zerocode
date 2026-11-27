import type { EnvironmentId } from "@zerocode/contracts/ids";
import type { AtomRegistry } from "effect/reactivity";

const environmentDisposedListeners = new Set<(environmentId: EnvironmentId) => void>();

export function onEnvironmentDisposed(
  listener: (environmentId: EnvironmentId) => void,
): () => void {
  environmentDisposedListeners.add(listener);
  return () => {
    environmentDisposedListeners.delete(listener);
  };
}

export function notifyEnvironmentDisposed(environmentId: EnvironmentId): void {
  for (const listener of environmentDisposedListeners) {
    try {
      listener(environmentId);
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}

const trackedRegistrySet = new WeakSet<AtomRegistry.AtomRegistry>();
const trackedRegistryRefs = new Set<WeakRef<AtomRegistry.AtomRegistry>>();

export function trackAtomRegistry(registry: AtomRegistry.AtomRegistry): void {
  if (trackedRegistrySet.has(registry)) return;
  trackedRegistrySet.add(registry);
  trackedRegistryRefs.add(new WeakRef(registry));
}

export function forEachTrackedAtomRegistry(
  visit: (registry: AtomRegistry.AtomRegistry) => void,
): void {
  for (const ref of trackedRegistryRefs) {
    const registry = ref.deref();
    if (registry === undefined) {
      trackedRegistryRefs.delete(ref);
      continue;
    }
    visit(registry);
  }
}
