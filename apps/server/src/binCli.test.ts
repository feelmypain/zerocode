import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NetService from "@zerocode/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import { makeCli, runCliWith } from "./binCli.ts";

const hooks = vi.hoisted(() => ({
  loaded: [] as Array<string>,
}));

vi.mock("./cli/doctor.ts", async (importOriginal) => {
  hooks.loaded.push("doctor");
  return await importOriginal<typeof import("./cli/doctor.ts")>();
});

vi.mock("./cli/trace.ts", async (importOriginal) => {
  hooks.loaded.push("trace");
  return await importOriginal<typeof import("./cli/trace.ts")>();
});

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);

const runWithConsole = (
  args: ReadonlyArray<string>,
  options: { readonly version?: string; readonly cloudEnabled?: boolean } = {},
) =>
  Effect.gen(function* () {
    yield* runCliWith(args, { version: "9.9.9", ...options });
    return (yield* TestConsole.logLines).join("\n");
  }).pipe(Effect.provide(Layer.fresh(TestConsole.layer)));

it.layer(layerCliRuntime)("binCli lazy dispatch", (it) => {
  it.effect("loads only the invoked subcommand and skips unrelated modules", () =>
    Effect.gen(function* () {
      assert.deepEqual(hooks.loaded, []);

      const versionOutput = yield* runWithConsole(["--version"]);
      assert.include(versionOutput, "9.9.9");
      assert.deepEqual(hooks.loaded, []);

      const themeHelp = yield* runWithConsole(["theme", "--help"]);
      assert.include(themeHelp, "zerocode theme");
      assert.deepEqual(hooks.loaded, []);

      const sshHelperHelp = yield* runWithConsole([
        "--log-level",
        "debug",
        "__ssh-helper",
        "--help",
      ]);
      assert.include(sshHelperHelp, "zerocode __ssh-helper");
      assert.deepEqual(hooks.loaded, []);

      const unavailableConnect = yield* runCliWith(["connect", "status"], {
        version: "9.9.9",
        cloudEnabled: false,
      }).pipe(Effect.provide(Layer.fresh(TestConsole.layer)), Effect.flip);
      assert.isTrue(
        typeof unavailableConnect === "object" &&
          unavailableConnect !== null &&
          "_tag" in unavailableConnect &&
          unavailableConnect._tag === "ShowHelp",
      );
      assert.deepEqual(hooks.loaded, []);

      const unknownError = yield* runCliWith(["not-a-real-subcommand"], {
        version: "9.9.9",
      }).pipe(Effect.provide(Layer.fresh(TestConsole.layer)), Effect.flip);
      assert.include(String(unknownError), 'Unknown command "not-a-real-subcommand"');
      assert.deepEqual(hooks.loaded, []);

      const doctorHelp = yield* runWithConsole(["doctor", "--help"]);
      assert.include(doctorHelp, "zerocode doctor");
      assert.deepEqual(hooks.loaded, ["doctor"]);

      const rootHelp = yield* runWithConsole(["--help"]);
      assert.include(rootHelp, "serve");
      assert.include(rootHelp, "pair");
      assert.include(rootHelp, "doctor");
      assert.include(rootHelp, "trace");
      assert.notInclude(rootHelp, "__ssh-helper");
      assert.deepEqual(hooks.loaded, ["doctor", "trace"]);
    }),
  );

  it.effect("preserves root help for `help` and unknown root flags", () =>
    Effect.gen(function* () {
      const helpFailure = yield* Effect.gen(function* () {
        const error = yield* runCliWith(["help"], { version: "9.9.9" }).pipe(Effect.flip);
        return { error, stdout: (yield* TestConsole.logLines).join("\n") };
      }).pipe(Effect.provide(Layer.fresh(TestConsole.layer)));
      assert.isTrue(
        typeof helpFailure.error === "object" &&
          helpFailure.error !== null &&
          "_tag" in helpFailure.error &&
          helpFailure.error._tag === "ShowHelp",
      );
      assert.include(helpFailure.stdout, "serve");
      assert.include(helpFailure.stdout, "doctor");

      const unknownFlag = yield* Effect.gen(function* () {
        const error = yield* runCliWith(["--not-a-real-flag"], { version: "9.9.9" }).pipe(
          Effect.flip,
        );
        return { error, stdout: (yield* TestConsole.logLines).join("\n") };
      }).pipe(Effect.provide(Layer.fresh(TestConsole.layer)));
      assert.isTrue(
        typeof unknownFlag.error === "object" &&
          unknownFlag.error !== null &&
          "_tag" in unknownFlag.error &&
          unknownFlag.error._tag === "ShowHelp",
      );
      assert.include(unknownFlag.stdout, "serve");
      assert.include(unknownFlag.stdout, "pair");
    }),
  );

  it.effect("builds the complete command tree through makeCli with cloud toggle", () =>
    Effect.gen(function* () {
      const enabledCli = yield* makeCli({ cloudEnabled: true });
      const disabledCli = yield* makeCli({ cloudEnabled: false });

      const enabledHelp = yield* Command.runWith(enabledCli, { version: "9.9.9" })(["--help"]).pipe(
        Effect.andThen(TestConsole.logLines),
        Effect.map((lines) => lines.join("\n")),
        Effect.provide(Layer.fresh(TestConsole.layer)),
      );
      const disabledHelp = yield* Command.runWith(disabledCli, { version: "9.9.9" })([
        "--help",
      ]).pipe(
        Effect.andThen(TestConsole.logLines),
        Effect.map((lines) => lines.join("\n")),
        Effect.provide(Layer.fresh(TestConsole.layer)),
      );

      assert.include(enabledHelp, "connect");
      assert.notInclude(disabledHelp, "Set up ZeroCode Connect for this machine.");
    }),
  );
});
