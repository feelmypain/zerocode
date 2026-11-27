#!/usr/bin/env node
// Measures desktop main-process bundle budget, V8 compile cache behavior (including AppImage),
// packaged boot->ensureMain->first-paint timing, and PiP screencast CPU overhead.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@zerocode/shared/HostProcess";
import { fromJsonStringPretty } from "@zerocode/shared/schemaJson";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import { _electron, type ElectronApplication } from "playwright-core";

import { run } from "../../scenarios/shell.ts";
import { describeFailure, Floors, loadWarnings, round } from "../core/report.ts";
import {
  machineLoad,
  MetricsError,
  nowMs,
  output,
  runAbRounds,
  watchMachine,
} from "../core/run.ts";
import {
  compareRuns,
  DESKTOP_CASES,
  DesktopMetrics,
  inspectDesktopDistElectron,
  parseDesktopCases,
  summaryTable,
  workloadDifferences,
  type DesktopBundleBudget,
  type DesktopCase,
  type DesktopPipSample,
  type DesktopRun,
  type DesktopStartupSample,
} from "./report.ts";

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const decodeJson = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
const encodeJsonLiteral = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeMetrics = decodeJson(DesktopMetrics);
const encodeMetrics = Schema.encodeEffect(fromJsonStringPretty(DesktopMetrics));
const decodeFloors = decodeJson(Floors);

const CompileProbeResult = Schema.Struct({
  mainParseMs: Schema.Number,
  compileCacheHit: Schema.Boolean,
  appImageSimulated: Schema.Boolean,
});
const decodeCompileProbe = decodeJson(CompileProbeResult);

const browserPromise = <A>(what: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new MetricsError({ message: `${what}: ${describeFailure(cause)}` }),
  });

const casesOf = (list: string) => {
  const parsed = parseDesktopCases(list);
  return "error" in parsed
    ? Effect.fail(new MetricsError({ message: parsed.error }))
    : Effect.succeed(parsed.cases);
};

/** Builds `apps/desktop` main/preload bundles unless `--skip-build` was passed. */
const buildDesktop = Effect.fn("desktopMetrics.buildDesktop")(function* (checkout: string) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const desktopDir = path.join(checkout, "apps/desktop");
  yield* Console.error(`building ${desktopDir}...`);
  yield* run("vp", ["run", "build:electron"], { cwd: desktopDir }).pipe(
    Effect.catch(() => run("vp", ["build"], { cwd: desktopDir })),
    Effect.mapError((error) => new MetricsError({ message: error.message, cause: error })),
  );
  if (!(yield* fs.exists(path.join(desktopDir, "dist-electron/main.cjs")))) {
    return yield* new MetricsError({
      message: `${desktopDir}/dist-electron/main.cjs missing after build`,
    });
  }
});

/**
 * Isolated Node child script that times V8 parse+compile of `boot.cjs`, `compileCache.cjs`,
 * `main.cjs`, and `main-shared-*.cjs` without executing Electron side effects.
 */
const COMPILE_PROBE_SCRIPT = `
const fs = require("node:fs");
const moduleApi = require("node:module");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const distDir = process.env.ZEROCODE_PROBE_DIST_DIR;
const mode = process.env.ZEROCODE_PROBE_MODE;
const cacheDir = process.env.ZEROCODE_PROBE_CACHE_DIR;
const serverCacheHelper = process.env.ZEROCODE_PROBE_CACHE_HELPER;

const ABORT = Symbol("compileOnlyAbort");
const compileFile = (filePath) => {
  const source = fs.readFileSync(filePath, "utf8");
  const mod = new moduleApi.Module(filePath);
  mod.filename = filePath;
  mod.require = () => { throw ABORT; };
  try {
    mod._compile(source, filePath);
  } catch {}
};

let compileCacheEnabled = false;
if (mode === "warm") {
  const result = moduleApi.enableCompileCache({ directory: cacheDir, portable: true });
  compileCacheEnabled =
    result.status === moduleApi.constants.compileCacheStatus.ENABLED &&
    Boolean(moduleApi.getCompileCacheDir());
} else if (mode === "appimage") {
  // Simulates packaged AppImage layout: <resources>/app.asar/apps/desktop/dist-electron/main.cjs
  // with <resources>/server-compile-cache/manifest.json seeded beforehand.
  const helper = require(serverCacheHelper);
  const entry = path.join(distDir, "compileCache.cjs");
  compileCacheEnabled = helper.enablePreparedCompileCache(entry, cacheDir, "main");
}

const files = fs
  .readdirSync(distDir)
  .filter((name) => name === "boot.cjs" || name === "compileCache.cjs" || name === "main.cjs" || /^main-shared(?:-[^.]+)?\\.cjs$/.test(name))
  .sort();

const started = performance.now();
for (const file of files) {
  compileFile(path.join(distDir, file));
}
const elapsed = performance.now() - started;

if (compileCacheEnabled) {
  try { moduleApi.flushCompileCache(); } catch {}
}
const activeDir = moduleApi.getCompileCacheDir ? moduleApi.getCompileCacheDir() : undefined;
const hasCacheEntries = Boolean(
  activeDir && fs.existsSync(activeDir) && fs.readdirSync(activeDir).length > 0,
);

process.stdout.write(JSON.stringify({
  mainParseMs: Math.round(elapsed * 10) / 10,
  compileCacheHit: Boolean(compileCacheEnabled && hasCacheEntries),
  appImageSimulated: mode === "appimage",
}) + "\\n");
`;

/** Measures cold, warm V8 compile-cache, and simulated AppImage compile-cache parse times. */
const measureCompileCache = Effect.fn("desktopMetrics.measureCompileCache")(function* (
  checkout: string,
  distDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const node = yield* HostProcess.ExecutablePath;
  const hostEnv = yield* HostProcess.Environment;
  const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "zerocode-desktop-cache-" });
  const cacheHelper = path.join(checkout, "scripts/lib/server-compile-cache.ts");
  const probePath = path.join(tempRoot, "compile-probe.cjs");
  yield* fs.writeFileString(probePath, COMPILE_PROBE_SCRIPT);

  const baseEnv: Record<string, string> = Object.fromEntries(
    Object.entries(hostEnv).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "APPIMAGE" && entry[0] !== "NODE_COMPILE_CACHE",
    ),
  );

  const runProbe = (
    mode: "cold" | "warm" | "appimage",
    targetDist: string,
    cacheDir: string,
    extraEnv: Record<string, string> = {},
  ) =>
    run(node, [probePath], {
      cwd: checkout,
      env: {
        ...baseEnv,
        ...extraEnv,
        ZEROCODE_PROBE_DIST_DIR: targetDist,
        ZEROCODE_PROBE_MODE: mode,
        ZEROCODE_PROBE_CACHE_DIR: cacheDir,
        ZEROCODE_PROBE_CACHE_HELPER: cacheHelper,
      },
    }).pipe(
      Effect.mapError((error) => new MetricsError({ message: error.message, cause: error })),
      Effect.flatMap(({ stdout }) =>
        decodeCompileProbe(stdout.trim()).pipe(
          Effect.mapError(
            (cause) => new MetricsError({ message: `compile probe output: ${cause}` }),
          ),
        ),
      ),
    );

  const samples: DesktopStartupSample[] = [];

  // 1. Cold parse (no compile cache)
  const cold = yield* runProbe("cold", distDir, path.join(tempRoot, "unused"));
  samples.push({
    bootToEnsureMainMs: null,
    ensureMainToFirstPaintMs: null,
    bootToFirstPaintMs: null,
    mainParseMs: cold.mainParseMs,
    compileCacheHit: false,
    appImageSimulated: false,
  });

  // 2. Warm parse (prime once, then measure warm hit in a fresh process)
  const warmCacheDir = path.join(tempRoot, "warm-cache");
  yield* runProbe("warm", distDir, warmCacheDir);
  const warm = yield* runProbe("warm", distDir, warmCacheDir);
  samples.push({
    bootToEnsureMainMs: null,
    ensureMainToFirstPaintMs: null,
    bootToFirstPaintMs: null,
    mainParseMs: warm.mainParseMs,
    compileCacheHit: warm.compileCacheHit,
    appImageSimulated: false,
  });

  // 3. Simulated AppImage prepared compile-cache activation (Wave 2.4)
  if (yield* fs.exists(cacheHelper)) {
    const resources = path.join(tempRoot, "appimage-resources");
    const fakeDist = path.join(resources, "app.asar/apps/desktop/dist-electron");
    const prepared = path.join(resources, "server-compile-cache");
    yield* fs.makeDirectory(fakeDist, { recursive: true });
    yield* fs.makeDirectory(prepared, { recursive: true });
    const cjsFiles = (yield* fs.readDirectory(distDir)).filter(
      (name) =>
        name === "boot.cjs" ||
        name === "compileCache.cjs" ||
        name === "main.cjs" ||
        /^main-shared(?:-[^.]+)?\.cjs$/.test(name),
    );
    for (const file of cjsFiles) {
      yield* fs.copyFile(path.join(distDir, file), path.join(fakeDist, file));
    }
    const [cacheHelperJson, preparedJson, fakeDistJson, filesJson] = yield* Effect.all([
      encodeJsonLiteral(cacheHelper),
      encodeJsonLiteral(prepared),
      encodeJsonLiteral(fakeDist),
      encodeJsonLiteral(cjsFiles),
    ]).pipe(
      Effect.mapError(
        (cause) => new MetricsError({ message: `encode probe args: ${String(cause)}` }),
      ),
    );
    const seedScript = `
const fs = require("node:fs");
const moduleApi = require("node:module");
const path = require("node:path");
const helper = require(${cacheHelperJson});
const prepared = ${preparedJson};
const fakeDist = ${fakeDistJson};
const files = ${filesJson};
const ABORT = Symbol("abort");
moduleApi.enableCompileCache({ directory: prepared, portable: true });
for (const file of files) {
  const full = path.join(fakeDist, file);
  const mod = new moduleApi.Module(full);
  mod.filename = full;
  mod.require = () => { throw ABORT; };
  try { mod._compile(fs.readFileSync(full, "utf8"), full); } catch {}
}
moduleApi.flushCompileCache();
const active = moduleApi.getCompileCacheDir();
const entries = [];
for (const file of files) {
  const key = helper.cacheKey(active, path.join(fakeDist, file), "cjs");
  if (fs.existsSync(path.join(active, key))) {
    fs.copyFileSync(path.join(active, key), path.join(prepared, key));
    entries.push({ module: "app.asar/apps/desktop/dist-electron/" + file, file: key });
  }
}
fs.writeFileSync(
  path.join(prepared, "manifest.json"),
  JSON.stringify({ format: 1, runtime: helper.runtimeIdentity(), entries }),
);
fs.rmSync(active, { recursive: true, force: true });
`;
    const seedPath = path.join(tempRoot, "seed-appimage-cache.cjs");
    yield* fs.writeFileString(seedPath, seedScript);
    yield* run(node, [seedPath], { cwd: checkout, env: baseEnv }).pipe(
      Effect.mapError((error) => new MetricsError({ message: error.message, cause: error })),
    );
    const appImageCacheDir = path.join(tempRoot, "appimage-runtime-cache");
    const appImage = yield* runProbe("appimage", fakeDist, appImageCacheDir, {
      APPIMAGE: "/tmp/zerocode.AppImage",
    });
    samples.push({
      bootToEnsureMainMs: null,
      ensureMainToFirstPaintMs: null,
      bootToFirstPaintMs: null,
      mainParseMs: appImage.mainParseMs,
      compileCacheHit: appImage.compileCacheHit,
      appImageSimulated: true,
    });
  }

  return samples;
}, Effect.scoped);

const resolveElectronExecutable = Effect.fn("desktopMetrics.resolveElectron")(function* (
  checkout: string,
  override: Option.Option<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (Option.isSome(override)) {
    const resolved = path.resolve(override.value);
    return (yield* fs.exists(resolved)) ? Option.some(resolved) : Option.none<string>();
  }
  const candidates = [
    path.join(checkout, "apps/desktop/node_modules/.bin/electron"),
    path.join(checkout, "node_modules/.bin/electron"),
  ];
  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) return Option.some(candidate);
  }
  return Option.none<string>();
});

const hasGuiDisplay = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform !== "linux") return true;
  const env = yield* HostProcess.Environment;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
});

/**
 * Measures Electron `boot.cjs` -> `ensureMain` -> first paint and optional PiP screencast idle vs
 * active frame CPU. Gracefully returns skip reasons on headless runners or without an Electron binary.
 */
const measureElectronGui = Effect.fn("desktopMetrics.measureElectronGui")(function* (options: {
  readonly checkout: string;
  readonly executable: Option.Option<string>;
  readonly measureStartup: boolean;
  readonly measurePip: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostEnv = yield* HostProcess.Environment;
  const skipped: Array<{ case: string; reason: string }> = [];
  const skipBoth = (reason: string) => {
    if (options.measureStartup) skipped.push({ case: "startup", reason });
    if (options.measurePip) skipped.push({ case: "pip", reason });
    return {
      startup: undefined as DesktopStartupSample | undefined,
      pip: undefined as DesktopPipSample | undefined,
      skipped,
    };
  };

  if (!(yield* hasGuiDisplay)) {
    return skipBoth("no graphical display available (DISPLAY/WAYLAND_DISPLAY unset)");
  }
  const electronBinary = yield* resolveElectronExecutable(options.checkout, options.executable);
  if (Option.isNone(electronBinary)) {
    return skipBoth("no Electron executable found (pass --executable or install apps/desktop)");
  }
  const desktopDir = path.join(options.checkout, "apps/desktop");
  if (!(yield* fs.exists(path.join(desktopDir, "dist-electron/boot.cjs")))) {
    return skipBoth("apps/desktop/dist-electron/boot.cjs missing");
  }

  const home = yield* fs.makeTempDirectoryScoped({ prefix: "zerocode-desktop-gui-" });
  const zerocodeHome = path.join(home, "zerocode");
  yield* fs.makeDirectory(path.join(zerocodeHome, "userdata"), { recursive: true });
  const fixtureDb = path.join(options.checkout, "scripts/fixtures/desktop-launch/statev2.sqlite");
  if (yield* fs.exists(fixtureDb)) {
    yield* fs.copyFile(fixtureDb, path.join(zerocodeHome, "userdata/statev2.sqlite"));
  }

  const launchStartedMs = yield* nowMs;
  const app = yield* Effect.acquireRelease(
    browserPromise("launch Electron", () =>
      _electron.launch({
        executablePath: electronBinary.value,
        args: [desktopDir, "--no-sandbox"],
        env: {
          ...Object.fromEntries(
            Object.entries(hostEnv).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_DATA_HOME: path.join(home, ".local/share"),
          ZEROCODE_HOME: zerocodeHome,
          ZEROCODE_DISABLE_AUTO_UPDATE: "true",
        },
        timeout: 60_000,
      }),
    ),
    (launched: ElectronApplication) =>
      Effect.gen(function* () {
        const child = launched.process();
        yield* Effect.promise(() => launched.close()).pipe(
          Effect.timeout(Duration.seconds(5)),
          Effect.ignore,
        );
        yield* Effect.sync(() => {
          child.kill("SIGKILL");
        });
      }).pipe(Effect.ignore),
  );

  const page = yield* browserPromise("first Electron window", () =>
    app.firstWindow({ timeout: 60_000 }),
  );
  const ensureMainAtMs = yield* nowMs;
  yield* browserPromise("first paint", async () => {
    await page.waitForLoadState("domcontentloaded", { timeout: 60_000 });
    await page.evaluate(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
    );
  });
  const firstPaintAtMs = yield* nowMs;

  const cacheHit = yield* browserPromise("check Electron compile cache", () =>
    app.evaluate(async () => {
      try {
        const mod = await import("node:module");
        return Boolean(mod.getCompileCacheDir?.());
      } catch {
        return false;
      }
    }),
  ).pipe(Effect.orElseSucceed(() => false));

  let startup: DesktopStartupSample | undefined;
  if (options.measureStartup) {
    const bootToEnsureMainMs = round(Math.max(0, ensureMainAtMs - launchStartedMs), 1);
    const ensureMainToFirstPaintMs = round(Math.max(0, firstPaintAtMs - ensureMainAtMs), 1);
    const bootToFirstPaintMs = round(Math.max(0, firstPaintAtMs - launchStartedMs), 1);
    startup = {
      bootToEnsureMainMs,
      ensureMainToFirstPaintMs,
      bootToFirstPaintMs,
      mainParseMs: bootToEnsureMainMs,
      compileCacheHit: cacheHit,
      appImageSimulated: Boolean(hostEnv.APPIMAGE),
    };
  }

  let pip: DesktopPipSample | undefined;
  if (options.measurePip) {
    const cdp = yield* browserPromise("Electron CDP session", () =>
      page.context().newCDPSession(page),
    );
    yield* browserPromise("Performance.enable", () => cdp.send("Performance.enable"));
    const readTaskDuration = () =>
      browserPromise("Performance.getMetrics", () => cdp.send("Performance.getMetrics")).pipe(
        Effect.map(
          ({ metrics }) => metrics.find((entry) => entry.name === "TaskDuration")?.value ?? 0,
        ),
      );
    const sampleCpuPct = Effect.fn("desktopMetrics.sampleCpuPct")(function* (windowMs: number) {
      const t0 = yield* nowMs;
      const before = yield* readTaskDuration();
      yield* Effect.sleep(Duration.millis(windowMs));
      const after = yield* readTaskDuration();
      const seconds = Math.max(0.001, ((yield* nowMs) - t0) / 1_000);
      return round(Math.max(0, ((after - before) / seconds) * 100), 1);
    });
    const idleCpuPct = yield* sampleCpuPct(2_000);
    const activeStartTask = yield* readTaskDuration();
    const activeStartMs = yield* nowMs;
    const decodePipFrames = Schema.decodeUnknownEffect(
      Schema.Struct({ frames: Schema.Number, avgFrameMs: Schema.Number }),
    );
    const activeFrames = yield* browserPromise("PiP active frame sample", () =>
      page.evaluate(`new Promise((resolve) => {
        const deltas = [];
        let prev = performance.now();
        const stopAt = prev + 1500;
        const tick = (now) => {
          deltas.push(now - prev);
          prev = now;
          if (now < stopAt) {
            requestAnimationFrame(tick);
          } else {
            const avg = deltas.length > 0 ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : 0;
            resolve({ frames: deltas.length, avgFrameMs: Math.round(avg * 10) / 10 });
          }
        };
        requestAnimationFrame(tick);
      })`),
    ).pipe(
      Effect.flatMap((value) =>
        decodePipFrames(value).pipe(
          Effect.mapError((cause) => new MetricsError({ message: `PiP frame sample: ${cause}` })),
        ),
      ),
    );
    const activeEndTask = yield* readTaskDuration();
    const activeSeconds = Math.max(0.001, ((yield* nowMs) - activeStartMs) / 1_000);
    const activeCpuPct = round(
      Math.max(0, ((activeEndTask - activeStartTask) / activeSeconds) * 100),
      1,
    );
    pip = {
      frames: activeFrames.frames,
      idleCpuPct,
      activeCpuPct,
      avgFrameMs: activeFrames.avgFrameMs,
    };
  }

  return { startup, pip, skipped };
}, Effect.scoped);

interface MeasureOptions {
  readonly checkout: string;
  readonly cases: ReadonlyArray<DesktopCase>;
  readonly executable: Option.Option<string>;
}

const measureOnce = Effect.fn("desktopMetrics.measureOnce")(function* (options: MeasureOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const machine = yield* watchMachine;
  const distDir = path.join(options.checkout, "apps/desktop/dist-electron");
  const hasDist = yield* fs.exists(distDir);
  const startup: DesktopStartupSample[] = [];
  const skipped: Array<{ case: string; reason: string }> = [];
  let bundle: DesktopBundleBudget | undefined;
  let pip: DesktopPipSample | undefined;

  if (options.cases.includes("bundle")) {
    if (!hasDist) {
      skipped.push({ case: "bundle", reason: `${distDir} does not exist` });
    } else {
      bundle = inspectDesktopDistElectron(distDir);
    }
  }

  if (options.cases.includes("compile-cache")) {
    if (!hasDist) {
      skipped.push({ case: "compile-cache", reason: `${distDir} does not exist` });
    } else {
      const cacheSamples = yield* measureCompileCache(options.checkout, distDir).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            skipped.push({ case: "compile-cache", reason: error.message.split("\n")[0]! });
            return [] as DesktopStartupSample[];
          }),
        ),
      );
      startup.push(...cacheSamples);
    }
  }

  const measureStartup = options.cases.includes("startup");
  const measurePip = options.cases.includes("pip");
  if (measureStartup || measurePip) {
    const gui = yield* measureElectronGui({
      checkout: options.checkout,
      executable: options.executable,
      measureStartup,
      measurePip,
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          const reason = error.message.split("\n")[0]!;
          const fallbackSkipped: Array<{ case: string; reason: string }> = [];
          if (measureStartup) fallbackSkipped.push({ case: "startup", reason });
          if (measurePip) fallbackSkipped.push({ case: "pip", reason });
          return {
            startup: undefined as DesktopStartupSample | undefined,
            pip: undefined as DesktopPipSample | undefined,
            skipped: fallbackSkipped,
          };
        }),
      ),
    );
    if (gui.startup !== undefined) startup.push(gui.startup);
    if (gui.pip !== undefined) pip = gui.pip;
    skipped.push(...gui.skipped);
  }

  const runResult: DesktopRun = {
    startup,
    ...(bundle === undefined ? {} : { bundle }),
    ...(pip === undefined ? {} : { pip }),
    ...(skipped.length === 0 ? {} : { skipped }),
    machine: yield* machine,
  };
  return runResult;
}, Effect.scoped);

const metaFor = Effect.fn("desktopMetrics.metaFor")(function* (
  checkout: string,
  cases: ReadonlyArray<DesktopCase>,
) {
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const node = yield* HostProcess.ExecutablePath;
  const cpus = yield* output("getconf", ["_NPROCESSORS_ONLN"]);
  return {
    platform: `${platform}-${architecture}`,
    cpus: Option.getOrNull(Option.map(cpus, Number)),
    node: Option.getOrNull(yield* output(node, ["--version"])),
    commit: Option.getOrNull(yield* output("git", ["rev-parse", "--short=12", "HEAD"], checkout)),
    cases: cases.join(","),
    loadBefore: yield* machineLoad,
    measuredAt: DateTime.formatIso(yield* DateTime.now),
  };
});

const writeMetrics = Effect.fn("desktopMetrics.writeMetrics")(function* (
  out: Option.Option<string>,
  metrics: DesktopMetrics,
) {
  const fs = yield* FileSystem.FileSystem;
  const json = yield* encodeMetrics(metrics);
  if (Option.isSome(out)) {
    const temp = `${out.value}.tmp`;
    yield* fs.writeFileString(temp, `${json}\n`);
    yield* fs.rename(temp, out.value);
  }
});

const readMetrics = Effect.fn("desktopMetrics.readMetrics")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(Effect.flatMap(decodeMetrics));
});

const readFloors = Effect.fn("desktopMetrics.readFloors")(function* (file: Option.Option<string>) {
  const fs = yield* FileSystem.FileSystem;
  if (Option.isNone(file)) return undefined;
  return yield* fs.readFileString(file.value).pipe(Effect.flatMap(decodeFloors));
});

const report = Effect.fn("desktopMetrics.report")(function* (
  before: DesktopMetrics,
  after: DesktopMetrics,
  threshold: number,
  floors: Floors | undefined,
) {
  const workload = workloadDifferences(before, after);
  if (workload.differ.length > 0) {
    return yield* new MetricsError({
      message: `the files ran different workloads (${workload.differ.join("; ")}); rerun one side with the other's settings`,
    });
  }
  const { table, regressed, improved, noisy, compared } = compareRuns(
    before,
    after,
    threshold,
    floors,
  );
  yield* Console.log(table);
  for (const warning of [...loadWarnings("before", before), ...loadWarnings("after", after)]) {
    yield* Console.error(`Warning: ${warning}`);
  }
  if (compared === 0) {
    return yield* new MetricsError({ message: "the two files share no metric" });
  }
  if (noisy.length) {
    yield* Console.error(
      `Moved, but not gated (too noisy, or one run a side): ${noisy.join(", ")}`,
    );
  }
  if (improved.length) yield* Console.error(`Better: ${improved.join(", ")}`);
  if (regressed.length === 0) return;
  yield* Console.error(`Worse: ${regressed.join(", ")}`);
  yield* Effect.sync(() => {
    process.exitCode = 1;
  });
});

const measureFlags = {
  cases: Flag.String("cases").pipe(
    Flag.withDescription(
      `Cases to run, comma separated: ${DESKTOP_CASES.join(", ")}. Default: all.`,
    ),
    Flag.withDefault(""),
  ),
  skipBuild: Flag.Boolean("skip-build").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Inspect existing apps/desktop/dist-electron instead of rebuilding it."),
  ),
  executable: Flag.String("executable").pipe(
    Flag.withDescription(
      "Path to an Electron or packaged ZeroCode executable for GUI startup/PiP runs.",
    ),
    Flag.optional,
  ),
};

const thresholdFlag = Flag.Int("threshold").pipe(
  Flag.withDescription("Percent a metric must move, past its floor, to count."),
  Flag.withDefault(10),
);
const floorsFlag = Flag.String("floors").pipe(
  Flag.withDescription("Optional calibrated floors JSON file."),
  Flag.optional,
);

const runCommand = Command.make(
  "run",
  {
    ...measureFlags,
    out: Flag.String("out").pipe(Flag.withDescription("JSON file to write."), Flag.optional),
    checkout: Flag.String("checkout").pipe(
      Flag.withDescription("Checkout to measure, with dependencies installed."),
      Flag.optional,
    ),
  },
  Effect.fn("desktopMetrics.run")(function* (input) {
    const path = yield* Path.Path;
    const checkout = path.resolve(
      Option.getOrElse(input.checkout, () => path.resolve(import.meta.dirname, "../../..")),
    );
    const cases = yield* casesOf(input.cases);
    if (!input.skipBuild) yield* buildDesktop(checkout);
    const meta = yield* metaFor(checkout, cases);
    const runResult = yield* measureOnce({
      checkout,
      cases,
      executable: input.executable,
    });
    const metrics: DesktopMetrics = {
      meta: { ...meta, loadAfter: yield* machineLoad },
      runs: [runResult],
    };
    yield* writeMetrics(input.out, metrics);
    yield* Console.log(summaryTable(metrics));
  }),
).pipe(
  Command.withDescription(
    "Measure desktop dist-electron bundle budgets, V8 compile-cache parse speed (including AppImage simulation), and Electron boot/PiP metrics when a display and binary are available.",
  ),
);

const abCommand = Command.make(
  "ab",
  {
    ...measureFlags,
    checkoutA: Argument.String("checkout-a").pipe(Argument.withDescription("Baseline checkout.")),
    checkoutB: Argument.String("checkout-b").pipe(Argument.withDescription("Candidate checkout.")),
    rounds: Flag.Int("rounds").pipe(
      Flag.withSchema(PositiveInt),
      Flag.withDescription("Rounds; each runs A and B once, alternating which goes first."),
      Flag.withDefault(3),
    ),
    outDir: Flag.String("out-dir").pipe(
      Flag.withDescription("Directory for a.json and b.json."),
      Flag.withDefault("desktop-metrics-ab"),
    ),
    threshold: thresholdFlag,
    floors: floorsFlag,
  },
  Effect.fn("desktopMetrics.ab")(function* (input) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outDir = path.resolve(input.outDir);
    yield* fs.makeDirectory(outDir, { recursive: true });
    const cases = yield* casesOf(input.cases);
    const floors = yield* readFloors(input.floors);
    const checkouts = [path.resolve(input.checkoutA), path.resolve(input.checkoutB)] as const;
    if (!input.skipBuild) {
      yield* buildDesktop(checkouts[0]);
      if (checkouts[1] !== checkouts[0]) yield* buildDesktop(checkouts[1]);
    }
    const metas = [
      yield* metaFor(checkouts[0], cases),
      yield* metaFor(checkouts[1], cases),
    ] as const;
    const saved = yield* runAbRounds({
      rounds: input.rounds,
      outDir,
      runSide: (side) =>
        measureOnce({
          checkout: checkouts[side],
          cases,
          executable: input.executable,
        }),
      save: Effect.fn("desktopMetrics.abSave")(function* (side, runs) {
        const file: DesktopMetrics = {
          meta: { ...metas[side], loadAfter: yield* machineLoad },
          runs: [...runs],
        };
        yield* writeMetrics(Option.some(path.join(outDir, side === 0 ? "a.json" : "b.json")), file);
        return file;
      }),
    });
    yield* report(saved[0], saved[1], input.threshold, floors);
  }),
).pipe(
  Command.withDescription(
    "Run two checkouts alternately (A B, then B A) and compare desktop bundle, compile-cache, startup, and PiP metrics.",
  ),
);

const compareCommand = Command.make(
  "compare",
  {
    before: Argument.String("before").pipe(Argument.withDescription("Baseline JSON.")),
    after: Argument.String("after").pipe(Argument.withDescription("Candidate JSON.")),
    threshold: thresholdFlag,
    floors: floorsFlag,
  },
  Effect.fn("desktopMetrics.compare")(function* (input) {
    yield* report(
      yield* readMetrics(input.before),
      yield* readMetrics(input.after),
      input.threshold,
      yield* readFloors(input.floors),
    );
  }),
).pipe(
  Command.withDescription("Compare two desktop metrics JSON files and exit 1 on regressions."),
);

const summaryCommand = Command.make(
  "summary",
  { file: Argument.String("file").pipe(Argument.withDescription("A result JSON.")) },
  Effect.fn("desktopMetrics.summary")(function* (input) {
    yield* Console.log(summaryTable(yield* readMetrics(input.file)));
  }),
).pipe(Command.withDescription("Print a desktop metrics JSON file's markdown summary tables."));

const desktopMetricsCommand = Command.make("desktop-metrics").pipe(
  Command.withDescription(
    `Measure the Electron desktop app's bundle weight, V8 compile-cache parse speed, startup latency, and PiP overhead.

Cases:
  bundle         Inspect apps/desktop/dist-electron/*.cjs sizes and guard against undici / OrchestrationV2ThreadProjection leaks.
  compile-cache  Benchmark cold vs warm V8 compile cache and simulated AppImage prepared cache activation.
  startup        Measure Electron boot.cjs -> ensureMain -> first paint when an Electron binary and display are available.
  pip            Measure PiP screencast idle vs active frame CPU when an Electron binary and display are available.`,
  ),
  Command.withSubcommands([runCommand, abCommand, compareCommand, summaryCommand]),
);

if (import.meta.main) {
  Command.run(desktopMetricsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.catchTags({
      MetricsError: (error) =>
        Console.error(`desktop-metrics: ${error.message}`).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
    }),
    NodeRuntime.runMain,
  );
}
