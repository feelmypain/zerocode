import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@zerocode/client-runtime/environment";
import {
  EnvironmentId,
  ModelSelection,
  type PreviewAnnotationPayload,
  ProjectId,
  ProviderInstanceId,
  ResponseContextRecord,
  ThreadId,
} from "@zerocode/contracts";
import {
  toComposerContextId,
  toKindScopedComposerContextId,
} from "@zerocode/shared/composerContextReferences";
import * as Equal from "effect/Equal";
import { DeepMutable } from "effect/Types";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import { rememberComposerImageBytes } from "../components/chat/composerAttachmentFiles";
import { getLocalStorageItem } from "../hooks/useLocalStorage";
import {
  environmentContextReference,
  fileContextReference,
  previewAnnotationContextReference,
  reviewCommentContextReference,
  terminalContextReference,
  threadContextReference,
} from "../lib/composerContextRecords";
import {
  ensureInlineContextReferences,
  formatInlineContextReference,
} from "../lib/composerContextReferences";
import { elementContextToPreviewAnnotation } from "../lib/elementContext";
import { createDeferredStorage, createMemoryStorage } from "../lib/storage";
import { migrateLegacyTerminalContextPlaceholders } from "../lib/terminalContext";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import {
  composerThreadRefFromKey,
  draftThreadHasOpenPreview,
  isDraftThreadPromoting,
  normalizeLegacyComposerStorageKey,
  projectDraftKey,
} from "./contextHelpers";
import {
  compactModelSelectionByProvider,
  compactStickyOptionsByModel,
  legacyMergeModelSelectionIntoProviderModelOptions,
  legacySyncModelSelectionOptions,
  legacyToModelSelectionByProvider,
  normalizeModelSelection,
  normalizePersistedModelSelectionByProvider,
  normalizeProviderInstanceId,
  normalizeProviderModelOptions,
  seedStickyOptionsByModel,
} from "./modelSelection";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  COMPOSER_PERSIST_DEBOUNCE_MS,
  composerDraftHasUserContent,
  type ComposerDraftStoreSet,
  type ComposerDraftStoreState,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerPersistState,
  type ComposerThreadDraftState,
  type DraftCheckoutPullRequest,
  type DraftThreadEnvMode,
  type DraftThreadState,
  EMPTY_PERSISTED_DRAFT_STORE_STATE,
  isElementContextDetails,
  isEnvironmentContextRecord,
  isPersistedComposerDraftFileAttachment,
  isPreviewAnnotationPayload,
  isResponseContextRecord,
  isReviewCommentContext,
  isRuntimeMode,
  isSnapShotSource,
  isThreadContextRecord,
  type LegacyPersistedComposerDraftStoreState,
  type LegacyPersistedComposerThreadDraftState,
  type PersistedComposerDraftStoreState,
  PersistedComposerDraftStoreStorage,
  type PersistedComposerImageAttachment,
  type PersistedComposerThreadDraftState,
  type PersistedDraftThreadState,
  type PersistedTerminalContextDraft,
  shouldRemoveDraft,
} from "./types";

const composerDraftBaseStorage =
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage();

interface ComposerDraftWrite {
  readonly text: string;
  /** This tab's own state as of the write; entries it still matches were not edited here. */
  readonly local: PersistedComposerDraftStoreState;
  readonly merged: PersistedComposerDraftStoreState;
}
let composerDraftLoadedState: PersistedComposerDraftStoreState | null = null;
let composerDraftLastWrite: ComposerDraftWrite | null = null;
let composerDraftPendingWrite: ComposerDraftWrite | null = null;

export function setComposerDraftLoadedState(state: ComposerDraftStoreState): void {
  composerDraftLoadedState = partializeComposerDraftStoreState(state);
}

function readStoredComposerDraftState(): PersistedComposerDraftStoreState | null {
  const text = composerDraftBaseStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
  if (typeof text !== "string") return null;
  if (text === composerDraftLastWrite?.text) return composerDraftLastWrite.merged;
  try {
    const parsed = JSON.parse(text) as StorageValue<PersistedComposerDraftStoreState>;
    return parsed.version === COMPOSER_DRAFT_STORAGE_VERSION ? parsed.state : null;
  } catch {
    return null;
  }
}

function mergeDraftRecord<V>(
  stored: Readonly<Record<string, V>> | undefined,
  local: Readonly<Record<string, V>>,
  baseline: Readonly<Record<string, V>>,
): Record<string, V> {
  const merged = { ...stored };
  for (const key of new Set([...Object.keys(local), ...Object.keys(baseline)])) {
    if (Equal.equals(local[key], baseline[key])) continue;
    const value = local[key];
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/** Writes only what this tab changed since its last write over what other tabs saved since. */
function mergeComposerDraftStates(
  stored: PersistedComposerDraftStoreState,
  local: PersistedComposerDraftStoreState,
  baseline: PersistedComposerDraftStoreState,
): PersistedComposerDraftStoreState {
  const pick = <K extends keyof PersistedComposerDraftStoreState>(key: K) => {
    const value = Equal.equals(local[key], baseline[key]) ? stored[key] : local[key];
    return value === undefined ? {} : { [key]: value };
  };
  return {
    draftsByThreadKey: mergeDraftRecord(
      stored.draftsByThreadKey,
      local.draftsByThreadKey,
      baseline.draftsByThreadKey,
    ),
    draftThreadsByThreadKey: mergeDraftRecord(
      stored.draftThreadsByThreadKey,
      local.draftThreadsByThreadKey,
      baseline.draftThreadsByThreadKey,
    ),
    logicalProjectDraftThreadKeyByLogicalProjectKey: mergeDraftRecord(
      stored.logicalProjectDraftThreadKeyByLogicalProjectKey,
      local.logicalProjectDraftThreadKeyByLogicalProjectKey,
      baseline.logicalProjectDraftThreadKeyByLogicalProjectKey,
    ),
    ...pick("stickyModelSelectionByProvider"),
    ...pick("stickyOptionsByModelByProvider"),
    ...pick("stickyActiveProvider"),
  };
}

function serializeComposerDraftState(value: StorageValue<ComposerPersistState>): string {
  if (!("capturedState" in value.state)) {
    return JSON.stringify({ state: value.state, version: value.version });
  }
  const local = partializeComposerDraftStoreState(value.state.capturedState);
  const baseline = composerDraftLastWrite?.local ?? composerDraftLoadedState;
  const stored = baseline ? readStoredComposerDraftState() : null;
  const merged = stored && baseline ? mergeComposerDraftStates(stored, local, baseline) : local;
  const text = JSON.stringify({ state: merged, version: value.version });
  composerDraftPendingWrite = { text, local, merged };
  return text;
}

export const composerDebouncedStorage = createDeferredStorage<StorageValue<ComposerPersistState>>(
  {
    getItem: (name) => composerDraftBaseStorage.getItem(name),
    setItem: (name, text) => {
      composerDraftBaseStorage.setItem(name, text);
      if (composerDraftPendingWrite?.text === text)
        composerDraftLastWrite = composerDraftPendingWrite;
    },
    removeItem: (name) => {
      composerDraftBaseStorage.removeItem(name);
      composerDraftLoadedState = null;
      composerDraftLastWrite = null;
    },
  },
  serializeComposerDraftState,
  COMPOSER_PERSIST_DEBOUNCE_MS,
);

export const composerPersistStorage: PersistStorage<ComposerPersistState> = {
  getItem: (name) => {
    const raw = composerDebouncedStorage.getItem(name);
    if (typeof raw !== "string") {
      return null;
    }
    return JSON.parse(raw) as StorageValue<ComposerPersistState>;
  },
  setItem: (name, value) => composerDebouncedStorage.setItem(name, value),
  removeItem: (name) => composerDebouncedStorage.removeItem(name),
};

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    composerDebouncedStorage.flush();
  });
}

function normalizePersistedAttachment(value: unknown): PersistedComposerImageAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const name = candidate.name;
  const mimeType = candidate.mimeType;
  const sizeBytes = candidate.sizeBytes;
  const dataUrl = candidate.dataUrl;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof mimeType !== "string" ||
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    typeof dataUrl !== "string" ||
    id.length === 0 ||
    dataUrl.length === 0
  ) {
    return null;
  }
  return {
    id,
    name,
    mimeType,
    sizeBytes,
    dataUrl,
    ...(isSnapShotSource(candidate.source) ? { source: candidate.source } : {}),
  };
}

function normalizePersistedTerminalContextDraft(
  value: unknown,
): PersistedTerminalContextDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const threadId = candidate.threadId;
  const createdAt = candidate.createdAt;
  const lineStart = candidate.lineStart;
  const lineEnd = candidate.lineEnd;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    typeof createdAt !== "string" ||
    createdAt.length === 0 ||
    typeof lineStart !== "number" ||
    !Number.isFinite(lineStart) ||
    typeof lineEnd !== "number" ||
    !Number.isFinite(lineEnd)
  ) {
    return null;
  }
  const terminalId = typeof candidate.terminalId === "string" ? candidate.terminalId.trim() : "";
  const terminalLabel =
    typeof candidate.terminalLabel === "string" ? candidate.terminalLabel.trim() : "";
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const normalizedLineStart = Math.max(1, Math.floor(lineStart));
  const normalizedLineEnd = Math.max(normalizedLineStart, Math.floor(lineEnd));
  return {
    id: toComposerContextId(id),
    threadId: threadId as ThreadId,
    createdAt,
    terminalId,
    terminalLabel,
    lineStart: normalizedLineStart,
    lineEnd: normalizedLineEnd,
    ...(typeof candidate.text === "string" ? { text: candidate.text } : {}),
  };
}

function normalizeDraftThreadEnvMode(
  value: unknown,
  fallbackWorktreePath: string | null,
): DraftThreadEnvMode {
  if (value === "local" || value === "worktree") {
    return value;
  }
  return fallbackWorktreePath ? "worktree" : "local";
}

function normalizePersistedCheckoutPullRequest(value: unknown): DraftCheckoutPullRequest | null {
  if (!value || typeof value !== "object") return null;
  const { url, branch } = value as Record<string, unknown>;
  return typeof url === "string" &&
    url.length > 0 &&
    typeof branch === "string" &&
    branch.length > 0
    ? { url, branch }
    : null;
}

function normalizePersistedDraftThreads(
  rawDraftThreadsByThreadId: unknown,
  rawProjectDraftThreadIdByProjectKey: unknown,
): Pick<
  PersistedComposerDraftStoreState,
  "draftThreadsByThreadKey" | "logicalProjectDraftThreadKeyByLogicalProjectKey"
> {
  const draftThreadsByThreadKey: Record<string, PersistedDraftThreadState> = {};
  const environmentIdByThreadId = new Map<ThreadId, EnvironmentId>();
  if (
    rawProjectDraftThreadIdByProjectKey &&
    typeof rawProjectDraftThreadIdByProjectKey === "object"
  ) {
    for (const [projectKey, threadId] of Object.entries(
      rawProjectDraftThreadIdByProjectKey as Record<string, unknown>,
    )) {
      if (typeof threadId !== "string" || threadId.length === 0) {
        continue;
      }
      const projectRef = parseScopedProjectKey(projectKey);
      if (!projectRef) {
        continue;
      }
      const parsedThreadRef = parseScopedThreadKey(threadId);
      if (parsedThreadRef) {
        environmentIdByThreadId.set(parsedThreadRef.threadId, parsedThreadRef.environmentId);
        continue;
      }
      environmentIdByThreadId.set(threadId as ThreadId, projectRef.environmentId);
    }
  }
  if (rawDraftThreadsByThreadId && typeof rawDraftThreadsByThreadId === "object") {
    for (const [threadKeyOrId, rawDraftThread] of Object.entries(
      rawDraftThreadsByThreadId as Record<string, unknown>,
    )) {
      if (typeof threadKeyOrId !== "string" || threadKeyOrId.length === 0) {
        continue;
      }
      if (!rawDraftThread || typeof rawDraftThread !== "object") {
        continue;
      }
      const candidateDraftThread = rawDraftThread as Record<string, unknown>;
      const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
      const threadKey = normalizeLegacyComposerStorageKey(threadKeyOrId);
      const threadId =
        parsedThreadRef?.threadId ??
        (typeof candidateDraftThread.threadId === "string" &&
        candidateDraftThread.threadId.length > 0
          ? (candidateDraftThread.threadId as ThreadId)
          : (threadKeyOrId as ThreadId));
      const environmentId =
        parsedThreadRef?.environmentId ??
        (typeof candidateDraftThread.environmentId === "string" &&
        candidateDraftThread.environmentId.length > 0
          ? (candidateDraftThread.environmentId as EnvironmentId)
          : environmentIdByThreadId.get(threadKeyOrId as ThreadId));
      const projectId = candidateDraftThread.projectId;
      const createdAt = candidateDraftThread.createdAt;
      const branch = candidateDraftThread.branch;
      const worktreePath = candidateDraftThread.worktreePath;
      const startFromOrigin = candidateDraftThread.startFromOrigin === true;
      const normalizedWorktreePath = typeof worktreePath === "string" ? worktreePath : null;
      const checkoutPullRequest = normalizePersistedCheckoutPullRequest(
        candidateDraftThread.checkoutPullRequest,
      );
      const promotedToCandidate = candidateDraftThread.promotedTo;
      const promotedToRecord =
        promotedToCandidate && typeof promotedToCandidate === "object"
          ? (promotedToCandidate as Record<string, unknown>)
          : null;
      const promotedTo =
        promotedToRecord &&
        typeof promotedToRecord.environmentId === "string" &&
        promotedToRecord.environmentId.length > 0 &&
        typeof promotedToRecord.threadId === "string" &&
        promotedToRecord.threadId.length > 0
          ? scopeThreadRef(
              promotedToRecord.environmentId as EnvironmentId,
              promotedToRecord.threadId as ThreadId,
            )
          : null;
      if (typeof projectId !== "string" || projectId.length === 0 || environmentId === undefined) {
        continue;
      }
      const normalizedEnvironmentId = environmentId as EnvironmentId;
      draftThreadsByThreadKey[threadKey] = {
        threadId,
        environmentId: normalizedEnvironmentId,
        projectId: projectId as ProjectId,
        logicalProjectKey:
          typeof candidateDraftThread.logicalProjectKey === "string" &&
          candidateDraftThread.logicalProjectKey.length > 0
            ? candidateDraftThread.logicalProjectKey
            : parsedThreadRef
              ? projectDraftKey(scopeProjectRef(normalizedEnvironmentId, projectId as ProjectId))
              : threadKeyOrId,
        createdAt:
          typeof createdAt === "string" && createdAt.length > 0
            ? createdAt
            : new Date().toISOString(),
        runtimeMode: isRuntimeMode(candidateDraftThread.runtimeMode)
          ? candidateDraftThread.runtimeMode
          : DEFAULT_RUNTIME_MODE,
        interactionMode:
          candidateDraftThread.interactionMode === "plan" ||
          candidateDraftThread.interactionMode === "default"
            ? candidateDraftThread.interactionMode
            : DEFAULT_INTERACTION_MODE,
        branch: typeof branch === "string" ? branch : null,
        worktreePath: normalizedWorktreePath,
        envMode: normalizeDraftThreadEnvMode(candidateDraftThread.envMode, normalizedWorktreePath),
        startFromOrigin,
        ...(candidateDraftThread.environmentSelection === "manual" ||
        candidateDraftThread.environmentSelection === "auto"
          ? { environmentSelection: candidateDraftThread.environmentSelection }
          : {}),
        ...(typeof candidateDraftThread.loadBalancedEnvironmentId === "string" &&
        candidateDraftThread.loadBalancedEnvironmentId.length > 0
          ? { loadBalancedEnvironmentId: candidateDraftThread.loadBalancedEnvironmentId }
          : candidateDraftThread.loadBalancedEnvironmentId === null
            ? { loadBalancedEnvironmentId: null }
            : {}),
        ...(checkoutPullRequest ? { checkoutPullRequest } : {}),
        ...(Array.isArray(candidateDraftThread.worktreeRepositories)
          ? {
              worktreeRepositories: candidateDraftThread.worktreeRepositories.filter(
                (path): path is string => typeof path === "string",
              ),
            }
          : {}),
        promotedTo,
      };
    }
  }

  const logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string> = {};
  if (
    rawProjectDraftThreadIdByProjectKey &&
    typeof rawProjectDraftThreadIdByProjectKey === "object"
  ) {
    for (const [logicalProjectKey, threadKeyOrId] of Object.entries(
      rawProjectDraftThreadIdByProjectKey as Record<string, unknown>,
    )) {
      if (typeof threadKeyOrId !== "string" || threadKeyOrId.length === 0) {
        continue;
      }
      const projectRef = parseScopedProjectKey(logicalProjectKey);
      const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
      const threadKey = normalizeLegacyComposerStorageKey(threadKeyOrId);
      logicalProjectDraftThreadKeyByLogicalProjectKey[logicalProjectKey] = threadKey;
      const existingDraftThread = draftThreadsByThreadKey[threadKey];
      if (parsedThreadRef) {
        environmentIdByThreadId.set(parsedThreadRef.threadId, parsedThreadRef.environmentId);
      }
      // Logical keys may contain workspace paths; a matching draft's concrete project id wins.
      if (existingDraftThread?.logicalProjectKey === logicalProjectKey) {
        continue;
      }
      if (!projectRef) {
        if (existingDraftThread) {
          draftThreadsByThreadKey[threadKey] = {
            ...existingDraftThread,
            logicalProjectKey,
          };
        }
        continue;
      }
      if (!existingDraftThread) {
        draftThreadsByThreadKey[threadKey] = {
          threadId: parsedThreadRef?.threadId ?? (threadKey as ThreadId),
          environmentId: projectRef.environmentId,
          projectId: projectRef.projectId,
          logicalProjectKey,
          createdAt: new Date().toISOString(),
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          envMode: "local",
          startFromOrigin: false,
          promotedTo: null,
        };
      } else if (
        existingDraftThread.projectId !== projectRef.projectId ||
        existingDraftThread.environmentId !== projectRef.environmentId
      ) {
        draftThreadsByThreadKey[threadKey] = {
          ...existingDraftThread,
          threadId: existingDraftThread.threadId,
          environmentId: projectRef.environmentId,
          projectId: projectRef.projectId,
          logicalProjectKey,
        };
      }
    }
  }

  return { draftThreadsByThreadKey, logicalProjectDraftThreadKeyByLogicalProjectKey };
}

function normalizePersistedDraftsByThreadId(
  rawDraftMap: unknown,
  draftThreadsByThreadKey: PersistedComposerDraftStoreState["draftThreadsByThreadKey"],
): PersistedComposerDraftStoreState["draftsByThreadKey"] {
  if (!rawDraftMap || typeof rawDraftMap !== "object") {
    return {};
  }

  const environmentIdByThreadId = new Map<ThreadId, EnvironmentId>();
  for (const [threadKey, draftThread] of Object.entries(draftThreadsByThreadKey)) {
    const parsedThreadRef = composerThreadRefFromKey(threadKey);
    if (!parsedThreadRef) {
      continue;
    }
    environmentIdByThreadId.set(
      parsedThreadRef.threadId,
      draftThread.environmentId as EnvironmentId,
    );
  }

  const nextDraftsByThreadKey: DeepMutable<PersistedComposerDraftStoreState["draftsByThreadKey"]> =
    {};
  for (const [threadKeyOrId, draftValue] of Object.entries(
    rawDraftMap as Record<string, unknown>,
  )) {
    if (typeof threadKeyOrId !== "string" || threadKeyOrId.length === 0) {
      continue;
    }
    if (!draftValue || typeof draftValue !== "object") {
      continue;
    }
    const draftCandidate = draftValue as PersistedComposerThreadDraftState;
    const promptCandidate = typeof draftCandidate.prompt === "string" ? draftCandidate.prompt : "";
    const attachments = Array.isArray(draftCandidate.attachments)
      ? draftCandidate.attachments.flatMap((entry) => {
          const normalized = normalizePersistedAttachment(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const files = Array.isArray(draftCandidate.files)
      ? draftCandidate.files.filter(isPersistedComposerDraftFileAttachment)
      : [];
    const terminalContexts = Array.isArray(draftCandidate.terminalContexts)
      ? draftCandidate.terminalContexts.flatMap((entry) => {
          const normalized = normalizePersistedTerminalContextDraft(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const reviewComments = Array.isArray(draftCandidate.reviewComments)
      ? draftCandidate.reviewComments.filter(isReviewCommentContext)
      : [];
    const threadContexts = Array.isArray(draftCandidate.threadContexts)
      ? draftCandidate.threadContexts.filter(isThreadContextRecord)
      : [];
    const environmentContexts = Array.isArray(draftCandidate.environmentContexts)
      ? draftCandidate.environmentContexts.filter(isEnvironmentContextRecord)
      : [];
    const previewAnnotations = Array.isArray(draftCandidate.previewAnnotations)
      ? draftCandidate.previewAnnotations.filter(isPreviewAnnotationPayload)
      : [];
    const replyTo = isResponseContextRecord(draftCandidate.replyTo) ? draftCandidate.replyTo : null;
    const legacyElements =
      "elementContexts" in draftValue && Array.isArray(draftValue.elementContexts)
        ? draftValue.elementContexts
        : [];
    for (const element of legacyElements) {
      if (
        !isElementContextDetails(element) ||
        !("id" in element) ||
        typeof element.id !== "string" ||
        !("pickedAt" in element) ||
        typeof element.pickedAt !== "string"
      )
        continue;
      if (!previewAnnotations.some((annotation) => annotation.id === element.id)) {
        previewAnnotations.push(
          elementContextToPreviewAnnotation(element, element.id, element.pickedAt),
        );
      }
    }
    const runtimeMode = isRuntimeMode(draftCandidate.runtimeMode)
      ? draftCandidate.runtimeMode
      : null;
    const interactionMode =
      draftCandidate.interactionMode === "plan" || draftCandidate.interactionMode === "default"
        ? draftCandidate.interactionMode
        : null;
    const contextIds = new Map<string, string>();
    for (const [kind, entries] of [
      ["image", attachments],
      ["file", files],
      ["terminal", terminalContexts],
      ["review-comment", reviewComments],
      ["preview-annotation", previewAnnotations],
    ] as const) {
      for (const entry of entries) {
        const contextId = toKindScopedComposerContextId(kind, entry.id);
        contextIds.set(`${kind}/${entry.id}`, contextId);
        contextIds.set(`${kind}/${toComposerContextId(entry.id)}`, contextId);
        if (kind === "preview-annotation") {
          contextIds.set(`${kind}/${toComposerContextId(`annotation-${entry.id}`)}`, contextId);
        }
      }
      for (const entry of entries) {
        const contextId = toKindScopedComposerContextId(kind, entry.id);
        contextIds.set(`${kind}/${contextId}`, contextId);
      }
    }
    const migratedPrompt = promptCandidate.replace(
      /!?\[([^\]\r\n]*)\]\(zerocode-context:\/\/v1\/([a-z-]+)\/([^/()\r\n]+)\)/g,
      (source, label: string, kind: string, id: string) => {
        const contextId = contextIds.get(`${kind}/${id}`);
        return contextId ? formatInlineContextReference({ kind, contextId, label }) : source;
      },
    );
    const prompt = ensureInlineContextReferences(
      migrateLegacyTerminalContextPlaceholders(migratedPrompt, terminalContexts),
      terminalContexts.map((context) => terminalContextReference({ ...context, text: "" })),
    );
    const legacyDraftCandidate = draftValue as LegacyPersistedComposerThreadDraftState;
    let modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> = {};
    let activeProvider: ProviderInstanceId | null = null;
    let modelSelectionExplicit: true | undefined = undefined;

    if (
      draftCandidate.modelSelectionByProvider &&
      typeof draftCandidate.modelSelectionByProvider === "object"
    ) {
      modelSelectionByProvider = normalizePersistedModelSelectionByProvider(
        draftCandidate.modelSelectionByProvider,
      );
      activeProvider = normalizeProviderInstanceId(draftCandidate.activeProvider);
      modelSelectionExplicit = draftCandidate.modelSelectionExplicit === true ? true : undefined;
    } else {
      const normalizedModelOptions =
        normalizeProviderModelOptions(
          legacyDraftCandidate.modelOptions,
          undefined,
          legacyDraftCandidate,
        ) ?? null;
      const normalizedModelSelection = normalizeModelSelection(
        legacyDraftCandidate.modelSelection,
        {
          provider: legacyDraftCandidate.provider,
          model: legacyDraftCandidate.model,
          modelOptions: normalizedModelOptions ?? (legacyDraftCandidate.modelOptions as unknown),
          legacyCodex: legacyDraftCandidate,
        },
      );
      const mergedModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
        normalizedModelSelection,
        normalizedModelOptions,
      );
      const modelSelection = legacySyncModelSelectionOptions(
        normalizedModelSelection,
        mergedModelOptions,
      );
      modelSelectionByProvider = legacyToModelSelectionByProvider(
        modelSelection,
        mergedModelOptions,
      );
      activeProvider = modelSelection?.instanceId ?? null;
    }

    const hasModelData =
      Object.keys(modelSelectionByProvider).length > 0 || activeProvider !== null;
    if (
      promptCandidate.length === 0 &&
      attachments.length === 0 &&
      files.length === 0 &&
      terminalContexts.length === 0 &&
      previewAnnotations.length === 0 &&
      reviewComments.length === 0 &&
      threadContexts.length === 0 &&
      environmentContexts.length === 0 &&
      replyTo === null &&
      !hasModelData &&
      !runtimeMode &&
      !interactionMode
    ) {
      continue;
    }
    const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
    const normalizedThreadKey =
      parsedThreadRef !== null
        ? normalizeLegacyComposerStorageKey(threadKeyOrId)
        : draftThreadsByThreadKey[threadKeyOrId] !== undefined
          ? threadKeyOrId
          : (() => {
              const environmentId = environmentIdByThreadId.get(threadKeyOrId as ThreadId);
              return environmentId
                ? normalizeLegacyComposerStorageKey(threadKeyOrId, { environmentId })
                : threadKeyOrId;
            })();
    nextDraftsByThreadKey[normalizedThreadKey] = {
      prompt,
      attachments,
      ...(files.length > 0 ? { files } : {}),
      ...(terminalContexts.length > 0 ? { terminalContexts } : {}),
      ...(previewAnnotations.length > 0 ? { previewAnnotations } : {}),
      ...(reviewComments.length > 0 ? { reviewComments } : {}),
      ...(threadContexts.length > 0 ? { threadContexts } : {}),
      ...(environmentContexts.length > 0 ? { environmentContexts } : {}),
      ...(replyTo ? { replyTo: replyTo as DeepMutable<ResponseContextRecord> } : {}),
      ...(hasModelData
        ? {
            modelSelectionByProvider: compactModelSelectionByProvider(modelSelectionByProvider),
            activeProvider,
            ...(modelSelectionExplicit ? { modelSelectionExplicit: true } : {}),
          }
        : {}),
      ...(runtimeMode ? { runtimeMode } : {}),
      ...(interactionMode ? { interactionMode } : {}),
    };
  }

  return nextDraftsByThreadKey;
}

function persistedComposerDraftHasUserContent(draft: PersistedComposerThreadDraftState): boolean {
  return (
    draft.prompt.trim().length > 0 ||
    draft.attachments.length > 0 ||
    (draft.files?.length ?? 0) > 0 ||
    (draft.terminalContexts?.length ?? 0) > 0 ||
    (draft.previewAnnotations?.length ?? 0) > 0 ||
    (draft.reviewComments?.length ?? 0) > 0 ||
    (draft.threadContexts?.length ?? 0) > 0 ||
    (draft.environmentContexts?.length ?? 0) > 0 ||
    draft.replyTo !== undefined
  );
}

function stripLegacyModelSeedsFromEmptyDraftSessions(
  draftsByThreadKey: PersistedComposerDraftStoreState["draftsByThreadKey"],
  draftThreadsByThreadKey: PersistedComposerDraftStoreState["draftThreadsByThreadKey"],
): PersistedComposerDraftStoreState["draftsByThreadKey"] {
  return Object.fromEntries(
    Object.entries(draftsByThreadKey).flatMap(([threadKey, draft]) => {
      if (
        draftThreadsByThreadKey[threadKey] === undefined ||
        draft.modelSelectionExplicit === true ||
        persistedComposerDraftHasUserContent(draft)
      ) {
        return [[threadKey, draft]];
      }

      const {
        activeProvider: _activeProvider,
        modelSelectionByProvider: _modelSelectionByProvider,
        modelSelectionExplicit: _modelSelectionExplicit,
        ...retained
      } = draft;
      return retained.runtimeMode || retained.interactionMode ? [[threadKey, retained]] : [];
    }),
  );
}

export function migratePersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  const normalized = normalizeCurrentPersistedComposerDraftStoreState(persistedState);
  return {
    ...normalized,
    draftsByThreadKey: stripLegacyModelSeedsFromEmptyDraftSessions(
      normalized.draftsByThreadKey,
      normalized.draftThreadsByThreadKey,
    ),
  };
}

export function partializeComposerDraftStoreState(
  state: ComposerDraftStoreState,
): PersistedComposerDraftStoreState {
  const mappedDraftKeys = new Set(
    Object.values(state.logicalProjectDraftThreadKeyByLogicalProjectKey),
  );
  const keptSessionKeys = new Set(
    Object.entries(state.draftThreadsByThreadKey)
      .filter(
        ([threadKey, draftThread]) =>
          mappedDraftKeys.has(threadKey) ||
          isDraftThreadPromoting(draftThread) ||
          composerDraftHasUserContent(state.draftsByThreadKey[threadKey]) ||
          draftThreadHasOpenPreview(draftThread),
      )
      .map(([threadKey]) => threadKey),
  );
  const persistedDraftsByThreadKey: DeepMutable<
    PersistedComposerDraftStoreState["draftsByThreadKey"]
  > = {};
  for (const [threadKey, draft] of Object.entries(state.draftsByThreadKey)) {
    if (typeof threadKey !== "string" || threadKey.length === 0) {
      continue;
    }
    if (state.draftThreadsByThreadKey[threadKey] !== undefined && !keptSessionKeys.has(threadKey)) {
      continue;
    }
    const hasModelData =
      Object.keys(draft.modelSelectionByProvider).length > 0 || draft.activeProvider !== null;
    if (
      draft.prompt.length === 0 &&
      draft.persistedAttachments.length === 0 &&
      draft.files.length === 0 &&
      draft.terminalContexts.length === 0 &&
      draft.previewAnnotations.length === 0 &&
      draft.reviewComments.length === 0 &&
      draft.threadContexts.length === 0 &&
      draft.environmentContexts.length === 0 &&
      draft.replyTo === null &&
      !hasModelData &&
      draft.runtimeMode === null &&
      draft.interactionMode === null
    ) {
      continue;
    }
    const persistedDraft: DeepMutable<PersistedComposerThreadDraftState> = {
      prompt: draft.prompt,
      attachments: draft.persistedAttachments,
      ...(draft.files.length > 0
        ? {
            files: draft.files.map((file) => ({
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              sizeBytes: file.sizeBytes,
              ...(file.source ? { source: file.source } : {}),
              ...(file.uploadedAttachmentId && file.uploadEnvironmentId
                ? {
                    attachmentId: file.uploadedAttachmentId,
                    environmentId: file.uploadEnvironmentId,
                  }
                : {}),
            })),
          }
        : {}),
      ...(draft.terminalContexts.length > 0
        ? {
            terminalContexts: draft.terminalContexts.map((context) => ({
              id: context.id,
              threadId: context.threadId,
              createdAt: context.createdAt,
              terminalId: context.terminalId,
              terminalLabel: context.terminalLabel,
              lineStart: context.lineStart,
              lineEnd: context.lineEnd,
              text: context.text,
            })),
          }
        : {}),
      ...(draft.previewAnnotations.length > 0
        ? {
            previewAnnotations: draft.previewAnnotations.map(
              (annotation) => ({ ...annotation }) as DeepMutable<PreviewAnnotationPayload>,
            ),
          }
        : {}),
      ...(draft.reviewComments.length > 0
        ? {
            reviewComments: draft.reviewComments.map((comment) => ({ ...comment })),
          }
        : {}),
      ...(draft.threadContexts.length > 0
        ? { threadContexts: draft.threadContexts.map((record) => ({ ...record })) }
        : {}),
      ...(draft.environmentContexts.length > 0
        ? { environmentContexts: draft.environmentContexts.map((record) => ({ ...record })) }
        : {}),
      ...(draft.replyTo
        ? { replyTo: { ...draft.replyTo } as DeepMutable<ResponseContextRecord> }
        : {}),
      ...(hasModelData
        ? {
            modelSelectionByProvider: compactModelSelectionByProvider(
              draft.modelSelectionByProvider,
            ),
            activeProvider: draft.activeProvider,
            ...(draft.modelSelectionExplicit ? { modelSelectionExplicit: true } : {}),
          }
        : {}),
      ...(draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
      ...(draft.interactionMode ? { interactionMode: draft.interactionMode } : {}),
    };
    persistedDraftsByThreadKey[threadKey] = persistedDraft;
  }
  const persistedDraftThreadsByThreadKey: DeepMutable<
    PersistedComposerDraftStoreState["draftThreadsByThreadKey"]
  > = {};
  for (const [threadKey, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
    if (!keptSessionKeys.has(threadKey)) {
      continue;
    }
    const { worktreeRepositories, ...persistedDraftThread } = draftThread;
    persistedDraftThreadsByThreadKey[threadKey] = {
      ...persistedDraftThread,
      ...(worktreeRepositories ? { worktreeRepositories: [...worktreeRepositories] } : {}),
    };
  }
  return {
    draftsByThreadKey: persistedDraftsByThreadKey,
    draftThreadsByThreadKey: persistedDraftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey:
      state.logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: compactModelSelectionByProvider(
      state.stickyModelSelectionByProvider,
    ),
    stickyOptionsByModelByProvider: compactStickyOptionsByModel(
      state.stickyOptionsByModelByProvider,
    ),
    stickyActiveProvider: state.stickyActiveProvider,
  };
}

function normalizeCurrentPersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  const normalizedPersistedState = persistedState as LegacyPersistedComposerDraftStoreState;
  const { draftThreadsByThreadKey, logicalProjectDraftThreadKeyByLogicalProjectKey } =
    normalizePersistedDraftThreads(
      normalizedPersistedState.draftThreadsByThreadKey ??
        normalizedPersistedState.draftThreadsByThreadId,
      normalizedPersistedState.logicalProjectDraftThreadKeyByLogicalProjectKey ??
        normalizedPersistedState.projectDraftThreadKeyByProjectKey ??
        normalizedPersistedState.projectDraftThreadIdByProjectKey ??
        normalizedPersistedState.projectDraftThreadIdByProjectId,
    );

  let stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> = {};
  let stickyActiveProvider: ProviderInstanceId | null = null;
  if (
    normalizedPersistedState.stickyModelSelectionByProvider &&
    typeof normalizedPersistedState.stickyModelSelectionByProvider === "object"
  ) {
    stickyModelSelectionByProvider = normalizePersistedModelSelectionByProvider(
      normalizedPersistedState.stickyModelSelectionByProvider,
    );
    stickyActiveProvider = normalizeProviderInstanceId(
      normalizedPersistedState.stickyActiveProvider,
    );
  } else {
    const stickyModelOptions =
      normalizeProviderModelOptions(normalizedPersistedState.stickyModelOptions) ?? {};
    const normalizedStickyModelSelection = normalizeModelSelection(
      normalizedPersistedState.stickyModelSelection,
      {
        provider: normalizedPersistedState.stickyProvider ?? "codex",
        model: normalizedPersistedState.stickyModel,
        modelOptions: stickyModelOptions,
      },
    );
    const nextStickyModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
      normalizedStickyModelSelection,
      stickyModelOptions,
    );
    const stickyModelSelection = legacySyncModelSelectionOptions(
      normalizedStickyModelSelection,
      nextStickyModelOptions,
    );
    stickyModelSelectionByProvider = legacyToModelSelectionByProvider(
      stickyModelSelection,
      nextStickyModelOptions,
    );
    stickyActiveProvider = normalizeProviderInstanceId(normalizedPersistedState.stickyProvider);
  }

  return {
    draftsByThreadKey: normalizePersistedDraftsByThreadId(
      normalizedPersistedState.draftsByThreadKey ?? normalizedPersistedState.draftsByThreadId,
      draftThreadsByThreadKey,
    ),
    draftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: compactModelSelectionByProvider(stickyModelSelectionByProvider),
    stickyOptionsByModelByProvider:
      normalizedPersistedState.stickyOptionsByModelByProvider === undefined
        ? seedStickyOptionsByModel(stickyModelSelectionByProvider)
        : compactStickyOptionsByModel(normalizedPersistedState.stickyOptionsByModelByProvider),
    stickyActiveProvider,
  };
}

function readPersistedAttachmentIdsFromStorage(threadKey: string): string[] {
  if (threadKey.length === 0) {
    return [];
  }
  try {
    const persisted = getLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      PersistedComposerDraftStoreStorage,
    );
    if (!persisted || persisted.version !== COMPOSER_DRAFT_STORAGE_VERSION) {
      return [];
    }
    return (persisted.state.draftsByThreadKey[threadKey]?.attachments ?? []).map(
      (attachment) => attachment.id,
    );
  } catch {
    return [];
  }
}

export function verifyPersistedAttachments(threadKey: string, set: ComposerDraftStoreSet): void {
  let persistedIdSet = new Set<string>();
  try {
    composerDebouncedStorage.flush();
    persistedIdSet = new Set(readPersistedAttachmentIdsFromStorage(threadKey));
  } catch {
    persistedIdSet = new Set();
  }
  set((state) => {
    const current = state.draftsByThreadKey[threadKey];
    if (!current) {
      return state;
    }
    const imageIdSet = new Set(current.images.map((image) => image.id));
    const persistedAttachments = current.persistedAttachments.filter(
      (attachment) => imageIdSet.has(attachment.id) && persistedIdSet.has(attachment.id),
    );
    const nonPersistedImageIds: string[] = [];
    for (const image of current.images) {
      if (!persistedIdSet.has(image.id)) {
        nonPersistedImageIds.push(image.id);
      }
    }
    const nextDraft: ComposerThreadDraftState = {
      ...current,
      persistedAttachments,
      nonPersistedImageIds,
    };
    const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
    if (shouldRemoveDraft(nextDraft)) {
      delete nextDraftsByThreadKey[threadKey];
    } else {
      nextDraftsByThreadKey[threadKey] = nextDraft;
    }
    return { draftsByThreadKey: nextDraftsByThreadKey };
  });
}

function hydratePersistedComposerImageAttachment(
  attachment: PersistedComposerImageAttachment,
): File | null {
  const commaIndex = attachment.dataUrl.indexOf(",");
  const header = commaIndex === -1 ? attachment.dataUrl : attachment.dataUrl.slice(0, commaIndex);
  const payload = commaIndex === -1 ? "" : attachment.dataUrl.slice(commaIndex + 1);
  if (payload.length === 0) {
    return null;
  }
  try {
    const isBase64 = header.includes(";base64");
    if (!isBase64) {
      const decodedText = decodeURIComponent(payload);
      const inferredMimeType =
        header.startsWith("data:") && header.includes(";")
          ? header.slice("data:".length, header.indexOf(";"))
          : attachment.mimeType;
      const textBytes = new TextEncoder().encode(decodedText);
      const textFile = new File([textBytes], attachment.name, {
        type: inferredMimeType || attachment.mimeType,
      });
      rememberComposerImageBytes(textFile, textBytes);
      return textFile;
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const file = new File([bytes], attachment.name, { type: attachment.mimeType });
    rememberComposerImageBytes(file, bytes);
    return file;
  } catch {
    return null;
  }
}

export function hydrateImagesFromPersisted(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): ComposerImageAttachment[] {
  return attachments.flatMap((attachment) => {
    const file = hydratePersistedComposerImageAttachment(attachment);
    if (!file) return [];

    return [
      {
        type: "image" as const,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        previewUrl: attachment.dataUrl,
        file,
        ...(attachment.source ? { source: attachment.source } : {}),
      } satisfies ComposerImageAttachment,
    ];
  });
}

function toHydratedThreadDraft(
  persistedDraft: PersistedComposerThreadDraftState,
): ComposerThreadDraftState {
  const modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> =
    persistedDraft.modelSelectionByProvider ?? {};
  const activeProvider = normalizeProviderInstanceId(persistedDraft.activeProvider) ?? null;
  const files: ComposerFileAttachment[] =
    persistedDraft.files?.map((file) => ({
      type: "file" as const,
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      file: null,
      ...(file.source ? { source: file.source } : {}),
      ...(file.attachmentId !== undefined && file.environmentId !== undefined
        ? { uploadedAttachmentId: file.attachmentId, uploadEnvironmentId: file.environmentId }
        : {}),
    })) ?? [];

  return {
    prompt: ensureInlineContextReferences(persistedDraft.prompt, [
      ...(persistedDraft.reviewComments ?? []).map(reviewCommentContextReference),
      ...(persistedDraft.previewAnnotations ?? []).map(previewAnnotationContextReference),
      ...(persistedDraft.threadContexts ?? []).map(threadContextReference),
      ...(persistedDraft.environmentContexts ?? []).map(environmentContextReference),
      ...files.map(fileContextReference),
    ]),
    images: hydrateImagesFromPersisted(persistedDraft.attachments),
    files,
    nonPersistedImageIds: [],
    persistedAttachments: [...persistedDraft.attachments],
    terminalContexts:
      persistedDraft.terminalContexts?.map((context) => ({
        ...context,
        text: context.text ?? "",
      })) ?? [],
    previewAnnotations:
      persistedDraft.previewAnnotations?.map((annotation) => ({ ...annotation })) ?? [],
    reviewComments: persistedDraft.reviewComments?.map((comment) => ({ ...comment })) ?? [],
    threadContexts: persistedDraft.threadContexts?.map((record) => ({ ...record })) ?? [],
    environmentContexts: persistedDraft.environmentContexts?.map((record) => ({ ...record })) ?? [],
    replyTo: persistedDraft.replyTo ?? null,
    modelSelectionByProvider,
    activeProvider,
    ...(persistedDraft.modelSelectionExplicit ? { modelSelectionExplicit: true } : {}),
    runtimeMode: persistedDraft.runtimeMode ?? null,
    interactionMode: persistedDraft.interactionMode ?? null,
  };
}

function toHydratedDraftThreadState(
  persistedDraftThread: PersistedDraftThreadState,
): DraftThreadState {
  return {
    threadId: persistedDraftThread.threadId,
    environmentId: persistedDraftThread.environmentId as EnvironmentId,
    projectId: persistedDraftThread.projectId,
    logicalProjectKey:
      persistedDraftThread.logicalProjectKey ??
      projectDraftKey(
        scopeProjectRef(
          persistedDraftThread.environmentId as EnvironmentId,
          persistedDraftThread.projectId,
        ),
      ),
    createdAt: persistedDraftThread.createdAt,
    runtimeMode: persistedDraftThread.runtimeMode,
    interactionMode: persistedDraftThread.interactionMode,
    branch: persistedDraftThread.branch,
    worktreePath: persistedDraftThread.worktreePath,
    envMode: persistedDraftThread.envMode,
    startFromOrigin: persistedDraftThread.startFromOrigin,
    ...(persistedDraftThread.environmentSelection
      ? { environmentSelection: persistedDraftThread.environmentSelection }
      : {}),
    ...(persistedDraftThread.loadBalancedEnvironmentId !== undefined
      ? {
          loadBalancedEnvironmentId:
            persistedDraftThread.loadBalancedEnvironmentId as EnvironmentId | null,
        }
      : {}),
    ...(persistedDraftThread.checkoutPullRequest
      ? { checkoutPullRequest: persistedDraftThread.checkoutPullRequest }
      : {}),
    ...(persistedDraftThread.worktreeRepositories
      ? { worktreeRepositories: persistedDraftThread.worktreeRepositories }
      : {}),
    promotedTo: persistedDraftThread.promotedTo
      ? scopeThreadRef(
          persistedDraftThread.promotedTo.environmentId as EnvironmentId,
          persistedDraftThread.promotedTo.threadId as ThreadId,
        )
      : null,
  };
}

export function mergePersistedComposerDraftStoreState(
  persistedState: unknown,
  currentState: ComposerDraftStoreState,
): ComposerDraftStoreState {
  const normalizedPersisted = normalizeCurrentPersistedComposerDraftStoreState(persistedState);
  const draftsByThreadKey = Object.fromEntries(
    Object.entries(normalizedPersisted.draftsByThreadKey).map(([threadKey, draft]) => [
      threadKey,
      toHydratedThreadDraft(draft),
    ]),
  );
  const draftThreadsByThreadKey = Object.fromEntries(
    Object.entries(normalizedPersisted.draftThreadsByThreadKey).map(([threadKey, draftThread]) => [
      threadKey,
      toHydratedDraftThreadState(draftThread),
    ]),
  ) as Record<string, DraftThreadState>;
  return {
    ...currentState,
    draftsByThreadKey,
    draftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey:
      normalizedPersisted.logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: normalizedPersisted.stickyModelSelectionByProvider ?? {},
    stickyOptionsByModelByProvider: normalizedPersisted.stickyOptionsByModelByProvider ?? {},
    stickyActiveProvider: normalizedPersisted.stickyActiveProvider ?? null,
  };
}
