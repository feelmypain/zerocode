// @effect-diagnostics nodeBuiltinImport:off - Creates temporary dist-electron fixtures for bundle inspection tests.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fromJsonStringPretty } from "@zerocode/shared/schemaJson";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  compareRuns,
  DESKTOP_CASES,
  DesktopMetrics,
  inspectDesktopDistElectron,
  parseDesktopCases,
  summaryTable,
  type DesktopRun,
  type DesktopStartupSample,
} from "./report.ts";

const decode = Schema.decodeSync(DesktopMetrics);
const encodePretty = Schema.encodeSync(fromJsonStringPretty(DesktopMetrics));
const decodePretty = Schema.decodeUnknownSync(fromJsonStringPretty(DesktopMetrics));

const startupSample = (overrides: Partial<DesktopStartupSample> = {}): DesktopStartupSample => ({
  bootToEnsureMainMs: 120,
  ensureMainToFirstPaintMs: 180,
  bootToFirstPaintMs: 300,
  mainParseMs: 42,
  compileCacheHit: true,
  appImageSimulated: false,
  ...overrides,
});

const makeRun = (overrides: Partial<DesktopRun> = {}): DesktopRun => ({
  startup: [startupSample()],
  bundle: {
    mainBytes: 7_000,
    mainSharedBytes: 4_100_000,
    lazyChunkCount: 8,
    lazyChunkBytes: 900_000,
    undiciPresent: false,
    orchestrationV2Present: false,
  },
  pip: {
    frames: 90,
    idleCpuPct: 1.2,
    activeCpuPct: 8.5,
    avgFrameMs: 16.7,
  },
  ...overrides,
});

const metricsFile = (commit: string, runs: ReadonlyArray<DesktopRun>) =>
  decode({
    meta: { commit, platform: "linux-x64", cases: DESKTOP_CASES.join(",") },
    runs: [...runs],
  });

describe("parseDesktopCases", () => {
  it("defaults to all cases and preserves canonical order", () => {
    expect(parseDesktopCases("")).toEqual({ cases: DESKTOP_CASES });
    expect(parseDesktopCases("pip, bundle, startup")).toEqual({
      cases: ["startup", "bundle", "pip"],
    });
  });

  it("rejects unknown and inherited property names", () => {
    const unknown = parseDesktopCases("startup,bogus");
    expect("error" in unknown && unknown.error).toMatch(/^unknown desktop cases: bogus;/);
    const inherited = parseDesktopCases("toString");
    expect("error" in inherited && inherited.error).toMatch(/^unknown desktop cases: toString;/);
  });
});

describe("inspectDesktopDistElectron", () => {
  it("computes bundle byte budgets and confirms undici and OrchestrationV2 absence", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zerocode-desktop-dist-clean-"));
    try {
      NodeFS.writeFileSync(NodePath.join(dir, "boot.cjs"), "require('./compileCache.cjs');");
      NodeFS.writeFileSync(NodePath.join(dir, "compileCache.cjs"), "module.exports = {};");
      NodeFS.writeFileSync(NodePath.join(dir, "preload.cjs"), "window.api = {};");
      NodeFS.writeFileSync(NodePath.join(dir, "rolldown-runtime-abc.cjs"), "exports.x = 1;");
      NodeFS.writeFileSync(NodePath.join(dir, "main.cjs"), "const m = 1;".repeat(20));
      NodeFS.writeFileSync(NodePath.join(dir, "main-shared-1234.cjs"), "const s = 2;".repeat(200));
      NodeFS.writeFileSync(
        NodePath.join(dir, "GnomeCaptureSetup-1.cjs"),
        "const g = 3;".repeat(10),
      );
      NodeFS.writeFileSync(
        NodePath.join(dir, "PasskeyBackendMac-2.cjs"),
        "const p = 4;".repeat(15),
      );
      NodeFS.writeFileSync(NodePath.join(dir, "main.cjs.map"), '{"version":3}');

      const budget = inspectDesktopDistElectron(dir);
      expect(budget.mainBytes).toBe("const m = 1;".repeat(20).length);
      expect(budget.mainSharedBytes).toBe("const s = 2;".repeat(200).length);
      expect(budget.lazyChunkCount).toBe(2);
      expect(budget.lazyChunkBytes).toBe(
        "const g = 3;".repeat(10).length + "const p = 4;".repeat(15).length,
      );
      expect(budget.undiciPresent).toBe(false);
      expect(budget.orchestrationV2Present).toBe(false);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags undici and OrchestrationV2ThreadProjection leaks in dist-electron", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zerocode-desktop-dist-leak-"));
    try {
      NodeFS.writeFileSync(NodePath.join(dir, "main.cjs"), 'require("undici");');
      NodeFS.writeFileSync(
        NodePath.join(dir, "main-shared-abcd.cjs"),
        "exports.OrchestrationV2ThreadProjection = {};",
      );

      const budget = inspectDesktopDistElectron(dir);
      expect(budget.undiciPresent).toBe(true);
      expect(budget.orchestrationV2Present).toBe(true);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DesktopMetrics schema and reporting", () => {
  it("round-trips DesktopMetrics JSON cleanly", () => {
    const sample = metricsFile("abc1234", [
      makeRun({
        startup: [
          startupSample({
            compileCacheHit: false,
            bootToEnsureMainMs: null,
            ensureMainToFirstPaintMs: null,
            bootToFirstPaintMs: null,
            mainParseMs: 85,
          }),
          startupSample({ compileCacheHit: true, mainParseMs: 32 }),
          startupSample({ compileCacheHit: true, appImageSimulated: true, mainParseMs: 35 }),
        ],
        skipped: [{ case: "pip", reason: "headless" }],
      }),
    ]);
    const serialized = encodePretty(sample);
    expect(decodePretty(serialized)).toEqual(sample);
  });

  it("renders startup, dist-electron bundle, PiP, and skipped rows in summaryTable", () => {
    const table = summaryTable(
      metricsFile("deadbeef", [
        makeRun({
          skipped: [{ case: "startup", reason: "no display" }],
        }),
      ]),
    );
    expect(table).toContain("### Desktop metrics (lower is better)");
    expect(table).toContain("| warm | 1 | 120 | 180 | 300 | 42 | 1/1 |");
    expect(table).toContain("| desktop main | 7000 | 4100000 | 8 | 900000 | absent | absent |");
    expect(table).toContain("| pip | 90 | 1.2 | 8.5 | 16.7 |");
    expect(table).toContain("Skipped startup: no display");
  });

  it("detects regressions in bootToFirstPaintMs, mainSharedBytes, compileCacheHit, and idleCpuPct", () => {
    const before = metricsFile("before1", [makeRun(), makeRun()]);
    const after = metricsFile("after2", [
      makeRun({
        startup: [
          startupSample({
            bootToFirstPaintMs: 520,
            ensureMainToFirstPaintMs: 340,
            compileCacheHit: false,
          }),
        ],
        bundle: {
          mainBytes: 7_000,
          mainSharedBytes: 5_200_000,
          lazyChunkCount: 8,
          lazyChunkBytes: 900_000,
          undiciPresent: true,
          orchestrationV2Present: false,
        },
        pip: {
          frames: 90,
          idleCpuPct: 14.5,
          activeCpuPct: 8.5,
          avgFrameMs: 16.7,
        },
      }),
      makeRun({
        startup: [
          startupSample({
            bootToFirstPaintMs: 530,
            ensureMainToFirstPaintMs: 350,
            compileCacheHit: false,
          }),
        ],
        bundle: {
          mainBytes: 7_000,
          mainSharedBytes: 5_250_000,
          lazyChunkCount: 8,
          lazyChunkBytes: 900_000,
          undiciPresent: true,
          orchestrationV2Present: false,
        },
        pip: {
          frames: 90,
          idleCpuPct: 15.0,
          activeCpuPct: 8.5,
          avgFrameMs: 16.7,
        },
      }),
    ]);

    const diff = compareRuns(before, after);
    expect(diff.regressed).toContain("startup.bootToFirstPaintMs");
    expect(diff.regressed).toContain("bundle.mainSharedBytes");
    expect(diff.regressed).toContain("startup.compileCacheMissPct");
    expect(diff.regressed).toContain("pip.idleCpuPct");
    expect(diff.regressed).toContain("bundle.undiciPresent");
  });
});
