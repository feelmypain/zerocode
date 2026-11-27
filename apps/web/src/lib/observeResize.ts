import { flushSync } from "react-dom";

type ResizeCallback = (entries: readonly ResizeObserverEntry[]) => void;

interface ObserveResizeOptions {
  readonly sync?: boolean;
}

interface Subscription {
  readonly callback: ResizeCallback;
  readonly sync: boolean;
  active: boolean;
}

interface Target {
  readonly subscriptions: Set<Subscription>;
  waiting: Set<Subscription> | null;
  last: ResizeObserverEntry | null;
}

let observer: ResizeObserver | null = null;
const targets = new Map<Element, Target>();
let pendingAsyncBatches = new Map<Subscription, Map<Element, ResizeObserverEntry>>();
let asyncFlushHandle: number | null = null;

function runBatches(batches: Map<Subscription, readonly ResizeObserverEntry[]>) {
  for (const [subscription, batch] of batches) {
    if (!subscription.active) continue;
    try {
      subscription.callback(batch);
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}

function flushAsyncBatches() {
  asyncFlushHandle = null;
  if (pendingAsyncBatches.size === 0) return;
  const queued = pendingAsyncBatches;
  pendingAsyncBatches = new Map();
  const batches = new Map<Subscription, ResizeObserverEntry[]>();
  for (const [subscription, entriesByTarget] of queued) {
    if (!subscription.active) continue;
    batches.set(subscription, [...entriesByTarget.values()]);
  }
  if (batches.size > 0) runBatches(batches);
}

function scheduleAsyncFlush() {
  if (asyncFlushHandle !== null) return;
  if (typeof requestAnimationFrame === "function") {
    asyncFlushHandle = requestAnimationFrame(flushAsyncBatches);
    return;
  }
  asyncFlushHandle = -1;
  queueMicrotask(flushAsyncBatches);
}

function deliver(entries: readonly ResizeObserverEntry[]) {
  const syncBatches = new Map<Subscription, ResizeObserverEntry[]>();
  let queuedAsync = false;
  for (const entry of entries) {
    const target = targets.get(entry.target);
    if (!target) continue;
    let recipients = target.subscriptions;
    if (target.waiting) {
      // Re-observing for a new subscriber redelivers an unchanged size to everyone else too.
      const previous = target.last?.contentRect;
      if (
        previous?.width === entry.contentRect.width &&
        previous.height === entry.contentRect.height
      ) {
        recipients = target.waiting;
      }
      target.waiting = null;
    }
    target.last = entry;
    for (const subscription of recipients) {
      if (subscription.sync) {
        const batch = syncBatches.get(subscription);
        if (batch) batch.push(entry);
        else syncBatches.set(subscription, [entry]);
      } else {
        let entriesByTarget = pendingAsyncBatches.get(subscription);
        if (!entriesByTarget) {
          entriesByTarget = new Map();
          pendingAsyncBatches.set(subscription, entriesByTarget);
        }
        entriesByTarget.set(entry.target, entry);
        queuedAsync = true;
      }
    }
  }
  if (queuedAsync) scheduleAsyncFlush();
  if (syncBatches.size === 0) return;
  flushSync(() => {
    runBatches(syncBatches);
  });
}

/**
 * Flushes `sync` callbacks together before paint; ordinary React updates would leave a stale frame.
 * Pass `{ sync: false }` to coalesce callbacks in the next animation frame without `flushSync`.
 */
export function observeResize(
  elements: Element | readonly Element[],
  callback: ResizeCallback,
  options?: ObserveResizeOptions,
): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const shared = (observer ??= new ResizeObserver(deliver));
  const subscription: Subscription = {
    callback,
    sync: options?.sync ?? true,
    active: true,
  };
  const observed: readonly Element[] = Array.isArray(elements) ? elements : [elements as Element];
  for (const element of observed) {
    const target = targets.get(element);
    if (!target) {
      targets.set(element, { subscriptions: new Set([subscription]), waiting: null, last: null });
      shared.observe(element);
      continue;
    }
    target.subscriptions.add(subscription);
    if (!target.last) continue;
    (target.waiting ??= new Set()).add(subscription);
    shared.unobserve(element);
    shared.observe(element);
  }
  return () => {
    if (!subscription.active) return;
    subscription.active = false;
    pendingAsyncBatches.delete(subscription);
    if (
      pendingAsyncBatches.size === 0 &&
      asyncFlushHandle !== null &&
      asyncFlushHandle !== -1 &&
      typeof cancelAnimationFrame === "function"
    ) {
      cancelAnimationFrame(asyncFlushHandle);
      asyncFlushHandle = null;
    }
    const unobserved = observed.filter((element) => {
      const target = targets.get(element);
      if (!target?.subscriptions.delete(subscription)) return false;
      target.waiting?.delete(subscription);
      return target.subscriptions.size === 0 && targets.delete(element);
    });
    if (targets.size > 0) {
      for (const element of unobserved) shared.unobserve(element);
    } else {
      observer?.disconnect();
      observer = null;
    }
  };
}
