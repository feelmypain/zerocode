import {
  retainTerminalSnapshotHistory,
  skipTerminalSnapshotContinuation,
  TERMINAL_SEQUENCE_GROUND,
  type TerminalSessionSnapshot,
  terminalSequenceEnd,
  terminalSequenceStateAfter,
} from "@zerocode/contracts";

export interface TerminalOutputChunk {
  readonly startOffset: number;
  readonly data: string;
  readonly byteLength: number;
}

export interface TerminalOutputState {
  readonly generation: number;
  readonly chunks: ReadonlyArray<TerminalOutputChunk>;
  readonly retainedBytes: number;
  readonly resetVersion: number;
  readonly nextOffset: number;
  // The terminal parser's state at the first retained code unit. Trimming can cut a control
  // sequence, and a replay has to skip the rest of it instead of printing it.
  readonly sequenceState: number;
  /** Parser state of a prefix omitted after the snapshot history. */
  readonly pendingSnapshotSequenceState?: number | undefined;
  /** Chunks before this offset are replayed to emulators but are no longer displayed text. */
  readonly textStartOffset: number;
}

export interface TerminalOutputCursor {
  readonly generation: number;
  readonly resetVersion: number;
  readonly offset: number;
  // The cut control sequence still open at `offset`, which the reader's terminal never entered.
  readonly sequenceState: number;
}

export const INITIAL_TERMINAL_OUTPUT_CURSOR = Object.freeze<TerminalOutputCursor>({
  generation: -1,
  resetVersion: -1,
  offset: 0,
  sequenceState: TERMINAL_SEQUENCE_GROUND,
});

export type TerminalOutputUpdate =
  | {
      readonly type: "none";
      readonly cursor: TerminalOutputCursor;
    }
  | {
      readonly type: "reset";
      readonly data: string;
      readonly cursor: TerminalOutputCursor;
    }
  | {
      readonly type: "append";
      readonly cursor: TerminalOutputCursor;
      readonly data: string;
    };

const DEFAULT_TERMINAL_CHUNK_BYTES = 16 * 1024;
const TAIL_COALESCE_CHUNK_BYTES = 4 * 1024;
const MAX_TERMINAL_OUTPUT_CHUNKS = 1_024;

export const EMPTY_TERMINAL_OUTPUT_STATE = Object.freeze<TerminalOutputState>({
  generation: 0,
  chunks: Object.freeze([]),
  retainedBytes: 0,
  resetVersion: 0,
  nextOffset: 0,
  sequenceState: TERMINAL_SEQUENCE_GROUND,
  textStartOffset: 0,
});

interface Utf8Chunk {
  readonly data: string;
  readonly byteLength: number;
}

/** Zero-allocation UTF-8 byte length matching TextEncoder (lone surrogates encode as U+FFFD = 3 bytes). */
export function utf8ByteLength(data: string): number {
  let bytes = 0;
  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < data.length) {
      const low = data.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function splitStringByUtf8Bytes(data: string, maxBytes: number): ReadonlyArray<Utf8Chunk> {
  if (data.length === 0) return [];

  const totalBytes = utf8ByteLength(data);
  if (totalBytes <= maxBytes) {
    return [{ data, byteLength: totalBytes }];
  }

  const chunks: Utf8Chunk[] = [];
  let start = 0;
  let chunkBytes = 0;
  let index = 0;
  while (index < data.length) {
    const code = data.charCodeAt(index);
    let stepUnits = 1;
    let stepBytes: number;
    if (code <= 0x7f) {
      stepBytes = 1;
    } else if (code <= 0x7ff) {
      stepBytes = 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < data.length) {
      const low = data.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        stepUnits = 2;
        stepBytes = 4;
      } else {
        stepBytes = 3;
      }
    } else {
      stepBytes = 3;
    }
    if (chunkBytes > 0 && chunkBytes + stepBytes > maxBytes) {
      chunks.push({ data: data.slice(start, index), byteLength: chunkBytes });
      start = index;
      chunkBytes = 0;
    }
    chunkBytes += stepBytes;
    index += stepUnits;
    // A degenerate budget smaller than one code point still advances by that code point.
    if (chunkBytes >= maxBytes && index < data.length) {
      chunks.push({ data: data.slice(start, index), byteLength: chunkBytes });
      start = index;
      chunkBytes = 0;
    }
  }
  if (start < data.length) {
    chunks.push({ data: data.slice(start), byteLength: chunkBytes });
  }

  return chunks;
}

function splitOutputChunks(
  data: string,
  firstOffset: number,
  maxChunkBytes = DEFAULT_TERMINAL_CHUNK_BYTES,
): {
  readonly chunks: ReadonlyArray<TerminalOutputChunk>;
  readonly nextOffset: number;
  readonly byteLength: number;
} {
  const split = splitStringByUtf8Bytes(data, maxChunkBytes);
  let byteLength = 0;
  let nextOffset = firstOffset;
  const chunks = split.map((chunk) => {
    byteLength += chunk.byteLength;
    const startOffset = nextOffset;
    nextOffset += chunk.data.length;
    return {
      startOffset,
      data: chunk.data,
      byteLength: chunk.byteLength,
    };
  });

  return {
    chunks,
    nextOffset,
    byteLength,
  };
}

function compactRetainedChunks(chunks: ReadonlyArray<TerminalOutputChunk>) {
  const compacted: TerminalOutputChunk[] = [];
  for (const chunk of chunks) {
    const previous = compacted.at(-1);
    if (
      previous !== undefined &&
      previous.startOffset + previous.data.length === chunk.startOffset &&
      previous.byteLength + chunk.byteLength <= DEFAULT_TERMINAL_CHUNK_BYTES
    ) {
      compacted[compacted.length - 1] = {
        startOffset: previous.startOffset,
        data: `${previous.data}${chunk.data}`,
        byteLength: previous.byteLength + chunk.byteLength,
      };
    } else {
      compacted.push(chunk);
    }
  }
  return compacted;
}

function trimOutputChunkStart(
  chunk: TerminalOutputChunk,
  bytesToDrop: number,
): TerminalOutputChunk {
  let offset = 0;
  let droppedBytes = 0;
  while (droppedBytes < bytesToDrop && offset < chunk.data.length) {
    const codepoint = chunk.data.codePointAt(offset)!;
    droppedBytes += codepoint <= 0x7f ? 1 : codepoint <= 0x7ff ? 2 : codepoint <= 0xffff ? 3 : 4;
    offset += codepoint <= 0xffff ? 1 : 2;
  }
  return {
    ...chunk,
    startOffset: chunk.startOffset + offset,
    data: chunk.data.slice(offset),
    byteLength: chunk.byteLength - droppedBytes,
  };
}

function appendOutput(
  current: TerminalOutputState,
  data: string,
  maxBufferBytes: number,
): TerminalOutputState {
  const pending = current.pendingSnapshotSequenceState;
  if (pending === undefined || data.length === 0) {
    return appendRetainedOutput(current, data, maxBufferBytes);
  }
  const continuation = skipTerminalSnapshotContinuation(pending, data);
  return appendRetainedOutput(
    {
      ...current,
      pendingSnapshotSequenceState:
        continuation.state === TERMINAL_SEQUENCE_GROUND ? undefined : continuation.state,
    },
    continuation.data,
    maxBufferBytes,
  );
}

function appendRetainedOutput(
  current: TerminalOutputState,
  data: string,
  maxBufferBytes: number,
): TerminalOutputState {
  if (data.length === 0) return current;
  if (maxBufferBytes <= 0) {
    return {
      generation: current.generation,
      chunks: [],
      retainedBytes: 0,
      resetVersion: current.resetVersion + 1,
      nextOffset: current.nextOffset + data.length,
      sequenceState: TERMINAL_SEQUENCE_GROUND,
      textStartOffset: current.textStartOffset,
    };
  }
  const maxChunkBytes = Math.min(DEFAULT_TERMINAL_CHUNK_BYTES, Math.max(1, maxBufferBytes));
  const appended = splitOutputChunks(data, current.nextOffset, maxChunkBytes);

  let retainedBytes = current.retainedBytes + appended.byteLength;
  let sequenceState = current.sequenceState;
  const tailCoalesceBudget = Math.min(TAIL_COALESCE_CHUNK_BYTES, maxChunkBytes);

  // Coalesce small consecutive tail writes into bounded chunks to avoid per-chunk array churn.
  if (
    retainedBytes <= maxBufferBytes &&
    current.chunks.length > 0 &&
    appended.chunks.length === 1
  ) {
    const last = current.chunks[current.chunks.length - 1]!;
    const firstNew = appended.chunks[0]!;
    if (
      last.startOffset + last.data.length === firstNew.startOffset &&
      last.byteLength + firstNew.byteLength <= tailCoalesceBudget
    ) {
      const merged = current.chunks.slice();
      merged[merged.length - 1] = {
        startOffset: last.startOffset,
        data: `${last.data}${firstNew.data}`,
        byteLength: last.byteLength + firstNew.byteLength,
      };
      return {
        generation: current.generation,
        chunks: merged,
        retainedBytes,
        resetVersion: current.resetVersion,
        nextOffset: appended.nextOffset,
        sequenceState,
        textStartOffset: current.textStartOffset,
      };
    }
  }

  // Evict over-budget prefix over a virtual view of current + appended before allocating once.
  const currentCount = current.chunks.length;
  const totalCount = currentCount + appended.chunks.length;
  const chunkAt = (index: number) =>
    index < currentCount ? current.chunks[index]! : appended.chunks[index - currentCount]!;

  let firstRetainedIndex = 0;
  let trimmedFirst: TerminalOutputChunk | undefined;
  while (retainedBytes > maxBufferBytes && firstRetainedIndex < totalCount) {
    const first = chunkAt(firstRetainedIndex);
    const bytesToDrop = retainedBytes - maxBufferBytes;
    if (bytesToDrop < first.byteLength) {
      const trimmed = trimOutputChunkStart(first, bytesToDrop);
      sequenceState = terminalSequenceStateAfter(
        sequenceState,
        first.data,
        0,
        first.data.length - trimmed.data.length,
      );
      retainedBytes -= first.byteLength - trimmed.byteLength;
      if (trimmed.byteLength > 0) {
        trimmedFirst = trimmed;
      } else {
        firstRetainedIndex += 1;
      }
      break;
    }
    sequenceState = terminalSequenceStateAfter(sequenceState, first.data);
    retainedBytes -= first.byteLength;
    firstRetainedIndex += 1;
  }

  let retainedChunks: TerminalOutputChunk[];
  const retainedCount = totalCount - firstRetainedIndex;
  if (retainedCount <= 0) {
    retainedChunks = [];
  } else {
    retainedChunks = new Array<TerminalOutputChunk>(retainedCount);
    for (let offset = 0; offset < retainedCount; offset += 1) {
      retainedChunks[offset] =
        offset === 0 && trimmedFirst !== undefined
          ? trimmedFirst
          : chunkAt(firstRetainedIndex + offset);
    }
  }

  if (retainedChunks.length > MAX_TERMINAL_OUTPUT_CHUNKS) {
    retainedChunks = compactRetainedChunks(retainedChunks);
    const excessChunks = retainedChunks.length - MAX_TERMINAL_OUTPUT_CHUNKS;
    if (excessChunks > 0) {
      for (let index = 0; index < excessChunks; index += 1) {
        const chunk = retainedChunks[index]!;
        sequenceState = terminalSequenceStateAfter(sequenceState, chunk.data);
        retainedBytes -= chunk.byteLength;
      }
      retainedChunks = retainedChunks.slice(excessChunks);
    }
  }

  return {
    generation: current.generation,
    chunks: retainedChunks,
    retainedBytes,
    resetVersion: current.resetVersion,
    nextOffset: appended.nextOffset,
    sequenceState,
    textStartOffset: current.textStartOffset,
  };
}

function resetOutput(
  current: TerminalOutputState,
  snapshot: Pick<TerminalSessionSnapshot, "history" | "historySequenceState">,
  maxBufferBytes: number,
): TerminalOutputState {
  const retained = retainTerminalSnapshotHistory(snapshot.history, maxBufferBytes);
  const reset = splitOutputChunks(
    retained.history,
    0,
    Math.min(DEFAULT_TERMINAL_CHUNK_BYTES, Math.max(1, maxBufferBytes)),
  );
  return {
    generation: current.generation,
    chunks: reset.chunks,
    retainedBytes: reset.byteLength,
    resetVersion: current.resetVersion + 1,
    nextOffset: reset.nextOffset,
    sequenceState: TERMINAL_SEQUENCE_GROUND,
    pendingSnapshotSequenceState: snapshot.historySequenceState ?? retained.historySequenceState,
    textStartOffset: 0,
  };
}

// Erases the screen and scrollback only. A full emulator reset would drop the
// screen and input modes the still-running program negotiated.
const CLEAR_TERMINAL_TEXT = "\u001b[H\u001b[2J\u001b[3J";

/** Earlier output stays retained so a replay from the start restores those modes. */
function clearOutput(
  current: TerminalOutputState,
  maxBufferBytes: number,
  pendingControlSequence = "",
): TerminalOutputState {
  const data = CLEAR_TERMINAL_TEXT + pendingControlSequence;
  // The erase rides over the budget: trimming here would evict the output that set those modes.
  const cleared = appendOutput(
    { ...current, pendingSnapshotSequenceState: undefined },
    data,
    maxBufferBytes <= 0
      ? maxBufferBytes
      : Math.max(maxBufferBytes, current.retainedBytes + utf8ByteLength(data)),
  );
  return { ...cleared, textStartOffset: cleared.nextOffset };
}

/** Everything a fresh emulator replays: retained output from outside any control sequence. */
export function terminalOutputReplay(output: TerminalOutputState): string {
  const text = output.chunks.map((chunk) => chunk.data).join("");
  return text.slice(terminalSequenceEnd(output.sequenceState, text));
}

/** The output as plain text, for surfaces that do not interpret escape sequences. */
export function terminalOutputText(output: TerminalOutputState): string {
  const text = output.chunks.map((chunk) => chunk.data).join("");
  const firstOffset = output.chunks[0]?.startOffset ?? output.nextOffset;
  const start = Math.max(0, output.textStartOffset - firstOffset);
  const sequenceState = terminalSequenceStateAfter(output.sequenceState, text, 0, start);
  const visible = text.slice(start);
  return visible.slice(terminalSequenceEnd(sequenceState, visible));
}

export function readTerminalOutputUpdate(
  output: TerminalOutputState,
  cursor: TerminalOutputCursor,
): TerminalOutputUpdate {
  const position = {
    generation: output.generation,
    resetVersion: output.resetVersion,
    offset: output.nextOffset,
  };
  const firstChunk = output.chunks[0];
  const firstStartOffset = firstChunk === undefined ? output.nextOffset : firstChunk.startOffset;
  if (
    cursor.generation !== output.generation ||
    cursor.resetVersion !== output.resetVersion ||
    cursor.offset < firstStartOffset
  ) {
    const text = output.chunks.map((chunk) => chunk.data).join("");
    const start = terminalSequenceEnd(output.sequenceState, text);
    return {
      type: "reset",
      data: text.slice(start),
      cursor: {
        ...position,
        sequenceState: terminalSequenceStateAfter(output.sequenceState, text, 0, start),
      },
    };
  }

  // Appends and compaction preserve offset order, so unread chunks form a suffix.
  const unreadSlices: string[] = [];
  for (let index = output.chunks.length - 1; index >= 0; index -= 1) {
    const chunk = output.chunks[index]!;
    const startOffset = index === 0 ? firstStartOffset : chunk.startOffset;
    if (!(startOffset + chunk.data.length > cursor.offset)) break;
    unreadSlices.push(chunk.data.slice(Math.max(0, cursor.offset - startOffset)));
  }
  unreadSlices.reverse();
  const text = unreadSlices.length === 1 ? unreadSlices[0]! : unreadSlices.join("");
  const start = terminalSequenceEnd(cursor.sequenceState, text);
  const nextCursor = {
    ...position,
    sequenceState: terminalSequenceStateAfter(cursor.sequenceState, text, 0, start),
  };
  if (start === text.length) {
    return { type: "none", cursor: nextCursor };
  }
  return { type: "append", data: text.slice(start), cursor: nextCursor };
}

export { appendOutput, clearOutput, resetOutput };
