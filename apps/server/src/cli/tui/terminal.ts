// ANSI CSI / OSC sequence matcher for accurate display-width measurement and slicing.
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/gu;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

function isCombiningCodePoint(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200d ||
    cp === 0x200c
  );
}

function isWideCodePoint(cp: number): boolean {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0x3247 && cp !== 0x303f) ||
      (cp >= 0x3250 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0xa4c6) ||
      (cp >= 0xa960 && cp <= 0xa97c) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6b) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  );
}

function charDisplayWidth(char: string): number {
  const cp = char.codePointAt(0);
  if (cp === undefined || cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (isCombiningCodePoint(cp)) return 0;
  if (isWideCodePoint(cp)) return 2;
  return 1;
}

export function displayWidth(text: string): number {
  const plain = stripAnsi(text);
  let width = 0;
  for (const ch of plain) {
    width += charDisplayWidth(ch);
  }
  return width;
}

/** Truncates ANSI-styled text to `maxWidth` columns, preserving active SGR escapes and resetting cleanly. */
export function truncateAnsi(text: string, maxWidth: number, ellipsis = "…"): string {
  if (maxWidth <= 0) return "";
  if (displayWidth(text) <= maxWidth) return text;
  const ellipsisWidth = displayWidth(ellipsis);
  const limit = Math.max(0, maxWidth - ellipsisWidth);
  let out = "";
  let width = 0;
  let i = 0;
  let sawEscape = false;
  while (i < text.length) {
    if (text.charCodeAt(i) === 0x1b) {
      ANSI_ESCAPE_RE.lastIndex = i;
      const match = ANSI_ESCAPE_RE.exec(text);
      if (match && match.index === i) {
        out += match[0];
        sawEscape = true;
        i += match[0].length;
        continue;
      }
    }
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const w = charDisplayWidth(ch);
    if (width + w > limit) break;
    out += ch;
    width += w;
    i += ch.length;
  }
  return `${out}${sawEscape ? "\x1b[0m" : ""}${ellipsisWidth <= maxWidth ? ellipsis : ""}`;
}

export function padRightAnsi(text: string, targetWidth: number): string {
  const current = displayWidth(text);
  if (current >= targetWidth) return truncateAnsi(text, targetWidth, "");
  return `${text}${" ".repeat(targetWidth - current)}`;
}

/** Word-wraps plain text to `maxWidth` terminal columns (handles long tokens and wide glyphs). */
export function wrapPlainText(text: string, maxWidth: number): Array<string> {
  const width = Math.max(1, maxWidth);
  const result: Array<string> = [];
  for (const rawLine of text.replaceAll("\r\n", "\n").split("\n")) {
    if (rawLine.length === 0) {
      result.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    const tokens = rawLine.match(/\S+|\s+/gu) ?? [rawLine];
    for (const token of tokens) {
      const tokenWidth = displayWidth(token);
      if (currentWidth === 0 && /^\s+$/.test(token)) {
        // Keep leading indentation on the first line of a paragraph.
        if (result.length === 0 || current === "") {
          if (tokenWidth < width) {
            current += token;
            currentWidth += tokenWidth;
          }
        }
        continue;
      }
      if (currentWidth + tokenWidth <= width) {
        current += token;
        currentWidth += tokenWidth;
        continue;
      }
      if (currentWidth > 0) {
        result.push(current.trimEnd());
        current = "";
        currentWidth = 0;
      }
      if (/^\s+$/.test(token)) continue;
      if (tokenWidth <= width) {
        current = token;
        currentWidth = tokenWidth;
      } else {
        // Break oversized tokens cleanly by grapheme width.
        let chunk = "";
        let chunkWidth = 0;
        for (const ch of token) {
          const w = charDisplayWidth(ch);
          if (chunkWidth + w > width && chunk.length > 0) {
            result.push(chunk);
            chunk = ch;
            chunkWidth = w;
          } else {
            chunk += ch;
            chunkWidth += w;
          }
        }
        current = chunk;
        currentWidth = chunkWidth;
      }
    }
    if (current.length > 0 || currentWidth === 0) {
      result.push(current);
    }
  }
  return result.length > 0 ? result : [""];
}

/** Wraps text that may contain ANSI SGR escapes, re-emitting active SGR styles across wrapped lines. */
export function wrapAnsiText(text: string, maxWidth: number): Array<string> {
  const width = Math.max(1, maxWidth);
  const out: Array<string> = [];
  for (const rawLine of text.replaceAll("\r\n", "\n").split("\n")) {
    if (displayWidth(rawLine) <= width) {
      out.push(rawLine);
      continue;
    }
    let activeSgr = "";
    let line = "";
    let lineWidth = 0;
    let i = 0;
    while (i < rawLine.length) {
      if (rawLine.charCodeAt(i) === 0x1b) {
        ANSI_ESCAPE_RE.lastIndex = i;
        const match = ANSI_ESCAPE_RE.exec(rawLine);
        if (match && match.index === i) {
          const seq = match[0];
          line += seq;
          activeSgr = seq === "\x1b[0m" || seq === "\x1b[m" ? "" : `${activeSgr}${seq}`;
          i += seq.length;
          continue;
        }
      }
      const cp = rawLine.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      const w = charDisplayWidth(ch);
      if (lineWidth + w > width && lineWidth > 0) {
        out.push(activeSgr ? `${line}\x1b[0m` : line);
        line = activeSgr + ch;
        lineWidth = w;
      } else {
        line += ch;
        lineWidth += w;
      }
      i += ch.length;
    }
    out.push(line);
  }
  return out;
}

export interface CursorPosition {
  readonly row: number; // 1-based terminal row
  readonly col: number; // 1-based terminal column
  readonly visible: boolean;
}

export interface RenderedFrame {
  readonly lines: ReadonlyArray<string>;
  readonly cursor: CursorPosition;
}

/** Differential terminal screen buffer with DEC synchronized updates (zero flicker). */
export class ScreenBuffer {
  private prevLines: Array<string> = [];
  private prevRows = 0;
  private prevCols = 0;

  reset(): void {
    this.prevLines = [];
    this.prevRows = 0;
    this.prevCols = 0;
  }

  diff(frame: RenderedFrame, rows: number, cols: number): string {
    const resized = rows !== this.prevRows || cols !== this.prevCols;
    const chunks: Array<string> = ["\x1b[?2026h\x1b[?25l"];
    if (resized) {
      chunks.push("\x1b[2J\x1b[H");
      this.prevLines = [];
      this.prevRows = rows;
      this.prevCols = cols;
    }
    for (let r = 0; r < rows; r++) {
      const nextLine = frame.lines[r] ?? "";
      if (resized || this.prevLines[r] !== nextLine) {
        chunks.push(`\x1b[${r + 1};1H\x1b[2K${nextLine}\x1b[0m`);
        this.prevLines[r] = nextLine;
      }
    }
    if (frame.cursor.visible) {
      const clampedRow = Math.max(1, Math.min(rows, frame.cursor.row));
      const clampedCol = Math.max(1, Math.min(cols, frame.cursor.col));
      chunks.push(`\x1b[${clampedRow};${clampedCol}H\x1b[?25h`);
    }
    chunks.push("\x1b[?2026l");
    return chunks.join("");
  }
}

export interface TerminalController {
  readonly enter: (mouseEnabled: boolean) => void;
  readonly setMouse: (enabled: boolean) => void;
  readonly write: (data: string) => void;
  readonly leave: () => void;
  readonly size: () => { readonly rows: number; readonly cols: number };
}

export function createStdioTerminal(): TerminalController {
  let active = false;
  let mouse = false;
  const stdout = process.stdout;
  const stdin = process.stdin;

  const write = (data: string) => {
    if (data.length > 0) stdout.write(data);
  };

  const setMouse = (enabled: boolean) => {
    if (mouse === enabled) return;
    mouse = enabled;
    if (active) {
      write(enabled ? "\x1b[?1000h\x1b[?1006h" : "\x1b[?1000l\x1b[?1006l");
    }
  };

  const enter = (mouseEnabled: boolean) => {
    if (active) return;
    active = true;
    mouse = mouseEnabled;
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
    }
    stdin.resume();
    write(
      "\x1b[?1049h" + // Alternate screen buffer
        "\x1b[?2004h" + // Bracketed paste mode
        "\x1b[2J\x1b[H" +
        (mouseEnabled ? "\x1b[?1000h\x1b[?1006h" : ""),
    );
  };

  const leave = () => {
    if (!active) return;
    active = false;
    write(
      (mouse ? "\x1b[?1000l\x1b[?1006l" : "") +
        "\x1b[?2004l" +
        "\x1b[?25h" +
        "\x1b[0m" +
        "\x1b[?1049l",
    );
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(false);
    }
    stdin.pause();
  };

  const size = () => ({
    rows: Math.max(12, stdout.rows || 24),
    cols: Math.max(40, stdout.columns || 80),
  });

  return { enter, setMouse, write, leave, size };
}
