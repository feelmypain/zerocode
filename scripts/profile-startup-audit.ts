// Lazy-boot regression audit for server startup traces captured by scripts/profile-startup.mjs.

export interface ForbiddenStartupModuleRule {
  readonly rule: string;
  readonly pattern: RegExp;
}

export const FORBIDDEN_STARTUP_MODULES: ReadonlyArray<ForbiddenStartupModuleRule> = [
  { rule: "@ff-labs/fff-node", pattern: /(?:^|[\\/])@ff-labs[\\/+]fff-node(?:[@\\/]|$)/ },
  { rule: "node-pty", pattern: /(?:^|[\\/])node-pty(?:[@\\/]|$)/ },
  { rule: "ClaudeAdapterV2", pattern: /(?:^|[\\/])ClaudeAdapterV2(?:\.[cm]?[jt]s)?(?:$|[?#\s])/ },
  { rule: "CodexAdapterV2", pattern: /(?:^|[\\/])CodexAdapterV2(?:\.[cm]?[jt]s)?(?:$|[?#\s])/ },
  {
    rule: "provider-opencode/src/server/v2/adapter",
    pattern: /provider-opencode[\\/]src[\\/]server[\\/]v2[\\/]adapter(?:\.[cm]?[jt]s)?(?:$|[?#\s])/,
  },
  {
    rule: "provider-opencode/src/server/adapter",
    pattern: /provider-opencode[\\/]src[\\/]server[\\/]adapter(?:\.[cm]?[jt]s)?(?:$|[?#\s])/,
  },
  {
    rule: "provider-cursor/src/server/adapter",
    pattern: /provider-cursor[\\/]src[\\/]server[\\/]adapter(?:\.[cm]?[jt]s)?(?:$|[?#\s])/,
  },
  {
    rule: "provider-pi/src/server/adapter",
    pattern: /provider-pi[\\/]src[\\/]server[\\/]adapter(?:\.[cm]?[jt]s)?(?:$|[?#\s])/,
  },
  {
    rule: "provider-acp/src/server/adapter",
    pattern: /provider-acp[\\/]src[\\/]server[\\/]adapter(?:\.[cm]?[jt]s)?(?:$|[?#\s])/,
  },
  {
    rule: "provider-fx/src/server/adapter",
    pattern: /provider-fx[\\/]src[\\/]server[\\/]adapter(?:\.[cm]?[jt]s)?(?:$|[?#\s])/,
  },
  {
    rule: "provider-grok/src/server/adapter",
    pattern: /provider-grok[\\/]src[\\/]server[\\/]adapter(?:\.[cm]?[jt]s)?(?:$|[?#\s])/,
  },
  {
    rule: "provider-kiro/src/server/adapter",
    pattern: /provider-kiro[\\/]src[\\/]server[\\/]adapter(?:\.[cm]?[jt]s)?(?:$|[?#\s])/,
  },
  {
    rule: "provider-muse/src/server/adapter",
    pattern: /provider-muse[\\/]src[\\/]server[\\/]adapter(?:\.[cm]?[jt]s)?(?:$|[?#\s])/,
  },
];

const MODULE_STAGE_EVENTS = new Set(["load", "evaluate", "commonjs", "require-esm"]);
const MODULE_NAME_PREFIX = /^(?:load|evaluate|commonjs|require-esm)\s+(.+)$/;

export interface StartupTraceEvent {
  readonly name?: string;
  readonly cat?: string;
  readonly ph?: string;
  readonly ts?: number;
  readonly dur?: number;
  readonly args?: {
    readonly stage?: string;
    readonly url?: string;
    readonly specifier?: string;
  };
}

export interface StartupAuditViolation {
  readonly rule: string;
  readonly name: string;
  readonly url: string;
  readonly tsUs: number;
}

export interface StartupSyncSubprocess {
  readonly name: string;
  readonly tsUs: number;
  readonly durUs: number;
}

export interface StartupAuditOptions {
  readonly readyMarker?: string;
  readonly forbiddenModules?: ReadonlyArray<ForbiddenStartupModuleRule>;
}

export interface StartupAuditResult {
  readonly ok: boolean;
  readonly httpListeningTsUs: number | null;
  readonly totalModulesBeforeReady: number;
  readonly violations: ReadonlyArray<StartupAuditViolation>;
  readonly syncSubprocessesBeforeReady: ReadonlyArray<StartupSyncSubprocess>;
}

/**
 * Audits trace events captured by `profile-startup.mjs` to ensure lazy modules and synchronous
 * `execFileSync` subprocess calls are not executed before `http_listening`.
 */
export function auditStartupTraceEvents(
  traceEvents: ReadonlyArray<StartupTraceEvent>,
  options: StartupAuditOptions = {},
): StartupAuditResult {
  const readyMarker = options.readyMarker ?? "http_listening";
  const forbiddenModules = options.forbiddenModules ?? FORBIDDEN_STARTUP_MODULES;

  let httpListeningTsUs: number | null = null;
  for (const event of traceEvents) {
    if (typeof event.name !== "string" || typeof event.ts !== "number") continue;
    if (event.name === readyMarker || event.name.includes(readyMarker)) {
      if (httpListeningTsUs === null || event.ts < httpListeningTsUs) {
        httpListeningTsUs = event.ts;
      }
    }
  }

  const modulesBeforeReady = new Set<string>();
  const seenViolations = new Set<string>();
  const violations: StartupAuditViolation[] = [];
  const syncSubprocessesBeforeReady: StartupSyncSubprocess[] = [];

  for (const event of traceEvents) {
    const name = typeof event.name === "string" ? event.name : "";
    const tsUs = typeof event.ts === "number" ? event.ts : 0;
    if (httpListeningTsUs !== null && tsUs > httpListeningTsUs) continue;

    if (event.cat === "subprocess" || name.startsWith("execFileSync")) {
      syncSubprocessesBeforeReady.push({
        name,
        tsUs,
        durUs: typeof event.dur === "number" ? event.dur : 0,
      });
      continue;
    }

    const stage = typeof event.args?.stage === "string" ? event.args.stage : undefined;
    const prefixMatch = MODULE_NAME_PREFIX.exec(name);
    const isModuleEvent =
      (stage !== undefined && MODULE_STAGE_EVENTS.has(stage)) || prefixMatch !== null;
    if (!isModuleEvent) continue;

    const url =
      typeof event.args?.url === "string"
        ? event.args.url
        : prefixMatch?.[1] !== undefined
          ? prefixMatch[1]
          : name;
    modulesBeforeReady.add(url);

    for (const entry of forbiddenModules) {
      if (!entry.pattern.test(url) && !entry.pattern.test(name)) continue;
      const dedupeKey = `${entry.rule}\u0000${url}`;
      if (seenViolations.has(dedupeKey)) continue;
      seenViolations.add(dedupeKey);
      violations.push({ rule: entry.rule, name, url, tsUs });
    }
  }

  violations.sort((a, b) => a.tsUs - b.tsUs);
  syncSubprocessesBeforeReady.sort((a, b) => a.tsUs - b.tsUs);

  return {
    ok: violations.length === 0 && syncSubprocessesBeforeReady.length === 0,
    httpListeningTsUs,
    totalModulesBeforeReady: modulesBeforeReady.size,
    violations,
    syncSubprocessesBeforeReady,
  };
}

/** Formats an audit result into concise diagnostic lines for launcher output. */
export function formatStartupAudit(audit: StartupAuditResult): string {
  if (audit.ok) {
    return `[profile-startup] Startup audit OK (${audit.totalModulesBeforeReady} modules before ready).`;
  }
  const lines = [
    `[profile-startup] Startup audit FAILED (${audit.violations.length} forbidden module(s), ${audit.syncSubprocessesBeforeReady.length} sync subprocess call(s) before ready):`,
  ];
  for (const violation of audit.violations) {
    lines.push(`  - module [${violation.rule}]: ${violation.url}`);
  }
  for (const sub of audit.syncSubprocessesBeforeReady) {
    lines.push(`  - subprocess: ${sub.name} (${Math.round(sub.durUs / 100) / 10} ms)`);
  }
  return lines.join("\n");
}
