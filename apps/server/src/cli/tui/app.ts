import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ProviderApprovalDecision,
  type ServerConfig,
  type ServerProvider,
} from "@zerocode/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import packageJson from "../../../package.json" with { type: "json" };
import {
  applyTextDeltaToProjection,
  applyThreadEventToProjection,
  forkShellSubscription,
  type TuiLiveConnection,
} from "./client.ts";
import { TerminalInputParser, type KeyEvent } from "./input.ts";
import {
  filterModels,
  filterProjects,
  filterSlashCommands,
  filterThemes,
  filterThreads,
  renderTuiFrame,
  type LocalNotice,
  type ModelChoice,
  type PendingInteraction,
  type TuiViewState,
} from "./renderer.ts";
import { ScreenBuffer, createStdioTerminal, type TerminalController } from "./terminal.ts";
import {
  TUI_BORDER_STYLES,
  TUI_COLOR_MODES,
  TUI_COLOR_ROLES,
  TUI_TOOL_DISPLAY_MODES,
  isTuiColorRole,
  parseColorSpec,
  resolveTuiTheme,
  saveTuiConfig,
  type TuiBorderStyle,
  type TuiColorMode,
  type TuiConfig,
  type TuiThemeDefinition,
  type TuiToolDisplayMode,
} from "./themes.ts";

export interface TuiAppOptions {
  readonly connection: TuiLiveConnection;
  readonly initialConfig: ServerConfig;
  readonly targetWorkspacePath: string;
  readonly explicitProjectArg: string | null;
  readonly initialThreadId: string | null;
  readonly explicitProvider: string | null;
  readonly explicitModel: string | null;
  readonly tuiConfigPath: string;
  readonly initialTuiConfig: TuiConfig;
  readonly themes: ReadonlyArray<TuiThemeDefinition>;
  readonly terminal?: TerminalController;
}

type TuiEvent =
  | { readonly kind: "raw-input"; readonly chunk: Buffer | string }
  | { readonly kind: "esc-flush" }
  | { readonly kind: "resize" }
  | { readonly kind: "tick" }
  | { readonly kind: "quit" }
  | {
      readonly kind: "shell-snapshot";
      readonly projects: ReadonlyArray<OrchestrationProjectShell>;
      readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
    }
  | { readonly kind: "project-updated"; readonly project: OrchestrationProjectShell }
  | { readonly kind: "project-removed"; readonly projectId: string }
  | { readonly kind: "thread-updated"; readonly thread: OrchestrationV2ThreadShell }
  | { readonly kind: "thread-removed"; readonly threadId: string }
  | { readonly kind: "disconnected"; readonly reason: string }
  | {
      readonly kind: "thread-projection";
      readonly threadId: string;
      readonly projection: OrchestrationV2ThreadProjection;
    }
  | {
      readonly kind: "thread-launched";
      readonly threadId: string;
      readonly projection: OrchestrationV2ThreadProjection;
    }
  | { readonly kind: "diff-loaded"; readonly title: string; readonly text: string }
  | {
      readonly kind: "notice";
      readonly level: LocalNotice["level"];
      readonly title: string | undefined;
      readonly body: string;
      readonly markdown?: boolean;
    }
  | { readonly kind: "status"; readonly message: string | null };

function buildModelChoices(providers: ReadonlyArray<ServerProvider>): Array<ModelChoice> {
  const choices: Array<ModelChoice> = [];
  for (const provider of providers) {
    if (provider.status === "disabled") continue;
    const label = provider.displayName ?? provider.instanceId;
    for (const model of provider.models) {
      choices.push({
        providerInstanceId: provider.instanceId,
        providerLabel: label,
        driver: provider.driver,
        modelSlug: model.slug,
        modelName: model.name,
        providerState: provider.status,
      });
    }
  }
  return choices;
}

function makeModelSelection(instanceId: string, model: string): ModelSelection {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    model,
  };
}

function pickInitialModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  project: OrchestrationProjectShell | null,
  explicitProvider: string | null,
  explicitModel: string | null,
): ModelSelection | null {
  const ready = providers.filter((p) => p.status === "ready" && p.models.length > 0);
  const nonDisabled = providers.filter((p) => p.status !== "disabled" && p.models.length > 0);
  const pool = ready.length > 0 ? ready : nonDisabled;

  if (explicitProvider && explicitModel) {
    return makeModelSelection(explicitProvider, explicitModel);
  }
  if (explicitModel) {
    for (const provider of pool) {
      const hit = provider.models.find(
        (m) => m.slug === explicitModel || m.aliases?.includes(explicitModel),
      );
      if (hit) {
        return makeModelSelection(provider.instanceId, hit.slug);
      }
    }
  }
  if (project?.defaultModelSelection) {
    return project.defaultModelSelection;
  }
  const first = pool[0];
  if (!first) return null;
  const preferred = first.models.find((m) => m.isDefault) ?? first.models[0];
  return preferred ? makeModelSelection(first.instanceId, preferred.slug) : null;
}

function extractPendingInteraction(
  projection: OrchestrationV2ThreadProjection | null,
): PendingInteraction | null {
  if (!projection) return null;
  const pendingReq = [...projection.runtimeRequests]
    .reverse()
    .find((req) => req.status === "pending");
  if (!pendingReq) return null;

  for (let i = projection.visibleTurnItems.length - 1; i >= 0; i--) {
    const item = projection.visibleTurnItems[i]!.item;
    if (item.type === "approval_request" && item.requestId === pendingReq.id) {
      const options: Array<{
        readonly decision: ProviderApprovalDecision;
        readonly label: string;
      }> =
        item.options && item.options.length > 0
          ? item.options.map((opt) => ({ decision: opt.decision, label: opt.label }))
          : [
              { decision: "accept", label: "Allow once" },
              { decision: "acceptForSession", label: "Allow session" },
              { decision: "decline", label: "Decline" },
            ];
      return {
        kind: "approval",
        request: pendingReq,
        prompt: item.prompt ?? `Approve ${item.requestKind} request?`,
        reason: item.reason,
        options,
        selectedIndex: 0,
      };
    }
    if (item.type === "user_input_request" && item.requestId === pendingReq.id) {
      return {
        kind: "user_input",
        request: pendingReq,
        questions: item.questions.map((q) => ({
          id: q.id,
          header: q.header,
          question: q.question,
          options: q.options?.map((o) => ({ label: o.label, description: o.description })),
        })),
        questionIndex: 0,
        selectedOptionIndex: 0,
        answers: {},
        draftText: "",
      };
    }
  }
  return null;
}

function isProjectionRunning(projection: OrchestrationV2ThreadProjection | null): boolean {
  if (!projection) return false;
  return projection.runs.some(
    (run) =>
      run.status === "running" ||
      run.status === "starting" ||
      run.status === "preparing" ||
      run.status === "queued",
  );
}

function activeRunIdOf(projection: OrchestrationV2ThreadProjection | null): string | null {
  if (!projection) return null;
  const active = [...projection.runs]
    .reverse()
    .find(
      (run) => run.status === "running" || run.status === "starting" || run.status === "preparing",
    );
  return active?.id ?? null;
}

function matchProjectForTarget(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  explicitArg: string | null,
  resolvedPath: string,
): OrchestrationProjectShell | null {
  if (explicitArg) {
    const byId = projects.find((p) => p.id === explicitArg || p.title === explicitArg);
    if (byId) return byId;
  }
  const normalizedTarget = resolvedPath.replace(/\/+$/, "");
  let best: OrchestrationProjectShell | null = null;
  for (const project of projects) {
    const root = project.workspaceRoot.replace(/\/+$/, "");
    if (normalizedTarget === root || normalizedTarget.startsWith(`${root}/`)) {
      if (!best || root.length > best.workspaceRoot.length) {
        best = project;
      }
    }
  }
  return best ?? projects[0] ?? null;
}

function titleFromPrompt(text: string): string {
  const firstLine = text.trim().split("\n")[0]?.trim() ?? "New thread";
  return firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine || "New thread";
}

function clockHhMm(ms: number): string {
  const parts = DateTime.toPartsUtc(DateTime.makeUnsafe(ms));
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

/** Runs the full-screen interactive ZeroCode CLI session until the user exits. */
export const runInteractiveTui = Effect.fn("cli.tui.run")(function* (options: TuiAppOptions) {
  const path = yield* Path.Path;
  const scope = yield* Scope.Scope;
  const terminal = options.terminal ?? createStdioTerminal();
  const screen = new ScreenBuffer();
  const inputParser = new TerminalInputParser();
  const queue = yield* Queue.unbounded<TuiEvent>();

  let noticeSeq = 0;
  let lastCtrlCAt = 0;
  const inputHistory: Array<string> = [];
  let historyIndex = -1;
  let historyDraft = "";
  let threadSubFiber: Fiber.Fiber<void, never> | null = null;
  let spinnerFiber: Fiber.Fiber<void, never> | null = null;
  let escFlushFiber: Fiber.Fiber<void, never> | null = null;
  let bootstrappedProject = false;
  let disposed = false;

  const modelChoices = buildModelChoices(options.initialConfig.providers);
  const initialNowMs = yield* Clock.currentTimeMillis;

  let state: TuiViewState = {
    version: packageJson.version,
    connectionLabel: options.connection.origin,
    connected: true,
    reconnecting: false,
    configPath: options.tuiConfigPath,
    config: options.initialTuiConfig,
    themes: options.themes,
    theme: resolveTuiTheme(options.themes, options.initialTuiConfig),
    projects: [],
    activeProject: null,
    threads: [],
    activeThreadId: options.initialThreadId,
    activeProjection: null,
    providers: options.initialConfig.providers,
    modelChoices,
    activeModelSelection: pickInitialModelSelection(
      options.initialConfig.providers,
      null,
      options.explicitProvider,
      options.explicitModel,
    ),
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    isRunning: false,
    spinnerFrame: 0,
    scrollOffset: 0,
    notices: [],
    inputText: "",
    inputCursor: 0,
    slashSelectedIndex: 0,
    overlay: { kind: "none" },
    pendingInteraction: null,
    statusMessage: options.connection.startedEmbeddedServer
      ? "Started local ZeroCode server"
      : `Connected to ${options.connection.origin}`,
    nowMs: initialNowMs,
  };

  const offer = (event: TuiEvent) => {
    Queue.offerUnsafe(queue, event);
  };

  const renderNow = Effect.fnUntraced(function* () {
    if (disposed) return;
    const nowMs = yield* Clock.currentTimeMillis;
    state = { ...state, nowMs };
    const { rows, cols } = terminal.size();
    const frame = renderTuiFrame(state, rows, cols);
    terminal.write(screen.diff(frame, rows, cols));
  });

  const forkAction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          offer({
            kind: "notice",
            level: "error",
            title: "Command failed",
            body: error instanceof Error ? error.message : String(error),
          });
        }),
      ),
      Effect.asVoid,
      Effect.forkIn(scope),
    );

  const syncSpinner = Effect.fnUntraced(function* () {
    if (state.isRunning && spinnerFiber === null) {
      spinnerFiber = yield* Effect.forever(
        Effect.sleep(Duration.millis(90)).pipe(
          Effect.andThen(Effect.sync(() => offer({ kind: "tick" }))),
        ),
      ).pipe(Effect.forkIn(scope));
    } else if (!state.isRunning && spinnerFiber !== null) {
      const current = spinnerFiber;
      spinnerFiber = null;
      yield* Fiber.interrupt(current);
    }
  });

  const pushNotice = (
    level: LocalNotice["level"],
    title: string | undefined,
    body: string,
    nowMs: number,
    markdown = false,
  ) => {
    state = {
      ...state,
      notices: [
        ...state.notices.slice(-24),
        { id: ++noticeSeq, level, title, body, markdown, timestamp: clockHhMm(nowMs) },
      ],
      scrollOffset: 0,
    };
  };

  const applyPreviewTheme = (themeId: string) => {
    const previewConfig: TuiConfig = { ...state.config, theme: themeId };
    state = {
      ...state,
      theme: resolveTuiTheme(state.themes, previewConfig),
    };
  };

  const persistConfig = Effect.fnUntraced(function* (nextConfig: TuiConfig, status?: string) {
    const nextTheme = resolveTuiTheme(state.themes, nextConfig);
    terminal.setMouse(nextConfig.mouse);
    state = {
      ...state,
      config: nextConfig,
      theme: nextTheme,
      ...(status !== undefined ? { statusMessage: status } : {}),
    };
    screen.reset();
    yield* forkAction(saveTuiConfig(options.tuiConfigPath, nextConfig));
  });

  const updateProjection = Effect.fnUntraced(function* (
    projection: OrchestrationV2ThreadProjection,
  ) {
    const running = isProjectionRunning(projection);
    const pending = extractPendingInteraction(projection);
    state = {
      ...state,
      activeProjection: projection,
      activeModelSelection: projection.thread.modelSelection,
      runtimeMode: projection.thread.runtimeMode,
      interactionMode: projection.thread.interactionMode,
      isRunning: running,
      pendingInteraction: pending,
    };
    yield* syncSpinner();
  });

  const subscribeToThread = Effect.fnUntraced(function* (threadId: string) {
    if (threadSubFiber !== null) {
      const prev = threadSubFiber;
      threadSubFiber = null;
      yield* Fiber.interrupt(prev);
    }
    state = {
      ...state,
      activeThreadId: threadId,
      activeProjection: null,
      pendingInteraction: null,
      scrollOffset: 0,
      notices: [],
    };
    let latestProjection: OrchestrationV2ThreadProjection | null = null;
    threadSubFiber = yield* options.connection.client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
      threadId: ThreadId.make(threadId),
    }).pipe(
      Stream.runForEach((item) =>
        Effect.sync(() => {
          if (item.kind === "snapshot") {
            latestProjection = item.projection;
            offer({ kind: "thread-projection", threadId, projection: item.projection });
          } else if (item.kind === "event" && latestProjection !== null) {
            latestProjection = applyThreadEventToProjection(latestProjection, item.event);
            offer({ kind: "thread-projection", threadId, projection: latestProjection });
          } else if (item.kind === "text-delta" && latestProjection !== null) {
            latestProjection = applyTextDeltaToProjection(latestProjection, item);
            offer({ kind: "thread-projection", threadId, projection: latestProjection });
          }
        }),
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          offer({
            kind: "notice",
            level: "error",
            title: "Thread stream interrupted",
            body: error instanceof Error ? error.message : String(error),
          });
        }),
      ),
      Effect.forkIn(scope),
    );
  });

  const applyModelChoice = Effect.fnUntraced(function* (choice: ModelChoice) {
    const selection = makeModelSelection(choice.providerInstanceId, choice.modelSlug);
    state = {
      ...state,
      activeModelSelection: selection,
      overlay: { kind: "none" },
      statusMessage: `Model: ${choice.providerLabel} / ${choice.modelName}`,
    };
    if (state.activeThreadId) {
      yield* forkAction(
        options.connection.setModelSelection(ThreadId.make(state.activeThreadId), selection),
      );
    }
  });

  const interruptActiveRun = Effect.fnUntraced(function* () {
    if (!state.activeThreadId) return;
    const threadId = ThreadId.make(state.activeThreadId);
    const runId = activeRunIdOf(state.activeProjection);
    state = { ...state, statusMessage: "Stopping run…" };
    yield* forkAction(
      runId
        ? options.connection.interruptRun(threadId, runId)
        : options.connection.stopThread(threadId),
    );
  });

  const handleSlashCommand = Effect.fnUntraced(function* (raw: string, nowMs: number) {
    const parts = raw.trim().split(/\s+/);
    const cmd = (parts[0] ?? "").toLowerCase();
    const args = parts.slice(1);
    const rest = raw.trim().slice(cmd.length).trim();

    switch (cmd) {
      case "/quit":
      case "/exit":
      case "/q":
        disposed = true;
        return;

      case "/help":
      case "/?":
        state = { ...state, overlay: { kind: "help", scrollOffset: 0 } };
        return;

      case "/clear":
        state = { ...state, notices: [], scrollOffset: 0, statusMessage: "Cleared notices" };
        return;

      case "/new":
        if (threadSubFiber !== null) {
          const prev = threadSubFiber;
          threadSubFiber = null;
          yield* Fiber.interrupt(prev);
        }
        state = {
          ...state,
          activeThreadId: null,
          activeProjection: null,
          pendingInteraction: null,
          isRunning: false,
          scrollOffset: 0,
          notices: [],
          statusMessage: rest ? `New thread draft: ${rest}` : "Ready for a new thread",
        };
        yield* syncSpinner();
        return;

      case "/threads":
      case "/thread": {
        const target = args[0];
        if (target) {
          const found = state.threads.find((t) => t.id === target || t.id.startsWith(target));
          if (found) {
            yield* subscribeToThread(found.id);
            state = { ...state, statusMessage: `Switched to ${found.title}` };
            return;
          }
          pushNotice("error", "Thread not found", `No thread matching "${target}".`, nowMs);
          return;
        }
        state = {
          ...state,
          overlay: { kind: "threads", query: "", selectedIndex: 0, allProjects: false },
        };
        return;
      }

      case "/project":
      case "/projects":
        state = {
          ...state,
          overlay: { kind: "projects", query: rest, selectedIndex: 0 },
        };
        return;

      case "/model":
      case "/models": {
        if (rest) {
          const matches = filterModels(state.modelChoices, rest);
          const exact =
            matches.find((m) => m.modelSlug.toLowerCase() === rest.toLowerCase()) ?? matches[0];
          if (exact) {
            yield* applyModelChoice(exact);
            return;
          }
          pushNotice("error", "Model not found", `No model matching "${rest}".`, nowMs);
          return;
        }
        state = { ...state, overlay: { kind: "model", query: "", selectedIndex: 0 } };
        return;
      }

      case "/mode": {
        const requested = args[0];
        if (!requested) {
          pushNotice(
            "info",
            "Runtime permission mode",
            `Current: \`${state.runtimeMode}\`.\nAvailable: ${RuntimeMode.literals.map((m) => `\`${m}\``).join(", ")}.\nUsage: \`/mode auto\``,
            nowMs,
            true,
          );
          return;
        }
        if (!(RuntimeMode.literals as ReadonlyArray<string>).includes(requested)) {
          pushNotice(
            "error",
            "Invalid mode",
            `Use one of: ${RuntimeMode.literals.join(", ")}.`,
            nowMs,
          );
          return;
        }
        const nextMode = requested as RuntimeMode;
        state = { ...state, runtimeMode: nextMode, statusMessage: `Mode: ${nextMode}` };
        if (state.activeThreadId) {
          yield* forkAction(
            options.connection.setRuntimeMode(ThreadId.make(state.activeThreadId), nextMode),
          );
        }
        return;
      }

      case "/plan":
      case "/default": {
        const nextInteraction: ProviderInteractionMode = cmd === "/plan" ? "plan" : "default";
        state = {
          ...state,
          interactionMode: nextInteraction,
          statusMessage: `Interaction mode: ${nextInteraction}`,
        };
        if (state.activeThreadId) {
          yield* forkAction(
            options.connection.setInteractionMode(
              ThreadId.make(state.activeThreadId),
              nextInteraction,
            ),
          );
        }
        return;
      }

      case "/theme":
      case "/themes": {
        if (rest) {
          const hit = state.themes.find(
            (t) =>
              t.id.toLowerCase() === rest.toLowerCase() ||
              t.label.toLowerCase() === rest.toLowerCase(),
          );
          if (!hit) {
            pushNotice(
              "error",
              "Unknown theme",
              `No theme named "${rest}". Run \`/theme\` to browse ${state.themes.length} themes.`,
              nowMs,
              true,
            );
            return;
          }
          yield* persistConfig({ ...state.config, theme: hit.id }, `Theme: ${hit.label}`);
          return;
        }
        const currentIdx = Math.max(
          0,
          state.themes.findIndex((t) => t.id === state.config.theme),
        );
        state = {
          ...state,
          overlay: {
            kind: "theme",
            query: "",
            selectedIndex: currentIdx,
            previousThemeId: state.config.theme,
          },
        };
        return;
      }

      case "/colors":
        state = { ...state, overlay: { kind: "colors", scrollOffset: 0 } };
        return;

      case "/color": {
        const [roleArg, ...valueParts] = args;
        if (!roleArg) {
          state = { ...state, overlay: { kind: "colors", scrollOffset: 0 } };
          return;
        }
        if (roleArg.toLowerCase() === "reset") {
          yield* persistConfig({ ...state.config, colors: {} }, "Reset all custom color overrides");
          return;
        }
        if (!isTuiColorRole(roleArg)) {
          pushNotice(
            "error",
            "Unknown color role",
            `Unknown role \`${roleArg}\`.\nRoles: ${TUI_COLOR_ROLES.join(", ")}`,
            nowMs,
            true,
          );
          return;
        }
        const value = valueParts.join(" ").trim();
        if (!value) {
          pushNotice(
            "info",
            `Color role: ${roleArg}`,
            `Current value: \`${state.theme.palette[roleArg]}\`\nSet with: \`/color ${roleArg} #7aa2f7\` or \`/color ${roleArg} reset\``,
            nowMs,
            true,
          );
          return;
        }
        if (value.toLowerCase() === "reset" || value.toLowerCase() === "clear") {
          const nextColors = { ...state.config.colors };
          delete nextColors[roleArg];
          yield* persistConfig({ ...state.config, colors: nextColors }, `Reset color: ${roleArg}`);
          return;
        }
        if (parseColorSpec(value) === null) {
          pushNotice(
            "error",
            "Invalid color value",
            `Could not parse "${value}". Use \`#rrggbb\`, \`oklch(0.7 0.15 250)\`, \`rgb(r,g,b)\`, ANSI color name (\`cyan\`, \`magenta\`, ...), or \`default\`.`,
            nowMs,
            true,
          );
          return;
        }
        yield* persistConfig(
          { ...state.config, colors: { ...state.config.colors, [roleArg]: value } },
          `Color ${roleArg} = ${value}`,
        );
        return;
      }

      case "/border": {
        const style = args[0]?.toLowerCase();
        if (!style || !(TUI_BORDER_STYLES as ReadonlyArray<string>).includes(style)) {
          pushNotice(
            "info",
            "Border style",
            `Current: \`${state.config.borderStyle}\`. Options: ${TUI_BORDER_STYLES.map((s) => `\`${s}\``).join(", ")}.`,
            nowMs,
            true,
          );
          return;
        }
        yield* persistConfig(
          { ...state.config, borderStyle: style as TuiBorderStyle },
          `Border style: ${style}`,
        );
        return;
      }

      case "/colormode": {
        const mode = args[0]?.toLowerCase();
        if (!mode || !(TUI_COLOR_MODES as ReadonlyArray<string>).includes(mode)) {
          pushNotice(
            "info",
            "Color depth",
            `Current: \`${state.config.colorMode}\` (resolved: \`${state.theme.depth}\`). Options: ${TUI_COLOR_MODES.map((m) => `\`${m}\``).join(", ")}.`,
            nowMs,
            true,
          );
          return;
        }
        yield* persistConfig(
          { ...state.config, colorMode: mode as TuiColorMode },
          `Color mode: ${mode}`,
        );
        return;
      }

      case "/thinking": {
        const next = !state.config.showThinking;
        yield* persistConfig(
          { ...state.config, showThinking: next },
          `Thinking blocks: ${next ? "shown" : "hidden"}`,
        );
        return;
      }

      case "/tools": {
        const arg = args[0]?.toLowerCase();
        const next: TuiToolDisplayMode =
          arg && (TUI_TOOL_DISPLAY_MODES as ReadonlyArray<string>).includes(arg)
            ? (arg as TuiToolDisplayMode)
            : TUI_TOOL_DISPLAY_MODES[
                (TUI_TOOL_DISPLAY_MODES.indexOf(state.config.showTools) + 1) %
                  TUI_TOOL_DISPLAY_MODES.length
              ]!;
        yield* persistConfig({ ...state.config, showTools: next }, `Tool output: ${next}`);
        return;
      }

      case "/timestamps": {
        const next = !state.config.showTimestamps;
        yield* persistConfig(
          { ...state.config, showTimestamps: next },
          `Timestamps: ${next ? "on" : "off"}`,
        );
        return;
      }

      case "/mouse": {
        const next = !state.config.mouse;
        yield* persistConfig(
          { ...state.config, mouse: next },
          `Mouse wheel scroll: ${next ? "on" : "off (native copy)"}`,
        );
        return;
      }

      case "/diff": {
        if (!state.activeThreadId) {
          pushNotice(
            "warning",
            "No active thread",
            "Open or start a thread before viewing its diff.",
            nowMs,
          );
          return;
        }
        const threadId = ThreadId.make(state.activeThreadId);
        const turnCount = state.activeProjection?.checkpoints.length ?? 0;
        const diffTitle = `Thread Diff (${state.activeProjection?.thread.title ?? threadId})`;
        state = { ...state, statusMessage: "Loading diff…" };
        yield* forkAction(
          options.connection.getFullThreadDiff(threadId, Math.max(1, turnCount)).pipe(
            Effect.tap((diffText) =>
              Effect.sync(() => {
                offer({ kind: "diff-loaded", title: diffTitle, text: diffText });
              }),
            ),
          ),
        );
        return;
      }

      case "/stop":
        yield* interruptActiveRun();
        return;

      case "/config": {
        const customColors = Object.entries(state.config.colors);
        const lines = [
          `- **Config file**: \`${state.configPath}\``,
          `- **Server**: \`${state.connectionLabel}\``,
          `- **Theme**: \`${state.config.theme}\` (${state.theme.label})`,
          `- **Color depth**: \`${state.config.colorMode}\` (resolved: \`${state.theme.depth}\`)`,
          `- **Border style**: \`${state.config.borderStyle}\``,
          `- **Thinking**: \`${state.config.showThinking}\` · **Tools**: \`${state.config.showTools}\` · **Timestamps**: \`${state.config.showTimestamps}\` · **Mouse**: \`${state.config.mouse}\``,
          customColors.length > 0
            ? `- **Color overrides**: ${customColors.map(([k, v]) => `\`${k}=${v}\``).join(", ")}`
            : `- **Color overrides**: none (use \`/color <role> <#hex>\`)`,
        ];
        pushNotice("info", "ZeroCode CLI Configuration", lines.join("\n"), nowMs, true);
        return;
      }

      default:
        pushNotice(
          "warning",
          "Unknown command",
          `Unknown command \`${cmd}\`. Run \`/help\` to see available slash commands.`,
          nowMs,
          true,
        );
    }
  });

  const submitPrompt = Effect.fnUntraced(function* (text: string, nowMs: number) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (inputHistory[inputHistory.length - 1] !== trimmed) {
      inputHistory.push(trimmed);
    }
    historyIndex = -1;
    historyDraft = "";
    state = { ...state, inputText: "", inputCursor: 0, slashSelectedIndex: 0, scrollOffset: 0 };

    if (trimmed.startsWith("/")) {
      yield* handleSlashCommand(trimmed, nowMs);
      return;
    }

    const activeProject = state.activeProject;
    if (!activeProject) {
      pushNotice(
        "warning",
        "No project selected",
        "Use `/project` to choose a project first.",
        nowMs,
      );
      return;
    }
    const modelSelection = state.activeModelSelection;
    if (!modelSelection) {
      pushNotice(
        "warning",
        "No ready provider",
        "No provider with models is ready. Press Ctrl+M to inspect providers or sign into a provider first.",
        nowMs,
      );
      return;
    }

    if (state.activeThreadId === null) {
      state = { ...state, statusMessage: "Launching thread…" };
      yield* forkAction(
        options.connection
          .launchThread({
            projectId: activeProject.id,
            title: titleFromPrompt(trimmed),
            message: trimmed,
            modelSelection,
            runtimeMode: state.runtimeMode,
            interactionMode: state.interactionMode,
          })
          .pipe(
            Effect.tap(({ threadId, projection }) =>
              Effect.sync(() => {
                offer({ kind: "thread-launched", threadId, projection });
              }),
            ),
          ),
      );
    } else {
      const threadId = ThreadId.make(state.activeThreadId);
      const runId = activeRunIdOf(state.activeProjection);
      state = { ...state, statusMessage: runId ? "Queued follow-up message" : "Sending…" };
      yield* forkAction(
        options.connection
          .sendMessage({
            threadId,
            text: trimmed,
            modelSelection,
            activeRunId: runId,
          })
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                offer({ kind: "status", message: null });
              }),
            ),
          ),
      );
    }
  });

  const handlePendingInteractionKey = Effect.fnUntraced(function* (key: KeyEvent) {
    const pending = state.pendingInteraction;
    if (!pending) return false;
    const threadId = state.activeThreadId ? ThreadId.make(state.activeThreadId) : null;
    if (!threadId) return false;

    if (pending.kind === "approval") {
      if (key.name === "left" || key.name === "up") {
        const next = (pending.selectedIndex - 1 + pending.options.length) % pending.options.length;
        state = { ...state, pendingInteraction: { ...pending, selectedIndex: next } };
        return true;
      }
      if (key.name === "right" || key.name === "down" || key.name === "tab") {
        const next = (pending.selectedIndex + 1) % pending.options.length;
        state = { ...state, pendingInteraction: { ...pending, selectedIndex: next } };
        return true;
      }
      if (key.name === "char" && !key.ctrl && !key.alt) {
        const num = Number.parseInt(key.text, 10);
        if (num >= 1 && num <= pending.options.length) {
          const chosen = pending.options[num - 1]!;
          state = {
            ...state,
            pendingInteraction: null,
            statusMessage: `Approval: ${chosen.label}`,
          };
          yield* forkAction(
            options.connection.respondApproval(threadId, pending.request.id, chosen.decision),
          );
          return true;
        }
        const ch = key.text.toLowerCase();
        if (ch === "y") {
          state = { ...state, pendingInteraction: null, statusMessage: "Approved" };
          yield* forkAction(
            options.connection.respondApproval(threadId, pending.request.id, "accept"),
          );
          return true;
        }
        if (ch === "n") {
          state = { ...state, pendingInteraction: null, statusMessage: "Declined" };
          yield* forkAction(
            options.connection.respondApproval(threadId, pending.request.id, "decline"),
          );
          return true;
        }
      }
      if (key.name === "enter") {
        const chosen = pending.options[pending.selectedIndex] ?? pending.options[0];
        if (chosen) {
          state = {
            ...state,
            pendingInteraction: null,
            statusMessage: `Approval: ${chosen.label}`,
          };
          yield* forkAction(
            options.connection.respondApproval(threadId, pending.request.id, chosen.decision),
          );
        }
        return true;
      }
      if (key.name === "escape") {
        state = { ...state, pendingInteraction: null, statusMessage: "Declined" };
        yield* forkAction(
          options.connection.respondApproval(threadId, pending.request.id, "decline"),
        );
        return true;
      }
      return true;
    }

    const currentQ = pending.questions[pending.questionIndex];
    if (!currentQ) return false;
    const hasOptions = (currentQ.options?.length ?? 0) > 0;
    if (key.name === "escape") {
      state = { ...state, pendingInteraction: null, statusMessage: "Dismissed question" };
      return true;
    }
    if (hasOptions) {
      const count = currentQ.options!.length;
      if (key.name === "up") {
        state = {
          ...state,
          pendingInteraction: {
            ...pending,
            selectedOptionIndex: (pending.selectedOptionIndex - 1 + count) % count,
          },
        };
        return true;
      }
      if (key.name === "down" || key.name === "tab") {
        state = {
          ...state,
          pendingInteraction: {
            ...pending,
            selectedOptionIndex: (pending.selectedOptionIndex + 1) % count,
          },
        };
        return true;
      }
    } else {
      if (key.name === "backspace") {
        state = {
          ...state,
          pendingInteraction: { ...pending, draftText: pending.draftText.slice(0, -1) },
        };
        return true;
      }
      if (key.name === "char" && !key.ctrl && !key.alt) {
        state = {
          ...state,
          pendingInteraction: { ...pending, draftText: pending.draftText + key.text },
        };
        return true;
      }
    }
    if (key.name === "enter") {
      const answerValue = hasOptions
        ? (currentQ.options![pending.selectedOptionIndex]?.label ?? "")
        : pending.draftText.trim();
      const nextAnswers = { ...pending.answers, [currentQ.id]: answerValue };
      if (pending.questionIndex + 1 < pending.questions.length) {
        state = {
          ...state,
          pendingInteraction: {
            ...pending,
            answers: nextAnswers,
            questionIndex: pending.questionIndex + 1,
            selectedOptionIndex: 0,
            draftText: "",
          },
        };
      } else {
        state = { ...state, pendingInteraction: null, statusMessage: "Submitted answer" };
        yield* forkAction(
          options.connection.respondUserInput(threadId, pending.request.id, nextAnswers),
        );
      }
      return true;
    }
    return true;
  });

  const handleOverlayKey = Effect.fnUntraced(function* (key: KeyEvent) {
    const overlay = state.overlay;
    if (overlay.kind === "none") return false;

    if (key.name === "escape") {
      if (overlay.kind === "theme") {
        applyPreviewTheme(overlay.previousThemeId);
      }
      state = { ...state, overlay: { kind: "none" } };
      return true;
    }

    if (overlay.kind === "help" || overlay.kind === "colors" || overlay.kind === "diff") {
      const step = key.name === "pageup" || key.name === "pagedown" ? 10 : 1;
      if (key.name === "up" || key.name === "pageup" || key.name === "mouse-wheel-up") {
        state = {
          ...state,
          overlay: { ...overlay, scrollOffset: Math.max(0, overlay.scrollOffset - step) },
        };
        return true;
      }
      if (key.name === "down" || key.name === "pagedown" || key.name === "mouse-wheel-down") {
        state = {
          ...state,
          overlay: { ...overlay, scrollOffset: overlay.scrollOffset + step },
        };
        return true;
      }
      if (key.name === "char" && key.text === "q") {
        state = { ...state, overlay: { kind: "none" } };
        return true;
      }
      return true;
    }

    if (overlay.kind === "theme") {
      const filtered = filterThemes(state.themes, overlay.query);
      if (key.name === "up" || key.name === "mouse-wheel-up") {
        const nextIdx =
          filtered.length === 0
            ? 0
            : (overlay.selectedIndex - 1 + filtered.length) % filtered.length;
        state = { ...state, overlay: { ...overlay, selectedIndex: nextIdx } };
        const candidate = filtered[nextIdx];
        if (candidate) applyPreviewTheme(candidate.id);
        return true;
      }
      if (key.name === "down" || key.name === "tab" || key.name === "mouse-wheel-down") {
        const nextIdx = filtered.length === 0 ? 0 : (overlay.selectedIndex + 1) % filtered.length;
        state = { ...state, overlay: { ...overlay, selectedIndex: nextIdx } };
        const candidate = filtered[nextIdx];
        if (candidate) applyPreviewTheme(candidate.id);
        return true;
      }
      if (key.name === "enter") {
        const chosen = filtered[overlay.selectedIndex];
        state = { ...state, overlay: { kind: "none" } };
        if (chosen) {
          yield* persistConfig(
            { ...state.config, theme: chosen.id },
            `Theme saved: ${chosen.label}`,
          );
        } else {
          applyPreviewTheme(overlay.previousThemeId);
        }
        return true;
      }
      if (key.name === "backspace") {
        const nextQuery = overlay.query.slice(0, -1);
        const nextFiltered = filterThemes(state.themes, nextQuery);
        state = { ...state, overlay: { ...overlay, query: nextQuery, selectedIndex: 0 } };
        if (nextFiltered[0]) applyPreviewTheme(nextFiltered[0].id);
        return true;
      }
      if (key.name === "char" && !key.ctrl && !key.alt) {
        const nextQuery = overlay.query + key.text;
        const nextFiltered = filterThemes(state.themes, nextQuery);
        state = { ...state, overlay: { ...overlay, query: nextQuery, selectedIndex: 0 } };
        if (nextFiltered[0]) applyPreviewTheme(nextFiltered[0].id);
        return true;
      }
      return true;
    }

    if (overlay.kind === "model") {
      const filtered = filterModels(state.modelChoices, overlay.query);
      if (key.name === "up" || key.name === "mouse-wheel-up") {
        const nextIdx =
          filtered.length === 0
            ? 0
            : (overlay.selectedIndex - 1 + filtered.length) % filtered.length;
        state = { ...state, overlay: { ...overlay, selectedIndex: nextIdx } };
        return true;
      }
      if (key.name === "down" || key.name === "tab" || key.name === "mouse-wheel-down") {
        const nextIdx = filtered.length === 0 ? 0 : (overlay.selectedIndex + 1) % filtered.length;
        state = { ...state, overlay: { ...overlay, selectedIndex: nextIdx } };
        return true;
      }
      if (key.name === "enter") {
        const chosen = filtered[overlay.selectedIndex];
        if (chosen) yield* applyModelChoice(chosen);
        else state = { ...state, overlay: { kind: "none" } };
        return true;
      }
      if (key.name === "backspace") {
        state = {
          ...state,
          overlay: { ...overlay, query: overlay.query.slice(0, -1), selectedIndex: 0 },
        };
        return true;
      }
      if (key.name === "char" && !key.ctrl && !key.alt) {
        state = {
          ...state,
          overlay: { ...overlay, query: overlay.query + key.text, selectedIndex: 0 },
        };
        return true;
      }
      return true;
    }

    if (overlay.kind === "threads") {
      const filtered = filterThreads(
        state.threads,
        state.activeProject?.id ?? null,
        overlay.allProjects,
        overlay.query,
      );
      if (key.name === "tab") {
        state = {
          ...state,
          overlay: { ...overlay, allProjects: !overlay.allProjects, selectedIndex: 0 },
        };
        return true;
      }
      if (key.name === "up" || key.name === "mouse-wheel-up") {
        const nextIdx =
          filtered.length === 0
            ? 0
            : (overlay.selectedIndex - 1 + filtered.length) % filtered.length;
        state = { ...state, overlay: { ...overlay, selectedIndex: nextIdx } };
        return true;
      }
      if (key.name === "down" || key.name === "mouse-wheel-down") {
        const nextIdx = filtered.length === 0 ? 0 : (overlay.selectedIndex + 1) % filtered.length;
        state = { ...state, overlay: { ...overlay, selectedIndex: nextIdx } };
        return true;
      }
      if (key.name === "enter") {
        const chosen = filtered[overlay.selectedIndex];
        state = { ...state, overlay: { kind: "none" } };
        if (chosen) {
          const owningProject = state.projects.find((p) => p.id === chosen.projectId);
          if (owningProject) state = { ...state, activeProject: owningProject };
          yield* subscribeToThread(chosen.id);
          state = { ...state, statusMessage: `Opened thread: ${chosen.title}` };
        }
        return true;
      }
      if (key.name === "backspace") {
        state = {
          ...state,
          overlay: { ...overlay, query: overlay.query.slice(0, -1), selectedIndex: 0 },
        };
        return true;
      }
      if (key.name === "char" && !key.ctrl && !key.alt) {
        state = {
          ...state,
          overlay: { ...overlay, query: overlay.query + key.text, selectedIndex: 0 },
        };
        return true;
      }
      return true;
    }

    if (overlay.kind === "projects") {
      const filtered = filterProjects(state.projects, overlay.query);
      if (key.name === "up" || key.name === "mouse-wheel-up") {
        const nextIdx =
          filtered.length === 0
            ? 0
            : (overlay.selectedIndex - 1 + filtered.length) % filtered.length;
        state = { ...state, overlay: { ...overlay, selectedIndex: nextIdx } };
        return true;
      }
      if (key.name === "down" || key.name === "tab" || key.name === "mouse-wheel-down") {
        const nextIdx = filtered.length === 0 ? 0 : (overlay.selectedIndex + 1) % filtered.length;
        state = { ...state, overlay: { ...overlay, selectedIndex: nextIdx } };
        return true;
      }
      if (key.name === "enter") {
        const chosen = filtered[overlay.selectedIndex];
        state = { ...state, overlay: { kind: "none" } };
        if (chosen) {
          const nextModel = pickInitialModelSelection(state.providers, chosen, null, null);
          state = {
            ...state,
            activeProject: chosen,
            activeThreadId: null,
            activeProjection: null,
            activeModelSelection: nextModel ?? state.activeModelSelection,
            scrollOffset: 0,
            statusMessage: `Project: ${chosen.title}`,
          };
        }
        return true;
      }
      if (key.name === "backspace") {
        state = {
          ...state,
          overlay: { ...overlay, query: overlay.query.slice(0, -1), selectedIndex: 0 },
        };
        return true;
      }
      if (key.name === "char" && !key.ctrl && !key.alt) {
        state = {
          ...state,
          overlay: { ...overlay, query: overlay.query + key.text, selectedIndex: 0 },
        };
        return true;
      }
      return true;
    }

    return false;
  });

  const insertComposerText = (text: string) => {
    const before = state.inputText.slice(0, state.inputCursor);
    const after = state.inputText.slice(state.inputCursor);
    state = {
      ...state,
      inputText: before + text + after,
      inputCursor: before.length + text.length,
      slashSelectedIndex: 0,
    };
  };

  const handleKey = Effect.fnUntraced(function* (key: KeyEvent, nowMs: number) {
    if (key.ctrl && key.name === "char" && key.text === "l") {
      screen.reset();
      return;
    }
    if (key.ctrl && key.name === "char" && key.text === "d") {
      if (state.overlay.kind === "none" && state.inputText.length === 0) {
        disposed = true;
        return;
      }
    }
    if (key.ctrl && key.name === "char" && key.text === "c") {
      if (state.overlay.kind !== "none") {
        if (state.overlay.kind === "theme") {
          applyPreviewTheme(state.overlay.previousThemeId);
        }
        state = { ...state, overlay: { kind: "none" } };
        return;
      }
      if (state.inputText.length > 0) {
        state = {
          ...state,
          inputText: "",
          inputCursor: 0,
          slashSelectedIndex: 0,
          statusMessage: "Cleared input (press Ctrl+C again to exit)",
        };
        lastCtrlCAt = nowMs;
        return;
      }
      if (state.isRunning && nowMs - lastCtrlCAt > 1200) {
        lastCtrlCAt = nowMs;
        yield* interruptActiveRun();
        return;
      }
      if (nowMs - lastCtrlCAt <= 1500) {
        disposed = true;
        return;
      }
      lastCtrlCAt = nowMs;
      state = { ...state, statusMessage: "Press Ctrl+C again (or Ctrl+D / /quit) to exit" };
      return;
    }

    if (yield* handleOverlayKey(key)) return;
    if (state.pendingInteraction !== null && (yield* handlePendingInteractionKey(key))) return;

    if (key.ctrl && key.name === "char") {
      switch (key.text) {
        case "k": {
          const currentIdx = Math.max(
            0,
            state.themes.findIndex((t) => t.id === state.config.theme),
          );
          state = {
            ...state,
            overlay: {
              kind: "theme",
              query: "",
              selectedIndex: currentIdx,
              previousThemeId: state.config.theme,
            },
          };
          return;
        }
        case "m":
          state = { ...state, overlay: { kind: "model", query: "", selectedIndex: 0 } };
          return;
        case "g":
          state = {
            ...state,
            overlay: { kind: "threads", query: "", selectedIndex: 0, allProjects: false },
          };
          return;
        case "p":
          state = { ...state, overlay: { kind: "projects", query: "", selectedIndex: 0 } };
          return;
        case "n":
          yield* handleSlashCommand("/new", nowMs);
          return;
        case "t":
          yield* handleSlashCommand("/thinking", nowMs);
          return;
        case "o":
          yield* handleSlashCommand("/tools", nowMs);
          return;
        case "a":
          state = { ...state, inputCursor: 0 };
          return;
        case "e":
          state = { ...state, inputCursor: state.inputText.length };
          return;
        case "u":
          state = {
            ...state,
            inputText: state.inputText.slice(state.inputCursor),
            inputCursor: 0,
            slashSelectedIndex: 0,
          };
          return;
        case "w": {
          const before = state.inputText.slice(0, state.inputCursor);
          const trimmed = before.replace(/\S+\s*$/, "");
          state = {
            ...state,
            inputText: trimmed + state.inputText.slice(state.inputCursor),
            inputCursor: trimmed.length,
          };
          return;
        }
        default:
          break;
      }
    }

    if (
      key.name === "pageup" ||
      key.name === "mouse-wheel-up" ||
      ((key.alt || key.shift) && key.name === "up")
    ) {
      const step = key.name === "pageup" ? 10 : 3;
      state = { ...state, scrollOffset: state.scrollOffset + step };
      return;
    }
    if (
      key.name === "pagedown" ||
      key.name === "mouse-wheel-down" ||
      ((key.alt || key.shift) && key.name === "down")
    ) {
      const step = key.name === "pagedown" ? 10 : 3;
      state = { ...state, scrollOffset: Math.max(0, state.scrollOffset - step) };
      return;
    }
    if (key.name === "escape") {
      if (state.isRunning) {
        yield* interruptActiveRun();
      } else if (state.scrollOffset > 0) {
        state = { ...state, scrollOffset: 0 };
      }
      return;
    }

    const slashMatches = filterSlashCommands(state.inputText);
    if (slashMatches.length > 0) {
      if (key.name === "up") {
        const next = (state.slashSelectedIndex - 1 + slashMatches.length) % slashMatches.length;
        state = { ...state, slashSelectedIndex: next };
        return;
      }
      if (key.name === "down") {
        const next = (state.slashSelectedIndex + 1) % slashMatches.length;
        state = { ...state, slashSelectedIndex: next };
        return;
      }
      if (key.name === "tab") {
        const selected = slashMatches[state.slashSelectedIndex] ?? slashMatches[0]!;
        const completed = selected.args ? `${selected.name} ` : selected.name;
        state = {
          ...state,
          inputText: completed,
          inputCursor: completed.length,
          slashSelectedIndex: 0,
        };
        return;
      }
      if (key.name === "enter" && !key.shift && !key.alt && !key.ctrl) {
        const selected = slashMatches[state.slashSelectedIndex] ?? slashMatches[0]!;
        if (selected.args && !selected.args.startsWith("[")) {
          const completed = `${selected.name} `;
          state = {
            ...state,
            inputText: completed,
            inputCursor: completed.length,
            slashSelectedIndex: 0,
          };
          return;
        }
        yield* submitPrompt(selected.name, nowMs);
        return;
      }
    }

    if (key.name === "paste") {
      insertComposerText(key.text.replaceAll("\r\n", "\n").replaceAll("\r", "\n"));
      return;
    }
    if (key.name === "enter") {
      if (key.shift || key.alt || key.ctrl) {
        insertComposerText("\n");
        return;
      }
      yield* submitPrompt(state.inputText, nowMs);
      return;
    }
    if (key.name === "backspace") {
      if (state.inputCursor > 0) {
        if (key.alt) {
          const before = state.inputText.slice(0, state.inputCursor).replace(/\S+\s*$/, "");
          state = {
            ...state,
            inputText: before + state.inputText.slice(state.inputCursor),
            inputCursor: before.length,
          };
        } else {
          state = {
            ...state,
            inputText:
              state.inputText.slice(0, state.inputCursor - 1) +
              state.inputText.slice(state.inputCursor),
            inputCursor: state.inputCursor - 1,
            slashSelectedIndex: 0,
          };
        }
      }
      return;
    }
    if (key.name === "delete") {
      if (state.inputCursor < state.inputText.length) {
        state = {
          ...state,
          inputText:
            state.inputText.slice(0, state.inputCursor) +
            state.inputText.slice(state.inputCursor + 1),
        };
      }
      return;
    }
    if (key.name === "left") {
      state = { ...state, inputCursor: Math.max(0, state.inputCursor - 1) };
      return;
    }
    if (key.name === "right") {
      state = { ...state, inputCursor: Math.min(state.inputText.length, state.inputCursor + 1) };
      return;
    }
    if (key.name === "home") {
      if (state.inputText.length === 0) {
        state = { ...state, scrollOffset: state.scrollOffset + 20 };
      } else {
        state = { ...state, inputCursor: 0 };
      }
      return;
    }
    if (key.name === "end") {
      if (state.scrollOffset > 0 && state.inputText.length === 0) {
        state = { ...state, scrollOffset: 0 };
      } else {
        state = { ...state, inputCursor: state.inputText.length };
      }
      return;
    }
    if (key.name === "up" && !state.inputText.includes("\n") && inputHistory.length > 0) {
      if (historyIndex === -1) {
        historyDraft = state.inputText;
        historyIndex = inputHistory.length - 1;
      } else if (historyIndex > 0) {
        historyIndex -= 1;
      }
      const next = inputHistory[historyIndex] ?? "";
      state = { ...state, inputText: next, inputCursor: next.length };
      return;
    }
    if (key.name === "down" && !state.inputText.includes("\n") && historyIndex !== -1) {
      if (historyIndex + 1 < inputHistory.length) {
        historyIndex += 1;
        const next = inputHistory[historyIndex] ?? "";
        state = { ...state, inputText: next, inputCursor: next.length };
      } else {
        historyIndex = -1;
        state = { ...state, inputText: historyDraft, inputCursor: historyDraft.length };
      }
      return;
    }
    if (key.name === "char" && !key.ctrl && !key.alt) {
      insertComposerText(key.text);
    }
  });

  yield* forkShellSubscription(options.connection.client, {
    onSnapshot: (projects, threads) => offer({ kind: "shell-snapshot", projects, threads }),
    onProjectUpdated: (project) => offer({ kind: "project-updated", project }),
    onProjectRemoved: (projectId) => offer({ kind: "project-removed", projectId }),
    onThreadUpdated: (thread) => offer({ kind: "thread-updated", thread }),
    onThreadRemoved: (threadId) => offer({ kind: "thread-removed", threadId }),
    onDisconnect: (reason) => offer({ kind: "disconnected", reason }),
  });

  const onData = (chunk: Buffer | string) => offer({ kind: "raw-input", chunk });
  const onResize = () => offer({ kind: "resize" });
  const onSignal = () => offer({ kind: "quit" });

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      terminal.enter(state.config.mouse);
      process.stdin.on("data", onData);
      process.stdout.on("resize", onResize);
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
    }),
    () =>
      Effect.sync(() => {
        disposed = true;
        process.stdin.off("data", onData);
        process.stdout.off("resize", onResize);
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        terminal.leave();
      }),
  );

  yield* renderNow();

  while (!disposed) {
    const event = yield* Queue.take(queue);
    const nowMs = yield* Clock.currentTimeMillis;

    switch (event.kind) {
      case "quit":
        disposed = true;
        break;

      case "resize":
        screen.reset();
        break;

      case "tick":
        state = { ...state, spinnerFrame: (state.spinnerFrame + 1) % 10 };
        break;

      case "raw-input": {
        if (escFlushFiber !== null) {
          yield* Fiber.interrupt(escFlushFiber);
          escFlushFiber = null;
        }
        for (const key of inputParser.feed(event.chunk)) {
          yield* handleKey(key, nowMs);
          if (disposed) break;
        }
        if (!disposed && inputParser.hasPendingEscape()) {
          escFlushFiber = yield* Effect.sleep(Duration.millis(35)).pipe(
            Effect.andThen(Effect.sync(() => offer({ kind: "esc-flush" }))),
            Effect.forkIn(scope),
          );
        }
        break;
      }

      case "esc-flush": {
        escFlushFiber = null;
        for (const key of inputParser.flushPendingEscape()) {
          yield* handleKey(key, nowMs);
          if (disposed) break;
        }
        break;
      }

      case "shell-snapshot": {
        const matched = matchProjectForTarget(
          event.projects,
          options.explicitProjectArg,
          options.targetWorkspacePath,
        );
        const nextModel =
          state.activeModelSelection ??
          pickInitialModelSelection(
            state.providers,
            matched,
            options.explicitProvider,
            options.explicitModel,
          );
        state = {
          ...state,
          connected: true,
          projects: event.projects,
          threads: event.threads,
          activeProject: matched,
          activeModelSelection: nextModel,
        };
        if (
          !bootstrappedProject &&
          !options.explicitProjectArg &&
          (matched === null ||
            !options.targetWorkspacePath
              .replace(/\/+$/, "")
              .startsWith(matched.workspaceRoot.replace(/\/+$/, "")))
        ) {
          bootstrappedProject = true;
          const title = path.basename(options.targetWorkspacePath) || "Workspace";
          yield* forkAction(
            options.connection.ensureProject(options.targetWorkspacePath, title).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  offer({ kind: "status", message: `Added project: ${title}` });
                }),
              ),
              Effect.ignore,
            ),
          );
        }
        if (options.initialThreadId && state.activeProjection === null) {
          yield* subscribeToThread(options.initialThreadId);
        }
        break;
      }

      case "project-updated": {
        const exists = state.projects.some((p) => p.id === event.project.id);
        const projects = exists
          ? state.projects.map((p) => (p.id === event.project.id ? event.project : p))
          : [...state.projects, event.project];
        const activeProject =
          state.activeProject?.id === event.project.id
            ? event.project
            : state.activeProject === null &&
                event.project.workspaceRoot.replace(/\/+$/, "") ===
                  options.targetWorkspacePath.replace(/\/+$/, "")
              ? event.project
              : state.activeProject;
        state = { ...state, projects, activeProject };
        break;
      }

      case "project-removed": {
        const projects = state.projects.filter((p) => p.id !== event.projectId);
        const activeProject =
          state.activeProject?.id === event.projectId ? (projects[0] ?? null) : state.activeProject;
        state = { ...state, projects, activeProject };
        break;
      }

      case "thread-updated": {
        const exists = state.threads.some((t) => t.id === event.thread.id);
        const threads = exists
          ? state.threads.map((t) => (t.id === event.thread.id ? event.thread : t))
          : [...state.threads, event.thread];
        state = { ...state, threads };
        break;
      }

      case "thread-removed": {
        const threads = state.threads.filter((t) => t.id !== event.threadId);
        state = { ...state, threads };
        break;
      }

      case "disconnected":
        state = { ...state, connected: false, statusMessage: `Disconnected: ${event.reason}` };
        break;

      case "thread-projection":
        if (state.activeThreadId === event.threadId) {
          yield* updateProjection(event.projection);
        }
        break;

      case "thread-launched":
        state = {
          ...state,
          activeThreadId: event.threadId,
          statusMessage: `Thread ${event.threadId.slice(0, 8)} started`,
        };
        yield* updateProjection(event.projection);
        yield* subscribeToThread(event.threadId);
        break;

      case "diff-loaded":
        state = {
          ...state,
          statusMessage: null,
          overlay: { kind: "diff", title: event.title, text: event.text, scrollOffset: 0 },
        };
        break;

      case "notice":
        pushNotice(event.level, event.title, event.body, nowMs, event.markdown);
        break;

      case "status":
        state = { ...state, statusMessage: event.message };
        break;
    }

    if (!disposed) {
      yield* renderNow();
    }
  }
});
