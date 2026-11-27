import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@zerocode/client-runtime/environment";
import type {
  EnvironmentShellState,
  EnvironmentThreadShell,
} from "@zerocode/client-runtime/state/shell";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  type ScopedThreadRef,
  ThreadId,
} from "@zerocode/contracts";
import {
  createModelSelection,
  draftModelPickMatchesThread,
  normalizeCustomModelSlug,
} from "@zerocode/shared/model";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import { waitForDraftHeroTransition } from "./components/chat/draftHeroTransition";
import { createComposerContextActions } from "./composerDraft/contextActions";
import {
  checkoutPullRequestsEqual,
  clearStaleFileUploadMetadata,
  composerFileDedupKey,
  composerFileMatchesReattachMarker,
  composerTargetKey,
  createDraftThreadState,
  draftThreadHasOpenPreview,
  draftThreadsEqual,
  getComposerDraftState,
  isComposerThreadKeyInUse,
  isDraftThreadPromoting,
  logicalProjectDraftKey,
  projectDraftKey,
  queuedRunEditDraftId,
  removeDraftThreadReferences,
  resolveCheckoutPullRequest,
  resolveComposerDraftKey,
  revokeDraftThreadPreviewUrls,
  scopedThreadRefsEqual,
  toProjectDraftSession,
  worktreeRepositoriesEqual,
} from "./composerDraft/contextHelpers";
import {
  compactModelSelectionByProvider,
  deriveEffectiveComposerModelState,
  isSameModel,
  normalizeModelSelection,
  normalizeProviderDriverKind,
} from "./composerDraft/modelSelection";
import {
  composerDebouncedStorage,
  composerPersistStorage,
  hydrateImagesFromPersisted,
  mergePersistedComposerDraftStoreState,
  migratePersistedComposerDraftStoreState,
  partializeComposerDraftStoreState,
  setComposerDraftLoadedState,
} from "./composerDraft/persistence";
import {
  checkoutPullRequestUrlToLink,
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  type ComposerContextAddOptions,
  type ComposerContextInsertionHandler,
  composerDraftHasUserContent,
  type ComposerDraftModelState,
  type ComposerDraftStoreState,
  type ComposerFileAttachment,
  composerFileNeedsReattach,
  type ComposerImageAttachment,
  type ComposerPersistState,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
  createEmptyThreadDraft,
  type DraftCheckoutPullRequest,
  DraftId,
  type DraftSessionState,
  type DraftThreadEnvMode,
  type DraftThreadState,
  type EffectiveComposerModelState,
  EMPTY_COMPOSER_DRAFT_MODEL_STATE,
  EMPTY_THREAD_DRAFT,
  isRuntimeMode,
  PersistedComposerDraftFileAttachment,
  PersistedComposerFileAttachment,
  PersistedComposerImageAttachment,
  shouldRemoveDraft,
} from "./composerDraft/types";

export {
  checkoutPullRequestUrlToLink,
  COMPOSER_DRAFT_STORAGE_KEY,
  type ComposerContextAddOptions,
  type ComposerContextInsertionHandler,
  composerDraftHasUserContent,
  type ComposerFileAttachment,
  composerFileDedupKey,
  composerFileMatchesReattachMarker,
  composerFileNeedsReattach,
  type ComposerImageAttachment,
  composerTargetKey,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
  deriveEffectiveComposerModelState,
  type DraftCheckoutPullRequest,
  DraftId,
  type DraftSessionState,
  type DraftThreadEnvMode,
  type DraftThreadState,
  type EffectiveComposerModelState,
  hydrateImagesFromPersisted,
  isSameModel,
  partializeComposerDraftStoreState,
  PersistedComposerDraftFileAttachment,
  PersistedComposerFileAttachment,
  PersistedComposerImageAttachment,
  queuedRunEditDraftId,
  resolveComposerDraftKey,
};

const contextInsertionHandlers = new Map<string, ComposerContextInsertionHandler>();

const composerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    (setBase, get) => {
      const set = setBase;

      return {
        draftsByThreadKey: {},
        draftThreadsByThreadKey: {},
        logicalProjectDraftThreadKeyByLogicalProjectKey: {},
        backgroundSubmissionThreadKeys: {},
        promotedDraftRedirects: {},
        rewindingThreadKeys: new Set<string>(),
        stickyModelSelectionByProvider: {},
        stickyOptionsByModelByProvider: {},
        stickyActiveProvider: null,
        getComposerDraft: (target) => getComposerDraftState(get(), target),
        getDraftSessionByLogicalProjectKey: (logicalProjectKey) => {
          const normalizedLogicalProjectKey = logicalProjectDraftKey(logicalProjectKey);
          if (normalizedLogicalProjectKey.length === 0) {
            return null;
          }
          const draftId =
            get().logicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey];
          if (!draftId) {
            return null;
          }
          const draftThread = get().draftThreadsByThreadKey[draftId];
          if (!draftThread || isDraftThreadPromoting(draftThread)) {
            return null;
          }
          return toProjectDraftSession(DraftId.make(draftId), draftThread);
        },
        getDraftThreadByProjectRef: (projectRef) => {
          return get().getDraftSessionByProjectRef(projectRef);
        },
        getDraftSessionByProjectRef: (projectRef) => {
          const state = get();
          for (const draftId of Object.values(
            state.logicalProjectDraftThreadKeyByLogicalProjectKey,
          )) {
            const draftThread = state.draftThreadsByThreadKey[draftId];
            if (!draftThread || isDraftThreadPromoting(draftThread)) {
              continue;
            }
            if (
              draftThread.projectId === projectRef.projectId &&
              draftThread.environmentId === projectRef.environmentId
            ) {
              return toProjectDraftSession(DraftId.make(draftId), draftThread);
            }
          }
          for (const [draftId, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
            if (isDraftThreadPromoting(draftThread)) {
              continue;
            }
            if (
              draftThread.projectId === projectRef.projectId &&
              draftThread.environmentId === projectRef.environmentId
            ) {
              return toProjectDraftSession(DraftId.make(draftId), draftThread);
            }
          }
          return null;
        },
        getDraftSession: (draftId) => get().draftThreadsByThreadKey[draftId] ?? null,
        getDraftSessionByRef: (threadRef) => {
          for (const draftSession of Object.values(get().draftThreadsByThreadKey)) {
            if (
              draftSession.environmentId === threadRef.environmentId &&
              draftSession.threadId === threadRef.threadId
            ) {
              return draftSession;
            }
          }
          return null;
        },
        getDraftIdByRef: (threadRef) => {
          for (const [draftId, draftSession] of Object.entries(get().draftThreadsByThreadKey)) {
            if (
              draftSession.environmentId === threadRef.environmentId &&
              draftSession.threadId === threadRef.threadId
            ) {
              return DraftId.make(draftId);
            }
          }
          return null;
        },
        getPromotedDraftRedirect: (draftId) => get().promotedDraftRedirects[draftId] ?? null,
        getDraftThread: (threadRef) => {
          if (typeof threadRef === "string") {
            return get().getDraftSession(DraftId.make(threadRef));
          }
          return get().getDraftSessionByRef(threadRef);
        },
        getDraftThreadByRef: (threadRef) => {
          return get().getDraftSessionByRef(threadRef);
        },
        listDraftThreadKeys: () =>
          Object.values(get().draftThreadsByThreadKey).map((draftThread) =>
            scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
          ),
        hasDraftThreadsInEnvironment: (environmentId) =>
          Object.values(get().draftThreadsByThreadKey).some(
            (draftThread) => draftThread.environmentId === environmentId,
          ),
        setLogicalProjectDraftThreadId: (logicalProjectKey, projectRef, draftId, options) => {
          const normalizedLogicalProjectKey = logicalProjectDraftKey(logicalProjectKey);
          if (normalizedLogicalProjectKey.length === 0 || draftId.length === 0) {
            return;
          }
          set((state) => {
            const existingThread = state.draftThreadsByThreadKey[draftId];
            const previousThreadKeyForLogicalProject =
              state.logicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey];
            const nextDraftThread = createDraftThreadState(
              projectRef,
              options?.threadId ?? existingThread?.threadId ?? ThreadId.make(draftId),
              normalizedLogicalProjectKey,
              existingThread,
              options,
            );
            const hasSameLogicalMapping = previousThreadKeyForLogicalProject === draftId;
            const hasNoStaleMappingsForDraft = Object.entries(
              state.logicalProjectDraftThreadKeyByLogicalProjectKey,
            ).every(
              ([logicalKey, mappedDraftId]) =>
                mappedDraftId !== draftId || logicalKey === normalizedLogicalProjectKey,
            );
            if (
              hasSameLogicalMapping &&
              hasNoStaleMappingsForDraft &&
              draftThreadsEqual(existingThread, nextDraftThread)
            ) {
              return state;
            }
            const nextLogicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string> =
              Object.fromEntries(
                Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
                  ([logicalKey, mappedDraftId]) =>
                    mappedDraftId !== draftId || logicalKey === normalizedLogicalProjectKey,
                ),
              );
            nextLogicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey] =
              draftId;
            const nextDraftThreadsByThreadKey: Record<string, DraftThreadState> = {
              ...state.draftThreadsByThreadKey,
              [draftId]: nextDraftThread,
            };
            const existingDraft = state.draftsByThreadKey[draftId];
            let nextDraftsByThreadKey = state.draftsByThreadKey;
            if (
              existingThread &&
              existingThread.environmentId !== projectRef.environmentId &&
              existingDraft !== undefined
            ) {
              const nextDraft = clearStaleFileUploadMetadata(
                existingDraft,
                projectRef.environmentId,
              );
              if (nextDraft !== existingDraft) {
                nextDraftsByThreadKey = {
                  ...state.draftsByThreadKey,
                  [draftId]: nextDraft,
                };
              }
            }
            const previousDraftThread =
              previousThreadKeyForLogicalProject === undefined
                ? undefined
                : nextDraftThreadsByThreadKey[previousThreadKeyForLogicalProject];
            // Keep populated drafts unmapped: sidebar rows still expose them when a new draft is opened.
            if (
              previousThreadKeyForLogicalProject &&
              previousThreadKeyForLogicalProject !== draftId &&
              !isComposerThreadKeyInUse(
                nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
                previousThreadKeyForLogicalProject,
              ) &&
              !isDraftThreadPromoting(previousDraftThread) &&
              !composerDraftHasUserContent(
                state.draftsByThreadKey[previousThreadKeyForLogicalProject],
              ) &&
              !draftThreadHasOpenPreview(previousDraftThread)
            ) {
              delete nextDraftThreadsByThreadKey[previousThreadKeyForLogicalProject];
              if (state.draftsByThreadKey[previousThreadKeyForLogicalProject] !== undefined) {
                nextDraftsByThreadKey = { ...nextDraftsByThreadKey };
                delete nextDraftsByThreadKey[previousThreadKeyForLogicalProject];
              }
            }
            return {
              draftsByThreadKey: nextDraftsByThreadKey,
              draftThreadsByThreadKey: nextDraftThreadsByThreadKey,
              logicalProjectDraftThreadKeyByLogicalProjectKey:
                nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
            };
          });
        },
        setProjectDraftThreadId: (projectRef, draftId, options) => {
          get().setLogicalProjectDraftThreadId(
            projectDraftKey(projectRef),
            projectRef,
            draftId,
            options,
          );
        },
        setDraftThreadContext: (threadRef, options) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const existing = state.draftThreadsByThreadKey[threadKey];
            if (!existing) {
              return state;
            }
            const nextProjectRef = options.projectRef ?? {
              environmentId: existing.environmentId,
              projectId: existing.projectId,
            };
            if (
              nextProjectRef.projectId.length === 0 ||
              nextProjectRef.environmentId.length === 0
            ) {
              return state;
            }
            const projectChanged =
              nextProjectRef.environmentId !== existing.environmentId ||
              nextProjectRef.projectId !== existing.projectId;
            const nextWorktreePath =
              options.worktreePath === undefined
                ? projectChanged
                  ? null
                  : existing.worktreePath
                : (options.worktreePath ?? null);
            const nextBranch =
              options.branch === undefined
                ? projectChanged
                  ? null
                  : existing.branch
                : (options.branch ?? null);
            const nextStartFromOrigin =
              options.startFromOrigin === undefined
                ? existing.startFromOrigin
                : options.startFromOrigin;
            const environmentSelection =
              options.environmentSelection ??
              (options.branch != null || options.worktreePath != null
                ? "manual"
                : existing.environmentSelection);
            const checkoutPullRequest = resolveCheckoutPullRequest(
              existing,
              options.checkoutPullRequest,
              projectChanged,
            );
            const worktreeRepositories =
              options.worktreeRepositories === undefined
                ? projectChanged
                  ? undefined
                  : existing.worktreeRepositories
                : (options.worktreeRepositories ?? undefined);
            const nextDraftThread: DraftThreadState = {
              threadId: existing.threadId,
              environmentId: nextProjectRef.environmentId,
              projectId: nextProjectRef.projectId,
              logicalProjectKey: existing.logicalProjectKey,
              ...(environmentSelection ? { environmentSelection } : {}),
              loadBalancedEnvironmentId:
                options.loadBalancedEnvironmentId === undefined
                  ? projectChanged
                    ? null
                    : (existing.loadBalancedEnvironmentId ?? null)
                  : options.loadBalancedEnvironmentId,
              createdAt:
                options.createdAt === undefined
                  ? existing.createdAt
                  : options.createdAt || existing.createdAt,
              runtimeMode: options.runtimeMode ?? existing.runtimeMode,
              interactionMode: options.interactionMode ?? existing.interactionMode,
              branch: nextBranch,
              worktreePath: nextWorktreePath,
              envMode:
                options.envMode ?? (nextWorktreePath ? "worktree" : (existing.envMode ?? "local")),
              startFromOrigin: nextStartFromOrigin,
              ...(checkoutPullRequest ? { checkoutPullRequest } : {}),
              ...(worktreeRepositories ? { worktreeRepositories } : {}),
              promotedTo: existing.promotedTo ?? null,
            };
            const isUnchanged =
              nextDraftThread.environmentId === existing.environmentId &&
              nextDraftThread.projectId === existing.projectId &&
              nextDraftThread.logicalProjectKey === existing.logicalProjectKey &&
              nextDraftThread.environmentSelection === existing.environmentSelection &&
              nextDraftThread.loadBalancedEnvironmentId === existing.loadBalancedEnvironmentId &&
              nextDraftThread.createdAt === existing.createdAt &&
              nextDraftThread.runtimeMode === existing.runtimeMode &&
              nextDraftThread.interactionMode === existing.interactionMode &&
              nextDraftThread.branch === existing.branch &&
              nextDraftThread.worktreePath === existing.worktreePath &&
              nextDraftThread.envMode === existing.envMode &&
              nextDraftThread.startFromOrigin === existing.startFromOrigin &&
              checkoutPullRequestsEqual(
                nextDraftThread.checkoutPullRequest,
                existing.checkoutPullRequest,
              ) &&
              worktreeRepositoriesEqual(
                nextDraftThread.worktreeRepositories,
                existing.worktreeRepositories,
              ) &&
              scopedThreadRefsEqual(nextDraftThread.promotedTo, existing.promotedTo);
            if (isUnchanged) {
              return state;
            }
            return {
              draftThreadsByThreadKey: {
                ...state.draftThreadsByThreadKey,
                [threadKey]: nextDraftThread,
              },
            };
          });
        },
        clearProjectDraftThreadId: (projectRef) => {
          set((state) => {
            const matchingThreadKeys = Object.entries(state.draftThreadsByThreadKey)
              .filter(
                ([, draftThread]) =>
                  draftThread.projectId === projectRef.projectId &&
                  draftThread.environmentId === projectRef.environmentId,
              )
              .map(([threadKey]) => threadKey);
            if (matchingThreadKeys.length === 0) {
              return state;
            }
            let nextState = {
              draftsByThreadKey: state.draftsByThreadKey,
              draftThreadsByThreadKey: state.draftThreadsByThreadKey,
              logicalProjectDraftThreadKeyByLogicalProjectKey:
                state.logicalProjectDraftThreadKeyByLogicalProjectKey,
            };
            for (const threadKey of matchingThreadKeys) {
              nextState = removeDraftThreadReferences(nextState, threadKey);
            }
            return nextState;
          });
        },
        clearProjectDraftThreadById: (projectRef, threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const draftThread = state.draftThreadsByThreadKey[threadKey];
            if (
              !draftThread ||
              draftThread.projectId !== projectRef.projectId ||
              draftThread.environmentId !== projectRef.environmentId
            ) {
              return state;
            }
            return removeDraftThreadReferences(state, threadKey);
          });
        },
        markDraftThreadPromoting: (threadRef, promotedTo) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey) {
            return;
          }
          set((state) => {
            const existing = state.draftThreadsByThreadKey[threadKey];
            if (!existing) {
              return state;
            }
            const nextPromotedTo =
              promotedTo ?? scopeThreadRef(existing.environmentId, existing.threadId);
            if (scopedThreadRefsEqual(existing.promotedTo, nextPromotedTo)) {
              return state;
            }
            return {
              draftThreadsByThreadKey: {
                ...state.draftThreadsByThreadKey,
                [threadKey]: {
                  ...existing,
                  promotedTo: nextPromotedTo,
                },
              },
            };
          });
        },
        finalizePromotedDraftThread: (threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const existing = state.draftThreadsByThreadKey[threadKey];
            if (!existing?.promotedTo) {
              return state;
            }
            return {
              ...removeDraftThreadReferences(state, threadKey, existing.promotedTo),
              promotedDraftRedirects: {
                ...state.promotedDraftRedirects,
                [threadKey]: existing.promotedTo,
              },
            };
          });
        },
        clearDraftThread: (threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const hasDraftThread = state.draftThreadsByThreadKey[threadKey] !== undefined;
            const hasLogicalProjectMapping = Object.values(
              state.logicalProjectDraftThreadKeyByLogicalProjectKey,
            ).includes(threadKey);
            const hasComposerDraft = state.draftsByThreadKey[threadKey] !== undefined;
            if (!hasDraftThread && !hasLogicalProjectMapping && !hasComposerDraft) {
              return state;
            }
            return removeDraftThreadReferences(state, threadKey);
          });
        },
        setStickyModelSelection: (modelSelection) => {
          const normalized = normalizeModelSelection(modelSelection);
          set((state) => {
            if (!normalized) {
              return state;
            }
            const current = state.stickyModelSelectionByProvider[normalized.instanceId];
            // Model-only updates omit options; preserve sticky traits across model switches and new chats.
            const nextSelection =
              normalized.options !== undefined
                ? normalized
                : createModelSelection(normalized.instanceId, normalized.model, current?.options);
            const nextMap: Partial<Record<ProviderInstanceId, ModelSelection>> = {
              ...state.stickyModelSelectionByProvider,
              [normalized.instanceId]: nextSelection,
            };
            if (Equal.equals(state.stickyModelSelectionByProvider, nextMap)) {
              return state.stickyActiveProvider === normalized.instanceId
                ? state
                : { stickyActiveProvider: normalized.instanceId };
            }
            return {
              stickyModelSelectionByProvider: nextMap,
              stickyActiveProvider: normalized.instanceId,
            };
          });
        },
        applyStickyState: (threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const stickyMap = state.stickyModelSelectionByProvider;
            const stickyActiveProvider = state.stickyActiveProvider;
            const existing = state.draftsByThreadKey[threadKey];
            const base = existing ?? createEmptyThreadDraft();
            const nextMap = compactModelSelectionByProvider(stickyMap);
            if (
              Equal.equals(base.modelSelectionByProvider, nextMap) &&
              base.activeProvider === stickyActiveProvider &&
              base.modelSelectionExplicit === undefined
            ) {
              return state;
            }
            const { modelSelectionExplicit: _modelSelectionExplicit, ...retained } = base;
            const nextDraft: ComposerThreadDraftState = {
              ...retained,
              modelSelectionByProvider: nextMap,
              activeProvider: stickyActiveProvider,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        setPrompt: (threadRef, prompt) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey];
            if (
              existing
                ? existing.prompt === prompt && !shouldRemoveDraft(existing)
                : prompt.length === 0
            ) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...(existing ?? createEmptyThreadDraft()),
              prompt,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        setModelSelection: (threadRef, modelSelection, opts) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          const normalized = normalizeModelSelection(modelSelection);
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey];
            if (!existing && normalized === null) {
              return state;
            }
            const base = existing ?? createEmptyThreadDraft();
            const nextMap = { ...base.modelSelectionByProvider };
            if (normalized) {
              const current = nextMap[normalized.instanceId];
              if (normalized.options !== undefined || opts?.replaceOptions) {
                nextMap[normalized.instanceId] = normalized as ModelSelection;
              } else {
                nextMap[normalized.instanceId] = createModelSelection(
                  normalized.instanceId,
                  normalized.model,
                  current?.options,
                );
              }
            }
            const nextActiveProvider = normalized?.instanceId ?? base.activeProvider;
            if (
              opts?.explicit !== true &&
              Equal.equals(base.modelSelectionByProvider, nextMap) &&
              base.activeProvider === nextActiveProvider &&
              !base.modelSelectionExplicit
            ) {
              return state;
            }
            const { modelSelectionExplicit: _previousExplicit, ...restBase } = base;
            const nextDraft: ComposerThreadDraftState = {
              ...restBase,
              modelSelectionByProvider: nextMap,
              activeProvider: nextActiveProvider,
              ...(opts?.explicit === true ? { modelSelectionExplicit: true as const } : {}),
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        releaseModelSelection: (threadRef, modelSelection) => {
          const threadKey = scopedThreadKey(threadRef);
          set((state) => {
            const draft = state.draftsByThreadKey[threadKey];
            // A newer pick, even of the same model, is still waiting for its own reply.
            if (
              !draft?.activeProvider ||
              draft.modelSelectionByProvider[draft.activeProvider] !== modelSelection
            ) {
              return state;
            }
            const { modelSelectionExplicit: _explicit, ...retained } = draft;
            const next = { ...retained, activeProvider: null, modelSelectionByProvider: {} };
            const draftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(next)) delete draftsByThreadKey[threadKey];
            else draftsByThreadKey[threadKey] = next;
            return { draftsByThreadKey };
          });
        },
        setProviderModelOptions: (threadRef, provider, nextProviderOptions, options) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          const normalizedProvider = normalizeProviderDriverKind(provider);
          if (normalizedProvider === null) {
            return;
          }
          const instanceKey = options?.instanceId ?? defaultInstanceIdForDriver(normalizedProvider);
          const fallbackModel =
            normalizeCustomModelSlug(options?.model) ??
            DEFAULT_MODEL_BY_PROVIDER[normalizedProvider] ??
            DEFAULT_MODEL;
          const providerOpts =
            nextProviderOptions && nextProviderOptions.length > 0 ? nextProviderOptions : undefined;

          set((state) => {
            const existing = state.draftsByThreadKey[threadKey];
            const base = existing ?? createEmptyThreadDraft();

            const nextMap = { ...base.modelSelectionByProvider };
            // Traits apply to the model the composer shows, which on a started
            // thread is the thread's model rather than a stored seed.
            nextMap[instanceKey] = createModelSelection(
              instanceKey,
              normalizeCustomModelSlug(options?.model) ??
                nextMap[instanceKey]?.model ??
                fallbackModel,
              providerOpts,
            );

            let nextStickyMap = state.stickyModelSelectionByProvider;
            let nextOptionsByModel = state.stickyOptionsByModelByProvider;
            let nextStickyActiveProvider = state.stickyActiveProvider;
            if (options?.persistSticky === true) {
              nextStickyMap = { ...state.stickyModelSelectionByProvider };
              const stickyBase =
                nextStickyMap[instanceKey] ??
                base.modelSelectionByProvider[instanceKey] ??
                createModelSelection(instanceKey, fallbackModel);
              const rememberedModel = normalizeCustomModelSlug(options?.model) ?? stickyBase.model;
              // Traits for another shown model belong in per-model memory only;
              // the sticky selection keeps its own model's traits.
              const appliesToSticky = rememberedModel === stickyBase.model;
              if (providerOpts) {
                if (appliesToSticky) {
                  nextStickyMap[instanceKey] = createModelSelection(
                    instanceKey,
                    stickyBase.model,
                    providerOpts,
                  );
                }
                nextOptionsByModel = {
                  ...state.stickyOptionsByModelByProvider,
                  [instanceKey]: {
                    ...state.stickyOptionsByModelByProvider[instanceKey],
                    [rememberedModel]: providerOpts,
                  },
                };
              } else {
                if (appliesToSticky && (stickyBase.options?.length ?? 0) > 0) {
                  const { options: _, ...rest } = stickyBase;
                  nextStickyMap[instanceKey] = rest as ModelSelection;
                }
                const rememberedByModel = {
                  ...state.stickyOptionsByModelByProvider[instanceKey],
                };
                delete rememberedByModel[rememberedModel];
                nextOptionsByModel = {
                  ...state.stickyOptionsByModelByProvider,
                  [instanceKey]: rememberedByModel,
                };
              }
              nextStickyActiveProvider = options.instanceId
                ? instanceKey
                : (base.activeProvider ?? instanceKey);
            }

            const { modelSelectionExplicit: _previousExplicit, ...restBase } = base;
            const nextDraft: ComposerThreadDraftState = {
              ...restBase,
              ...(options?.instanceId ? { activeProvider: instanceKey } : {}),
              modelSelectionByProvider: nextMap,
              modelSelectionExplicit: true,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }

            return {
              draftsByThreadKey: nextDraftsByThreadKey,
              ...(options?.persistSticky === true
                ? {
                    stickyModelSelectionByProvider: nextStickyMap,
                    stickyOptionsByModelByProvider: nextOptionsByModel,
                    stickyActiveProvider: nextStickyActiveProvider,
                  }
                : {}),
            };
          });
        },
        setRuntimeMode: (threadRef, runtimeMode) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          const nextRuntimeMode = isRuntimeMode(runtimeMode) ? runtimeMode : null;
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey];
            if (!existing && nextRuntimeMode === null) {
              return state;
            }
            const base = existing ?? createEmptyThreadDraft();
            if (base.runtimeMode === nextRuntimeMode) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...base,
              runtimeMode: nextRuntimeMode,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        setInteractionMode: (threadRef, interactionMode) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          const nextInteractionMode =
            interactionMode === "plan" || interactionMode === "default" ? interactionMode : null;
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey];
            if (!existing && nextInteractionMode === null) {
              return state;
            }
            const base = existing ?? createEmptyThreadDraft();
            if (base.interactionMode === nextInteractionMode) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...base,
              interactionMode: nextInteractionMode,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        ...createComposerContextActions(set, get, contextInsertionHandlers),
      };
    },
    {
      name: COMPOSER_DRAFT_STORAGE_KEY,
      version: COMPOSER_DRAFT_STORAGE_VERSION,
      storage: composerPersistStorage,
      migrate: migratePersistedComposerDraftStoreState,
      partialize: (state): ComposerPersistState => ({ capturedState: state }),
      merge: mergePersistedComposerDraftStoreState,
    },
  ),
);

setComposerDraftLoadedState(composerDraftStore.getState());

export const useComposerDraftStore = composerDraftStore;

/** Where a draft lives now: its thread once promoted, or null once it was discarded. */
export function resolveLiveComposerDraftTarget(
  target: ComposerThreadTarget,
): ComposerThreadTarget | null {
  if (typeof target !== "string") return target;
  const state = composerDraftStore.getState();
  const promoted = state.promotedDraftRedirects[target];
  if (promoted) return promoted;
  return state.draftThreadsByThreadKey[target] || state.draftsByThreadKey[target] ? target : null;
}

/** The stored prompt for a target, empty when it has no draft, or null when the target is gone. */
export function readComposerDraftPrompt(target: ComposerThreadTarget): string | null {
  const live = resolveLiveComposerDraftTarget(target);
  if (live === null) return null;
  const state = composerDraftStore.getState();
  const threadKey = resolveComposerDraftKey(state, live);
  if (!threadKey) return null;
  return state.draftsByThreadKey[threadKey]?.prompt ?? "";
}

function draftModelPickChanged(
  previousDraft: ComposerThreadDraftState | undefined,
  nextDraft: ComposerThreadDraftState | undefined,
): boolean {
  if (previousDraft === nextDraft) return false;
  const previousProvider = previousDraft?.activeProvider ?? null;
  const nextProvider = nextDraft?.activeProvider ?? null;
  if (previousProvider !== nextProvider) return true;
  if (nextProvider === null) return false;
  return (
    previousDraft?.modelSelectionByProvider[nextProvider] !==
    nextDraft?.modelSelectionByProvider[nextProvider]
  );
}

function modelReconciliationSlicesChanged(
  previous: ComposerDraftStoreState,
  next: ComposerDraftStoreState,
): boolean {
  if (previous.draftThreadsByThreadKey !== next.draftThreadsByThreadKey) return true;
  if (previous.draftsByThreadKey === next.draftsByThreadKey) return false;
  for (const [key, nextDraft] of Object.entries(next.draftsByThreadKey)) {
    if (draftModelPickChanged(previous.draftsByThreadKey[key], nextDraft)) return true;
  }
  for (const [key, previousDraft] of Object.entries(previous.draftsByThreadKey)) {
    if (!(key in next.draftsByThreadKey) && draftModelPickChanged(previousDraft, undefined)) {
      return true;
    }
  }
  return false;
}

type ReconciliationModelPick = readonly [string, ProviderInstanceId, ModelSelection];

function extractReconciliationModelPicks(
  state: ComposerDraftStoreState,
): ReadonlyArray<ReconciliationModelPick> {
  const picks: ReconciliationModelPick[] = [];
  for (const [key, draft] of Object.entries(state.draftsByThreadKey)) {
    // Local drafts can materialize a shell before their first turn is submitted.
    if (state.draftThreadsByThreadKey[key] || draft.activeProvider === null) continue;
    const pick = draft.modelSelectionByProvider[draft.activeProvider];
    if (pick) picks.push([key, draft.activeProvider, pick]);
  }
  return picks;
}

function sameReconciliationModelPicks(
  left: ReadonlyArray<ReconciliationModelPick>,
  right: ReadonlyArray<ReconciliationModelPick>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      ([key, provider, pick], index) =>
        right[index]![0] === key && right[index]![1] === provider && right[index]![2] === pick,
    )
  );
}

export function subscribeComposerDraftModelReconciliation(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly threadRefsAtom: Atom.Atom<ReadonlyArray<ScopedThreadRef>>;
  readonly threadShellAtom: (ref: ScopedThreadRef) => Atom.Atom<EnvironmentThreadShell | null>;
  readonly shellStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentShellState, unknown>>;
  readonly pendingThreadIdsAtom: (environmentId: EnvironmentId) => Atom.Atom<ReadonlySet<ThreadId>>;
}): () => void {
  // Only model-reconciliation slices: prompt edits replace draftsByThreadKey on every keystroke.
  let currentPicks = extractReconciliationModelPicks(composerDraftStore.getState());
  const draftsAtom = Atom.make(currentPicks);
  const unsubscribeDrafts = composerDraftStore.subscribe((state, previous) => {
    if (!modelReconciliationSlicesChanged(previous, state)) return;
    const nextPicks = extractReconciliationModelPicks(state);
    if (sameReconciliationModelPicks(currentPicks, nextPicks)) return;
    currentPicks = nextPicks;
    input.registry.set(draftsAtom, nextPicks);
  });
  const threadKeysAtom = Atom.map(
    input.threadRefsAtom,
    (refs) => new Set(refs.map(scopedThreadKey)),
  );
  const matchesAtom = Atom.make((get) => {
    const picks = get(draftsAtom);
    const threadKeys = get(threadKeysAtom);
    const matches: ReconciliationModelPick[] = [];
    for (const [key, activeProvider, pick] of picks) {
      const ref = parseScopedThreadKey(key);
      if (!ref || !threadKeys.has(key)) continue;
      const thread = get(input.threadShellAtom(ref));
      if (!thread || !draftModelPickMatchesThread(pick, thread.modelSelection)) continue;
      // The pick can match an old model while an earlier pick in flight still replaces it.
      if (get(input.pendingThreadIdsAtom(ref.environmentId)).has(ref.threadId)) continue;
      // Status and selection must come from the same emission; derived atoms can update apart.
      const shell = AsyncResult.getOrElse(get(input.shellStateAtom(ref.environmentId)), () => null);
      if (shell?.status !== "live") continue;
      const authoritativeThread = Option.getOrNull(shell.snapshot)?.threads.find(
        (candidate) => candidate.id === ref.threadId,
      );
      if (
        authoritativeThread &&
        draftModelPickMatchesThread(pick, authoritativeThread.modelSelection)
      ) {
        matches.push([key, activeProvider, pick]);
      }
    }
    return matches;
  });
  const unsubscribeMatches = input.registry.subscribe(
    matchesAtom,
    (matches) => {
      if (matches.length === 0) return;
      composerDraftStore.setState((state) => {
        let drafts: Record<string, ComposerThreadDraftState> | null = null;
        for (const [key, matchedProvider, matchedPick] of matches) {
          const current = (drafts ?? state.draftsByThreadKey)[key];
          if (
            !current ||
            state.draftThreadsByThreadKey[key] ||
            current.activeProvider !== matchedProvider ||
            current.modelSelectionByProvider[matchedProvider] !== matchedPick
          ) {
            continue;
          }
          drafts ??= { ...state.draftsByThreadKey };
          const { modelSelectionExplicit: _explicit, ...retained } = current;
          const draft = { ...retained, activeProvider: null, modelSelectionByProvider: {} };
          if (shouldRemoveDraft(draft)) delete drafts[key];
          else drafts[key] = draft;
        }
        return drafts ? { draftsByThreadKey: drafts } : state;
      });
    },
    { immediate: true },
  );
  return () => {
    unsubscribeMatches();
    unsubscribeDrafts();
  };
}

export function beginBackgroundDraftSubmissionByRef(threadRef: ScopedThreadRef): void {
  const threadKey = scopedThreadKey(threadRef);
  useComposerDraftStore.setState((state) => ({
    backgroundSubmissionThreadKeys: { ...state.backgroundSubmissionThreadKeys, [threadKey]: true },
  }));
}

export function clearBackgroundDraftSubmissionByRef(threadRef: ScopedThreadRef): void {
  const threadKey = scopedThreadKey(threadRef);
  useComposerDraftStore.setState((state) => {
    if (!state.backgroundSubmissionThreadKeys[threadKey]) {
      return state;
    }
    const backgroundSubmissionThreadKeys = { ...state.backgroundSubmissionThreadKeys };
    delete backgroundSubmissionThreadKeys[threadKey];
    return { backgroundSubmissionThreadKeys };
  });
}

export function clearComposerDraftsEnvironment(environmentId: EnvironmentId): void {
  useComposerDraftStore.setState((state) => {
    const removedThreadKeys = new Set<string>();

    for (const [threadKey, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
      if (draftThread.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }
    for (const threadKey of Object.keys(state.draftsByThreadKey)) {
      if (parseScopedThreadKey(threadKey)?.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }
    for (const [logicalProjectKey, threadKey] of Object.entries(
      state.logicalProjectDraftThreadKeyByLogicalProjectKey,
    )) {
      if (parseScopedProjectKey(logicalProjectKey)?.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }

    const nextLogicalMappings = Object.fromEntries(
      Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
        ([logicalProjectKey, threadKey]) =>
          parseScopedProjectKey(logicalProjectKey)?.environmentId !== environmentId &&
          !removedThreadKeys.has(threadKey),
      ),
    ) as Record<string, string>;
    const nextDraftThreads = Object.fromEntries(
      Object.entries(state.draftThreadsByThreadKey).filter(
        ([threadKey, draftThread]) =>
          draftThread.environmentId !== environmentId && !removedThreadKeys.has(threadKey),
      ),
    ) as Record<string, DraftThreadState>;
    const nextDrafts = Object.fromEntries(
      Object.entries(state.draftsByThreadKey).filter(([threadKey, draft]) => {
        if (!removedThreadKeys.has(threadKey)) {
          return true;
        }
        revokeDraftThreadPreviewUrls(draft);
        return false;
      }),
    ) as Record<string, ComposerThreadDraftState>;
    const nextBackgroundSubmissionThreadKeys = Object.fromEntries(
      Object.entries(state.backgroundSubmissionThreadKeys).filter(
        ([threadKey]) => parseScopedThreadKey(threadKey)?.environmentId !== environmentId,
      ),
    ) as Record<string, true>;
    const nextPromotedDraftRedirects = Object.fromEntries(
      Object.entries(state.promotedDraftRedirects).filter(
        ([, promotedTo]) => promotedTo.environmentId !== environmentId,
      ),
    ) as Record<string, ScopedThreadRef>;

    return {
      draftsByThreadKey: nextDrafts,
      draftThreadsByThreadKey: nextDraftThreads,
      logicalProjectDraftThreadKeyByLogicalProjectKey: nextLogicalMappings,
      backgroundSubmissionThreadKeys: nextBackgroundSubmissionThreadKeys,
      promotedDraftRedirects: nextPromotedDraftRedirects,
      rewindingThreadKeys: new Set(
        [...state.rewindingThreadKeys].filter(
          (threadKey) => parseScopedThreadKey(threadKey)?.environmentId !== environmentId,
        ),
      ),
    };
  });
  composerDebouncedStorage.flush();
}

export function useComposerThreadDraft(threadRef: ComposerThreadTarget): ComposerThreadDraftState {
  return useComposerDraftStore((state) => {
    return getComposerDraftState(state, threadRef) ?? EMPTY_THREAD_DRAFT;
  });
}

export function useThreadHasUnsentDraft(threadRef: ScopedThreadRef): boolean {
  return useComposerDraftStore((state) =>
    composerDraftHasUserContent(getComposerDraftState(state, threadRef)),
  );
}

export function useComposerDraftModelState(
  threadRef: ComposerThreadTarget,
): ComposerDraftModelState {
  return useComposerDraftStore(
    useShallow((state) => {
      const draft = getComposerDraftState(state, threadRef);
      return draft
        ? {
            activeProvider: draft.activeProvider,
            modelSelectionByProvider: draft.modelSelectionByProvider,
            modelSelectionExplicit: draft.modelSelectionExplicit === true,
          }
        : EMPTY_COMPOSER_DRAFT_MODEL_STATE;
    }),
  );
}

/** Threads a sent draft is launching into: from their shell's arrival until the server owns the send. */
export function usePromotingDraftThreadKeys(): ReadonlyArray<string> {
  return useComposerDraftStore(
    useShallow((state) =>
      Object.values(state.draftThreadsByThreadKey).flatMap((draft) =>
        draft.promotedTo ? [scopedThreadKey(draft.promotedTo)] : [],
      ),
    ),
  );
}

export function markPromotedDraftThreadByRef(threadRef: ScopedThreadRef): void {
  const draftStore = useComposerDraftStore.getState();
  for (const [draftId, draftThread] of Object.entries(draftStore.draftThreadsByThreadKey)) {
    if (
      draftThread.environmentId === threadRef.environmentId &&
      draftThread.threadId === threadRef.threadId
    ) {
      draftStore.markDraftThreadPromoting(DraftId.make(draftId), threadRef);
    }
  }
}

export function restoreFailedDraftThread(
  draftId: DraftId,
  draftThread: DraftThreadState,
  threadId: ThreadId,
): void {
  useComposerDraftStore.setState((state) => ({
    draftThreadsByThreadKey: {
      ...state.draftThreadsByThreadKey,
      [draftId]: {
        ...(state.draftThreadsByThreadKey[draftId] ?? draftThread),
        threadId,
        ...(threadId !== draftThread.threadId ? { createdAt: new Date().toISOString() } : {}),
        promotedTo: null,
      },
    },
  }));
}

export function finalizePromotedDraftThreadByRef(threadRef: ScopedThreadRef): void {
  const draftStore = useComposerDraftStore.getState();
  for (const [draftId, draftThread] of Object.entries(draftStore.draftThreadsByThreadKey)) {
    const promotedRef = draftThread.promotedTo;
    const matches = promotedRef
      ? promotedRef.environmentId === threadRef.environmentId &&
        promotedRef.threadId === threadRef.threadId
      : draftThread.environmentId === threadRef.environmentId &&
        draftThread.threadId === threadRef.threadId;
    if (matches) {
      const target = DraftId.make(draftId);
      draftStore.markDraftThreadPromoting(target, threadRef);
      draftStore.finalizePromotedDraftThread(target);
    }
  }
  clearBackgroundDraftSubmissionByRef(threadRef);
}

type DraftPromotionShell = Pick<EnvironmentThreadShell, "latestRun" | "latestUserMessageAt">;

/** The server owns a draft's send once its message persisted or its run started or stopped. */
export function resolveDraftPromotionNavigationTarget(input: {
  serverThreadRef: ScopedThreadRef | null;
  serverThread: DraftPromotionShell | null | undefined;
  backgroundSubmissionPending: boolean;
}): ScopedThreadRef | null {
  if (input.backgroundSubmissionPending) {
    return null;
  }
  const latestRun = input.serverThread?.latestRun ?? null;
  const runStarted = latestRun?.startedAt != null;
  const startupStopped =
    latestRun?.status === "failed" ||
    latestRun?.status === "interrupted" ||
    latestRun?.status === "cancelled";
  const messagePersisted = input.serverThread?.latestUserMessageAt != null;
  return runStarted || startupStopped || messagePersisted ? input.serverThreadRef : null;
}

/**
 * Drives every draft through promotion as server shells arrive: a draft whose reserved thread
 * appears on the server becomes promoting, and once the server owns its send (and any hero
 * transition has played) it finalizes into that thread. The draft route follows the redirect
 * that finalization records, so no route has to watch for these milestones.
 */
export function subscribeDraftThreadPromotion(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly threadRefsAtom: Atom.Atom<ReadonlyArray<ScopedThreadRef>>;
  readonly threadShellAtom: (ref: ScopedThreadRef) => Atom.Atom<DraftPromotionShell | null>;
}): () => void {
  // Only the promotion slices: prompt edits replace the store state on every keystroke.
  const promotionSlices = (state: ComposerDraftStoreState) => ({
    draftThreadsByThreadKey: state.draftThreadsByThreadKey,
    backgroundSubmissionThreadKeys: state.backgroundSubmissionThreadKeys,
  });
  const draftsAtom = Atom.make(promotionSlices(composerDraftStore.getState()));
  const unsubscribeDrafts = composerDraftStore.subscribe((state, previous) => {
    if (
      state.draftThreadsByThreadKey === previous.draftThreadsByThreadKey &&
      state.backgroundSubmissionThreadKeys === previous.backgroundSubmissionThreadKeys
    ) {
      return;
    }
    input.registry.set(draftsAtom, promotionSlices(state));
  });
  const threadKeysAtom = Atom.map(
    input.threadRefsAtom,
    (refs) => new Set(refs.map(scopedThreadKey)),
  );
  const milestonesAtom = Atom.make((get) => {
    const state = get(draftsAtom);
    const threadKeys = get(threadKeysAtom);
    const arrived: Array<readonly [DraftId, ScopedThreadRef]> = [];
    const owned: Array<readonly [DraftId, ScopedThreadRef]> = [];
    for (const [draftId, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
      const ref =
        draftThread.promotedTo ?? scopeThreadRef(draftThread.environmentId, draftThread.threadId);
      const threadKey = scopedThreadKey(ref);
      if (!threadKeys.has(threadKey)) continue;
      if (!draftThread.promotedTo) {
        arrived.push([DraftId.make(draftId), ref]);
        continue;
      }
      const target = resolveDraftPromotionNavigationTarget({
        serverThreadRef: ref,
        serverThread: get(input.threadShellAtom(ref)),
        backgroundSubmissionPending: state.backgroundSubmissionThreadKeys[threadKey] === true,
      });
      if (target) owned.push([DraftId.make(draftId), target]);
    }
    return { arrived, owned };
  });
  let disposed = false;
  const finalizing = new Set<DraftId>();
  const unsubscribeMilestones = input.registry.subscribe(
    milestonesAtom,
    ({ arrived, owned }) => {
      const store = composerDraftStore.getState();
      for (const [draftId, ref] of arrived) {
        store.markDraftThreadPromoting(draftId, ref);
      }
      for (const [draftId, ref] of owned) {
        if (finalizing.has(draftId)) continue;
        finalizing.add(draftId);
        void waitForDraftHeroTransition().then(() => {
          finalizing.delete(draftId);
          if (disposed) return;
          const current = composerDraftStore.getState().draftThreadsByThreadKey[draftId];
          if (!current || !scopedThreadRefsEqual(current.promotedTo, ref)) return;
          finalizePromotedDraftThreadByRef(ref);
        });
      }
    },
    { immediate: true },
  );
  return () => {
    disposed = true;
    unsubscribeMilestones();
    unsubscribeDrafts();
  };
}
