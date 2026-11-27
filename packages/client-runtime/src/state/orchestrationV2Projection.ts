import { applyThreadPullRequestLinkUpdate } from "../threadPullRequests.ts";
import {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2TurnItem,
} from "@zerocode/contracts";
import type {
  MessageId,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
  TurnItemId,
} from "@zerocode/contracts";
import * as Schema from "effect/Schema";
import type { DedupedBodySource } from "@zerocode/shared/orchestrationV2DedupedBodies";
import { reduceOrchestrationV2ThreadProjection } from "@zerocode/shared/orchestrationV2ProjectionReducer";

export type ApplyOrchestrationV2ProjectionEventOptions = {
  readonly partialTimeline?: boolean;
  readonly latestLocalTurnOrdinal?: number | null;
};

type VisibleTurnItem = OrchestrationV2ThreadProjection["visibleTurnItems"][number];
type ConversationMessage = OrchestrationV2ThreadProjection["messages"][number];

const sameTurnItem = Schema.toEquivalence(OrchestrationV2TurnItem);
const sameAppThread = Schema.toEquivalence(OrchestrationV2AppThread);
const sameMessage = Schema.toEquivalence(OrchestrationV2ConversationMessage);

const PATCHED_MAP_MAX_DEPTH = 16;

// Persistent 1-key overlay so streaming updates to one item stay O(1) without cloning the whole Map.
class PatchedMap<K, V> implements ReadonlyMap<K, V> {
  readonly base: ReadonlyMap<K, V>;
  readonly key: K;
  readonly value: V;
  readonly depth: number;
  readonly size: number;
  private flattened: Map<K, V> | undefined;

  constructor(base: ReadonlyMap<K, V>, key: K, value: V, depth: number, size: number) {
    this.base = base;
    this.key = key;
    this.value = value;
    this.depth = depth;
    this.size = size;
  }

  private materialize(): Map<K, V> {
    if (this.flattened === undefined) {
      const map = new Map<K, V>();
      const chain: Array<PatchedMap<K, V>> = [];
      let cursor: ReadonlyMap<K, V> = this;
      while (cursor instanceof PatchedMap) {
        chain.push(cursor);
        cursor = cursor.base;
      }
      for (const [k, v] of cursor) map.set(k, v);
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        const node = chain[i]!;
        map.set(node.key, node.value);
      }
      this.flattened = map;
    }
    return this.flattened;
  }

  get(key: K): V | undefined {
    let cursor: ReadonlyMap<K, V> = this;
    while (cursor instanceof PatchedMap) {
      if (cursor.key === key) return cursor.value;
      cursor = cursor.base;
    }
    return cursor.get(key);
  }

  has(key: K): boolean {
    let cursor: ReadonlyMap<K, V> = this;
    while (cursor instanceof PatchedMap) {
      if (cursor.key === key) return true;
      cursor = cursor.base;
    }
    return cursor.has(key);
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
    this.materialize().forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }

  entries() {
    return this.materialize().entries();
  }

  keys() {
    return this.materialize().keys();
  }

  values() {
    return this.materialize().values();
  }

  [Symbol.iterator]() {
    return this.materialize()[Symbol.iterator]();
  }
}

function withMapEntry<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  if (map instanceof PatchedMap) {
    if (map.key === key) {
      return new PatchedMap(map.base, key, value, map.depth, map.size);
    }
    if (map.depth >= PATCHED_MAP_MAX_DEPTH) {
      const flat = new Map(map);
      flat.set(key, value);
      return flat;
    }
    return new PatchedMap(map, key, value, map.depth + 1, map.has(key) ? map.size : map.size + 1);
  }
  return new PatchedMap(map, key, value, 1, map.has(key) ? map.size : map.size + 1);
}

const EMPTY_VISIBLE_ITEMS_BY_ID: ReadonlyMap<TurnItemId, VisibleTurnItem> = new Map();
const EMPTY_MESSAGES_BY_ID: ReadonlyMap<MessageId, ConversationMessage> = new Map();

export interface ProjectionMeta {
  readonly quietVersion: number;
  readonly timelineVersion: number;
  readonly messagesStructureVersion: number;
  readonly requestsVersion: number;
  readonly liveTextVersion: number;
  readonly visibleTurnItemsById: ReadonlyMap<TurnItemId, VisibleTurnItem>;
  readonly messagesById: ReadonlyMap<MessageId, ConversationMessage>;
}

interface InternalProjectionMeta {
  readonly quietVersion: number;
  readonly timelineVersion: number;
  readonly messagesStructureVersion: number;
  readonly requestsVersion: number;
  readonly liveTextVersion: number;
  visibleTurnItemsById: ReadonlyMap<TurnItemId, VisibleTurnItem> | undefined;
  messagesById: ReadonlyMap<MessageId, ConversationMessage> | undefined;
  readonly view: ProjectionMeta;
}

const projectionMeta = new WeakMap<OrchestrationV2ThreadProjection, InternalProjectionMeta>();
let nextProjectionRevision = 0;

function buildVisibleTurnItemsById(
  rows: ReadonlyArray<VisibleTurnItem>,
): ReadonlyMap<TurnItemId, VisibleTurnItem> {
  if (rows.length === 0) return EMPTY_VISIBLE_ITEMS_BY_ID;
  const map = new Map<TurnItemId, VisibleTurnItem>();
  for (const row of rows) map.set(row.sourceItemId, row);
  return map;
}

function buildMessagesById(
  messages: ReadonlyArray<ConversationMessage>,
): ReadonlyMap<MessageId, ConversationMessage> {
  if (messages.length === 0) return EMPTY_MESSAGES_BY_ID;
  const map = new Map<MessageId, ConversationMessage>();
  for (const message of messages) map.set(message.id, message);
  return map;
}

function createInternalMeta(
  projection: OrchestrationV2ThreadProjection,
  versions: {
    readonly quietVersion: number;
    readonly timelineVersion: number;
    readonly messagesStructureVersion: number;
    readonly requestsVersion: number;
    readonly liveTextVersion: number;
  },
  indexes?: {
    readonly visibleTurnItemsById?: ReadonlyMap<TurnItemId, VisibleTurnItem> | undefined;
    readonly messagesById?: ReadonlyMap<MessageId, ConversationMessage> | undefined;
  },
): InternalProjectionMeta {
  const internal: InternalProjectionMeta = {
    ...versions,
    visibleTurnItemsById: indexes?.visibleTurnItemsById,
    messagesById: indexes?.messagesById,
    view: null as unknown as ProjectionMeta,
  };
  const view: ProjectionMeta = {
    quietVersion: versions.quietVersion,
    timelineVersion: versions.timelineVersion,
    messagesStructureVersion: versions.messagesStructureVersion,
    requestsVersion: versions.requestsVersion,
    liveTextVersion: versions.liveTextVersion,
    get visibleTurnItemsById() {
      internal.visibleTurnItemsById ??= buildVisibleTurnItemsById(projection.visibleTurnItems);
      return internal.visibleTurnItemsById;
    },
    get messagesById() {
      internal.messagesById ??= buildMessagesById(projection.messages);
      return internal.messagesById;
    },
  };
  (internal as { view: ProjectionMeta }).view = view;
  projectionMeta.set(projection, internal);
  return internal;
}

function getInternalProjectionMeta(
  projection: OrchestrationV2ThreadProjection,
): InternalProjectionMeta {
  const existing = projectionMeta.get(projection);
  if (existing !== undefined) return existing;
  const revision = ++nextProjectionRevision;
  return createInternalMeta(projection, {
    quietVersion: revision,
    timelineVersion: revision,
    messagesStructureVersion: revision,
    requestsVersion: revision,
    liveTextVersion: revision,
  });
}

export function getProjectionMeta(projection: OrchestrationV2ThreadProjection): ProjectionMeta {
  return getInternalProjectionMeta(projection).view;
}

export function hasProjectionMeta(projection: object): boolean {
  return projectionMeta.has(projection as OrchestrationV2ThreadProjection);
}

function sameApartFromFields<T extends object>(
  same: (left: T, right: T) => boolean,
  previous: T,
  previousStripped: object,
  next: T,
): boolean {
  return (
    Object.keys(previous).length === Object.keys(next).length &&
    same(Object.assign({}, next, previousStripped), next)
  );
}

function isQuietStreamingMessageUpdate(
  previous: ConversationMessage,
  next: ConversationMessage,
): boolean {
  if (!previous.streaming || !next.streaming || previous.id !== next.id) return false;
  const { text: _text, updatedAt: _updatedAt, ...rest } = previous;
  return sameApartFromFields(sameMessage, previous, rest, next);
}

function isQuietTurnItemTextUpdate(
  previous: OrchestrationV2TurnItem,
  next: OrchestrationV2TurnItem,
): boolean {
  if (previous === next) return true;
  if (previous.id !== next.id || previous.type !== next.type) return false;
  if (previous.type === "assistant_message" || previous.type === "reasoning") {
    const { text: _text, updatedAt: _updatedAt, ...rest } = previous;
    return sameApartFromFields(sameTurnItem, previous, rest, next);
  }
  if (previous.type === "proposed_plan" && next.type === "proposed_plan") {
    if (!previous.streaming || !next.streaming) return false;
    const { markdown: _markdown, updatedAt: _updatedAt, ...rest } = previous;
    return sameApartFromFields(sameTurnItem, previous, rest, next);
  }
  return false;
}

function isVisitOnlyThreadUpdate(
  previous: OrchestrationV2ThreadProjection["thread"],
  next: OrchestrationV2ThreadProjection["thread"],
): boolean {
  if (previous === next) return true;
  const { updatedAt: _updatedAt, lastVisitedAt: _lastVisitedAt, ...rest } = previous;
  return sameApartFromFields(sameAppThread, previous, rest, next);
}

function isRequestTurnItem(item: OrchestrationV2TurnItem | undefined): boolean {
  return item?.type === "approval_request" || item?.type === "user_input_request";
}

function replaceArrayItem<T>(items: ReadonlyArray<T>, index: number, item: T): ReadonlyArray<T> {
  const next = items.slice();
  next[index] = item;
  return next;
}

function findLastIndexById<T extends { readonly id: unknown }>(
  items: ReadonlyArray<T>,
  id: T["id"],
): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]!.id === id) return index;
  }
  return -1;
}

// A deduped item repeats a record the stream just sent, so use O(1) messagesById and tail search.
function latestBodies(
  projection: OrchestrationV2ThreadProjection,
  meta: InternalProjectionMeta,
): DedupedBodySource {
  return {
    messageText: (id) => meta.view.messagesById.get(id as MessageId)?.text,
    checkpointFiles: (id) =>
      projection.checkpoints.findLast((checkpoint) => checkpoint.id === id)?.files,
    subagent: (id) => projection.subagents.findLast((subagent) => subagent.id === id),
  };
}

function stampMeta(
  previous: OrchestrationV2ThreadProjection,
  prevMeta: InternalProjectionMeta,
  next: OrchestrationV2ThreadProjection,
  changes: {
    readonly quiet?: boolean;
    readonly timeline?: boolean;
    readonly messagesStructure?: boolean;
    readonly requests?: boolean;
    readonly liveText?: boolean;
    readonly visibleTurnItemsById?: ReadonlyMap<TurnItemId, VisibleTurnItem> | undefined;
    readonly messagesById?: ReadonlyMap<MessageId, ConversationMessage> | undefined;
    readonly resetVisibleIndex?: boolean;
  },
): OrchestrationV2ThreadProjection {
  const revision = ++nextProjectionRevision;
  const visibleTurnItemsById =
    changes.resetVisibleIndex === true
      ? undefined
      : changes.visibleTurnItemsById !== undefined
        ? changes.visibleTurnItemsById
        : next.visibleTurnItems === previous.visibleTurnItems
          ? prevMeta.visibleTurnItemsById
          : undefined;
  const messagesById =
    changes.messagesById !== undefined
      ? changes.messagesById
      : next.messages === previous.messages
        ? prevMeta.messagesById
        : undefined;
  createInternalMeta(
    next,
    {
      quietVersion: changes.quiet ? revision : prevMeta.quietVersion,
      timelineVersion: changes.timeline ? revision : prevMeta.timelineVersion,
      messagesStructureVersion: changes.messagesStructure
        ? revision
        : prevMeta.messagesStructureVersion,
      requestsVersion: changes.requests ? revision : prevMeta.requestsVersion,
      liveTextVersion: changes.liveText ? revision : prevMeta.liveTextVersion,
    },
    { visibleTurnItemsById, messagesById },
  );
  return next;
}

export type OrchestrationV2TextDeltaItem = Extract<
  OrchestrationV2ThreadStreamItem,
  { readonly kind: "text-delta" }
>;

export type ApplyOrchestrationV2TextDeltaResult =
  | { readonly _tag: "applied"; readonly projection: OrchestrationV2ThreadProjection }
  | { readonly _tag: "mismatch" };

export function applyOrchestrationV2TextDelta(
  projection: OrchestrationV2ThreadProjection | null,
  delta: OrchestrationV2TextDeltaItem,
): ApplyOrchestrationV2TextDeltaResult {
  if (projection === null) return { _tag: "mismatch" };
  const prevMeta = getInternalProjectionMeta(projection);

  if (delta.target === "message") {
    const messageId = delta.id as MessageId;
    const message = prevMeta.view.messagesById.get(messageId);
    if (
      message === undefined ||
      message.role !== "assistant" ||
      !message.streaming ||
      message.text.length !== delta.baseLength
    ) {
      return { _tag: "mismatch" };
    }
    const msgIndex = findLastIndexById(projection.messages, messageId);
    if (msgIndex === -1) return { _tag: "mismatch" };
    const nextText = message.text + delta.append;
    const nextUpdatedAt = delta.updatedAt ?? message.updatedAt;
    const nextMessage: ConversationMessage = {
      ...message,
      text: nextText,
      updatedAt: nextUpdatedAt,
    };
    const nextMessages = replaceArrayItem(projection.messages, msgIndex, nextMessage);
    const nextMessagesById = withMapEntry(prevMeta.view.messagesById, messageId, nextMessage);

    // Keep any paired streaming assistant_message turn item consistent, including deduped ones.
    let nextTurnItems = projection.turnItems;
    let nextVisibleTurnItems = projection.visibleTurnItems;
    let nextVisibleTurnItemsById = prevMeta.visibleTurnItemsById;
    let pairedTurnItemId: TurnItemId | undefined;

    for (let index = projection.turnItems.length - 1; index >= 0; index -= 1) {
      const candidate = projection.turnItems[index]!;
      if (
        candidate.type === "assistant_message" &&
        candidate.messageId === messageId &&
        candidate.streaming
      ) {
        const { textOmitted: _omitted, ...rest } = candidate;
        const updatedItem: OrchestrationV2TurnItem = {
          ...rest,
          text: nextText,
          updatedAt: nextUpdatedAt,
        };
        nextTurnItems = replaceArrayItem(projection.turnItems, index, updatedItem);
        pairedTurnItemId = updatedItem.id;
        for (let vIndex = projection.visibleTurnItems.length - 1; vIndex >= 0; vIndex -= 1) {
          const row = projection.visibleTurnItems[vIndex]!;
          if (row.sourceItemId === updatedItem.id) {
            const nextRow: VisibleTurnItem = { ...row, item: updatedItem };
            nextVisibleTurnItems = replaceArrayItem(projection.visibleTurnItems, vIndex, nextRow);
            if (prevMeta.visibleTurnItemsById !== undefined) {
              nextVisibleTurnItemsById = withMapEntry(
                prevMeta.visibleTurnItemsById,
                nextRow.sourceItemId,
                nextRow,
              );
            }
            break;
          }
        }
        break;
      }
    }

    if (pairedTurnItemId === undefined) {
      for (let vIndex = projection.visibleTurnItems.length - 1; vIndex >= 0; vIndex -= 1) {
        const row = projection.visibleTurnItems[vIndex]!;
        if (
          row.item.type === "assistant_message" &&
          row.item.messageId === messageId &&
          row.item.streaming
        ) {
          const { textOmitted: _omitted, ...rest } = row.item;
          const updatedItem: OrchestrationV2TurnItem = {
            ...rest,
            text: nextText,
            updatedAt: nextUpdatedAt,
          };
          const nextRow: VisibleTurnItem = { ...row, item: updatedItem };
          nextVisibleTurnItems = replaceArrayItem(projection.visibleTurnItems, vIndex, nextRow);
          if (prevMeta.visibleTurnItemsById !== undefined) {
            nextVisibleTurnItemsById = withMapEntry(
              prevMeta.visibleTurnItemsById,
              nextRow.sourceItemId,
              nextRow,
            );
          }
          break;
        }
      }
    }

    const nextProjection: OrchestrationV2ThreadProjection = {
      ...projection,
      updatedAt: delta.updatedAt ?? projection.updatedAt,
      messages: nextMessages,
      turnItems: nextTurnItems,
      visibleTurnItems: nextVisibleTurnItems,
    };
    return {
      _tag: "applied",
      projection: stampMeta(projection, prevMeta, nextProjection, {
        liveText: true,
        messagesById: nextMessagesById,
        visibleTurnItemsById: nextVisibleTurnItemsById,
      }),
    };
  }

  const itemId = delta.id as TurnItemId;
  const itemIndex = findLastIndexById(projection.turnItems, itemId);
  const existing = itemIndex === -1 ? undefined : projection.turnItems[itemIndex];
  if (existing === undefined) return { _tag: "mismatch" };

  let updatedItem: OrchestrationV2TurnItem;
  if (delta.target === "reasoning") {
    if (
      existing.type !== "reasoning" ||
      !existing.streaming ||
      existing.text.length !== delta.baseLength
    ) {
      return { _tag: "mismatch" };
    }
    updatedItem = {
      ...existing,
      text: existing.text + delta.append,
      updatedAt: delta.updatedAt ?? existing.updatedAt,
    };
  } else {
    if (
      existing.type !== "proposed_plan" ||
      !existing.streaming ||
      existing.markdown.length !== delta.baseLength
    ) {
      return { _tag: "mismatch" };
    }
    updatedItem = {
      ...existing,
      markdown: existing.markdown + delta.append,
      updatedAt: delta.updatedAt ?? existing.updatedAt,
    };
  }

  const nextTurnItems = replaceArrayItem(projection.turnItems, itemIndex, updatedItem);
  let nextVisibleTurnItems = projection.visibleTurnItems;
  let nextVisibleTurnItemsById = prevMeta.visibleTurnItemsById;
  for (let vIndex = projection.visibleTurnItems.length - 1; vIndex >= 0; vIndex -= 1) {
    const row = projection.visibleTurnItems[vIndex]!;
    if (row.sourceItemId === itemId) {
      const nextRow: VisibleTurnItem = { ...row, item: updatedItem };
      nextVisibleTurnItems = replaceArrayItem(projection.visibleTurnItems, vIndex, nextRow);
      if (prevMeta.visibleTurnItemsById !== undefined) {
        nextVisibleTurnItemsById = withMapEntry(prevMeta.visibleTurnItemsById, itemId, nextRow);
      }
      break;
    }
  }

  const nextProjection: OrchestrationV2ThreadProjection = {
    ...projection,
    updatedAt: delta.updatedAt ?? projection.updatedAt,
    turnItems: nextTurnItems,
    visibleTurnItems: nextVisibleTurnItems,
  };
  return {
    _tag: "applied",
    projection: stampMeta(projection, prevMeta, nextProjection, {
      // Reasoning and proposed_plan render live content from timelineVisibleTurnItemsAtom.
      timeline: nextVisibleTurnItems !== projection.visibleTurnItems,
      liveText: true,
      visibleTurnItemsById: nextVisibleTurnItemsById,
    }),
  };
}

export function applyOrchestrationV2ProjectionEvent(
  projection: OrchestrationV2ThreadProjection | null,
  event: OrchestrationV2DomainEvent,
  options?: ApplyOrchestrationV2ProjectionEventOptions,
): OrchestrationV2ThreadProjection | null {
  if (projection === null || event.threadId !== projection.thread.id) return projection;

  const prevMeta = getInternalProjectionMeta(projection);
  const reduced = reduceOrchestrationV2ThreadProjection(projection, event, {
    applyThreadPullRequestLinkUpdate,
    touchThreadUpdatedAt: false,
    visibleTurnItemsMode: "incremental",
    partialTimeline: options?.partialTimeline === true,
    latestLocalTurnOrdinal: options?.latestLocalTurnOrdinal,
    ...(event.type === "turn-item.updated"
      ? { dedupedBodySource: latestBodies(projection, prevMeta) }
      : {}),
  });
  if (reduced.dropped === true) return projection;

  const next = reduced.projection;
  switch (event.type) {
    case "thread.visit-recorded":
      return stampMeta(projection, prevMeta, next, {});
    case "thread.visited":
      return stampMeta(projection, prevMeta, next, {
        quiet: !isVisitOnlyThreadUpdate(projection.thread, next.thread),
      });
    case "run.created":
    case "run.updated":
    case "run-attempt.created":
    case "run-attempt.updated": {
      const visibleChanged = next.visibleTurnItems !== projection.visibleTurnItems;
      return stampMeta(projection, prevMeta, next, {
        quiet: true,
        timeline: visibleChanged,
        resetVisibleIndex: visibleChanged,
      });
    }
    case "runtime-request.updated":
      return stampMeta(projection, prevMeta, next, { quiet: true, requests: true });
    case "message.updated": {
      const nextMessagesById =
        prevMeta.messagesById !== undefined
          ? withMapEntry(prevMeta.messagesById, event.payload.id, event.payload)
          : undefined;
      const quietStreaming =
        reduced.previousMessage !== undefined &&
        isQuietStreamingMessageUpdate(reduced.previousMessage, event.payload);
      return stampMeta(projection, prevMeta, next, {
        quiet: !quietStreaming,
        messagesStructure: !quietStreaming,
        liveText: true,
        messagesById: nextMessagesById,
      });
    }
    case "turn-item.updated": {
      const previous = reduced.previousTurnItem;
      const payload = reduced.nextTurnItem ?? event.payload;
      const inPlaceRow = reduced.inPlaceVisibleTurnItem;
      const inPlace = inPlaceRow !== undefined && previous !== undefined;
      const quietTextUpdate = inPlace && isQuietTurnItemTextUpdate(previous, payload);
      const streamedAssistantOnly =
        quietTextUpdate &&
        previous.type === "assistant_message" &&
        payload.type === "assistant_message" &&
        previous.streaming &&
        payload.streaming;
      const nextVisibleIndex =
        inPlace && prevMeta.visibleTurnItemsById !== undefined
          ? withMapEntry(prevMeta.visibleTurnItemsById, inPlaceRow.sourceItemId, inPlaceRow)
          : undefined;
      return stampMeta(projection, prevMeta, next, {
        quiet: !quietTextUpdate,
        timeline: !streamedAssistantOnly,
        requests: isRequestTurnItem(previous) || isRequestTurnItem(payload),
        liveText: true,
        visibleTurnItemsById: nextVisibleIndex,
        resetVisibleIndex: !inPlace && next.visibleTurnItems !== projection.visibleTurnItems,
      });
    }
    default:
      return stampMeta(projection, prevMeta, next, { quiet: true });
  }
}
