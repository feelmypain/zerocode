import type {
  EnvironmentContextRecord,
  ModelSelection,
  PreviewAnnotationPayload,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ThreadContextRecord,
} from "@zerocode/contracts";
import { msg } from "gt-react";
import { type Dispatch, type RefObject, type SetStateAction, useImperativeHandle } from "react";
import { flushSync } from "react-dom";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { terminalContextReference } from "~/lib/composerContextRecords";
import { insertInlineContextReference } from "~/lib/composerContextReferences";
import { randomUUID } from "~/lib/utils";
import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  type ComposerTrigger,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  formatAssistantCitationForComposer,
} from "../../composer-logic";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { m as resolveMessage } from "../../i18n/messages";
import type { TerminalContextDraft, TerminalContextSelection } from "../../lib/terminalContext";
import type { PendingUserInputProgress } from "../../pendingUserInput";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import type { PendingApproval, PendingUserInput } from "../../session-logic";
import type { Thread } from "../../types";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditorTiptap";
import { toastManager } from "../ui/toast";
import type { ChatComposerHandle, ChatComposerProps } from "./ChatComposer";
import type { ComposerCommandMenuControllerHandle } from "./ComposerCommandMenuController";
import { markOpenToEffort, markOpenToPermissions } from "./composerEventScope";
import { getComposerReasoningStep } from "./composerProviderState";
import { getComposerSubmissionValidationMessage } from "./composerSubmission";
import { pendingDraftWork } from "./pendingDraftWork";
import { countPreparingComposerImages } from "./preparingComposerImages";
import { useApplyThreadModelPick } from "./useApplyThreadModelPick";
import { consumePasteAsTextShortcut } from "./useChatComposerAttachments";
import type { useComposerProviderModel } from "./useComposerProviderModel";

interface ChatComposerImperativeHandleInput {
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly composerFormRef: RefObject<HTMLFormElement | null>;
  readonly composerBlurFrameRef: RefObject<number | null>;
  readonly composerMenuControllerRef: RefObject<ComposerCommandMenuControllerHandle | null>;
  readonly pasteAsTextShortcutUntilRef: RefObject<number>;
  readonly providerInputRejectedRef: RefObject<boolean>;
  readonly promptRef: RefObject<string>;
  readonly composerImagesRef: RefObject<ComposerImageAttachment[]>;
  readonly composerFilesRef: RefObject<ComposerFileAttachment[]>;
  readonly composerTerminalContextsRef: RefObject<TerminalContextDraft[]>;
  readonly activeThread: Thread | undefined;
  readonly routeKind: "server" | "draft";
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly attachmentTargetKey: string;
  readonly isLiteralPendingAnswer: boolean;
  readonly isEditingQueuedMessage: boolean;
  readonly projectSelectionRequired: boolean;
  readonly speechFreezesEditor: boolean;
  readonly isComposerModelPickerOpen: boolean;
  readonly activePendingProgress: PendingUserInputProgress | null;
  readonly pendingApprovals: ReadonlyArray<PendingApproval>;
  readonly heldRequestIds: ReadonlySet<string>;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly composerTerminalContexts: TerminalContextDraft[];
  readonly composerPreviewAnnotations: PreviewAnnotationPayload[];
  readonly composerReviewComments: ReviewCommentContext[];
  readonly composerThreadContexts: ThreadContextRecord[];
  readonly composerEnvironmentContexts: EnvironmentContextRecord[];
  readonly selectedProvider: ProviderDriverKind;
  readonly selectedInstanceId: ProviderInstanceId;
  readonly selectedModel: string;
  readonly selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
  readonly composerModelOptions: ReturnType<
    typeof useComposerProviderModel
  >["composerModelOptions"];
  readonly reportedModelSelection: ModelSelection | null | undefined;
  readonly selectedPromptEffort: string | null;
  readonly selectedModelSelection: ModelSelection;
  readonly multipleModelSelections: ReadonlyArray<ModelSelection> | null;
  readonly setMultipleModelSelections: ChatComposerProps["onMultipleModelSelectionsChange"];
  readonly noProviderAvailable: boolean;
  readonly providerSendBlockReason: string | null;
  readonly setComposerCursor: Dispatch<SetStateAction<number>>;
  readonly setComposerTrigger: (trigger: ComposerTrigger | null) => void;
  readonly resetComposerTrigger: (trigger: ComposerTrigger | null) => void;
  readonly setIsComposerFocused: Dispatch<SetStateAction<boolean>>;
  readonly setIsComposerModelPickerOpen: Dispatch<SetStateAction<boolean>>;
  readonly setProviderInputSubmissionError: Dispatch<SetStateAction<string | null>>;
  readonly addComposerAttachments: (
    files: File[],
    options?: { skipImageInlineChip?: boolean },
  ) => Promise<boolean>;
  readonly addComposerFoldersStable: (folders: File[]) => void;
  readonly foldPastedText: (
    text: string,
    bypassAutoAttachment: boolean,
    selection?: { start: number; end: number },
  ) => boolean;
  readonly insertComposerTextStable: (
    text: string,
    position: "cursor" | "end",
    options?: {
      ensureLeadingBoundary?: boolean;
      citationCommentAnchor?: AssistantCitationSourceAnchor;
      clipboardData?: DataTransfer;
    },
  ) => boolean;
  readonly insertComposerTextAtEndStable: ChatComposerHandle["insertTextAtEnd"];
  readonly applyPromptReplacementStable: (
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
    options?: {
      expectedText?: string;
      expandedCursorAfterReplace?: number;
      focusEditorAfterReplace?: boolean;
    },
  ) => boolean;
  readonly readComposerSnapshotStable: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  };
  readonly openModelPickerStable: () => void;
  readonly compactThreadContextStable: () => void;
  readonly focusComposer: () => void;
}

export function useChatComposerImperativeHandle(input: ChatComposerImperativeHandleInput) {
  const {
    composerRef,
    composerEditorRef,
    composerFormRef,
    composerBlurFrameRef,
    composerMenuControllerRef,
    pasteAsTextShortcutUntilRef,
    providerInputRejectedRef,
    promptRef,
    composerImagesRef,
    composerFilesRef,
    composerTerminalContextsRef,
    activeThread,
    routeKind,
    composerDraftTarget,
    attachmentTargetKey,
    isLiteralPendingAnswer,
    isEditingQueuedMessage,
    projectSelectionRequired,
    speechFreezesEditor,
    isComposerModelPickerOpen,
    activePendingProgress,
    pendingApprovals,
    heldRequestIds,
    pendingUserInputs,
    composerTerminalContexts,
    composerPreviewAnnotations,
    composerReviewComments,
    composerThreadContexts,
    composerEnvironmentContexts,
    selectedProvider,
    selectedInstanceId,
    selectedModel,
    selectedProviderModels,
    composerModelOptions,
    reportedModelSelection,
    selectedPromptEffort,
    selectedModelSelection,
    multipleModelSelections,
    setMultipleModelSelections,
    noProviderAvailable,
    providerSendBlockReason,
    setComposerCursor,
    setComposerTrigger,
    resetComposerTrigger,
    setIsComposerFocused,
    setIsComposerModelPickerOpen,
    setProviderInputSubmissionError,
    addComposerAttachments,
    addComposerFoldersStable,
    foldPastedText,
    insertComposerTextStable,
    insertComposerTextAtEndStable,
    applyPromptReplacementStable,
    readComposerSnapshotStable,
    openModelPickerStable,
    compactThreadContextStable,
    focusComposer,
  } = input;

  const applyThreadModelPick = useApplyThreadModelPick();
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const setComposerDraftReplyTo = useComposerDraftStore((store) => store.setReplyTo);

  useImperativeHandle(
    composerRef,
    () => ({
      focusAtEnd: () => {
        composerEditorRef.current?.focusAtEnd();
      },
      focusAt: (cursor: number) => {
        composerEditorRef.current?.focusAt(cursor);
      },
      addDroppedFiles: (files: File[]) => {
        void addComposerAttachments(files).then((inserted) => {
          if (!inserted) focusComposer();
        });
      },
      addDroppedFolders: addComposerFoldersStable,
      hasPendingAttachments: () =>
        countPreparingComposerImages(attachmentTargetKey) > 0 ||
        pendingDraftWork.has(attachmentTargetKey),
      insertTextAtEnd: insertComposerTextAtEndStable,
      pasteTextAtEnd: (text: string, options) => {
        if (speechFreezesEditor) return false;
        const shortcutArmed = consumePasteAsTextShortcut(pasteAsTextShortcutUntilRef);
        const bypassAutoAttachment = options?.bypassAutoAttachment === true || shortcutArmed;
        const promptLength = promptRef.current.length;
        if (
          !foldPastedText(text, bypassAutoAttachment, {
            start: promptLength,
            end: promptLength,
          })
        ) {
          return false;
        }
        focusComposer();
        return true;
      },
      citeAssistantText: (citation, sourceAnchor) =>
        insertComposerTextStable(
          formatAssistantCitationForComposer(citation, citation.comment),
          "cursor",
          { ensureLeadingBoundary: true, citationCommentAnchor: sourceAnchor },
        ),
      replyToResponse: (response) => {
        // An open question owns the composer, and its answer would not carry the reply.
        if (pendingUserInputs.length > 0 || projectSelectionRequired) return false;
        setComposerDraftReplyTo(composerDraftTarget, response);
        focusComposer();
        return true;
      },
      openModelPicker: openModelPickerStable,
      stepReasoningEffort: (direction) => {
        if (noProviderAvailable || pendingUserInputs.length > 0 || isEditingQueuedMessage) {
          return;
        }
        const change = getComposerReasoningStep({
          provider: selectedProvider,
          instanceId: selectedInstanceId,
          model: selectedModel,
          models: selectedProviderModels,
          modelOptions: composerModelOptions?.[selectedInstanceId],
          reportedModelSelection,
          prompt: promptRef.current,
          cursor: readComposerSnapshotStable().expandedCursor,
          direction,
        });
        if (!change) return;
        useComposerDraftStore
          .getState()
          .setProviderModelOptions(composerDraftTarget, selectedProvider, change.modelOptions, {
            instanceId: selectedInstanceId,
            model: selectedModel,
            persistSticky: true,
          });
        applyThreadModelPick(composerDraftTarget);
        if (change.prompt !== promptRef.current) {
          applyPromptReplacementStable(0, promptRef.current.length, change.prompt, {
            expandedCursorAfterReplace: change.cursor,
          });
        }
      },
      toggleModelPicker: () => {
        if (isComposerModelPickerOpen) {
          setIsComposerModelPickerOpen(false);
        } else {
          openModelPickerStable();
        }
      },
      openControl: (command) => {
        if (composerBlurFrameRef.current !== null) {
          window.cancelAnimationFrame(composerBlurFrameRef.current);
          composerBlurFrameRef.current = null;
        }
        flushSync(() => setIsComposerFocused(true));
        const shell = composerFormRef.current?.closest('[data-slot="composer-shell"]');
        const trigger = Array.from(
          shell?.querySelectorAll<HTMLButtonElement>(
            `button[data-composer-shortcut~="${command}"]:not(:disabled)`,
          ) ?? [],
        ).find(
          (element) =>
            !element.closest("[inert]") && element.checkVisibility({ visibilityProperty: true }),
        );
        if (!trigger) return;
        trigger.focus({ preventScroll: true });
        if (command === "composer.mode") markOpenToPermissions(trigger);
        if (command === "composer.effort") markOpenToEffort(trigger);
        trigger.click();
      },
      compactContext: compactThreadContextStable,
      isModelPickerOpen: () => isComposerModelPickerOpen,
      isCaretAtStart: () => {
        const range = composerEditorRef.current?.readSelectionRange();
        return range !== undefined && range.start === 0 && range.end === 0;
      },
      readSnapshot: () => {
        return readComposerSnapshotStable();
      },
      resetCursorState: (options?: {
        cursor?: number;
        prompt?: string;
        detectTrigger?: boolean;
      }) => {
        const promptForState = options?.prompt ?? promptRef.current;
        const cursor = clampCollapsedComposerCursor(
          promptForState,
          options?.cursor ?? 0,
          isLiteralPendingAnswer,
        );
        composerMenuControllerRef.current?.clearHighlight();
        setComposerCursor(cursor);
        resetComposerTrigger(
          options?.detectTrigger && !isLiteralPendingAnswer
            ? detectComposerTrigger(
                promptForState,
                expandCollapsedComposerCursor(promptForState, cursor),
              )
            : null,
        );
      },
      addTerminalContext: (selection: TerminalContextSelection) => {
        if (!activeThread) return;
        // Answers are plain text, so a terminal excerpt cannot ride along with one. Writing it
        // to the thread draft instead would hide it until the question closes.
        if (activePendingProgress) {
          toastManager.add({
            type: "info",
            title: resolveMessage(msg("Terminal output can't be added to a question answer.")),
            description: resolveMessage(
              msg("Answer or dismiss the question first, then add it to chat."),
            ),
          });
          return;
        }
        const snapshot = readComposerSnapshotStable();
        const context = {
          id: randomUUID(),
          threadId: activeThread.id,
          createdAt: new Date().toISOString(),
          ...selection,
        };
        const insertion = insertInlineContextReference(
          snapshot.value,
          snapshot.expandedCursor,
          terminalContextReference(context),
        );
        const nextCollapsedCursor = collapseExpandedComposerCursor(
          insertion.prompt,
          insertion.cursor,
        );
        const inserted = insertComposerDraftTerminalContext(
          composerDraftTarget,
          insertion.prompt,
          context,
          composerTerminalContexts.length,
        );
        if (!inserted) return;
        promptRef.current = insertion.prompt;
        setComposerCursor(nextCollapsedCursor);
        setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAt(nextCollapsedCursor);
        });
      },
      getSendContext: () => ({
        answeringPendingUserInput: activePendingProgress !== null,
        shownPendingApprovalIds: pendingApprovals
          .map((approval) => approval.requestId)
          .filter((requestId) => !heldRequestIds.has(requestId)),
        prompt: promptRef.current,
        images: composerImagesRef.current,
        files: composerFilesRef.current,
        terminalContexts: composerTerminalContextsRef.current,
        previewAnnotations: composerPreviewAnnotations,
        reviewComments: composerReviewComments,
        threadContexts: composerThreadContexts,
        environmentContexts: composerEnvironmentContexts,
        selectedPromptEffort,
        selectedModelSelection,
        multipleModelSelections:
          routeKind === "draft" && multipleModelSelections !== null
            ? multipleModelSelections.map((selection) =>
                selection.instanceId === selectedModelSelection.instanceId &&
                selection.model === selectedModelSelection.model
                  ? selectedModelSelection
                  : selection,
              )
            : null,
        providerAvailable:
          multipleModelSelections !== null ||
          (!noProviderAvailable && providerSendBlockReason === null),
        selectedProvider,
        selectedModel,
        selectedProviderModels,
      }),
      setMultipleModelSelections,
      validateProviderInput: (providerInput: string) => {
        const validationMessage = getComposerSubmissionValidationMessage({
          prompt: promptRef.current,
          providerInput,
          submissionTarget: "provider-turn",
        });
        providerInputRejectedRef.current = validationMessage !== null;
        setProviderInputSubmissionError(validationMessage);
        return validationMessage === null;
      },
    }),
    [
      activeThread,
      attachmentTargetKey,
      addComposerAttachments,
      addComposerFoldersStable,
      applyThreadModelPick,
      foldPastedText,
      composerDraftTarget,
      composerModelOptions,
      isEditingQueuedMessage,
      activePendingProgress,
      pendingApprovals,
      heldRequestIds,
      composerTerminalContexts,
      insertComposerDraftTerminalContext,
      setComposerDraftReplyTo,
      insertComposerTextStable,
      insertComposerTextAtEndStable,
      composerEditorRef,
      composerFormRef,
      composerBlurFrameRef,
      composerMenuControllerRef,
      pasteAsTextShortcutUntilRef,
      providerInputRejectedRef,
      promptRef,
      composerImagesRef,
      composerFilesRef,
      composerTerminalContextsRef,
      composerPreviewAnnotations,
      composerReviewComments,
      composerThreadContexts,
      composerEnvironmentContexts,
      focusComposer,
      isLiteralPendingAnswer,
      pendingUserInputs.length,
      projectSelectionRequired,
      speechFreezesEditor,
      applyPromptReplacementStable,
      isComposerModelPickerOpen,
      openModelPickerStable,
      readComposerSnapshotStable,
      resetComposerTrigger,
      setComposerCursor,
      setComposerTrigger,
      setIsComposerFocused,
      setIsComposerModelPickerOpen,
      setProviderInputSubmissionError,
      selectedModel,
      selectedInstanceId,
      reportedModelSelection,
      selectedModelSelection,
      multipleModelSelections,
      setMultipleModelSelections,
      routeKind,
      noProviderAvailable,
      providerSendBlockReason,
      selectedPromptEffort,
      selectedProvider,
      selectedProviderModels,
      compactThreadContextStable,
    ],
  );
}
