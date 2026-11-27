// @effect-diagnostics nodeBuiltinImport:off -- Runs the profiling preload in a real Node subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  auditStartupTraceEvents,
  FORBIDDEN_STARTUP_MODULES,
  type StartupTraceEvent,
} from "./profile-startup-audit.ts";

const decodeTrace = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      traceEvents: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          ts: Schema.Number,
          dur: Schema.Number,
          args: Schema.optional(
            Schema.Struct({
              stage: Schema.optional(Schema.String),
              url: Schema.optional(Schema.String),
              parentURL: Schema.optional(Schema.String),
              importedBy: Schema.optional(Schema.String),
              installed: Schema.optional(Schema.Boolean),
            }),
          ),
        }),
      ),
    }),
  ),
);

const decodeRunner = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Number, args: Schema.Array(Schema.String) })),
);

it("attributes ESM and CommonJS imports without changing module execution", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zerocode-startup-profile-"));
  try {
    NodeFS.writeFileSync(NodePath.join(directory, "package.json"), '{"type":"module"}');
    const fixtures = {
      "root.mjs": `
        import { value } from './dependency.mjs';
        import strict from './strict.cjs';
        import loose from './loose.cjs';
        import interop from './interop.cjs';
        if (value !== 42 || strict !== undefined || loose !== true || interop !== 9) {
          throw Error('Profiling changed module semantics');
        }
      `,
      "dependency.mjs": "export const value = 42;",
      "strict.cjs": `/* retain the directive */\n"use strict"; module.exports = (function () { return this; })();`,
      "loose.cjs": "module.exports = (function () { return this; })() === globalThis;",
      "interop.cjs": "module.exports = require('./required.js').value;",
      "required.js": "export const value = 9;",
    };
    for (const [name, source] of Object.entries(fixtures)) {
      NodeFS.writeFileSync(NodePath.join(directory, name), source);
    }
    const output = NodePath.join(directory, "capture");
    const root = NodeURL.pathToFileURL(
      NodeFS.realpathSync(NodePath.join(directory, "root.mjs")),
    ).href;
    NodeChildProcess.execFileSync(
      process.execPath,
      [
        "--no-node-snapshot",
        "--import",
        NodeURL.pathToFileURL(NodePath.join(import.meta.dirname, "profile-startup.mjs")).href,
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(root)})`,
      ],
      { env: { ...process.env, NODE_OPTIONS: "", ZEROCODE_STARTUP_PROFILE_DIR: output } },
    );
    const spans = NodeFS.readdirSync(output)
      .filter((name) => name.endsWith(".modules.json"))
      .flatMap(
        (name) => decodeTrace(NodeFS.readFileSync(NodePath.join(output, name), "utf8")).traceEvents,
      );
    expect(spans.some((span) => span.args?.installed === true)).toBe(true);
    for (const name of Object.keys(fixtures)) {
      const url = NodeURL.pathToFileURL(NodeFS.realpathSync(NodePath.join(directory, name))).href;
      const stages = spans.filter((span) => span.args?.url === url).map((span) => span.args?.stage);
      expect(stages, name).toEqual(
        expect.arrayContaining(
          name === "required.js" ? ["link", "require-esm"] : ["prepare", "evaluate"],
        ),
      );
    }
    const prepared = spans.find(
      (span) => span.args?.url === root && span.args?.stage === "prepare",
    );
    const linked = spans.find((span) => span.args?.url === root && span.args?.stage === "link");
    if (!prepared || !linked) throw Error("Missing root module preparation/link boundaries");
    expect(prepared.ts + prepared.dur).toBeLessThanOrEqual(linked.ts);
    const dependency = NodeURL.pathToFileURL(
      NodeFS.realpathSync(NodePath.join(directory, "dependency.mjs")),
    ).href;
    expect(
      spans.find((span) => span.args?.url === dependency && span.args?.stage === "link")?.args
        ?.importedBy,
    ).toBe(root);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it("captures only the dev runner and preserves its exit status", () => {
  const directory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "zerocode-startup-launcher-"),
  );
  try {
    NodeFS.mkdirSync(NodePath.join(directory, "scripts"));
    NodeFS.writeFileSync(
      NodePath.join(directory, "scripts/dev-runner.ts"),
      "console.log(JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));",
    );
    const output = NodePath.join(directory, "capture");
    const stdout = NodeChildProcess.execFileSync(
      process.execPath,
      [NodePath.join(import.meta.dirname, "profile-startup.mjs"), "--no-seed"],
      {
        cwd: directory,
        env: { ...process.env, NODE_OPTIONS: "", ZEROCODE_STARTUP_PROFILE_DIR: output },
        encoding: "utf8",
      },
    );
    const runner = decodeRunner(stdout.trim().split("\n").at(-1));
    expect(runner.args).toEqual(["dev", "--no-seed"]);
    expect(NodeFS.readdirSync(output).sort()).toEqual(
      ["cpuprofile", "modules.json", "process.json"].map((suffix) => `${runner.pid}-0.${suffix}`),
    );
    NodeFS.writeFileSync(
      NodePath.join(directory, "scripts/dev-runner.ts"),
      "process.kill(process.pid, 'SIGTERM');",
    );
    const interrupted = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(import.meta.dirname, "profile-startup.mjs")],
      {
        cwd: directory,
        env: { ...process.env, NODE_OPTIONS: "", ZEROCODE_STARTUP_PROFILE_DIR: output },
      },
    );
    expect(interrupted.error).toBeUndefined();
    expect(interrupted.status).toBe(1);
    const processRecord = JSON.parse(
      NodeFS.readFileSync(NodePath.join(output, `${runner.pid}-0.process.json`), "utf8"),
    ) as { startupAudit?: { ok: boolean; violations: ReadonlyArray<unknown> } };
    expect(processRecord.startupAudit?.ok).toBe(true);
    expect(processRecord.startupAudit?.violations).toEqual([]);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("auditStartupTraceEvents", () => {
  const moduleEvent = (
    stage: "load" | "evaluate" | "commonjs",
    url: string,
    ts: number,
  ): StartupTraceEvent => ({
    name: `${stage} ${url}`,
    cat: stage === "load" ? "module" : "module.detail",
    ph: "X",
    ts,
    dur: 500,
    args: { stage, url },
  });

  const readyEvent = (ts: number): StartupTraceEvent => ({
    name: "server.startup.http_listening",
    cat: "startup",
    ph: "X",
    ts,
    dur: 0,
  });

  it("passes cleanly when lazy modules are absent or only loaded after http_listening", () => {
    const events: ReadonlyArray<StartupTraceEvent> = [
      moduleEvent("load", "file:///repo/apps/server/src/binMain.ts", 10_000),
      moduleEvent("evaluate", "file:///repo/apps/server/src/serverRuntimeStartup.ts", 20_000),
      readyEvent(100_000),
      moduleEvent("load", "file:///repo/node_modules/@ff-labs/fff-node/index.js", 120_000),
      moduleEvent("evaluate", "file:///repo/node_modules/node-pty/lib/index.js", 130_000),
      moduleEvent(
        "evaluate",
        "file:///repo/apps/server/src/provider/Layers/ClaudeAdapterV2.ts",
        140_000,
      ),
      {
        name: "execFileSync git",
        cat: "subprocess",
        ph: "X",
        ts: 150_000,
        dur: 4_000,
      },
    ];

    const audit = auditStartupTraceEvents(events);
    expect(audit).toEqual({
      ok: true,
      httpListeningTsUs: 100_000,
      totalModulesBeforeReady: 2,
      violations: [],
      syncSubprocessesBeforeReady: [],
    });
  });

  it("flags every forbidden lazy module loaded before http_listening", () => {
    const samples: ReadonlyArray<readonly [string, string]> = [
      ["@ff-labs/fff-node", "file:///repo/node_modules/@ff-labs/fff-node/dist/index.js"],
      ["node-pty", "file:///repo/node_modules/node-pty/lib/index.js"],
      ["ClaudeAdapterV2", "file:///repo/apps/server/src/provider/Layers/ClaudeAdapterV2.ts"],
      ["CodexAdapterV2", "file:///repo/apps/server/src/provider/Layers/CodexAdapterV2.ts"],
      [
        "provider-opencode/src/server/v2/adapter",
        "file:///repo/packages/provider-opencode/src/server/v2/adapter.ts",
      ],
      [
        "provider-opencode/src/server/adapter",
        "file:///repo/packages/provider-opencode/src/server/adapter.ts",
      ],
      [
        "provider-cursor/src/server/adapter",
        "file:///repo/packages/provider-cursor/src/server/adapter.ts",
      ],
      ["provider-pi/src/server/adapter", "file:///repo/packages/provider-pi/src/server/adapter.ts"],
      [
        "provider-acp/src/server/adapter",
        "file:///repo/packages/provider-acp/src/server/adapter.ts",
      ],
      ["provider-fx/src/server/adapter", "file:///repo/packages/provider-fx/src/server/adapter.ts"],
      [
        "provider-grok/src/server/adapter",
        "file:///repo/packages/provider-grok/src/server/adapter.ts",
      ],
      [
        "provider-kiro/src/server/adapter",
        "file:///repo/packages/provider-kiro/src/server/adapter.ts",
      ],
      [
        "provider-muse/src/server/adapter",
        "file:///repo/packages/provider-muse/src/server/adapter.ts",
      ],
    ];

    expect(samples.map(([rule]) => rule)).toEqual(
      FORBIDDEN_STARTUP_MODULES.map((entry) => entry.rule),
    );

    for (const [index, [rule, url]] of samples.entries()) {
      const stage = index % 3 === 0 ? "load" : index % 3 === 1 ? "evaluate" : "commonjs";
      const audit = auditStartupTraceEvents([moduleEvent(stage, url, 50_000), readyEvent(100_000)]);
      expect(audit.ok, rule).toBe(false);
      expect(audit.violations, rule).toEqual([
        { rule, name: `${stage} ${url}`, url, tsUs: 50_000 },
      ]);
    }
  });

  it("flags synchronous execFileSync subprocess calls executed before http_listening", () => {
    const audit = auditStartupTraceEvents([
      moduleEvent("load", "file:///repo/apps/server/src/binMain.ts", 10_000),
      {
        name: "execFileSync /bin/zsh",
        cat: "subprocess",
        ph: "X",
        ts: 40_000,
        dur: 25_000,
      },
      readyEvent(100_000),
    ]);

    expect(audit.ok).toBe(false);
    expect(audit.violations).toEqual([]);
    expect(audit.syncSubprocessesBeforeReady).toEqual([
      { name: "execFileSync /bin/zsh", tsUs: 40_000, durUs: 25_000 },
    ]);
  });

  it("audits all startup events when no http_listening marker is present", () => {
    const audit = auditStartupTraceEvents([
      moduleEvent("commonjs", "file:///repo/node_modules/node-pty/lib/index.js", 30_000),
      { name: "execFileSync which", cat: "subprocess", ph: "X", ts: 35_000, dur: 2_000 },
    ]);

    expect(audit.ok).toBe(false);
    expect(audit.httpListeningTsUs).toBeNull();
    expect(audit.totalModulesBeforeReady).toBe(1);
    expect(audit.violations.map((entry) => entry.rule)).toEqual(["node-pty"]);
    expect(audit.syncSubprocessesBeforeReady).toHaveLength(1);
  });
});
