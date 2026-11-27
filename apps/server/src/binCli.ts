import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Argument, Command } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as NetService from "@zerocode/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { hasCloudPublicConfig } from "./cloud/publicConfig.ts";
import { extendConnectionAttemptTimeout, keepOutboundFetchOnHttp1 } from "./outboundHttp.ts";
import { sharedServerCommandFlags } from "./cli/config.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);

const connectPublicConfigMissingMessage =
  "ZeroCode Connect commands are unavailable: this build is missing ZeroCode Connect public configuration.";

class ConnectPublicConfigMissingError extends CliError.UserError {
  override get message() {
    return connectPublicConfigMissingMessage;
  }
}

const connectUnavailableCommand = Command.make("connect", {
  command: Argument.String("command").pipe(Argument.variadic),
}).pipe(
  Command.withDescription(
    "ZeroCode Connect is unavailable in builds without public configuration.",
  ),
  Command.unlisted,
  Command.withHandler(() =>
    Effect.fail(
      new CliError.ShowHelp({
        commandPath: ["zerocode", "connect"],
        errors: [new ConnectPublicConfigMissingError({ cause: connectPublicConfigMissingMessage })],
      }),
    ),
  ),
);

const helpCommand = Command.make("help").pipe(
  Command.withDescription("Show command help."),
  Command.withHandler(() =>
    Effect.fail(new CliError.ShowHelp({ commandPath: ["zerocode"], errors: [] })),
  ),
);

// bin.ts runs the bare service invocation; this keeps flags and help working like other commands.
const serviceLauncherCommand = Command.make("__service-launcher").pipe(
  Command.unlisted,
  // The launcher owns shutdown until its child exits; `runMain` would interrupt that shutdown.
  Command.withHandler(() =>
    Effect.promise(() => import("./cli/serviceLauncher.ts")).pipe(
      Effect.tap(({ runServiceLauncherCli }) => Effect.sync(() => void runServiceLauncherCli())),
      Effect.asVoid,
    ),
  ),
);

// Explicit string-literal dynamic imports keep every CLI module visible to knip and the bundler.
const SUBCOMMAND_LOADERS = {
  "acp-mcp-bridge": () =>
    import("./cli/acpMcpBridge.ts").then((module) => module.acpMcpBridgeCommand),
  "acp-mcp-call": () => import("./cli/acpMcpBridge.ts").then((module) => module.acpMcpCallCommand),
  start: () => import("./cli/serverCommand.ts").then((module) => module.startCommand),
  serve: () => import("./cli/serverCommand.ts").then((module) => module.serveCommand),
  cli: () => import("./cli/tui.ts").then((module) => module.cliCommand),
  app: () => import("./cli/app.ts").then((module) => module.appCommand),
  pair: () => import("./cli/pair.ts").then((module) => module.pairCommand),
  auth: () => import("./cli/auth.ts").then((module) => module.authCommand),
  environment: () => import("./cli/environment.ts").then((module) => module.environmentCommand),
  browser: () => import("./cli/browser.ts").then((module) => module.browserCommand),
  project: () => import("./cli/project.ts").then((module) => module.projectCommand),
  thread: () => import("./cli/thread.ts").then((module) => module.threadCommand),
  workflow: () => import("./cli/workflow.ts").then((module) => module.workflowCommand),
  up: () => import("./cli/up.ts").then((module) => module.upCommand),
  status: () => import("./cli/up.ts").then((module) => module.statusCommand),
  service: () => import("./cli/service.ts").then((module) => module.serviceCommand),
  update: () => import("./cli/update.ts").then((module) => module.updateCommand),
  install: () => import("./cli/install.ts").then((module) => module.installCommand),
  uninstall: () => import("./cli/uninstall.ts").then((module) => module.uninstallCommand),
  "__service-launcher": () => Promise.resolve(serviceLauncherCommand),
  "__claude-history": () =>
    import("./cli/claudeHistory.ts").then((module) => module.claudeHistoryCommand),
  "__speech-worker": () =>
    import("./cli/speechWorker.ts").then((module) => module.speechWorkerCommand),
  "__ssh-helper": () => import("./cli/sshHelper.ts").then((module) => module.sshHelperCommand),
  "__service-preflight": () =>
    import("./cli/servicePreflight.ts").then((module) => module.servicePreflightCommand),
  theme: () => import("./cli/theme.ts").then((module) => module.themeCommand),
  trace: () => import("./cli/trace.ts").then((module) => module.traceCommand),
  doctor: () => import("./cli/doctor.ts").then((module) => module.doctorCommand),
  policy: () => import("./cli/policy.ts").then((module) => module.policyCommand),
  triage: () => import("./cli/triage.ts").then((module) => module.triageCommand),
  connect: () => import("./cli/up.ts").then((module) => module.connectCommand),
} as const;

type SubcommandName = keyof typeof SUBCOMMAND_LOADERS;
type LoadedSubcommand =
  | typeof helpCommand
  | typeof connectUnavailableCommand
  | Awaited<ReturnType<(typeof SUBCOMMAND_LOADERS)[SubcommandName]>>;

const SUBCOMMAND_ORDER: ReadonlyArray<SubcommandName> = [
  "acp-mcp-bridge",
  "acp-mcp-call",
  "start",
  "serve",
  "cli",
  "app",
  "pair",
  "auth",
  "environment",
  "browser",
  "project",
  "thread",
  "workflow",
  "up",
  "status",
  "service",
  "update",
  "install",
  "uninstall",
  "__service-launcher",
  "__claude-history",
  "__speech-worker",
  "__ssh-helper",
  "__service-preflight",
  "theme",
  "trace",
  "doctor",
  "policy",
  "triage",
  "connect",
];

const isSubcommandName = (value: string): value is SubcommandName =>
  Object.hasOwn(SUBCOMMAND_LOADERS, value);

const loadSubcommand = (name: SubcommandName, cloudEnabled: boolean): Promise<LoadedSubcommand> =>
  name === "connect" && !cloudEnabled
    ? Promise.resolve(connectUnavailableCommand)
    : SUBCOMMAND_LOADERS[name]();

const makeRootCommand = (subcommands: ReadonlyArray<LoadedSubcommand>) =>
  Command.make("zerocode", { ...sharedServerCommandFlags }).pipe(
    Command.withDescription(
      "Run ZeroCode in this terminal and open it in your browser. To use it from your other devices, run `zerocode up`.",
    ),
    Command.withHandler((flags) =>
      Effect.promise(() => import("./cli/serverCommand.ts")).pipe(
        Effect.flatMap(({ runDefaultServerCommand }) => runDefaultServerCommand(flags)),
      ),
    ),
    Command.withSubcommands(subcommands),
  );

const BOOLEAN_LITERALS = new Set(["true", "false", "yes", "no", "on", "off", "1", "0"]);
const LOG_LEVEL_LITERALS = new Set([
  "all",
  "trace",
  "debug",
  "info",
  "warn",
  "warning",
  "error",
  "fatal",
  "none",
]);
const ROOT_VALUE_FLAGS = new Set([
  "mode",
  "port",
  "host",
  "base-dir",
  "dev-url",
  "bootstrap-fd",
  "tailscale-serve-port",
]);
const ROOT_BOOLEAN_FLAGS = new Set([
  "no-browser",
  "auto-bootstrap-project-from-cwd",
  "log-websocket-events",
  "log-ws-events",
  "tailscale-serve",
  "lan",
]);
const ROOT_NEGATED_BOOLEAN_FLAGS = new Set([
  "no-no-browser",
  "no-auto-bootstrap-project-from-cwd",
  "no-log-websocket-events",
  "no-tailscale-serve",
  "no-lan",
]);

const isBooleanLiteral = (value: string | undefined): boolean =>
  value !== undefined && BOOLEAN_LITERALS.has(value.toLowerCase());

const isValidPortValue = (value: string): boolean => {
  if (!/^\d+$/.test(value)) return false;
  const port = Number.parseInt(value, 10);
  return port >= 1 && port <= 65535;
};

const isValidRootFlagValue = (name: string, value: string): boolean => {
  switch (name) {
    case "mode":
      return value === "web" || value === "desktop";
    case "port":
    case "tailscale-serve-port":
      return isValidPortValue(value);
    case "bootstrap-fd":
      return /^-?\d+$/.test(value);
    case "dev-url":
      return URL.canParse(value);
    case "log-level":
      return LOG_LEVEL_LITERALS.has(value);
    default:
      return true;
  }
};

type CliDispatchPlan =
  | { readonly kind: "all" }
  | { readonly kind: "root" }
  | { readonly kind: "subcommand"; readonly name: SubcommandName };

function planCliDispatch(args: ReadonlyArray<string>): CliDispatchPlan {
  for (const arg of args) {
    if (arg === "--") break;
    if (
      arg === "--completions" ||
      arg.startsWith("--completions=") ||
      arg === "--wizard" ||
      arg.startsWith("--wizard=")
    ) {
      return { kind: "all" };
    }
  }

  let sawHelp = false;
  let sawRootValueError = false;
  let rootPositionals = 0;
  let afterEndOfOptions = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!afterEndOfOptions && arg === "--") {
      afterEndOfOptions = true;
      continue;
    }
    if (afterEndOfOptions) {
      rootPositionals += 1;
      if (rootPositionals > 1) return { kind: "all" };
      continue;
    }

    if (arg.startsWith("--")) {
      const equalsIndex = arg.indexOf("=");
      const name = equalsIndex === -1 ? arg.slice(2) : arg.slice(2, equalsIndex);
      const hasInlineValue = equalsIndex !== -1;
      const inlineValue = hasInlineValue ? arg.slice(equalsIndex + 1) : undefined;

      if (name === "help" || name === "version") {
        if (name === "help") sawHelp = true;
        if (hasInlineValue) {
          if (!isBooleanLiteral(inlineValue)) sawRootValueError = true;
        } else if (isBooleanLiteral(args[index + 1])) {
          index += 1;
        }
        continue;
      }

      if (name === "log-level" || ROOT_VALUE_FLAGS.has(name)) {
        let value = inlineValue;
        if (!hasInlineValue) {
          const next = args[index + 1];
          if (next === undefined || (next.startsWith("-") && next !== "-")) {
            return { kind: "all" };
          }
          value = next;
          index += 1;
        }
        if (value === undefined || !isValidRootFlagValue(name, value)) {
          sawRootValueError = true;
        }
        continue;
      }

      if (ROOT_BOOLEAN_FLAGS.has(name)) {
        if (hasInlineValue) {
          if (!isBooleanLiteral(inlineValue)) sawRootValueError = true;
        } else if (isBooleanLiteral(args[index + 1])) {
          index += 1;
        }
        continue;
      }

      if (ROOT_NEGATED_BOOLEAN_FLAGS.has(name)) {
        if (hasInlineValue || isBooleanLiteral(args[index + 1])) {
          return { kind: "all" };
        }
        continue;
      }

      return { kind: "all" };
    }

    if (arg.startsWith("-") && arg.length > 1) {
      const equalsIndex = arg.indexOf("=");
      const flagsPart = equalsIndex === -1 ? arg.slice(1) : arg.slice(1, equalsIndex);
      const hasInlineValue = equalsIndex !== -1;
      const inlineValue = hasInlineValue ? arg.slice(equalsIndex + 1) : undefined;
      for (const ch of flagsPart) {
        if (ch === "h") sawHelp = true;
        else if (ch !== "v") return { kind: "all" };
      }
      if (hasInlineValue) {
        if (!isBooleanLiteral(inlineValue)) sawRootValueError = true;
      } else if (flagsPart.length === 1 && isBooleanLiteral(args[index + 1])) {
        index += 1;
      }
      continue;
    }

    if (rootPositionals === 0) {
      if (arg === "help") return { kind: "all" };
      if (isSubcommandName(arg)) return { kind: "subcommand", name: arg };
    }
    rootPositionals += 1;
    if (rootPositionals > 1) return { kind: "all" };
  }

  return sawHelp || sawRootValueError ? { kind: "all" } : { kind: "root" };
}

export const makeCli = ({ cloudEnabled = hasCloudPublicConfig } = {}) =>
  Effect.promise(() =>
    Promise.all(SUBCOMMAND_ORDER.map((name) => loadSubcommand(name, cloudEnabled))),
  ).pipe(Effect.map((subcommands) => makeRootCommand([helpCommand, ...subcommands])));

export const runCliWith = (
  args: ReadonlyArray<string>,
  options: {
    readonly version?: string;
    readonly cloudEnabled?: boolean;
  } = {},
) => {
  const version = options.version ?? packageJson.version;
  const cloudEnabled = options.cloudEnabled ?? hasCloudPublicConfig;
  const plan = planCliDispatch(args);
  const loadCommand =
    plan.kind === "all"
      ? makeCli({ cloudEnabled })
      : plan.kind === "subcommand"
        ? Effect.promise(() => loadSubcommand(plan.name, cloudEnabled)).pipe(
            Effect.map((subcommand) => makeRootCommand([subcommand])),
          )
        : Effect.succeed(makeRootCommand([]));
  return loadCommand.pipe(Effect.flatMap((command) => Command.runWith(command, { version })(args)));
};

export function runCli() {
  extendConnectionAttemptTimeout();
  keepOutboundFetchOnHttp1();
  const args = process.argv.slice(2);
  // A child started over IPC (a service launcher) has no one to answer.
  const interactive =
    Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.send === undefined;
  const maybeOfferCliInstall = !interactive
    ? Effect.succeed(true)
    : Effect.promise(() => import("./cli/install.ts")).pipe(
        Effect.flatMap(({ confirmCliInstall, inTerminalForeground, offerCliInstall }) =>
          offerCliInstall({
            args,
            interactive,
            foreground: inTerminalForeground,
            confirm: confirmCliInstall,
          }),
        ),
        // The offer handles its own errors; even an unexpected defect must not stop the command.
        Effect.catchDefect(() => Effect.succeed(true)),
      );
  maybeOfferCliInstall.pipe(
    Effect.flatMap((proceed) =>
      proceed
        ? runCliWith(args, { version: packageJson.version })
        : Effect.sync(() => {
            process.exitCode = 130;
          }),
    ),
    Effect.scoped,
    Effect.provide(layerCliRuntime),
    NodeRuntime.runMain,
  );
}
