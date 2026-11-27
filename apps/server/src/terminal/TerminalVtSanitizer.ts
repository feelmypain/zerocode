import {
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  TERMINAL_SEQUENCE_GROUND,
  terminalSequenceStateAfter,
} from "@zerocode/contracts";

export interface SanitizedTerminalChunk {
  readonly visibleText: string;
  readonly pendingControlSequence: string;
}

export const VT_SANITIZER_OFFLOAD_THRESHOLD = 16_384;

// Clients keep this much output and drop a sequence their trim cuts through, so none of them
// could replay a longer string or CSI whole.
const MAX_HELD_SEQUENCE_LENGTH = DEFAULT_MAX_TERMINAL_BUFFER_BYTES;
// Leads the held text of a string or CSI that outgrew its limit and stays out of history.
const OVERSIZED_SEQUENCE = "\u0018";
// Stands in for the ESC of an oversized sequence, which ended any string history left open.
const STRING_TERMINATOR = "\u001b\\";
// Bound the unfinished sequence in snapshots so it cannot push history out of the client's budget.
const MAX_SNAPSHOT_SEQUENCE_LENGTH = 4_096;

export function shouldOffloadVtSanitization(
  _pendingControlSequence: string,
  data: string,
): boolean {
  return data.length >= VT_SANITIZER_OFFLOAD_THRESHOLD && data.indexOf("\u001b") !== -1;
}

// Self-contained factory so inline execution and the eval worker share one implementation.
function createVtChunkSanitizer(
  maxHeldSequenceLength: number,
  oversizedSequence: string,
  stringTerminator: string,
): (pendingControlSequence: string, data: string) => SanitizedTerminalChunk {
  // ESC and four intermediates: libghostty ignores every intermediate past the fourth.
  const maxHeldEscapeLength = 5;
  // Ghostty reports colours as `rgb:rrrr/gggg/bbbb`; a lone shorter `rgb:` value only sets one.
  const loneShortRgbSetter =
    /^\d+;rgb:(?![\da-f]{4}\/[\da-f]{4}\/[\da-f]{4}$)[\da-f]{1,4}\/[\da-f]{1,4}\/[\da-f]{1,4}$/i;
  const oscEndPattern = /[\x07\x18\x1a\x1b]/g;
  const nonOscStringEndPattern = /[\x18\x1a\x1b\u0080-\uffff]/g;

  const isCsiFinalByte = (codePoint: number): boolean => codePoint >= 0x40 && codePoint <= 0x7e;
  const isControlSequenceCancel = (codePoint: number): boolean =>
    codePoint === 0x18 || codePoint === 0x1a;
  const isEscapeIntermediateByte = (codePoint: number): boolean =>
    codePoint >= 0x20 && codePoint <= 0x2f;
  const isEscapeFinalByte = (codePoint: number): boolean => codePoint >= 0x30 && codePoint <= 0x7e;

  const isStrippableCsiFinalByte = (codePoint: number): boolean =>
    codePoint === 0x6e ||
    codePoint === 0x52 ||
    codePoint === 0x63 ||
    codePoint === 0x70 ||
    codePoint === 0x79 ||
    codePoint === 0x71 ||
    codePoint === 0x75;

  const shouldStripCsiSequence = (body: string, finalByte: number): boolean => {
    if (finalByte === 0x6e) return true;
    if (finalByte === 0x52 && /^[0-9;?]*$/.test(body)) return true;
    if (finalByte === 0x63 && /^[>=0-9;?]*$/.test(body)) return true;
    // Strip DECRQM/DECRPM query traffic to prevent echoed replies during replay; $ guards preserve setters.
    if ((finalByte === 0x70 || finalByte === 0x79) && /^[0-9;?]*\$$/.test(body)) return true;
    // XTVERSION query (>q). DECSCUSR (space-intermediate q) stays.
    if (finalByte === 0x71 && /^>[0-9;]*$/.test(body)) return true;
    // Kitty keyboard protocol query/reply (?u). Restore-cursor (bare u) stays.
    if (finalByte === 0x75 && body.startsWith("?")) return true;
    return false;
  };

  // Strip DECRQSS/XTGETTCAP query traffic; replaying queries triggers fresh replies without visual value.
  const shouldStripDcsSequence = (content: string): boolean => /^[01]?[$+][qr]/.test(content);

  const shouldStripOscSequence = (content: string): boolean =>
    /^(10|11|12);(?:\?|rgb:)/.test(content) && !loneShortRgbSetter.test(content);

  // An OSC 4 whose every colour is "?" reports palette entries and sets none. Ghostty skips C0
  // controls inside an OSC, runs one that CAN or SUB ends, and reads the pairs past empty fields.
  const isOscPaletteQuery = (content: string): boolean => {
    if (!/^[\0-\x1f]*4/.test(content) || !content.includes("?")) return false;
    const [code, ...pairs] = content
      .replace(/[\0-\x1f]+/g, "")
      .split(";")
      .filter((field) => field !== "");
    return (
      code === "4" && pairs.length > 1 && pairs.every((field, at) => at % 2 === 0 || field === "?")
    );
  };

  const stripStringTerminator = (value: string): string => {
    if (value.endsWith("\u001b\\")) return value.slice(0, -2);
    const lastCharacter = value.at(-1);
    if (lastCharacter === "\u0007" || lastCharacter === "\u009c") return value.slice(0, -1);
    return value;
  };

  // Outside ground and OSC, libghostty parses a code point's UTF-8 bytes one at a time: 0x80-0x9F
  // act as C1 controls, the rest are dropped. Bytes left over after a return to ground print U+FFFD.
  const c1Effect = (
    codePoint: number,
  ): { readonly next: string; readonly query: boolean; readonly safe: string } | undefined => {
    // A lone surrogate is encoded as U+FFFD, whose bytes are all dropped.
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return undefined;
    let next: string | undefined;
    let query = false;
    let safe = "";
    for (let shift = codePoint > 0xffff ? 12 : codePoint > 0x7ff ? 6 : 0; shift >= 0; shift -= 6) {
      const byte = 0x80 | ((codePoint >> shift) & 0x3f);
      if (next === "") {
        safe += "\ufffd";
      } else if (next?.startsWith("\u001b]")) {
        next += "\ufffd";
      } else if (byte === 0x9b) {
        next = "\u001b[";
      } else if (byte === 0x9d) {
        next = "\u001b]";
      } else if (byte === 0x90) {
        next = "\u001bP";
      } else if (byte === 0x98 || byte === 0x9e || byte === 0x9f) {
        next = "\u001b_";
      } else if (byte < 0xa0) {
        next = "";
        query = byte === 0x9a;
        // Any other C1 control but ST runs as ESC plus the byte less 0x40.
        safe = query || byte === 0x9c ? "" : `\u001b${String.fromCharCode(byte - 0x40)}`;
      }
    }
    return next === undefined ? undefined : { next, query, safe };
  };

  // BEL ends only OSC; inside DCS, PM and APC it is payload. Non-ASCII is the reverse: libghostty
  // keeps it inside OSC, while a C1 byte in it ends the other strings.
  const findStringEnd = (
    input: string,
    start: number,
    isOsc: boolean,
  ): {
    end: number;
    c1?: {
      effect: { readonly next: string; readonly query: boolean; readonly safe: string };
      index: number;
    };
  } | null => {
    if (isOsc) {
      oscEndPattern.lastIndex = start;
      const match = oscEndPattern.exec(input);
      if (match === null) return null;
      const index = match.index;
      if (input.charCodeAt(index) === 0x1b) {
        if (index + 1 >= input.length) return null;
        return { end: input.charCodeAt(index + 1) === 0x5c ? index + 2 : index };
      }
      return { end: index + 1 };
    }

    let cursor = start;
    while (cursor < input.length) {
      nonOscStringEndPattern.lastIndex = cursor;
      const match = nonOscStringEndPattern.exec(input);
      if (match === null) return null;
      const index = match.index;
      const codePoint = input.charCodeAt(index);
      if (codePoint === 0x18 || codePoint === 0x1a) {
        return { end: index + 1 };
      }
      if (codePoint === 0x1b) {
        if (index + 1 >= input.length) return null;
        return { end: input.charCodeAt(index + 1) === 0x5c ? index + 2 : index };
      }
      const fullCodePoint = input.codePointAt(index) ?? codePoint;
      const end = index + (fullCodePoint > 0xffff ? 2 : 1);
      const effect = c1Effect(fullCodePoint);
      if (effect) return { end, c1: { effect, index } };
      cursor = end;
    }
    return null;
  };

  const findEscapeSequenceEndIndex = (input: string, start: number): number | null => {
    let cursor = start;
    while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) {
      cursor += 1;
    }
    if (cursor >= input.length) return null;
    // A second ESC restarts the sequence, so leave it for the next pass.
    if (input.charCodeAt(cursor) === 0x1b) return cursor;
    return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
  };

  return (pendingControlSequence: string, data: string): SanitizedTerminalChunk => {
    // libghostty prints UTF-8 C1 code points (U+0080-U+009F) as text, so only ESC starts a sequence.
    if (pendingControlSequence.length === 0 && data.indexOf("\u001b") === -1) {
      return { visibleText: data, pendingControlSequence: "" };
    }

    const resumesOversized = pendingControlSequence.startsWith(oversizedSequence);
    const held = resumesOversized ? pendingControlSequence.slice(1) : pendingControlSequence;
    const input = held.length === 0 ? data : `${held}${data}`;
    // Only the held text's final code unit, an ESC or a high surrogate, can begin an end split
    // across chunks.
    const pendingScanStart = Math.max(0, held.length - 1);
    const parts: string[] = [];
    let copyStart = 0;
    let index = 0;
    // Set when a C1 code point began the sequence at `index`: the ESC form that stands in for it.
    let c1Introducer = "";

    const flushCopied = (upTo: number) => {
      if (upTo > copyStart) {
        parts.push(input.slice(copyStart, upTo));
      }
    };

    const emitSynthetic = (cutAt: number, value: string, nextCopyStart: number) => {
      flushCopied(cutAt);
      if (value.length > 0) {
        parts.push(value);
      }
      copyStart = nextCopyStart;
    };

    const finishVisible = (upTo: number): string => {
      if (parts.length === 0) {
        if (copyStart === 0 && upTo === input.length) return input;
        return upTo > copyStart ? input.slice(copyStart, upTo) : "";
      }
      flushCopied(upTo);
      return parts.join("");
    };

    while (index < input.length) {
      const codePoint = input.charCodeAt(index);

      if (c1Introducer.length > 0 || codePoint === 0x1b) {
        // Empty for a sequence the input introduces itself, which starts with ESC at `index`.
        const prefix = c1Introducer;
        c1Introducer = "";
        const oversized = resumesOversized && index === 0;
        const contentStart = prefix.length > 0 ? index : index + 2;
        const nextCodePoint = (prefix || input).charCodeAt(prefix.length > 0 ? 1 : index + 1);
        if (Number.isNaN(nextCodePoint)) {
          return { visibleText: finishVisible(index), pendingControlSequence: input.slice(index) };
        }

        if (nextCodePoint === 0x5b) {
          // A held CSI has not ended, so only its last code unit is scanned again.
          let cursor = index === 0 ? Math.max(contentStart, pendingScanStart) : contentStart;
          // Inside a CSI Ghostty executes 0x00-0x0F and ignores DEL and 0x10-0x1F, which it would
          // print in ground state. None join the parameters; only executed ones survive a strip.
          const executedControls = () =>
            cursor <= contentStart
              ? ""
              : input.slice(contentStart, cursor).replace(/[^\x00-\x0f]+/g, "");
          while (cursor < input.length) {
            const cursorCodePoint = input.charCodeAt(cursor);
            const cancelled = isControlSequenceCancel(cursorCodePoint);
            if (cancelled || isCsiFinalByte(cursorCodePoint)) {
              const strip =
                oversized ||
                (!cancelled &&
                  isStrippableCsiFinalByte(cursorCodePoint) &&
                  shouldStripCsiSequence(
                    cursorCodePoint === 0x6e
                      ? ""
                      : input.slice(contentStart, cursor).replace(/[^\x20-\x7e]+/g, ""),
                    cursorCodePoint,
                  ));
              if (!strip) {
                if (prefix.length > 0) {
                  emitSynthetic(index, prefix + input.slice(index, cursor + 1), cursor + 1);
                }
              } else {
                emitSynthetic(index, executedControls(), cursor + 1);
              }
              index = cursor + 1;
              break;
            }
            if (cursorCodePoint >= 0x80) {
              const fullCodePoint = input.codePointAt(cursor) ?? cursorCodePoint;
              const end = cursor + (fullCodePoint > 0xffff ? 2 : 1);
              const c1 = c1Effect(fullCodePoint);
              if (c1) {
                // The CSI ends here undispatched, so it is kept only when the terminal is back in
                // ground with nothing to answer.
                if (!oversized && c1.next.length === 0 && !c1.query) {
                  if (prefix.length > 0) {
                    emitSynthetic(index, prefix + input.slice(index, end), end);
                  }
                } else {
                  emitSynthetic(index, executedControls() + c1.safe, end);
                }
                c1Introducer = c1.next;
                index = end;
                break;
              }
              cursor = end;
              continue;
            }
            // An ESC abandons the CSI and starts the next sequence, which may be stripped.
            if (cursorCodePoint === 0x1b) {
              emitSynthetic(index, executedControls(), cursor);
              index = cursor;
              break;
            }
            cursor += 1;
          }
          if (cursor >= input.length) {
            const unfinished = prefix + input.slice(index);
            if (oversized || unfinished.length > maxHeldSequenceLength) {
              // The terminal has run these controls already, so history takes them as they come.
              emitSynthetic(
                index,
                (oversized ? "" : stringTerminator) + executedControls(),
                input.length,
              );
              const endStart = /[\ud800-\udbff]$/.exec(unfinished)?.[0] ?? "";
              return {
                visibleText: finishVisible(input.length),
                pendingControlSequence: `${oversizedSequence}\u001b[${endStart}`,
              };
            }
            return { visibleText: finishVisible(index), pendingControlSequence: unfinished };
          }
          continue;
        }

        if (
          nextCodePoint === 0x5d ||
          nextCodePoint === 0x50 ||
          nextCodePoint === 0x5e ||
          nextCodePoint === 0x5f
        ) {
          const stringEnd = findStringEnd(
            input,
            index === 0 ? Math.max(contentStart, pendingScanStart) : contentStart,
            nextCodePoint === 0x5d,
          );
          if (stringEnd === null) {
            const unfinished = prefix + input.slice(index);
            if (oversized || unfinished.length > maxHeldSequenceLength) {
              emitSynthetic(index, oversized ? "" : stringTerminator, input.length);
              const endStart = /[\u001b\ud800-\udbff]$/.exec(unfinished)?.[0] ?? "";
              return {
                visibleText: finishVisible(input.length),
                pendingControlSequence: oversizedSequence + unfinished.slice(0, 2) + endStart,
              };
            }
            return { visibleText: finishVisible(index), pendingControlSequence: unfinished };
          }
          const { end, c1 } = stringEnd;
          const contentEnd = c1?.index ?? end;
          const firstContentCode =
            prefix.length > 2
              ? prefix.charCodeAt(2)
              : contentStart < contentEnd
                ? input.charCodeAt(contentStart)
                : -1;

          let strip = oversized;
          if (!oversized && nextCodePoint === 0x5d) {
            const mayMatchOscQuery =
              firstContentCode === 0x31 ||
              firstContentCode === 0x34 ||
              (firstContentCode >= 0 && firstContentCode <= 0x1f);
            if (mayMatchOscQuery) {
              const content = stripStringTerminator(
                prefix.slice(2) + input.slice(contentStart, contentEnd),
              );
              const lastChar = end > index ? input.charCodeAt(end - 1) : -1;
              const hasTerminator =
                lastChar === 0x07 ||
                lastChar === 0x18 ||
                lastChar === 0x1a ||
                (lastChar === 0x5c && end - index >= 2 && input.charCodeAt(end - 2) === 0x1b);
              // ST ends what the query's ESC cut short and leaves ground state, as the query does
              // when it has its own terminator. Without one, the query stays.
              if (hasTerminator && isOscPaletteQuery(content)) {
                emitSynthetic(index, "\u001b\\", end);
                index = end;
                continue;
              }
              strip = shouldStripOscSequence(content);
            }
          } else if (!oversized && nextCodePoint === 0x50) {
            const mayMatchDcsQuery =
              firstContentCode === 0x30 ||
              firstContentCode === 0x31 ||
              firstContentCode === 0x24 ||
              firstContentCode === 0x2b;
            if (mayMatchDcsQuery) {
              const dcsHead =
                prefix.length <= 2 && contentEnd - contentStart > 5
                  ? input.slice(contentStart, contentStart + 3)
                  : stripStringTerminator(prefix.slice(2) + input.slice(contentStart, contentEnd));
              strip = shouldStripDcsSequence(dcsHead);
            }
          }

          if (c1 === undefined || (!strip && c1.effect.next.length === 0 && !c1.effect.query)) {
            if (!strip) {
              if (prefix.length > 0) {
                emitSynthetic(index, prefix + input.slice(index, end), end);
              }
            } else {
              emitSynthetic(index, "", end);
            }
          } else {
            // ST stands in for a code point that cannot be replayed as it came.
            const closed = strip ? "" : `${prefix}${input.slice(index, c1.index)}\u009c`;
            emitSynthetic(index, closed + c1.effect.safe, end);
            c1Introducer = c1.effect.next;
          }
          index = end;
          continue;
        }

        const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
        if (escapeSequenceEndIndex === null) {
          return {
            visibleText: finishVisible(index),
            pendingControlSequence: input.slice(index, index + maxHeldEscapeLength),
          };
        }
        // ESC Z (DECID) is the legacy primary device attributes query.
        if (nextCodePoint === 0x5a) {
          emitSynthetic(index, "", escapeSequenceEndIndex);
        }
        index = escapeSequenceEndIndex;
        continue;
      }

      // Skip directly to the next ESC so printable runs never iterate per character.
      const nextEscape = input.indexOf("\u001b", index + 1);
      index = nextEscape === -1 ? input.length : nextEscape;
    }

    return { visibleText: finishVisible(input.length), pendingControlSequence: c1Introducer };
  };
}

export const sanitizeTerminalHistoryChunk = createVtChunkSanitizer(
  MAX_HELD_SEQUENCE_LENGTH,
  OVERSIZED_SEQUENCE,
  STRING_TERMINATOR,
);

export function serializeVtSanitizerFactory(): string {
  return `(${createVtChunkSanitizer.toString()})(${MAX_HELD_SEQUENCE_LENGTH}, ${JSON.stringify(OVERSIZED_SEQUENCE)}, ${JSON.stringify(STRING_TERMINATOR)})`;
}

// History leaves out the sequence the terminal is still inside. A client that starts from a
// snapshot needs it, or it prints the rest of the sequence as text.
export function unfinishedSequenceReplay(held: string): string {
  if (held.startsWith(OVERSIZED_SEQUENCE)) return held.slice(1);
  if (held.length <= MAX_SNAPSHOT_SEQUENCE_LENGTH) return held;
  const introducer = held.slice(0, 2);
  const tail = /[\u001b\ud800-\udbff]$/.exec(held)?.[0] ?? "";
  if (introducer === "\u001b[") {
    // The scanner has already handled bytes that end a CSI. Only intermediates, parameters,
    // and executed non-NUL controls affect its replay.
    const body = held
      .slice(2, held.length - tail.length)
      .replace(/[^\x01-\x0f\x20-\x3f]+/g, "")
      .replace(/\r{2,}/g, "\r");
    const budget = MAX_SNAPSHOT_SEQUENCE_LENGTH - introducer.length - tail.length;
    if (body.length <= budget) return introducer + body + tail;
    // Controls execute as they arrive, independently of the parameters dispatched at the end.
    const parameters = body.replace(/[^\x20-\x3f]+/g, "");
    const replayParameters = parameters.length <= budget ? parameters : "";
    const controls = body.replace(/[^\x01-\x0f]+/g, "");
    const controlsToSkip = Math.max(0, controls.length - (budget - replayParameters.length));
    return introducer + replayParameters + controls.slice(controlsToSkip) + tail;
  }
  return introducer + tail;
}

export function snapshotHistoryFromPending(
  history: string,
  held: string,
  supportsSnapshotSequenceState: boolean,
): { readonly history: string; readonly historySequenceState?: number } {
  const oversized = held.startsWith(OVERSIZED_SEQUENCE);
  // A long CSI compacts into a faithful replay, so only strings and oversized prefixes are omitted.
  if (
    !supportsSnapshotSequenceState ||
    (!oversized && (held.length <= MAX_SNAPSHOT_SEQUENCE_LENGTH || held.startsWith("\u001b[")))
  ) {
    return { history: history + unfinishedSequenceReplay(held) };
  }
  const state = terminalSequenceStateAfter(TERMINAL_SEQUENCE_GROUND, held, oversized ? 1 : 0);
  // The omitted prefix's ESC may also have ended the preceding string in history.
  const closedHistory =
    terminalSequenceStateAfter(TERMINAL_SEQUENCE_GROUND, history) === TERMINAL_SEQUENCE_GROUND
      ? history
      : history + STRING_TERMINATOR;
  return state === TERMINAL_SEQUENCE_GROUND
    ? { history: closedHistory }
    : { history: closedHistory, historySequenceState: state };
}
