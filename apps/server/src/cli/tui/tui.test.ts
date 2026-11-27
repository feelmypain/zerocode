import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@zerocode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { TerminalInputParser } from "./input.ts";
import { renderDiffSnippet, renderMarkdown } from "./markdown.ts";
import {
  filterModels,
  filterSlashCommands,
  filterThemes,
  renderTuiFrame,
  type TuiViewState,
} from "./renderer.ts";
import { ScreenBuffer, displayWidth, stripAnsi, truncateAnsi, wrapAnsiText } from "./terminal.ts";
import {
  BUILT_IN_TUI_THEMES,
  DEFAULT_TUI_CONFIG,
  colorToSgr,
  detectColorDepth,
  loadTuiConfig,
  oklchToRgb,
  parseColorSpec,
  resolveTuiTheme,
  rgbToAnsi16,
  rgbToAnsi256,
  saveTuiConfig,
  type TuiConfig,
} from "./themes.ts";

describe("TUI themes and config", () => {
  it("parses hex, rgb, oklch, and named ANSI color specs", () => {
    assert.deepEqual(parseColorSpec("#7aa2f7"), { kind: "rgb", r: 0x7a, g: 0xa2, b: 0xf7 });
    assert.deepEqual(parseColorSpec("#f0a"), { kind: "rgb", r: 0xff, g: 0x00, b: 0xaa });
    assert.deepEqual(parseColorSpec("rgb(12, 34, 56)"), { kind: "rgb", r: 12, g: 34, b: 56 });
    assert.deepEqual(parseColorSpec("cyan"), { kind: "ansi16", code: 6 });
    assert.deepEqual(parseColorSpec("default"), { kind: "default" });
    assert.isNull(parseColorSpec("not-a-color"));

    const white = oklchToRgb(1, 0, 0);
    assert.equal(white.r, 255);
    assert.equal(white.g, 255);
    assert.equal(white.b, 255);

    const parsedOklch = parseColorSpec("oklch(0.67 0.17 294)");
    assert.isNotNull(parsedOklch);
    assert.equal(parsedOklch?.kind, "rgb");
  });

  it("maps colors cleanly across truecolor, 256, 16, and none depths", () => {
    assert.equal(detectColorDepth("auto", { NO_COLOR: "1", COLORTERM: "truecolor" }), "none");
    assert.equal(detectColorDepth("auto", { COLORTERM: "truecolor" }), "truecolor");
    assert.equal(detectColorDepth("256", { NO_COLOR: "1" }), "256");

    assert.equal(colorToSgr("#7aa2f7", "truecolor"), "\x1b[38;2;122;162;247m");
    assert.equal(colorToSgr("#7aa2f7", "truecolor", true), "\x1b[48;2;122;162;247m");
    assert.equal(
      colorToSgr("#7aa2f7", "256"),
      `\x1b[38;5;${rgbToAnsi256({ r: 122, g: 162, b: 247 })}m`,
    );
    assert.isAbove(rgbToAnsi16({ r: 122, g: 162, b: 247 }), -1);
    assert.equal(colorToSgr("#7aa2f7", "none"), "");
  });

  it("includes ZeroCode native palettes plus iconic terminal themes and applies per-role overrides", () => {
    const ids = new Set(BUILT_IN_TUI_THEMES.map((t) => t.id));
    for (const expected of [
      "zerocode-dark",
      "zerocode-light",
      "zerocode-plum",
      "tokyo-night",
      "catppuccin-mocha",
      "gruvbox-dark",
      "nord",
      "rose-pine",
      "dracula",
      "ansi",
    ]) {
      assert.isTrue(ids.has(expected), `expected built-in theme ${expected}`);
    }

    const config: TuiConfig = {
      ...DEFAULT_TUI_CONFIG,
      theme: "tokyo-night",
      colorMode: "truecolor",
      colors: { accent: "#ff79c6", prompt: "cyan" },
    };
    const resolved = resolveTuiTheme(BUILT_IN_TUI_THEMES, config);
    assert.equal(resolved.id, "tokyo-night");
    assert.equal(resolved.palette.accent, "#ff79c6");
    assert.equal(resolved.palette.prompt, "cyan");
    assert.include(resolved.fg("accent", "hi"), "\x1b[38;2;255;121;198m");
    assert.include(resolved.fg("prompt", ">"), "\x1b[36m");
  });

  it.effect("persists and reloads TUI theme and color overrides atomically", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "zerocode-tui-config-" });
        const configPath = path.join(dir, "cli-tui.json");

        const saved: TuiConfig = {
          theme: "catppuccin-mocha",
          colorMode: "256",
          borderStyle: "sharp",
          showThinking: false,
          showTools: "expanded",
          showTimestamps: false,
          mouse: true,
          colors: { accent: "#ff79c6", border: "gray" },
        };
        yield* saveTuiConfig(configPath, saved);
        const reloaded = yield* loadTuiConfig(configPath);
        assert.deepEqual(reloaded, saved);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("TerminalInputParser", () => {
  it("decodes CSI, SS3, Kitty Shift+Enter, Ctrl chords, SGR mouse, and split bracketed paste", () => {
    const parser = new TerminalInputParser();

    assert.deepEqual(
      parser.feed("\x1b[A\x1bOB\x1b[13;2u\x1b[27;2;13~\x0b").map((k) => ({
        name: k.name,
        text: k.text,
        ctrl: k.ctrl,
        shift: k.shift,
      })),
      [
        { name: "up", text: "", ctrl: false, shift: false },
        { name: "down", text: "", ctrl: false, shift: false },
        { name: "enter", text: "", ctrl: false, shift: true },
        { name: "enter", text: "", ctrl: false, shift: true },
        { name: "char", text: "k", ctrl: true, shift: false },
      ],
    );

    assert.deepEqual(
      parser.feed("\x1b[<64;12;8M\x1b[<65;12;8M").map((k) => k.name),
      ["mouse-wheel-up", "mouse-wheel-down"],
    );

    // Split bracketed paste across two chunks
    assert.deepEqual(parser.feed("\x1b[200~line1\nli"), []);
    const pasted = parser.feed("ne2\x1b[201~");
    assert.equal(pasted.length, 1);
    assert.equal(pasted[0]?.name, "paste");
    assert.equal(pasted[0]?.text, "line1\nline2");

    // Bare ESC waits for flush
    assert.deepEqual(parser.feed("\x1b"), []);
    assert.isTrue(parser.hasPendingEscape());
    assert.equal(parser.flushPendingEscape()[0]?.name, "escape");
  });
});

describe("Terminal width, markdown, and diff rendering", () => {
  it("measures ANSI and wide characters accurately and preserves styles across wraps", () => {
    const styled = "\x1b[38;2;122;162;247mhello 世界\x1b[0m";
    assert.equal(displayWidth(styled), 10);
    assert.equal(stripAnsi(truncateAnsi(styled, 8)), "hello …");
    assert.equal(stripAnsi(truncateAnsi(styled, 9)), "hello 世…");

    const wrapped = wrapAnsiText("\x1b[32mabcdefghij\x1b[0m", 4);
    assert.equal(wrapped.length, 3);
    assert.equal(stripAnsi(wrapped[0]!), "abcd");
    assert.equal(stripAnsi(wrapped[1]!), "efgh");
    assert.equal(stripAnsi(wrapped[2]!), "ij");
    assert.include(wrapped[1]!, "\x1b[32m");
  });

  it("renders markdown code fences, headings, lists, and colorized diffs", () => {
    const theme = resolveTuiTheme(BUILT_IN_TUI_THEMES, {
      ...DEFAULT_TUI_CONFIG,
      theme: "tokyo-night",
      colorMode: "truecolor",
    });
    const md = renderMarkdown("# Heading\n- [x] Done\n```ts\nconst x = 42;\n```", 60, theme);
    const plain = md.map(stripAnsi).join("\n");
    assert.include(plain, "Heading");
    assert.include(plain, "✓ Done");
    assert.include(plain, "ts");
    assert.include(plain, "const x = 42;");

    const diff = renderDiffSnippet("@@ -1,2 +1,2 @@\n-old\n+new", 60, theme);
    assert.include(diff[1]!, "\x1b[38;2;");
    assert.include(diff[2]!, "\x1b[38;2;");
  });
});

describe("TUI renderer and ScreenBuffer diff", () => {
  function baseState(overrides: Partial<TuiViewState> = {}): TuiViewState {
    const config: TuiConfig = {
      ...DEFAULT_TUI_CONFIG,
      theme: "tokyo-night",
      colorMode: "truecolor",
    };
    return {
      version: "0.1.14",
      connectionLabel: "http://127.0.0.1:3773",
      connected: true,
      reconnecting: false,
      configPath: "/tmp/cli-tui.json",
      config,
      themes: BUILT_IN_TUI_THEMES,
      theme: resolveTuiTheme(BUILT_IN_TUI_THEMES, config),
      projects: [],
      activeProject: {
        id: ProjectId.make("proj-1"),
        title: "zerocode",
        workspaceRoot: "/workspace/zerocode",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } as unknown as TuiViewState["activeProject"],
      threads: [],
      activeThreadId: null,
      activeProjection: null,
      providers: [],
      modelChoices: [
        {
          providerInstanceId: "claude",
          providerLabel: "Claude",
          driver: "claudeAgent",
          modelSlug: "claude-sonnet-4-6",
          modelName: "Claude Sonnet 4.6",
          providerState: "ready",
        },
      ],
      activeModelSelection: {
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-sonnet-4-6",
      },
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
      statusMessage: null,
      ...overrides,
    };
  }

  it("renders welcome screen, slash autocomplete, theme picker, approval card, and incremental diffs", () => {
    const buffer = new ScreenBuffer();
    const state = baseState();
    const frame1 = renderTuiFrame(state, 30, 100);
    assert.equal(frame1.lines.length, 30);
    assert.isTrue(frame1.cursor.visible);
    const plain1 = frame1.lines.map(stripAnsi).join("\n");
    assert.include(plain1, "ZeroCode");
    assert.include(plain1, "tokyo-night");
    assert.include(plain1, "claude/claude-sonnet-4-6");

    const firstFlush = buffer.diff(frame1, 30, 100);
    assert.include(firstFlush, "\x1b[?2026h");
    // Unchanged second frame writes zero line updates.
    const noopFlush = buffer.diff(frame1, 30, 100);
    assert.notInclude(noopFlush, "\x1b[2K");

    // Slash command popup
    assert.isAbove(filterSlashCommands("/th").length, 1);
    const slashFrame = renderTuiFrame(baseState({ inputText: "/th", inputCursor: 3 }), 30, 100);
    assert.include(slashFrame.lines.map(stripAnsi).join("\n"), "/theme");

    // Theme picker overlay
    assert.isAbove(filterThemes(BUILT_IN_TUI_THEMES, "catppuccin").length, 0);
    assert.equal(filterModels(state.modelChoices, "sonnet").length, 1);
    const themeFrame = renderTuiFrame(
      baseState({
        overlay: { kind: "theme", query: "", selectedIndex: 0, previousThemeId: "tokyo-night" },
      }),
      30,
      100,
    );
    assert.isFalse(themeFrame.cursor.visible);
    assert.include(themeFrame.lines.map(stripAnsi).join("\n"), "Theme Picker");

    // Inline approval banner
    const approvalFrame = renderTuiFrame(
      baseState({
        activeThreadId: ThreadId.make("thread-1"),
        pendingInteraction: {
          kind: "approval",
          request: {
            id: RuntimeRequestId.make("req-1"),
            nodeId: TurnItemId.make("node-1") as never,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "command",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: DateTime.makeUnsafe(1_700_000_000_000),
            resolvedAt: null,
          },
          prompt: "Run rm -rf dist?",
          reason: "Cleanup requested",
          options: [
            { decision: "accept", label: "Allow once" },
            { decision: "decline", label: "Decline" },
          ],
          selectedIndex: 0,
        },
      }),
      30,
      100,
    );
    const approvalPlain = approvalFrame.lines.map(stripAnsi).join("\n");
    assert.include(approvalPlain, "Approval Required");
    assert.include(approvalPlain, "Run rm -rf dist?");
  });
});
