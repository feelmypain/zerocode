import {
  isListedThreadLineage,
  isOlderSettledThreadShell,
  isProviderNativeSubagentThread,
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
  RepositoryIdentity,
  ThreadPullRequestLink,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type ThreadId,
} from "@zerocode/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const sameThreadShell = Schema.toEquivalence(OrchestrationV2ThreadShell);
const sameProjectShell = Schema.toEquivalence(OrchestrationProjectShell);
const sameLinks = Schema.toEquivalence(Schema.UndefinedOr(Schema.Array(ThreadPullRequestLink)));
const sameRepositoryIdentity = Schema.toEquivalence(
  Schema.UndefinedOr(Schema.NullOr(RepositoryIdentity)),
);

export interface ShellSnapshotMeta {
  readonly threadsById: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>;
  readonly membershipVersion: number;
  readonly olderSettledVersion: number;
  readonly pendingRequestVersion: number;
}

const EMPTY_THREAD_MAP: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell> = new Map();
const shellSnapshotMeta = new WeakMap<OrchestrationV2ShellSnapshot, ShellSnapshotMeta>();
let nextShellVersion = 0;

function sameDateTime(left: DateTime.Utc | null, right: DateTime.Utc | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      DateTime.toEpochMillis(left) === DateTime.toEpochMillis(right))
  );
}

function isChildRunLive(
  thread: Pick<OrchestrationV2ThreadShell, "activityRunStatus" | "status">,
): boolean {
  return thread.activityRunStatus !== undefined
    ? thread.activityRunStatus !== null
    : thread.status === "preparing" ||
        thread.status === "starting" ||
        thread.status === "running" ||
        thread.status === "waiting";
}

function isChildOrDelegated(thread: OrchestrationV2ThreadShell): boolean {
  return (
    thread.lineage.relationshipToParent === "subagent" ||
    thread.lineage.sideChat === true ||
    thread.delegatedFrom !== undefined
  );
}

function sameThreadMembership(
  previous: OrchestrationV2ThreadShell,
  next: OrchestrationV2ThreadShell,
): boolean {
  return (
    previous.projectId === next.projectId &&
    sameDateTime(previous.archivedAt, next.archivedAt) &&
    previous.lineage.parentThreadId === next.lineage.parentThreadId &&
    previous.lineage.relationshipToParent === next.lineage.relationshipToParent &&
    previous.lineage.sideChat === next.lineage.sideChat &&
    previous.delegatedFrom?.environmentId === next.delegatedFrom?.environmentId &&
    previous.delegatedFrom?.threadId === next.delegatedFrom?.threadId
  );
}

function samePendingRequestContribution(
  previous: OrchestrationV2ThreadShell,
  next: OrchestrationV2ThreadShell,
): boolean {
  const previousChild = isChildOrDelegated(previous);
  const nextChild = isChildOrDelegated(next);
  if (!previousChild && !nextChild) return true;
  if (previousChild !== nextChild) return false;
  return (
    previous.lineage.parentThreadId === next.lineage.parentThreadId &&
    previous.lineage.relationshipToParent === next.lineage.relationshipToParent &&
    previous.lineage.sideChat === next.lineage.sideChat &&
    previous.delegatedFrom?.environmentId === next.delegatedFrom?.environmentId &&
    previous.delegatedFrom?.threadId === next.delegatedFrom?.threadId &&
    previous.pendingRuntimeRequest?.id === next.pendingRuntimeRequest?.id &&
    previous.pendingRuntimeRequest?.kind === next.pendingRuntimeRequest?.kind &&
    previous.pendingRuntimeRequest?.userOnly === next.pendingRuntimeRequest?.userOnly &&
    isChildRunLive(previous) === isChildRunLive(next) &&
    isProviderNativeSubagentThread(previous) === isProviderNativeSubagentThread(next)
  );
}

function olderSettledCutoffMs(snapshot: OrchestrationV2ShellSnapshot): number | null {
  return snapshot.olderSettled === undefined
    ? null
    : DateTime.toEpochMillis(DateTime.makeUnsafe(snapshot.olderSettled.before));
}

function affectsOlderSettledOnUpsert(
  previous: OrchestrationV2ThreadShell | undefined,
  next: OrchestrationV2ThreadShell,
  beforeMs: number | null,
): boolean {
  if (previous === undefined) {
    if (!isListedThreadLineage(next.lineage)) return false;
    if (beforeMs === null) return true;
    return (
      isOlderSettledThreadShell(next, beforeMs) || DateTime.toEpochMillis(next.createdAt) < beforeMs
    );
  }
  const prevListed = isListedThreadLineage(previous.lineage);
  const nextListed = isListedThreadLineage(next.lineage);
  if (!prevListed && !nextListed) return false;
  if (beforeMs !== null) {
    const prevOlder = prevListed && isOlderSettledThreadShell(previous, beforeMs);
    const nextOlder = nextListed && isOlderSettledThreadShell(next, beforeMs);
    const prevInKey =
      prevOlder || (prevListed && DateTime.toEpochMillis(previous.createdAt) < beforeMs);
    const nextInKey =
      nextOlder || (nextListed && DateTime.toEpochMillis(next.createdAt) < beforeMs);
    if (!prevInKey && !nextInKey) return false;
    return (
      prevInKey !== nextInKey || prevOlder !== nextOlder || previous.projectId !== next.projectId
    );
  }
  return (
    prevListed !== nextListed ||
    previous.projectId !== next.projectId ||
    previous.settledOverride !== next.settledOverride ||
    !sameDateTime(previous.settledAt, next.settledAt) ||
    !sameDateTime(previous.createdAt, next.createdAt)
  );
}

function affectsOlderSettledOnArchive(
  previous: OrchestrationV2ThreadShell | undefined,
  beforeMs: number | null,
): boolean {
  if (previous === undefined || !isListedThreadLineage(previous.lineage)) return false;
  if (beforeMs === null) return true;
  return (
    isOlderSettledThreadShell(previous, beforeMs) ||
    DateTime.toEpochMillis(previous.createdAt) < beforeMs
  );
}

function buildThreadsById(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): ReadonlyMap<ThreadId, OrchestrationV2ThreadShell> {
  if (threads.length === 0) return EMPTY_THREAD_MAP;
  const byId = new Map<ThreadId, OrchestrationV2ThreadShell>();
  for (const thread of threads) byId.set(thread.id, thread);
  return byId;
}

export function getShellSnapshotMeta(snapshot: OrchestrationV2ShellSnapshot): ShellSnapshotMeta {
  const cached = shellSnapshotMeta.get(snapshot);
  if (cached !== undefined) return cached;
  const version = ++nextShellVersion;
  const meta: ShellSnapshotMeta = {
    threadsById: buildThreadsById(snapshot.threads),
    membershipVersion: version,
    olderSettledVersion: version,
    pendingRequestVersion: version,
  };
  shellSnapshotMeta.set(snapshot, meta);
  return meta;
}

/** Carry structural revision counters across metadata-only thread/project updates. */
export function preserveShellSnapshotMeta(
  previous: OrchestrationV2ShellSnapshot,
  next: OrchestrationV2ShellSnapshot,
): OrchestrationV2ShellSnapshot {
  if (previous === next) return next;
  const prevMeta = getShellSnapshotMeta(previous);
  const threadsById =
    next.threads === previous.threads ? prevMeta.threadsById : buildThreadsById(next.threads);
  shellSnapshotMeta.set(next, { ...prevMeta, threadsById });
  return next;
}

export function sameThreadPullRequests(
  left: OrchestrationV2ThreadShell["pullRequests"],
  right: OrchestrationV2ThreadShell["pullRequests"],
): boolean {
  return left === right || sameLinks(left, right);
}

/**
 * Links are compared apart from the rest of the row because a deferred snapshot arrives without
 * them; such a row keeps its links until they fill in.
 */
export function reuseUnchangedThreadShells(
  previous: OrchestrationV2ShellSnapshot | null,
  next: OrchestrationV2ShellSnapshot,
): OrchestrationV2ShellSnapshot {
  if (previous === null || previous.threads.length === 0) return next;
  const previousById = getShellSnapshotMeta(previous).threadsById;
  let changed = false;
  const threads = next.threads.map((thread) => {
    const prior = previousById.get(thread.id);
    if (prior === undefined) return thread;
    const candidate =
      thread.pullRequests === undefined && prior.pullRequests !== undefined
        ? { ...thread, pullRequests: prior.pullRequests }
        : thread;
    const retained = sameThreadShell(prior, candidate) ? prior : candidate;
    if (retained !== thread) changed = true;
    return retained;
  });
  return changed ? { ...next, threads } : next;
}

function upsertById<T extends { readonly id: unknown }>(
  items: ReadonlyArray<T>,
  item: T,
): ReadonlyArray<T> {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  return items.map((candidate, candidateIndex) => (candidateIndex === index ? item : candidate));
}

function removeById<T extends { readonly id: unknown }>(
  items: ReadonlyArray<T>,
  id: T["id"],
): ReadonlyArray<T> {
  if (items.length === 0) return items;
  const index = items.findIndex((candidate) => candidate.id === id);
  if (index === -1) return items;
  return [...items.slice(0, index), ...items.slice(index + 1)];
}

function retainRepositoryIdentity(
  previous: OrchestrationProjectShell | undefined,
  next: OrchestrationProjectShell,
): OrchestrationProjectShell {
  if (
    next.repositoryIdentity == null &&
    previous?.repositoryIdentity != null &&
    previous.workspaceRoot === next.workspaceRoot
  ) {
    return { ...next, repositoryIdentity: previous.repositoryIdentity };
  }
  return next;
}

export interface MergeShellSnapshotOptions {
  /**
   * Metadata-only enrichment refresh: structure and sequence never change;
   * listed roots accept identity exactly (including null).
   * Omit this options object for authoritative HTTP/initial WebSocket snapshots.
   */
  readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
}

export function mergeShellSnapshotProjects(
  previous: OrchestrationV2ShellSnapshot | null | undefined,
  next: OrchestrationV2ShellSnapshot,
  options?: MergeShellSnapshotOptions,
): OrchestrationV2ShellSnapshot {
  if (previous === null || previous === undefined) {
    return next;
  }

  const isEnrichment = options !== undefined;
  const resolvedRootSet = isEnrichment ? new Set(options.resolvedRepositoryIdentityRoots) : null;

  if (isEnrichment) {
    const nextById = new Map(next.projects.map((project) => [project.id, project] as const));
    const projects = previous.projects.map((project) => {
      const candidate = nextById.get(project.id);
      if (candidate === undefined || candidate.workspaceRoot !== project.workspaceRoot) {
        return project;
      }
      if (resolvedRootSet?.has(project.workspaceRoot) === true) {
        // Refreshes re-resolve every root; an unchanged identity keeps the project's identity
        // so every subscriber (each pull request row, the sidebar) skips re-rendering.
        if (sameRepositoryIdentity(project.repositoryIdentity, candidate.repositoryIdentity)) {
          return project;
        }
        return { ...project, repositoryIdentity: candidate.repositoryIdentity };
      }
      if (project.repositoryIdentity == null && candidate.repositoryIdentity != null) {
        return { ...project, repositoryIdentity: candidate.repositoryIdentity };
      }
      return project;
    });
    return projects.every((project, index) => project === previous.projects[index])
      ? previous
      : preserveShellSnapshotMeta(previous, { ...previous, projects });
  }

  const previousById = new Map(previous.projects.map((project) => [project.id, project] as const));
  // Project atoms and shell persistence compare by reference, so unchanged projects keep their objects.
  const projects = next.projects.map((project) => {
    const prior = previousById.get(project.id);
    const merged = retainRepositoryIdentity(prior, project);
    return prior !== undefined && sameProjectShell(prior, merged) ? prior : merged;
  });
  const unchanged =
    projects.length === previous.projects.length &&
    projects.every((project, index) => project === previous.projects[index]);
  return { ...next, projects: unchanged ? previous.projects : projects };
}

export function applyShellStreamEvent(
  snapshot: OrchestrationV2ShellSnapshot,
  event: ShellStreamEvent,
): OrchestrationV2ShellSnapshot {
  if (event.sequence <= snapshot.snapshotSequence) return snapshot;

  switch (event.kind) {
    case "project.updated": {
      // Enrichment is async. A project mutation can land with null
      // repositoryIdentity while an earlier snapshot already resolved it.
      // Keep the prior identity for the same workspace root so multi-env
      // grouping does not split until a full snapshot refresh arrives.
      const previous = snapshot.projects.find((project) => project.id === event.project.id);
      const project = retainRepositoryIdentity(previous, event.project);
      const next: OrchestrationV2ShellSnapshot = {
        ...snapshot,
        projects: upsertById(snapshot.projects, project),
        snapshotSequence: event.sequence,
      };
      const existingMeta = shellSnapshotMeta.get(snapshot);
      if (existingMeta !== undefined) shellSnapshotMeta.set(next, existingMeta);
      return next;
    }
    case "project.removed": {
      const next: OrchestrationV2ShellSnapshot = {
        ...snapshot,
        projects: removeById(snapshot.projects, event.projectId),
        snapshotSequence: event.sequence,
      };
      const existingMeta = shellSnapshotMeta.get(snapshot);
      if (existingMeta !== undefined) shellSnapshotMeta.set(next, existingMeta);
      return next;
    }
    case "thread.updated": {
      const id = event.thread.id;
      const prevMeta = getShellSnapshotMeta(snapshot);
      const existing = prevMeta.threadsById.get(id);
      if (
        event.location === "active" &&
        existing !== undefined &&
        sameThreadShell(existing, event.thread)
      ) {
        const next: OrchestrationV2ShellSnapshot = {
          ...snapshot,
          snapshotSequence: event.sequence,
        };
        shellSnapshotMeta.set(next, prevMeta);
        return next;
      }
      // The archive has its own bounded query/subscription. Older servers may
      // still send archive-located deltas here; remove them from the normal
      // shell without allocating a new array when no archived row matches.
      const nextArchived = removeById(snapshot.archivedThreads, id);
      const beforeMs = olderSettledCutoffMs(snapshot);
      let nextThreads = snapshot.threads;
      let nextThreadsById = prevMeta.threadsById;
      let membershipChanged = false;
      let olderSettledChanged = false;
      let pendingRequestChanged = false;
      if (event.location === "active") {
        const mutable = new Map(prevMeta.threadsById);
        mutable.set(id, event.thread);
        nextThreadsById = mutable;
        nextThreads = Array.from(mutable.values());
        membershipChanged = existing === undefined || !sameThreadMembership(existing, event.thread);
        olderSettledChanged = affectsOlderSettledOnUpsert(existing, event.thread, beforeMs);
        pendingRequestChanged =
          existing === undefined
            ? isChildOrDelegated(event.thread)
            : !samePendingRequestContribution(existing, event.thread);
      } else if (existing !== undefined) {
        const mutable = new Map(prevMeta.threadsById);
        mutable.delete(id);
        nextThreadsById = mutable.size === 0 ? EMPTY_THREAD_MAP : mutable;
        nextThreads = mutable.size === 0 ? [] : Array.from(mutable.values());
        membershipChanged = true;
        olderSettledChanged = affectsOlderSettledOnArchive(existing, beforeMs);
        pendingRequestChanged = isChildOrDelegated(existing);
      }
      const next: OrchestrationV2ShellSnapshot = {
        ...snapshot,
        threads: nextThreads,
        archivedThreads: nextArchived,
        snapshotSequence: event.sequence,
      };
      shellSnapshotMeta.set(next, {
        threadsById: nextThreadsById,
        membershipVersion: membershipChanged ? ++nextShellVersion : prevMeta.membershipVersion,
        olderSettledVersion: olderSettledChanged
          ? ++nextShellVersion
          : prevMeta.olderSettledVersion,
        pendingRequestVersion: pendingRequestChanged
          ? ++nextShellVersion
          : prevMeta.pendingRequestVersion,
      });
      return next;
    }
    case "thread.removed": {
      const prevMeta = getShellSnapshotMeta(snapshot);
      const existing = prevMeta.threadsById.get(event.threadId);
      const nextArchived = removeById(snapshot.archivedThreads, event.threadId);
      let nextThreads = snapshot.threads;
      let nextThreadsById = prevMeta.threadsById;
      if (existing !== undefined) {
        const mutable = new Map(prevMeta.threadsById);
        mutable.delete(event.threadId);
        nextThreadsById = mutable.size === 0 ? EMPTY_THREAD_MAP : mutable;
        nextThreads = mutable.size === 0 ? [] : Array.from(mutable.values());
      }
      const next: OrchestrationV2ShellSnapshot = {
        ...snapshot,
        threads: nextThreads,
        archivedThreads: nextArchived,
        snapshotSequence: event.sequence,
      };
      shellSnapshotMeta.set(next, {
        threadsById: nextThreadsById,
        membershipVersion: existing !== undefined ? ++nextShellVersion : prevMeta.membershipVersion,
        olderSettledVersion: ++nextShellVersion,
        pendingRequestVersion:
          existing !== undefined && isChildOrDelegated(existing)
            ? ++nextShellVersion
            : prevMeta.pendingRequestVersion,
      });
      return next;
    }
    default:
      return snapshot;
  }
}

/** Index a collection lazily and materialize it only if a delta changes its rows. */
function batchRows<T extends { readonly id: unknown }>(rows: ReadonlyArray<T>) {
  let byId: Map<T["id"], T> | undefined;
  let changed = false;
  const index = () => {
    if (byId === undefined) {
      byId = new Map();
      for (const row of rows) byId.set(row.id, row);
    }
    return byId;
  };
  return {
    get: (id: T["id"]) => index().get(id),
    set: (row: T) => {
      index().set(row.id, row);
      changed = true;
    },
    remove: (id: T["id"]) => {
      if (byId === undefined && rows.length === 0) return;
      if (index().delete(id)) changed = true;
    },
    finish: () => (changed ? Array.from(index().values()) : rows),
  };
}

export type ShellStreamEvent = Extract<
  OrchestrationV2ShellStreamItem,
  { readonly sequence: number }
>;

/** Apply ordered deltas with one index and at most one new array per collection. */
export function applyShellStreamEvents(
  snapshot: OrchestrationV2ShellSnapshot,
  events: ReadonlyArray<ShellStreamEvent>,
): OrchestrationV2ShellSnapshot {
  if (events.length === 0) return snapshot;
  if (events.length === 1) return applyShellStreamEvent(snapshot, events[0]!);
  let hasApplicable = false;
  for (const event of events) {
    if (event.sequence > snapshot.snapshotSequence) {
      hasApplicable = true;
      break;
    }
  }
  if (!hasApplicable) return snapshot;

  const projects = batchRows(snapshot.projects);
  const archivedThreads = batchRows(snapshot.archivedThreads);
  let prevMeta: ShellSnapshotMeta | undefined;
  let mutableThreads: Map<ThreadId, OrchestrationV2ThreadShell> | undefined;
  let threadsChanged = false;
  let membershipChanged = false;
  let olderSettledChanged = false;
  let pendingRequestChanged = false;
  const beforeMs = olderSettledCutoffMs(snapshot);
  const ensureThreadMeta = () => (prevMeta ??= getShellSnapshotMeta(snapshot));
  const currentThread = (id: ThreadId) =>
    mutableThreads !== undefined ? mutableThreads.get(id) : ensureThreadMeta().threadsById.get(id);
  const ensureMutableThreads = () => (mutableThreads ??= new Map(ensureThreadMeta().threadsById));

  let sequence = snapshot.snapshotSequence;
  for (const event of events) {
    if (event.sequence <= sequence) continue;
    switch (event.kind) {
      case "project.updated":
        projects.set(retainRepositoryIdentity(projects.get(event.project.id), event.project));
        break;
      case "project.removed":
        projects.remove(event.projectId);
        break;
      case "thread.updated": {
        const id = event.thread.id;
        const previous = currentThread(id);
        if (event.location === "active") {
          if (previous !== undefined && sameThreadShell(previous, event.thread)) {
            sequence = event.sequence;
            continue;
          }
          ensureMutableThreads().set(id, event.thread);
          threadsChanged = true;
          membershipChanged ||=
            previous === undefined || !sameThreadMembership(previous, event.thread);
          olderSettledChanged ||= affectsOlderSettledOnUpsert(previous, event.thread, beforeMs);
          pendingRequestChanged ||=
            previous === undefined
              ? isChildOrDelegated(event.thread)
              : !samePendingRequestContribution(previous, event.thread);
        } else if (previous !== undefined) {
          ensureMutableThreads().delete(id);
          threadsChanged = true;
          membershipChanged = true;
          olderSettledChanged ||= affectsOlderSettledOnArchive(previous, beforeMs);
          pendingRequestChanged ||= isChildOrDelegated(previous);
        }
        // Legacy archive deltas remove rows from the shell; the archive is queried separately.
        archivedThreads.remove(id);
        break;
      }
      case "thread.removed": {
        const previous = currentThread(event.threadId);
        if (previous !== undefined) {
          ensureMutableThreads().delete(event.threadId);
          threadsChanged = true;
          membershipChanged = true;
          pendingRequestChanged ||= isChildOrDelegated(previous);
        }
        olderSettledChanged = true;
        archivedThreads.remove(event.threadId);
        break;
      }
      default:
        continue;
    }
    sequence = event.sequence;
  }
  if (sequence === snapshot.snapshotSequence) return snapshot;
  const nextThreads =
    threadsChanged && mutableThreads !== undefined
      ? mutableThreads.size === 0
        ? []
        : Array.from(mutableThreads.values())
      : snapshot.threads;
  const next: OrchestrationV2ShellSnapshot = {
    ...snapshot,
    snapshotSequence: sequence,
    projects: projects.finish(),
    threads: nextThreads,
    archivedThreads: archivedThreads.finish(),
  };
  const baseMeta = prevMeta ?? shellSnapshotMeta.get(snapshot);
  if (baseMeta !== undefined) {
    const nextThreadsById =
      threadsChanged && mutableThreads !== undefined
        ? mutableThreads.size === 0
          ? EMPTY_THREAD_MAP
          : mutableThreads
        : baseMeta.threadsById;
    shellSnapshotMeta.set(next, {
      threadsById: nextThreadsById,
      membershipVersion: membershipChanged ? ++nextShellVersion : baseMeta.membershipVersion,
      olderSettledVersion: olderSettledChanged ? ++nextShellVersion : baseMeta.olderSettledVersion,
      pendingRequestVersion: pendingRequestChanged
        ? ++nextShellVersion
        : baseMeta.pendingRequestVersion,
    });
  }
  return next;
}
