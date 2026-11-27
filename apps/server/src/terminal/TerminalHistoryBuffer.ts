import {
  TERMINAL_SEQUENCE_GROUND,
  terminalSequenceEnd,
  terminalSequenceStateAfter,
} from "@zerocode/contracts";

export const DEFAULT_HISTORY_BYTE_LIMIT = 8 * 1024 * 1024;
const INITIAL_SLAB_BYTES = 256;
const MAX_SLAB_BYTES = 16 * 1024;

// Mirrors libghostty-vt parser states in @zerocode/contracts for zero-decode UTF-8 byte scans.
const SEQUENCE_ESCAPE = 1;
const SEQUENCE_ESCAPE_INTERMEDIATE = 2;
const SEQUENCE_CSI = 3;
const SEQUENCE_DCS = 4;
const SEQUENCE_SOS_PM_APC = 5;
const SEQUENCE_OSC = 6;

const utf8Encoder = new TextEncoder();

interface HistorySlab {
  bytes: Buffer;
  start: number;
  end: number;
  lineBreaks: number;
  hasLoneSurrogates: boolean;
}

export interface TerminalHistoryPersistenceCursor {
  readonly generation: number;
  readonly offset: number;
  readonly fileBytes: number;
}

function allocateSlabBuffer(capacity: number): Buffer {
  // Unpooled allocation avoids pinning Node's shared 8 KiB Buffer slab for long-lived terminals.
  return Buffer.from(new Uint8Array(capacity).buffer);
}

function countLineBreaksBytes(bytes: Buffer, start: number, end: number): number {
  if (end <= start) return 0;
  const view = start === 0 && end === bytes.byteLength ? bytes : bytes.subarray(start, end);
  let count = 0;
  let index = view.indexOf(0x0a);
  while (index !== -1) {
    count += 1;
    index = view.indexOf(0x0a, index + 1);
  }
  return count;
}

function decodeWtf8Range(bytes: Buffer, start: number, end: number): string {
  let cursor = start;
  let result = "";
  let searchFrom = start;
  while (searchFrom < end) {
    const pos = bytes.indexOf(0xed, searchFrom);
    if (pos === -1 || pos + 2 >= end) break;
    const second = bytes[pos + 1]!;
    if (second >= 0xa0 && second <= 0xbf) {
      if (pos > cursor) {
        result += bytes.toString("utf8", cursor, pos);
      }
      const third = bytes[pos + 2]!;
      result += String.fromCharCode(0xd000 | ((second & 0x3f) << 6) | (third & 0x3f));
      cursor = pos + 3;
      searchFrom = cursor;
    } else {
      searchFrom = pos + 1;
    }
  }
  if (cursor === start) {
    return bytes.toString("utf8", start, end);
  }
  if (cursor < end) {
    result += bytes.toString("utf8", cursor, end);
  }
  return result;
}

function decodeSlabRange(slab: HistorySlab, start: number, end: number): string {
  if (end <= start) return "";
  return slab.hasLoneSurrogates
    ? decodeWtf8Range(slab.bytes, start, end)
    : slab.bytes.toString("utf8", start, end);
}

function nextTerminalSequenceStateByte(state: number, byte: number): number {
  if (byte === 0x1b) return SEQUENCE_ESCAPE;
  if (state === TERMINAL_SEQUENCE_GROUND || byte === 0x18 || byte === 0x1a) {
    return TERMINAL_SEQUENCE_GROUND;
  }
  if (byte < 0x80) {
    switch (state) {
      case SEQUENCE_ESCAPE:
        if (byte < 0x20 || byte === 0x7f) return state;
        if (byte < 0x30) return SEQUENCE_ESCAPE_INTERMEDIATE;
        if (byte === 0x5b) return SEQUENCE_CSI;
        if (byte === 0x5d) return SEQUENCE_OSC;
        if (byte === 0x50) return SEQUENCE_DCS;
        return byte === 0x58 || byte === 0x5e || byte === 0x5f
          ? SEQUENCE_SOS_PM_APC
          : TERMINAL_SEQUENCE_GROUND;
      case SEQUENCE_ESCAPE_INTERMEDIATE:
        return byte >= 0x30 && byte !== 0x7f ? TERMINAL_SEQUENCE_GROUND : state;
      case SEQUENCE_CSI:
        return byte >= 0x40 && byte !== 0x7f ? TERMINAL_SEQUENCE_GROUND : state;
      case SEQUENCE_OSC:
        return byte === 0x07 ? TERMINAL_SEQUENCE_GROUND : state;
      default:
        return state;
    }
  }
  if (state === SEQUENCE_OSC || byte >= 0xa0) return state;
  if (byte === 0x9d) return SEQUENCE_OSC;
  if (byte === 0x90) return SEQUENCE_DCS;
  if (byte === 0x9b) return SEQUENCE_CSI;
  if (byte === 0x98 || byte >= 0x9e) return SEQUENCE_SOS_PM_APC;
  return TERMINAL_SEQUENCE_GROUND;
}

function terminalSequenceStateAfterBytes(
  state: number,
  bytes: Buffer,
  start: number,
  end: number,
): number {
  if (end <= start) return state;
  const view = start === 0 && end === bytes.byteLength ? bytes : bytes.subarray(start, end);
  const relativeEscape = view.lastIndexOf(0x1b);
  if (relativeEscape >= 0) {
    state = SEQUENCE_ESCAPE;
    start += relativeEscape + 1;
  }
  for (let index = start; index < end && state !== TERMINAL_SEQUENCE_GROUND; index += 1) {
    state = nextTerminalSequenceStateByte(state, bytes[index]!);
  }
  return state;
}

function terminalSequenceEndBytes(
  state: number,
  bytes: Buffer,
  start: number,
  end: number,
): number {
  let index = start;
  while (state !== TERMINAL_SEQUENCE_GROUND && index < end) {
    state = nextTerminalSequenceStateByte(state, bytes[index]!);
    index += 1;
  }
  // A C1 continuation byte can return to ground mid-code-point; finish that UTF-8 character.
  while (index < end && (bytes[index]! & 0xc0) === 0x80) {
    index += 1;
  }
  return index;
}

export class BoundedTerminalHistory {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private slabs: Array<HistorySlab | undefined> = [];
  private start = 0;
  private totalBytes = 0;
  private lineBreaks = 0;
  private lastByte: number | undefined;
  private trailingHighSurrogate: number | undefined;
  // The terminal parser's state at the first retained byte, which is where a replay starts.
  private sequenceState = TERMINAL_SEQUENCE_GROUND;
  private cachedValue: string | null = "";
  private generation = 0;
  private appendedBytes = 0;

  constructor(maxLines: number, initial: string, maxBytes = DEFAULT_HISTORY_BYTE_LIMIT) {
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
    this.append(initial);
  }

  get byteLength(): number {
    return this.totalBytes;
  }

  append(text: string): void {
    if (text.length === 0) return;
    this.cachedValue = null;
    if (this.maxBytes <= 0 || this.maxLines <= 0) {
      this.clear();
      if (this.maxBytes > 0 && text.endsWith("\n")) {
        this.appendNewlineOnly();
      }
      return;
    }

    if (text.isWellFormed()) {
      this.trailingHighSurrogate = undefined;
      this.appendWellFormedRange(text, 0, text.length);
      return;
    }

    this.appendIllFormed(text);
  }

  private appendNewlineOnly(): void {
    const slab = this.ensureWritableSlab(1);
    slab.bytes[slab.end] = 0x0a;
    slab.end += 1;
    slab.lineBreaks += 1;
    this.totalBytes += 1;
    this.lineBreaks += 1;
    this.appendedBytes += 1;
    this.lastByte = 0x0a;
    this.trailingHighSurrogate = undefined;
    this.cachedValue = null;
  }

  private allocateSlab(hintBytes: number): HistorySlab {
    const desired =
      this.totalBytes >= 4_096 || hintBytes >= 4_096
        ? MAX_SLAB_BYTES
        : Math.min(MAX_SLAB_BYTES, Math.max(INITIAL_SLAB_BYTES, hintBytes * 2));
    const capacity = Math.max(4, desired);
    const slab: HistorySlab = {
      bytes: allocateSlabBuffer(capacity),
      start: 0,
      end: 0,
      lineBreaks: 0,
      hasLoneSurrogates: false,
    };
    this.slabs.push(slab);
    return slab;
  }

  private ensureWritableSlab(hintBytes: number): HistorySlab {
    if (this.slabs.length > this.start) {
      const tail = this.slabs[this.slabs.length - 1]!;
      if (tail.bytes.byteLength - tail.end >= 4) {
        return tail;
      }
    }
    return this.allocateSlab(hintBytes);
  }

  private appendWellFormedRange(text: string, rangeStart: number, rangeEnd: number): void {
    let offset = rangeStart;
    while (offset < rangeEnd) {
      const slab = this.ensureWritableSlab(rangeEnd - offset);
      const freeBytes = slab.bytes.byteLength - slab.end;
      let sliceEnd = Math.min(offset + freeBytes, rangeEnd);
      if (sliceEnd < rangeEnd) {
        const lastUnit = text.charCodeAt(sliceEnd - 1);
        if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
          sliceEnd -= 1;
        }
      }
      if (sliceEnd === offset) {
        sliceEnd = Math.min(offset + 2, rangeEnd);
      }
      const segment =
        offset === 0 && sliceEnd === text.length ? text : text.slice(offset, sliceEnd);
      const { read, written } = utf8Encoder.encodeInto(segment, slab.bytes.subarray(slab.end));
      if (read === 0 || written === 0) {
        this.allocateSlab(
          Math.min(MAX_SLAB_BYTES, Math.max(INITIAL_SLAB_BYTES, rangeEnd - offset)),
        );
        continue;
      }
      const writeStart = slab.end;
      const writeEnd = writeStart + written;
      const addedLineBreaks = countLineBreaksBytes(slab.bytes, writeStart, writeEnd);
      slab.end = writeEnd;
      slab.lineBreaks += addedLineBreaks;
      this.totalBytes += written;
      this.lineBreaks += addedLineBreaks;
      this.appendedBytes += written;
      this.lastByte = slab.bytes[writeEnd - 1];
      offset += read;
      this.trim();
    }
  }

  private joinTrailingSurrogate(high: number, low: number): void {
    const tail = this.slabs[this.slabs.length - 1]!;
    // Joining a split surrogate changes its UTF-8 size from 3 to 4 bytes; force rewrite on flush.
    tail.end -= 3;
    this.totalBytes -= 3;
    if (tail.end === tail.start) {
      this.slabs.pop();
    }
    const target = this.ensureWritableSlab(4);
    const codePoint = 0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00);
    const pos = target.end;
    target.bytes[pos] = 0xf0 | (codePoint >> 18);
    target.bytes[pos + 1] = 0x80 | ((codePoint >> 12) & 0x3f);
    target.bytes[pos + 2] = 0x80 | ((codePoint >> 6) & 0x3f);
    target.bytes[pos + 3] = 0x80 | (codePoint & 0x3f);
    target.end = pos + 4;
    this.totalBytes += 4;
    this.appendedBytes += 1;
    this.generation += 1;
    this.lastByte = target.bytes[pos + 3];
    this.trailingHighSurrogate = undefined;
    this.trim();
  }

  private appendLoneSurrogate(codeUnit: number): void {
    const slab = this.ensureWritableSlab(3);
    const pos = slab.end;
    // WTF-8 preserves the unpaired surrogate code unit while keeping its 3-byte UTF-8 size.
    slab.bytes[pos] = 0xed;
    slab.bytes[pos + 1] = 0x80 | ((codeUnit >> 6) & 0x3f);
    slab.bytes[pos + 2] = 0x80 | (codeUnit & 0x3f);
    slab.end = pos + 3;
    slab.hasLoneSurrogates = true;
    this.totalBytes += 3;
    this.appendedBytes += 3;
    this.lastByte = slab.bytes[pos + 2];
    this.trim();
  }

  private appendIllFormed(text: string): void {
    let offset = 0;
    const firstCode = text.charCodeAt(0);
    if (this.trailingHighSurrogate !== undefined && firstCode >= 0xdc00 && firstCode <= 0xdfff) {
      this.joinTrailingSurrogate(this.trailingHighSurrogate, firstCode);
      offset = 1;
    } else {
      this.trailingHighSurrogate = undefined;
    }

    let spanStart = offset;
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = offset + 1 < text.length ? text.charCodeAt(offset + 1) : -1;
        if (next >= 0xdc00 && next <= 0xdfff) {
          offset += 2;
          continue;
        }
        if (offset > spanStart) {
          this.appendWellFormedRange(text, spanStart, offset);
        }
        this.appendLoneSurrogate(code);
        offset += 1;
        spanStart = offset;
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        if (offset > spanStart) {
          this.appendWellFormedRange(text, spanStart, offset);
        }
        this.appendLoneSurrogate(code);
        offset += 1;
        spanStart = offset;
        continue;
      }
      offset += 1;
    }
    if (offset > spanStart) {
      this.appendWellFormedRange(text, spanStart, offset);
    }

    if (this.totalBytes > 0) {
      const lastCode = text.charCodeAt(text.length - 1);
      this.trailingHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff ? lastCode : undefined;
    } else {
      this.trailingHighSurrogate = undefined;
    }
  }

  private advanceSequenceState(slab: HistorySlab, start: number, end: number): void {
    if (end <= start) return;
    if (slab.hasLoneSurrogates || this.sequenceState >= 8) {
      this.sequenceState = terminalSequenceStateAfter(
        this.sequenceState,
        decodeSlabRange(slab, start, end),
      );
      return;
    }
    this.sequenceState = terminalSequenceStateAfterBytes(
      this.sequenceState,
      slab.bytes,
      start,
      end,
    );
  }

  private discardSlab(): void {
    const first = this.slabs[this.start]!;
    this.advanceSequenceState(first, first.start, first.end);
    this.totalBytes -= first.end - first.start;
    this.lineBreaks -= first.lineBreaks;
    this.slabs[this.start++] = undefined;
  }

  private trimSlab(dropBytes: number, droppedLineBreaks: number): void {
    const first = this.slabs[this.start]!;
    if (dropBytes >= first.end - first.start) {
      this.discardSlab();
      return;
    }
    const nextStart = first.start + dropBytes;
    this.advanceSequenceState(first, first.start, nextStart);
    first.start = nextStart;
    first.lineBreaks -= droppedLineBreaks;
    this.totalBytes -= dropBytes;
    this.lineBreaks -= droppedLineBreaks;
  }

  private trim(): void {
    if (this.start === this.slabs.length) return;

    const trailingNewline = this.lastByte === 0x0a;
    let linesToDrop = this.lineBreaks + (trailingNewline ? 0 : 1) - this.maxLines;
    while (linesToDrop > 0 && this.start < this.slabs.length) {
      const first = this.slabs[this.start]!;
      if (first.lineBreaks < linesToDrop) {
        linesToDrop -= first.lineBreaks;
        this.discardSlab();
        continue;
      }
      const view = first.bytes.subarray(first.start, first.end);
      let offset = 0;
      for (let line = 0; line < linesToDrop; line += 1) {
        offset = view.indexOf(0x0a, offset) + 1;
      }
      this.trimSlab(offset, linesToDrop);
      linesToDrop = 0;
    }

    while (this.totalBytes > this.maxBytes && this.start < this.slabs.length) {
      const first = this.slabs[this.start]!;
      const firstBytes = first.end - first.start;
      const bytesToDrop = this.totalBytes - this.maxBytes;
      if (firstBytes <= bytesToDrop) {
        this.discardSlab();
        continue;
      }
      let dropBytes = bytesToDrop;
      // Never split a multi-byte UTF-8 character; advance past any continuation bytes.
      while (dropBytes < firstBytes && (first.bytes[first.start + dropBytes]! & 0xc0) === 0x80) {
        dropBytes += 1;
      }
      const droppedLineBreaks =
        first.lineBreaks === 0
          ? 0
          : countLineBreaksBytes(first.bytes, first.start, first.start + dropBytes);
      this.trimSlab(dropBytes, droppedLineBreaks);
    }

    // A cut inside a control sequence would replay the rest of it as text.
    while (this.sequenceState !== TERMINAL_SEQUENCE_GROUND && this.start < this.slabs.length) {
      const first = this.slabs[this.start]!;
      let dropBytes: number;
      if (first.hasLoneSurrogates || this.sequenceState >= 8) {
        const text = decodeSlabRange(first, first.start, first.end);
        const endCharOffset = terminalSequenceEnd(this.sequenceState, text);
        dropBytes =
          endCharOffset === text.length
            ? first.end - first.start
            : Buffer.byteLength(text.slice(0, endCharOffset));
      } else {
        dropBytes =
          terminalSequenceEndBytes(this.sequenceState, first.bytes, first.start, first.end) -
          first.start;
      }
      const droppedLineBreaks =
        first.lineBreaks === 0
          ? 0
          : countLineBreaksBytes(first.bytes, first.start, first.start + dropBytes);
      this.trimSlab(dropBytes, droppedLineBreaks);
    }

    if (
      this.start === this.slabs.length ||
      (this.start > 2_048 && this.start * 2 >= this.slabs.length)
    ) {
      this.slabs = this.slabs.slice(this.start);
      this.start = 0;
      if (this.slabs.length === 0) {
        this.lastByte = undefined;
        this.trailingHighSurrogate = undefined;
      }
    }
  }

  clear(): void {
    this.generation += 1;
    this.appendedBytes = 0;
    this.slabs = [];
    this.start = 0;
    this.totalBytes = 0;
    this.lineBreaks = 0;
    this.lastByte = undefined;
    this.trailingHighSurrogate = undefined;
    this.sequenceState = TERMINAL_SEQUENCE_GROUND;
    this.cachedValue = "";
  }

  private decodeTailBytes(byteCount: number): string {
    if (byteCount <= 0) return "";
    let remaining = byteCount;
    const parts: string[] = [];
    for (let index = this.slabs.length - 1; remaining > 0 && index >= this.start; index -= 1) {
      const slab = this.slabs[index]!;
      const available = slab.end - slab.start;
      const take = Math.min(available, remaining);
      parts.push(decodeSlabRange(slab, slab.end - take, slab.end));
      remaining -= take;
    }
    return parts.length === 1 ? parts[0]! : parts.toReversed().join("");
  }

  persistenceUpdate(previous?: TerminalHistoryPersistenceCursor) {
    const offset = this.appendedBytes;
    const deltaBytes =
      previous !== undefined && previous.generation === this.generation
        ? offset - previous.offset
        : -1;
    // Keep the on-disk log bounded while amortizing compaction across new output.
    const append =
      previous !== undefined &&
      deltaBytes >= 0 &&
      deltaBytes <= this.totalBytes &&
      previous.fileBytes + deltaBytes <= this.maxBytes * 2;
    const output = append ? this.decodeTailBytes(deltaBytes) : this.value();
    return {
      data: output,
      append,
      cursor: {
        generation: this.generation,
        offset,
        fileBytes: append ? previous.fileBytes + deltaBytes : this.totalBytes,
      },
    };
  }

  value(): string {
    if (this.cachedValue !== null) return this.cachedValue;
    const count = this.slabs.length - this.start;
    if (count === 0) {
      this.cachedValue = "";
      return "";
    }
    if (count === 1) {
      const only = this.slabs[this.start]!;
      this.cachedValue = decodeSlabRange(only, only.start, only.end);
      return this.cachedValue;
    }
    const parts: string[] = [];
    for (let index = this.start; index < this.slabs.length; index += 1) {
      const slab = this.slabs[index]!;
      parts.push(decodeSlabRange(slab, slab.start, slab.end));
    }
    this.cachedValue = parts.join("");
    return this.cachedValue;
  }
}
