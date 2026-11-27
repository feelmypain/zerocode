import {
  EnvironmentId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@zerocode/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { EMPTY_V2_ITEM_SUPPORT } from "./itemSupport.ts";
import { createV2ItemSupportAtomFamily } from "./itemSupportAtoms.ts";

describe("createV2ItemSupportAtomFamily", () => {
  it("returns EMPTY_V2_ITEM_SUPPORT when the thread is absent and keeps object identity when support is unchanged", () => {
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    const envId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-1");
    const itemId = TurnItemId.make("item-1");

    const sourceAtom = Atom.make<{ readonly projection: OrchestrationV2ThreadProjection } | null>(
      null,
    );
    const supportAtom = createV2ItemSupportAtomFamily(
      () => sourceAtom,
      "test-support",
    )({
      environmentId: envId,
      threadId,
      itemId,
    });

    expect(registry.get(supportAtom)).toBe(EMPTY_V2_ITEM_SUPPORT);

    const item = {
      id: itemId,
      type: "assistant_message",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
    } as unknown as OrchestrationV2ThreadProjection["turnItems"][number];
    const baseProjection = {
      turnItems: [item],
      visibleTurnItems: [],
      runs: [],
      attempts: [],
      nodes: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      checkpoints: [],
      subagents: [],
      contextHandoffs: [],
      contextTransfers: [],
    } as unknown as OrchestrationV2ThreadProjection;

    registry.set(sourceAtom, { projection: baseProjection });
    const first = registry.get(supportAtom);
    expect(first.item).toBe(item);

    registry.set(sourceAtom, { projection: { ...baseProjection } });
    expect(registry.get(supportAtom)).toBe(first);
  });
});
