// The pure half of desktop-metrics.ts: bundle inspection, schemas, markdown summary, and run comparisons.
// @effect-diagnostics nodeBuiltinImport:off - inspectDesktopDistElectron reads built dist-electron/*.cjs bundles from disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

import { cell, compareSeries, type Floors, MachineState, median, round } from "../core/report.ts";

export const DESKTOP_CASES = ["startup", "bundle", "compile-cache", "pip"] as const;
export type DesktopCase = (typeof DESKTOP_CASES)[number];

export const DesktopStartupSample = Schema.Struct({
  bootToEnsureMainMs: Schema.NullOr(Schema.Number),
  ensureMainToFirstPaintMs: Schema.NullOr(Schema.Number),
  bootToFirstPaintMs: Schema.NullOr(Schema.Number),
  mainParseMs: Schema.Number,
  compileCacheHit: Schema.Boolean,
  appImageSimulated: Schema.Boolean,
});
export type DesktopStartupSample = typeof DesktopStartupSample.Type;

export const DesktopBundleBudget = Schema.Struct({
  mainBytes: Schema.Number,
  mainSharedBytes: Schema.Number,
  lazyChunkCount: Schema.Number,
  lazyChunkBytes: Schema.Number,
  undiciPresent: Schema.Boolean,
  orchestrationV2Present: Schema.Boolean,
});
export type DesktopBundleBudget = typeof DesktopBundleBudget.Type;

export const DesktopPipSample = Schema.Struct({
  frames: Schema.Number,
  idleCpuPct: Schema.Number,
  activeCpuPct: Schema.Number,
  avgFrameMs: Schema.Number,
});
export type DesktopPipSample = typeof DesktopPipSample.Type;

export const DesktopRun = Schema.Struct({
  startup: Schema.Array(DesktopStartupSample),
  bundle: Schema.optional(DesktopBundleBudget),
  pip: Schema.optional(DesktopPipSample),
  skipped: Schema.optional(
    Schema.Array(Schema.Struct({ case: Schema.String, reason: Schema.String })),
  ),
  machine: Schema.optional(MachineState),
});
export type DesktopRun = typeof DesktopRun.Type;

export const DesktopMetrics = Schema.Struct({
  meta: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
  ),
  runs: Schema.Array(DesktopRun),
});
export type DesktopMetrics = typeof DesktopMetrics.Type;

export const WORKLOAD_KEYS = ["cases"] as const;

export function parseDesktopCases(
  list: string,
): { cases: ReadonlyArray<DesktopCase> } | { error: string } {
  const named = list
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (named.length === 0) return { cases: DESKTOP_CASES };
  const unknown = named.filter(
    (entry) => !(DESKTOP_CASES as ReadonlyArray<string>).includes(entry),
  );
  if (unknown.length > 0) {
    return {
      error: `unknown desktop cases: ${unknown.join(", ")}; choose from ${DESKTOP_CASES.join(", ")}`,
    };
  }
  const chosen = new Set(named);
  return { cases: DESKTOP_CASES.filter((entry) => chosen.has(entry)) };
}

export function workloadDifferences(
  before: DesktopMetrics,
  after: DesktopMetrics,
  keys: ReadonlyArray<string> = WORKLOAD_KEYS,
) {
  const differ: string[] = [];
  const unrecorded: string[] = [];
  for (const key of keys) {
    const a = before.meta[key];
    const b = after.meta[key];
    if (a === undefined || b === undefined) {
      if (a !== b) unrecorded.push(key);
    } else if (a !== b) {
      differ.push(`${key} ${a} vs ${b}`);
    }
  }
  return { differ, unrecorded };
}

const EAGER_DESKTOP_FILE =
  /^(?:boot|compileCache|serverCompileCache|main|main-shared(?:-[^.]+)?|rolldown-runtime(?:-[^.]+)?|(?:.*-)?preload)\.cjs$/;
const MAIN_SHARED_FILE = /^main-shared(?:-[^.]+)?\.cjs$/;
const UNDICI_PATTERN = /\bundici\b/;
const ORCHESTRATION_V2_PATTERN = /\bOrchestrationV2ThreadProjection\b/;

/** Reads built `dist-electron/*.cjs` sizes and checks `undici` and `OrchestrationV2ThreadProjection` absence. */
export function inspectDesktopDistElectron(distDir: string): DesktopBundleBudget {
  const entries = NodeFS.readdirSync(distDir, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && entry.name.endsWith(".cjs"),
  );
  let mainBytes = 0;
  let mainSharedBytes = 0;
  let lazyChunkCount = 0;
  let lazyChunkBytes = 0;
  let undiciPresent = false;
  let orchestrationV2Present = false;
  for (const entry of entries) {
    const filePath = NodePath.join(distDir, entry.name);
    const bytes = NodeFS.statSync(filePath).size;
    if (entry.name === "main.cjs") {
      mainBytes += bytes;
    } else if (MAIN_SHARED_FILE.test(entry.name)) {
      mainSharedBytes += bytes;
    } else if (!EAGER_DESKTOP_FILE.test(entry.name)) {
      lazyChunkCount += 1;
      lazyChunkBytes += bytes;
    }
    if (!undiciPresent || !orchestrationV2Present) {
      const content = NodeFS.readFileSync(filePath, "utf8");
      if (!undiciPresent && UNDICI_PATTERN.test(content)) undiciPresent = true;
      if (!orchestrationV2Present && ORCHESTRATION_V2_PATTERN.test(content)) {
        orchestrationV2Present = true;
      }
    }
  }
  return {
    mainBytes,
    mainSharedBytes,
    lazyChunkCount,
    lazyChunkBytes,
    undiciPresent,
    orchestrationV2Present,
  };
}

const present = (values: ReadonlyArray<number | null>) =>
  values.filter((value): value is number => value !== null);

const startupModeOf = (sample: DesktopStartupSample) =>
  sample.appImageSimulated ? "appImage" : sample.compileCacheHit ? "warm" : "cold";

/** Every compared metric of a desktop file, one value per run (median across samples in the run). */
export function flattenDesktopMetrics(metrics: DesktopMetrics): Map<string, number[]> {
  const values = new Map<string, number[]>();
  for (const run of metrics.runs) {
    const inRun = new Map<string, number[]>();
    const add = (key: string, value: number | null | undefined) => {
      if (value === null || value === undefined || !Number.isFinite(value)) return;
      inRun.set(key, [...(inRun.get(key) ?? []), value]);
    };
    for (const sample of run.startup) {
      add("startup.bootToEnsureMainMs", sample.bootToEnsureMainMs);
      add("startup.ensureMainToFirstPaintMs", sample.ensureMainToFirstPaintMs);
      add("startup.bootToFirstPaintMs", sample.bootToFirstPaintMs);
      add("startup.mainParseMs", sample.mainParseMs);
      add(`startup.${startupModeOf(sample)}.mainParseMs`, sample.mainParseMs);
    }
    if (run.startup.length > 0) {
      const misses = run.startup.filter((sample) => !sample.compileCacheHit).length;
      add("startup.compileCacheMissPct", (misses / run.startup.length) * 100);
    }
    if (run.bundle !== undefined) {
      add("bundle.mainBytes", run.bundle.mainBytes);
      add("bundle.mainSharedBytes", run.bundle.mainSharedBytes);
      add("bundle.lazyChunkCount", run.bundle.lazyChunkCount);
      add("bundle.lazyChunkBytes", run.bundle.lazyChunkBytes);
      add("bundle.undiciPresent", run.bundle.undiciPresent ? 1 : 0);
      add("bundle.orchestrationV2Present", run.bundle.orchestrationV2Present ? 1 : 0);
    }
    if (run.pip !== undefined) {
      add("pip.idleCpuPct", run.pip.idleCpuPct);
      add("pip.activeCpuPct", run.pip.activeCpuPct);
      add("pip.avgFrameMs", run.pip.avgFrameMs);
    }
    for (const [key, samples] of inRun) {
      values.set(key, [...(values.get(key) ?? []), median(samples)!]);
    }
  }
  return values;
}

/** Markdown tables for desktop startup, bundle budget, compile-cache, and PiP metrics. */
export function summaryTable(metrics: DesktopMetrics): string {
  const lines = [
    "### Desktop metrics (lower is better)",
    "",
    `\`${metrics.meta.commit}\`, ${metrics.runs.length} run(s), ${metrics.meta.platform}`,
  ];
  const startup = metrics.runs.flatMap((run) => run.startup);
  if (startup.length > 0) {
    lines.push(
      "",
      "| startup mode | n | boot→ensureMain ms | ensureMain→paint ms | boot→paint ms | main parse ms | compile cache hit |",
      "| :-- | --: | --: | --: | --: | --: | :-- |",
    );
    for (const mode of new Set(startup.map(startupModeOf))) {
      const rows = startup.filter((sample) => startupModeOf(sample) === mode);
      const hits = rows.filter((sample) => sample.compileCacheHit).length;
      lines.push(
        `| ${mode} | ${rows.length} | ${cell(median(present(rows.map((sample) => sample.bootToEnsureMainMs))), 1)} | ${cell(median(present(rows.map((sample) => sample.ensureMainToFirstPaintMs))), 1)} | ${cell(median(present(rows.map((sample) => sample.bootToFirstPaintMs))), 1)} | ${cell(median(rows.map((sample) => sample.mainParseMs)), 1)} | ${hits}/${rows.length} |`,
      );
    }
  }
  const bundles = metrics.runs.flatMap((run) => (run.bundle ? [run.bundle] : []));
  if (bundles.length > 0) {
    const undiciAny = bundles.some((bundle) => bundle.undiciPresent);
    const orchestrationAny = bundles.some((bundle) => bundle.orchestrationV2Present);
    lines.push(
      "",
      "| dist-electron bundle | main bytes | main-shared bytes | lazy chunks | lazy bytes | undici | OrchestrationV2 |",
      "| :-- | --: | --: | --: | --: | :-- | :-- |",
      `| desktop main | ${cell(median(bundles.map((bundle) => bundle.mainBytes)))} | ${cell(median(bundles.map((bundle) => bundle.mainSharedBytes)))} | ${cell(median(bundles.map((bundle) => bundle.lazyChunkCount)))} | ${cell(median(bundles.map((bundle) => bundle.lazyChunkBytes)))} | ${undiciAny ? "present" : "absent"} | ${orchestrationAny ? "present" : "absent"} |`,
    );
  }
  const pips = metrics.runs.flatMap((run) => (run.pip ? [run.pip] : []));
  if (pips.length > 0) {
    lines.push(
      "",
      "| PiP screencast | frames p50 | idle CPU % | active CPU % | avg frame ms |",
      "| :-- | --: | --: | --: | --: |",
      `| pip | ${cell(median(pips.map((pip) => pip.frames)))} | ${cell(median(pips.map((pip) => pip.idleCpuPct)), 1)} | ${cell(median(pips.map((pip) => pip.activeCpuPct)), 1)} | ${round(median(pips.map((pip) => pip.avgFrameMs)) ?? 0, 1)} |`,
    );
  }
  for (const entry of metrics.runs.flatMap((run) => run.skipped ?? [])) {
    lines.push("", `Skipped ${entry.case}: ${entry.reason}`);
  }
  return lines.join("\n");
}

/** `compareSeries` over two desktop metrics files' per-run medians. */
export function compareRuns(
  before: DesktopMetrics,
  after: DesktopMetrics,
  threshold = 10,
  floors?: Floors,
) {
  return compareSeries(
    flattenDesktopMetrics(before),
    flattenDesktopMetrics(after),
    [
      "### Desktop metrics (lower is better)",
      "",
      `before \`${before.meta.commit}\` (${before.runs.length} runs), after \`${after.meta.commit}\` (${after.runs.length} runs)${floors ? `, floors calibrated on ${floors.platform}` : ""}`,
    ],
    threshold,
    floors,
  );
}
