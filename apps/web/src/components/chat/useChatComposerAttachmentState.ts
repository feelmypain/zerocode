import type {
  ChatFileAttachment,
  ComposerContextRecord,
  EnvironmentContextRecord,
  EnvironmentId,
  PreviewAnnotationPayload,
  ProjectId,
  ScopedThreadRef,
  ThreadContextRecord,
} from "@zerocode/contracts";
import { encodeComposerContextFragment } from "@zerocode/shared/composerContextClipboard";
import {
  formatComposerContextReference,
  toKindScopedComposerContextId,
} from "@zerocode/shared/composerContextReferences";
import { useGT, useMessages } from "gt-react";
import { type RefObject, useEffect, useState } from "react";
import {
  attachmentContextRecord,
  previewAnnotationContextId,
  previewAnnotationContextRecord,
  reviewCommentContextId,
  reviewCommentContextRecord,
  terminalContextRecord,
  terminalContextReference,
  uploadedAttachmentContextRecord,
} from "~/lib/composerContextRecords";
import { collectInlineContextIds } from "~/lib/composerContextReferences";
import { rememberCopiedComposerAttachments } from "~/lib/copiedComposerAttachments";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
  type DraftId,
  composerFileNeedsReattach,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  releaseAttachmentUpload,
  releaseDraftAttachment,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import { attachmentUploadBlockReason } from "../../lib/attachmentUploadState";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import type { PendingApproval, PendingUserInput } from "../../session-logic";
import { isVideoAttachment, type Thread } from "../../types";
import { composerContextRecordsFromDraft } from "../composerContextPresentation";
import type { ChatComposerProps } from "./ChatComposer";
import {
  attachmentsToReleaseOnUploadCapabilityLoss,
  composerOtherFilesForPresentation,
  fileAttachmentCapabilityBlockReason,
  fileAttachmentStagingLimit,
  isPreviewableComposerVideo,
} from "./composerAttachmentFiles";
import type { QueuedAttachmentContextBinding } from "./composerContextUndo";
import { serializeComposerImages } from "./composerImagePersistence";
import { copySnapshot } from "./copySnapshot";
import {
  buildAttachmentVideoPreview,
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { usePreparingComposerImages } from "./preparingComposerImages";
import { isQueuedFileAttachment, isQueuedImageAttachment } from "./queuedMessageEdit";
import { useComposerContextImport } from "./useComposerContextImport";
import { useComposerImageGroups } from "./useComposerImageGroups";

interface ChatComposerAttachmentStateInput {
  readonly environmentId: EnvironmentId;
  readonly linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  readonly routeThreadRef: ScopedThreadRef;
  readonly activeThread: Thread | undefined;
  readonly activeThreadId: ChatComposerProps["activeThreadId"];
  readonly activeProjectId: ProjectId | null;
  readonly gitCwd: string | null;
  readonly canOperateThread: boolean;
  readonly attachmentUploadsCapabilityKnown: boolean;
  readonly supportsAttachmentUploads: boolean;
  readonly supportsQuestionAttachments: boolean;
  readonly maxFileAttachmentBytes: number | null;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly attachmentDraftTarget: ComposerThreadTarget;
  readonly attachmentTargetKey: string;
  readonly attachmentTargetKeyRef: RefObject<string>;
  readonly questionAttachmentTarget: DraftId | null;
  readonly prompt: string;
  readonly composerImages: ComposerImageAttachment[];
  readonly composerFiles: ComposerFileAttachment[];
  readonly composerTerminalContexts: TerminalContextDraft[];
  readonly composerPreviewAnnotations: PreviewAnnotationPayload[];
  readonly composerReviewComments: ReviewCommentContext[];
  readonly composerThreadContexts: ThreadContextRecord[];
  readonly composerEnvironmentContexts: EnvironmentContextRecord[];
  readonly pendingApprovals: ReadonlyArray<PendingApproval>;
  readonly heldRequestIds: ReadonlySet<string>;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly activePendingIsResponding: boolean;
  readonly activeEditingQueuedAttachments: ChatComposerProps["editingQueuedAttachments"];
  readonly activeRemovedEditingQueuedAttachments:
    | ReadonlyArray<QueuedAttachmentContextBinding>
    | undefined;
  readonly onRestoreEditingQueuedAttachment:
    | ChatComposerProps["onRestoreEditingQueuedAttachment"]
    | undefined;
  readonly promptRef: RefObject<string>;
  readonly composerFilesRef: RefObject<ComposerFileAttachment[]>;
  readonly pendingThreadImportsRef: RefObject<Map<string, number>>;
  readonly onExpandImage: (preview: ExpandedImagePreview) => void;
  readonly onFileOpen: (attachment: ChatFileAttachment) => void;
}

export function useChatComposerAttachmentState(input: ChatComposerAttachmentStateInput) {
  const {
    environmentId,
    linkedEnvironments,
    routeThreadRef,
    activeThread,
    activeThreadId,
    activeProjectId,
    gitCwd,
    canOperateThread,
    attachmentUploadsCapabilityKnown,
    supportsAttachmentUploads,
    supportsQuestionAttachments,
    maxFileAttachmentBytes,
    composerDraftTarget,
    attachmentDraftTarget,
    attachmentTargetKey,
    attachmentTargetKeyRef,
    questionAttachmentTarget,
    prompt,
    composerImages,
    composerFiles,
    composerTerminalContexts,
    composerPreviewAnnotations,
    composerReviewComments,
    composerThreadContexts,
    composerEnvironmentContexts,
    pendingApprovals,
    heldRequestIds,
    pendingUserInputs,
    activePendingIsResponding,
    activeEditingQueuedAttachments,
    activeRemovedEditingQueuedAttachments,
    onRestoreEditingQueuedAttachment,
    promptRef,
    composerFilesRef,
    pendingThreadImportsRef,
    onExpandImage,
    onFileOpen,
  } = input;
  const gt = useGT();
  const m = useMessages();
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const addComposerDraftFiles = useComposerDraftStore((store) => store.addFiles);
  const removeComposerDraftFile = useComposerDraftStore((store) => store.removeFile);
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);

  const inlineFileIdSet = (() => {
    if (questionAttachmentTarget) return new Set<string>();
    const contextIds = new Set(collectInlineContextIds(prompt));
    return new Set(
      composerFiles
        .filter((file) => contextIds.has(toKindScopedComposerContextId("file", file.id)))
        .map((file) => file.id),
    );
  })();
  const composerVideos = composerFiles.filter((file) =>
    isPreviewableComposerVideo(file, environmentId),
  );
  const composerOtherFiles = composerOtherFilesForPresentation(
    composerFiles,
    environmentId,
    inlineFileIdSet,
  );

  const {
    pendingSnapShotAnimations,
    pendingSnapShotIds,
    uncommittedSnapShotIds,
    standaloneComposerImages,
  } = useComposerImageGroups(attachmentDraftTarget, composerImages, composerPreviewAnnotations);
  const allPreparingComposerImages = usePreparingComposerImages(attachmentTargetKey);
  const preparingComposerImages = allPreparingComposerImages.filter((image) => !image.hidden);
  // A message send waits for these itself; an answer waits in the composer below.
  const messageHasPreparingImages =
    questionAttachmentTarget === null && allPreparingComposerImages.length > 0;
  const uploadsByImageId = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const openPrLink = useOpenPrLink(routeThreadRef);
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const previewFile = composerFiles.find((file) => file.id === previewFileId);

  const buildContextClipboardFragment = (contextIds: ReadonlyArray<string>): string | null => {
    const wanted = new Set(contextIds);
    const copiedFiles = new Map<string, File>();
    for (const annotation of composerPreviewAnnotations) {
      if (
        wanted.has(previewAnnotationContextId(annotation.id)) &&
        composerImages.some((image) => image.id === annotation.id)
      ) {
        wanted.add(toKindScopedComposerContextId("image", annotation.id));
      }
    }
    const records: ComposerContextRecord[] = [
      ...composerTerminalContexts
        .filter((c) => wanted.has(terminalContextReference(c).contextId))
        .map(terminalContextRecord),
      ...composerThreadContexts.filter((record) => wanted.has(record.contextId)),
      ...composerEnvironmentContexts.filter((record) => wanted.has(record.contextId)),
      ...composerReviewComments
        .filter((c) => wanted.has(reviewCommentContextId(c.id)))
        .map(reviewCommentContextRecord),
      ...composerPreviewAnnotations
        .filter((a) => wanted.has(previewAnnotationContextId(a.id)))
        .map((annotation) =>
          previewAnnotationContextRecord(annotation, {
            screenshotContextId: composerImages.some((image) => image.id === annotation.id)
              ? annotation.id
              : undefined,
          }),
        ),
      ...[...composerImages, ...composerFiles]
        .filter((attachment) =>
          wanted.has(toKindScopedComposerContextId(attachment.type, attachment.id)),
        )
        .flatMap((attachment) => {
          const record =
            uploadedAttachmentContextRecord(attachment, uploadsByImageId[attachment.id]) ??
            (attachment.file
              ? attachmentContextRecord({ attachment, attachmentId: attachment.id })
              : null);
          if (!record) return [];
          if (attachment.file) copiedFiles.set(record.attachmentId, attachment.file);
          return [record];
        }),
      ...(activeEditingQueuedAttachments ?? []).flatMap(({ attachment, contextIds: queuedIds }) => {
        if (!isQueuedImageAttachment(attachment) && !isQueuedFileAttachment(attachment)) return [];
        return (queuedIds ?? [])
          .filter((contextId) => wanted.has(contextId))
          .map((contextId) =>
            attachmentContextRecord({
              attachment,
              attachmentId: attachment.id,
              contextId,
            }),
          );
      }),
    ];
    if (records.length === 0) return null;
    const fragment = encodeComposerContextFragment({
      version: 1,
      source: { environmentId, ...(activeThread ? { threadId: activeThread.id } : {}) },
      records,
    });
    if (fragment) rememberCopiedComposerAttachments(environmentId, copiedFiles);
    return fragment;
  };
  const copyComposerSnapshot = async (imageId: string) => {
    const image = composerImages.find((candidate) => candidate.id === imageId);
    if (!image) throw new Error(gt("Snapshot is no longer available."));
    const contextId = toKindScopedComposerContextId("image", image.id);
    const fragment = buildContextClipboardFragment([contextId]);
    if (!fragment || !image.previewUrl) throw new Error(gt("The snapshot is not ready to copy."));
    await copySnapshot(
      image.previewUrl,
      formatComposerContextReference({ kind: "image", contextId, label: image.name }),
      fragment,
    );
  };
  const copyComposerSnapshotStable = useStableCallback(copyComposerSnapshot);
  const buildContextClipboardFragmentStable = useStableCallback(buildContextClipboardFragment);

  const composerContextActions = {
    environmentId,
    cwd: gitCwd ?? undefined,
    projectId: activeProjectId ?? undefined,
    expandImage: (imageId: string) => {
      const preview =
        buildExpandedImagePreview(composerImages, imageId, copyComposerSnapshotStable) ??
        buildExpandedImagePreview(
          (activeEditingQueuedAttachments ?? []).flatMap(({ attachment, url }) =>
            isQueuedImageAttachment(attachment) && url ? [{ ...attachment, previewUrl: url }] : [],
          ),
          imageId,
        );
      if (preview) onExpandImage(preview);
    },
    openFile: (fileId: string) => {
      if (composerFiles.some((file) => file.id === fileId)) {
        setPreviewFileId(fileId);
        return;
      }
      const queuedFile = activeEditingQueuedAttachments?.find(
        ({ attachment }) => isQueuedFileAttachment(attachment) && attachment.id === fileId,
      )?.attachment;
      if (queuedFile && isQueuedFileAttachment(queuedFile)) onFileOpen(queuedFile);
    },
    openMention: (path: string) => useRightPanelStore.getState().openFile(routeThreadRef, path),
    expandVideo: (fileId: string) => {
      const file = composerFiles.find((candidate) => candidate.id === fileId);
      if (file && isVideoAttachment(file)) {
        const localPreview = buildExpandedImagePreview([file], file.id);
        if (localPreview) {
          onExpandImage(localPreview);
          return;
        }
        if (file.uploadedAttachmentId === undefined || file.uploadEnvironmentId !== environmentId) {
          return;
        }
        const persistedPreview = buildAttachmentVideoPreview(environmentId, {
          type: "file",
          id: file.uploadedAttachmentId,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        });
        if (persistedPreview) onExpandImage(persistedPreview);
        return;
      }
      const queuedFile = activeEditingQueuedAttachments?.find(
        ({ attachment }) => isQueuedFileAttachment(attachment) && attachment.id === fileId,
      )?.attachment;
      if (!queuedFile || !isQueuedFileAttachment(queuedFile) || !isVideoAttachment(queuedFile)) {
        return;
      }
      const persistedPreview = buildAttachmentVideoPreview(environmentId, queuedFile);
      if (persistedPreview) onExpandImage(persistedPreview);
    },
    openPullRequest: (event: React.MouseEvent<HTMLElement>, url: string) => {
      openPrLink(event, url);
    },
  };
  const composerContextRecords = composerContextRecordsFromDraft({
    terminalContexts: composerTerminalContexts,
    reviewComments: composerReviewComments,
    previewAnnotations: composerPreviewAnnotations,
    threadContexts: composerThreadContexts,
    environmentContexts: composerEnvironmentContexts,
    images: composerImages,
    files: composerFiles,
    existingAttachments: activeEditingQueuedAttachments ?? undefined,
    environmentId,
    uploadsByImageId,
  });

  const needsReattachFileCount = composerFiles.filter(composerFileNeedsReattach).length;
  const fileStagingLimit = fileAttachmentStagingLimit({
    attachmentUploadsCapabilityKnown,
    supportsAttachmentUploads,
    maxFileAttachmentBytes,
  });
  const fileCapabilityBlockReason = fileAttachmentCapabilityBlockReason(
    {
      files: composerFiles,
      attachmentUploadsCapabilityKnown,
      supportsAttachmentUploads,
      maxFileAttachmentBytes,
    },
    m,
  );
  const attachmentBlockReason =
    (questionAttachmentTarget &&
    !supportsQuestionAttachments &&
    (composerImages.length > 0 || composerFiles.length > 0)
      ? gt("Update this server to send files with question answers")
      : null) ??
    fileCapabilityBlockReason ??
    (supportsAttachmentUploads
      ? needsReattachFileCount > 0
        ? needsReattachFileCount === 1
          ? gt("Attach the interrupted file again or remove it")
          : gt("Attach the interrupted files again or remove them")
        : // A plain send waits for its uploads. Answers and approval redirects need them first.
          questionAttachmentTarget ||
            pendingApprovals.some((approval) => !heldRequestIds.has(approval.requestId))
          ? attachmentUploadBlockReason(
              {
                imageIds: [...composerImages, ...composerFiles].map((attachment) => attachment.id),
                uploadsByImageId,
                environmentId,
              },
              m,
            )
          : null
      : null);

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- starts or releases server attachment uploads as upload capability, limits and draft attachments change
  useEffect(() => {
    if (!attachmentUploadsCapabilityKnown) {
      return;
    }
    if (!supportsAttachmentUploads) {
      // Reconnect or version skew can hide upload support; retain hydrated uploads.
      for (const attachment of attachmentsToReleaseOnUploadCapabilityLoss([
        ...composerImages,
        ...composerFiles,
      ])) {
        releaseAttachmentUpload(attachment.id);
      }
      return;
    }
    if (!canOperateThread) return;
    const invalidFiles =
      maxFileAttachmentBytes === null
        ? composerFiles
        : composerFiles.filter((file) => file.sizeBytes > maxFileAttachmentBytes);
    for (const attachment of attachmentsToReleaseOnUploadCapabilityLoss(invalidFiles)) {
      releaseAttachmentUpload(attachment.id);
    }
    const uploadableFiles =
      maxFileAttachmentBytes === null
        ? []
        : composerFiles.filter((file) => file.sizeBytes <= maxFileAttachmentBytes);
    const uploadableAttachments = [...composerImages, ...uploadableFiles];
    for (const attachment of uploadableAttachments) {
      if (attachment.type === "file" && composerFileNeedsReattach(attachment)) {
        continue;
      }
      startAttachmentUpload({
        environmentId,
        image: attachment,
        draftTarget: attachmentDraftTarget,
      });
    }
  }, [
    attachmentUploadsCapabilityKnown,
    attachmentDraftTarget,
    canOperateThread,
    composerFiles,
    composerImages,
    environmentId,
    maxFileAttachmentBytes,
    supportsAttachmentUploads,
  ]);

  const addComposerImage = (image: ComposerImageAttachment) =>
    addComposerDraftImages(attachmentDraftTarget, [image]);

  const addComposerImagesToDraft = (images: ComposerImageAttachment[]) =>
    addComposerDraftImages(attachmentDraftTarget, images);

  const addComposerFilesToDraft = (files: ComposerFileAttachment[]) =>
    addComposerDraftFiles(attachmentDraftTarget, files, {
      appendReference: questionAttachmentTarget === null,
    });

  const removeComposerImageFromDraft = (imageId: string) => {
    if (questionAttachmentTarget && activePendingIsResponding) return;
    releaseAttachmentUpload(imageId);
    removeComposerDraftImage(attachmentDraftTarget, imageId);
  };

  const removeComposerFileFromDraft = (fileId: string) => {
    if (questionAttachmentTarget && activePendingIsResponding) return;
    // Hydrated uploads use persisted attachment ids, not queue keys.
    const file = composerFilesRef.current.find((candidate) => candidate.id === fileId);
    if (file) {
      releaseDraftAttachment(file);
    } else {
      releaseAttachmentUpload(fileId);
    }
    removeComposerDraftFile(attachmentDraftTarget, fileId);
  };

  const {
    loadThreadTranscript,
    countReservedAttachments,
    countReservedAttachmentsStable,
    importContextRecords,
    importContextFragment,
    importContextFragmentStable,
  } = useComposerContextImport({
    environmentId,
    linkedEnvironments,
    activeThread,
    activeThreadId,
    composerDraftTarget,
    attachmentDraftTarget,
    attachmentTargetKey,
    attachmentTargetKeyRef,
    questionAttachmentTarget,
    pendingUserInputs,
    composerContextRecords,
    composerImages,
    composerFilesRef,
    promptRef,
    pendingThreadImportsRef,
    addComposerFilesToDraft,
    removedQueuedAttachments: activeRemovedEditingQueuedAttachments,
    onRestoreQueuedAttachment: onRestoreEditingQueuedAttachment,
  });

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- reads draft images as data URLs and persists them to the draft store, dropping stale results on cleanup
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(attachmentDraftTarget);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        getComposerDraft(attachmentDraftTarget)?.persistedAttachments ?? [];
      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const serialized = await serializeComposerImages(
          composerImages,
          currentPersistedAttachments,
        );
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(attachmentDraftTarget, serialized);
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        const fallbackPersistedIds: Array<string> = [];
        for (const attachment of fallbackPersistedAttachments) {
          if (currentImageIds.has(attachment.id)) {
            fallbackPersistedIds.push(attachment.id);
          }
        }
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(attachmentDraftTarget, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    attachmentDraftTarget,
    clearComposerDraftPersistedAttachments,
    composerImages,
    getComposerDraft,
    syncComposerDraftPersistedAttachments,
  ]);

  return {
    composerVideos,
    composerOtherFiles,
    pendingSnapShotAnimations,
    pendingSnapShotIds,
    uncommittedSnapShotIds,
    standaloneComposerImages,
    preparingComposerImages,
    messageHasPreparingImages,
    previewFile,
    setPreviewFileId,
    composerContextActions,
    composerContextRecords,
    fileStagingLimit,
    attachmentBlockReason,
    addComposerImage,
    addComposerImagesToDraft,
    addComposerFilesToDraft,
    removeComposerImageFromDraft,
    removeComposerFileFromDraft,
    copyComposerSnapshotStable,
    buildContextClipboardFragmentStable,
    loadThreadTranscript,
    countReservedAttachments,
    countReservedAttachmentsStable,
    importContextRecords,
    importContextFragment,
    importContextFragmentStable,
  };
}
