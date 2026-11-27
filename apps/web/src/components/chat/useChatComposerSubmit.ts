import { useNavigate } from "@tanstack/react-router";
import { scopedThreadKey } from "@zerocode/client-runtime/environment";
import {
  type ComposerDispatchMode,
  resolveComposerDispatchMode,
} from "@zerocode/client-runtime/state/composer-dispatch";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationV2Run,
  type PreviewAnnotationPayload,
  type ProjectId,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
  type UnifiedSettings,
} from "@zerocode/contracts";
import { useGT } from "gt-react";
import { type Dispatch, type RefObject, type SetStateAction, useLayoutEffect, useRef } from "react";
import {
  collapseExpandedComposerCursor,
  type ComposerSubmissionIntent,
  type ComposerTrigger,
  composerSubmissionIntentForKey,
} from "../../composer-logic";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
  type DraftId,
  readComposerDraftPrompt,
  resolveLiveComposerDraftTarget,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import type { ShortcutMatchContext } from "../../keybindings";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { PendingUserInputProgress } from "../../pendingUserInput";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import type { PendingApproval, PendingUserInput, TimelineEntry } from "../../session-logic";
import { useDictationShortcut } from "../../speech/useDictationShortcut";
import { useDictationSubmissionShortcut } from "../../speech/useDictationSubmissionShortcut";
import { useEnvironmentSpeechInput } from "../../speech/useEnvironmentSpeechInput";
import { readEnvironmentScope } from "../../state/session";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../../threadRoutes";
import type { SessionPhase, Thread } from "../../types";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditorTiptap";
import { toastManager } from "../ui/toast";
import type { ChatComposerHandle, ChatComposerProps } from "./ChatComposer";
import { composerCommandKeyHandler } from "./composerCommandKey";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import type { ComposerPromptHistoryPosition } from "./composerPromptHistory";
import { isComposerSubmissionBlocked, submitComposerDraft } from "./composerSubmission";
import { useFreshSessionArmed } from "./freshSessionArms";
import { pendingDraftWork } from "./pendingDraftWork";
import {
  countPreparingComposerImages,
  useSubmitAfterPreparingImages,
} from "./preparingComposerImages";
import { usePromptSuggestion } from "./usePromptSuggestion";

interface ChatComposerSubmitInput {
  readonly environmentId: EnvironmentId;
  readonly routeKind: "server" | "draft";
  readonly routeThreadRef: ScopedThreadRef;
  readonly activeThreadId: ThreadId | null;
  readonly activeThread: Thread | undefined;
  readonly activeThreadRuns: ReadonlyArray<OrchestrationV2Run>;
  readonly activeProjectId: ProjectId | null;
  readonly projectName: string | undefined;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly composerDraftTargetKey: string;
  readonly attachmentTargetKey: string;
  readonly attachmentTargetKeyRef: RefObject<string>;
  readonly questionAttachmentTarget: DraftId | null;
  readonly prompt: string;
  readonly isLiteralPendingAnswer: boolean;
  readonly canOperateThread: boolean;
  readonly environmentUnavailable: ChatComposerProps["environmentUnavailable"];
  readonly projectSelectionRequired: boolean;
  readonly isComposerApprovalState: boolean;
  readonly activePendingApproval: PendingApproval | null;
  readonly activePendingProgress: PendingUserInputProgress | null;
  readonly hasActivePendingResolvedAnswers: boolean;
  readonly activePendingIsResponding: boolean;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly hiddenThread: boolean;
  readonly backgroundThread: boolean;
  readonly terminalOpen: boolean;
  readonly isComposerModelPickerOpen: boolean;
  readonly isComposerFooterCompact: boolean;
  readonly isSoftwareKeyboardOpen: boolean;
  readonly phase: SessionPhase;
  readonly isSendBusy: boolean;
  readonly canSteer: boolean;
  readonly followUpBehavior: "steer" | "queue";
  readonly noProviderAvailable: boolean;
  readonly sendDisabledReason: string | null;
  readonly attachmentBlockReason: string | null;
  readonly composerSendHeld: boolean;
  readonly cancelHeldSend: () => void;
  readonly hasMessageToSend: boolean;
  readonly showResumeAction: boolean;
  readonly compactDisabled: boolean;
  readonly settings: UnifiedSettings;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly getShortcutContext: (eventTarget: EventTarget | null) => ShortcutMatchContext;
  readonly promptHistoryEntries: ReadonlyArray<TimelineEntry>;
  readonly composerPreviewAnnotations: PreviewAnnotationPayload[];
  readonly composerReviewComments: ReviewCommentContext[];
  readonly hasComposerContextRecords: boolean;
  readonly showProviderUnavailable: boolean;
  readonly composerMountedRef: RefObject<boolean>;
  readonly composerFormRef: RefObject<HTMLFormElement | null>;
  readonly composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly composerBlurFrameRef: RefObject<number | null>;
  readonly providerInputRejectedRef: RefObject<boolean>;
  readonly promptRef: RefObject<string>;
  readonly promptHistoryPositionRef: RefObject<{
    targetKey: string;
    position: ComposerPromptHistoryPosition;
  } | null>;
  readonly composerImagesRef: RefObject<ComposerImageAttachment[]>;
  readonly composerFilesRef: RefObject<ComposerFileAttachment[]>;
  readonly composerTerminalContextsRef: RefObject<TerminalContextDraft[]>;
  readonly composerMenuItemsRef: RefObject<ComposerCommandItem[]>;
  readonly activeComposerMenuItemRef: RefObject<ComposerCommandItem | null>;
  readonly setPrompt: (prompt: string) => void;
  readonly setComposerCursor: Dispatch<SetStateAction<number>>;
  readonly setComposerTrigger: (trigger: ComposerTrigger | null) => void;
  readonly setIsComposerFocused: Dispatch<SetStateAction<boolean>>;
  readonly setComposerSubmissionError: Dispatch<SetStateAction<string | null>>;
  readonly dismissComposerTrigger: (candidate: ComposerTrigger | null) => void;
  readonly clearComposerMenuHighlight: () => void;
  readonly nudgeComposerMenuHighlight: (key: "ArrowDown" | "ArrowUp") => void;
  readonly readComposerSnapshot: () => {
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
    },
  ) => boolean;
  readonly resolveActiveComposerTrigger: () => {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  };
  readonly onSelectComposerItem: (item: ComposerCommandItem) => void;
  readonly onTypingGuardSend: () => void;
  readonly onSend: ChatComposerProps["onSend"];
  readonly captureDetachedSend: ChatComposerProps["captureDetachedSend"];
  readonly onResume: () => void;
  readonly onCompactContext: () => void;
}

export function useChatComposerSubmit(input: ChatComposerSubmitInput) {
  const {
    environmentId,
    routeKind,
    routeThreadRef,
    activeThreadId,
    activeThread,
    activeThreadRuns,
    activeProjectId,
    projectName,
    composerDraftTarget,
    composerDraftTargetKey,
    attachmentTargetKey,
    attachmentTargetKeyRef,
    questionAttachmentTarget,
    prompt,
    isLiteralPendingAnswer,
    canOperateThread,
    environmentUnavailable,
    projectSelectionRequired,
    isComposerApprovalState,
    activePendingApproval,
    activePendingProgress,
    hasActivePendingResolvedAnswers,
    activePendingIsResponding,
    pendingUserInputs,
    hiddenThread,
    backgroundThread,
    terminalOpen,
    isComposerModelPickerOpen,
    isComposerFooterCompact,
    isSoftwareKeyboardOpen,
    phase,
    isSendBusy,
    canSteer,
    followUpBehavior,
    noProviderAvailable,
    sendDisabledReason,
    attachmentBlockReason,
    composerSendHeld,
    cancelHeldSend,
    hasMessageToSend,
    showResumeAction,
    compactDisabled,
    settings,
    keybindings,
    getShortcutContext,
    promptHistoryEntries,
    composerPreviewAnnotations,
    composerReviewComments,
    hasComposerContextRecords,
    showProviderUnavailable,
    composerMountedRef,
    composerFormRef,
    composerEditorRef,
    composerRef,
    composerBlurFrameRef,
    providerInputRejectedRef,
    promptRef,
    promptHistoryPositionRef,
    composerImagesRef,
    composerFilesRef,
    composerTerminalContextsRef,
    composerMenuItemsRef,
    activeComposerMenuItemRef,
    setPrompt,
    setComposerCursor,
    setComposerTrigger,
    setIsComposerFocused,
    setComposerSubmissionError,
    dismissComposerTrigger,
    clearComposerMenuHighlight,
    nudgeComposerMenuHighlight,
    readComposerSnapshot,
    applyPromptReplacement,
    resolveActiveComposerTrigger,
    onSelectComposerItem,
    onTypingGuardSend,
    onSend,
    captureDetachedSend,
    onResume,
    onCompactContext,
  } = input;
  const gt = useGT();
  const navigate = useNavigate();
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftThreadContexts = useComposerDraftStore((store) => store.setThreadContexts);
  const setComposerDraftEnvironmentContexts = useComposerDraftStore(
    (store) => store.setEnvironmentContexts,
  );

  const dictationDisabled =
    !canOperateThread ||
    environmentUnavailable !== null ||
    projectSelectionRequired ||
    isComposerApprovalState ||
    activePendingIsResponding ||
    activePendingProgress?.activeQuestion?.allowCustomAnswer === false;
  const speechInput = useEnvironmentSpeechInput({
    environmentId,
    projectId: activeProjectId,
    projectName,
    ownerKey: questionAttachmentTarget ?? composerDraftTargetKey,
    disabled: dictationDisabled,
    label: activeThread?.title ?? null,
    presented: !hiddenThread,
    // A question's answer lives only in this composer, so only the thread draft outlives it.
    persistentDraft: questionAttachmentTarget
      ? undefined
      : {
          readStoredText: () => readComposerDraftPrompt(composerDraftTarget),
          commitStoredText: (text) => {
            const live = resolveLiveComposerDraftTarget(composerDraftTarget);
            if (live !== null) setComposerDraftPrompt(live, text);
          },
          // The route, not the draft target: a queued-message edit has a draft id but no route.
          open: () =>
            void (routeKind === "draft" && typeof composerDraftTarget === "string"
              ? navigate({
                  to: "/draft/$draftId",
                  params: buildDraftThreadRouteParams(composerDraftTarget),
                })
              : navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(routeThreadRef),
                })),
        },
    readDraft: () => {
      const snapshot = readComposerSnapshot();
      return {
        text: snapshot.value,
        selection: composerEditorRef.current?.readSelectionRange() ?? {
          start: snapshot.expandedCursor,
          end: snapshot.expandedCursor,
        },
      };
    },
    commitDraft: (text, selection) => {
      const snapshot = readComposerSnapshot();
      const applied = applyPromptReplacement(0, snapshot.value.length, text, {
        expectedText: snapshot.value,
        focusEditorAfterReplace: false,
      });
      if (!applied) return;
      const cursor = collapseExpandedComposerCursor(text, selection.start, isLiteralPendingAnswer);
      setComposerCursor(cursor);
      window.requestAnimationFrame(() => composerEditorRef.current?.focusAt(cursor));
    },
  });
  const { blocksSubmission: voiceInputActive, submitAfterDictation } = speechInput;
  // A compact footer gives the dictation capsule the whole row beside the send button.
  const dictationTakesFooter = isComposerFooterCompact && speechInput.state.phase !== "idle";
  const submissionTarget = activePendingProgress ? "pending-user-input" : "provider-turn";
  const submissionBlocked = isComposerSubmissionBlocked({
    submissionTarget,
    noProviderAvailable,
    sendDisabledReason,
    attachmentBlockReason,
    environmentUnavailable: environmentUnavailable !== null,
  });
  const submitAfterPreparingImages = useSubmitAfterPreparingImages(
    attachmentTargetKey,
    submissionBlocked,
  );
  // The pending Submit button follows the answer's own blockers, matching submitComposer.
  const primaryActionSendDisabledReason =
    (activePendingProgress ? attachmentBlockReason : sendDisabledReason) ??
    (speechInput.preparing ? gt("Preparing voice input") : null);
  const primaryActionEnvironmentUnavailable =
    environmentUnavailable !== null ||
    (!activePendingProgress && (noProviderAvailable || projectSelectionRequired));
  const dictationShortcutLabel = useDictationShortcut({
    keybindings,
    speech: speechInput,
    disabled: dictationDisabled,
    terminalOpen,
    modelPickerOpen: isComposerModelPickerOpen,
    ...(backgroundThread ? { targetRef: composerFormRef } : {}),
  });

  const blurMobileComposerAfterSend = () => {
    if (!isSoftwareKeyboardOpen) return;
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
    setIsComposerFocused(false);
  };

  const shouldBlurMobileComposerOnSubmit = () => {
    if (!isSoftwareKeyboardOpen) return false;
    if (isSendBusy || submissionBlocked || environmentUnavailable !== null || phase === "running") {
      return false;
    }
    if (activePendingProgress) {
      return activePendingProgress.isLastQuestion && hasActivePendingResolvedAnswers;
    }
    return hasMessageToSend;
  };

  const submitComposerRef = useRef<
    (
      dispatchMode?: ComposerDispatchMode,
      submissionIntent?: ComposerSubmissionIntent,
      options?: { readonly afterDictation?: boolean },
    ) => void
  >(() => {});
  const submitComposer = (
    event?: { preventDefault: () => void },
    dispatchMode?: ComposerDispatchMode,
    submissionIntent?: ComposerSubmissionIntent,
    options?: { readonly afterDictation?: boolean },
  ) => {
    if (voiceInputActive && !options?.afterDictation) {
      event?.preventDefault();
      const queuedOwnerKey = attachmentTargetKey;
      const capturedDraftTarget = composerDraftTarget;
      const resolvedDispatchMode =
        dispatchMode ??
        resolveComposerDispatchMode({
          running: phase === "running" || phase === "connecting",
          alternateModifier: false,
          activeTurnDefault: followUpBehavior,
          canSteer,
        });
      const capturedDetachedSend =
        questionAttachmentTarget === null ? (captureDetachedSend?.() ?? null) : null;
      const capturedSendContext =
        capturedDetachedSend !== null ? (composerRef.current?.getSendContext() ?? null) : null;
      const capturedSubmissionTarget = submissionTarget;
      submitAfterDictation((transcribedText) => {
        const stillLive =
          composerMountedRef.current && attachmentTargetKeyRef.current === queuedOwnerKey;
        if (stillLive) {
          submitComposerRef.current(dispatchMode, submissionIntent, { afterDictation: true });
          return;
        }
        if (
          !capturedDetachedSend ||
          !capturedSendContext ||
          pendingDraftWork.has(queuedOwnerKey) ||
          countPreparingComposerImages(queuedOwnerKey) > 0
        ) {
          return;
        }
        const liveTarget = resolveLiveComposerDraftTarget(capturedDraftTarget);
        const latestDraft =
          liveTarget !== null
            ? useComposerDraftStore.getState().getComposerDraft(liveTarget)
            : null;
        submitComposerDraft({
          prompt: transcribedText,
          submissionTarget: capturedSubmissionTarget,
          event: undefined,
          onSend: (sendEvent) => {
            capturedDetachedSend(sendEvent, resolvedDispatchMode, submissionIntent, undefined, {
              prompt: transcribedText,
              sendContext: {
                ...capturedSendContext,
                ...(latestDraft
                  ? {
                      images: latestDraft.images,
                      files: latestDraft.files,
                      terminalContexts: latestDraft.terminalContexts,
                      previewAnnotations: latestDraft.previewAnnotations,
                      reviewComments: latestDraft.reviewComments,
                      threadContexts: latestDraft.threadContexts,
                      environmentContexts: latestDraft.environmentContexts,
                    }
                  : {}),
                prompt: transcribedText,
              },
            });
            return true;
          },
        });
      });
      return false;
    }
    if (submissionBlocked || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      event?.preventDefault();
      return false;
    }
    if (composerSendHeld) {
      event?.preventDefault();
      return false;
    }
    // Sending now would leave a still-compressing image out of the answer, so wait for it.
    if (
      activeThreadId &&
      questionAttachmentTarget &&
      submitAfterPreparingImages(() => submitComposerRef.current(dispatchMode, submissionIntent))
    ) {
      event?.preventDefault();
      return false;
    }
    if (pendingDraftWork.has(attachmentTargetKey)) {
      event?.preventDefault();
      toastManager.add({
        type: "info",
        title: gt("Still bringing attached context into this message."),
        description: gt("Send again once its chip resolves."),
      });
      return false;
    }
    // An empty draft has nothing to send; Enter does what the Resume thread button does.
    if (showResumeAction && !activePendingProgress && promptRef.current.trim().length === 0) {
      event?.preventDefault();
      if (isSendBusy || environmentUnavailable !== null) return false;
      onResume();
      return true;
    }
    const submission = submitComposerDraft({
      prompt: promptRef.current,
      submissionTarget,
      event,
      onSend: (sendEvent) => {
        providerInputRejectedRef.current = false;
        onSend(
          sendEvent,
          dispatchMode ??
            resolveComposerDispatchMode({
              running: phase === "running" || phase === "connecting",
              alternateModifier: false,
              activeTurnDefault: followUpBehavior,
              canSteer,
            }),
          submissionIntent,
        );
        return !providerInputRejectedRef.current;
      },
    });
    setComposerSubmissionError(submission.validationMessage);
    if (!submission.didDispatch) return false;
    onTypingGuardSend();
    if (shouldBlurMobileComposerOnSubmit()) {
      blurMobileComposerAfterSend();
    }
    return true;
  };
  const submitComposerStable = useStableCallback(submitComposer);
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- publishes the committed submission handler to the asynchronous dictation completion
  useLayoutEffect(() => {
    submitComposerRef.current = (mode, intent, options) =>
      submitComposerStable(undefined, mode, intent, options);
  }, [submitComposerStable]);
  useDictationSubmissionShortcut({
    enabled: voiceInputActive && !speechInput.preparing,
    formRef: composerFormRef,
    onKeyDown: (event) => {
      const intent = composerSubmissionIntentForKey({
        event,
        keybindings,
        context: getShortcutContext(event.target),
        isSoftwareKeyboardOpen,
        isDraftThread: routeKind === "draft",
        isRunning: phase === "running" || phase === "connecting",
        sendShortcut: settings.sendShortcut,
        prompt: promptRef.current,
      });
      if (!intent) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      submitComposer(
        undefined,
        resolveComposerDispatchMode({
          running: phase === "running" || phase === "connecting",
          alternateModifier: intent === "alternate",
          canSteer,
          activeTurnDefault: followUpBehavior,
        }),
        intent,
      );
    },
  });

  const handleSubmitMessage = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const running = phase === "running" || phase === "connecting";
    const alternateModifier = event.metaKey || event.ctrlKey;
    submitComposer(
      event,
      resolveComposerDispatchMode({
        running,
        alternateModifier,
        activeTurnDefault: followUpBehavior,
        canSteer,
      }),
      running && alternateModifier ? "alternate" : undefined,
    );
  };
  const handleSubmitMessageStable = useStableCallback(handleSubmitMessage);
  const submitCitationAndSend = () => {
    return submitComposer(
      undefined,
      resolveComposerDispatchMode({
        running: phase === "running" || phase === "connecting",
        alternateModifier: false,
        activeTurnDefault: followUpBehavior,
        canSteer,
      }),
    );
  };
  const submitCitationAndSendStable = useStableCallback(submitCitationAndSend);
  // A question took the editor while a citation comment was
  // unsaved. Keep the comment in the prompt that comes back afterward.
  const saveCitationDraftToPrompt = (replacedValue: string, savedValue: string) => {
    if (replacedValue !== prompt) return;
    if (promptRef.current === replacedValue) promptRef.current = savedValue;
    setPrompt(savedValue);
  };
  const saveCitationDraftToPromptStable = useStableCallback(saveCitationDraftToPrompt);
  const compactThreadContext = () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      compactDisabled ||
      noProviderAvailable ||
      activePendingApproval !== null ||
      pendingUserInputs.length > 0 ||
      phase === "running" ||
      isSendBusy ||
      !activeThreadId
    ) {
      return;
    }
    onCompactContext();
  };
  const compactThreadContextStable = useStableCallback(compactThreadContext);

  // Escape dismisses the suggestion so Tab moves focus again.
  const { suggestion: promptSuggestion, dismiss: dismissPromptSuggestion } = usePromptSuggestion(
    environmentId,
    activeThread,
    activeThreadRuns,
  );
  // After /clear the next message starts a fresh session that cannot see what the suggestion refers to.
  const freshSessionArmed = useFreshSessionArmed(scopedThreadKey(routeThreadRef));
  // Offered only where the default placeholder would show, so it never hides a pending question.
  const offeredPromptSuggestion =
    phase !== "running" &&
    !isSendBusy &&
    !freshSessionArmed &&
    !speechInput.freezesEditor &&
    !hasComposerContextRecords &&
    !isComposerApprovalState &&
    !activePendingProgress &&
    !projectSelectionRequired &&
    !showProviderUnavailable
      ? promptSuggestion
      : null;

  const onComposerCommandKey = (key: string, event: KeyboardEvent, isTaskItem?: boolean) => {
    if (key === "Escape" && composerSendHeld && !event.isComposing) {
      cancelHeldSend();
      return true;
    }
    return composerCommandKeyHandler({
      keybindings,
      getShortcutContext,
      sendShortcut: settings.sendShortcut,
      routeKind,
      phase,
      canSteer,
      followUpBehavior,
      isSoftwareKeyboardOpen,
      isLiteralPendingAnswer,
      pendingUserInputs,
      promptHistoryEntries,
      promptHistoryPositionRef,
      composerDraftTarget,
      promptRef,
      composerImagesRef,
      composerFilesRef,
      composerTerminalContextsRef,
      composerPreviewAnnotations,
      composerReviewComments,
      composerEditorRef,
      composerMenuItemsRef,
      activeComposerMenuItemRef,
      setComposerDraftPrompt,
      setComposerDraftThreadContexts,
      setComposerDraftEnvironmentContexts,
      setComposerCursor,
      setComposerTrigger,
      setComposerHighlightedItemId: (next) => {
        if (next === null) clearComposerMenuHighlight();
      },
      dismissComposerTrigger,
      nudgeComposerMenuHighlight,
      onSelectComposerItem,
      resolveActiveComposerTrigger,
      readComposerSnapshot,
      applyPromptReplacement,
      submitComposer,
      promptSuggestion: offeredPromptSuggestion,
      dismissPromptSuggestion,
    })(key, event, isTaskItem);
  };
  const onComposerCommandKeyStable = useStableCallback(onComposerCommandKey);

  return {
    dictationDisabled,
    speechInput,
    voiceInputActive,
    dictationTakesFooter,
    primaryActionSendDisabledReason,
    primaryActionEnvironmentUnavailable,
    dictationShortcutLabel,
    submitComposer,
    submitComposerStable,
    handleSubmitMessageStable,
    submitCitationAndSendStable,
    saveCitationDraftToPromptStable,
    compactThreadContextStable,
    onComposerCommandKeyStable,
    offeredPromptSuggestion,
  };
}
