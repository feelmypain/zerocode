import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createAtomCommandInvoker, createAtomQueryInvoker } from "./atomInvokers.ts";
import type { AtomCommand } from "./runtime.ts";

describe("atomInvokers", () => {
  it("invokes commands and queries with normalized options", async () => {
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };

    const doubleCommand: AtomCommand<number, number, never> = {
      label: "test:double",
      run: (_registry, value) => Effect.succeed(value * 2),
    };
    const runDouble = createAtomCommandInvoker(registry, doubleCommand, {
      reportFailure: false,
    });
    const commandResult = await runDouble(21);
    expect(commandResult._tag).toBe("Success");
    if (commandResult._tag === "Success") expect(commandResult.value).toBe(42);

    const queryFamily = (key: string) =>
      Atom.make(AsyncResult.success(`value:${key}`)).pipe(Atom.withLabel(`query:${key}`));
    const runQuery = createAtomQueryInvoker(registry, queryFamily, "custom-label");
    const queryResult = await runQuery("alpha");
    expect(queryResult._tag).toBe("Success");
    if (queryResult._tag === "Success") expect(queryResult.value).toBe("value:alpha");
  });
});
