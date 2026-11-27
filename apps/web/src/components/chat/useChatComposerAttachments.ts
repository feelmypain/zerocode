import { settlePromise, squashAtomCommandFailure } from "@zerocode/client-runtime/state/runtime";
import {
  type EnvironmentId,
  EnvironmentRequestInvalidError,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ScopedThreadRef,
  type ThreadId,
} from "@zerocode/contracts";
import { serializeComposerFileLink } from "@zerocode/shared/composerTrigger";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { type RefObject, useEffect, useEffectEvent, useRef, useState } from "react";
import { isPasteAsTextShortcut } from "@zerocode/client-runtime/text-paste";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import {
  reviewCommentContextReference,
  threadContextReference,
} from "~/lib/composerContextRecords";
import {
  type ComposerContextReference,
  ensureInlineContextReferences,
  formatInlineContextReference,
  inlineContextReferenceReplacement,
} from "~/lib/composerContextReferences";
import { isMacPlatform } from "~/lib/utils";
import { threadContextAttachment } from "~/lib/threadContextAttachment";
import { readThreadShell } from "~/state/entities";
import { extendReplacementRangeForTrailingSpace } from "../../composer-logic";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
  type DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { DESKTOP_PASTE_AS_TEXT_EVENT } from "../../lib/desktopPasteAsText";
import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import type { PendingUserInputProgress } from "../../pendingUserInput";
import type { PendingUserInput } from "../../session-logic";
import { readPreparedConnection } from "../../state/session";
import type { ComposerAttachmentInsertion } from "../composerAttachmentInsertion";
import { importPastedComposerText, readPastedComposerContext } from "../composerInlineTokenPaste";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditorTiptap";
import { buildPullRequestReferenceContext } from "../pullRequest/pullRequestDetail.logic";
import { toastManager } from "../ui/toast";
import type { ChatComposerHandle } from "./ChatComposer";
import {
  clipboardHtmlImageContent,
  imagesToAttachBesidePastedText,
  shouldHandleComposerAttachmentPaste,
} from "./composerAttachmentFiles";
import { insertAttachmentReferencesForDraft } from "./composerAttachmentReferences";
import {
  dataTransferHasComposerMention,
  makeComposerMentionDragHandlers,
} from "./composerMentionDrag";
import { importComposerThreadAttachment } from "./composerThreadImport";
import { type FolderDropTarget, folderDropTarget, resolveDroppedFolderPath } from "./folderDrop";
import { pendingDraftWork } from "./pendingDraftWork";
import { useThreadContextDrop } from "./threadContextDrag";
import { droppedThreadContextRecord } from "./threadContextDrop.logic";
import { useComposerAttachmentIntake } from "./useComposerAttachmentIntake";
import type { useComposerContextImport } from "./useComposerContextImport";
import { splitTransferredFiles } from "./workspaceFileDrop";

const isEnvironmentRequestInvalidError = Schema.is(EnvironmentRequestInvalidError);

export function consumePasteAsTextShortcut(deadline: { current: number }): boolean {
  const armed = Date.now() <= deadline.current;
  deadline.current = 0;
  return armed;
}

interface ChatComposerAttachmentsInput {
  readonly environmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  readonly routeThreadRef: ScopedThreadRef;
  readonly activeThreadId: ThreadId | null;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly questionAttachmentTarget: DraftId | null;
  readonly attachmentTargetKey: string;
  readonly attachmentTargetKeyRef: RefObject<string>;
  readonly canOperateThread: boolean;
  readonly backgroundThread: boolean;
  readonly activePendingProgress: PendingUserInputProgress | null;
  readonly activePendingIsResponding: boolean;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly supportsQuestionAttachments: boolean;
  readonly isLiteralPendingAnswer: boolean;
  readonly projectSelectionRequired: boolean;
  readonly speechFreezesEditor: boolean;
  readonly isComposerCollapsedMobile: boolean;
  readonly fileStagingLimit: number | null;
  readonly composerSessionKey: string;
  readonly composerMountedRef: RefObject<boolean>;
  readonly composerFormRef: RefObject<HTMLFormElement | null>;
  readonly composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly promptRef: RefObject<string>;
  readonly composerImagesRef: RefObject<ComposerImageAttachment[]>;
  readonly composerFilesRef: RefObject<ComposerFileAttachment[]>;
  readonly isRevertingCheckpointRef: RefObject<boolean>;
  readonly pendingThreadImportsRef: RefObject<Map<string, number>>;
  readonly setPrompt: (prompt: string) => void;
  readonly setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  readonly focusComposer: () => void;
  readonly expandMobileComposer: () => void;
  readonly expandMobileComposerStable: () => void;
  readonly addComposerImage: (image: ComposerImageAttachment) => string[];
  readonly addComposerImagesToDraft: (images: ComposerImageAttachment[]) => string[];
  readonly addComposerFilesToDraft: (files: ComposerFileAttachment[]) => string[];
  readonly removeComposerImageFromDraft: (imageId: string) => void;
  readonly countReservedAttachments: ReturnType<
    typeof useComposerContextImport
  >["countReservedAttachments"];
  readonly countReservedAttachmentsStable: ReturnType<
    typeof useComposerContextImport
  >["countReservedAttachmentsStable"];
  readonly loadThreadTranscript: ReturnType<
    typeof useComposerContextImport
  >["loadThreadTranscript"];
  readonly importContextFragment: ReturnType<
    typeof useComposerContextImport
  >["importContextFragment"];
  readonly readComposerSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  };
  readonly readComposerSnapshotStable: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  };
  readonly applyPromptReplacement: (
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
    options?: {
      expectedText?: string;
      expandedCursorAfterReplace?: number;
      focusEditorAfterReplace?: boolean;
      citationComment?: {
        start: number;
        sourceAnchor: AssistantCitationSourceAnchor;
        insertedSpaces: { readonly before: boolean; readonly after: boolean };
      };
    },
  ) => boolean;
  readonly applyPromptReplacementStable: (
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
    options?: {
      expectedText?: string;
      expandedCursorAfterReplace?: number;
      focusEditorAfterReplace?: boolean;
      citationComment?: {
        start: number;
        sourceAnchor: AssistantCitationSourceAnchor;
        insertedSpaces: { readonly before: boolean; readonly after: boolean };
      };
    },
  ) => boolean;
}

export function useChatComposerAttachments(input: ChatComposerAttachmentsInput) {
  const {
    environmentId,
    primaryEnvironmentId,
    linkedEnvironments,
    routeThreadRef,
    activeThreadId,
    composerDraftTarget,
    questionAttachmentTarget,
    attachmentTargetKey,
    attachmentTargetKeyRef,
    canOperateThread,
    backgroundThread,
    activePendingProgress,
    activePendingIsResponding,
    pendingUserInputs,
    supportsQuestionAttachments,
    isLiteralPendingAnswer,
    projectSelectionRequired,
    speechFreezesEditor,
    isComposerCollapsedMobile,
    fileStagingLimit,
    composerSessionKey,
    composerMountedRef,
    composerFormRef,
    composerEditorRef,
    promptRef,
    composerImagesRef,
    composerFilesRef,
    isRevertingCheckpointRef,
    pendingThreadImportsRef,
    setPrompt,
    setThreadError,
    focusComposer,
    expandMobileComposer,
    expandMobileComposerStable,
    addComposerImage,
    addComposerImagesToDraft,
    addComposerFilesToDraft,
    removeComposerImageFromDraft,
    countReservedAttachments,
    countReservedAttachmentsStable,
    loadThreadTranscript,
    importContextFragment,
    readComposerSnapshot,
    readComposerSnapshotStable,
    applyPromptReplacement,
    applyPromptReplacementStable,
  } = input;
  const gt = useGT();
  const addComposerDraftReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const addComposerDraftThreadContexts = useComposerDraftStore((store) => store.addThreadContexts);
  const setContextInsertionHandler = useComposerDraftStore(
    (store) => store.setContextInsertionHandler,
  );

  const pasteAsTextShortcutUntilRef = useRef(0);
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [dragSessionKey, setDragSessionKey] = useState(composerSessionKey);
  if (dragSessionKey !== composerSessionKey) {
    setDragSessionKey(composerSessionKey);
    setIsDragOverComposer(false);
  }

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- subscribes to keydown, window blur and the desktop paste-as-text event to arm plain-text paste
  useEffect(() => {
    // A background composer listens on its own form, so it never hears the main composer's keys.
    const target: EventTarget | null = backgroundThread ? composerFormRef.current : window;
    if (target === null) return;
    const armPasteAsTextShortcut = () => {
      // Electron's menu action can precede paste; browsers deliver keydown first.
      pasteAsTextShortcutUntilRef.current = Date.now() + 1_000;
    };
    const onKeyDown = (event: Event) => {
      if (
        event instanceof KeyboardEvent &&
        event.target instanceof Node &&
        composerFormRef.current?.contains(event.target) &&
        isPasteAsTextShortcut(event, isMacPlatform(navigator.platform))
      ) {
        armPasteAsTextShortcut();
      }
    };
    const onBlur = () => {
      pasteAsTextShortcutUntilRef.current = 0;
    };
    const onDesktopPasteAsText = () => {
      const activeElement = document.activeElement;
      const blocksPasteToFocus =
        activeElement instanceof Element &&
        activeElement.closest(
          'input, textarea, select, button, a[href], summary, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], [role="button"], [role="menuitem"], [role="option"]',
        ) !== null;
      // A background composer takes no paste-to-focus, so it arms only for its own focus.
      if (
        (activeElement instanceof Node && composerFormRef.current?.contains(activeElement)) ||
        (!blocksPasteToFocus && !backgroundThread)
      ) {
        armPasteAsTextShortcut();
      }
    };
    target.addEventListener(DESKTOP_PASTE_AS_TEXT_EVENT, onDesktopPasteAsText);
    target.addEventListener("keydown", onKeyDown, true);
    // An arm lasts a second, so a background composer can skip the window blur reset.
    if (!backgroundThread) window.addEventListener("blur", onBlur);
    return () => {
      target.removeEventListener(DESKTOP_PASTE_AS_TEXT_EVENT, onDesktopPasteAsText);
      target.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [backgroundThread, composerFormRef]);

  const insertComposerText = (
    text: string,
    position: "cursor" | "end",
    options?: {
      ensureLeadingBoundary?: boolean;
      citationCommentAnchor?: AssistantCitationSourceAnchor;
      clipboardData?: DataTransfer;
    },
  ): boolean => {
    if (
      text.length === 0 ||
      activePendingIsResponding ||
      (pendingUserInputs.length > 0 && !activePendingProgress?.activeQuestion) ||
      projectSelectionRequired ||
      speechFreezesEditor ||
      (options?.citationCommentAnchor && !composerEditorRef.current)
    ) {
      return false;
    }
    if (options?.clipboardData) {
      text = importPastedComposerText(options.clipboardData, importContextFragment);
    }
    const prompt = promptRef.current;
    const cursor = position === "cursor" ? readComposerSnapshot().expandedCursor : prompt.length;
    const needsLeadingSpace =
      (options?.ensureLeadingBoundary ?? false) &&
      cursor > 0 &&
      !/\s/.test(prompt[cursor - 1] ?? "");
    const rangeEnd = extendReplacementRangeForTrailingSpace(prompt, cursor, text);
    return applyPromptReplacement(
      cursor,
      rangeEnd,
      needsLeadingSpace ? ` ${text}` : text,
      options?.citationCommentAnchor
        ? {
            citationComment: {
              start: cursor + (needsLeadingSpace ? 1 : 0),
              sourceAnchor: options.citationCommentAnchor,
              insertedSpaces: { before: needsLeadingSpace, after: rangeEnd === cursor },
            },
            focusEditorAfterReplace: false,
          }
        : undefined,
    );
  };
  const insertComposerTextStable = useStableCallback(insertComposerText);

  const insertAttachmentReferences = (
    references: ReadonlyArray<ComposerContextReference>,
    selection?: { start: number; end: number },
    pendingInsertion?: ComposerAttachmentInsertion,
  ): boolean => {
    if (references.length === 0) return false;
    // Question answers carry attachments beside the answer, never as chips. Falling back to
    // the thread prompt here would hide the file behind a reference the question never shows.
    if (questionAttachmentTarget) return false;
    return insertAttachmentReferencesForDraft({
      target: composerDraftTarget,
      liveAttachmentTargetKey: attachmentTargetKeyRef.current,
      references,
      insertReferences: () => {
        if (pendingInsertion?.insert(references)) return true;
        if (selection) {
          const edit = inlineContextReferenceReplacement(promptRef.current, selection, references);
          return applyPromptReplacementStable(edit.start, edit.end, edit.text);
        }
        const text = references.map(formatInlineContextReference).join(" ");
        const inserted = insertComposerTextStable(`${text} `, "cursor", {
          ensureLeadingBoundary: true,
        });
        if (!inserted) {
          setPrompt(ensureInlineContextReferences(promptRef.current, references));
        }
        return true;
      },
    });
  };

  const { addComposerAttachments, removeComposerImage, foldPastedText } =
    useComposerAttachmentIntake({
      activeThreadId,
      activePendingProgress,
      activePendingIsResponding,
      pendingUserInputs,
      supportsQuestionAttachments,
      isLiteralPendingAnswer,
      projectSelectionRequired,
      questionAttachmentTarget,
      attachmentTargetKey,
      fileStagingLimit,
      promptRef,
      composerImagesRef,
      composerFilesRef,
      composerEditorRef,
      isRevertingCheckpointRef,
      setThreadError,
      countReservedAttachments,
      addComposerImage,
      addComposerImagesToDraft,
      addComposerFilesToDraft,
      removeComposerImageFromDraft,
      insertAttachmentReferences,
    });

  const insertComposerTextAtEnd: ChatComposerHandle["insertTextAtEnd"] = (text, options) => {
    const inserted = insertComposerText(text, "end", options);
    if (inserted && isComposerCollapsedMobile) {
      // Reveal the mobile editor before its focus frame.
      expandMobileComposer();
    }
    return inserted;
  };
  const insertComposerTextAtEndStable = useStableCallback(insertComposerTextAtEnd);

  const insertComposerFolders = async (
    folders: File[],
    target: FolderDropTarget,
    draftKey: string,
  ) => {
    const bridge = window.desktopBridge;
    for (const folder of folders) {
      const droppedPath = resolveDroppedFolderPath(folder, bridge?.getPathForFile);
      const path =
        droppedPath === null || typeof target === "string"
          ? droppedPath
          : ((await bridge
              ?.toLocalBackendPath(target.wslBackendId, droppedPath)
              .catch(() => null)) ?? null);
      // ChatView is reused across threads, so a slow conversion must not land in the next draft.
      if (!composerMountedRef.current || attachmentTargetKeyRef.current !== draftKey) return;
      if (path === null) {
        toastManager.add({
          type: "error",
          title: gt('Couldn\'t get the path of "{name}"', { name: folder.name }),
          description: gt("Type the folder path with @ instead."),
        });
        continue;
      }
      const inserted = insertComposerTextAtEndStable(`${serializeComposerFileLink(path)} `, {
        ensureLeadingBoundary: true,
      });
      if (!inserted) {
        toastManager.add({
          type: "error",
          title: gt("Unable to add folder"),
          description: gt("The composer is busy; try again once it is ready."),
        });
        break;
      }
    }
    focusComposer();
  };

  const addComposerFolders = (folders: File[]) => {
    const target = folderDropTarget({
      localEnvironmentDisabled: isLocalEnvironmentDisabled(),
      environmentId,
      primaryEnvironmentId,
      connection: readPreparedConnection(environmentId),
      isDesktopRenderer: window.desktopBridge !== undefined,
      primaryRunsInWsl:
        window.desktopBridge
          ?.getLocalEnvironmentBootstraps()
          .some(
            (bootstrap) =>
              bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID &&
              typeof bootstrap.runningDistro === "string",
          ) === true,
    });
    if (target === "remote") {
      toastManager.add({
        type: "error",
        title: gt("Folders can only be referenced on a server running on this computer"),
      });
      return;
    }
    const draftKey = attachmentTargetKeyRef.current;
    // Hold send until every conversion lands, or the folder misses the message.
    pendingDraftWork.begin(draftKey);
    void insertComposerFolders(folders, target, draftKey).finally(() =>
      pendingDraftWork.end(draftKey),
    );
  };
  const addComposerFoldersStable = useStableCallback(addComposerFolders);

  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const { files, folders } = splitTransferredFiles(event.clipboardData);
    const plainText = event.clipboardData.getData("text/plain");
    const bypassAutoAttachment = consumePasteAsTextShortcut(pasteAsTextShortcutUntilRef);
    const pastedContext =
      !isLiteralPendingAnswer &&
      (readPastedComposerContext(event.clipboardData)?.records.length ?? 0) > 0;
    const canAttachFiles = !pastedContext && activeThreadId !== null && files.length > 0;
    const htmlImageContent =
      canAttachFiles && plainText.length > 0
        ? clipboardHtmlImageContent(event.clipboardData.getData("text/html"))
        : "none";
    if (
      folders.length > 0 ||
      (canAttachFiles &&
        shouldHandleComposerAttachmentPaste({
          files,
          plainText,
          bypassAutoAttachment,
          htmlIsOnlyImage: htmlImageContent === "only-image",
        }))
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (folders.length > 0) addComposerFoldersStable(folders);
      if (files.length > 0) {
        void addComposerAttachments(files, { skipImageInlineChip: bypassAutoAttachment });
      }
      return;
    }

    if (pastedContext) return;
    const imagesBesideText = imagesToAttachBesidePastedText({
      files,
      plainText,
      bypassAutoAttachment,
      htmlHasImageAndText: htmlImageContent === "image-and-text",
    });
    if (imagesBesideText.length > 0) void addComposerAttachments(imagesBesideText);
    if (!foldPastedText(plainText, bypassAutoAttachment)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  };
  // The editor is memoized; fresh closures here re-render it on every parent
  // render, which during a stream is every delta.
  const onComposerPasteStable = useStableCallback(onComposerPaste);

  const insertContextReferencesAtCaret = (
    references: ReadonlyArray<ComposerContextReference>,
  ): boolean =>
    insertComposerText(`${references.map(formatInlineContextReference).join(" ")} `, "cursor", {
      ensureLeadingBoundary: true,
    });
  const insertContextReferencesAtCaretStable = useStableCallback(insertContextReferencesAtCaret);
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- registers this composer's context insertion handler in the draft store for the current target
  useEffect(() => {
    return setContextInsertionHandler(composerDraftTarget, insertContextReferencesAtCaretStable);
  }, [composerDraftTarget, insertContextReferencesAtCaretStable, setContextInsertionHandler]);

  // Capture drops before the editor; mention handlers own native propagation and moves.
  const composerMentionDragHandlers = makeComposerMentionDragHandlers({
    insertMentionAtEnd: (text) =>
      insertComposerTextAtEndStable(text, { ensureLeadingBoundary: true }),
    insertPullRequestAtEnd: (pullRequest) => {
      const comment = buildPullRequestReferenceContext(pullRequest);
      const inserted = insertComposerTextAtEndStable(
        `${formatInlineContextReference(reviewCommentContextReference(comment))} `,
        { ensureLeadingBoundary: true },
      );
      if (inserted) {
        addComposerDraftReviewComment(composerDraftTarget, comment, { appendReference: false });
      }
      return inserted;
    },
    setDragActive: setIsDragOverComposer,
    onInsertRejected: () => {
      toastManager.add({
        type: "error",
        title: gt("Unable to add to chat"),
        description: gt("The composer is busy; try again once it is ready."),
      });
    },
  });

  const attachDroppedThreadFile = useEffectEvent((file: File) => addComposerAttachments([file]));
  const importDroppedThread = useEffectEvent(
    async (ref: ScopedThreadRef, isActive: () => boolean) => {
      const targetKey = attachmentTargetKey;
      pendingDraftWork.begin(targetKey);
      const loadingToast = toastManager.add({
        type: "loading",
        title: gt("Loading thread context…"),
        timeout: 0,
        data: { threadRef: routeThreadRef, hideCopyButton: true },
      });
      const importResult = await settlePromise(() =>
        importComposerThreadAttachment({
          targetKey,
          pendingImports: pendingThreadImportsRef.current,
          countReservedAttachments: countReservedAttachmentsStable,
          load: async () => {
            const result = await loadThreadTranscript({
              environmentId: ref.environmentId,
              input: { threadId: ref.threadId },
            });
            if (result._tag !== "Success") {
              throw squashAtomCommandFailure(result);
            }
            return threadContextAttachment(ref.environmentId, result.value);
          },
          isActive,
          attach: attachDroppedThreadFile,
          onLimitReached: () => {
            if (activeThreadId) {
              setThreadError(
                activeThreadId,
                gt(
                  "{count, plural, one {You can attach up to {count} files per message.} other {You can attach up to {count} files per message.}}",
                  {
                    count: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
                  },
                ),
              );
            }
          },
        }),
      );
      if (importResult._tag === "Failure" && isActive()) {
        const error = squashAtomCommandFailure(importResult);
        toastManager.add({
          type: "error",
          title: gt("Unable to read the dropped thread"),
          description:
            isEnvironmentRequestInvalidError(error) &&
            error.reason === "thread_transcript_too_large"
              ? gt("This thread exceeds the attachment size limit. Try a shorter thread.")
              : gt("Check that its environment is connected and up to date, then try again."),
        });
      }
      toastManager.close(loadingToast);
      pendingDraftWork.end(targetKey);
    },
  );

  useThreadContextDrop(composerFormRef, environmentId, attachmentTargetKey, (refs, isActive) => {
    const records = refs.flatMap((ref) => {
      // The agent reads a linked machine's thread itself, like the `@` picker's; any other
      // machine's comes in as its transcript.
      if (ref.environmentId !== environmentId && !linkedEnvironments.has(ref.environmentId)) {
        void importDroppedThread(
          ref,
          () => isActive() && attachmentTargetKeyRef.current === attachmentTargetKey,
        );
        return [];
      }
      const record = droppedThreadContextRecord(ref, readThreadShell(ref));
      return record ? [record] : [];
    });
    if (records.length === 0) return;
    if (questionAttachmentTarget !== null) {
      const canAnswer =
        canOperateThread &&
        !activePendingIsResponding &&
        activePendingProgress?.activeQuestion?.allowCustomAnswer !== false;
      const text = `${records
        .map((record) => formatInlineContextReference(threadContextReference(record)))
        .join(" ")} `;
      const snapshot = readComposerSnapshotStable();
      const cursor = snapshot.expandedCursor;
      const leadingSpace = cursor > 0 && !/\s/.test(snapshot.value[cursor - 1] ?? "");
      const inserted =
        canAnswer &&
        applyPromptReplacementStable(
          cursor,
          extendReplacementRangeForTrailingSpace(snapshot.value, cursor, text),
          leadingSpace ? ` ${text}` : text,
        );
      if (!inserted) {
        toastManager.add({
          type: "error",
          title: gt("Unable to add thread"),
          description: gt("The composer is busy; try again once it is ready."),
        });
        return;
      }
      addComposerDraftThreadContexts(questionAttachmentTarget, records, {
        appendReference: false,
      });
      if (isComposerCollapsedMobile) expandMobileComposerStable();
    } else {
      addComposerDraftThreadContexts(composerDraftTarget, records);
    }
  });

  const onComposerMentionDragLeaveCapture = (event: React.DragEvent<HTMLFormElement>) => {
    if (!dataTransferHasComposerMention(event.dataTransfer.types)) return;
    event.stopPropagation();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setIsDragOverComposer(false);
  };

  // Escape can cancel without dragleave; clear highlights on bubbling dragend.
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- window dragend listener clears the drop highlight when a drag is cancelled without dragleave
  useEffect(() => {
    if (!isDragOverComposer) return;
    const onWindowDragEnd = () => {
      setIsDragOverComposer(false);
    };
    window.addEventListener("dragend", onWindowDragEnd);
    return () => window.removeEventListener("dragend", onWindowDragEnd);
  }, [isDragOverComposer]);

  return {
    isDragOverComposer,
    pasteAsTextShortcutUntilRef,
    insertComposerTextStable,
    insertComposerTextAtEndStable,
    addComposerAttachments,
    removeComposerImage,
    foldPastedText,
    addComposerFoldersStable,
    onComposerPasteStable,
    composerMentionDragHandlers,
    onComposerMentionDragLeaveCapture,
  };
}
