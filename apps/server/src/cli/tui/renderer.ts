import type {
  ModelSelection,
  OrchestrationProjectShell,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  RuntimeMode,
  ServerProvider,
} from "@zerocode/contracts";

import * as DateTime from "effect/DateTime";

import { renderDiffSnippet, renderMarkdown } from "./markdown.ts";
import {
  displayWidth,
  padRightAnsi,
  truncateAnsi,
  wrapPlainText,
  type CursorPosition,
  type RenderedFrame,
} from "./terminal.ts";
import {
  TUI_COLOR_ROLES,
  type ResolvedTuiTheme,
  type TuiConfig,
  type TuiThemeDefinition,
} from "./themes.ts";

export interface SlashCommandMeta {
  readonly name: string;
  readonly args?: string;
  readonly description: string;
}

const SLASH_COMMANDS: ReadonlyArray<SlashCommandMeta> = [
  { name: "/help", description: "Show keyboard shortcuts and commands" },
  { name: "/new", args: "[title]", description: "Start a fresh thread in the current project" },
  { name: "/threads", description: "Switch threads (Ctrl+G)" },
  { name: "/project", description: "Switch or add project (Ctrl+P)" },
  { name: "/model", args: "[slug]", description: "Choose provider & model (Ctrl+M)" },
  {
    name: "/mode",
    args: "<mode>",
    description: "Set permission mode (approval-required | auto-accept-edits | auto | full-access)",
  },
  { name: "/plan", description: "Switch to plan interaction mode" },
  { name: "/default", description: "Switch to default interaction mode" },
  { name: "/theme", args: "[id]", description: "Open live theme picker or apply theme (Ctrl+K)" },
  { name: "/colors", description: "Inspect all semantic color roles and swatches" },
  {
    name: "/color",
    args: "<role> <value|reset>",
    description: "Customize a color role (#hex, oklch(...), ansi name) or reset",
  },
  {
    name: "/border",
    args: "<style>",
    description: "Set border style (rounded | sharp | minimal | none)",
  },
  {
    name: "/colormode",
    args: "<mode>",
    description: "Set color depth (auto | truecolor | 256 | 16 | none)",
  },
  { name: "/thinking", description: "Toggle inline thinking/reasoning blocks (Ctrl+T)" },
  {
    name: "/tools",
    args: "[mode]",
    description: "Cycle tool display (compact | expanded | minimal) (Ctrl+O)",
  },
  { name: "/timestamps", description: "Toggle message timestamps" },
  { name: "/mouse", description: "Toggle mouse wheel scrolling (off preserves native text copy)" },
  { name: "/diff", description: "Inspect the current thread's full git diff" },
  { name: "/stop", description: "Interrupt the active agent run (Esc)" },
  { name: "/config", description: "Show active TUI configuration and file path" },
  { name: "/clear", description: "Clear transient notices and scroll to bottom" },
  { name: "/quit", description: "Exit ZeroCode CLI (Ctrl+D)" },
];

export interface ModelChoice {
  readonly providerInstanceId: string;
  readonly providerLabel: string;
  readonly driver: string;
  readonly modelSlug: string;
  readonly modelName: string;
  readonly providerState: ServerProvider["status"];
}

export interface LocalNotice {
  readonly id: number;
  readonly level: "info" | "success" | "warning" | "error";
  readonly title?: string | undefined;
  readonly body: string;
  readonly markdown?: boolean;
  readonly timestamp: string;
}

export type ActiveOverlay =
  | { readonly kind: "none" }
  | {
      readonly kind: "theme";
      readonly query: string;
      readonly selectedIndex: number;
      readonly previousThemeId: string;
    }
  | { readonly kind: "colors"; readonly scrollOffset: number }
  | { readonly kind: "model"; readonly query: string; readonly selectedIndex: number }
  | {
      readonly kind: "threads";
      readonly query: string;
      readonly selectedIndex: number;
      readonly allProjects: boolean;
    }
  | { readonly kind: "projects"; readonly query: string; readonly selectedIndex: number }
  | { readonly kind: "help"; readonly scrollOffset: number }
  | {
      readonly kind: "diff";
      readonly title: string;
      readonly text: string;
      readonly scrollOffset: number;
    };

export interface PendingApprovalView {
  readonly kind: "approval";
  readonly request: OrchestrationV2RuntimeRequest;
  readonly prompt: string;
  readonly reason: string | undefined;
  readonly options: ReadonlyArray<{
    readonly decision: ProviderApprovalDecision;
    readonly label: string;
  }>;
  readonly selectedIndex: number;
}

export interface PendingUserInputView {
  readonly kind: "user_input";
  readonly request: OrchestrationV2RuntimeRequest;
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly header?: string;
    readonly question: string;
    readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
  }>;
  readonly questionIndex: number;
  readonly selectedOptionIndex: number;
  readonly answers: Readonly<Record<string, string>>;
  readonly draftText: string;
}

export type PendingInteraction = PendingApprovalView | PendingUserInputView;

export interface TuiViewState {
  readonly version: string;
  readonly connectionLabel: string;
  readonly connected: boolean;
  readonly reconnecting: boolean;
  readonly configPath: string;
  readonly config: TuiConfig;
  readonly themes: ReadonlyArray<TuiThemeDefinition>;
  readonly theme: ResolvedTuiTheme;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly activeProject: OrchestrationProjectShell | null;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly activeThreadId: string | null;
  readonly activeProjection: OrchestrationV2ThreadProjection | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly modelChoices: ReadonlyArray<ModelChoice>;
  readonly activeModelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly isRunning: boolean;
  readonly spinnerFrame: number;
  readonly scrollOffset: number; // lines scrolled UP from bottom (0 = pinned to bottom)
  readonly notices: ReadonlyArray<LocalNotice>;
  readonly inputText: string;
  readonly inputCursor: number;
  readonly slashSelectedIndex: number;
  readonly overlay: ActiveOverlay;
  readonly pendingInteraction: PendingInteraction | null;
  readonly statusMessage: string | null;
  readonly nowMs?: number;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function filterSlashCommands(inputText: string): ReadonlyArray<SlashCommandMeta> {
  if (!inputText.startsWith("/") || inputText.includes("\n") || inputText.includes(" ")) {
    return [];
  }
  const needle = inputText.toLowerCase();
  return SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(needle));
}

export function filterThemes(
  themes: ReadonlyArray<TuiThemeDefinition>,
  query: string,
): ReadonlyArray<TuiThemeDefinition> {
  const q = query.trim().toLowerCase();
  if (!q) return themes;
  return themes.filter(
    (t) =>
      t.id.toLowerCase().includes(q) ||
      t.label.toLowerCase().includes(q) ||
      t.group.toLowerCase().includes(q) ||
      t.appearance.includes(q),
  );
}

export function filterModels(
  choices: ReadonlyArray<ModelChoice>,
  query: string,
): ReadonlyArray<ModelChoice> {
  const q = query.trim().toLowerCase();
  if (!q) return choices;
  return choices.filter(
    (c) =>
      c.modelSlug.toLowerCase().includes(q) ||
      c.modelName.toLowerCase().includes(q) ||
      c.providerLabel.toLowerCase().includes(q) ||
      c.providerInstanceId.toLowerCase().includes(q),
  );
}

function timestampToMillis(value: unknown): number {
  if (!value) return NaN;
  if (typeof value === "string") return Date.parse(value);
  if (DateTime.isDateTime(value)) return DateTime.toEpochMillis(value);
  return NaN;
}

export function filterThreads(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  activeProjectId: string | null,
  allProjects: boolean,
  query: string,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  const q = query.trim().toLowerCase();
  const scoped =
    allProjects || activeProjectId === null
      ? threads
      : threads.filter((t) => t.projectId === activeProjectId);
  const filtered = q
    ? scoped.filter((t) => t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q))
    : scoped;
  return [...filtered].sort((a, b) => {
    const aMs = timestampToMillis(a.updatedAt) || 0;
    const bMs = timestampToMillis(b.updatedAt) || 0;
    return bMs - aMs;
  });
}

export function filterProjects(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  query: string,
): ReadonlyArray<OrchestrationProjectShell> {
  const q = query.trim().toLowerCase();
  if (!q) return projects;
  return projects.filter(
    (p) =>
      p.title.toLowerCase().includes(q) ||
      p.workspaceRoot.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q),
  );
}

function formatClockTime(value: unknown): string {
  const ms = timestampToMillis(value);
  if (!Number.isFinite(ms)) return "";
  const parts = DateTime.toPartsUtc(DateTime.makeUnsafe(ms));
  const hh = String(parts.hour).padStart(2, "0");
  const mm = String(parts.minute).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatRelativeTime(value: unknown, nowMs: number): string {
  const ms = timestampToMillis(value);
  if (!Number.isFinite(ms)) return "";
  const diffSec = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  return `${Math.floor(diffHr / 24)}d`;
}

function horizontalBoxTop(
  cols: number,
  leftTitle: string,
  rightTitle: string,
  theme: ResolvedTuiTheme,
  focused = false,
): string {
  const b = theme.border;
  const colorRole = focused ? "borderFocused" : "border";
  const left = leftTitle ? ` ${leftTitle} ` : "";
  const right = rightTitle ? ` ${rightTitle} ` : "";
  const used = 2 + displayWidth(left) + displayWidth(right) + (left ? 1 : 0) + (right ? 1 : 0);
  const fill = Math.max(0, cols - used);
  return (
    theme.fg(colorRole, b.tl + (left ? b.h : "")) +
    left +
    theme.fg(colorRole, b.h.repeat(fill)) +
    right +
    theme.fg(colorRole, (right ? b.h : "") + b.tr)
  );
}

function horizontalBoxBottom(cols: number, theme: ResolvedTuiTheme, focused = false): string {
  const b = theme.border;
  const colorRole = focused ? "borderFocused" : "border";
  return theme.fg(colorRole, `${b.bl}${b.h.repeat(Math.max(0, cols - 2))}${b.br}`);
}

function boxRow(content: string, cols: number, theme: ResolvedTuiTheme, focused = false): string {
  const b = theme.border;
  const colorRole = focused ? "borderFocused" : "border";
  const innerWidth = Math.max(1, cols - 4);
  const padded = padRightAnsi(truncateAnsi(content, innerWidth), innerWidth);
  return `${theme.fg(colorRole, b.v)} ${padded} ${theme.fg(colorRole, b.v)}`;
}

function renderWelcomeLines(state: TuiViewState, width: number): Array<string> {
  const { theme } = state;
  const lines: Array<string> = [];
  const logo = [
    "███████╗███████╗██████╗  ██████╗  ██████╗ ██████╗ ██████╗ ███████╗",
    "╚══███╔╝██╔════╝██╔══██╗██╔═══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝",
    "  ███╔╝ █████╗  ██████╔╝██║   ██║██║     ██║   ██║██║  ██║█████╗  ",
    " ███╔╝  ██╔══╝  ██╔══██╗██║   ██║██║     ██║   ██║██║  ██║██╔══╝  ",
    "███████╗███████╗██║  ██║╚██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗",
    "╚══════╝╚══════╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
  ];
  lines.push("");
  if (width >= 68) {
    for (const row of logo) {
      lines.push(`  ${theme.bold("accent", row)}`);
    }
  } else {
    lines.push(`  ${theme.bold("accent", "◆ ZeroCode CLI")} ${theme.dimText(`v${state.version}`)}`);
  }
  lines.push("");
  const projectText = state.activeProject
    ? `${theme.bold("text", state.activeProject.title)} ${theme.dimText(state.activeProject.workspaceRoot)}`
    : theme.fg("warning", "No project selected (use /project)");
  const modelText = state.activeModelSelection
    ? `${theme.bold("assistantLabel", state.activeModelSelection.instanceId)} / ${theme.fg("text", state.activeModelSelection.model)}`
    : theme.fg("muted", "No ready provider detected");
  const swatches = (["accent", "userLabel", "assistantLabel", "toolOk", "tool", "error"] as const)
    .map((role) => theme.swatch(role))
    .join(" ");

  lines.push(
    `  ${theme.fg("muted", "Project  ")} ${truncateAnsi(projectText, Math.max(10, width - 14))}`,
  );
  lines.push(
    `  ${theme.fg("muted", "Model    ")} ${truncateAnsi(modelText, Math.max(10, width - 14))}`,
  );
  lines.push(
    `  ${theme.fg("muted", "Mode     ")} ${theme.fg("text", state.runtimeMode)} ${theme.dimText(`(${state.interactionMode})`)}`,
  );
  lines.push(
    `  ${theme.fg("muted", "Theme    ")} ${theme.bold("accent", theme.label)} ${swatches}`,
  );
  lines.push("");
  lines.push(`  ${theme.fg("border", theme.border.sep.repeat(Math.min(width - 4, 62)))}`);
  lines.push("");
  lines.push(`  ${theme.bold("text", "Quick Keys")}`);
  lines.push(
    `    ${theme.fg("accent", "Enter")}      Send prompt   ${theme.fg("accent", "Alt+Enter / Ctrl+J")}  New line`,
  );
  lines.push(
    `    ${theme.fg("accent", "Ctrl+M")}     Switch model  ${theme.fg("accent", "Ctrl+K")}              Live theme picker`,
  );
  lines.push(
    `    ${theme.fg("accent", "Ctrl+G")}     Threads       ${theme.fg("accent", "Ctrl+P")}              Projects`,
  );
  lines.push(
    `    ${theme.fg("accent", "Ctrl+T")}     Thinking      ${theme.fg("accent", "Ctrl+O")}              Tool detail (${state.config.showTools})`,
  );
  lines.push(
    `    ${theme.fg("accent", "Esc")}        Stop run      ${theme.fg("accent", "/help")}               All commands`,
  );
  lines.push("");
  return lines;
}

function renderTurnItemLines(
  item: OrchestrationV2TurnItem,
  width: number,
  state: TuiViewState,
): Array<string> {
  const { theme, config } = state;
  const contentWidth = Math.max(16, width - 4);
  const stamp = config.showTimestamps
    ? theme.dimText(formatClockTime(item.startedAt ?? item.updatedAt))
    : "";

  const headerLine = (left: string): string => {
    const gap = Math.max(1, contentWidth - displayWidth(left) - displayWidth(stamp));
    return ` ${left}${" ".repeat(gap)}${stamp}`;
  };

  switch (item.type) {
    case "user_message": {
      const out: Array<string> = [];
      out.push("");
      out.push(
        headerLine(`${theme.fg("userLabel", theme.border.rail)} ${theme.bold("userLabel", "You")}`),
      );
      for (const wrapped of wrapPlainText(item.text, Math.max(12, contentWidth - 2))) {
        out.push(` ${theme.fg("userLabel", theme.border.rail)} ${theme.fg("text", wrapped)}`);
      }
      return out;
    }

    case "assistant_message": {
      const out: Array<string> = [];
      out.push("");
      const badge = item.streaming
        ? ` ${theme.fg("accent", SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length]!)}`
        : "";
      out.push(headerLine(`${theme.bold("assistantLabel", "◆ Assistant")}${badge}`));
      const mdLines = renderMarkdown(item.text, Math.max(16, contentWidth - 2), theme);
      for (const line of mdLines) {
        out.push(`   ${line}`);
      }
      return out;
    }

    case "reasoning": {
      if (!config.showThinking || !item.text.trim()) return [];
      const out: Array<string> = [];
      const label = item.streaming ? "💭 Thinking…" : "💭 Thinking";
      out.push(`   ${theme.italic("thinking", label)}`);
      const rawLines = item.text.trim().split("\n");
      const limit = config.showTools === "expanded" ? 24 : 6;
      const shown = rawLines.slice(-limit);
      if (rawLines.length > limit) {
        out.push(
          `   ${theme.fg("border", theme.border.v)} ${theme.dimText(`… ${rawLines.length - limit} earlier line(s)`)}`,
        );
      }
      for (const row of shown) {
        for (const w of wrapPlainText(row, Math.max(12, contentWidth - 5))) {
          out.push(`   ${theme.fg("border", theme.border.v)} ${theme.italic("thinking", w)}`);
        }
      }
      return out;
    }

    case "command_execution": {
      const statusIcon =
        item.status === "running" || item.status === "pending"
          ? theme.fg("tool", SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length]!)
          : item.exitCode === 0 && !item.outputIndicatesFailure
            ? theme.fg("toolOk", "✓")
            : item.status === "failed" || (item.exitCode !== undefined && item.exitCode !== 0)
              ? theme.fg("toolErr", `✗ exit ${item.exitCode ?? "?"}`)
              : theme.fg("toolOk", "✓");
      const cmdPreview = truncateAnsi(
        item.input.replaceAll("\n", " "),
        Math.max(12, contentWidth - 16),
      );
      const out: Array<string> = [
        `   ${theme.fg("tool", "▸")} ${theme.bold("tool", "$")} ${theme.fg("code", cmdPreview)}  ${statusIcon}`,
      ];
      if (config.showTools !== "minimal" && item.output && item.output.trim().length > 0) {
        const outputLines = item.output.replaceAll("\r\n", "\n").trimEnd().split("\n");
        const maxLines = config.showTools === "expanded" ? 24 : 5;
        const tail = outputLines.slice(-maxLines);
        if (outputLines.length > maxLines) {
          out.push(
            `     ${theme.dimText(`… ${outputLines.length - maxLines} earlier line(s) (Ctrl+O to expand)`)}`,
          );
        }
        for (const line of tail) {
          out.push(`     ${theme.dimText(truncateAnsi(line, Math.max(10, contentWidth - 6)))}`);
        }
      }
      return out;
    }

    case "file_change": {
      const stats = [
        item.additions !== undefined ? theme.fg("diffAdd", `+${item.additions}`) : "",
        item.deletions !== undefined ? theme.fg("diffDel", `-${item.deletions}`) : "",
      ]
        .filter(Boolean)
        .join(" ");
      const out: Array<string> = [
        `   ${theme.fg("tool", "✎")} ${theme.bold("text", item.fileName)}${stats ? `  ${stats}` : ""}`,
      ];
      if (config.showTools !== "minimal" && item.diffStr) {
        const diffLines = renderDiffSnippet(
          item.diffStr,
          Math.max(12, contentWidth - 5),
          theme,
          config.showTools === "expanded" ? 36 : 10,
        );
        for (const line of diffLines) {
          out.push(`     ${line}`);
        }
      }
      return out;
    }

    case "file_search": {
      const count = item.results?.length ?? 0;
      const pattern = item.pattern ?? "";
      return [
        `   ${theme.fg("tool", "⌕")} ${theme.fg("muted", "Search")} ${theme.fg("code", truncateAnsi(pattern, 44))} ${theme.dimText(`(${count} hit${count === 1 ? "" : "s"})`)}`,
      ];
    }

    case "web_search": {
      const queries = item.patterns?.join(", ") ?? "";
      const count = item.results?.length ?? 0;
      return [
        `   ${theme.fg("tool", "◎")} ${theme.fg("muted", "Web")} ${theme.fg("code", truncateAnsi(queries, 44))} ${theme.dimText(`(${count})`)}`,
      ];
    }

    case "dynamic_tool": {
      const name = item.toolName ?? "tool";
      const icon =
        item.status === "running" || item.status === "pending"
          ? theme.fg("tool", SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length]!)
          : item.status === "failed"
            ? theme.fg("toolErr", "✗")
            : theme.fg("toolOk", "✓");
      const out = [`   ${icon} ${theme.fg("tool", name)}`];
      if (config.showTools === "expanded" && item.output !== undefined) {
        const text =
          typeof item.output === "string" ? item.output : JSON.stringify(item.output, null, 2);
        for (const line of text.split("\n").slice(0, 12)) {
          out.push(`     ${theme.dimText(truncateAnsi(line, Math.max(10, contentWidth - 6)))}`);
        }
      }
      return out;
    }

    case "proposed_plan": {
      const out = ["", `   ${theme.bold("accent", "▣ Proposed Plan")}`];
      for (const line of renderMarkdown(item.markdown, Math.max(14, contentWidth - 4), theme)) {
        out.push(`   ${theme.fg("accent", theme.border.v)} ${line}`);
      }
      return out;
    }

    case "todo_list": {
      const out = [`   ${theme.bold("muted", "☑ Plan Steps")}`];
      for (const step of item.steps) {
        const icon =
          step.status === "completed"
            ? theme.fg("toolOk", "✓")
            : step.status === "running"
              ? theme.fg("accent", "▸")
              : theme.dimText("○");
        out.push(
          `     ${icon} ${theme.fg("text", truncateAnsi(step.text, Math.max(10, contentWidth - 8)))}`,
        );
      }
      return out;
    }

    case "subagent": {
      const icon =
        item.status === "running" || item.status === "pending"
          ? theme.fg("accent", SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length]!)
          : item.status === "failed"
            ? theme.fg("toolErr", "✗")
            : theme.fg("toolOk", "✓");
      return [
        `   ${icon} ${theme.bold("assistantLabel", "Subagent")} ${theme.dimText(truncateAnsi(item.prompt, Math.max(10, contentWidth - 16)))}`,
      ];
    }

    case "error": {
      const out = ["", `   ${theme.badge("error", "accentText", "ERROR")}`];
      for (const w of wrapPlainText(item.failure.message, Math.max(12, contentWidth - 4))) {
        out.push(`   ${theme.fg("error", w)}`);
      }
      return out;
    }

    case "system_notice": {
      const role =
        item.level === "error" ? "error" : item.level === "warning" ? "warning" : "muted";
      return [
        `   ${theme.fg(role, `ℹ ${truncateAnsi(item.message, Math.max(10, contentWidth - 4))}`)}`,
      ];
    }

    case "compaction":
      return [`   ${theme.dimText("── Context compacted ──")}`];

    case "approval_request":
    case "user_input_request": {
      const label = item.type === "approval_request" ? "Approval" : "Question";
      const summary =
        item.type === "approval_request"
          ? (item.prompt ?? item.reason ?? item.requestKind)
          : (item.questions[0]?.question ?? "Waiting for answer");
      return [
        `   ${theme.fg("warning", "⚡")} ${theme.bold("warning", label)} ${theme.fg("text", truncateAnsi(summary, Math.max(10, contentWidth - 16)))}`,
      ];
    }

    case "checkpoint": {
      const count = item.filesTotal?.count ?? item.files.length;
      if (count === 0) return [];
      return [
        `   ${theme.dimText(`◇ Checkpoint · ${count} changed file${count === 1 ? "" : "s"}`)}`,
      ];
    }

    default:
      return [];
  }
}

function renderNoticeLines(
  notice: LocalNotice,
  width: number,
  theme: ResolvedTuiTheme,
): Array<string> {
  const role =
    notice.level === "error"
      ? "error"
      : notice.level === "warning"
        ? "warning"
        : notice.level === "success"
          ? "toolOk"
          : "accent";
  const out: Array<string> = [""];
  if (notice.title) {
    out.push(`   ${theme.bold(role, `◆ ${notice.title}`)}`);
  }
  const bodyLines = notice.markdown
    ? renderMarkdown(notice.body, Math.max(14, width - 6), theme)
    : wrapPlainText(notice.body, Math.max(14, width - 6)).map((line) => theme.fg("text", line));
  for (const line of bodyLines) {
    out.push(`   ${theme.fg(role, theme.border.rail)} ${line}`);
  }
  return out;
}

function buildConversationLines(state: TuiViewState, innerWidth: number): Array<string> {
  const lines: Array<string> = [];
  const items = state.activeProjection?.visibleTurnItems ?? [];
  if (items.length === 0 && state.notices.length === 0) {
    return renderWelcomeLines(state, innerWidth);
  }
  if (items.length === 0) {
    lines.push(...renderWelcomeLines(state, innerWidth));
  } else {
    for (const row of items) {
      if ("type" in row.item) {
        lines.push(...renderTurnItemLines(row.item as OrchestrationV2TurnItem, innerWidth, state));
      }
    }
  }
  for (const notice of state.notices) {
    lines.push(...renderNoticeLines(notice, innerWidth, state.theme));
  }
  lines.push("");
  return lines;
}

function renderPendingInteractionLines(
  pending: PendingInteraction,
  cols: number,
  theme: ResolvedTuiTheme,
): Array<string> {
  const out: Array<string> = [];
  if (pending.kind === "approval") {
    out.push(
      horizontalBoxTop(
        cols,
        theme.bold("warning", "⚡ Approval Required"),
        theme.dimText("↑/↓ select · Enter confirm · Esc decline"),
        theme,
        true,
      ),
    );
    for (const w of wrapPlainText(pending.prompt, Math.max(16, cols - 6)).slice(0, 3)) {
      out.push(boxRow(theme.bold("text", w), cols, theme, true));
    }
    if (pending.reason) {
      out.push(boxRow(theme.dimText(pending.reason), cols, theme, true));
    }
    const opts = pending.options
      .map((opt, idx) => {
        const tag = `[${idx + 1}] ${opt.label}`;
        return idx === pending.selectedIndex
          ? theme.badge("selectionBg", "selectionFg", tag)
          : theme.fg("muted", ` ${tag} `);
      })
      .join(" ");
    out.push(boxRow(opts, cols, theme, true));
    out.push(horizontalBoxBottom(cols, theme, true));
    return out;
  }

  const q = pending.questions[pending.questionIndex];
  const progress = `Question ${pending.questionIndex + 1}/${pending.questions.length}`;
  out.push(
    horizontalBoxTop(
      cols,
      theme.bold("accent", `? ${q?.header ?? progress}`),
      theme.dimText("Enter answer · ↑/↓ options · Esc dismiss"),
      theme,
      true,
    ),
  );
  if (q) {
    for (const w of wrapPlainText(q.question, Math.max(16, cols - 6)).slice(0, 2)) {
      out.push(boxRow(theme.fg("text", w), cols, theme, true));
    }
    if (q.options && q.options.length > 0) {
      q.options.forEach((opt, idx) => {
        const prefix = idx === pending.selectedOptionIndex ? theme.bold("accent", "▸ ") : "  ";
        const label =
          idx === pending.selectedOptionIndex
            ? theme.badge("selectionBg", "selectionFg", opt.label)
            : theme.fg("text", opt.label);
        const desc = opt.description ? ` ${theme.dimText(opt.description)}` : "";
        out.push(boxRow(`${prefix}${label}${desc}`, cols, theme, true));
      });
    } else {
      out.push(
        boxRow(
          `${theme.fg("prompt", "❯ ")}${theme.fg("text", pending.draftText)}█`,
          cols,
          theme,
          true,
        ),
      );
    }
  }
  out.push(horizontalBoxBottom(cols, theme, true));
  return out;
}

function renderSlashMenu(
  matches: ReadonlyArray<SlashCommandMeta>,
  selectedIndex: number,
  cols: number,
  theme: ResolvedTuiTheme,
): Array<string> {
  const visible = matches.slice(0, 7);
  const out: Array<string> = [
    horizontalBoxTop(
      cols,
      theme.bold("accent", "Commands"),
      theme.dimText("Tab complete · ↑/↓ select · Enter run"),
      theme,
      false,
    ),
  ];
  visible.forEach((cmd, idx) => {
    const selected = idx === selectedIndex;
    const label = cmd.args ? `${cmd.name} ${cmd.args}` : cmd.name;
    const paddedCmd = padRightAnsi(
      selected ? theme.bold("selectionFg", label) : theme.bold("accent", label),
      26,
    );
    const desc = selected
      ? theme.fg("selectionFg", cmd.description)
      : theme.fg("muted", cmd.description);
    const line = `${selected ? "▸ " : "  "}${paddedCmd} ${desc}`;
    const styled = selected
      ? theme.bg(
          "selectionBg",
          padRightAnsi(truncateAnsi(line, Math.max(10, cols - 4)), Math.max(10, cols - 4)),
        )
      : line;
    out.push(boxRow(styled, cols, theme, false));
  });
  out.push(horizontalBoxBottom(cols, theme, false));
  return out;
}

function renderOverlayContent(
  state: TuiViewState,
  cols: number,
  maxBodyRows: number,
): Array<string> | null {
  const { overlay, theme } = state;
  if (overlay.kind === "none") return null;
  const inner = Math.max(20, cols - 4);
  const out: Array<string> = [];

  if (overlay.kind === "theme") {
    const filtered = filterThemes(state.themes, overlay.query);
    out.push(
      horizontalBoxTop(
        cols,
        theme.bold("accent", "◆ Theme Picker (live preview)"),
        theme.dimText("↑/↓ preview · Enter save · Esc cancel"),
        theme,
        true,
      ),
    );
    out.push(
      boxRow(
        `${theme.fg("muted", "Filter: ")}${theme.fg("text", overlay.query || theme.dimText("type to filter (tokyo, catppuccin, gruvbox, plum, light, dark...)"))}`,
        cols,
        theme,
        true,
      ),
    );
    out.push(boxRow(theme.fg("border", theme.border.sep.repeat(inner)), cols, theme, true));

    const listRows = Math.max(4, maxBodyRows - 6);
    const clampedIdx = Math.max(0, Math.min(filtered.length - 1, overlay.selectedIndex));
    const start = Math.max(
      0,
      Math.min(clampedIdx - Math.floor(listRows / 2), Math.max(0, filtered.length - listRows)),
    );
    const slice = filtered.slice(start, start + listRows);

    if (slice.length === 0) {
      out.push(boxRow(theme.dimText("No matching themes."), cols, theme, true));
    } else {
      slice.forEach((candidate, idx) => {
        const realIdx = start + idx;
        const selected = realIdx === clampedIdx;
        const activeMark = candidate.id === state.config.theme ? "●" : " ";
        const previewSwatches = (
          ["accent", "userLabel", "assistantLabel", "toolOk", "tool", "error"] as const
        )
          .map((role) => {
            const hex = candidate.palette[role];
            const sgr =
              theme.depth === "none"
                ? ""
                : theme.depth === "truecolor" && /^#[0-9a-f]{6}$/i.test(hex)
                  ? `\x1b[38;2;${Number.parseInt(hex.slice(1, 3), 16)};${Number.parseInt(hex.slice(3, 5), 16)};${Number.parseInt(hex.slice(5, 7), 16)}m`
                  : "";
            return sgr ? `${sgr}██\x1b[0m` : "██";
          })
          .join(" ");
        const groupTag = theme.dimText(`[${candidate.group}/${candidate.appearance}]`);
        const nameCol = padRightAnsi(`${activeMark} ${candidate.label}`, 26);
        const line = `${selected ? "▸ " : "  "}${nameCol} ${previewSwatches}  ${groupTag}`;
        const styled = selected
          ? theme.bg(
              "selectionBg",
              theme.fg("selectionFg", padRightAnsi(truncateAnsi(line, inner), inner)),
            )
          : line;
        out.push(boxRow(styled, cols, theme, true));
      });
    }
    out.push(
      boxRow(
        theme.dimText(
          `Border: ${state.config.borderStyle} (/border) · Depth: ${theme.depth} (/colormode) · Custom roles: /colors`,
        ),
        cols,
        theme,
        true,
      ),
    );
    out.push(horizontalBoxBottom(cols, theme, true));
    return out;
  }

  if (overlay.kind === "colors") {
    out.push(
      horizontalBoxTop(
        cols,
        theme.bold("accent", `◆ Color Palette (${theme.label})`),
        theme.dimText("↑/↓ scroll · Esc close · /color <role> <#hex|name|reset>"),
        theme,
        true,
      ),
    );
    const listRows = Math.max(4, maxBodyRows - 4);
    const start = Math.max(
      0,
      Math.min(overlay.scrollOffset, Math.max(0, TUI_COLOR_ROLES.length - listRows)),
    );
    for (const role of TUI_COLOR_ROLES.slice(start, start + listRows)) {
      const value = theme.palette[role];
      const overridden = state.config.colors[role] !== undefined;
      const line = `  ${theme.swatch(role)}  ${padRightAnsi(theme.bold("text", role), 18)} ${padRightAnsi(theme.fg("code", value), 28)} ${overridden ? theme.fg("accent", "(custom)") : theme.dimText("(theme)")}`;
      out.push(boxRow(line, cols, theme, true));
    }
    out.push(
      boxRow(
        theme.dimText("Example: /color accent #ff79c6   |   /color prompt cyan   |   /color reset"),
        cols,
        theme,
        true,
      ),
    );
    out.push(horizontalBoxBottom(cols, theme, true));
    return out;
  }

  if (overlay.kind === "model") {
    const filtered = filterModels(state.modelChoices, overlay.query);
    out.push(
      horizontalBoxTop(
        cols,
        theme.bold("accent", "◆ Select Provider & Model"),
        theme.dimText("type to filter · ↑/↓ select · Enter apply · Esc close"),
        theme,
        true,
      ),
    );
    out.push(
      boxRow(
        `${theme.fg("muted", "Filter: ")}${theme.fg("text", overlay.query || theme.dimText("search model or provider..."))}`,
        cols,
        theme,
        true,
      ),
    );
    out.push(boxRow(theme.fg("border", theme.border.sep.repeat(inner)), cols, theme, true));
    const listRows = Math.max(4, maxBodyRows - 5);
    const clampedIdx = Math.max(0, Math.min(filtered.length - 1, overlay.selectedIndex));
    const start = Math.max(
      0,
      Math.min(clampedIdx - Math.floor(listRows / 2), Math.max(0, filtered.length - listRows)),
    );
    const slice = filtered.slice(start, start + listRows);
    if (slice.length === 0) {
      out.push(boxRow(theme.dimText("No matching models available."), cols, theme, true));
    } else {
      slice.forEach((choice, idx) => {
        const selected = start + idx === clampedIdx;
        const isCurrent =
          state.activeModelSelection?.instanceId === choice.providerInstanceId &&
          state.activeModelSelection?.model === choice.modelSlug;
        const statusDot =
          choice.providerState === "ready"
            ? theme.fg("toolOk", "●")
            : choice.providerState === "warning"
              ? theme.fg("warning", "◐")
              : theme.fg("error", "○");
        const line = `${selected ? "▸ " : "  "}${isCurrent ? "★ " : "  "}${statusDot} ${padRightAnsi(choice.providerLabel, 14)} ${padRightAnsi(choice.modelName, 26)} ${theme.dimText(choice.modelSlug)}`;
        const styled = selected
          ? theme.bg(
              "selectionBg",
              theme.fg("selectionFg", padRightAnsi(truncateAnsi(line, inner), inner)),
            )
          : line;
        out.push(boxRow(styled, cols, theme, true));
      });
    }
    out.push(horizontalBoxBottom(cols, theme, true));
    return out;
  }

  if (overlay.kind === "threads") {
    const filtered = filterThreads(
      state.threads,
      state.activeProject?.id ?? null,
      overlay.allProjects,
      overlay.query,
    );
    out.push(
      horizontalBoxTop(
        cols,
        theme.bold(
          "accent",
          `◆ Threads (${overlay.allProjects ? "All Projects" : (state.activeProject?.title ?? "Project")})`,
        ),
        theme.dimText("Tab scope · ↑/↓ select · Enter open · Esc close"),
        theme,
        true,
      ),
    );
    out.push(
      boxRow(
        `${theme.fg("muted", "Filter: ")}${theme.fg("text", overlay.query || theme.dimText("search thread title..."))}`,
        cols,
        theme,
        true,
      ),
    );
    out.push(boxRow(theme.fg("border", theme.border.sep.repeat(inner)), cols, theme, true));
    const listRows = Math.max(4, maxBodyRows - 5);
    const clampedIdx = Math.max(0, Math.min(filtered.length - 1, overlay.selectedIndex));
    const start = Math.max(
      0,
      Math.min(clampedIdx - Math.floor(listRows / 2), Math.max(0, filtered.length - listRows)),
    );
    const slice = filtered.slice(start, start + listRows);
    if (slice.length === 0) {
      out.push(
        boxRow(
          theme.dimText("No threads yet. Press Esc and type a prompt or run /new."),
          cols,
          theme,
          true,
        ),
      );
    } else {
      slice.forEach((thread, idx) => {
        const selected = start + idx === clampedIdx;
        const currentMark = thread.id === state.activeThreadId ? "●" : " ";
        const stateIcon =
          thread.pendingRuntimeRequest !== null
            ? theme.fg("warning", "⚡")
            : thread.activeRunId !== null
              ? theme.fg("accent", SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length]!)
              : theme.dimText("·");
        const age = formatRelativeTime(thread.updatedAt, state.nowMs ?? 0).padStart(4);
        const titleWidth = Math.max(12, inner - 28);
        const line = `${selected ? "▸ " : "  "}${currentMark} ${stateIcon} ${padRightAnsi(truncateAnsi(thread.title, titleWidth), titleWidth)} ${theme.dimText(truncateAnsi(thread.modelSelection.model, 16))} ${theme.dimText(age)}`;
        const styled = selected
          ? theme.bg(
              "selectionBg",
              theme.fg("selectionFg", padRightAnsi(truncateAnsi(line, inner), inner)),
            )
          : line;
        out.push(boxRow(styled, cols, theme, true));
      });
    }
    out.push(horizontalBoxBottom(cols, theme, true));
    return out;
  }

  if (overlay.kind === "projects") {
    const filtered = filterProjects(state.projects, overlay.query);
    out.push(
      horizontalBoxTop(
        cols,
        theme.bold("accent", "◆ Select Project"),
        theme.dimText("↑/↓ select · Enter open · Esc close"),
        theme,
        true,
      ),
    );
    out.push(
      boxRow(
        `${theme.fg("muted", "Filter: ")}${theme.fg("text", overlay.query || theme.dimText("search project name or path..."))}`,
        cols,
        theme,
        true,
      ),
    );
    out.push(boxRow(theme.fg("border", theme.border.sep.repeat(inner)), cols, theme, true));
    const listRows = Math.max(4, maxBodyRows - 5);
    const clampedIdx = Math.max(0, Math.min(filtered.length - 1, overlay.selectedIndex));
    const start = Math.max(
      0,
      Math.min(clampedIdx - Math.floor(listRows / 2), Math.max(0, filtered.length - listRows)),
    );
    const slice = filtered.slice(start, start + listRows);
    if (slice.length === 0) {
      out.push(boxRow(theme.dimText("No matching projects."), cols, theme, true));
    } else {
      slice.forEach((project, idx) => {
        const selected = start + idx === clampedIdx;
        const activeMark = project.id === state.activeProject?.id ? "●" : " ";
        const line = `${selected ? "▸ " : "  "}${activeMark} ${padRightAnsi(project.title, 22)} ${theme.dimText(project.workspaceRoot)}`;
        const styled = selected
          ? theme.bg(
              "selectionBg",
              theme.fg("selectionFg", padRightAnsi(truncateAnsi(line, inner), inner)),
            )
          : line;
        out.push(boxRow(styled, cols, theme, true));
      });
    }
    out.push(horizontalBoxBottom(cols, theme, true));
    return out;
  }

  if (overlay.kind === "diff") {
    out.push(
      horizontalBoxTop(
        cols,
        theme.bold("accent", `◆ ${overlay.title}`),
        theme.dimText("↑/↓/PgUp/PgDn scroll · Esc close"),
        theme,
        true,
      ),
    );
    const rendered =
      overlay.text.trim().length > 0
        ? renderDiffSnippet(overlay.text, inner, theme, 500)
        : [theme.dimText("No changes in this thread yet.")];
    const listRows = Math.max(4, maxBodyRows - 3);
    const start = Math.max(
      0,
      Math.min(overlay.scrollOffset, Math.max(0, rendered.length - listRows)),
    );
    for (const line of rendered.slice(start, start + listRows)) {
      out.push(boxRow(line, cols, theme, true));
    }
    out.push(horizontalBoxBottom(cols, theme, true));
    return out;
  }

  // Help overlay
  out.push(
    horizontalBoxTop(
      cols,
      theme.bold("accent", "◆ ZeroCode CLI: Shortcuts & Slash Commands"),
      theme.dimText("↑/↓ scroll · Esc close"),
      theme,
      true,
    ),
  );
  const helpRows: Array<string> = [
    theme.bold("text", "Keyboard Shortcuts"),
    `  ${theme.fg("accent", "Enter")}                 Send message / execute slash command`,
    `  ${theme.fg("accent", "Alt+Enter / Ctrl+J")}    Insert newline in composer`,
    `  ${theme.fg("accent", "Esc")}                   Close overlay or interrupt active run`,
    `  ${theme.fg("accent", "Ctrl+K")}                Live Theme Picker (20+ themes + custom)`,
    `  ${theme.fg("accent", "Ctrl+M")}                Provider & Model Picker`,
    `  ${theme.fg("accent", "Ctrl+G")}                Thread Switcher`,
    `  ${theme.fg("accent", "Ctrl+P")}                Project Switcher`,
    `  ${theme.fg("accent", "Ctrl+N")}                Start a new thread`,
    `  ${theme.fg("accent", "Ctrl+T")}                Toggle inline thinking blocks`,
    `  ${theme.fg("accent", "Ctrl+O")}                Cycle tool output (compact/expanded/minimal)`,
    `  ${theme.fg("accent", "PgUp/PgDn / Alt+↑↓")}    Scroll conversation history`,
    `  ${theme.fg("accent", "Ctrl+L")}                Force full redraw`,
    `  ${theme.fg("accent", "Ctrl+C / Ctrl+D")}       Clear / interrupt / exit`,
    "",
    theme.bold("text", "Slash Commands"),
    ...SLASH_COMMANDS.map((cmd) => {
      const name = cmd.args ? `${cmd.name} ${cmd.args}` : cmd.name;
      return `  ${padRightAnsi(theme.bold("accent", name), 28)} ${theme.fg("muted", cmd.description)}`;
    }),
  ];
  const listRows = Math.max(4, maxBodyRows - 3);
  const start = Math.max(
    0,
    Math.min(overlay.scrollOffset, Math.max(0, helpRows.length - listRows)),
  );
  for (const row of helpRows.slice(start, start + listRows)) {
    out.push(boxRow(row, cols, theme, true));
  }
  out.push(horizontalBoxBottom(cols, theme, true));
  return out;
}

function layoutComposer(
  inputText: string,
  inputCursor: number,
  innerWidth: number,
  maxLines: number,
): {
  readonly lines: Array<string>;
  readonly cursorRowOffset: number;
  readonly cursorColOffset: number;
} {
  const usable = Math.max(8, innerWidth - 2); // reserve "❯ " prefix on line 0 / "  " on continuations
  const logicalLines = inputText.split("\n");
  const visual: Array<{ text: string; startIdx: number; endIdx: number }> = [];
  let offset = 0;

  for (let i = 0; i < logicalLines.length; i++) {
    const raw = logicalLines[i]!;
    if (raw.length === 0) {
      visual.push({ text: "", startIdx: offset, endIdx: offset });
    } else {
      let chunk = "";
      let chunkStart = offset;
      let chunkWidth = 0;
      let pos = 0;
      for (const ch of raw) {
        const w = displayWidth(ch);
        if (chunkWidth + w > usable && chunk.length > 0) {
          visual.push({ text: chunk, startIdx: chunkStart, endIdx: chunkStart + chunk.length });
          chunk = ch;
          chunkStart = offset + pos;
          chunkWidth = w;
        } else {
          chunk += ch;
          chunkWidth += w;
        }
        pos += ch.length;
      }
      visual.push({ text: chunk, startIdx: chunkStart, endIdx: chunkStart + chunk.length });
    }
    offset += raw.length + 1;
  }

  let cursorLine = visual.length - 1;
  let cursorCol = 0;
  for (let i = 0; i < visual.length; i++) {
    const seg = visual[i]!;
    if (inputCursor >= seg.startIdx && inputCursor <= seg.endIdx) {
      cursorLine = i;
      cursorCol = displayWidth(seg.text.slice(0, inputCursor - seg.startIdx));
      break;
    }
  }

  const startLine = Math.max(
    0,
    Math.min(cursorLine - maxLines + 1, Math.max(0, visual.length - maxLines)),
  );
  const visible = visual.slice(startLine, startLine + maxLines);
  return {
    lines: visible.map((v) => v.text),
    cursorRowOffset: cursorLine - startLine,
    cursorColOffset: cursorCol,
  };
}

/** Renders the complete TUI viewport, overlays, composer, and status bar for the current terminal size. */
export function renderTuiFrame(state: TuiViewState, rows: number, cols: number): RenderedFrame {
  const { theme } = state;
  const lines: Array<string> = [];

  // 1. Header bar (1 row)
  const connBadge = state.connected
    ? state.isRunning
      ? theme.fg("accent", `${SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length]} running`)
      : theme.fg("toolOk", "● live")
    : state.reconnecting
      ? theme.fg("warning", "◐ reconnecting")
      : theme.fg("error", "○ offline");
  const projectPart = state.activeProject ? state.activeProject.title : "no project";
  const threadTitle =
    state.activeProjection?.thread.title ??
    state.threads.find((t) => t.id === state.activeThreadId)?.title ??
    "new thread";
  const branch = state.activeProjection?.thread.branch;
  const leftTitle =
    `${theme.bold("accent", "ZeroCode")} ${theme.dimText(`v${state.version}`)} ` +
    `${theme.fg("border", "·")} ${theme.bold("text", truncateAnsi(projectPart, 20))}` +
    (branch ? ` ${theme.fg("muted", `(${truncateAnsi(branch, 18)})`)}` : "") +
    ` ${theme.fg("border", "›")} ${theme.fg("text", truncateAnsi(threadTitle, Math.max(12, cols - 54)))}`;
  lines.push(horizontalBoxTop(cols, leftTitle, connBadge, theme, false));

  // 2. Bottom blocks (status bar + composer + optional slash popup / approval card)
  const slashMatches = state.overlay.kind === "none" ? filterSlashCommands(state.inputText) : [];
  const composerInnerWidth = Math.max(12, cols - 4);
  const composerLayout = layoutComposer(state.inputText, state.inputCursor, composerInnerWidth, 5);
  const composerRows: Array<string> = [];
  const composerHeaderRight = state.isRunning
    ? theme.fg("warning", "Esc stop · Enter queue")
    : state.statusMessage
      ? theme.fg("accent", truncateAnsi(state.statusMessage, Math.max(14, cols - 32)))
      : theme.dimText("Enter send · Alt+Enter newline · /help");
  composerRows.push(
    horizontalBoxTop(
      cols,
      theme.bold("prompt", "Prompt"),
      composerHeaderRight,
      theme,
      state.overlay.kind === "none",
    ),
  );
  composerLayout.lines.forEach((line, idx) => {
    const prefix = idx === 0 ? theme.bold("prompt", "❯ ") : "  ";
    const text =
      idx === 0 && state.inputText.length === 0
        ? theme.dimText("Ask anything, type / for commands...")
        : theme.fg("text", line);
    composerRows.push(boxRow(`${prefix}${text}`, cols, theme, state.overlay.kind === "none"));
  });
  composerRows.push(horizontalBoxBottom(cols, theme, state.overlay.kind === "none"));

  const pendingRows =
    state.overlay.kind === "none" && state.pendingInteraction !== null
      ? renderPendingInteractionLines(state.pendingInteraction, cols, theme)
      : [];
  const slashRows =
    state.overlay.kind === "none" && slashMatches.length > 0
      ? renderSlashMenu(slashMatches, state.slashSelectedIndex, cols, theme)
      : [];

  // Status footer (1 row)
  const modelLabel = state.activeModelSelection
    ? `${state.activeModelSelection.instanceId}/${state.activeModelSelection.model}`
    : "no-model";
  const statusLeft = ` ${theme.bold("accent", modelLabel)} ${theme.dimText("│")} ${theme.fg("statusFg", state.runtimeMode)} ${theme.dimText("│")} ${theme.fg("statusFg", `theme:${theme.id}`)}`;
  const statusRight = theme.dimText("^M model · ^K theme · ^G threads · ^P project · ^C quit ");
  const statusGap = Math.max(1, cols - displayWidth(statusLeft) - displayWidth(statusRight));
  const statusLine = theme.bg(
    "statusBg",
    padRightAnsi(
      truncateAnsi(
        statusGap > 1 ? `${statusLeft}${" ".repeat(statusGap)}${statusRight}` : statusLeft,
        cols,
      ),
      cols,
    ),
  );

  const reservedBottom = pendingRows.length + slashRows.length + composerRows.length + 1;
  const viewportHeight = Math.max(3, rows - 1 - reservedBottom - 1); // -1 for viewport bottom border

  // 3. Main viewport OR modal overlay
  const overlayRows = renderOverlayContent(state, cols, viewportHeight + 1);
  if (overlayRows !== null) {
    // Replace main area cleanly with the overlay, padded to keep composer & footer anchored.
    const targetRows = viewportHeight + 1;
    const clipped = overlayRows.slice(0, targetRows);
    while (clipped.length < targetRows) {
      clipped.push(" ".repeat(cols));
    }
    lines.push(...clipped);
  } else {
    const innerWidth = Math.max(16, cols - 4);
    const conversation = buildConversationLines(state, innerWidth);
    const maxScroll = Math.max(0, conversation.length - viewportHeight);
    const effectiveScroll = Math.max(0, Math.min(state.scrollOffset, maxScroll));
    const endIdx = conversation.length - effectiveScroll;
    const startIdx = Math.max(0, endIdx - viewportHeight);
    const visibleSlice = conversation.slice(startIdx, endIdx);

    for (let r = 0; r < viewportHeight; r++) {
      const content = visibleSlice[r] ?? "";
      lines.push(boxRow(content, cols, theme, false));
    }

    const scrollIndicator =
      effectiveScroll > 0
        ? theme.badge(
            "accent",
            "accentText",
            `↓ ${effectiveScroll} line${effectiveScroll === 1 ? "" : "s"} below (End)`,
          )
        : "";
    if (scrollIndicator) {
      const b = theme.border;
      const fill = Math.max(0, cols - 3 - displayWidth(scrollIndicator));
      lines.push(
        theme.fg("border", b.bl + b.h.repeat(fill)) +
          scrollIndicator +
          theme.fg("border", b.h + b.br),
      );
    } else {
      lines.push(horizontalBoxBottom(cols, theme, false));
    }
  }

  lines.push(...pendingRows, ...slashRows, ...composerRows, statusLine);

  // Compute hardware cursor position inside the composer (hidden when an overlay is open).
  const composerFirstContentRow =
    1 + (viewportHeight + 1) + pendingRows.length + slashRows.length + 2; // 1-based terminal row
  const cursor: CursorPosition = {
    row: composerFirstContentRow + composerLayout.cursorRowOffset,
    col: 5 + composerLayout.cursorColOffset, // "│ ❯ " = 4 cols, 1-based -> 5
    visible: state.overlay.kind === "none" && state.pendingInteraction === null,
  };

  return { lines: lines.slice(0, rows), cursor };
}
