export type KeyName =
  | "char"
  | "enter"
  | "backspace"
  | "delete"
  | "tab"
  | "escape"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "paste"
  | "mouse-wheel-up"
  | "mouse-wheel-down";

export interface KeyEvent {
  readonly name: KeyName;
  readonly text: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function makeKey(
  name: KeyName,
  options?: { text?: string; ctrl?: boolean; alt?: boolean; shift?: boolean },
): KeyEvent {
  return {
    name,
    text: options?.text ?? "",
    ctrl: options?.ctrl ?? false,
    alt: options?.alt ?? false,
    shift: options?.shift ?? false,
  };
}

function decodeModifier(modParam: number): { shift: boolean; alt: boolean; ctrl: boolean } {
  const bits = Math.max(0, modParam - 1);
  return {
    shift: (bits & 1) !== 0,
    alt: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
  };
}

/** Stateful incremental raw-TTY input parser (CSI, SS3, Kitty/CSI-u, bracketed paste, SGR mouse). */
export class TerminalInputParser {
  private pending = "";
  private inPaste = false;
  private pasteBuffer = "";

  feed(chunk: string | Buffer): Array<KeyEvent> {
    this.pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const events: Array<KeyEvent> = [];

    while (this.pending.length > 0) {
      if (this.inPaste) {
        const endIdx = this.pending.indexOf(PASTE_END);
        if (endIdx === -1) {
          // Retain up to PASTE_END.length - 1 tail chars in case the sequence splits across chunks.
          const safeLen = Math.max(0, this.pending.length - (PASTE_END.length - 1));
          this.pasteBuffer += this.pending.slice(0, safeLen);
          this.pending = this.pending.slice(safeLen);
          break;
        }
        this.pasteBuffer += this.pending.slice(0, endIdx);
        this.pending = this.pending.slice(endIdx + PASTE_END.length);
        this.inPaste = false;
        events.push(makeKey("paste", { text: this.pasteBuffer }));
        this.pasteBuffer = "";
        continue;
      }

      if (this.pending.startsWith(PASTE_START)) {
        this.pending = this.pending.slice(PASTE_START.length);
        this.inPaste = true;
        this.pasteBuffer = "";
        continue;
      }

      // Incomplete bracketed paste start prefix
      if (PASTE_START.startsWith(this.pending)) {
        break;
      }

      const ch = this.pending[0]!;
      const code = this.pending.charCodeAt(0);

      if (code === 0x1b) {
        const parsed = this.parseEscape();
        if (parsed === "incomplete") break;
        if (parsed !== null) events.push(parsed);
        continue;
      }

      this.pending = this.pending.slice(1);

      if (code === 0x0d) {
        events.push(makeKey("enter"));
      } else if (code === 0x0a) {
        // Ctrl+J / LF inserts a newline in the composer.
        events.push(makeKey("enter", { ctrl: true }));
      } else if (code === 0x09) {
        events.push(makeKey("tab"));
      } else if (code === 0x7f || code === 0x08) {
        events.push(makeKey("backspace"));
      } else if (code >= 0x01 && code <= 0x1a) {
        const letter = String.fromCharCode(code + 96);
        events.push(makeKey("char", { text: letter, ctrl: true }));
      } else if (code >= 0x20) {
        const cp = ch.codePointAt(0)!;
        // Handle surrogate pairs cleanly.
        if (cp >= 0xd800 && cp <= 0xdbff && this.pending.length > 0) {
          const low = this.pending[0]!;
          this.pending = this.pending.slice(1);
          events.push(makeKey("char", { text: ch + low }));
        } else {
          events.push(makeKey("char", { text: ch }));
        }
      }
    }

    return events;
  }

  /** Flushes a bare ESC if no trailing escape sequence bytes arrived within the timeout. */
  flushPendingEscape(): Array<KeyEvent> {
    if (this.pending === "\x1b") {
      this.pending = "";
      return [makeKey("escape")];
    }
    return [];
  }

  hasPendingEscape(): boolean {
    return this.pending === "\x1b";
  }

  private parseEscape(): KeyEvent | "incomplete" | null {
    if (this.pending.length === 1) {
      return "incomplete";
    }
    const second = this.pending[1]!;

    // CSI: ESC [ ...
    if (second === "[") {
      const match = /^\x1b\[([0-9;:<>=?]*)([@-~])/.exec(this.pending);
      if (!match) {
        // Wait for more bytes unless the sequence is implausibly long.
        if (this.pending.length < 24) return "incomplete";
        this.pending = this.pending.slice(2);
        return null;
      }
      const [full, params = "", finalChar = ""] = match;
      this.pending = this.pending.slice(full.length);
      return this.decodeCsi(params, finalChar);
    }

    // SS3: ESC O <char>
    if (second === "O") {
      if (this.pending.length < 3) return "incomplete";
      const finalChar = this.pending[2]!;
      this.pending = this.pending.slice(3);
      switch (finalChar) {
        case "A":
          return makeKey("up");
        case "B":
          return makeKey("down");
        case "C":
          return makeKey("right");
        case "D":
          return makeKey("left");
        case "H":
          return makeKey("home");
        case "F":
          return makeKey("end");
        default:
          return null;
      }
    }

    // Alt + Enter / Alt + Backspace / Alt + char
    this.pending = this.pending.slice(2);
    const code = second.charCodeAt(0);
    if (code === 0x0d || code === 0x0a) {
      return makeKey("enter", { alt: true });
    }
    if (code === 0x7f || code === 0x08) {
      return makeKey("backspace", { alt: true });
    }
    if (code === 0x1b) {
      return makeKey("escape");
    }
    return makeKey("char", { text: second, alt: true });
  }

  private decodeCsi(params: string, finalChar: string): KeyEvent | null {
    // SGR mouse: ESC [ < button ; col ; row M/m
    if (params.startsWith("<") && (finalChar === "M" || finalChar === "m")) {
      const parts = params.slice(1).split(";");
      const button = Number.parseInt(parts[0] ?? "", 10);
      if (button === 64) return makeKey("mouse-wheel-up");
      if (button === 65) return makeKey("mouse-wheel-down");
      return null;
    }

    // CSI-u (Kitty / modern terminals: e.g., Shift+Enter = ESC[13;2u, Shift+Tab = ESC[9;2u)
    if (finalChar === "u") {
      const [codeStr, modStr] = params.split(";");
      const codePoint = Number.parseInt(codeStr ?? "", 10);
      const mods = modStr
        ? decodeModifier(Number.parseInt(modStr, 10))
        : { shift: false, alt: false, ctrl: false };
      if (codePoint === 13) return makeKey("enter", mods);
      if (codePoint === 27) return makeKey("escape", mods);
      if (codePoint === 9) return makeKey("tab", mods);
      if (codePoint === 127 || codePoint === 8) return makeKey("backspace", mods);
      if (codePoint >= 32 && codePoint <= 0x10ffff) {
        return makeKey("char", { text: String.fromCodePoint(codePoint), ...mods });
      }
      return null;
    }

    const parts = params.length > 0 ? params.split(";") : [];
    const mods =
      parts.length >= 2
        ? decodeModifier(Number.parseInt(parts[1] ?? "1", 10))
        : { shift: false, alt: false, ctrl: false };

    switch (finalChar) {
      case "A":
        return makeKey("up", mods);
      case "B":
        return makeKey("down", mods);
      case "C":
        return makeKey("right", mods);
      case "D":
        return makeKey("left", mods);
      case "H":
        return makeKey("home", mods);
      case "F":
        return makeKey("end", mods);
      case "Z":
        return makeKey("tab", { shift: true });
      case "~": {
        const keyNum = Number.parseInt(parts[0] ?? "", 10);
        // xterm modifyOtherKeys: ESC [ 27 ; mod ; 13 ~
        if (keyNum === 27 && parts.length >= 3) {
          const chCode = Number.parseInt(parts[2] ?? "", 10);
          if (chCode === 13) return makeKey("enter", mods);
          if (chCode === 27) return makeKey("escape", mods);
        }
        switch (keyNum) {
          case 1:
          case 7:
            return makeKey("home", mods);
          case 3:
            return makeKey("delete", mods);
          case 4:
          case 8:
            return makeKey("end", mods);
          case 5:
            return makeKey("pageup", mods);
          case 6:
            return makeKey("pagedown", mods);
          default:
            return null;
        }
      }
      default:
        return null;
    }
  }
}
