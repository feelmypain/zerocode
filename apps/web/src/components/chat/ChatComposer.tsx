import {
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from "@zerocode/client-runtime/providerSkills";
import { composerRunsDraftLocally } from "@zerocode/client-runtime/state/composer-dispatch";
import {
  clampManagedRuntimeMode,
  type ModelSelection,
  ProviderInstanceId,
  type ServerProvider,
} from "@zerocode/contracts";
import { createModelSelection, normalizeModelSlug } from "@zerocode/shared/model";
import { useGT, useMessages } from "gt-react";
import { memo, use, useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import { useLinkedEnvironments } from "~/state/peerLinks";
import { collapseExpandedComposerCursor, detectComposerTrigger } from "../../composer-logic";
import {
  composerDraftHasUserContent,
  composerTargetKey,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../../composerDraftStore";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useSoftwareKeyboardOpen } from "../../hooks/useSoftwareKeyboardOpen";
import { useStableCallback } from "../../hooks/useStableCallback";
import { threadHasStarted } from "../../lib/chatThreadActions";
import { type AppModelOption, getAppModelOptionsForInstance } from "../../modelSelection";
import { usePanelAnimationSettings } from "../../panelAnimations";
import {
  questionAttachmentDraftId,
  useQuestionAttachmentPreparation,
} from "../../questionAttachments";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useManagedPolicy } from "../../state/managedPolicy";
import { deriveComposerSendState, getAntigravitySendBlockReason } from "../ChatView.logic";
import { type ComposerPromptEditorHandle } from "../ComposerPromptEditorTiptap";
import { BackgroundThreadContext, HiddenThreadContext } from "./backgroundThread";
import { ChatComposerBannerDock } from "./ChatComposerBannerDock";
import { ChatComposerBody } from "./ChatComposerBody";
import { ChatComposerCollapsedMobileRow, ChatComposerFooterBar } from "./ChatComposerFooterBar";
import type { ChatComposerProps } from "./chatComposerTypes";
import {
  ComposerAttachButton,
  ComposerAttachInput,
  ComposerAttachmentFileList,
  ComposerAttachmentMediaRow,
} from "./ComposerAttachmentStrip";
import { type ComposerCommandItem } from "./ComposerCommandMenu";
import { type ComposerCommandMenuControllerHandle } from "./ComposerCommandMenuController";
import { ComposerControlsBar } from "./ComposerControlsBar";
import { ComposerSurface } from "./ComposerSurface";
import { hasProviderSetup } from "./ProviderStatusBanner";
import { readPromptUltrathink } from "./TraitsPicker";
import {
  isInsideCollapsedComposerControls,
  isInsideRestingComposerControlScope,
} from "./composerEventScope";
import { type ComposerPromptHistoryPosition } from "./composerPromptHistory";
import { getComposerPromptInjectionState } from "./composerProviderState";
import { cancelHeldComposerSend, useComposerSendHeld } from "./preparingComposerImages";
import {
  draftSupportedRuntimeModes,
  resolveCompatibleRuntimeMode,
  resolveRuntimeModeOptions,
  runtimeModeDenial,
} from "./runtimeModeConfig";
import { threadContextDropTargetProps } from "./threadContextDrag";
import { useChatComposerAttachments } from "./useChatComposerAttachments";
import { useChatComposerAttachmentState } from "./useChatComposerAttachmentState";
import { useChatComposerImperativeHandle } from "./useChatComposerImperativeHandle";
import { useChatComposerPromptChange } from "./useChatComposerPromptChange";
import { useChatComposerSubmit } from "./useChatComposerSubmit";
import { useChatComposerUiState } from "./useChatComposerUiState";
import { useComposerMultilinePrompt } from "./useComposerMultilinePrompt";
import { useComposerProviderModel } from "./useComposerProviderModel";
import { useComposerRestingTransition } from "./useComposerRestingTransition";
import { useComposerStash } from "./useComposerStash";
import { useComposerTriggerState } from "./useComposerTriggerState";
import { useComposerTypingGuard } from "./useComposerTypingGuard";
import { usePendingUserInputDraft } from "./usePendingThreadRequests";
import { useProviderWorkspaceSnapshotRefresh } from "./useProviderWorkspaceSnapshotRefresh";
import { useRestingComposerControlsLayout } from "./useRestingComposerControlsLayout";

export type { ChatComposerHandle, ChatComposerProps } from "./chatComposerTypes";

const NO_PROVIDER_SKILLS: ServerProvider["skills"] = [];
const NO_PROVIDER_SLASH_COMMANDS: ServerProvider["slashCommands"] = [];

export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps) {
  const gt = useGT();
  const m = useMessages();
  const {
    composerDraftTarget,
    environmentId,
    canOperateThread,
    attachmentUploadsCapabilityKnown,
    supportsAttachmentUploads,
    supportsQuestionAttachments,
    maxFileAttachmentBytes,
    routeKind,
    routeThreadRef,
    draftId,
    multipleModelSelections,
    supportsMultipleModels,
    onMultipleModelSelectionsChange: setMultipleModelSelections,
    activeThreadId,
    activeThread,
    activeThreadRuns,
    promptHistoryEntries,
    forceExpandedOnMobile,
    projectSelectionRequired,
    phase,
    canInterrupt,
    isSendBusy,
    canResume,
    isRevertingCheckpoint = false,
    sendDisabledReason: externalSendDisabledReason,
    isPreparingWorktree,
    canSteer,
    bannerItems: incomingBannerItems,
    resumeCompactionTokens,
    keepFullHistory,
    onToggleKeepFullHistory,
    onUsageLimitsCommand,
    sideChatAvailable,
    sideChatDisabledReason,
    onFreshSession,
    environmentUnavailable,
    activePendingApproval: incomingPendingApproval,
    pendingApprovals,
    onHeldRequestIdsChange,
    pendingUserInputs: incomingPendingUserInputs,
    activePendingIsResponding: incomingPendingIsResponding,
    respondingRequestIds,
    runtimeMode,
    defaultRuntimeMode,
    lockedProvider,
    providerStatuses,
    providerCatalogKnown,
    activeProjectDefaultModelSelection,
    activeThreadModelSelection,
    reportedModelSelection,
    activeProjectId,
    projectName,
    compactThreadUnavailable,
    compactDisabled,
    resolvedTheme,
    settings,
    keybindings,
    getShortcutContext,
    terminalOpen,
    gitCwd,
    pullRequestProjectId,
    pullRequestRepository,
    threadPullRequests,
    onComposerOverlayHeightChange,
    permissionsShownInStrip,
    promptRef,
    composerRef,
    composerImagesRef,
    composerFilesRef,
    composerTerminalContextsRef,
    onPageScrollKeyDown,
    onPageScrollKeyUp,
    onPageScrollRelease,
    onCompactContext,
    onSend,
    captureDetachedSend,
    onResume,
    onInterrupt,
    onSelectActivePendingUserInputOption,
    onAdvanceActivePendingUserInput,
    onDismissActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
    onChangeActivePendingUserInputCustomAnswer,
    onProviderModelSelect,
    onOpenProviderSetup,
    getModelDisabledReason,
    handleRuntimeModeChange,
    focusComposer,
    scheduleComposerFocus,
    setThreadError,
    onExpandImage,
    onFileOpen,
    editingQueuedAttachments,
    removedEditingQueuedAttachments,
    onRemoveEditingQueuedAttachment,
    onRestoreEditingQueuedAttachment,
  } = props;

  const {
    activePendingProgress: incomingPendingProgress,
    activePendingResolvedAnswers,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
  } = usePendingUserInputDraft({
    environmentId,
    activeThreadId,
    activePendingUserInput: incomingPendingUserInputs[0] ?? null,
    supportsQuestionAttachments,
  });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const composerDraftTargetKey = composerTargetKey(composerDraftTarget);
  const {
    heldRequestIds,
    onDraftChange: onTypingGuardDraftChange,
    onFocus: onTypingGuardFocus,
    onBlur: onTypingGuardBlur,
    onSend: onTypingGuardSend,
  } = useComposerTypingGuard(composerDraftTargetKey, [
    ...pendingApprovals.map((request) => request.requestId),
    ...incomingPendingUserInputs.map((request) => request.requestId),
  ]);
  // A layout effect so the timeline never paints a held approval as answerable.
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- publishes held requests to the timeline without lifting per-keystroke typing state
  useLayoutEffect(() => {
    onHeldRequestIdsChange(heldRequestIds);
  }, [heldRequestIds, onHeldRequestIdsChange]);
  const activePendingApproval =
    incomingPendingApproval && !heldRequestIds.has(incomingPendingApproval.requestId)
      ? incomingPendingApproval
      : null;
  const holdingUserInput = incomingPendingUserInputs[0]
    ? heldRequestIds.has(incomingPendingUserInputs[0].requestId)
    : false;
  const pendingUserInputs = holdingUserInput ? [] : incomingPendingUserInputs;
  const activePendingProgress = holdingUserInput ? null : incomingPendingProgress;
  const activePendingIsResponding = !holdingUserInput && incomingPendingIsResponding;
  const isLiteralPendingAnswer = activePendingProgress?.activeQuestion?.initialAnswer !== undefined;
  const isEditingQueuedMessage = editingQueuedAttachments !== null;
  const composerDraft = useComposerThreadDraft(composerDraftTarget);
  const questionAttachmentTarget =
    pendingUserInputs[0] && activePendingProgress?.activeQuestion
      ? questionAttachmentDraftId(
          environmentId,
          activeThreadId!,
          pendingUserInputs[0].requestId,
          activePendingProgress.activeQuestion.id,
        )
      : null;
  const queuedEditOwnsComposer =
    questionAttachmentTarget === null && pendingUserInputs.length === 0;
  const activeEditingQueuedAttachments = queuedEditOwnsComposer ? editingQueuedAttachments : null;
  const activeRemovedEditingQueuedAttachments = queuedEditOwnsComposer
    ? removedEditingQueuedAttachments
    : undefined;
  const attachmentDraftTarget = questionAttachmentTarget ?? composerDraftTarget;
  const attachmentDraft = useComposerThreadDraft(attachmentDraftTarget);
  const questionTakesSnapShots =
    supportsQuestionAttachments &&
    activePendingProgress?.activeQuestion?.allowCustomAnswer !== false &&
    !activePendingIsResponding;
  const questionRequest = pendingUserInputs[0];
  const attachmentTargetKey = composerTargetKey(attachmentDraftTarget);
  const attachmentTargetKeyRef = useRef(attachmentTargetKey);
  const pendingThreadImportsRef = useRef<Map<string, number>>(new Map());
  const questionPreparations = useQuestionAttachmentPreparation((state) => state.counts);
  const prompt = composerDraft.prompt;
  const composerImages = attachmentDraft.images;
  const composerFiles = attachmentDraft.files;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerPreviewAnnotations = composerDraft.previewAnnotations;
  const composerReviewComments = composerDraft.reviewComments;
  const composerThreadContexts = attachmentDraft.threadContexts;
  const composerEnvironmentContexts = composerDraft.environmentContexts;
  const nonPersistedComposerImageIds = attachmentDraft.nonPersistedImageIds;
  const linkedEnvironments = useLinkedEnvironments(environmentId);

  const {
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
  } = useChatComposerAttachmentState({
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
  });

  const composerSendHeld = useComposerSendHeld(composerDraftTargetKey);
  const cancelHeldSend = () => cancelHeldComposerSend(composerDraftTargetKey);
  const handleMultipleModelSelectionsChangeStable = useStableCallback(
    (next: React.SetStateAction<ReadonlyArray<ModelSelection> | null>) => {
      cancelHeldSend();
      setMultipleModelSelections(next);
    },
  );
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);

  const {
    providerInstanceEntries,
    selectedProviderEntry,
    lockedContinuationGroupKey,
    unavailableProviderInstanceId,
    selectedInstanceId,
    selectedProvider,
    selectedProviderModels,
    composerModelOptions,
    selectedModel,
    composerProviderState,
  } = useComposerProviderModel({
    providerStatuses,
    settings,
    activeProjectId,
    threadRef: composerDraftTarget,
    threadModelSelection: activeThreadModelSelection,
    projectModelSelection: activeProjectDefaultModelSelection,
    promptInjectionState: getComposerPromptInjectionState(prompt),
    threadStarted: threadHasStarted(activeThread),
    candidateInstanceIds: [
      activeThread?.runtime?.providerInstanceId,
      activeThreadModelSelection?.instanceId,
      activeProjectDefaultModelSelection?.instanceId,
    ],
    lockedProvider,
    lockedInstanceId:
      activeThread?.runtime?.providerInstanceId ?? activeThreadModelSelection?.instanceId,
  });
  const noProviderAvailable =
    selectedProviderEntry === undefined && multipleModelSelections === null;
  const providerCatalogPending = noProviderAvailable && !providerCatalogKnown;
  const showProviderUnavailable = noProviderAvailable && !providerCatalogPending;
  const providerSetupInstanceId = noProviderAvailable
    ? (unavailableProviderInstanceId ??
      (lockedProvider === null
        ? providerInstanceEntries.find((entry) => hasProviderSetup(entry.snapshot))?.instanceId
        : undefined))
    : undefined;
  // Called before the derivation below: a hook between it and its uses stops React Compiler
  // from caching the mode options, and the footer then re-renders on every keystroke.
  const managedPolicy = useManagedPolicy(environmentId);
  const { modes: compatibleRuntimeModes, mode: compatibleRuntimeMode } =
    resolveCompatibleRuntimeMode(
      runtimeMode,
      draftSupportedRuntimeModes(
        selectedProviderEntry?.snapshot.supportedRuntimeModes,
        multipleModelSelections,
        providerStatuses,
      ),
    );
  // Modes above an administrator's ceiling stay listed, disabled with the reason.
  const compatibleRuntimeModeOptions = resolveRuntimeModeOptions(
    compatibleRuntimeModes,
    managedPolicy,
    m,
  );
  // A thread or draft already above the ceiling would be refused; offer the broadest mode left.
  const runtimeModeCeilingDenial = runtimeModeDenial(managedPolicy, compatibleRuntimeMode, m);
  const runtimeModeCeilingFallback =
    runtimeModeCeilingDenial === undefined
      ? undefined
      : clampManagedRuntimeMode(managedPolicy, compatibleRuntimeMode, compatibleRuntimeModes);

  const providerSendBlockReason = getAntigravitySendBlockReason(
    selectedProviderEntry?.snapshot,
    selectedModel,
    m,
  );
  const sendDisabledReason =
    externalSendDisabledReason ??
    (multipleModelSelections?.length === 0 ? gt("Select at least one model.") : null) ??
    (activePendingProgress
      ? attachmentBlockReason
      : (attachmentBlockReason ??
        runtimeModeCeilingDenial ??
        (multipleModelSelections === null ? providerSendBlockReason : null)));
  const isSendDisabled = sendDisabledReason !== null;
  const selectedProviderStatus = selectedProviderEntry?.snapshot ?? null;
  const selectedProviderSkills = selectedProviderStatus
    ? resolveProviderSkillsForCwd(selectedProviderStatus, gitCwd)
    : NO_PROVIDER_SKILLS;
  const selectedProviderSlashCommands = selectedProviderStatus
    ? resolveProviderSlashCommandsForCwd(selectedProviderStatus, gitCwd)
    : NO_PROVIDER_SLASH_COMMANDS;
  const { refresh: refreshWorkspaceSnapshotOnTyping, scanning: workspaceSkillsScanning } =
    useProviderWorkspaceSnapshotRefresh({
      environmentId,
      gitCwd,
      instanceId: selectedProviderEntry?.instanceId,
    });

  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  const selectedModelSelection: ModelSelection = createModelSelection(
    selectedInstanceId,
    selectedModel,
    selectedModelOptionsForDispatch,
  );
  const selectedModelForPicker = selectedModel;
  const modelOptionsByInstance = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
  for (const entry of providerInstanceEntries) {
    modelOptionsByInstance.set(
      entry.instanceId,
      getAppModelOptionsForInstance(
        settings,
        entry,
        entry.instanceId === selectedInstanceId ? selectedModelForPicker : null,
      ),
    );
  }
  const selectedModelForPickerWithCustomFallback = (() => {
    const currentOptions = modelOptionsByInstance.get(selectedInstanceId) ?? [];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  })();

  const [composerCursor, setComposerCursor] = useState(() => {
    const value = isLiteralPendingAnswer ? (activePendingProgress?.customAnswer ?? prompt) : prompt;
    return collapseExpandedComposerCursor(value, value.length, isLiteralPendingAnswer);
  });
  const {
    trigger: composerTrigger,
    setTrigger: setComposerTrigger,
    followCaret: followComposerCaret,
    resolveTrigger: resolveComposerTrigger,
    dismissTrigger: dismissComposerTrigger,
    resetTrigger: resetComposerTrigger,
  } = useComposerTriggerState(() =>
    isLiteralPendingAnswer ? null : detectComposerTrigger(prompt, prompt.length),
  );
  const [activeSuggestionId, setActiveSuggestionId] = useState<string | undefined>(undefined);
  const composerSuggestionId = useId();
  const composerSuggestionListId = `${composerSuggestionId}-${encodeURIComponent(draftId ?? activeThreadId ?? "new")}-suggestions`;
  const promptHistoryPositionRef = useRef<{
    targetKey: string;
    position: ComposerPromptHistoryPosition;
  } | null>(null);
  const [isComposerModelPickerOpen, setIsComposerModelPickerOpen] = useState(false);
  const isMobileViewport = useMediaQuery("max-sm");
  const isSoftwareKeyboardOpen = useSoftwareKeyboardOpen();
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [composerMenuAnchor, setComposerMenuAnchor] = useState<HTMLDivElement | null>(null);
  const [hasWrappedPrompt, observeWrappedPrompt] = useComposerMultilinePrompt();
  const hasMultilinePrompt = prompt.includes("\n") || hasWrappedPrompt;
  // A pending question stays expanded: its card moves into the banner dock,
  // so collapsing would leave the surface empty and squashed beneath it.
  const isComposerCollapsedMobile =
    isMobileViewport &&
    !forceExpandedOnMobile &&
    !isComposerFocused &&
    !hasMultilinePrompt &&
    pendingUserInputs.length === 0;

  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerAttachInputRef = useRef<HTMLInputElement>(null);
  const composerSurfaceRef = useRef<HTMLDivElement>(null);
  const providerInputRejectedRef = useRef(false);
  const composerMenuControllerRef = useRef<ComposerCommandMenuControllerHandle | null>(null);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);

  const backgroundThread = use(BackgroundThreadContext);
  const hiddenThread = use(HiddenThreadContext);

  const composerSendState = deriveComposerSendState({
    prompt,
    imageCount: composerImages.length + composerFiles.length,
    existingAttachmentCount: editingQueuedAttachments?.length ?? 0,
    terminalContexts: composerTerminalContexts,
    elementContextCount:
      composerPreviewAnnotations.length +
      composerReviewComments.length +
      composerThreadContexts.length +
      composerEnvironmentContexts.length,
  });
  const compactSlashCommandAvailable =
    composerTrigger?.kind === "slash-command" &&
    prompt.slice(0, composerTrigger.rangeStart).trim() === "" &&
    !compactThreadUnavailable &&
    prompt.slice(composerTrigger.rangeEnd).trim() === "" &&
    composerImages.length + composerFiles.length === 0 &&
    composerDraft.persistedAttachments.length === 0 &&
    composerTerminalContexts.length === 0 &&
    composerPreviewAnnotations.length === 0 &&
    composerReviewComments.length === 0;
  const composerMenuOpen = Boolean(composerTrigger);
  if (!composerMenuOpen && activeSuggestionId !== undefined) {
    setActiveSuggestionId(undefined);
  }
  const clearComposerMenuHighlight = () => {
    composerMenuControllerRef.current?.clearHighlight();
  };
  const nudgeComposerMenuHighlight = (key: "ArrowDown" | "ArrowUp") => {
    composerMenuControllerRef.current?.nudgeHighlight(key);
  };

  const isComposerApprovalState = activePendingApproval !== null;
  // A send declines the approvals shown here to redirect the agent, so it steers the waiting
  // turn instead of queueing behind it. Approvals the typing guard holds stay unseen and pending.
  const followUpBehavior = pendingApprovals.some(
    (approval) => !heldRequestIds.has(approval.requestId),
  )
    ? "steer"
    : settings.followUpBehavior;
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const isChoiceOnlyPendingQuestion =
    activePendingProgress?.activeQuestion?.allowCustomAnswer === false;
  const showCollapsedMobilePromptRow = isComposerCollapsedMobile;
  const showComposerAttachAction =
    fileStagingLimit !== null &&
    (!activePendingProgress ||
      (supportsQuestionAttachments &&
        activePendingProgress.activeQuestion?.allowCustomAnswer !== false));
  const composerFooterHasWideActions = activePendingProgress !== null;

  const editPromptFromTraits = (edit: (next: string) => string) => {
    const currentPrompt = getComposerDraft(composerDraftTarget)?.prompt ?? "";
    const nextPrompt = edit(currentPrompt);
    if (nextPrompt === currentPrompt) return;
    if (nextPrompt === promptRef.current) {
      scheduleComposerFocus();
      return;
    }
    promptRef.current = nextPrompt;
    setComposerDraftPrompt(composerDraftTarget, nextPrompt);
    const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
    scheduleComposerFocus();
  };
  const editPromptFromTraitsStable = useStableCallback(editPromptFromTraits);
  const promptUltrathink = readPromptUltrathink(prompt);

  const [inlineRestingControlsHost, setInlineRestingControlsHost] = useState<HTMLDivElement | null>(
    null,
  );
  const {
    controlsRef: restingComposerControlsRef,
    attachControls: attachRestingComposerControls,
    hiddenBlockCount: restingControlsHiddenBlockCount,
    iconOnlyBlockCount: restingControlsIconOnlyBlockCount,
    controlsVisible: restingControlsVisible,
  } = useRestingComposerControlsLayout(inlineRestingControlsHost);
  const {
    attachControls: attachExpandedComposerControls,
    hiddenBlockCount: expandedControlsHiddenBlockCount,
    iconOnlyBlockCount: expandedControlsIconOnlyBlockCount,
  } = useRestingComposerControlsLayout(null, true);
  const pendingPrimaryAction = activePendingProgress
    ? {
        questionIndex: activePendingProgress.questionIndex,
        isLastQuestion: activePendingProgress.isLastQuestion,
        canAdvance:
          activePendingProgress.canAdvance &&
          !attachmentBlockReason &&
          !(questionPreparations[attachmentTargetKey] ?? 0),
        isResponding: activePendingIsResponding,
        isComplete: Boolean(activePendingResolvedAnswers),
      }
    : null;
  const hasMessageToSend = composerSendState.hasSendableContent || messageHasPreparingImages;
  const showResumeAction =
    canResume &&
    !composerDraftHasUserContent(composerDraft) &&
    !messageHasPreparingImages &&
    !isEditingQueuedMessage;
  const collapsedComposerPrimaryActionDisabled =
    phase === "running" ||
    isSendBusy ||
    composerSendHeld ||
    isSendDisabled ||
    noProviderAvailable ||
    projectSelectionRequired ||
    environmentUnavailable !== null ||
    (!hasMessageToSend && !showResumeAction);
  const collapsedComposerPrimaryActionLabel = composerSendHeld
    ? gt("Sending when ready")
    : showResumeAction
      ? gt("Resume thread")
      : resumeCompactionTokens !== null && !keepFullHistory
        ? gt("Open composer to compact and send")
        : gt("Send message");
  const showMobilePendingAnswerActions =
    isMobileViewport && !isComposerCollapsedMobile && pendingPrimaryAction !== null;

  const {
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
  } = useChatComposerUiState({
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
  });

  const {
    setPrompt,
    onPromptChangeStable,
    applyPromptReplacement,
    applyPromptReplacementStable,
    readComposerSnapshot,
    readComposerSnapshotStable,
    resolveActiveComposerTrigger,
    onSelectComposerItem,
    onSelectComposerItemStable,
    isPathQueryActiveStable,
  } = useChatComposerPromptChange({
    environmentId,
    gitCwd,
    composerDraftTarget,
    attachmentDraftTarget,
    composerDraftTargetKey,
    composerCursor,
    setComposerCursor,
    setComposerTrigger,
    followComposerCaret,
    resolveComposerTrigger,
    isLiteralPendingAnswer,
    activePendingProgress,
    activePendingUserInput,
    pendingUserInputs,
    composerImages,
    composerFiles,
    composerTerminalContexts,
    composerPreviewAnnotations,
    composerReviewComments,
    composerThreadContexts,
    composerEnvironmentContexts,
    activeEditingQueuedAttachments,
    activeRemovedEditingQueuedAttachments,
    onRemoveEditingQueuedAttachment,
    onRestoreEditingQueuedAttachment,
    onChangeActivePendingUserInputCustomAnswer,
    onTypingGuardDraftChange,
    refreshWorkspaceSnapshotOnTyping,
    clearComposerMenuHighlight,
    setIsComposerModelPickerOpen,
    onFreshSession,
    sideChatDisabledReason,
    onUsageLimitsCommand,
    promptRef,
    promptHistoryPositionRef,
    composerEditorRef,
    composerMenuItemsRef,
  });

  const {
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
  } = useChatComposerSubmit({
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
    hasActivePendingResolvedAnswers: Boolean(activePendingResolvedAnswers),
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
    hasComposerContextRecords: composerContextRecords.size > 0,
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
  });

  const {
    stashQueue,
    isStashMenuOpen,
    setIsStashMenuOpen,
    stashPulseKey,
    restoreStashEntryStable,
    deleteStashEntryStable,
    toggleStashMenuStable,
  } = useComposerStash({
    environmentId,
    composerDraftTarget,
    promptRef,
    readAttachmentDraft: () => ({
      images: composerImagesRef.current,
      files: composerFilesRef.current,
    }),
    readTerminalContexts: () => composerTerminalContextsRef.current,
    routeThreadRef,
    projectSelectionRequired,
    pendingUserInputs,
    activePendingProgress,
    prompt,
    composerMenuOpen,
    isComposerCollapsedMobile,
    composerPreviewAnnotations,
    composerReviewComments,
    composerThreadContexts,
    attachmentTargetKey,
    isComposerDraftTargetOpen: (key) => composerDraftTargetKeyRef.current === key,
    composerEditorRef,
    isRevertingCheckpoint: () => isRevertingCheckpointRef.current,
    pendingThreadImportsRef,
    setComposerCursor,
    setComposerTrigger,
    importContextRecords,
    expandMobileComposer: expandMobileComposerStable,
  });

  const composerControlsCollapsed = isComposerCollapsedMobile;
  // The collapsed mobile web composer keeps a second controls row inside the card.
  const showInlineRestingControls = isComposerCollapsedMobile;
  const composerControlsHidden = showInlineRestingControls && !restingControlsVisible;
  // Popovers and menus stack above app modals, so one left open would cover Settings or Usage.
  const composerMenusClosed = composerControlsHidden || hiddenThread;
  if (composerMenusClosed && isComposerModelPickerOpen) {
    setIsComposerModelPickerOpen(false);
  }
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const composerMainSurfaceRef = useComposerRestingTransition(
    composerControlsCollapsed,
    restingComposerControlsRef,
    onComposerOverlayHeightChange,
    panelAnimationsActive,
    panelAnimationDurationMs,
  );
  const restingHiddenBlockCount = showInlineRestingControls
    ? restingControlsHiddenBlockCount
    : composerControlsCollapsed
      ? 0
      : expandedControlsHiddenBlockCount;
  const iconOnlyBlockCount = showInlineRestingControls
    ? restingControlsIconOnlyBlockCount
    : composerControlsCollapsed
      ? 0
      : expandedControlsIconOnlyBlockCount;

  const replyTo = composerDraft?.replyTo ?? null;
  const draftRunsLocally = composerRunsDraftLocally({
    text: prompt,
    holdsOnlyText:
      composerImages.length + composerFiles.length === 0 &&
      composerSendState.sendableTerminalContexts.length === 0 &&
      composerPreviewAnnotations.length === 0 &&
      composerReviewComments.length === 0 &&
      composerThreadContexts.length === 0 &&
      composerEnvironmentContexts.length === 0 &&
      replyTo === null,
    sideChat: sideChatAvailable === true || (sideChatDisabledReason ?? null) !== null,
    usageLimits: onUsageLimitsCommand !== undefined,
    codexFeedback: selectedProvider === "codex" && multipleModelSelections === null,
    freshSession: onFreshSession !== undefined,
  });

  const {
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
  } = useChatComposerAttachments({
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
    speechFreezesEditor: speechInput.freezesEditor,
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
  });

  const handleInterruptPrimaryAction = () => {
    void onInterrupt();
  };
  const handleInterruptPrimaryActionStable = useStableCallback(handleInterruptPrimaryAction);

  const openModelPicker = () => {
    if (composerControlsHidden) {
      if (composerBlurFrameRef.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRef.current);
        composerBlurFrameRef.current = null;
      }
      setIsComposerFocused(true);
    }
    setIsComposerModelPickerOpen(true);
  };
  const openModelPickerStable = useStableCallback(openModelPicker);

  useChatComposerImperativeHandle({
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
    speechFreezesEditor: speechInput.freezesEditor,
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
  });

  const composerControls = (
    <ComposerControlsBar
      environmentId={environmentId}
      workspaceCwd={gitCwd}
      routeKind={typeof composerDraftTarget === "string" ? "draft" : routeKind}
      routeThreadRef={routeThreadRef}
      draftId={typeof composerDraftTarget === "string" ? composerDraftTarget : draftId}
      selectedProvider={selectedProvider}
      selectedInstanceId={selectedInstanceId}
      selectedModel={selectedModel}
      selectedProviderModels={selectedProviderModels}
      composerModelOptions={composerModelOptions}
      reportedModelSelection={reportedModelSelection}
      promptUltrathink={promptUltrathink}
      onPromptEdit={editPromptFromTraitsStable}
      compatibleRuntimeMode={compatibleRuntimeMode}
      defaultRuntimeMode={defaultRuntimeMode}
      compatibleRuntimeModeOptions={compatibleRuntimeModeOptions}
      handleRuntimeModeChange={handleRuntimeModeChange}
      composerControlsCollapsed={composerControlsCollapsed}
      effortDisplay={settings.effortDisplay}
      permissionsShownInStrip={permissionsShownInStrip}
      composerControlsHidden={composerMenusClosed}
      restingHiddenBlockCount={restingHiddenBlockCount}
      iconOnlyBlockCount={iconOnlyBlockCount}
      showProviderUnavailable={showProviderUnavailable}
      providerSetupInstanceId={providerSetupInstanceId}
      onOpenProviderSetup={onOpenProviderSetup}
      providerCatalogPending={providerCatalogPending}
      isSendBusy={isSendBusy}
      multipleModelsEnabled={routeKind === "draft" && supportsMultipleModels}
      multipleModelSelections={multipleModelSelections}
      onMultipleModelSelectionsChange={handleMultipleModelSelectionsChangeStable}
      selectedModelSelection={selectedModelSelection}
      onProviderModelSelect={onProviderModelSelect}
      activeThreadModelSelection={activeThreadModelSelection}
      selectedModelForPickerWithCustomFallback={selectedModelForPickerWithCustomFallback}
      lockedProvider={lockedProvider}
      lockedContinuationGroupKey={lockedContinuationGroupKey}
      providerInstanceEntries={providerInstanceEntries}
      keybindings={keybindings}
      modelOptionsByInstance={modelOptionsByInstance}
      terminalOpen={terminalOpen}
      modelPickerOpen={isComposerModelPickerOpen}
      onModelPickerOpenChange={setIsComposerModelPickerOpen}
      modelPickerIconClassName={composerProviderState.modelPickerIconClassName}
      getModelDisabledReason={getModelDisabledReason}
    />
  );

  // Built outside the form's JSX so typing, which rebuilds that JSX, leaves them cached.
  const composerAttachmentMediaRow =
    !isComposerCollapsedMobile &&
    (uncommittedSnapShotIds.length > 0 ||
      composerVideos.length > 0 ||
      standaloneComposerImages.length > 0 ||
      preparingComposerImages.length > 0) ? (
      <ComposerAttachmentMediaRow
        images={composerImages}
        expandedImages={standaloneComposerImages}
        preparingImages={preparingComposerImages}
        videos={composerVideos}
        pendingSnapShotAnimations={pendingSnapShotAnimations}
        pendingSnapShotIds={pendingSnapShotIds}
        uncommittedSnapShotIds={uncommittedSnapShotIds}
        nonPersistedImageIds={nonPersistedComposerImageIds}
        snapShotAnimations={settings.snapShotAnimations}
        supportsAttachmentUploads={supportsAttachmentUploads}
        maxFileAttachmentBytes={maxFileAttachmentBytes}
        environmentId={environmentId}
        attachmentDraftTarget={attachmentDraftTarget}
        canOperateThread={canOperateThread}
        onCopySnapshot={copyComposerSnapshotStable}
        onExpandImage={onExpandImage}
        onFileOpen={onFileOpen}
        onRemoveImage={removeComposerImage}
        onRemoveFile={removeComposerFileFromDraft}
      />
    ) : null;
  const composerAttachmentFileList =
    !isComposerCollapsedMobile && composerOtherFiles.length > 0 ? (
      <ComposerAttachmentFileList
        files={composerOtherFiles}
        resolvedTheme={resolvedTheme}
        supportsAttachmentUploads={supportsAttachmentUploads}
        maxFileAttachmentBytes={maxFileAttachmentBytes}
        fileStagingLimit={fileStagingLimit}
        environmentId={environmentId}
        attachmentDraftTarget={attachmentDraftTarget}
        canOperateThread={canOperateThread}
        onPreviewFile={setPreviewFileId}
        onRemoveFile={removeComposerFileFromDraft}
      />
    ) : null;
  const composerAttachButton = showComposerAttachAction ? (
    <ComposerAttachButton onOpenPicker={() => composerAttachInputRef.current?.click()} />
  ) : null;

  return (
    <form
      ref={composerFormRef}
      onSubmit={submitComposerStable}
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          composerSendHeld &&
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          cancelHeldSend();
        }
      }}
      onFocusCapture={(event) => {
        const activeElement = event.target;
        if (
          activeElement instanceof Element &&
          activeElement.closest('[data-testid="composer-editor"]')
        ) {
          onTypingGuardFocus();
        }
        if (composerControlsCollapsed && isInsideRestingComposerControlScope(activeElement)) {
          return;
        }
        if (isInsideCollapsedComposerControls(activeElement)) {
          return;
        }
        if (composerBlurFrameRef.current !== null) {
          window.cancelAnimationFrame(composerBlurFrameRef.current);
          composerBlurFrameRef.current = null;
        }
        setIsComposerFocused(true);
      }}
      onBlurCapture={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('[data-testid="composer-editor"]')
        ) {
          onTypingGuardBlur();
        }
        scheduleComposerCollapseCheck();
      }}
      onDragEnterCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        composerMentionDragHandlers.onDragEnter(event);
      }}
      onDragOverCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        composerMentionDragHandlers.onDragOver(event);
      }}
      onDragLeaveCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        onComposerMentionDragLeaveCapture(event);
      }}
      onDropCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        composerMentionDragHandlers.onDrop(event);
      }}
      className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width)"
      data-chat-composer-form="true"
      {...threadContextDropTargetProps()}
    >
      <ChatComposerBannerDock
        composerDraftTarget={composerDraftTarget}
        routeThreadRef={routeThreadRef}
        gitCwd={gitCwd}
        canOperateThread={canOperateThread}
        bannerItems={incomingBannerItems}
        replyTo={replyTo}
        hasActivePendingProgress={activePendingProgress !== null}
        runtimeModeCeilingDenial={runtimeModeCeilingDenial}
        runtimeModeCeilingFallback={runtimeModeCeilingFallback}
        handleRuntimeModeChange={handleRuntimeModeChange}
        pendingUserInputs={pendingUserInputs}
        activePendingUserInput={activePendingUserInput}
        activePendingIsResponding={activePendingIsResponding}
        respondingRequestIds={respondingRequestIds}
        activePendingDraftAnswers={activePendingDraftAnswers}
        activePendingQuestionIndex={activePendingQuestionIndex}
        onSelectActivePendingUserInputOption={onSelectActivePendingUserInputOption}
        onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInput}
        onDismissActivePendingUserInput={onDismissActivePendingUserInput}
        stashCount={stashQueue.length}
        isStashMenuOpen={isStashMenuOpen}
        stashPulseKey={stashPulseKey}
        onToggleStashMenu={toggleStashMenuStable}
      />
      {showComposerAttachAction ? (
        <ComposerAttachInput
          ref={composerAttachInputRef}
          addComposerAttachments={addComposerAttachments}
          focusComposer={focusComposer}
        />
      ) : null}
      <div className="relative">
        <ComposerSurface.Main
          ref={composerMainSurfaceRef}
          data-inline-resting-controls="true"
          className={composerProviderState.composerFrameClassName}
        >
          <div
            ref={composerSurfaceRef}
            data-chat-composer-surface="true"
            data-chat-composer-mobile-collapsed={isComposerCollapsedMobile ? "true" : "false"}
            className={cn(
              "rounded-2xl transition-[background-color] duration-200",
              "in-data-[thread-context-over]:bg-accent/45 in-data-[thread-context-over]:ring-1 in-data-[thread-context-over]:ring-inset in-data-[thread-context-over]:ring-primary/70",
              isDragOverComposer ? "bg-accent/45 ring-1 ring-inset ring-primary/70" : null,
              projectSelectionRequired ? "opacity-75" : null,
              composerProviderState.composerSurfaceClassName,
            )}
          >
            {showCollapsedMobilePromptRow ? (
              <ChatComposerCollapsedMobileRow
                environmentId={environmentId}
                activeThreadId={activeThreadId}
                activeRunId={activeThread?.runtime?.activeRunId ?? null}
                prompt={prompt}
                selectedProviderSkills={selectedProviderSkills}
                composerContextRecords={composerContextRecords}
                resolvedTheme={resolvedTheme}
                showProviderUnavailable={showProviderUnavailable}
                standaloneComposerImages={standaloneComposerImages}
                composerImages={composerImages}
                canOperateThread={canOperateThread}
                canInterrupt={canInterrupt}
                hasMessageToSend={hasMessageToSend}
                isEditingQueuedMessage={isEditingQueuedMessage}
                collapsedComposerPrimaryActionDisabled={collapsedComposerPrimaryActionDisabled}
                collapsedComposerPrimaryActionLabel={collapsedComposerPrimaryActionLabel}
                composerSendHeld={composerSendHeld}
                isSendBusy={isSendBusy}
                showResumeAction={showResumeAction}
                resumeCompactionTokens={resumeCompactionTokens}
                keepFullHistory={keepFullHistory}
                onExpandMobileComposer={expandMobileComposerStable}
                onExpandImage={onExpandImage}
                onCopySnapshot={copyComposerSnapshotStable}
                onInterrupt={handleInterruptPrimaryActionStable}
                onResume={onResume}
                onSubmit={() => submitComposer()}
              />
            ) : null}

            <ChatComposerBody
              environmentId={environmentId}
              linkedEnvironments={linkedEnvironments}
              gitCwd={gitCwd}
              activeThreadId={activeThreadId}
              activeThread={activeThread}
              composerDraftTargetKey={composerDraftTargetKey}
              composerSessionKey={composerSessionKey}
              composerSuggestionListId={composerSuggestionListId}
              isComposerCollapsedMobile={isComposerCollapsedMobile}
              isStashMenuOpen={isStashMenuOpen}
              setIsStashMenuOpen={setIsStashMenuOpen}
              composerMenuOpen={composerMenuOpen}
              composerMenuAnchor={composerMenuAnchor}
              setComposerMenuAnchor={setComposerMenuAnchor}
              observeWrappedPrompt={observeWrappedPrompt}
              composerFormRef={composerFormRef}
              stashQueue={stashQueue}
              keybindings={keybindings}
              terminalOpen={terminalOpen}
              restoreStashEntryStable={restoreStashEntryStable}
              deleteStashEntryStable={deleteStashEntryStable}
              composerTrigger={composerTrigger}
              composerMenuControllerRef={composerMenuControllerRef}
              resolvedTheme={resolvedTheme}
              pullRequestProjectId={pullRequestProjectId}
              pullRequestRepository={pullRequestRepository}
              threadPullRequests={threadPullRequests}
              sideChatAvailable={sideChatAvailable === true}
              sideChatDisabledReason={sideChatDisabledReason ?? null}
              freshSessionAvailable={onFreshSession !== undefined}
              compactSlashCommandAvailable={compactSlashCommandAvailable}
              selectedProvider={selectedProvider}
              selectedProviderSkills={selectedProviderSkills}
              selectedProviderSlashCommands={selectedProviderSlashCommands}
              settings={settings}
              workspaceSkillsScanning={workspaceSkillsScanning}
              questionAttachmentTarget={questionAttachmentTarget}
              providerInstanceEntries={providerInstanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              composerMenuItemsRef={composerMenuItemsRef}
              activeComposerMenuItemRef={activeComposerMenuItemRef}
              onSelectComposerItemStable={onSelectComposerItemStable}
              activeSuggestionId={activeSuggestionId}
              setActiveSuggestionId={setActiveSuggestionId}
              activeEditingQueuedAttachments={activeEditingQueuedAttachments}
              onRemoveEditingQueuedAttachment={onRemoveEditingQueuedAttachment}
              composerAttachmentMediaRow={composerAttachmentMediaRow}
              composerAttachmentFileList={composerAttachmentFileList}
              composerSendHeld={composerSendHeld}
              previewFile={previewFile}
              removeComposerFileFromDraft={removeComposerFileFromDraft}
              setPreviewFileId={setPreviewFileId}
              composerContextActions={composerContextActions}
              composerEditorRef={composerEditorRef}
              isLiteralPendingAnswer={isLiteralPendingAnswer}
              isPathQueryActiveStable={isPathQueryActiveStable}
              activePendingProgress={activePendingProgress}
              prompt={prompt}
              composerCursor={composerCursor}
              composerContextRecords={composerContextRecords}
              buildContextClipboardFragmentStable={buildContextClipboardFragmentStable}
              importContextFragmentStable={importContextFragmentStable}
              showMobilePendingAnswerActions={showMobilePendingAnswerActions}
              onPromptChangeStable={onPromptChangeStable}
              onComposerCommandKeyStable={onComposerCommandKeyStable}
              onPageScrollKeyDown={onPageScrollKeyDown}
              onPageScrollKeyUp={onPageScrollKeyUp}
              onPageScrollRelease={onPageScrollRelease}
              submitCitationAndSendStable={submitCitationAndSendStable}
              saveCitationDraftToPromptStable={saveCitationDraftToPromptStable}
              onComposerPasteStable={onComposerPasteStable}
              isComposerApprovalState={isComposerApprovalState}
              activePendingApproval={activePendingApproval}
              isChoiceOnlyPendingQuestion={isChoiceOnlyPendingQuestion}
              projectSelectionRequired={projectSelectionRequired}
              showProviderUnavailable={showProviderUnavailable}
              offeredPromptSuggestion={offeredPromptSuggestion}
              promptRef={promptRef}
              applyPromptReplacementStable={applyPromptReplacementStable}
              activePendingIsResponding={activePendingIsResponding}
              speechFreezesEditor={speechInput.freezesEditor}
              canOperateThread={canOperateThread}
              pendingPrimaryAction={pendingPrimaryAction}
              isSendBusy={isSendBusy}
              primaryActionSendDisabledReason={primaryActionSendDisabledReason}
              primaryActionEnvironmentUnavailable={primaryActionEnvironmentUnavailable}
              onPreviousActivePendingUserInputQuestion={onPreviousActivePendingUserInputQuestion}
              handleInterruptPrimaryActionStable={handleInterruptPrimaryActionStable}
              validationMessage={providerInputSubmissionError ?? composerSubmissionError}
            />

            <ChatComposerFooterBar
              environmentId={environmentId}
              activeThreadId={activeThreadId}
              activeRunId={activeThread?.runtime?.activeRunId ?? null}
              routeKind={routeKind}
              prompt={prompt}
              settings={settings}
              keybindings={keybindings}
              phase={phase}
              draftRunsLocally={draftRunsLocally}
              isComposerCollapsedMobile={isComposerCollapsedMobile}
              isMobileViewport={isMobileViewport}
              showMobilePendingAnswerActions={showMobilePendingAnswerActions}
              hasPendingUserInputs={pendingUserInputs.length > 0}
              dictationTakesFooter={dictationTakesFooter}
              isComposerPrimaryActionsCompact={isComposerPrimaryActionsCompact}
              composerAttachButton={composerAttachButton}
              composerControls={composerControls}
              attachExpandedComposerControls={attachExpandedComposerControls}
              showInlineRestingControls={showInlineRestingControls}
              setInlineRestingControlsHost={setInlineRestingControlsHost}
              attachRestingComposerControls={attachRestingComposerControls}
              restingControlsVisible={restingControlsVisible}
              canOperateThread={canOperateThread}
              pendingPrimaryAction={pendingPrimaryAction}
              canInterrupt={canInterrupt}
              followUpBehavior={followUpBehavior}
              canSteer={canSteer}
              voiceInputActive={voiceInputActive}
              isSendBusy={isSendBusy}
              composerSendHeld={composerSendHeld}
              primaryActionSendDisabledReason={primaryActionSendDisabledReason}
              primaryActionEnvironmentUnavailable={primaryActionEnvironmentUnavailable}
              isPreparingWorktree={isPreparingWorktree}
              hasMessageToSend={hasMessageToSend}
              showResumeAction={showResumeAction}
              isEditingQueuedMessage={isEditingQueuedMessage}
              onSubmitMessage={handleSubmitMessageStable}
              onResume={onResume}
              onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
              onInterrupt={handleInterruptPrimaryActionStable}
              resumeCompactionTokens={resumeCompactionTokens}
              keepFullHistory={keepFullHistory}
              onToggleKeepFullHistory={onToggleKeepFullHistory}
              speechInput={speechInput}
              dictationShortcutLabel={dictationShortcutLabel}
              dictationDisabled={dictationDisabled}
            />
          </div>
        </ComposerSurface.Main>
      </div>
    </form>
  );
});
