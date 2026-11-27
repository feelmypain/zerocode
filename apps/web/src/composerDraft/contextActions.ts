import { parseScopedThreadKey } from "@zerocode/client-runtime/environment";
import {
  type PreviewAnnotationPayload,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@zerocode/contracts";
import {
  replaceComposerContextReferences,
  toKindScopedComposerContextId,
} from "@zerocode/shared/composerContextReferences";
import { composerImageDedupKey } from "../components/chat/composerAttachmentFiles";
import {
  environmentContextReference,
  fileContextReference,
  previewAnnotationContextId,
  previewAnnotationContextReference,
  reviewCommentContextId,
  reviewCommentContextReference,
  terminalContextReference,
  threadContextReference,
} from "../lib/composerContextRecords";
import {
  appendInlineContextReference,
  ensureInlineContextReferences,
  formatInlineContextReference,
  removeInlineContextReference,
} from "../lib/composerContextReferences";
import {
  clearStaleFileUploadMetadata,
  composerFileDedupKey,
  composerFileMatchesReattachMarker,
  normalizeTerminalContextForThread,
  normalizeTerminalContextsForThread,
  resolveComposerDraftKey,
  resolveComposerThreadId,
  revokeObjectPreviewUrl,
  terminalContextDedupKey,
} from "./contextHelpers";
import { verifyPersistedAttachments } from "./persistence";
import {
  type ComposerContextInsertionHandler,
  composerDraftContent,
  composerDraftHasUserContent,
  type ComposerDraftStoreGet,
  type ComposerDraftStoreSet,
  type ComposerDraftStoreState,
  type ComposerFileAttachment,
  composerFileNeedsReattach,
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
  createEmptyThreadDraft,
  DraftId,
  isEnvironmentContextRecord,
  isReviewCommentContext,
  isThreadContextRecord,
  shouldRemoveDraft,
} from "./types";

type ComposerContextActionKeys =
  | "setTerminalContexts"
  | "addImage"
  | "addImages"
  | "removeImage"
  | "addFiles"
  | "removeFile"
  | "setFileUpload"
  | "markFileUploadMissing"
  | "insertTerminalContext"
  | "addTerminalContexts"
  | "removeTerminalContext"
  | "clearTerminalContexts"
  | "addPreviewAnnotation"
  | "setPreviewAnnotations"
  | "removePreviewAnnotation"
  | "setReplyTo"
  | "addReviewComment"
  | "setContextInsertionHandler"
  | "setReviewComments"
  | "removeReviewComment"
  | "addThreadContexts"
  | "setThreadContexts"
  | "addEnvironmentContexts"
  | "setEnvironmentContexts"
  | "clearPersistedAttachments"
  | "syncPersistedAttachments"
  | "appendPersistedAttachments"
  | "clearComposerContent"
  | "clearComposerPromptAndImages"
  | "moveComposerContent";

export function createComposerContextActions(
  set: ComposerDraftStoreSet,
  get: ComposerDraftStoreGet,
  contextInsertionHandlers: Map<string, ComposerContextInsertionHandler>,
): Pick<ComposerDraftStoreState, ComposerContextActionKeys> {
  return {
    setTerminalContexts: (threadRef, contexts) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      const threadId = resolveComposerThreadId(get(), threadRef);
      if (!threadKey || !threadId) {
        return;
      }
      const normalizedContexts = normalizeTerminalContextsForThread(threadId, contexts);
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt: ensureInlineContextReferences(
            existing.terminalContexts
              .filter((context) => !normalizedContexts.some((next) => next.id === context.id))
              .reduce(
                (prompt, context) =>
                  removeInlineContextReference(prompt, terminalContextReference(context).contextId)
                    .prompt,
                existing.prompt,
              ),
            normalizedContexts.map(terminalContextReference),
          ),
          terminalContexts: normalizedContexts,
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
    addImage: (threadRef, image) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      const threadId = resolveComposerThreadId(get(), threadRef);
      if (!threadKey || !threadId) {
        return false;
      }
      const acceptedIds = get().addImages(
        typeof threadRef === "string" ? DraftId.make(threadKey) : threadRef,
        [image],
      );
      return acceptedIds.includes(image.id);
    },
    addImages: (threadRef, images, options) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0 || images.length === 0) {
        return [];
      }
      let acceptedIds: string[] = [];
      const capacityRejections: ComposerImageAttachment[] = [];
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const existingIds = new Set(existing.images.map((image) => image.id));
        const existingDedupKeys = new Set(
          existing.images.map((image) => composerImageDedupKey(image)),
        );
        const acceptedPreviewUrls = new Set(existing.images.map((image) => image.previewUrl));
        const dedupedIncoming: ComposerImageAttachment[] = [];
        for (const image of images) {
          const dedupKey = composerImageDedupKey(image);
          if (
            existingIds.has(image.id) ||
            (!options?.allowDuplicates && existingDedupKeys.has(dedupKey))
          ) {
            // Avoid revoking a blob URL that's still referenced by an accepted image.
            if (!acceptedPreviewUrls.has(image.previewUrl)) {
              revokeObjectPreviewUrl(image.previewUrl);
            }
            continue;
          }
          if (
            existing.images.length + existing.files.length + dedupedIncoming.length >=
            PROVIDER_SEND_TURN_MAX_ATTACHMENTS
          ) {
            capacityRejections.push(image);
            if (!acceptedPreviewUrls.has(image.previewUrl)) {
              revokeObjectPreviewUrl(image.previewUrl);
            }
            continue;
          }
          dedupedIncoming.push(image);
          existingIds.add(image.id);
          existingDedupKeys.add(dedupKey);
          acceptedPreviewUrls.add(image.previewUrl);
        }
        if (dedupedIncoming.length === 0) {
          return state;
        }
        acceptedIds = dedupedIncoming.map((image) => image.id);
        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: {
              ...existing,
              images: [...existing.images, ...dedupedIncoming],
            },
          },
        };
      });
      capacityRejections.forEach((image) => options?.onCapacityExceeded?.(image));
      return acceptedIds;
    },
    removeImage: (threadRef, imageId) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      const existing = get().draftsByThreadKey[threadKey];
      if (!existing) {
        return;
      }
      const removedImage = existing.images.find((image) => image.id === imageId);
      if (removedImage) {
        revokeObjectPreviewUrl(removedImage.previewUrl);
      }
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          prompt: removeInlineContextReference(
            current.prompt,
            toKindScopedComposerContextId("image", imageId),
          ).prompt,
          images: current.images.filter((image) => image.id !== imageId),
          nonPersistedImageIds: current.nonPersistedImageIds.filter((id) => id !== imageId),
          persistedAttachments: current.persistedAttachments.filter(
            (attachment) => attachment.id !== imageId,
          ),
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
    addFiles: (threadRef, files, options) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0 || files.length === 0) {
        return [];
      }
      let acceptedIds: string[] = [];
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const knownIds = new Set(existing.files.map((file) => file.id));
        const knownFiles = new Map<string, ComposerFileAttachment>(
          existing.files.map((file) => [composerFileDedupKey(file), file]),
        );
        const accepted: ComposerFileAttachment[] = [];
        const replacements = new Map<string, ComposerFileAttachment>();
        for (const file of files) {
          const key = composerFileDedupKey(file);
          if (knownIds.has(file.id)) {
            continue;
          }
          const duplicate = options?.allowDuplicates
            ? undefined
            : (knownFiles.get(key) ??
              existing.files.find(
                (candidate) =>
                  composerFileNeedsReattach(candidate) &&
                  !replacements.has(candidate.id) &&
                  composerFileMatchesReattachMarker(candidate, file),
              ));
          if (duplicate) {
            if (composerFileNeedsReattach(duplicate) && !replacements.has(duplicate.id)) {
              replacements.set(duplicate.id, file);
              knownIds.add(file.id);
              knownFiles.set(key, file);
            }
            continue;
          }
          if (
            existing.images.length + existing.files.length + accepted.length >=
            PROVIDER_SEND_TURN_MAX_ATTACHMENTS
          ) {
            break;
          }
          accepted.push(file);
          knownIds.add(file.id);
          knownFiles.set(key, file);
        }
        if (accepted.length === 0 && replacements.size === 0) {
          return state;
        }
        acceptedIds = accepted.map((file) => file.id);
        const retained = existing.files.map((file) => replacements.get(file.id) ?? file);
        const prompt =
          replacements.size === 0
            ? existing.prompt
            : replaceComposerContextReferences(existing.prompt, (occurrence) => {
                const original = existing.files.find(
                  (file) => fileContextReference(file).contextId === occurrence.contextId,
                );
                const replacement = original ? replacements.get(original.id) : undefined;
                return replacement
                  ? formatInlineContextReference(fileContextReference(replacement))
                  : occurrence.source;
              });
        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: {
              ...existing,
              prompt: options?.appendReference
                ? ensureInlineContextReferences(
                    prompt,
                    [...accepted, ...replacements.values()].map(fileContextReference),
                  )
                : prompt,
              files: [...retained, ...accepted],
            },
          },
        };
      });
      return acceptedIds;
    },
    removeFile: (threadRef, fileId) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];
        if (!current?.files.some((file) => file.id === fileId)) {
          return state;
        }
        const nextDraft = {
          ...current,
          prompt: removeInlineContextReference(
            current.prompt,
            toKindScopedComposerContextId("file", fileId),
          ).prompt,
          files: current.files.filter((file) => file.id !== fileId),
        } satisfies ComposerThreadDraftState;
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    setFileUpload: (threadRef, fileId, environmentId, attachmentId) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];
        const file = current?.files.find((entry) => entry.id === fileId);
        if (
          !current ||
          !file ||
          (file.uploadEnvironmentId === environmentId && file.uploadedAttachmentId === attachmentId)
        ) {
          return state;
        }
        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: {
              ...current,
              files: current.files.map((entry) =>
                entry.id === fileId
                  ? {
                      ...entry,
                      uploadedAttachmentId: attachmentId,
                      uploadEnvironmentId: environmentId,
                    }
                  : entry,
              ),
            },
          },
        };
      });
    },
    markFileUploadMissing: (threadRef, fileId, environmentId, attachmentId) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return false;
      }
      let markedMissing = false;
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];
        const file = current?.files.find((entry) => entry.id === fileId);
        if (
          !current ||
          !file ||
          file.file !== null ||
          file.uploadEnvironmentId !== environmentId ||
          file.uploadedAttachmentId !== attachmentId
        ) {
          return state;
        }
        markedMissing = true;
        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: {
              ...current,
              files: current.files.map((entry) => {
                if (entry.id !== fileId) {
                  return entry;
                }
                const marker = { ...entry };
                delete marker.uploadedAttachmentId;
                delete marker.uploadEnvironmentId;
                return marker;
              }),
            },
          },
        };
      });
      return markedMissing;
    },
    insertTerminalContext: (threadRef, prompt, context, index) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      const threadId = resolveComposerThreadId(get(), threadRef);
      if (!threadKey || !threadId) {
        return false;
      }
      let inserted = false;
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const normalizedContext = normalizeTerminalContextForThread(threadId, context);
        if (!normalizedContext) {
          return state;
        }
        const dedupKey = terminalContextDedupKey(normalizedContext);
        if (
          existing.terminalContexts.some((entry) => entry.id === normalizedContext.id) ||
          existing.terminalContexts.some((entry) => terminalContextDedupKey(entry) === dedupKey)
        ) {
          return state;
        }
        inserted = true;
        const boundedIndex = Math.max(0, Math.min(existing.terminalContexts.length, index));
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt,
          terminalContexts: [
            ...existing.terminalContexts.slice(0, boundedIndex),
            normalizedContext,
            ...existing.terminalContexts.slice(boundedIndex),
          ],
        };
        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: nextDraft,
          },
        };
      });
      return inserted;
    },
    addTerminalContexts: (threadRef, contexts, options) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      const threadId = resolveComposerThreadId(get(), threadRef);
      if (!threadKey || !threadId || contexts.length === 0) {
        return;
      }
      const currentContexts = get().draftsByThreadKey[threadKey]?.terminalContexts ?? [];
      const incoming = normalizeTerminalContextsForThread(threadId, [
        ...currentContexts,
        ...contexts,
      ]).slice(currentContexts.length);
      if (incoming.length === 0) return;
      const placedAtCaret =
        options?.appendReference !== false &&
        options?.insertAtCaret !== false &&
        (contextInsertionHandlers.get(threadKey)?.(incoming.map(terminalContextReference)) ??
          false);
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const acceptedContexts = normalizeTerminalContextsForThread(threadId, [
          ...existing.terminalContexts,
          ...contexts,
        ]).slice(existing.terminalContexts.length);
        if (acceptedContexts.length === 0) {
          return state;
        }
        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: {
              ...existing,
              prompt:
                placedAtCaret || options?.appendReference === false
                  ? existing.prompt
                  : ensureInlineContextReferences(
                      existing.prompt,
                      [...existing.terminalContexts, ...acceptedContexts].map(
                        terminalContextReference,
                      ),
                    ),
              terminalContexts: [...existing.terminalContexts, ...acceptedContexts],
            },
          },
        };
      });
    },
    removeTerminalContext: (threadRef, contextId) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0 || contextId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          prompt: removeInlineContextReference(
            current.prompt,
            toKindScopedComposerContextId("terminal", contextId),
          ).prompt,
          terminalContexts: current.terminalContexts.filter((context) => context.id !== contextId),
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
    clearTerminalContexts: (threadRef) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];
        if (!current || current.terminalContexts.length === 0) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          prompt: current.terminalContexts.reduce(
            (prompt, context) =>
              removeInlineContextReference(prompt, terminalContextReference(context).contextId)
                .prompt,
            current.prompt,
          ),
          terminalContexts: [],
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
    addPreviewAnnotation: (threadRef, annotation, options) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey) return;
      const compactAnnotation: PreviewAnnotationPayload = {
        ...annotation,
        screenshot: annotation.screenshot ? { ...annotation.screenshot, dataUrl: "" } : null,
      };
      const reference = previewAnnotationContextReference(compactAnnotation);
      const current = get().draftsByThreadKey[threadKey];
      const alreadyPresent =
        current?.previewAnnotations.some((entry) => entry.id === annotation.id) ?? false;
      // The handler calls setPrompt; running it inside the updater would overwrite the inserted reference.
      const placedAtCaret =
        !alreadyPresent &&
        options?.appendReference !== false &&
        options?.insertAtCaret !== false &&
        (contextInsertionHandlers.get(threadKey)?.([reference]) ?? false);
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const nextAnnotations = existing.previewAnnotations.filter(
          (entry) => entry.id !== annotation.id,
        );
        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: {
              ...existing,
              prompt:
                alreadyPresent || placedAtCaret || options?.appendReference === false
                  ? existing.prompt
                  : appendInlineContextReference(existing.prompt, reference),
              previewAnnotations: [...nextAnnotations, compactAnnotation],
            },
          },
        };
      });
    },
    setPreviewAnnotations: (threadRef, annotations) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey) return;
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const retainedIds = new Set(annotations.map((annotation) => annotation.id));
        let prompt = existing.prompt;
        for (const previous of existing.previewAnnotations) {
          if (retainedIds.has(previous.id)) continue;
          prompt = removeInlineContextReference(
            prompt,
            previewAnnotationContextId(previous.id),
          ).prompt;
        }
        prompt = ensureInlineContextReferences(
          prompt,
          annotations.map(previewAnnotationContextReference),
        );
        const nextDraft = { ...existing, prompt, previewAnnotations: [...annotations] };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
        else nextDraftsByThreadKey[threadKey] = nextDraft;
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    setReplyTo: (threadRef, response) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey) return;
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const nextDraft = { ...existing, replyTo: response };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
        else nextDraftsByThreadKey[threadKey] = nextDraft;
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    removePreviewAnnotation: (threadRef, annotationId) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey || !annotationId) return;
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];
        if (!current) return state;
        const previewAnnotations = current.previewAnnotations.filter(
          (entry) => entry.id !== annotationId,
        );
        if (previewAnnotations.length === current.previewAnnotations.length) return state;
        const nextDraft = {
          ...current,
          prompt: removeInlineContextReference(
            current.prompt,
            previewAnnotationContextId(annotationId),
          ).prompt,
          previewAnnotations,
          images: current.images.filter((image) => image.id !== annotationId),
          persistedAttachments: current.persistedAttachments.filter(
            (image) => image.id !== annotationId,
          ),
          nonPersistedImageIds: current.nonPersistedImageIds.filter(
            (imageId) => imageId !== annotationId,
          ),
        };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
        else nextDraftsByThreadKey[threadKey] = nextDraft;
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    addReviewComment: (threadRef, comment, options) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey || !isReviewCommentContext(comment)) return;
      const reference = reviewCommentContextReference(comment);
      const current = get().draftsByThreadKey[threadKey];
      const alreadyPresent =
        current?.reviewComments.some((entry) => entry.id === comment.id) ?? false;
      const shouldPlaceReference =
        options?.appendReference !== false &&
        (!alreadyPresent || options?.allowDuplicateReference === true);
      // Editor insertion must finish before this update reads the draft it extends.
      const placedAtCaret =
        shouldPlaceReference &&
        options?.insertAtCaret !== false &&
        (contextInsertionHandlers.get(threadKey)?.([reference]) ?? false);
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const reviewComments = existing.reviewComments.filter((entry) => entry.id !== comment.id);
        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: {
              ...existing,
              prompt:
                !shouldPlaceReference || placedAtCaret
                  ? existing.prompt
                  : appendInlineContextReference(existing.prompt, reference),
              reviewComments: [...reviewComments, { ...comment }],
            },
          },
        };
      });
    },
    setContextInsertionHandler: (threadRef, handler) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey) return;
      if (handler) contextInsertionHandlers.set(threadKey, handler);
      else contextInsertionHandlers.delete(threadKey);
      return () => {
        if (contextInsertionHandlers.get(threadKey) === handler) {
          contextInsertionHandlers.delete(threadKey);
        }
      };
    },
    setReviewComments: (threadRef, comments) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey) return;
      const reviewComments = comments
        .filter(isReviewCommentContext)
        .map((comment) => ({ ...comment }));
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const retainedIds = new Set(reviewComments.map((comment) => comment.id));
        let prompt = existing.prompt;
        for (const previous of existing.reviewComments) {
          if (retainedIds.has(previous.id)) continue;
          prompt = removeInlineContextReference(prompt, reviewCommentContextId(previous.id)).prompt;
        }
        prompt = ensureInlineContextReferences(
          prompt,
          reviewComments.map(reviewCommentContextReference),
        );
        const nextDraft = { ...existing, prompt, reviewComments };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
        else nextDraftsByThreadKey[threadKey] = nextDraft;
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    addThreadContexts: (threadRef, records, options) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey) return;
      const existingIds = new Set(
        (get().draftsByThreadKey[threadKey]?.threadContexts ?? []).map(
          (record) => record.contextId,
        ),
      );
      const incoming = records.filter((record) => {
        if (existingIds.has(record.contextId)) return false;
        existingIds.add(record.contextId);
        return true;
      });
      if (incoming.length === 0) return;
      const references = incoming.map(threadContextReference);
      const placedAtCaret =
        options?.appendReference !== false &&
        options?.insertAtCaret !== false &&
        (contextInsertionHandlers.get(threadKey)?.(references) ?? false);
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const known = new Set(existing.threadContexts.map((record) => record.contextId));
        const accepted = incoming.filter((record) => !known.has(record.contextId));
        if (accepted.length === 0) return state;
        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: {
              ...existing,
              prompt:
                placedAtCaret || options?.appendReference === false
                  ? existing.prompt
                  : ensureInlineContextReferences(
                      existing.prompt,
                      accepted.map(threadContextReference),
                    ),
              threadContexts: [...existing.threadContexts, ...accepted],
            },
          },
        };
      });
    },
    setThreadContexts: (threadRef, records) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey) return;
      const threadContexts = records.filter(isThreadContextRecord).map((record) => ({ ...record }));
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const retainedIds = new Set(threadContexts.map((record) => record.contextId));
        let prompt = existing.prompt;
        for (const previous of existing.threadContexts) {
          if (retainedIds.has(previous.contextId)) continue;
          prompt = removeInlineContextReference(prompt, previous.contextId).prompt;
        }
        prompt = ensureInlineContextReferences(prompt, threadContexts.map(threadContextReference));
        const nextDraft = { ...existing, prompt, threadContexts };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
        else nextDraftsByThreadKey[threadKey] = nextDraft;
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    addEnvironmentContexts: (threadRef, records, options) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey) return;
      const existingIds = new Set(
        (get().draftsByThreadKey[threadKey]?.environmentContexts ?? []).map(
          (record) => record.contextId,
        ),
      );
      const incoming = records.filter((record) => {
        if (existingIds.has(record.contextId)) return false;
        existingIds.add(record.contextId);
        return true;
      });
      if (incoming.length === 0) return;
      const references = incoming.map(environmentContextReference);
      const placedAtCaret =
        options?.appendReference !== false &&
        options?.insertAtCaret !== false &&
        (contextInsertionHandlers.get(threadKey)?.(references) ?? false);
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const known = new Set(existing.environmentContexts.map((record) => record.contextId));
        const accepted = incoming.filter((record) => !known.has(record.contextId));
        if (accepted.length === 0) return state;
        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: {
              ...existing,
              prompt:
                placedAtCaret || options?.appendReference === false
                  ? existing.prompt
                  : ensureInlineContextReferences(
                      existing.prompt,
                      accepted.map(environmentContextReference),
                    ),
              environmentContexts: [...existing.environmentContexts, ...accepted],
            },
          },
        };
      });
    },
    setEnvironmentContexts: (threadRef, records) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey) return;
      const environmentContexts = records
        .filter(isEnvironmentContextRecord)
        .map((record) => ({ ...record }));
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const retainedIds = new Set(environmentContexts.map((record) => record.contextId));
        let prompt = existing.prompt;
        for (const previous of existing.environmentContexts) {
          if (retainedIds.has(previous.contextId)) continue;
          prompt = removeInlineContextReference(prompt, previous.contextId).prompt;
        }
        prompt = ensureInlineContextReferences(
          prompt,
          environmentContexts.map(environmentContextReference),
        );
        const nextDraft = { ...existing, prompt, environmentContexts };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
        else nextDraftsByThreadKey[threadKey] = nextDraft;
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    removeReviewComment: (threadRef, commentId) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey || !commentId) return;
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];
        if (!current) return state;
        const reviewComments = current.reviewComments.filter((entry) => entry.id !== commentId);
        if (reviewComments.length === current.reviewComments.length) return state;
        const nextDraft = {
          ...current,
          prompt: removeInlineContextReference(current.prompt, reviewCommentContextId(commentId))
            .prompt,
          reviewComments,
        };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
        else nextDraftsByThreadKey[threadKey] = nextDraft;
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    clearPersistedAttachments: (threadRef) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          persistedAttachments: [],
          nonPersistedImageIds: [],
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
    syncPersistedAttachments: async (threadRef, attachments) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey) {
        return;
      }
      const attachmentIdSet = new Set(attachments.map((attachment) => attachment.id));
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          persistedAttachments: attachments,
          nonPersistedImageIds: current.nonPersistedImageIds.filter(
            (id) => !attachmentIdSet.has(id),
          ),
        };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
      await Promise.resolve();
      verifyPersistedAttachments(threadKey, set);
    },
    appendPersistedAttachments: async (threadRef, images, attachments) => {
      const current = get().getComposerDraft(threadRef);
      if (!current || attachments.length === 0) return;
      const ownedImages = new Set(current.images);
      const ownedIds = new Set(
        images.filter((image) => ownedImages.has(image)).map(({ id }) => id),
      );
      const ownedRecords = attachments.filter(({ id }) => ownedIds.has(id));
      if (ownedRecords.length === 0) return;
      const persistedById = new Map(
        current.persistedAttachments.map((record) => [record.id, record]),
      );
      for (const record of ownedRecords) {
        if (!persistedById.has(record.id)) persistedById.set(record.id, record);
      }
      await get().syncPersistedAttachments(threadRef, [...persistedById.values()]);
    },
    clearComposerContent: (threadRef) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          ...composerDraftContent(createEmptyThreadDraft()),
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
    clearComposerPromptAndImages: (threadRef) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];
        if (!current) {
          return state;
        }
        for (const image of current.images) {
          revokeObjectPreviewUrl(image.previewUrl);
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          prompt: ensureInlineContextReferences("", [
            ...current.terminalContexts.map(terminalContextReference),
            ...current.reviewComments.map(reviewCommentContextReference),
            ...current.threadContexts.map(threadContextReference),
            ...current.environmentContexts.map(environmentContextReference),
            ...current.previewAnnotations.map(previewAnnotationContextReference),
          ]),
          images: [],
          files: [],
          nonPersistedImageIds: [],
          persistedAttachments: [],
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
    moveComposerContent: (from, to) => {
      const fromKey = resolveComposerDraftKey(get(), from) ?? "";
      const toKey = resolveComposerDraftKey(get(), to) ?? "";
      if (fromKey.length === 0 || toKey.length === 0 || fromKey === toKey) {
        return;
      }
      set((state) => {
        const source = state.draftsByThreadKey[fromKey];
        const destination = state.draftsByThreadKey[toKey] ?? createEmptyThreadDraft();
        if (!source || composerDraftHasUserContent(destination)) {
          return state;
        }
        const destinationEnvironmentId =
          typeof to === "string"
            ? (state.draftThreadsByThreadKey[toKey]?.environmentId ??
              parseScopedThreadKey(toKey)?.environmentId ??
              null)
            : to.environmentId;
        const nextDestination = clearStaleFileUploadMetadata(
          { ...destination, ...composerDraftContent(source) },
          destinationEnvironmentId,
        );
        // Moved images still use these blob URLs at the destination; do not revoke them.
        const nextSource: ComposerThreadDraftState = {
          ...source,
          ...composerDraftContent(createEmptyThreadDraft()),
        };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextSource)) {
          delete nextDraftsByThreadKey[fromKey];
        } else {
          nextDraftsByThreadKey[fromKey] = nextSource;
        }
        if (shouldRemoveDraft(nextDestination)) {
          delete nextDraftsByThreadKey[toKey];
        } else {
          nextDraftsByThreadKey[toKey] = nextDestination;
        }
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
  };
}
