import {
  applyOrchestrationV2ThreadVisit,
  isQueuedProviderThreadPlaceholder,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ThreadPullRequestLink,
} from "@zerocode/contracts";

import {
  restoreSubagentBodies,
  restoreTurnItemBodies,
  type DedupedBodySource,
} from "./orchestrationV2DedupedBodies.ts";
import {
  createOrchestrationV2TurnItemVisibility,
  isOrchestrationV2TurnItemVisible,
} from "./orchestrationV2Timeline.ts";

type VisibleTurnItem = OrchestrationV2ThreadProjection["visibleTurnItems"][number];

export interface ReduceOrchestrationV2ThreadProjectionOptions {
  readonly applyThreadPullRequestLinkUpdate: (
    thread: OrchestrationV2AppThread,
    link: ThreadPullRequestLink,
  ) => OrchestrationV2AppThread;
  /**
   * Whether activity events also bump `projection.thread.updatedAt` (server SQL parity).
   * Clients leave `projection.thread` referentially stable across non-thread streaming updates.
   */
  readonly touchThreadUpdatedAt?: boolean | undefined;
  /**
   * `"local-rebuild"` derives `visibleTurnItems` from local `turnItems` (server pure projection).
   * `"incremental"` preserves inherited rows, supports partial-timeline windowing, and tracks
   * in-place replacements for O(1) client projection metadata.
   */
  readonly visibleTurnItemsMode?: "local-rebuild" | "incremental" | undefined;
  readonly partialTimeline?: boolean | undefined;
  readonly latestLocalTurnOrdinal?: number | null | undefined;
  readonly dedupedBodySource?: DedupedBodySource | undefined;
}

export interface ReduceOrchestrationV2ThreadProjectionResult {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly previousMessage?: OrchestrationV2ConversationMessage | undefined;
  readonly previousTurnItem?: OrchestrationV2TurnItem | undefined;
  readonly nextTurnItem?: OrchestrationV2TurnItem | undefined;
  readonly inPlaceVisibleTurnItem?: OrchestrationV2ProjectedTurnItem | undefined;
  readonly dropped?: boolean | undefined;
}

function replaceArrayItem<T>(items: ReadonlyArray<T>, index: number, item: T): Array<T> {
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

function upsertById<T extends { readonly id: unknown }>(
  items: ReadonlyArray<T>,
  next: T,
): Array<T> {
  const index = findLastIndexById(items, next.id);
  if (index === -1) return [...items, next];
  return replaceArrayItem(items, index, next);
}

/** Adapters resend whole rosters without runs, so a task keeps the run it first appeared under. */
export function attributePendingBackgroundTasks(
  next: OrchestrationV2ProviderThread,
  previous: Pick<OrchestrationV2ProviderThread, "pendingBackgroundTasks"> | undefined,
  runId: OrchestrationV2DomainEvent["runId"],
): OrchestrationV2ProviderThread {
  const tasks = next.pendingBackgroundTasks ?? [];
  if (tasks.every((task) => task.runId !== undefined)) return next;
  const known = new Map(
    (previous?.pendingBackgroundTasks ?? []).map((task) => [task.taskId, task.runId]),
  );
  return {
    ...next,
    pendingBackgroundTasks: tasks.map((task) => {
      const owner = task.runId ?? (known.has(task.taskId) ? known.get(task.taskId) : runId);
      return owner === undefined ? task : { ...task, runId: owner };
    }),
  };
}

export function upsertProviderTurn(
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  next: OrchestrationV2ProviderTurn,
): Array<OrchestrationV2ProviderTurn> {
  const index = findLastIndexById(turns, next.id);
  const current = index === -1 ? undefined : turns[index];
  const merged = {
    ...next,
    ...((next.tokenUsage ?? current?.tokenUsage) === undefined
      ? {}
      : { tokenUsage: next.tokenUsage ?? current?.tokenUsage }),
  };
  return index === -1 ? [...turns, merged] : replaceArrayItem(turns, index, merged);
}

function preserveRunRecordedFields(
  current: OrchestrationV2Run | undefined,
  next: OrchestrationV2Run,
): OrchestrationV2Run {
  if (current === undefined) return next;
  return {
    ...next,
    ...(next.delegatedCompletion === undefined && current.delegatedCompletion !== undefined
      ? { delegatedCompletion: current.delegatedCompletion }
      : {}),
    ...(next.restartCancelledBackgroundWork === undefined &&
    current.restartCancelledBackgroundWork !== undefined
      ? { restartCancelledBackgroundWork: current.restartCancelledBackgroundWork }
      : {}),
    // Only a submission sets the output; a lifecycle write carries it as it was when read.
    ...(current.output !== undefined ? { output: current.output } : {}),
  };
}

function preserveCompletionDelivery(
  current: OrchestrationV2Subagent | undefined,
  next: OrchestrationV2Subagent,
): OrchestrationV2Subagent {
  if (next.completionDelivery !== undefined || current?.completionDelivery === undefined) {
    return next;
  }
  return { ...next, completionDelivery: current.completionDelivery };
}

function activeLocalTurnItems(
  projection: OrchestrationV2ThreadProjection,
): Array<OrchestrationV2ProjectedTurnItem> {
  const isVisible = createOrchestrationV2TurnItemVisibility({
    runs: projection.runs,
    attempts: projection.attempts,
    items: projection.turnItems,
  });
  return projection.turnItems.filter(isVisible).map((item, position) => ({
    position,
    visibility: "local" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  }));
}

function withLocalVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  return {
    ...projection,
    visibleTurnItems: activeLocalTurnItems(projection),
  };
}

function renumberVisibleItems(
  rows: OrchestrationV2ThreadProjection["visibleTurnItems"],
): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  return rows.map((row, position) => (row.position === position ? row : { ...row, position }));
}

function removeVisibleItem(
  rows: OrchestrationV2ThreadProjection["visibleTurnItems"],
  sourceItemId: OrchestrationV2TurnItem["id"],
): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  let index = rows.length - 1;
  while (index >= 0 && rows[index]!.sourceItemId !== sourceItemId) index -= 1;
  if (index === -1) return rows;
  return renumberVisibleItems([...rows.slice(0, index), ...rows.slice(index + 1)]);
}

function shouldShowLocalTurnItem(
  projection: OrchestrationV2ThreadProjection,
  item: OrchestrationV2TurnItem,
): boolean {
  return isOrchestrationV2TurnItemVisible({
    item,
    runs: projection.runs,
    attempts: projection.attempts,
    items: projection.turnItems,
  });
}

function activeVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  const rows = projection.visibleTurnItems;
  const isVisible = createOrchestrationV2TurnItemVisibility({
    runs: projection.runs,
    attempts: projection.attempts,
    items: projection.turnItems,
  });
  let next: Array<VisibleTurnItem> | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const keep = row.visibility !== "local" || isVisible(row.item);
    if (!keep) {
      next ??= rows.slice(0, index);
      continue;
    }
    next?.push(row);
  }
  return next === null ? rows : renumberVisibleItems(next);
}

function oldestLocalTurnOrdinal(
  rows: OrchestrationV2ThreadProjection["visibleTurnItems"],
): number | null {
  let oldest: number | null = null;
  for (const row of rows) {
    if (row.visibility !== "local") continue;
    if (oldest === null || row.item.ordinal < oldest) {
      oldest = row.item.ordinal;
    }
  }
  return oldest;
}

const UNFINISHED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

function isBelowPartialWindow(
  projection: OrchestrationV2ThreadProjection,
  item: OrchestrationV2TurnItem,
  latestLocalTurnOrdinal: number | null | undefined,
): boolean {
  if (
    latestLocalTurnOrdinal !== null &&
    latestLocalTurnOrdinal !== undefined &&
    item.ordinal <= latestLocalTurnOrdinal
  ) {
    return true;
  }
  const oldest = oldestLocalTurnOrdinal(projection.visibleTurnItems);
  return oldest !== null && item.ordinal < oldest;
}

function shouldDropMissingPartialTurnItem(
  projection: OrchestrationV2ThreadProjection,
  item: OrchestrationV2TurnItem,
  latestLocalTurnOrdinal: number | null | undefined,
): boolean {
  if (projection.visibleTurnItems.some((row) => row.sourceItemId === item.id)) {
    return false;
  }
  if (item.runId === null) {
    return isBelowPartialWindow(projection, item, latestLocalTurnOrdinal);
  }
  // A queued run keeps the ordinal it got when queued, so a steer sent later
  // can raise the watermark past it. Items of a run that has not finished are
  // new, not unloaded history: the first lands while the run is still queued,
  // and a bounded window can start after the ones before it.
  if (
    projection.runs.some((run) => run.id === item.runId && UNFINISHED_RUN_STATUSES.has(run.status))
  ) {
    return false;
  }
  if (
    projection.visibleTurnItems.some(
      (row) =>
        row.visibility === "local" &&
        row.item.runId === item.runId &&
        row.item.ordinal <= item.ordinal,
    )
  ) {
    return false;
  }
  return isBelowPartialWindow(projection, item, latestLocalTurnOrdinal);
}

interface UpsertVisibleTurnItemResult {
  readonly rows: OrchestrationV2ThreadProjection["visibleTurnItems"];
  readonly inPlaceRow?: VisibleTurnItem;
}

function upsertVisibleTurnItemDetailed(
  projection: OrchestrationV2ThreadProjection,
  item: OrchestrationV2TurnItem,
  partialTimeline: boolean,
  latestLocalTurnOrdinal: number | null | undefined,
): UpsertVisibleTurnItemResult {
  const rows = projection.visibleTurnItems;
  // Streamed updates land on the newest rows. Item ids are unique, so the search can start there.
  let index = rows.length - 1;
  while (index >= 0 && rows[index]!.sourceItemId !== item.id) index -= 1;
  const next = {
    position: 0,
    visibility: "local" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  };
  const previous = index === -1 ? undefined : rows[index]!;
  if (
    previous !== undefined &&
    previous.visibility === next.visibility &&
    previous.sourceThreadId === next.sourceThreadId
  ) {
    if (previous.item === item) return { rows, inPlaceRow: previous };
    if (previous.item.ordinal === item.ordinal) {
      const inPlaceRow = { ...next, position: previous.position };
      return { rows: replaceArrayItem(rows, index, inPlaceRow), inPlaceRow };
    }
  }
  if (
    index === -1 &&
    partialTimeline &&
    shouldDropMissingPartialTurnItem(projection, item, latestLocalTurnOrdinal)
  ) {
    return { rows };
  }
  // The item goes before the first later local row, as if its old row were removed first.
  let insertion = rows.length;
  for (let candidate = 0; candidate < rows.length; candidate += 1) {
    const row = rows[candidate]!;
    if (
      candidate !== index &&
      row.visibility === "local" &&
      (row.item.ordinal > item.ordinal ||
        (row.item.ordinal === item.ordinal &&
          String(row.item.id).localeCompare(String(item.id)) > 0))
    ) {
      insertion = candidate;
      break;
    }
  }
  const updated: Array<VisibleTurnItem> = [];
  for (let source = 0; source < rows.length; source += 1) {
    if (source === insertion) updated.push(next);
    if (source !== index) updated.push(rows[source]!);
  }
  if (insertion === rows.length) updated.push(next);
  for (let position = 0; position < updated.length; position += 1) {
    const row = updated[position]!;
    if (row.position !== position) updated[position] = { ...row, position };
  }
  return { rows: updated };
}

// A user item retained for a queued run stays hidden until the run leaves the queue, and its
// update can arrive before or after that run update. Items in `turnItems` were loaded or streamed,
// so they skip the partial-window check; items never received stay absent.
function restoreQueuedUserItems(
  projection: OrchestrationV2ThreadProjection,
  runId: OrchestrationV2Run["id"],
): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  let visibleTurnItems = projection.visibleTurnItems;
  for (const item of projection.turnItems) {
    if (item.runId !== runId || item.type !== "user_message" || item.inputIntent !== "queued_turn")
      continue;
    if (!shouldShowLocalTurnItem(projection, item)) continue;
    visibleTurnItems = upsertVisibleTurnItemDetailed(
      { ...projection, visibleTurnItems },
      item,
      false,
      null,
    ).rows;
  }
  return visibleTurnItems;
}

export function createEmptyOrchestrationV2ThreadProjection(
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }>,
): OrchestrationV2ThreadProjection {
  return {
    thread: event.payload,
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: event.occurredAt,
  };
}

export function reduceOrchestrationV2ThreadProjection(
  projection: OrchestrationV2ThreadProjection,
  event: OrchestrationV2DomainEvent,
  options: ReduceOrchestrationV2ThreadProjectionOptions,
): ReduceOrchestrationV2ThreadProjectionResult {
  const visibleTurnItemsMode = options.visibleTurnItemsMode ?? "local-rebuild";
  const activityBase = (): OrchestrationV2ThreadProjection =>
    options.touchThreadUpdatedAt === true
      ? {
          ...projection,
          thread: {
            ...projection.thread,
            updatedAt: event.occurredAt,
          },
          updatedAt: event.occurredAt,
        }
      : {
          ...projection,
          updatedAt: event.occurredAt,
        };

  switch (event.type) {
    case "thread.pull-request-link-updated":
      return {
        projection: {
          ...projection,
          thread: options.applyThreadPullRequestLinkUpdate(projection.thread, event.payload),
        },
      };
    case "thread.created":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.auto-settle-set":
    case "thread.pinned":
    case "thread.unpinned":
    case "thread.pin-reordered":
    case "thread.metadata-updated":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
    case "thread.guest-share-updated":
      return {
        projection: {
          ...projection,
          thread: event.payload,
          updatedAt: event.occurredAt,
        },
      };
    // Reordering, tags, and PR/issue refreshes preserve the orchestrator's activity timestamp.
    case "thread.active-reordered":
    case "thread.tags-updated":
    case "thread.pull-request-synced":
    case "thread.issue-synced":
      return {
        projection: {
          ...projection,
          thread: event.payload,
          updatedAt: event.payload.updatedAt,
        },
      };
    case "thread.visited":
    case "thread.marked-unread":
      return {
        projection: {
          ...projection,
          thread: event.payload,
        },
      };
    case "thread.visit-recorded":
      return {
        projection: {
          ...projection,
          thread: applyOrchestrationV2ThreadVisit(projection.thread, event.payload),
        },
      };
    case "run.created":
    case "run.updated": {
      const base = activityBase();
      const existingIndex = findLastIndexById(base.runs, event.payload.id);
      const existing = existingIndex === -1 ? undefined : base.runs[existingIndex];
      const merged = preserveRunRecordedFields(existing, event.payload);
      const runs =
        existingIndex === -1
          ? [...base.runs, merged]
          : replaceArrayItem(base.runs, existingIndex, merged);
      const next = { ...base, runs };
      if (visibleTurnItemsMode === "local-rebuild") {
        return { projection: withLocalVisibleTurnItems(next) };
      }
      const visible = { ...next, visibleTurnItems: activeVisibleTurnItems(next) };
      const wasQueued = existing?.status === "queued";
      return {
        projection:
          wasQueued && merged.status !== "queued"
            ? { ...visible, visibleTurnItems: restoreQueuedUserItems(visible, merged.id) }
            : visible,
      };
    }
    case "run.background-work-cancelled": {
      const base = activityBase();
      return {
        projection: {
          ...base,
          runs: base.runs.map((run) =>
            run.id === event.payload.runId
              ? {
                  ...run,
                  restartCancelledBackgroundWork: event.payload.restartCancelledBackgroundWork,
                }
              : run,
          ),
        },
      };
    }
    case "run.output-submitted": {
      const base = activityBase();
      return {
        projection: {
          ...base,
          runs: base.runs.map((run) =>
            run.id === event.payload.runId ? { ...run, output: event.payload.output } : run,
          ),
        },
      };
    }
    case "run-attempt.created":
    case "run-attempt.updated": {
      const base = activityBase();
      const next = { ...base, attempts: upsertById(base.attempts, event.payload) };
      return {
        projection:
          visibleTurnItemsMode === "local-rebuild"
            ? withLocalVisibleTurnItems(next)
            : { ...next, visibleTurnItems: activeVisibleTurnItems(next) },
      };
    }
    case "node.updated": {
      const base = activityBase();
      return {
        projection: {
          ...base,
          nodes: upsertById(base.nodes, event.payload),
        },
      };
    }
    case "subagent.updated": {
      const base = activityBase();
      const existingIndex = findLastIndexById(base.subagents, event.payload.id);
      const existing = existingIndex === -1 ? undefined : base.subagents[existingIndex];
      const restored = restoreSubagentBodies(event.payload, existing);
      const merged = preserveCompletionDelivery(existing, restored);
      return {
        projection: {
          ...base,
          subagents:
            existingIndex === -1
              ? [...base.subagents, merged]
              : replaceArrayItem(base.subagents, existingIndex, merged),
        },
      };
    }
    case "provider-session.attached":
    case "provider-session.updated": {
      const base = activityBase();
      return {
        projection: {
          ...base,
          providerSessions: upsertById(base.providerSessions, event.payload),
        },
      };
    }
    case "provider-session.detached": {
      const base = activityBase();
      return {
        projection: {
          ...base,
          providerSessions: base.providerSessions.filter(
            (session) => session.id !== event.payload.providerSessionId,
          ),
        },
      };
    }
    case "provider-thread.updated": {
      const base = activityBase();
      const existingIndex = findLastIndexById(base.providerThreads, event.payload.id);
      const existing = existingIndex === -1 ? undefined : base.providerThreads[existingIndex];
      const attributed = attributePendingBackgroundTasks(event.payload, existing, event.runId);
      return {
        projection: {
          ...base,
          thread:
            event.payload.appThreadId === base.thread.id &&
            !isQueuedProviderThreadPlaceholder(event.payload)
              ? {
                  ...base.thread,
                  activeProviderThreadId: event.payload.id,
                }
              : base.thread,
          providerThreads:
            existingIndex === -1
              ? [...base.providerThreads, attributed]
              : replaceArrayItem(base.providerThreads, existingIndex, attributed),
        },
      };
    }
    case "provider-turn.updated": {
      const base = activityBase();
      return {
        projection: {
          ...base,
          providerTurns: upsertProviderTurn(base.providerTurns, event.payload),
        },
      };
    }
    case "runtime-request.updated": {
      const base = activityBase();
      return {
        projection: {
          ...base,
          runtimeRequests: upsertById(base.runtimeRequests, event.payload),
        },
      };
    }
    case "message.updated": {
      const base = activityBase();
      const msgIndex = findLastIndexById(base.messages, event.payload.id);
      const previousMessage = msgIndex === -1 ? undefined : base.messages[msgIndex];
      const messages =
        msgIndex === -1
          ? [...base.messages, event.payload]
          : replaceArrayItem(base.messages, msgIndex, event.payload);
      return {
        projection: {
          ...base,
          messages,
        },
        previousMessage,
      };
    }
    case "turn-item.updated": {
      if (visibleTurnItemsMode === "local-rebuild") {
        const base = activityBase();
        return {
          projection: withLocalVisibleTurnItems({
            ...base,
            turnItems: upsertById(base.turnItems, event.payload),
          }),
        };
      }
      let payload =
        options.dedupedBodySource === undefined
          ? event.payload
          : restoreTurnItemBodies(event.payload, options.dedupedBodySource);
      // Streamed updates land on the newest items, so search from the end.
      const itemIndex = findLastIndexById(projection.turnItems, payload.id);
      const previous = itemIndex === -1 ? undefined : projection.turnItems[itemIndex];
      const deferredWork = previous?.deferredWork;
      if (deferredWork !== undefined) payload = { ...payload, deferredWork };
      const partialTimeline = options.partialTimeline === true;
      const latestLocalTurnOrdinal = options.latestLocalTurnOrdinal;
      if (
        partialTimeline &&
        itemIndex === -1 &&
        shouldDropMissingPartialTurnItem(projection, payload, latestLocalTurnOrdinal)
      ) {
        return { projection, dropped: true };
      }
      const turnItems =
        itemIndex === -1
          ? [...projection.turnItems, payload]
          : replaceArrayItem(projection.turnItems, itemIndex, payload);
      const next = { ...activityBase(), turnItems };
      // Only interrupt requests can change another item's visibility. Streaming
      // text/tool updates must not recheck every row against every run.
      const recheckedVisibility =
        payload.type === "run_interrupt_request" || previous?.type === "run_interrupt_request";
      const visible = recheckedVisibility
        ? { ...next, visibleTurnItems: activeVisibleTurnItems(next) }
        : next;
      const visibleChangedByRecheck = visible.visibleTurnItems !== projection.visibleTurnItems;
      const show = shouldShowLocalTurnItem(next, payload);
      const upsert = show
        ? upsertVisibleTurnItemDetailed(visible, payload, partialTimeline, latestLocalTurnOrdinal)
        : { rows: removeVisibleItem(visible.visibleTurnItems, payload.id) };
      const result: OrchestrationV2ThreadProjection = {
        ...next,
        visibleTurnItems: upsert.rows,
      };
      const inPlaceVisibleTurnItem =
        !visibleChangedByRecheck && previous !== undefined && itemIndex !== -1
          ? upsert.inPlaceRow
          : undefined;
      return {
        projection: result,
        previousTurnItem: previous,
        nextTurnItem: payload,
        inPlaceVisibleTurnItem,
      };
    }
    case "plan.updated": {
      const base = activityBase();
      return {
        projection: {
          ...base,
          plans: upsertById(base.plans, event.payload),
        },
      };
    }
    case "checkpoint-scope.created": {
      const base = activityBase();
      return {
        projection: {
          ...base,
          checkpointScopes: upsertById(base.checkpointScopes, event.payload),
        },
      };
    }
    case "checkpoint.captured": {
      const base = activityBase();
      return {
        projection: {
          ...base,
          checkpoints: upsertById(base.checkpoints, event.payload),
        },
      };
    }
    case "checkpoint.rollback-requested":
      return { projection: activityBase() };
    case "context-handoff.updated": {
      const base = activityBase();
      return {
        projection: {
          ...base,
          contextHandoffs: upsertById(base.contextHandoffs, event.payload),
        },
      };
    }
    case "context-transfer.created":
    case "context-transfer.updated": {
      const base = activityBase();
      return {
        projection: {
          ...base,
          contextTransfers: upsertById(base.contextTransfers, event.payload),
        },
      };
    }
  }
}
