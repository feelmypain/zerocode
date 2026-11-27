import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@zerocode/client-runtime/environment";
import {
  EnvironmentId,
  ProviderInteractionMode,
  RuntimeMode,
  type ScopedProjectRef,
  type ScopedThreadRef,
  ThreadId,
} from "@zerocode/contracts";
import { toComposerContextId } from "@zerocode/shared/composerContextReferences";
import { composerFileAttachmentMimeType } from "../components/chat/composerAttachmentFiles";
import { normalizeTerminalContextText, type TerminalContextDraft } from "../lib/terminalContext";
import { readThreadPreviewState } from "../previewStateStore";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, videoMimeType } from "../types";
import {
  type ComposerDraftStoreState,
  type ComposerFileAttachment,
  type ComposerThreadDraftState,
  type ComposerThreadLookupState,
  type ComposerThreadTarget,
  type DraftCheckoutPullRequest,
  DraftId,
  type DraftSessionState,
  type DraftThreadEnvMode,
  type DraftThreadState,
  type ProjectDraftSession,
} from "./types";

/** Strips upload ids another environment owns; local bytes re-upload, byte-less files need reattaching. */
export function clearStaleFileUploadMetadata(
  draft: ComposerThreadDraftState,
  environmentId: EnvironmentId | null,
): ComposerThreadDraftState {
  let changed = false;
  const files = draft.files.map((file) => {
    if (
      (file.uploadedAttachmentId === undefined && file.uploadEnvironmentId === undefined) ||
      file.uploadEnvironmentId === environmentId
    ) {
      return file;
    }

    changed = true;
    const nextFile = { ...file };
    delete nextFile.uploadedAttachmentId;
    delete nextFile.uploadEnvironmentId;
    return nextFile;
  });

  return changed ? { ...draft, files } : draft;
}

export function composerFileDedupKey(
  file: Pick<ComposerFileAttachment, "mimeType" | "sizeBytes" | "name">,
): string {
  return `${file.mimeType}\u0000${file.sizeBytes}\u0000${file.name}`;
}

export function composerFileMatchesReattachMarker(
  marker: Pick<ComposerFileAttachment, "mimeType" | "sizeBytes" | "name">,
  file: Pick<ComposerFileAttachment, "mimeType" | "sizeBytes" | "name">,
): boolean {
  if (marker.name !== file.name || marker.sizeBytes !== file.sizeBytes) return false;
  if (marker.mimeType === file.mimeType) return true;
  const normalizedMarkerMimeType = composerFileAttachmentMimeType({
    name: marker.name,
    type: marker.mimeType,
  });
  if (
    normalizedMarkerMimeType === "image/x-adobe-dng" &&
    normalizedMarkerMimeType ===
      composerFileAttachmentMimeType({ name: file.name, type: file.mimeType })
  ) {
    return true;
  }
  const markerMimeType = marker.mimeType.toLowerCase();
  return (
    (markerMimeType === "" || markerMimeType === "application/octet-stream") &&
    videoMimeType(marker) !== null &&
    videoMimeType(file) !== null
  );
}

export function terminalContextDedupKey(context: TerminalContextDraft): string {
  return `${context.terminalId}\u0000${context.lineStart}\u0000${context.lineEnd}`;
}

export function normalizeTerminalContextForThread(
  threadId: ThreadId,
  context: TerminalContextDraft,
): TerminalContextDraft | null {
  const terminalId = context.terminalId.trim();
  const terminalLabel = context.terminalLabel.trim();
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const lineStart = Math.max(1, Math.floor(context.lineStart));
  const lineEnd = Math.max(lineStart, Math.floor(context.lineEnd));
  return {
    ...context,
    id: toComposerContextId(context.id),
    threadId,
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd,
    text: normalizeTerminalContextText(context.text),
  };
}

export function normalizeTerminalContextsForThread(
  threadId: ThreadId,
  contexts: ReadonlyArray<TerminalContextDraft>,
): TerminalContextDraft[] {
  const existingIds = new Set<string>();
  const existingDedupKeys = new Set<string>();
  const normalizedContexts: TerminalContextDraft[] = [];

  for (const context of contexts) {
    const normalizedContext = normalizeTerminalContextForThread(threadId, context);
    if (!normalizedContext) {
      continue;
    }
    const dedupKey = terminalContextDedupKey(normalizedContext);
    if (existingIds.has(normalizedContext.id) || existingDedupKeys.has(dedupKey)) {
      continue;
    }
    normalizedContexts.push(normalizedContext);
    existingIds.add(normalizedContext.id);
    existingDedupKeys.add(dedupKey);
  }

  return normalizedContexts;
}

export function revokeObjectPreviewUrl(previewUrl: string): void {
  if (typeof URL === "undefined") {
    return;
  }
  if (!previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeDraftThreadPreviewUrls(draft: ComposerThreadDraftState | undefined): void {
  if (!draft) {
    return;
  }
  for (const image of draft.images) {
    revokeObjectPreviewUrl(image.previewUrl);
  }
}

export function projectDraftKey(projectRef: ScopedProjectRef): string {
  return scopedProjectKey(projectRef);
}

export function logicalProjectDraftKey(logicalProjectKey: string): string {
  return logicalProjectKey.trim();
}

export function composerTargetKey(target: ScopedThreadRef | DraftId): string {
  if (typeof target === "string") {
    return target.trim();
  }
  return scopedThreadKey(target);
}

export function normalizeLegacyComposerStorageKey(
  threadKeyOrId: string,
  options?: {
    environmentId?: EnvironmentId;
  },
): string {
  const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
  if (parsedThreadRef) {
    return composerTargetKey(parsedThreadRef);
  }
  if (options?.environmentId) {
    return composerTargetKey(scopeThreadRef(options.environmentId, threadKeyOrId as ThreadId));
  }
  return threadKeyOrId;
}

export function composerThreadRefFromKey(threadKey: string): ScopedThreadRef | null {
  return parseScopedThreadKey(threadKey);
}

function normalizeComposerTarget(target: ComposerThreadTarget): ComposerThreadTarget | null {
  if (typeof target === "string") {
    const draftId = target.trim();
    return draftId.length > 0 ? DraftId.make(draftId) : null;
  }
  return target;
}

export function resolveComposerDraftKey(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): string | null {
  const normalizedTarget = normalizeComposerTarget(target);
  if (!normalizedTarget) {
    return null;
  }
  if (typeof normalizedTarget !== "string") {
    const scopedKey = composerTargetKey(normalizedTarget);
    if (state.draftsByThreadKey[scopedKey]) {
      return scopedKey;
    }
    for (const [draftId, draftSession] of Object.entries(state.draftThreadsByThreadKey)) {
      if (
        draftSession.environmentId === normalizedTarget.environmentId &&
        draftSession.threadId === normalizedTarget.threadId
      ) {
        return draftId;
      }
    }
    return scopedKey;
  }
  const threadKey = composerTargetKey(normalizedTarget);
  return threadKey.length > 0 ? threadKey : null;
}

const QUEUED_RUN_EDIT_DRAFT_PREFIX = "queued-edit:";

// Thread and run ids both contain colons, so the run id is encoded to keep the thread key parseable.
export function queuedRunEditDraftId(threadRef: ScopedThreadRef, runId: string): DraftId {
  return DraftId.make(
    `${QUEUED_RUN_EDIT_DRAFT_PREFIX}${scopedThreadKey(threadRef)}:${encodeURIComponent(runId)}`,
  );
}

function queuedRunEditThreadId(draftId: string): ThreadId | null {
  if (!draftId.startsWith(QUEUED_RUN_EDIT_DRAFT_PREFIX)) return null;
  const rest = draftId.slice(QUEUED_RUN_EDIT_DRAFT_PREFIX.length);
  return parseScopedThreadKey(rest.slice(0, rest.lastIndexOf(":")))?.threadId ?? null;
}

export function resolveComposerThreadId(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): ThreadId | null {
  const normalizedTarget = normalizeComposerTarget(target);
  if (!normalizedTarget) {
    return null;
  }
  if (typeof normalizedTarget !== "string") {
    return normalizedTarget.threadId;
  }
  return (
    state.draftThreadsByThreadKey[normalizedTarget]?.threadId ??
    queuedRunEditThreadId(normalizedTarget)
  );
}

export function getComposerDraftState(
  state: Pick<ComposerDraftStoreState, "draftsByThreadKey" | "draftThreadsByThreadKey">,
  target: ComposerThreadTarget,
): ComposerThreadDraftState | null {
  const threadKey = resolveComposerDraftKey(state, target);
  if (!threadKey) {
    return null;
  }
  return state.draftsByThreadKey[threadKey] ?? null;
}

export function draftThreadHasOpenPreview(draftThread: DraftThreadState | undefined): boolean {
  if (draftThread === undefined) return false;
  const ref = scopeThreadRef(draftThread.environmentId, draftThread.threadId);
  return Object.keys(readThreadPreviewState(ref).sessions).length > 0;
}

export function isComposerThreadKeyInUse(
  mappings: Record<string, string>,
  threadKey: string,
): boolean {
  return Object.values(mappings).includes(threadKey);
}

export function toProjectDraftSession(
  draftId: DraftId,
  draftSession: DraftSessionState,
): ProjectDraftSession {
  return {
    draftId,
    ...draftSession,
  };
}

export function worktreeRepositoriesEqual(
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((path, index) => path === right[index]);
}

/** An explicit value wins; otherwise a checkout's pull request stays with its project. */
export function resolveCheckoutPullRequest(
  existing: DraftThreadState | undefined,
  explicit: DraftCheckoutPullRequest | null | undefined,
  projectChanged: boolean,
): DraftCheckoutPullRequest | undefined {
  if (explicit !== undefined) return explicit ?? undefined;
  return projectChanged ? undefined : existing?.checkoutPullRequest;
}

export function checkoutPullRequestsEqual(
  left: DraftCheckoutPullRequest | undefined,
  right: DraftCheckoutPullRequest | undefined,
): boolean {
  return left === right || (left?.url === right?.url && left?.branch === right?.branch);
}

export function scopedThreadRefsEqual(
  left: ScopedThreadRef | null | undefined,
  right: ScopedThreadRef | null | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

export function isDraftThreadPromoting(draftThread: DraftThreadState | null | undefined): boolean {
  return draftThread?.promotedTo !== null && draftThread?.promotedTo !== undefined;
}

export function createDraftThreadState(
  projectRef: ScopedProjectRef,
  threadId: ThreadId,
  logicalProjectKey: string,
  existingThread: DraftThreadState | undefined,
  options?: {
    threadId?: ThreadId;
    branch?: string | null;
    worktreePath?: string | null;
    createdAt?: string;
    envMode?: DraftThreadEnvMode;
    startFromOrigin?: boolean;
    runtimeMode?: RuntimeMode;
    interactionMode?: ProviderInteractionMode;
    environmentSelection?: "auto" | "manual";
    loadBalancedEnvironmentId?: EnvironmentId | null;
    checkoutPullRequest?: DraftCheckoutPullRequest | null;
    ephemeral?: boolean;
  },
): DraftThreadState {
  const projectChanged =
    existingThread !== undefined &&
    (existingThread.environmentId !== projectRef.environmentId ||
      existingThread.projectId !== projectRef.projectId);
  const nextWorktreePath =
    options?.worktreePath === undefined
      ? projectChanged
        ? null
        : (existingThread?.worktreePath ?? null)
      : (options.worktreePath ?? null);
  const nextBranch =
    options?.branch === undefined
      ? projectChanged
        ? null
        : (existingThread?.branch ?? null)
      : (options.branch ?? null);
  const nextStartFromOrigin =
    options?.startFromOrigin === undefined
      ? (existingThread?.startFromOrigin ?? false)
      : options.startFromOrigin;
  const environmentSelection =
    options?.environmentSelection ?? existingThread?.environmentSelection;
  const checkoutPullRequest = resolveCheckoutPullRequest(
    existingThread,
    options?.checkoutPullRequest,
    projectChanged,
  );
  const nextEphemeral =
    options?.ephemeral === undefined ? (existingThread?.ephemeral ?? false) : options.ephemeral;
  return {
    threadId,
    environmentId: projectRef.environmentId,
    projectId: projectRef.projectId,
    logicalProjectKey,
    ...(environmentSelection ? { environmentSelection } : {}),
    ...(options?.loadBalancedEnvironmentId !== undefined
      ? { loadBalancedEnvironmentId: options.loadBalancedEnvironmentId }
      : existingThread?.loadBalancedEnvironmentId !== undefined
        ? {
            loadBalancedEnvironmentId: projectChanged
              ? null
              : existingThread.loadBalancedEnvironmentId,
          }
        : {}),
    createdAt: options?.createdAt ?? existingThread?.createdAt ?? new Date().toISOString(),
    runtimeMode: options?.runtimeMode ?? existingThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode:
      options?.interactionMode ?? existingThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
    branch: nextBranch,
    worktreePath: nextWorktreePath,
    envMode:
      options?.envMode ?? (nextWorktreePath ? "worktree" : (existingThread?.envMode ?? "local")),
    startFromOrigin: nextStartFromOrigin,
    ...(checkoutPullRequest ? { checkoutPullRequest } : {}),
    ...(nextEphemeral ? { ephemeral: true } : {}),
    ...(!projectChanged && existingThread?.worktreeRepositories !== undefined
      ? { worktreeRepositories: existingThread.worktreeRepositories }
      : {}),
    promotedTo: null,
  };
}

export function draftThreadsEqual(
  left: DraftThreadState | undefined,
  right: DraftThreadState,
): boolean {
  return (
    !!left &&
    left.threadId === right.threadId &&
    left.environmentId === right.environmentId &&
    left.projectId === right.projectId &&
    left.logicalProjectKey === right.logicalProjectKey &&
    left.environmentSelection === right.environmentSelection &&
    left.loadBalancedEnvironmentId === right.loadBalancedEnvironmentId &&
    left.createdAt === right.createdAt &&
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.envMode === right.envMode &&
    left.startFromOrigin === right.startFromOrigin &&
    Boolean(left.ephemeral) === Boolean(right.ephemeral) &&
    checkoutPullRequestsEqual(left.checkoutPullRequest, right.checkoutPullRequest) &&
    worktreeRepositoriesEqual(left.worktreeRepositories, right.worktreeRepositories) &&
    scopedThreadRefsEqual(left.promotedTo, right.promotedTo)
  );
}

export function removeDraftThreadReferences(
  state: Pick<
    ComposerDraftStoreState,
    | "draftThreadsByThreadKey"
    | "draftsByThreadKey"
    | "logicalProjectDraftThreadKeyByLogicalProjectKey"
  >,
  threadKey: string,
  composerDestination?: ScopedThreadRef,
): Pick<
  ComposerDraftStoreState,
  | "draftThreadsByThreadKey"
  | "draftsByThreadKey"
  | "logicalProjectDraftThreadKeyByLogicalProjectKey"
> {
  const nextLogicalMappings = Object.fromEntries(
    Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
      ([, draftThreadKey]) => draftThreadKey !== threadKey,
    ),
  ) as Record<string, string>;
  const { [threadKey]: _removedDraftThread, ...restDraftThreadsByThreadKey } =
    state.draftThreadsByThreadKey;
  const { [threadKey]: removedComposerDraft, ...restDraftsByThreadKey } = state.draftsByThreadKey;
  if (composerDestination && removedComposerDraft) {
    restDraftsByThreadKey[composerTargetKey(composerDestination)] = removedComposerDraft;
  } else {
    revokeDraftThreadPreviewUrls(removedComposerDraft);
  }
  return {
    draftsByThreadKey: restDraftsByThreadKey,
    draftThreadsByThreadKey: restDraftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey: nextLogicalMappings,
  };
}
