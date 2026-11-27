import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import { expandHomePath } from "../os-jank.ts";
import { baseDirFlag, resolveCliAuthConfig } from "./config.ts";
import { runInteractiveTui } from "./tui/app.ts";
import { TuiConnectionError, connectTuiServer } from "./tui/client.ts";
import {
  BUILT_IN_TUI_THEMES,
  TUI_CONFIG_FILENAME,
  loadCustomZeroCodeThemes,
  loadTuiConfig,
  type TuiColorMode,
} from "./tui/themes.ts";

export const cliCommand = Command.make("cli", {
  project: Argument.String("project").pipe(
    Argument.withDescription(
      "Project directory or id to open in the interactive terminal UI (defaults to current directory).",
    ),
    Argument.optional,
  ),
  baseDir: baseDirFlag,
  thread: Flag.String("thread").pipe(
    Flag.withDescription("Open an existing thread id immediately on startup."),
    Flag.optional,
  ),
  provider: Flag.String("provider").pipe(
    Flag.withDescription("Initial provider instance id (e.g. claude, codex, opencode, pi, fx)."),
    Flag.optional,
  ),
  model: Flag.String("model").pipe(Flag.withDescription("Initial model slug."), Flag.optional),
  theme: Flag.String("theme").pipe(
    Flag.withDescription(
      "Theme id for this session (e.g. tokyo-night, catppuccin-mocha, gruvbox-dark, nord, zerocode-dark, ansi).",
    ),
    Flag.optional,
  ),
  colorMode: Flag.Literals("color-mode", ["auto", "truecolor", "256", "16", "none"]).pipe(
    Flag.withDescription("ANSI color depth (auto, truecolor, 256, 16, none)."),
    Flag.optional,
  ),
  noColor: Flag.Boolean("no-color").pipe(
    Flag.withDescription("Disable ANSI colors (same as --color-mode none or NO_COLOR=1)."),
    Flag.withDefault(false),
  ),
  url: Flag.String("url").pipe(
    Flag.withDescription("Connect to a remote ZeroCode server URL instead of the local server."),
    Flag.optional,
  ),
  token: Flag.String("token").pipe(
    Flag.withDescription("Bearer access token for --url (defaults to ZEROCODE_TOKEN)."),
    Flag.optional,
  ),
  noAutostart: Flag.Boolean("no-autostart").pipe(
    Flag.withDescription("Fail instead of starting a local ZeroCode server when none is running."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withShortDescription("Launch the interactive terminal UI (TUI) for ZeroCode."),
  Command.withDescription(
    "Start ZeroCode's interactive terminal UI with live streaming, tool output, inline approvals, slash commands, and customizable themes/colors. Works standalone or inside Neovim :term / tmux.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        yield* Console.error(
          "zerocode cli requires an interactive TTY. For non-interactive scripts, use `zerocode thread start` / `zerocode thread send --wait`.",
        );
        return;
      }

      const path = yield* Path.Path;
      const logLevel = yield* GlobalFlag.LogLevel;
      const serverConfig = yield* resolveCliAuthConfig({ baseDir: flags.baseDir }, logLevel, {
        quietLogs: true,
      });

      const targetWorkspacePath = Option.isNone(flags.project)
        ? path.resolve(process.cwd())
        : path.resolve(yield* expandHomePath(flags.project.value));

      const tuiConfigPath = path.join(serverConfig.stateDir, TUI_CONFIG_FILENAME);
      const savedConfig = yield* loadTuiConfig(tuiConfigPath);
      const customThemes = yield* loadCustomZeroCodeThemes(
        path.join(serverConfig.stateDir, "themes"),
      );
      const allThemes = [...BUILT_IN_TUI_THEMES, ...customThemes];

      const effectiveColorMode: TuiColorMode = flags.noColor
        ? "none"
        : Option.getOrElse(flags.colorMode, () => savedConfig.colorMode);
      const effectiveConfig = {
        ...savedConfig,
        colorMode: effectiveColorMode,
        ...(Option.isSome(flags.theme) ? { theme: flags.theme.value } : {}),
      };

      const connection = yield* connectTuiServer({
        serverConfig,
        remoteUrl: flags.url,
        remoteToken: flags.token,
        autoStartLocal: !flags.noAutostart,
      });

      const initialConfig = yield* connection.getInitialConfig().pipe(
        Effect.mapError(
          (cause) =>
            new TuiConnectionError({
              stage: "websocket",
              origin: connection.origin,
              detail: "Connected to server, but failed to fetch initial server config.",
              cause,
            }),
        ),
      );

      yield* runInteractiveTui({
        connection,
        initialConfig,
        targetWorkspacePath,
        explicitProjectArg: Option.getOrNull(flags.project),
        initialThreadId: Option.getOrNull(flags.thread),
        explicitProvider: Option.getOrNull(flags.provider),
        explicitModel: Option.getOrNull(flags.model),
        tuiConfigPath,
        initialTuiConfig: effectiveConfig,
        themes: allThemes,
      });
    }).pipe(
      Effect.scoped,
      Effect.provideService(References.MinimumLogLevel, "Error"),
      Effect.catchTags({
        TuiConnectionError: (error) => Console.error(error.message),
      }),
    ),
  ),
);
