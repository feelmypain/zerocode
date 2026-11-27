import { writeFileStringAtomically } from "@zerocode/shared/atomicWrite";
import { fromJsonStringPretty, fromLenientJson } from "@zerocode/shared/schemaJson";
import {
  BUILT_IN_THEMES,
  ZEROCODE_DARK_THEME_COLORS,
  ZEROCODE_LIGHT_THEME_COLORS,
  getThemeColorsForAppearance,
  type ThemeAppearance,
  type ThemeColors,
} from "@zerocode/shared/themePalettes";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { readPublishedThemes } from "../../environmentTheme.ts";

export const TUI_COLOR_MODES = ["auto", "truecolor", "256", "16", "none"] as const;
export type TuiColorMode = (typeof TUI_COLOR_MODES)[number];
export type ResolvedColorDepth = "truecolor" | "256" | "16" | "none";

export const TUI_BORDER_STYLES = ["rounded", "sharp", "minimal", "none"] as const;
export type TuiBorderStyle = (typeof TUI_BORDER_STYLES)[number];

export const TUI_TOOL_DISPLAY_MODES = ["compact", "expanded", "minimal"] as const;
export type TuiToolDisplayMode = (typeof TUI_TOOL_DISPLAY_MODES)[number];

export const TUI_COLOR_ROLES = [
  "accent",
  "accentText",
  "text",
  "muted",
  "dim",
  "border",
  "borderFocused",
  "surface",
  "userBg",
  "userLabel",
  "assistantLabel",
  "thinking",
  "tool",
  "toolOk",
  "toolErr",
  "diffAdd",
  "diffDel",
  "code",
  "codeBg",
  "warning",
  "error",
  "statusBg",
  "statusFg",
  "prompt",
  "selectionBg",
  "selectionFg",
] as const;

export type TuiColorRole = (typeof TUI_COLOR_ROLES)[number];
export type TuiPalette = Readonly<Record<TuiColorRole, string>>;

export interface TuiThemeDefinition {
  readonly id: string;
  readonly label: string;
  readonly group: "zerocode" | "terminal" | "custom";
  readonly appearance: ThemeAppearance;
  readonly palette: TuiPalette;
}

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export type ParsedColor =
  | { readonly kind: "default" }
  | { readonly kind: "rgb"; readonly r: number; readonly g: number; readonly b: number }
  | { readonly kind: "ansi16"; readonly code: number };

export interface BorderGlyphs {
  readonly tl: string;
  readonly tr: string;
  readonly bl: string;
  readonly br: string;
  readonly h: string;
  readonly v: string;
  readonly rail: string;
  readonly sep: string;
}

const BORDER_GLYPHS: Readonly<Record<TuiBorderStyle, BorderGlyphs>> = {
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", rail: "┃", sep: "─" },
  sharp: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", rail: "│", sep: "─" },
  minimal: { tl: " ", tr: " ", bl: " ", br: " ", h: "─", v: " ", rail: "▎", sep: "─" },
  none: { tl: " ", tr: " ", bl: " ", br: " ", h: " ", v: " ", rail: " ", sep: " " },
};

const TuiConfigSchema = Schema.Struct({
  theme: Schema.optional(Schema.String),
  colorMode: Schema.optional(Schema.Literals(TUI_COLOR_MODES)),
  borderStyle: Schema.optional(Schema.Literals(TUI_BORDER_STYLES)),
  showThinking: Schema.optional(Schema.Boolean),
  showTools: Schema.optional(Schema.Literals(TUI_TOOL_DISPLAY_MODES)),
  showTimestamps: Schema.optional(Schema.Boolean),
  mouse: Schema.optional(Schema.Boolean),
  colors: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export interface TuiConfig {
  readonly theme: string;
  readonly colorMode: TuiColorMode;
  readonly borderStyle: TuiBorderStyle;
  readonly showThinking: boolean;
  readonly showTools: TuiToolDisplayMode;
  readonly showTimestamps: boolean;
  readonly mouse: boolean;
  readonly colors: Readonly<Partial<Record<TuiColorRole, string>>>;
}

export const DEFAULT_TUI_CONFIG: TuiConfig = {
  theme: "zerocode-dark",
  colorMode: "auto",
  borderStyle: "rounded",
  showThinking: true,
  showTools: "compact",
  showTimestamps: true,
  mouse: false,
  colors: {},
};

const decodeTuiConfig = Schema.decodeUnknownEffect(fromLenientJson(TuiConfigSchema));
const encodeTuiConfig = Schema.encodeEffect(fromJsonStringPretty(TuiConfigSchema));
const TUI_COLOR_ROLE_SET: ReadonlySet<string> = new Set(TUI_COLOR_ROLES);

export function isTuiColorRole(value: string): value is TuiColorRole {
  return TUI_COLOR_ROLE_SET.has(value);
}

const NAMED_ANSI_COLORS: Readonly<Record<string, number>> = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  gray: 8,
  grey: 8,
  "bright-black": 8,
  "bright-red": 9,
  "bright-green": 10,
  "bright-yellow": 11,
  "bright-blue": 12,
  "bright-magenta": 13,
  "bright-cyan": 14,
  "bright-white": 15,
};

const ANSI16_REFERENCE_RGB: ReadonlyArray<RgbColor> = [
  { r: 0, g: 0, b: 0 },
  { r: 205, g: 49, b: 49 },
  { r: 13, g: 188, b: 121 },
  { r: 229, g: 229, b: 16 },
  { r: 36, g: 114, b: 200 },
  { r: 188, g: 63, b: 188 },
  { r: 17, g: 168, b: 205 },
  { r: 229, g: 229, b: 229 },
  { r: 102, g: 102, b: 102 },
  { r: 241, g: 76, b: 76 },
  { r: 35, g: 209, b: 139 },
  { r: 245, g: 245, b: 67 },
  { r: 59, g: 142, b: 234 },
  { r: 214, g: 112, b: 214 },
  { r: 41, g: 184, b: 219 },
  { r: 255, g: 255, b: 255 },
];

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function linearToSrgbByte(value: number): number {
  const clamped = clamp01(value);
  const srgb = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(clamp01(srgb) * 255);
}

/** Converts CSS OKLCH (L in 0..1 or 0%..100%, C >= 0, H in degrees) to sRGB. */
export function oklchToRgb(l: number, c: number, hDeg: number): RgbColor {
  const hRad = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;

  const rLin = +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const gLin = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bLin = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  return {
    r: linearToSrgbByte(rLin),
    g: linearToSrgbByte(gLin),
    b: linearToSrgbByte(bLin),
  };
}

function rgbToHex({ r, g, b }: RgbColor): string {
  const hex = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

const HEX3_RE = /^#([0-9a-f]{3})$/i;
const HEX6_RE = /^#([0-9a-f]{6})$/i;
const OKLCH_RE =
  /^oklch\(\s*([+-]?\d*\.?\d+%?)\s+([+-]?\d*\.?\d+)\s+([+-]?\d*\.?\d+)(?:deg)?(?:\s*\/\s*[^)]+)?\s*\)$/i;
const RGB_RE = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;

export function parseColorSpec(raw: string): ParsedColor | null {
  const spec = raw.trim().toLowerCase();
  if (!spec || spec === "default" || spec === "none" || spec === "transparent") {
    return { kind: "default" };
  }
  const ansiNamed = NAMED_ANSI_COLORS[spec];
  if (ansiNamed !== undefined) {
    return { kind: "ansi16", code: ansiNamed };
  }
  if (/^ansi(\d{1,2})$/.test(spec)) {
    const code = Number.parseInt(spec.slice(4), 10);
    if (code >= 0 && code <= 15) return { kind: "ansi16", code };
    return null;
  }
  const hex6 = HEX6_RE.exec(spec);
  if (hex6?.[1]) {
    const value = Number.parseInt(hex6[1], 16);
    return { kind: "rgb", r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
  }
  const hex3 = HEX3_RE.exec(spec);
  if (hex3?.[1]) {
    const [r, g, b] = hex3[1].split("").map((ch) => Number.parseInt(ch + ch, 16));
    return { kind: "rgb", r: r!, g: g!, b: b! };
  }
  const oklch = OKLCH_RE.exec(spec);
  if (oklch?.[1] && oklch[2] && oklch[3]) {
    const rawL = oklch[1];
    const l = rawL.endsWith("%") ? Number.parseFloat(rawL) / 100 : Number.parseFloat(rawL);
    const c = Number.parseFloat(oklch[2]);
    const h = Number.parseFloat(oklch[3]);
    if (Number.isFinite(l) && Number.isFinite(c) && Number.isFinite(h)) {
      const rgb = oklchToRgb(l, c, h);
      return { kind: "rgb", ...rgb };
    }
  }
  const rgbMatch = RGB_RE.exec(spec);
  if (rgbMatch?.[1] && rgbMatch[2] && rgbMatch[3]) {
    const r = Number.parseInt(rgbMatch[1], 10);
    const g = Number.parseInt(rgbMatch[2], 10);
    const b = Number.parseInt(rgbMatch[3], 10);
    if (r <= 255 && g <= 255 && b <= 255) {
      return { kind: "rgb", r, g, b };
    }
  }
  return null;
}

function colorDistSq(a: RgbColor, b: RgbColor): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

/** Nearest xterm-256 palette index (16..255) for an RGB color. */
export function rgbToAnsi256({ r, g, b }: RgbColor): number {
  const cubeLevels = [0, 95, 135, 175, 215, 255];
  const nearestCubeIdx = (v: number) => {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < cubeLevels.length; i++) {
      const d = Math.abs(v - cubeLevels[i]!);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  };
  const ri = nearestCubeIdx(r);
  const gi = nearestCubeIdx(g);
  const bi = nearestCubeIdx(b);
  const cubeColor = { r: cubeLevels[ri]!, g: cubeLevels[gi]!, b: cubeLevels[bi]! };
  const cubeIndex = 16 + 36 * ri + 6 * gi + bi;

  const avg = Math.round((r + g + b) / 3);
  const grayStep = avg < 4 ? 0 : avg > 243 ? 23 : Math.round((avg - 8) / 10);
  const grayLevel = 8 + grayStep * 10;
  const grayColor = { r: grayLevel, g: grayLevel, b: grayLevel };
  const grayIndex = 232 + Math.max(0, Math.min(23, grayStep));

  return colorDistSq({ r, g, b }, grayColor) < colorDistSq({ r, g, b }, cubeColor)
    ? grayIndex
    : cubeIndex;
}

export function rgbToAnsi16(rgb: RgbColor): number {
  let best = 7;
  let bestDist = Infinity;
  for (let i = 0; i < ANSI16_REFERENCE_RGB.length; i++) {
    const d = colorDistSq(rgb, ANSI16_REFERENCE_RGB[i]!);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

export function detectColorDepth(
  mode: TuiColorMode,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedColorDepth {
  if (mode !== "auto") return mode;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if (env.TERM === "dumb") return "none";
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm.includes("truecolor") || colorterm.includes("24bit")) return "truecolor";
  const term = (env.TERM ?? "").toLowerCase();
  if (term.includes("256color") || env.WT_SESSION || env.TERM_PROGRAM) return "truecolor";
  if (term.includes("color") || term.includes("xterm") || term.includes("screen")) return "256";
  return "16";
}

function ansi16Sgr(code: number, background: boolean): string {
  if (code < 8) return `${background ? 40 + code : 30 + code}`;
  return `${background ? 100 + (code - 8) : 90 + (code - 8)}`;
}

export function colorToSgr(spec: string, depth: ResolvedColorDepth, background = false): string {
  if (depth === "none") return "";
  const parsed = parseColorSpec(spec);
  if (!parsed || parsed.kind === "default") return "";
  if (parsed.kind === "ansi16") {
    return `\x1b[${ansi16Sgr(parsed.code, background)}m`;
  }
  if (depth === "truecolor") {
    return `\x1b[${background ? 48 : 38};2;${parsed.r};${parsed.g};${parsed.b}m`;
  }
  if (depth === "256") {
    return `\x1b[${background ? 48 : 38};5;${rgbToAnsi256(parsed)}m`;
  }
  return `\x1b[${ansi16Sgr(rgbToAnsi16(parsed), background)}m`;
}

function colorFromPalette(colors: ThemeColors, role: keyof ThemeColors, fallback: string): string {
  const value = colors[role];
  if (!value) return fallback;
  const parsed = parseColorSpec(value);
  if (!parsed || parsed.kind === "default") return fallback;
  return parsed.kind === "rgb" ? rgbToHex(parsed) : value;
}

function tuiPaletteFromZeroCodeTheme(colors: ThemeColors, appearance: ThemeAppearance): TuiPalette {
  const dark = appearance === "dark";
  return {
    accent: colorFromPalette(colors, "accent", dark ? "#60a5fa" : "#1b4ed8"),
    accentText: colorFromPalette(colors, "accentForeground", dark ? "#ffffff" : "#ffffff"),
    text: colorFromPalette(colors, "text", dark ? "#f5f5f5" : "#27272a"),
    muted: colorFromPalette(colors, "textMuted", dark ? "#9ca3af" : "#71717b"),
    dim: colorFromPalette(colors, "placeholder", dark ? "#6b7280" : "#8b8b96"),
    border: colorFromPalette(colors, "border", dark ? "#30363d" : "#d4d4d8"),
    borderFocused: colorFromPalette(colors, "focus", dark ? "#60a5fa" : "#1b4ed8"),
    surface: colorFromPalette(colors, "surface", dark ? "#141418" : "#f4f4f5"),
    userBg: colorFromPalette(colors, "messageSurface", dark ? "#1c1f26" : "#eceef2"),
    userLabel: colorFromPalette(colors, "accent", dark ? "#60a5fa" : "#1b4ed8"),
    assistantLabel: colorFromPalette(colors, "updateForeground", dark ? "#7dd3fc" : "#0369a1"),
    thinking: colorFromPalette(colors, "mutedForeground", dark ? "#94a3b8" : "#64748b"),
    tool: colorFromPalette(colors, "warningForeground", dark ? "#f59e0b" : "#b45309"),
    toolOk: dark ? "#4ade80" : "#15803d",
    toolErr: colorFromPalette(colors, "errorForeground", dark ? "#f87171" : "#b91c1c"),
    diffAdd: dark ? "#4ade80" : "#15803d",
    diffDel: colorFromPalette(colors, "errorForeground", dark ? "#f87171" : "#b91c1c"),
    code: colorFromPalette(colors, "codeForeground", dark ? "#e2e8f0" : "#1e293b"),
    codeBg: colorFromPalette(colors, "codeBackground", dark ? "#161821" : "#f1f5f9"),
    warning: colorFromPalette(colors, "warningForeground", dark ? "#fbbf24" : "#b45309"),
    error: colorFromPalette(colors, "errorForeground", dark ? "#f87171" : "#dc2626"),
    statusBg: colorFromPalette(colors, "toolbar", dark ? "#111318" : "#e4e4e7"),
    statusFg: colorFromPalette(colors, "toolbarForeground", dark ? "#e5e7eb" : "#27272a"),
    prompt: colorFromPalette(colors, "accent", dark ? "#60a5fa" : "#1b4ed8"),
    selectionBg: colorFromPalette(colors, "accent", dark ? "#346bf1" : "#1b4ed8"),
    selectionFg: colorFromPalette(colors, "accentForeground", "#ffffff"),
  };
}

function buildZeroCodeNativeThemes(): Array<TuiThemeDefinition> {
  const list: Array<TuiThemeDefinition> = [
    {
      id: "zerocode-dark",
      label: "ZeroCode Dark",
      group: "zerocode",
      appearance: "dark",
      palette: tuiPaletteFromZeroCodeTheme(ZEROCODE_DARK_THEME_COLORS, "dark"),
    },
    {
      id: "zerocode-light",
      label: "ZeroCode Light",
      group: "zerocode",
      appearance: "light",
      palette: tuiPaletteFromZeroCodeTheme(ZEROCODE_LIGHT_THEME_COLORS, "light"),
    },
  ];
  for (const theme of BUILT_IN_THEMES) {
    const darkColors = getThemeColorsForAppearance(theme, "dark");
    const lightColors = getThemeColorsForAppearance(theme, "light");
    if (darkColors) {
      list.push({
        id: theme.appearance === "dark" ? theme.id : `${theme.id}-dark`,
        label: `${theme.label} Dark`,
        group: "zerocode",
        appearance: "dark",
        palette: tuiPaletteFromZeroCodeTheme(darkColors, "dark"),
      });
    }
    if (lightColors) {
      list.push({
        id: theme.appearance === "light" ? theme.id : `${theme.id}-light`,
        label: `${theme.label} Light`,
        group: "zerocode",
        appearance: "light",
        palette: tuiPaletteFromZeroCodeTheme(lightColors, "light"),
      });
    }
  }
  return list;
}

const TERMINAL_PRESET_THEMES: ReadonlyArray<TuiThemeDefinition> = [
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    group: "terminal",
    appearance: "dark",
    palette: {
      accent: "#7aa2f7",
      accentText: "#1a1b26",
      text: "#c0caf5",
      muted: "#787c99",
      dim: "#565f89",
      border: "#3b4261",
      borderFocused: "#7aa2f7",
      surface: "#1f2335",
      userBg: "#24283b",
      userLabel: "#7aa2f7",
      assistantLabel: "#bb9af7",
      thinking: "#7dcfff",
      tool: "#e0af68",
      toolOk: "#9ece6a",
      toolErr: "#f7768e",
      diffAdd: "#9ece6a",
      diffDel: "#f7768e",
      code: "#c0caf5",
      codeBg: "#16161e",
      warning: "#e0af68",
      error: "#f7768e",
      statusBg: "#16161e",
      statusFg: "#a9b1d6",
      prompt: "#7dcfff",
      selectionBg: "#33467c",
      selectionFg: "#c0caf5",
    },
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    group: "terminal",
    appearance: "dark",
    palette: {
      accent: "#cba6f7",
      accentText: "#1e1e2e",
      text: "#cdd6f4",
      muted: "#9399b2",
      dim: "#6c7086",
      border: "#45475a",
      borderFocused: "#cba6f7",
      surface: "#181825",
      userBg: "#313244",
      userLabel: "#89b4fa",
      assistantLabel: "#cba6f7",
      thinking: "#94e2d5",
      tool: "#fab387",
      toolOk: "#a6e3a1",
      toolErr: "#f38ba8",
      diffAdd: "#a6e3a1",
      diffDel: "#f38ba8",
      code: "#cdd6f4",
      codeBg: "#11111b",
      warning: "#f9e2af",
      error: "#f38ba8",
      statusBg: "#181825",
      statusFg: "#bac2de",
      prompt: "#f5c2e7",
      selectionBg: "#45475a",
      selectionFg: "#cdd6f4",
    },
  },
  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    group: "terminal",
    appearance: "light",
    palette: {
      accent: "#8839ef",
      accentText: "#eff1f5",
      text: "#4c4f69",
      muted: "#6c6f85",
      dim: "#8c8fa1",
      border: "#bcc0cc",
      borderFocused: "#8839ef",
      surface: "#e6e9ef",
      userBg: "#dce0e8",
      userLabel: "#1e66f5",
      assistantLabel: "#8839ef",
      thinking: "#179299",
      tool: "#fe640b",
      toolOk: "#40a02b",
      toolErr: "#d20f39",
      diffAdd: "#40a02b",
      diffDel: "#d20f39",
      code: "#4c4f69",
      codeBg: "#dce0e8",
      warning: "#df8e1d",
      error: "#d20f39",
      statusBg: "#dce0e8",
      statusFg: "#4c4f69",
      prompt: "#8839ef",
      selectionBg: "#8839ef",
      selectionFg: "#eff1f5",
    },
  },
  {
    id: "gruvbox-dark",
    label: "Gruvbox Dark",
    group: "terminal",
    appearance: "dark",
    palette: {
      accent: "#fe8019",
      accentText: "#282828",
      text: "#ebdbb2",
      muted: "#a89984",
      dim: "#7c6f64",
      border: "#504945",
      borderFocused: "#fe8019",
      surface: "#32302f",
      userBg: "#3c3836",
      userLabel: "#fabd2f",
      assistantLabel: "#83a598",
      thinking: "#8ec07c",
      tool: "#fe8019",
      toolOk: "#b8bb26",
      toolErr: "#fb4934",
      diffAdd: "#b8bb26",
      diffDel: "#fb4934",
      code: "#ebdbb2",
      codeBg: "#1d2021",
      warning: "#fabd2f",
      error: "#fb4934",
      statusBg: "#1d2021",
      statusFg: "#d5c4a1",
      prompt: "#fe8019",
      selectionBg: "#504945",
      selectionFg: "#fbf1c7",
    },
  },
  {
    id: "nord",
    label: "Nord",
    group: "terminal",
    appearance: "dark",
    palette: {
      accent: "#88c0d0",
      accentText: "#2e3440",
      text: "#eceff4",
      muted: "#9aa5b8",
      dim: "#616e88",
      border: "#434c5e",
      borderFocused: "#88c0d0",
      surface: "#3b4252",
      userBg: "#3b4252",
      userLabel: "#81a1c1",
      assistantLabel: "#88c0d0",
      thinking: "#8fbcbb",
      tool: "#ebcb8b",
      toolOk: "#a3be8c",
      toolErr: "#bf616a",
      diffAdd: "#a3be8c",
      diffDel: "#bf616a",
      code: "#e5e9f0",
      codeBg: "#2e3440",
      warning: "#ebcb8b",
      error: "#bf616a",
      statusBg: "#2e3440",
      statusFg: "#d8dee9",
      prompt: "#88c0d0",
      selectionBg: "#4c566a",
      selectionFg: "#eceff4",
    },
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    group: "terminal",
    appearance: "dark",
    palette: {
      accent: "#ebbcba",
      accentText: "#191724",
      text: "#e0def4",
      muted: "#908caa",
      dim: "#6e6a86",
      border: "#403d52",
      borderFocused: "#ebbcba",
      surface: "#1f1d2e",
      userBg: "#26233a",
      userLabel: "#c4a7e7",
      assistantLabel: "#ebbcba",
      thinking: "#9ccfd8",
      tool: "#f6c177",
      toolOk: "#31748f",
      toolErr: "#eb6f92",
      diffAdd: "#9ccfd8",
      diffDel: "#eb6f92",
      code: "#e0def4",
      codeBg: "#191724",
      warning: "#f6c177",
      error: "#eb6f92",
      statusBg: "#1f1d2e",
      statusFg: "#e0def4",
      prompt: "#c4a7e7",
      selectionBg: "#403d52",
      selectionFg: "#e0def4",
    },
  },
  {
    id: "kanagawa",
    label: "Kanagawa",
    group: "terminal",
    appearance: "dark",
    palette: {
      accent: "#7e9cd8",
      accentText: "#1f1f28",
      text: "#dcd7ba",
      muted: "#938aa9",
      dim: "#727169",
      border: "#363646",
      borderFocused: "#7e9cd8",
      surface: "#2a2a37",
      userBg: "#2a2a37",
      userLabel: "#7e9cd8",
      assistantLabel: "#957fb8",
      thinking: "#7fb4ca",
      tool: "#dca561",
      toolOk: "#98bb6c",
      toolErr: "#e46876",
      diffAdd: "#98bb6c",
      diffDel: "#e46876",
      code: "#dcd7ba",
      codeBg: "#16161d",
      warning: "#e6c384",
      error: "#e46876",
      statusBg: "#16161d",
      statusFg: "#c8c093",
      prompt: "#7fb4ca",
      selectionBg: "#2d4f67",
      selectionFg: "#dcd7ba",
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    group: "terminal",
    appearance: "dark",
    palette: {
      accent: "#bd93f9",
      accentText: "#282a36",
      text: "#f8f8f2",
      muted: "#9ea4c6",
      dim: "#6272a4",
      border: "#44475a",
      borderFocused: "#bd93f9",
      surface: "#282a36",
      userBg: "#343746",
      userLabel: "#8be9fd",
      assistantLabel: "#bd93f9",
      thinking: "#ff79c6",
      tool: "#ffb86c",
      toolOk: "#50fa7b",
      toolErr: "#ff5555",
      diffAdd: "#50fa7b",
      diffDel: "#ff5555",
      code: "#f8f8f2",
      codeBg: "#21222c",
      warning: "#f1fa8c",
      error: "#ff5555",
      statusBg: "#21222c",
      statusFg: "#f8f8f2",
      prompt: "#ff79c6",
      selectionBg: "#44475a",
      selectionFg: "#f8f8f2",
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    group: "terminal",
    appearance: "dark",
    palette: {
      accent: "#2aa198",
      accentText: "#002b36",
      text: "#93a1a1",
      muted: "#657b83",
      dim: "#586e75",
      border: "#073642",
      borderFocused: "#2aa198",
      surface: "#073642",
      userBg: "#073642",
      userLabel: "#268bd2",
      assistantLabel: "#2aa198",
      thinking: "#6c71c4",
      tool: "#b58900",
      toolOk: "#859900",
      toolErr: "#dc322f",
      diffAdd: "#859900",
      diffDel: "#dc322f",
      code: "#93a1a1",
      codeBg: "#002b36",
      warning: "#cb4b16",
      error: "#dc322f",
      statusBg: "#073642",
      statusFg: "#93a1a1",
      prompt: "#2aa198",
      selectionBg: "#073642",
      selectionFg: "#eee8d5",
    },
  },
  {
    id: "monokai",
    label: "Monokai Pro",
    group: "terminal",
    appearance: "dark",
    palette: {
      accent: "#ffd866",
      accentText: "#2d2a2e",
      text: "#fcfcfa",
      muted: "#939293",
      dim: "#727072",
      border: "#403e41",
      borderFocused: "#ffd866",
      surface: "#2d2a2e",
      userBg: "#383539",
      userLabel: "#78dce8",
      assistantLabel: "#ab9df2",
      thinking: "#78dce8",
      tool: "#fc9867",
      toolOk: "#a9dc76",
      toolErr: "#ff6188",
      diffAdd: "#a9dc76",
      diffDel: "#ff6188",
      code: "#fcfcfa",
      codeBg: "#221f22",
      warning: "#ffd866",
      error: "#ff6188",
      statusBg: "#221f22",
      statusFg: "#fcfcfa",
      prompt: "#ff6188",
      selectionBg: "#49464a",
      selectionFg: "#fcfcfa",
    },
  },
  {
    id: "ansi",
    label: "Terminal ANSI (Native)",
    group: "terminal",
    appearance: "dark",
    palette: {
      accent: "cyan",
      accentText: "black",
      text: "default",
      muted: "gray",
      dim: "gray",
      border: "gray",
      borderFocused: "cyan",
      surface: "default",
      userBg: "default",
      userLabel: "blue",
      assistantLabel: "magenta",
      thinking: "gray",
      tool: "yellow",
      toolOk: "green",
      toolErr: "red",
      diffAdd: "green",
      diffDel: "red",
      code: "bright-white",
      codeBg: "default",
      warning: "yellow",
      error: "red",
      statusBg: "default",
      statusFg: "white",
      prompt: "cyan",
      selectionBg: "blue",
      selectionFg: "bright-white",
    },
  },
];

export const BUILT_IN_TUI_THEMES: ReadonlyArray<TuiThemeDefinition> = [
  ...buildZeroCodeNativeThemes(),
  ...TERMINAL_PRESET_THEMES,
];

export interface ResolvedTuiTheme {
  readonly id: string;
  readonly label: string;
  readonly appearance: ThemeAppearance;
  readonly depth: ResolvedColorDepth;
  readonly border: BorderGlyphs;
  readonly palette: TuiPalette;
  readonly fg: (role: TuiColorRole, text: string) => string;
  readonly bg: (role: TuiColorRole, text: string) => string;
  readonly bold: (role: TuiColorRole, text: string) => string;
  readonly dimText: (text: string) => string;
  readonly italic: (role: TuiColorRole, text: string) => string;
  readonly badge: (bgRole: TuiColorRole, fgRole: TuiColorRole, text: string) => string;
  readonly swatch: (role: TuiColorRole) => string;
}

export function resolveTuiTheme(
  themes: ReadonlyArray<TuiThemeDefinition>,
  config: TuiConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedTuiTheme {
  const base =
    themes.find((theme) => theme.id === config.theme) ??
    themes.find((theme) => theme.id === DEFAULT_TUI_CONFIG.theme) ??
    BUILT_IN_TUI_THEMES[0]!;
  const depth = detectColorDepth(config.colorMode, env);
  const border = BORDER_GLYPHS[config.borderStyle] ?? BORDER_GLYPHS.rounded;
  const merged: Record<TuiColorRole, string> = { ...base.palette };
  for (const role of TUI_COLOR_ROLES) {
    const override = config.colors[role];
    if (override !== undefined && parseColorSpec(override) !== null) {
      merged[role] = override;
    }
  }
  const fgCodes: Record<TuiColorRole, string> = {} as Record<TuiColorRole, string>;
  const bgCodes: Record<TuiColorRole, string> = {} as Record<TuiColorRole, string>;
  for (const role of TUI_COLOR_ROLES) {
    fgCodes[role] = colorToSgr(merged[role], depth, false);
    bgCodes[role] = colorToSgr(merged[role], depth, true);
  }
  const reset = depth === "none" ? "" : "\x1b[0m";
  const wrap = (prefix: string, text: string) =>
    prefix.length === 0 || text.length === 0 ? text : `${prefix}${text}${reset}`;

  return {
    id: base.id,
    label: base.label,
    appearance: base.appearance,
    depth,
    border,
    palette: merged,
    fg: (role, text) => wrap(fgCodes[role], text),
    bg: (role, text) => wrap(bgCodes[role], text),
    bold: (role, text) => (depth === "none" ? text : wrap(`\x1b[1m${fgCodes[role]}`, text)),
    dimText: (text) => (depth === "none" ? text : wrap(`\x1b[2m${fgCodes.dim}`, text)),
    italic: (role, text) => (depth === "none" ? text : wrap(`\x1b[3m${fgCodes[role]}`, text)),
    badge: (bgRole, fgRole, text) =>
      depth === "none"
        ? `[${text}]`
        : wrap(`${bgCodes[bgRole]}${fgCodes[fgRole]}\x1b[1m`, ` ${text} `),
    swatch: (role) => (depth === "none" ? "[]" : wrap(fgCodes[role], "██")),
  };
}

export const TUI_CONFIG_FILENAME = "cli-tui.json";

export const loadCustomZeroCodeThemes = Effect.fn("cli.tui.loadCustomThemes")(function* (
  themesDir: string,
) {
  const published = yield* readPublishedThemes(themesDir).pipe(Effect.orElseSucceed(() => []));
  const custom: Array<TuiThemeDefinition> = [];
  for (const item of published) {
    const appearance: ThemeAppearance = item.appearance;
    const baseColors =
      appearance === "dark" ? ZEROCODE_DARK_THEME_COLORS : ZEROCODE_LIGHT_THEME_COLORS;
    const mergedColors = { ...baseColors, ...item.colors } as ThemeColors;
    if (item.accent) {
      (mergedColors as Record<string, string>).accent = item.accent;
      (mergedColors as Record<string, string>).focus = item.accent;
    }
    if (item.canvas) {
      (mergedColors as Record<string, string>).canvas = item.canvas;
    }
    custom.push({
      id: item.id,
      label: `${item.name} (custom)`,
      group: "custom",
      appearance,
      palette: tuiPaletteFromZeroCodeTheme(mergedColors, appearance),
    });
  }
  return custom;
});

export const loadTuiConfig = Effect.fn("cli.tui.loadConfig")(function* (configPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => null));
  if (raw === null) return DEFAULT_TUI_CONFIG;
  const parsed = yield* decodeTuiConfig(raw).pipe(Effect.orElseSucceed(() => null));
  if (parsed === null) return DEFAULT_TUI_CONFIG;
  const colors: Partial<Record<TuiColorRole, string>> = {};
  if (parsed.colors) {
    for (const [key, value] of Object.entries(parsed.colors)) {
      if (isTuiColorRole(key) && parseColorSpec(value) !== null) {
        colors[key] = value;
      }
    }
  }
  return {
    theme: parsed.theme ?? DEFAULT_TUI_CONFIG.theme,
    colorMode: parsed.colorMode ?? DEFAULT_TUI_CONFIG.colorMode,
    borderStyle: parsed.borderStyle ?? DEFAULT_TUI_CONFIG.borderStyle,
    showThinking: parsed.showThinking ?? DEFAULT_TUI_CONFIG.showThinking,
    showTools: parsed.showTools ?? DEFAULT_TUI_CONFIG.showTools,
    showTimestamps: parsed.showTimestamps ?? DEFAULT_TUI_CONFIG.showTimestamps,
    mouse: parsed.mouse ?? DEFAULT_TUI_CONFIG.mouse,
    colors,
  } satisfies TuiConfig;
});

export const saveTuiConfig = Effect.fn("cli.tui.saveConfig")(function* (
  configPath: string,
  config: TuiConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(configPath), { recursive: true });
  const encoded = yield* encodeTuiConfig({
    theme: config.theme,
    colorMode: config.colorMode,
    borderStyle: config.borderStyle,
    showThinking: config.showThinking,
    showTools: config.showTools,
    showTimestamps: config.showTimestamps,
    mouse: config.mouse,
    colors: config.colors as Record<string, string>,
  });
  yield* writeFileStringAtomically({ filePath: configPath, contents: `${encoded}\n` });
});
