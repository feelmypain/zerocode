import type {
  EnvironmentId,
  PreviewAnnotationPayload,
  ProviderDriverKind,
  ScopedThreadRef,
  ThreadId,
} from "@zerocode/contracts";
import { useMessages } from "gt-react";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { observeResize } from "~/lib/observeResize";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  composerStateAtPromptEnd,
} from "../../composer-logic";
import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
  DraftId,
} from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { PendingUserInputProgress } from "../../pendingUserInput";
import {
  questionAttachmentDraftId,
  trackOpenQuestionAttachmentDraft,
} from "../../questionAttachments";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import type { PendingUserInput } from "../../session-logic";
import {
  shouldUseCompactComposerFooter,
  shouldUseCompactComposerPrimaryActions,
} from "../composerFooterLayout";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditorTiptap";
import type { ComposerCommandMenuControllerHandle } from "./ComposerCommandMenuController";
import { isInsideRestingComposerControlScope } from "./composerEventScope";
import { getComposerPromptLengthValidationMessage } from "./composerSubmission";

interface ChatComposerUiStateInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly activeThreadId: ThreadId | null;
  readonly draftId: DraftId | null;
  readonly prompt: string;
  readonly isLiteralPendingAnswer: boolean;
  readonly composerDraftTargetKey: string;
  readonly attachmentTargetKey: string;
  readonly attachmentTargetKeyRef: RefObject<string>;
  readonly questionAttachmentTarget: DraftId | null;
  readonly questionRequest: PendingUserInput | undefined;
  readonly questionTakesSnapShots: boolean;
  readonly activePendingUserInput: PendingUserInput | null;
  readonly activePendingProgress: PendingUserInputProgress | null;
  readonly isRevertingCheckpoint: boolean;
  readonly composerFooterHasWideActions: boolean;
  readonly isMobileViewport: boolean;
  readonly composerImages: ComposerImageAttachment[];
  readonly composerFiles: ComposerFileAttachment[];
  readonly composerTerminalContexts: TerminalContextDraft[];
  readonly composerPreviewAnnotations: PreviewAnnotationPayload[];
  readonly composerReviewComments: ReviewCommentContext[];
  readonly selectedModel: string;
  readonly selectedPromptEffort: string | null;
  readonly selectedProvider: ProviderDriverKind;
  readonly setComposerCursor: Dispatch<SetStateAction<number>>;
  readonly resetComposerTrigger: (trigger: ComposerTrigger | null) => void;
  readonly setActiveSuggestionId: Dispatch<SetStateAction<string | undefined>>;
  readonly setIsComposerFocused: Dispatch<SetStateAction<boolean>>;
  readonly promptRef: RefObject<string>;
  readonly composerImagesRef: RefObject<ComposerImageAttachment[]>;
  readonly composerFilesRef: RefObject<ComposerFileAttachment[]>;
  readonly composerTerminalContextsRef: RefObject<TerminalContextDraft[]>;
  readonly composerFormRef: RefObject<HTMLFormElement | null>;
  readonly composerSurfaceRef: RefObject<HTMLDivElement | null>;
  readonly composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly composerMenuControllerRef: RefObject<ComposerCommandMenuControllerHandle | null>;
}

export function useChatComposerUiState(input: ChatComposerUiStateInput) {
  const {
    environmentId,
    routeThreadRef,
    activeThreadId,
    draftId,
    prompt,
    isLiteralPendingAnswer,
    composerDraftTargetKey,
    attachmentTargetKey,
    attachmentTargetKeyRef,
    questionAttachmentTarget,
    questionRequest,
    questionTakesSnapShots,
    activePendingUserInput,
    activePendingProgress,
    isRevertingCheckpoint,
    composerFooterHasWideActions,
    isMobileViewport,
    composerImages,
    composerFiles,
    composerTerminalContexts,
    composerPreviewAnnotations,
    composerReviewComments,
    selectedModel,
    selectedPromptEffort,
    selectedProvider,
    setComposerCursor,
    resetComposerTrigger,
    setActiveSuggestionId,
    setIsComposerFocused,
    promptRef,
    composerImagesRef,
    composerFilesRef,
    composerTerminalContextsRef,
    composerFormRef,
    composerSurfaceRef,
    composerEditorRef,
    composerMenuControllerRef,
  } = input;
  const m = useMessages();

  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
  const [composerSubmissionError, setComposerSubmissionError] = useState<string | null>(null);
  const [providerInputSubmissionError, setProviderInputSubmissionError] = useState<string | null>(
    null,
  );
  const composerBlurFrameRef = useRef<number | null>(null);
  const mobileComposerExpandFrameRef = useRef<number | null>(null);
  const mobileComposerExpandReleaseFrameRef = useRef<number | null>(null);
  const mobileComposerExpandInFlightRef = useRef(false);

  const composerDraftTargetKeyRef = useRef("");
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- publishes the committed draft target key to a ref read by async handlers
  useLayoutEffect(() => {
    composerDraftTargetKeyRef.current = composerDraftTargetKey;
  });

  // Publish eligibility before async captures can observe a question the UI has already closed.
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- registers the open question's attachment draft in the module tracker before async captures read it
  useLayoutEffect(() => {
    if (!questionAttachmentTarget || !questionRequest || !questionTakesSnapShots) return;
    return trackOpenQuestionAttachmentDraft(routeThreadRef, {
      draftId: questionAttachmentTarget,
      requestKeys: questionRequest.questions.map((question) =>
        questionAttachmentDraftId(
          environmentId,
          activeThreadId!,
          questionRequest.requestId,
          question.id,
        ),
      ),
    });
  }, [
    activeThreadId,
    environmentId,
    questionAttachmentTarget,
    questionRequest,
    questionTakesSnapShots,
    routeThreadRef,
  ]);

  // Reject async imports after a draft switch.
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- publishes the committed attachment target key to a ref so async imports reject after a draft switch
  useLayoutEffect(() => {
    attachmentTargetKeyRef.current = attachmentTargetKey;
  });
  const composerMountedRef = useRef(true);
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- tracks unmount so an awaited folder conversion cannot write into ChatView's reused promptRef
  useLayoutEffect(() => {
    composerMountedRef.current = true;
    return () => {
      composerMountedRef.current = false;
    };
  }, []);
  const isRevertingCheckpointRef = useRef(isRevertingCheckpoint);
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- publishes the committed checkpoint revert flag to a ref read by async handlers
  useLayoutEffect(() => {
    isRevertingCheckpointRef.current = isRevertingCheckpoint;
  });

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- keeps the shared prompt ref in step with the committed draft prompt for imperative handlers
  useEffect(() => {
    if (isLiteralPendingAnswer) return;
    promptRef.current = prompt;
  }, [isLiteralPendingAnswer, prompt, promptRef]);
  const [cursorClampedFor, setCursorClampedFor] = useState({ prompt, isLiteralPendingAnswer });
  if (
    cursorClampedFor.prompt !== prompt ||
    cursorClampedFor.isLiteralPendingAnswer !== isLiteralPendingAnswer
  ) {
    setCursorClampedFor({ prompt, isLiteralPendingAnswer });
    if (!isLiteralPendingAnswer) {
      setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
    }
  }

  if (composerSubmissionError !== null) {
    const nextError = getComposerPromptLengthValidationMessage(prompt, m);
    if (nextError !== composerSubmissionError) {
      setComposerSubmissionError(nextError);
    }
  }

  const providerInputInputs = [
    composerPreviewAnnotations,
    composerReviewComments,
    composerTerminalContexts,
    prompt,
    selectedModel,
    selectedPromptEffort,
    selectedProvider,
  ] as const;
  const [providerInputValidatedFor, setProviderInputValidatedFor] = useState(providerInputInputs);
  if (providerInputInputs.some((value, index) => value !== providerInputValidatedFor[index])) {
    setProviderInputValidatedFor(providerInputInputs);
    setProviderInputSubmissionError(null);
  }

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- keeps the shared images ref in step with committed draft images for async handlers
  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages, composerImagesRef]);

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- keeps the shared files ref in step with committed draft files for async handlers
  useEffect(() => {
    composerFilesRef.current = composerFiles;
  }, [composerFiles, composerFilesRef]);

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- keeps the shared terminal contexts ref in step with committed draft contexts for async handlers
  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts, composerTerminalContextsRef]);

  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- moves the prompt ref and caret to the end when the pending question or its answer changes externally
  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      if (lastSyncedPendingInputRef.current !== null) {
        promptRef.current = prompt;
        const { cursor, trigger } = composerStateAtPromptEnd(prompt);
        setComposerCursor(cursor);
        resetComposerTrigger(trigger);
      }
      lastSyncedPendingInputRef.current = null;
      return;
    }

    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const { cursor, trigger } = composerStateAtPromptEnd(nextCustomAnswer, isLiteralPendingAnswer);
    setComposerCursor(cursor);
    resetComposerTrigger(trigger);
    composerMenuControllerRef.current?.clearHighlight();
  }, [
    activePendingProgress?.customAnswer,
    activePendingProgress?.activeQuestion?.id,
    composerMenuControllerRef,
    isLiteralPendingAnswer,
    activePendingUserInput?.requestId,
    prompt,
    promptRef,
    resetComposerTrigger,
    setComposerCursor,
  ]);

  const composerSessionKey = `${draftId ?? ""}:${activeThreadId ?? ""}:${isLiteralPendingAnswer}`;
  const [shownComposerSessionKey, setShownComposerSessionKey] = useState(composerSessionKey);
  if (shownComposerSessionKey !== composerSessionKey) {
    setShownComposerSessionKey(composerSessionKey);
    setActiveSuggestionId(undefined);
    setComposerSubmissionError(null);
    setProviderInputSubmissionError(null);
    const pendingAnswer = activePendingProgress?.customAnswer;
    const { cursor, trigger } = composerStateAtPromptEnd(
      typeof pendingAnswer === "string" ? pendingAnswer : prompt,
      isLiteralPendingAnswer,
    );
    setComposerCursor(cursor);
    resetComposerTrigger(trigger);
  }

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- observes composer form resizes to switch the footer and primary actions between compact layouts
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureCompactLayouts = () => {
      const composerFormWidth = composerForm.clientWidth;
      const options = { hasWideActions: composerFooterHasWideActions };
      setIsComposerFooterCompact(shouldUseCompactComposerFooter(composerFormWidth));
      setIsComposerPrimaryActionsCompact(
        shouldUseCompactComposerFooter(composerFormWidth, options) &&
          shouldUseCompactComposerPrimaryActions(composerFormWidth, options),
      );
    };

    measureCompactLayouts();
    return observeResize(composerForm, measureCompactLayouts);
  }, [composerFooterHasWideActions, composerFormRef]);

  const expandMobileComposer = () => {
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    if (mobileComposerExpandFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
    }
    if (mobileComposerExpandReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
    }
    mobileComposerExpandInFlightRef.current = true;
    setIsComposerFocused(true);
    mobileComposerExpandFrameRef.current = window.requestAnimationFrame(() => {
      mobileComposerExpandFrameRef.current = null;
      composerEditorRef.current?.focusAtEnd();
      mobileComposerExpandReleaseFrameRef.current = window.requestAnimationFrame(() => {
        mobileComposerExpandReleaseFrameRef.current = null;
        mobileComposerExpandInFlightRef.current = false;
      });
    });
  };
  const expandMobileComposerStable = useStableCallback(expandMobileComposer);

  const scheduleComposerCollapseCheck = () => {
    if (!isMobileViewport || mobileComposerExpandInFlightRef.current) {
      return;
    }
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
    }
    composerBlurFrameRef.current = window.requestAnimationFrame(() => {
      composerBlurFrameRef.current = null;
      if (mobileComposerExpandInFlightRef.current) {
        return;
      }
      const composerSurface = composerSurfaceRef.current;
      const composerForm = composerFormRef.current;
      const activeElement = document.activeElement;
      if (isInsideRestingComposerControlScope(activeElement)) {
        return;
      }
      if (
        activeElement instanceof Node &&
        ((composerSurface && composerSurface.contains(activeElement)) ||
          (composerForm && composerForm.contains(activeElement)))
      ) {
        return;
      }
      setIsComposerFocused(false);
    });
  };
  const scheduleComposerCollapseCheckStable = useStableCallback(scheduleComposerCollapseCheck);

  // Question dismissal unmounts focused controls without firing blur.
  const activePendingUserInputRequestId = activePendingUserInput?.requestId ?? null;
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- schedules the collapse check after a dismissed question unmounts focused controls without a blur
  useEffect(() => {
    if (activePendingUserInputRequestId !== null) return;
    scheduleComposerCollapseCheckStable();
  }, [activePendingUserInputRequestId, scheduleComposerCollapseCheckStable]);

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- cancels pending blur and mobile expand animation frames when the composer unmounts
  useEffect(() => {
    return () => {
      if (composerBlurFrameRef.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRef.current);
      }
      if (mobileComposerExpandFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
      }
      if (mobileComposerExpandReleaseFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
      }
    };
  }, []);

  return {
    composerDraftTargetKeyRef,
    composerMountedRef,
    isRevertingCheckpointRef,
    composerBlurFrameRef,
    composerSessionKey,
    isComposerFooterCompact,
    isComposerPrimaryActionsCompact,
    composerSubmissionError,
    setComposerSubmissionError,
    providerInputSubmissionError,
    setProviderInputSubmissionError,
    expandMobileComposer,
    expandMobileComposerStable,
    scheduleComposerCollapseCheck,
  };
}
