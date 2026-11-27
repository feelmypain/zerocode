import { type LegendListRef } from "@legendapp/list/react";
import { scopeProjectRef, scopeThreadRef } from "@zerocode/client-runtime/environment";
import { thrownErrorMessage } from "@zerocode/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@zerocode/client-runtime/state/runtime";
import { queuedRunEditBlockedReason } from "@zerocode/client-runtime/queued-run-edit";
import type { ThreadStructure } from "@zerocode/client-runtime/state/shell";
import {
  announcedRun,
  isDetailBehindShell,
} from "@zerocode/client-runtime/state/thread-activity-announcement";
import {
  type EnvironmentId,
  type ServerProvider,
  type ThreadId,
  type UsageLimitSourceSnapshots,
} from "@zerocode/contracts";
import { useGT, useMessages } from "gt-react";
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  use,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { SideChatParentPanel } from "~/lib/sideChatPane";
import { cn } from "~/lib/utils";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useStableCallback } from "../hooks/useStableCallback";
import { untrackSessionEphemeralThread } from "../lib/ephemeralThreads";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { useComposerHandleContext } from "../composerHandleContext";
import { FileMetadataThreadProvider } from "../hooks/FileMetadataThreadProvider";
import { shortcutLabelForCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { type TerminalContextDraft } from "../lib/terminalContext";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { usePanelAnimationSettings } from "../panelAnimations";
import { deriveCanInterruptRunningThread } from "../session-logic";
import { type BranchToolbarHandle } from "./BranchToolbar";
import { shouldShowComposerContextStrip } from "./BranchToolbar.logic";
import { NoActiveThreadState } from "./NoActiveThreadState";
import { ChatBannerLane } from "./chat/ChatBannerLane";
import { type ChatComposerHandle, type ChatComposerProps } from "./chat/ChatComposer";
import { WorkspaceMutationIdContext } from "./chat/ChatMarkdownMedia";
import { DeviceSetupDialogHost } from "./chat/ChatOverlayHosts";
import { ChatTerminalDrawers } from "./chat/ChatTerminalDrawers";
import { ChatViewComposerOverlay } from "./chat/ChatViewComposerOverlay";
import {
  ChatViewCanvasOverlays,
  ChatViewRootOverlays,
  ChatViewTimelineFooter,
} from "./chat/ChatViewDialogs";
import { ChatViewHeaderBar, ChatViewPanelLayoutControls } from "./chat/ChatViewHeaderBar";
import { ChatViewRightPanelSection } from "./chat/ChatViewRightPanelSection";
import { ChatWallpaperOverlay } from "./chat/ChatWallpaperOverlay";
import { type ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import { PanelLayoutControls, type PanelLayoutControlsProps } from "./chat/PanelLayoutControls";
import { type QueuedRunsControlHandle } from "./chat/QueuedRunsControl";
import { THREAD_FIND_BAR_RESERVED_HEIGHT } from "./chat/ThreadFindBar";
import { ThreadFind, ThreadFindCanvas } from "./chat/ThreadFindProvider";
import { ThreadTimeline } from "./chat/ThreadTimeline";
import { ScrollToEndButton, WorkspaceFileDropOverlay } from "./chat/TimelineOverlays";
import { BackgroundThreadContext } from "./chat/backgroundThread";
import { draftSendState } from "./chat/chatViewSend";
import { useChatViewBanners } from "./chat/useChatViewBanners";
import { useChatViewCoreActions } from "./chat/useChatViewCoreActions";
import { useChatViewLifecycleState } from "./chat/useChatViewLifecycleState";
import { useChatViewOverlayLayout } from "./chat/useChatViewOverlayLayout";
import { useChatViewPanels } from "./chat/useChatViewPanels";
import { useChatViewRouteData } from "./chat/useChatViewRouteData";
import { useChatViewShortcuts } from "./chat/useChatViewShortcuts";
import { useChatViewTimeline } from "./chat/useChatViewTimeline";
import { useChatViewTurnActions } from "./chat/useChatViewTurnActions";
import { useChatViewWorkspace } from "./chat/useChatViewWorkspace";
import { useComposerFocus } from "./chat/useComposerFocus";
import { useDraftEnvironmentRouting } from "./chat/useDraftEnvironmentRouting";
import { useFocusComposerOnThreadOpen } from "./chat/useFocusComposerOnThreadOpen";
import { useTimelineFollow } from "./chat/useTimelineFollow";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";

const EMPTY_USAGE_LIMIT_SOURCES: UsageLimitSourceSnapshots = [];
const EMPTY_RUNS: ThreadStructure["runs"] = [];
const EMPTY_COMPOSER_BANNER_ITEMS: ReadonlyArray<ComposerBannerStackItem> = [];

type ChatViewProps =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      /** A side chat in its parent's right panel; the parent keeps the keyboard and workspace UI. */
      embedded?: SideChatParentPanel;
      routeKind: "server";
      draftId?: never;
    }
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      embedded?: never;
      routeKind: "draft";
      draftId: DraftId;
    };

const ignoreComposerFocus = () => {};

export default function ChatView(props: ChatViewProps) {
  const gt = useGT();
  const messages = useMessages();
  const {
    environmentId,
    threadId,
    routeKind,
    onDiffPanelOpen,
    reserveTitleBarControlInset = true,
    forceExpandedMobileComposer = false,
    embedded: parentPanel,
  } = props;
  const embedded = parentPanel !== undefined;
  const draftId = routeKind === "draft" ? props.draftId : null;

  const promptRef = useRef("");
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  const composerRef = useComposerHandleContext() ?? localComposerRef;
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const branchToolbarRef = useRef<BranchToolbarHandle>(null);
  const threadPanelPopoverAnchorRef = useRef<HTMLElement | null>(null);
  const legendListRef = useRef<LegendListRef | null>(null);
  const queuedRunsControlRef = useRef<QueuedRunsControlHandle>(null);
  const conversationArea = workspaceAreaProps("conversation", 1, gt("Conversation"));
  const backgroundThread = use(BackgroundThreadContext);
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();

  const route = useChatViewRouteData({
    environmentId,
    threadId,
    routeKind,
    draftId,
    embedded,
    parentPanel,
    promptRef,
    composerRef,
  });

  const currentRouteThreadKeyRef = useRef<string | null>(route.routeThreadKey);
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- publishes the committed route thread key to a ref that async handlers check before applying results
  useLayoutEffect(() => {
    currentRouteThreadKeyRef.current = route.routeThreadKey;
    return () => {
      currentRouteThreadKeyRef.current = null;
    };
  }, [route.routeThreadKey]);
  const [workspaceLayoutElement, setWorkspaceLayoutElement] = useState<HTMLDivElement | null>(null);
  const { sendInFlight: sendInFlightRef } = draftSendState(route.routeThreadKey);
  const feedbackUploadsInFlightRef = useRef(new Set<string>());

  const isLocalDraftThread = !route.isServerThread && route.localDraftThread !== undefined;
  const workspace = useChatViewWorkspace({
    environmentId,
    routeKind,
    draftId,
    routeThreadDetailRef: route.routeThreadDetailRef,
    isServerThread: route.isServerThread,
    isLocalDraftThread,
    activeThread: route.activeThread,
    serverThread: route.serverThread,
    serverThreadShell: route.serverThreadShell,
    serverProjection: route.serverProjection,
    serverVisibleTurnItems: route.serverVisibleTurnItems,
    serverThreadHistoryHasMore: route.serverThreadHistory.hasMoreHistory,
    threadStatus: route.threadStatus,
    draftThread: route.draftThread,
    draftFallback: route.draftFallback,
    activeRuntime: route.activeRuntime,
    reportedModelSelection: route.reportedModelSelection,
    supportsProviderSwitchingViaHandoff: route.supportsProviderSwitchingViaHandoff,
    canOperateThread: route.canOperateThread,
    canWriteSourceControl: route.canWriteSourceControl,
    committedServerMessageCount: route.committedServerMessageIds.size,
    environmentById: route.environmentById,
    providersByEnvironment: route.providersByEnvironment,
    primaryEnvironment: route.primaryEnvironment,
    settings: route.settings,
    clientSettingsHydrated: route.clientSettingsHydrated,
    composerRuntimeMode: route.composerRuntimeMode,
    composerActiveProvider: route.composerActiveProvider,
    composerModelSelectionExplicit: route.composerModelSelectionExplicit,
    composerSelectedModelSelection: route.composerSelectedModelSelection,
    composerHasAttachments: route.composerHasAttachments,
    timelineThreadError: route.timelineThreadError,
    terminalOpen: Boolean(route.terminalUiState.terminalOpen),
  });

  const timeline = useChatViewTimeline({
    environmentId,
    threadId,
    routeThreadRef: route.routeThreadRef,
    routeThreadKey: route.routeThreadKey,
    draftId,
    isServerThread: route.isServerThread,
    isLocalDraftThread,
    activeThread: route.activeThread,
    activeThreadId: workspace.activeThreadId,
    activeThreadRef: workspace.activeThreadRef,
    activeThreadKey: workspace.activeThreadKey,
    serverProjection: route.serverProjection,
    serverVisibleTurnItems: route.serverVisibleTurnItems,
    activeLatestRun: route.activeLatestRun,
    activeActivityRun: route.activeActivityRun,
    activeRuntime: route.activeRuntime,
    runlessWorkStartedAt: route.runlessWorkStartedAt,
    phase: workspace.phase,
    threadError: route.threadError,
    supportsQuestionAttachments: workspace.supportsQuestionAttachments,
    composerDraftTarget: route.composerDraftTarget,
    setComposerDraftPrompt: route.setComposerDraftPrompt,
    promptRef,
    composerRef,
    setThreadError: route.setThreadError,
    activeProviderInstanceId: workspace.activeProviderInstanceId,
    activeUsageModel: workspace.activeUsageModel,
    activeProviderStatus: workspace.activeProviderStatus,
    selectedProviderEntry: workspace.selectedProviderEntry,
    providerStatuses: workspace.providerStatuses,
    serverConfig: workspace.serverConfig,
    optimisticState: route.optimisticState,
    optimisticBlobPreviews: route.optimisticBlobPreviews,
    optimisticUserMessages: route.optimisticUserMessages,
    setHeldOptimisticUserMessages: route.setHeldOptimisticUserMessages,
    feedbackSubmissions: route.feedbackSubmissions,
    panelAnimationsActive,
    panelAnimationDurationMs,
  });

  // Provider-native subagents cannot take messages; approvals and questions go to the top-level parent.
  const showProviderSubagentBar = route.isProviderSubagent;
  const composerMounted = !showProviderSubagentBar;
  const showComposerContextStrip =
    !embedded &&
    shouldShowComposerContextStrip({
      isDraftHeroState: timeline.isDraftHeroState,
      persistInActiveThreads: route.settings.persistComposerContextStrip,
      hasActiveProject: workspace.activeProject !== null && !showProviderSubagentBar,
      isGitRepo: workspace.isGitRepo,
      showEnvironmentIndicator: workspace.showComposerEnvironmentIndicator,
    });

  const {
    composerOverlayElement,
    setComposerOverlayElement,
    composerTimelineInset,
    composerReservedHeight,
    composerTimelineInsetRef,
    publishComposerOverlayHeightStable,
    updateScrollToEndClearanceCssVarStable,
  } = useChatViewOverlayLayout({
    activeThreadKey: workspace.activeThreadKey,
    composerMounted,
    isDraftHeroState: timeline.isDraftHeroState,
  });

  const {
    needsLoadBalancing,
    loadBalancing,
    refreshBeforeSend,
    onAutoEnvironmentStable,
    autoEnvironmentLabel,
    isEnvironmentChanging,
    readPendingEnvironmentChange,
    onEnvironmentChangeStable,
  } = useDraftEnvironmentRouting({
    draftId,
    draftThread: route.draftThread,
    envLocked: workspace.envLocked,
    automaticEnvironment: workspace.automaticEnvironment,
    logicalProjectEnvironments: workspace.logicalProjectEnvironments,
    environmentById: route.environmentById,
    providersByEnvironment: route.providersByEnvironment,
    loadBalancingSettings: workspace.loadBalancingSettings,
    referencedThreadContexts: route.referencedThreadContexts,
    activeProviderInstanceId: workspace.activeProviderInstanceId,
    selectedProvider: workspace.selectedProvider,
    composerHasAttachments: route.composerHasAttachments,
    activeProjectKey: workspace.activeProjectKey,
    activeProjectIsScratch: workspace.activeProjectIsScratch,
    projectGroupingSettings: workspace.projectGroupingSettings,
    sendInFlightRef,
  });

  const { focusComposer: focusComposerStable, scheduleComposerFocus: scheduleComposerFocusStable } =
    useComposerFocus(composerRef);
  const canInterruptRunningThread =
    route.canOperateThread &&
    deriveCanInterruptRunningThread(route.activeThread !== undefined, route.activeRuntime);
  const coreActions = useChatViewCoreActions({
    environmentId,
    routeThreadKey: route.routeThreadKey,
    embedded,
    isServerThread: route.isServerThread,
    serverThread: route.serverThread,
    activeThread: route.activeThread,
    activeThreadId: workspace.activeThreadId,
    activeThreadRef: workspace.activeThreadRef,
    composerDraftTarget: route.composerDraftTarget,
    runtimeMode: workspace.runtimeMode,
    terminalOpen: Boolean(route.terminalUiState.terminalOpen),
    isMobileViewport: route.isMobileViewport,
    isCoarsePointer: route.isCoarsePointer,
    composerRef,
    focusComposerStable,
    scheduleComposerFocusStable,
    setThreadError: route.setThreadError,
  });

  const panels = useChatViewPanels({
    environmentId,
    routeThreadRef: route.routeThreadRef,
    embedded,
    isServerThread: route.isServerThread,
    isSubagentThread: route.isSubagentThread,
    canOperateThread: route.canOperateThread,
    activeThread: route.activeThread,
    activeThreadId: workspace.activeThreadId,
    activeThreadRef: workspace.activeThreadRef,
    activeThreadKey: workspace.activeThreadKey,
    activeThreadShell: route.activeThreadShell,
    panelHostShell: route.panelHostShell,
    activeProject: workspace.activeProject,
    activeProjectCwd: workspace.activeProjectCwd,
    activeProjectScripts: workspace.activeProjectScripts,
    activeThreadWorktreePath: workspace.activeThreadWorktreePath,
    activeLatestRun: route.activeLatestRun,
    activeRuntime: route.activeRuntime,
    serverProjection: route.serverProjection,
    serverConfig: workspace.serverConfig,
    settings: route.settings,
    clientSettingsHydrated: route.clientSettingsHydrated,
    threadDetailLoading: route.threadDetailLoading,
    runtimeMode: workspace.runtimeMode,
    browserAvailable: workspace.browserAvailable,
    diffAvailable: workspace.diffAvailable,
    pullRequestsCapabilityKnown: workspace.pullRequestsCapabilityKnown,
    supportsPullRequests: workspace.supportsPullRequests,
    prefersPlanSidebarSheet: route.prefersPlanSidebarSheet,
    panelAnimationsActive,
    panelAnimationDurationMs,
    terminalUiState: route.terminalUiState,
    runningTerminalIds: workspace.runningTerminalIds,
    activeServerOrderedTerminalIds: workspace.activeServerOrderedTerminalIds,
    activeTerminalLabelsById: workspace.activeTerminalLabelsById,
    canReuseTerminal: workspace.canReuseTerminal,
    gitCwd: workspace.gitCwd,
    gitStatusData: workspace.gitStatusQuery.data,
    turnDiffSummaries: workspace.turnDiffSummaries,
    onDiffPanelOpen,
    composerRef,
    setThreadError: route.setThreadError,
  });

  const {
    showScrollToBottom,
    timelineLiveFollowEnabled,
    onComposerPageScrollKeyDownStable,
    onComposerPageScrollKeyUpStable,
    onComposerPageScrollReleaseStable,
    scrollToEnd,
    onTimelineAnchorReadyStable,
    onTimelineAnchorSizeChangedStable,
    onTimelineFooterGrowStable,
    onIsAtEndChangeStable,
    anchorNewTurn,
    attachTimelineViewport,
    attachComposerOverlay: attachFollowComposerOverlay,
  } = useTimelineFollow({
    legendListRef,
    composerTimelineInset,
    routeThreadKey: route.routeThreadKey,
    activeThreadKey: workspace.activeThreadKey,
    isServerThread: route.isServerThread,
    serverProjection: route.serverProjection,
    threadStatus: route.threadStatus,
    activeActivityRun: route.activeActivityRun,
    activeRunningTurnId: panels.activeRunningTurnId,
    timelineEntries: timeline.timelineEntries,
    timelineAnchorMessageId: timeline.timelineAnchorMessageId,
    setTimelineAnchor: timeline.setTimelineAnchor,
  });

  useFocusComposerOnThreadOpen(
    workspace.activeThreadRef,
    workspaceLayoutElement,
    !embedded,
    route.terminalUiState.terminalOpen,
    route.isCoarsePointer ? ignoreComposerFocus : focusComposerStable,
  );

  const {
    envMode,
    sendEnvMode,
    localCheckoutBranchMismatch,
    lifecycle,
    pendingHandoff,
    compactThreadUnavailable,
    compactDisabled,
    freshSessionPending,
    freshSessionCommandAvailable,
    resumeCompactionTokens,
    keepFullHistory,
    setKeepFullHistory,
    composerSendHeld,
    cancelHeldSendStable,
    toggleKeepFullHistoryStable,
    armFreshSessionStable,
    handleRestoreThreadBranchStable,
    threadFindEnabled,
    isThreadFindActive,
    openThreadFindStable,
    shownThreadSyncPhase,
    hasThreadNow,
    hasQueuedTurns,
    scrollToEndSummary,
  } = useChatViewLifecycleState({
    environmentId,
    routeThreadKey: route.routeThreadKey,
    currentRouteThreadKeyRef,
    isServerThread: route.isServerThread,
    isLocalDraftThread,
    canOperateThread: route.canOperateThread,
    canWriteSourceControl: route.canWriteSourceControl,
    clientSettingsHydrated: route.clientSettingsHydrated,
    activeThread: route.activeThread,
    activeThreadId: workspace.activeThreadId,
    activeThreadRef: workspace.activeThreadRef,
    routeThreadDetailRef: route.routeThreadDetailRef,
    activeThreadKey: workspace.activeThreadKey,
    activeThreadBranch: workspace.activeThreadBranch,
    activeThreadShell: route.activeThreadShell,
    activeLatestRun: route.activeLatestRun,
    activeRuntime: route.activeRuntime,
    hasActiveProject: workspace.activeProject !== null,
    activeProjectCwd: workspace.activeProjectCwd,
    activeMessageCount: workspace.activeMessageCount,
    draftThread: route.draftThread,
    serverThreadLatestUserMessageAt: route.serverThread?.latestUserMessageAt ?? null,
    serverProjection: route.serverProjection,
    serverVisibleTurnItems: route.serverVisibleTurnItems,
    serverThreadHistoryHasMore: route.serverThreadHistory.hasMoreHistory,
    serverConfig: workspace.serverConfig,
    settings: route.settings,
    runtimeMode: workspace.runtimeMode,
    phase: workspace.phase,
    selectedProvider: workspace.selectedProvider,
    activeProviderInstanceId: workspace.activeProviderInstanceId,
    providerStatuses: workspace.providerStatuses,
    providerInstanceEntries: workspace.providerInstanceEntries,
    composerModelSelectionApplies: workspace.composerModelSelectionApplies,
    composerSelectedModelSelection: route.composerSelectedModelSelection,
    multipleModelSelections: route.multipleModelSelections,
    manualCompactionProviderAvailable: workspace.manualCompactionProviderAvailable,
    activeEnvironmentUnavailable: workspace.activeEnvironmentUnavailable,
    isGitRepo: workspace.isGitRepo,
    tracksGitRepositories: workspace.worktreeRepositoryChoices.tracksGitRepositories,
    canOverrideServerThreadEnvMode: workspace.canOverrideServerThreadEnvMode,
    pendingServerThreadEnvMode: workspace.pendingServerThreadEnvMode,
    gitStatusQuery: workspace.gitStatusQuery,
    isWorking: timeline.isWorking,
    isPreparingWorktree: timeline.isPreparingWorktree,
    isRevertingCheckpoint: route.isRevertingCheckpoint,
    threadDetailLoading: route.threadDetailLoading,
    feedbackUploading: route.feedbackUploading,
    hasHeldQueuedRuns: route.hasHeldQueuedRuns,
    limitRecoveryHoldsSnooze: route.limitRecoveryHoldsSnooze,
    resumeCompactionPermanentlyDismissed: workspace.resumeCompactionPermanentlyDismissed,
    nativeResumeCompactionDismissed: workspace.nativeResumeCompactionDismissed,
    activeContextWindow: timeline.activeContextWindow,
    activeThreadLiveTokenUsage: timeline.activeThreadLiveTokenUsage,
    pendingBackgroundTasks: timeline.pendingBackgroundTasks,
    pendingApprovals: timeline.pendingApprovals,
    pendingUserInputs: timeline.pendingUserInputs,
    activePendingApproval: timeline.activePendingApproval,
    activePendingUserInput: timeline.activePendingUserInput,
    delayedThreadSyncPhase: route.delayedThreadSyncPhase,
    optimisticUserMessages: route.optimisticUserMessages,
    composerDraftTarget: route.composerDraftTarget,
    composerRef,
    sendInFlightRef,
    showScrollToBottom,
    composerOverlayElement,
    composerTimelineInsetRef,
    updateScrollToEndClearanceCssVarStable,
    setOptimisticUserMessages: route.setOptimisticUserMessages,
    setThreadError: route.setThreadError,
    clearUsageLimitsFor: timeline.clearUsageLimitsFor,
    beginLocalDispatch: timeline.beginLocalDispatch,
    resetLocalDispatch: timeline.resetLocalDispatch,
    scrollToEnd,
    focusComposerStable,
    persistThreadSettingsForNextTurn: coreActions.persistThreadSettingsForNextTurn,
  });

  const { getShortcutContextStable } = useChatViewShortcuts({
    environmentId,
    routeKind,
    activeThreadId: workspace.activeThreadId,
    activeThreadKey: workspace.activeThreadKey,
    isServerThread: route.isServerThread,
    backgroundThread,
    embedded,
    terminalOpen: Boolean(route.terminalUiState.terminalOpen),
    previewPanelOpen: panels.previewPanelOpen,
    rightPanelOpen: panels.rightPanelOpen,
    isThreadFindActive,
    phase: workspace.phase,
    isEditingQueuedRun: route.queuedRunEdit.isEditing,
    pendingUserInputs: timeline.pendingUserInputs,
    composerHasNonPromptContent: route.composerHasNonPromptContent,
    settings: route.settings,
    serverConfig: workspace.serverConfig,
    keybindings: workspace.keybindings,
    scriptKeybindings: workspace.scriptKeybindings,
    showOpenInPicker: workspace.showOpenInPicker,
    openInEnvironmentId: workspace.openInEnvironmentId,
    availableEditors: workspace.availableEditors,
    gitCwd: workspace.gitCwd,
    canChangeEnvironment: workspace.canChangeEnvironment,
    logicalProjectEnvironments: workspace.logicalProjectEnvironments,
    readPendingEnvironmentChange,
    onEnvironmentChangeStable,
    canInterruptRunningThread,
    onInterruptStable: coreActions.onInterruptStable,
    copyActiveThreadReference: panels.copyActiveThreadReference,
    hasActiveProject: workspace.activeProject !== null,
    canOperateTerminal: route.canOperateTerminal,
    activeProjectScripts: workspace.activeProjectScripts,
    runProjectScriptStable: panels.runProjectScriptStable,
    activeRightPanelSurface: panels.activeRightPanelSurface,
    closeRightPanelSurface: panels.closeRightPanelSurface,
    toggleRightPanelStable: panels.toggleRightPanelStable,
    toggleRightPanelMaximizedStable: panels.toggleRightPanelMaximizedStable,
    focusComposerStable,
    composerOverlayElement,
    promptRef,
    composerRef,
    branchToolbarRef,
    queuedRunsControlRef,
    terminalShortcuts: panels.terminalShortcuts,
    rightPanelShortcuts: panels.rightPanelShortcuts,
    threadLifecycleShortcuts: lifecycle.shortcuts,
  });

  const turnActions = useChatViewTurnActions({
    rewind: {
      environmentId,
      routeThreadRef: route.routeThreadRef,
      routeThreadKey: route.routeThreadKey,
      currentRouteThreadKeyRef,
      serverProjection: route.serverProjection,
      activeThread: route.activeThread,
      timelineMessages: timeline.timelineMessages,
      phase: workspace.phase,
      isSendBusy: timeline.isSendBusy,
      isRevertingCheckpoint: route.isRevertingCheckpoint,
      supportsConversationRollback: workspace.supportsConversationRollback,
      activeEnvironmentUnavailable: workspace.activeEnvironmentUnavailable,
      activeEnvironmentUnavailableLabel: workspace.activeEnvironmentUnavailableLabel,
      promptRef,
      composerRef,
      composerDraftTarget: route.composerDraftTarget,
      setThreadError: route.setThreadError,
    },
    selection: {
      environmentId,
      composerDraftTarget: route.composerDraftTarget,
      draftThread: route.draftThread,
      activeThread: route.activeThread,
      activeRuntime: route.activeRuntime,
      activeProjectSettings: workspace.activeProjectSettings,
      settings: route.settings,
      providerStatuses: workspace.providerStatuses,
      lockedProvider: workspace.lockedProvider,
      supportsProviderSwitchingViaHandoff: route.supportsProviderSwitchingViaHandoff,
      multipleModelSelections: route.multipleModelSelections,
      runtimeMode: workspace.runtimeMode,
      isLocalDraftThread,
      canOverrideServerThreadEnvMode: workspace.canOverrideServerThreadEnvMode,
      setPendingServerThreadEnvModeEntry: workspace.setPendingServerThreadEnvModeEntry,
      setPendingServerThreadStartFromOriginByThreadId:
        workspace.setPendingServerThreadStartFromOriginByThreadId,
      scheduleComposerFocus: scheduleComposerFocusStable,
    },
    resume: {
      environmentId,
      routeThreadKey: route.routeThreadKey,
      currentRouteThreadKeyRef,
      activeThread: route.activeThread,
      resumableRunId: route.resumableRunId,
      hasHeldQueuedRuns: route.hasHeldQueuedRuns,
      canResume: route.canResume,
      isSendBusy: timeline.isSendBusy,
      isRevertingCheckpoint: route.isRevertingCheckpoint,
      threadDetailLoading: route.threadDetailLoading,
      activeEnvironmentUnavailable: workspace.activeEnvironmentUnavailable,
      runtimeMode: workspace.runtimeMode,
      localCheckoutBranchMismatch,
      composerRef,
      persistThreadSettingsForNextTurn: coreActions.persistThreadSettingsForNextTurn,
      clearUsageLimitsFor: timeline.clearUsageLimitsFor,
      scrollToEnd,
      setThreadError: route.setThreadError,
    },
    send: {
      environmentId,
      routeThreadKey: route.routeThreadKey,
      currentRouteThreadKeyRef,
      draftId,
      draftThread: route.draftThread,
      activeThread: route.activeThread,
      activeThreadKey: workspace.activeThreadKey,
      activeThreadBranch: workspace.activeThreadBranch,
      activeProject: workspace.activeProject,
      activeProjectIsScratch: workspace.activeProjectIsScratch,
      activeProjectDefaultModelSelection: workspace.activeProjectDefaultModelSelection,
      activeMessageCount: workspace.activeMessageCount,
      isServerThread: route.isServerThread,
      isLocalDraftThread,
      isGitRepo: workspace.isGitRepo,
      phase: workspace.phase,
      runtimeMode: workspace.runtimeMode,
      sendEnvMode,
      worktreeRepositories: workspace.worktreeRepositories,
      startFromOrigin: workspace.startFromOrigin,
      localCheckoutBranchMismatch,
      logicalProjectEnvironments: workspace.logicalProjectEnvironments,
      providerInstanceEntries: workspace.providerInstanceEntries,
      composerRef,
      composerDraftTarget: route.composerDraftTarget,
      promptRef,
      composerImagesRef,
      composerFilesRef,
      composerTerminalContextsRef,
      feedbackUploadsInFlightRef,
      queuedRunEdit: route.queuedRunEdit,
      isRevertingCheckpoint: route.isRevertingCheckpoint,
      threadDetailLoading: route.threadDetailLoading,
      activeEnvironmentUnavailable: workspace.activeEnvironmentUnavailable,
      isSendBusy: timeline.isSendBusy,
      sendQueuesBehindSetup: timeline.sendQueuesBehindSetup,
      isDraftHeroState: timeline.isDraftHeroState,
      panelAnimationsActive,
      panelAnimationDurationMs,
      keepFullHistory,
      freshSessionAvailable: freshSessionCommandAvailable,
      resumeCompactionTokens,
      usageLimitsKey: timeline.usageLimitsKey,
      usageLimitsOffered: timeline.usageLimitsOffered,
      openUsageLimits: timeline.openUsageLimits,
      clearUsageLimitsFor: timeline.clearUsageLimitsFor,
      needsLoadBalancing,
      loadBalancing,
      refreshBeforeSend,
      readPendingEnvironmentChange,
      pendingApprovals: timeline.pendingApprovals,
      respondingRequestIds: timeline.respondingRequestIds,
      activePendingUserInput: timeline.activePendingUserInput,
      onAdvanceActivePendingUserInput: timeline.onAdvanceActivePendingUserInput,
      onRespondToApproval: timeline.onRespondToApprovalStable,
      beginLocalDispatch: timeline.beginLocalDispatch,
      resetLocalDispatch: timeline.resetLocalDispatch,
      beginWorktreeSetup: timeline.beginWorktreeSetup,
      captureDraftHeroComposerRect: timeline.captureDraftHeroComposerRect,
      setDockedDraftHeroThreadKey: timeline.setDockedDraftHeroThreadKey,
      setSetupQueueSendThreadKey: timeline.setSetupQueueSendThreadKey,
      setOptimisticUserMessages: route.setOptimisticUserMessages,
      optimisticBlobPreviews: {
        track: (message) => route.optimisticBlobPreviews.track(threadId, message),
        release: (message) => route.optimisticBlobPreviews.release(threadId, message),
      },
      setFeedbackSubmissionsByThreadKey: route.setFeedbackSubmissionsByThreadKey,
      setThreadError: route.setThreadError,
      setKeepFullHistory,
      anchorNewTurn,
      acknowledgeActiveThreadWoke: lifecycle.acknowledgeActiveThreadWoke,
      onSideChat: panels.sideChat.available ? panels.sendSideChatStable : undefined,
      sideChatDisabledReason: panels.sideChatDisabledReason,
      handleNewThreadInActiveProject: workspace.handleNewThreadInActiveProject,
      persistThreadSettingsForNextTurn: coreActions.persistThreadSettingsForNextTurn,
      linkCheckoutPullRequest: workspace.linkCheckoutPullRequest,
    },
    routeThreadKey: route.routeThreadKey,
    draftId,
    serverProjection: route.serverProjection,
    compactDisabled,
    sendStandaloneCommand: lifecycle.sendStandaloneCommand,
    worktreeSetup: timeline.worktreeSetup,
    cancelWorktreeSetup: timeline.cancelWorktreeSetup,
    isLocalDraftThread,
    isSendBusy: timeline.isSendBusy,
    isRevertingCheckpoint: route.isRevertingCheckpoint,
    threadDetailLoading: route.threadDetailLoading,
    clientSettingsHydrated: route.clientSettingsHydrated,
    needsLoadBalancing,
    activeEnvironmentUnavailable: workspace.activeEnvironmentUnavailable,
    hasActivePendingUserInput: Boolean(timeline.activePendingUserInput),
    feedbackUploading: route.feedbackUploading,
    sendEnvMode,
    sendInFlightRef,
    feedbackUploadsInFlightRef,
    timelineLiveFollowEnabled,
    scrollToEnd,
  });

  const composerBannerItems = useChatViewBanners({
    environmentId,
    routeThreadKey: route.routeThreadKey,
    composerDraftTarget: route.composerDraftTarget,
    isServerThread: route.isServerThread,
    draftThread: route.draftThread,
    draftDefaultModelSelection: route.draftDefaultModelSelection,
    draftFallback: route.draftFallback,
    activeThreadShell: route.activeThreadShell,
    activeThreadEnvironmentId: route.activeThread?.environmentId ?? null,
    activeEnvironment: workspace.activeEnvironment,
    activeEnvironmentUnavailable: workspace.activeEnvironmentUnavailable,
    activeEnvironmentUnavailableState: workspace.activeEnvironmentUnavailableState,
    serverConfig: workspace.serverConfig,
    serverProjection: route.serverProjection,
    serverRuntime: route.serverRuntime,
    providerStatuses: workspace.providerStatuses,
    settings: route.settings,
    timestampFormat: route.timestampFormat,
    hasMultipleRegisteredEnvironments: route.environments.length > 1,
    automaticEnvironment: workspace.automaticEnvironment,
    autoUpdateEnvironments: workspace.autoUpdateEnvironments,
    multipleModelSelections: route.multipleModelSelections,
    composerModelSelectionExplicit: route.composerModelSelectionExplicit,
    composerSelectedModelSelection: route.composerSelectedModelSelection,
    feedbackSubmissions: route.feedbackSubmissions,
    setFeedbackSubmissionsByThreadKey: route.setFeedbackSubmissionsByThreadKey,
    limitRecoveryRun: route.limitRecoveryRun,
    pendingApprovals: timeline.pendingApprovals,
    pendingUserInputs: timeline.pendingUserInputs,
    activePendingApproval: timeline.activePendingApproval,
    usageLimitsBanner: timeline.usageLimitsBanner,
    projectCloneBannerItem: workspace.projectCloneBannerItem,
    freshSessionPending,
    composerSendHeld,
    cancelHeldSendStable,
    localCheckoutBranchMismatch,
    showBranchMismatchBanner: lifecycle.showBranchMismatchBanner,
    activeBranchMismatchKey: lifecycle.activeBranchMismatchKey,
    canWriteSourceControl: route.canWriteSourceControl,
    isRestoringThreadBranch: lifecycle.isRestoringThreadBranch,
    handleRestoreThreadBranchStable,
    setBranchMismatchDismissTick: lifecycle.setBranchMismatchDismissTick,
    onProviderModelSelectStable: turnActions.onProviderModelSelectStable,
  });

  // The end of the timeline holds the thread's present and next turns: what it is doing now,
  // its lifecycle status, guest messages awaiting you, then your queued messages.
  const timelineFooter =
    pendingHandoff === null &&
    !hasThreadNow &&
    lifecycle.threadStatusLine === null &&
    turnActions.pendingGuestMessageCount === 0 &&
    !hasQueuedTurns ? null : (
      <ChatViewTimelineFooter
        environmentId={environmentId}
        routeThreadKey={route.routeThreadKey}
        isServerThread={route.isServerThread}
        activeThread={route.activeThread}
        pendingHandoff={pendingHandoff}
        providerStatuses={workspace.providerStatuses}
        attentionNow={lifecycle.attentionNow}
        workNow={lifecycle.workNow}
        shownThreadSyncPhase={shownThreadSyncPhase}
        goalNow={lifecycle.goalNow}
        threadStatusLine={lifecycle.threadStatusLine}
        pendingGuestMessageCount={turnActions.pendingGuestMessageCount}
        hasQueuedTurns={hasQueuedTurns}
        queuedRunsControlRef={queuedRunsControlRef}
        steerShortcutLabel={shortcutLabelForCommand(
          workspace.keybindings,
          "thread.steerQueuedMessage",
          {
            context: { terminalFocus: false },
          },
        )}
        editShortcutLabel={shortcutLabelForCommand(
          workspace.keybindings,
          "thread.editQueuedMessage",
          {
            context: { composerFocus: true },
          },
        )}
        optimisticUserMessages={route.optimisticUserMessages}
        editingRunId={route.queuedRunEdit.editingRunId}
        editBlockedReason={queuedRunEditBlockedReason(
          { openQuestionCount: timeline.pendingUserInputs.length },
          messages,
        )}
        onEditQueuedRun={route.queuedRunEdit.beginEdit}
        onCancelEdit={route.queuedRunEdit.cancelEdit}
        timestampFormat={route.timestampFormat}
        onOpenThread={lifecycle.onOpenRelatedThreadStable}
        onImageExpand={coreActions.onExpandTimelineImageStable}
        onFileOpen={coreActions.openFileAttachmentStable}
      />
    );

  // Above the early return, where React Compiler can cache it for the side chat pane.
  const handleNewThread = useNewThreadHandler();
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const keepEphemeralThreadStable = useStableCallback(() => {
    const targetRef = workspace.activeThreadRef;
    if (!route.isServerThread || !route.canOperateThread || targetRef === null) return;
    void updateThreadMetadata({
      environmentId: targetRef.environmentId,
      input: { threadId: targetRef.threadId, ephemeral: false },
    }).then((result) => {
      if (result._tag === "Success") {
        untrackSessionEphemeralThread(targetRef);
        toastManager.add({
          type: "success",
          title: gt("Chat saved"),
          description: gt("This conversation will stay in your history."),
        });
      } else if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Failed to keep chat"),
            description:
              thrownErrorMessage(squashAtomCommandFailure(result), messages) ?? undefined,
          }),
        );
      }
    });
  });
  const toggleEphemeralStable = useStableCallback(() => {
    if (route.isServerThread) {
      if (route.activeThread?.ephemeral) {
        keepEphemeralThreadStable();
        return;
      }
      const project = workspace.activeProject;
      if (!project) return;
      void handleNewThread(scopeProjectRef(project.environmentId, project.id), {
        ephemeral: true,
      });
      return;
    }
    if (draftId !== null) {
      useComposerDraftStore.getState().setDraftThreadContext(draftId, {
        ephemeral: !(route.draftThread?.ephemeral === true),
      });
    }
  });
  const sideChatParentPanel = {
    hostRef: scopeThreadRef(environmentId, threadId),
    openToolDiff: panels.onOpenToolDiffStable,
    runShellCommand: panels.runSideChatShellCommandStable,
  };

  if (!route.activeThread) {
    return embedded ? null : <NoActiveThreadState />;
  }
  const activeThread = route.activeThread;

  const panelToggleControlProps = {
    terminalAvailable: workspace.activeProject !== null,
    terminalOpen: route.terminalUiState.terminalOpen,
    terminalShortcutLabel: shortcutLabelForCommand(workspace.keybindings, "terminal.toggle"),
    threadPanelOpen: panels.threadPanelOpen,
    threadPanelPresentation: panels.threadPanelPresentation,
    threadPanelPopoverHandle: panels.threadPanelPopoverHandle,
    threadPanelShortcutLabel: shortcutLabelForCommand(workspace.keybindings, "threadPanel.toggle"),
    rightPanelAvailable: workspace.activeProject !== null,
    rightPanelOpen: panels.rightPanelOpen,
    rightPanelShortcutLabel: shortcutLabelForCommand(workspace.keybindings, "rightPanel.toggle"),
    onToggleTerminal: panels.toggleTerminalVisibilityStable,
    onToggleThreadPanel: panels.toggleThreadPanelStable,
    onToggleRightPanel: panels.toggleRightPanelStable,
  } satisfies PanelLayoutControlsProps;
  const panelToggleControls = (
    <PanelLayoutControls
      {...panelToggleControlProps}
      showThreadPanelControl={!panels.inlineRightPanelOwnsTitleBar}
    />
  );
  const panelLayoutControls = (
    <ChatViewPanelLayoutControls
      panelToggleControlProps={panelToggleControlProps}
      inlineRightPanelOwnsTitleBar={panels.inlineRightPanelOwnsTitleBar}
      shouldUsePlanSidebarSheet={panels.shouldUsePlanSidebarSheet}
      rightPanelOpen={panels.rightPanelOpen}
      panelAnimationsActive={panelAnimationsActive}
      rightPanelMaximized={panels.rightPanelMaximized}
      onToggleMaximized={panels.toggleRightPanelMaximizedStable}
    />
  );
  const workspaceFileDropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive: route.setIsWorkspaceFileDragActive,
    addFiles: coreActions.addDroppedFilesToComposer,
    addFolders: coreActions.addDroppedFoldersToComposer,
  });

  const composerProps: ChatComposerProps = {
    canOperateThread: route.canOperateThread,
    reportedModelSelection: route.reportedModelSelection,
    multipleModelSelections: route.multipleModelSelections,
    supportsMultipleModels:
      workspace.serverConfig?.environment.capabilities.requiredWorktreeBootstrap === true,
    onMultipleModelSelectionsChange: route.setMultipleModelSelectionsStable,
    composerRef,
    composerDraftTarget: route.composerDraftTarget,
    environmentId,
    attachmentUploadsCapabilityKnown: workspace.attachmentUploadsCapabilityKnown,
    supportsAttachmentUploads: workspace.supportsAttachmentUploads,
    supportsQuestionAttachments: workspace.supportsQuestionAttachments,
    maxFileAttachmentBytes: workspace.maxFileAttachmentBytes,
    routeKind,
    routeThreadRef: route.routeThreadRef,
    draftId,
    activeThreadId: workspace.activeThreadId,
    activeThread,
    activeThreadRuns: route.serverProjection?.runs ?? EMPTY_RUNS,
    promptHistoryEntries: timeline.timelineEntries,
    forceExpandedOnMobile: forceExpandedMobileComposer && timeline.isDraftHeroState,
    projectSelectionRequired: isLocalDraftThread && workspace.activeProject === null,
    phase: workspace.phase,
    canSteer: timeline.canSteer,
    canInterrupt: canInterruptRunningThread,
    isSendBusy:
      (timeline.isSendBusy && !timeline.sendQueuesBehindSetup) ||
      (timeline.setupQueueSendThreadKey !== null &&
        timeline.setupQueueSendThreadKey === workspace.activeThreadKey) ||
      route.queuedRunEdit.isSaving ||
      turnActions.isResuming,
    canResume: route.canResume,
    isRevertingCheckpoint: route.isRevertingCheckpoint,
    sendDisabledReason: !route.canOperateThread
      ? gt("This connection cannot change threads.")
      : isEnvironmentChanging
        ? gt("Preparing machine")
        : route.isRevertingCheckpoint
          ? gt("Rewinding conversation")
          : route.feedbackUploading
            ? gt("Sending feedback")
            : route.threadDetailLoading
              ? gt("Messages loading")
              : timeline.worktreeSetupBlocksSend
                ? gt("Preparing worktree")
                : workspace.projectCloneSendBlockReason,
    isPreparingWorktree: timeline.isPreparingWorktree && !timeline.sendQueuesBehindSetup,
    bannerItems:
      timeline.isDraftHeroState || composerBannerItems.length === 0
        ? EMPTY_COMPOSER_BANNER_ITEMS
        : composerBannerItems,
    resumeCompactionTokens,
    keepFullHistory,
    onToggleKeepFullHistory: toggleKeepFullHistoryStable,
    sideChatAvailable: panels.sideChat.available,
    sideChatDisabledReason: panels.sideChatDisabledReason,
    onFreshSession: freshSessionCommandAvailable ? armFreshSessionStable : undefined,
    onToggleEphemeral: embedded ? undefined : toggleEphemeralStable,
    onUsageLimitsCommand:
      timeline.usageLimitsOffered &&
      timeline.usageLimitsKey !== null &&
      !route.composerHasNonPromptContent
        ? timeline.openUsageLimits
        : undefined,
    environmentUnavailable: workspace.activeEnvironmentUnavailableState,
    activePendingApproval: timeline.activePendingApproval,
    pendingApprovals: timeline.pendingApprovals,
    onHeldRequestIdsChange: timeline.onHeldRequestIdsChange,
    pendingUserInputs: timeline.pendingUserInputs,
    activePendingIsResponding: timeline.activePendingIsResponding,
    respondingRequestIds: timeline.respondingRequestIds,
    runtimeMode: workspace.runtimeMode,
    defaultRuntimeMode: workspace.defaultRuntimeMode,
    lockedProvider: workspace.modelPickerLockedProvider,
    providerStatuses: workspace.providerStatuses as ServerProvider[],
    providerCatalogKnown: workspace.serverConfig !== null,
    activeProjectDefaultModelSelection: workspace.activeProjectDefaultModelSelection,
    activeThreadModelSelection: activeThread.modelSelection,
    activeProjectId: workspace.activeProject?.id ?? null,
    projectName: workspace.activeProject?.title,
    compactThreadUnavailable,
    compactDisabled,
    resolvedTheme: route.resolvedTheme,
    settings: route.settings,
    keybindings: workspace.keybindings,
    getShortcutContext: getShortcutContextStable,
    terminalOpen: Boolean(route.terminalUiState.terminalOpen),
    gitCwd: workspace.gitCwd,
    pullRequestProjectId: workspace.supportsPullRequests
      ? (workspace.activeProject?.id ?? null)
      : null,
    pullRequestRepository: workspace.supportsPullRequests ? panels.activeProjectRepository : null,
    threadPullRequests: (route.activeThreadShell ?? activeThread).pullRequests,
    onComposerOverlayHeightChange: publishComposerOverlayHeightStable,
    permissionsShownInStrip: showComposerContextStrip && !route.isServerThread,
    promptRef,
    composerImagesRef,
    composerFilesRef,
    composerTerminalContextsRef,
    onPageScrollKeyDown: onComposerPageScrollKeyDownStable,
    onPageScrollKeyUp: onComposerPageScrollKeyUpStable,
    onPageScrollRelease: onComposerPageScrollReleaseStable,
    onCompactContext: turnActions.onComposerCompactContextStable,
    onSend: turnActions.onComposerSendStable,
    captureDetachedSend: turnActions.captureDetachedSend,
    onResume: turnActions.onComposerResumeStable,
    onInterrupt: coreActions.onInterruptStable,
    onSelectActivePendingUserInputOption: timeline.onSelectActivePendingUserInputOptionStable,
    onAdvanceActivePendingUserInput: timeline.onAdvanceActivePendingUserInputStable,
    onDismissActivePendingUserInput: timeline.onDismissUserInputStable,
    onPreviousActivePendingUserInputQuestion:
      timeline.onPreviousActivePendingUserInputQuestionStable,
    onChangeActivePendingUserInputCustomAnswer: timeline.onChangeActivePendingUserInputCustomAnswer,
    onProviderModelSelect: turnActions.onProviderModelSelectStable,
    onOpenProviderSetup: turnActions.openProviderSetupStable,
    getModelDisabledReason: turnActions.getModelDisabledReason,
    handleRuntimeModeChange: turnActions.handleRuntimeModeChangeStable,
    focusComposer: focusComposerStable,
    scheduleComposerFocus: scheduleComposerFocusStable,
    setThreadError: route.setThreadError,
    onExpandImage: coreActions.onExpandTimelineImageStable,
    onFileOpen: coreActions.openFileAttachmentStable,
    editingQueuedAttachments: route.queuedRunEdit.editingAttachments,
    removedEditingQueuedAttachments: route.queuedRunEdit.removedEditingAttachments,
    onRemoveEditingQueuedAttachment: route.queuedRunEdit.removeEditingAttachment,
    onRestoreEditingQueuedAttachment: route.queuedRunEdit.restoreEditingAttachment,
  };

  const content = (
    <div
      ref={setWorkspaceLayoutElement}
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
    >
      {embedded ? null : (
        <DeviceSetupDialogHost
          threadKey={workspace.activeThreadKey}
          threadRef={workspace.activeThreadRef}
          state={panels.deviceState}
        />
      )}
      {panels.rightPanelControlsAtRoot && !embedded ? panelLayoutControls : null}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-x-hidden",
          panels.rightPanelMaximized ? "w-0 flex-none" : "flex-1",
        )}
        data-chat-column-maximized-away={panels.rightPanelMaximized ? "true" : "false"}
        data-chat-column
        style={
          {
            "--chat-header-height": embedded ? "0px" : "var(--workspace-topbar-height)",
          } as CSSProperties
        }
        inert={panels.rightPanelMaximized}
        onMouseUp={preventMiddleClickPasteOutsideEditable}
      >
        {embedded ? null : (
          <ChatViewHeaderBar
            headerRef={threadPanelPopoverAnchorRef}
            reserveTitleBarControlInset={reserveTitleBarControlInset}
            inlineRightPanelOwnsTitleBar={panels.inlineRightPanelOwnsTitleBar}
            rightPanelControlsAtRoot={panels.rightPanelControlsAtRoot}
            rightPanelControlsInPanel={panels.rightPanelControlsInPanel}
            panelLayoutControls={panelLayoutControls}
            panelToggleControlProps={panelToggleControlProps}
            chatHeaderProps={{
              activeThreadEnvironmentId: activeThread.environmentId,
              activeThreadId: activeThread.id,
              isServerThread: route.isServerThread,
              activeThreadTitle: activeThread.title,
              activeThreadEphemeral: activeThread.ephemeral === true,
              activeThreadLinkOrigin: route.activeThreadShell?.linkOrigin?.label ?? null,
              activeProject: workspace.activeProject ?? null,
              parentThreadLink: route.headerParentThreadLink,
              onOpenThread: lifecycle.onOpenRelatedThreadStable,
              rightPanelOpen: panels.inlineRightPanelOwnsTitleBar,
              onNewThreadInProject: workspace.handleNewThreadInActiveProjectStable,
              onKeepEphemeralThread:
                route.isServerThread && activeThread.ephemeral === true
                  ? keepEphemeralThreadStable
                  : undefined,
              ...(workspace.activeDraftLogicalProjectKey
                ? { onOpenProjectSettings: workspace.handleOpenDraftProjectSettingsStable }
                : {}),
              ...(threadFindEnabled ? { onFindInThread: openThreadFindStable } : {}),
            }}
          />
        )}

        <div className="relative flex min-h-0 min-w-0 flex-1">
          <ThreadFindCanvas
            findOptions={{
              skills: workspace.timelineSkills,
              progressive: workspace.serverConfig?.threadFindProgressive === true,
              thread: workspace.activeThreadRef,
              enabled: threadFindEnabled,
            }}
            store={panels.chatCanvasStore}
            threadRef={workspace.activeThreadRef}
            preview={panels.canvasPreview}
            detailsCardTopInset={isThreadFindActive ? THREAD_FIND_BAR_RESERVED_HEIGHT : 0}
            composerOverlayElement={timeline.isDraftHeroState ? null : composerOverlayElement}
            data-chat-workspace-drop-target="true"
            onDragEnter={workspaceFileDropHandlers.onDragEnter}
            onDragOver={workspaceFileDropHandlers.onDragOver}
            onDragLeave={workspaceFileDropHandlers.onDragLeave}
            onDrop={workspaceFileDropHandlers.onDrop}
          >
            <ThreadFind onClose={focusComposerStable} />
            {route.isWorkspaceFileDragActive ? <WorkspaceFileDropOverlay /> : null}
            <ChatBannerLane
              environmentId={activeThread.environmentId}
              providerStatus={workspace.visibleProviderStatus}
              providerStatusDismissalKey={workspace.providerStatusDismissalKey}
              onOpenProviderSetup={turnActions.openProviderSetupStable}
              threadId={activeThread.id}
              threadError={route.timelineThreadError}
              threadErrorClass={
                route.threadErrorIsServerRuntimeError
                  ? (route.serverRuntime?.lastErrorClass ?? null)
                  : null
              }
              threadErrorCode={
                route.threadErrorIsServerRuntimeError
                  ? (route.serverRuntime?.lastErrorCode ?? null)
                  : null
              }
              threadErrorBannerKey={route.threadErrorBannerKey}
              setThreadError={route.setThreadError}
              setThreadErrorBannerDismissTick={route.setThreadErrorBannerDismissTick}
            />
            <div
              {...conversationArea}
              className="relative flex min-h-0 flex-1 flex-col bg-background"
            >
              <ChatWallpaperOverlay />
              <div className="relative z-[1] flex min-h-0 flex-1 flex-col">
                <WorkspaceMutationIdContext value={workspace.workspaceMutationId}>
                  <ThreadTimeline
                    pendingApprovals={timeline.pendingApprovals}
                    heldApprovalRequestIds={timeline.heldApprovalRequestIds}
                    respondingRequestIds={timeline.respondingRequestIds}
                    onRespondToApproval={timeline.onRespondToApprovalStable}
                    canOperateThread={route.canOperateThread}
                    threadDetailRef={route.routeThreadDetailRef}
                    entriesInput={timeline.timelineEntriesInput}
                    draftEntries={route.isServerThread ? null : timeline.draftTimelineEntries}
                    activeThreadKey={workspace.activeThreadKey}
                    syncing={route.threadSyncPhase !== null}
                    detailLoading={route.threadDetailLoading}
                    citationRequest={route.citationRequest}
                    citationHistory={route.citationHistory}
                    onCiteAssistantText={route.citeAssistantTextStable}
                    onReplyToResponse={route.replyToResponseStable}
                    {...(workspace.activeProject && !panels.runsOutsideHostCheckout
                      ? {
                          onRunShellCommand:
                            parentPanel?.runShellCommand ?? panels.runShellCommandStable,
                        }
                      : {})}
                    isWorking={timeline.isWorking}
                    runlessWorkActive={route.runlessWorkStartedAt !== null}
                    isCompacting={timeline.isCompacting}
                    awaitingUser={
                      timeline.activePendingApproval !== null
                        ? "approval"
                        : timeline.activePendingUserInput !== null ||
                            // A secret request has no runtime request; the shell carries it.
                            route.activeThreadShell?.hasPendingUserInput === true
                          ? "input"
                          : null
                    }
                    awaitingRequestId={
                      timeline.activePendingApproval?.requestId ??
                      timeline.activePendingUserInput?.requestId ??
                      null
                    }
                    activeTurnStartedAt={timeline.activeWorkStartedAt}
                    providerStartingLabel={
                      timeline.providerStartingRun?.providerStartingLabelMsg
                        ? messages(timeline.providerStartingRun.providerStartingLabelMsg)
                        : null
                    }
                    providerStarting={
                      timeline.providerStartingRun?.providerStartingLabelMsg
                        ? (timeline.providerStartingRun.providerStarting ?? null)
                        : null
                    }
                    worktreeSetup={timeline.worktreeSetup}
                    onCancelWorktreeSetup={timeline.onCancelWorktreeSetupStable}
                    retryableWorkspacePreparationRunIds={
                      timeline.retryableWorkspacePreparationRunIds
                    }
                    onRetryWorkspacePreparation={timeline.onRetryWorkspacePreparationStable}
                    {...(draftId
                      ? { onWorktreeSetupWorkLocally: turnActions.onWorktreeSetupWorkLocallyStable }
                      : {})}
                    {...(timeline.onOpenWorktreeSetupTerminal
                      ? { onOpenWorktreeSetupTerminal: timeline.onOpenWorktreeSetupTerminal }
                      : {})}
                    isPreparingWorktree={timeline.isPreparingWorktree}
                    footer={timelineFooter}
                    listRef={legendListRef}
                    runs={route.serverProjection?.runs ?? []}
                    latestRun={route.activeActivityRun}
                    usageLimitRunId={route.usageLimitRunId}
                    announcedRun={announcedRun(
                      route.activeActivityRun,
                      route.serverProjection?.runs ?? [],
                    )}
                    detailBehindShell={isDetailBehindShell(
                      route.activeLatestRun,
                      route.activeThreadShell?.latestRun ?? null,
                    )}
                    runningRunId={panels.activeRunningTurnId}
                    turnDiffSummaries={workspace.turnDiffSummaries}
                    activeThreadEnvironmentId={
                      timeline.displayedThreadRef?.environmentId ?? activeThread.environmentId
                    }
                    routeThreadKey={timeline.displayedTimelineKey}
                    displayThreadKey={timeline.displayedTimelineKey}
                    announceTurnStatus={!route.isProviderSubagent}
                    onOpenToolDiff={parentPanel?.openToolDiff ?? panels.onOpenToolDiffStable}
                    // A fork would promote the side chat.
                    {...(embedded ? {} : { onForkFromRun: turnActions.onForkFromRunStable })}
                    onOpenThread={lifecycle.onOpenRelatedThreadStable}
                    parentThreadLink={route.parentThreadLink}
                    workflowOpening={route.workflowOpening}
                    supportsConversationRollback={workspace.supportsConversationRollback}
                    threadStartCheckpointAvailable={workspace.threadStartCheckpointAvailable}
                    availableRevertTurnCounts={workspace.availableRevertTurnCounts}
                    onRevertToTurnCount={turnActions.onRevertTimelineTurnStable}
                    onUseArtifactTemplate={coreActions.insertArtifactTemplateStable}
                    onSendAppMessage={coreActions.sendAppMessageStable}
                    isRevertingCheckpoint={route.isRevertingCheckpoint}
                    onImageExpand={coreActions.onExpandTimelineImageStable}
                    onFileOpen={coreActions.openFileAttachmentStable}
                    onFileDownload={coreActions.downloadFileAttachmentStable}
                    markdownCwd={workspace.gitCwd ?? undefined}
                    resolvedTheme={route.resolvedTheme}
                    timestampFormat={route.timestampFormat}
                    workspaceRoot={workspace.activeWorkspaceRoot}
                    skills={workspace.timelineSkills}
                    anchorMessageId={timeline.timelineAnchorMessageId}
                    onAnchorReady={onTimelineAnchorReadyStable}
                    onAnchorSizeChanged={onTimelineAnchorSizeChangedStable}
                    contentInsetEndAdjustment={composerTimelineInset}
                    liveFollowEnabled={timelineLiveFollowEnabled}
                    onIsAtEndChange={onIsAtEndChangeStable}
                    onViewportAttach={attachTimelineViewport}
                    onFooterGrow={onTimelineFooterGrowStable}
                    hideEmptyPlaceholder={timeline.isDraftHeroState || route.threadDetailLoading}
                    emptyPlaceholderInset={composerReservedHeight}
                    topFadeEnabled={!workspace.hasTimelineTopBanner}
                    {...(route.threadHistoryControls === undefined
                      ? {}
                      : { historyControls: route.threadHistoryControls })}
                  />
                </WorkspaceMutationIdContext>

                {showScrollToBottom && !isThreadFindActive && (
                  <ScrollToEndButton
                    bottom="calc(var(--chat-scroll-to-end-clearance, 0px) + 4px)"
                    summary={scrollToEndSummary}
                    onScrollToEnd={() => scrollToEnd(true)}
                  />
                )}
              </div>
            </div>

            <ChatViewComposerOverlay
              environmentId={environmentId}
              threadId={threadId}
              routeKind={routeKind}
              draftId={draftId}
              activeThread={activeThread}
              activeThreadRef={workspace.activeThreadRef}
              activeProjectRef={workspace.activeProjectRef}
              activeProjectTitle={workspace.activeProject?.title ?? null}
              isServerThread={route.isServerThread}
              isDraftHeroState={timeline.isDraftHeroState}
              isRevertingCheckpoint={route.isRevertingCheckpoint}
              isQueuedRunSaving={route.queuedRunEdit.isSaving}
              forceExpandedMobileComposer={forceExpandedMobileComposer}
              showProviderSubagentBar={showProviderSubagentBar}
              composerMounted={composerMounted}
              showComposerContextStrip={showComposerContextStrip}
              terminalOpen={Boolean(route.terminalUiState.terminalOpen)}
              overlayRef={(overlay: HTMLDivElement | null) => {
                setComposerOverlayElement(overlay);
                attachFollowComposerOverlay(overlay);
              }}
              draftHeroTransitionGroupRef={timeline.draftHeroTransitionGroupRef}
              draftHeroComposerAnchorRef={timeline.draftHeroComposerAnchorRef}
              selectedProviderEntry={workspace.selectedProviderEntry}
              providerInstanceEntries={workspace.providerInstanceEntries}
              providerSubagentModelLabel={workspace.providerSubagentModelLabel}
              providerSubagentEffortLabel={workspace.providerSubagentEffortLabel}
              providerSubagentStatus={route.providerSubagentStatus}
              onOpenParentThread={route.parentThreadLink?.open ?? null}
              composerProps={composerProps}
              composerBannerItems={composerBannerItems}
              branchToolbarRef={branchToolbarRef}
              multipleModelSelections={route.multipleModelSelections}
              workspaceModesOffered={workspace.workspaceModesOffered}
              isGitRepo={workspace.isGitRepo}
              onEnvModeChange={turnActions.onEnvModeChangeStable}
              startFromOrigin={workspace.startFromOrigin}
              onStartFromOriginChange={turnActions.onStartFromOriginChange}
              envMode={envMode}
              canOverrideServerThreadEnvMode={workspace.canOverrideServerThreadEnvMode}
              activeThreadBranch={workspace.activeThreadBranch}
              onActiveThreadBranchOverrideChange={workspace.setPendingServerThreadBranch}
              envLocked={workspace.envLocked}
              onComposerFocusRequest={scheduleComposerFocusStable}
              canCheckoutPullRequestIntoThread={workspace.canCheckoutPullRequestIntoThread}
              onCheckoutPullRequestRequest={workspace.openPullRequestDialogStable}
              canChangeEnvironment={workspace.canChangeEnvironment}
              onEnvironmentChange={onEnvironmentChangeStable}
              autoEnvironmentLabel={autoEnvironmentLabel}
              onAutoEnvironment={
                draftId &&
                !workspace.envLocked &&
                workspace.canAutoBalanceEnvironments &&
                workspace.loadBalancingSettings.loadBalancingEnabled
                  ? onAutoEnvironmentStable
                  : undefined
              }
              availableEnvironments={workspace.logicalProjectEnvironments}
              runtimeMode={workspace.runtimeMode}
              activeProviderStatus={workspace.activeProviderStatus}
              providerStatuses={workspace.providerStatuses}
              onRuntimeModeChange={turnActions.handleRuntimeModeChangeStable}
            />

            <ChatViewCanvasOverlays
              embedded={embedded}
              canOperatePreview={panels.canOperatePreview}
              activeThreadRef={workspace.activeThreadRef}
              activeThreadKey={workspace.activeThreadKey}
              activeEnvironmentServerBrowser={workspace.activeEnvironmentServerBrowser}
              shownPreviewMiniPlayer={panels.shownPreviewMiniPlayer}
              branchRestoreThreadBranch={localCheckoutBranchMismatch?.threadBranch ?? ""}
              canWriteSourceControl={route.canWriteSourceControl}
              onConfirmBranchRestore={lifecycle.handleSwitchCheckoutToThreadStable}
              threadDetailsProps={{
                anchor: threadPanelPopoverAnchorRef,
                handle: panels.threadPanelPopoverHandle,
                forceNewWorktree: route.multipleModelSelections !== null,
                environmentId: activeThread.environmentId,
                threadId: activeThread.id,
                projectId: activeThread.projectId,
                worktreePath: activeThread.worktreePath,
                isServerThread: route.isServerThread,
                ...(draftId ? { draftId } : {}),
                composerDraftTarget: route.composerDraftTarget,
                activeProjectName: workspace.activeProject?.title,
                activeProjectScripts: workspace.activeProject
                  ? workspace.activeProjectScripts
                  : undefined,
                preferredScriptId: workspace.activeProject
                  ? (panels.lastInvokedScriptByProjectId[workspace.activeProject.id] ?? null)
                  : null,
                keybindings: workspace.keybindings,
                availableEditors: workspace.availableEditors,
                showOpenInPicker: workspace.showOpenInPicker,
                openInShortcutEnabled: !(
                  panels.rightPanelOpen &&
                  panels.renderedRightPanelSurface?.kind === "file" &&
                  panels.renderedRightPanelSurface.attachment === undefined
                ),
                gitCwd: workspace.gitCwd,
                workspaceMutationId: workspace.workspaceRevision.revision,
                isGitRepo: workspace.isGitRepo,
                offersWorkspaceModes: workspace.workspaceModesOffered,
                envLocked: workspace.envLocked,
                availableEnvironments: workspace.logicalProjectEnvironments,
                autoEnvironmentLabel,
                onAutoEnvironment:
                  draftId &&
                  !workspace.envLocked &&
                  workspace.canAutoBalanceEnvironments &&
                  workspace.loadBalancingSettings.loadBalancingEnabled
                    ? onAutoEnvironmentStable
                    : undefined,
                ...(workspace.canChangeEnvironment
                  ? { onEnvironmentChange: onEnvironmentChangeStable }
                  : {}),
                onEnvModeChange: turnActions.onEnvModeChangeStable,
                envMode,
                ...(workspace.canOverrideServerThreadEnvMode
                  ? {
                      activeThreadBranchOverride: workspace.activeThreadBranch,
                      onActiveThreadBranchOverrideChange: workspace.setPendingServerThreadBranch,
                    }
                  : {}),
                startFromOrigin: workspace.startFromOrigin,
                onStartFromOriginChange: turnActions.onStartFromOriginChange,
                ...(workspace.canCheckoutPullRequestIntoThread
                  ? { onCheckoutPullRequestRequest: workspace.openPullRequestDialogStable }
                  : {}),
                onComposerFocusRequest: scheduleComposerFocusStable,
                ...(route.isServerThread && workspace.isGitRepo
                  ? { onOpenChanges: panels.openChangesFromThreadPanelStable }
                  : {}),
                onRunProjectScript: panels.runProjectScriptStable,
                onAddProjectScript: panels.saveProjectScriptStable,
                onUpdateProjectScript: panels.updateProjectScriptStable,
                onDeleteProjectScript: panels.deleteProjectScriptStable,
                usage: {
                  providerInstanceId: workspace.activeProviderInstanceId,
                  model: workspace.activeUsageModel,
                  providers: workspace.providerStatuses,
                  sources: workspace.serverConfig?.usageLimitSources ?? EMPTY_USAGE_LIMIT_SOURCES,
                  contextWindow: timeline.activeContextWindow,
                },
              }}
              pullRequestDialogProps={{
                threadKey: workspace.activeThreadKey,
                environmentId: activeThread.environmentId,
                threadId: activeThread.id,
                cwd: workspace.activeProject?.workspaceRoot ?? null,
                onPrepared: workspace.handlePreparedPullRequestThreadStable,
              }}
            />
          </ThreadFindCanvas>
        </div>

        {embedded ? null : (
          <ChatTerminalDrawers
            activeThreadKey={workspace.activeThreadKey}
            activeTerminalOpen={Boolean(route.terminalUiState.terminalOpen)}
            composerHeight={composerReservedHeight}
            launchContext={panels.activeTerminalLaunchContext ?? null}
            splitShortcutLabel={workspace.splitTerminalShortcutLabel ?? undefined}
            splitVerticalShortcutLabel={workspace.splitTerminalVerticalShortcutLabel ?? undefined}
            newShortcutLabel={workspace.newTerminalShortcutLabel ?? undefined}
            closeShortcutLabel={workspace.closeTerminalShortcutLabel ?? undefined}
            keybindings={workspace.keybindings}
            onAddTerminalContext={panels.addTerminalContextToDraftStable}
          />
        )}
      </div>

      {panels.rightPanelPresent && workspace.activeThreadRef && !embedded ? (
        <ChatViewRightPanelSection
          activeThreadRef={workspace.activeThreadRef}
          activeThreadKey={workspace.activeThreadKey}
          rightPanelOpen={panels.rightPanelOpen}
          rightPanelMaximized={panels.rightPanelMaximized}
          onToggleMaximized={panels.toggleRightPanelMaximizedStable}
          panelToggleControls={panelToggleControls}
          panelProps={{
            sheet: panels.shouldUsePlanSidebarSheet,
            workspaceLayoutElement,
            sheetAnimationDurationMs: panelAnimationsActive ? panelAnimationDurationMs : 0,
            onCloseSheet: panels.closePreviewPanelStable,
            keybindings: workspace.keybindings,
            getShortcutContext: getShortcutContextStable,
            surfaces: panels.renderedRightPanelSurfaces,
            environmentId: workspace.activeThreadRef.environmentId,
            activeSurfaceId: panels.renderedRightPanelSurface?.id ?? null,
            pendingSurfaceIds: workspace.pendingFileSurfaceIds,
            previewSessions: panels.activePreviewState.sessions,
            desktopByTabId: panels.activePreviewState.desktopByTabId,
            previewRuntimeTabId: panels.resolvePreviewRuntimeTabId,
            terminalLabelsById: workspace.activeTerminalLabelsById,
            onActivate: panels.activateRightPanelSurfaceStable,
            onCloseSurface: panels.closeRightPanelSurface,
            onOpenInMainView: panels.openSurfaceInMainView,
            onCloseOtherSurfaces: panels.closeOtherRightPanelSurfacesStable,
            onCloseSurfacesToRight: panels.closeRightPanelSurfacesToRightStable,
            onCloseAllSurfaces: panels.closeAllRightPanelSurfacesStable,
            onMoveSurface: panels.moveRightPanelSurfaceStable,
            onCopyFilePath: panels.copyRightPanelFilePathStable,
            onAddBrowser: () => panels.createBrowserSurface(),
            onAddBrowserInProfile: panels.createBrowserSurfaceStable,
            onDuplicateBrowser: panels.duplicateBrowserSurfaceStable,
            onAddTerminal: panels.addTerminalSurfaceStable,
            onAddDiff: panels.addDiffSurfaceStable,
            onAddFiles: panels.addFilesSurfaceStable,
            onAddPullRequest: panels.addPullRequestSurfaceStable,
            onAddPullRequests: panels.addPullRequestsSurfaceStable,
            onAddDevice: panels.addDeviceSurfaceStable,
            onAddSideChat: panels.sideChatsOffered ? panels.openSideChatStable : undefined,
            browserAvailable: panels.canOperatePreview && workspace.browserAvailable,
            terminalAvailable: workspace.activeProject !== null && route.canOperateTerminal,
            diffAvailable: route.isServerThread && workspace.diffAvailable,
            filesAvailable: workspace.activeProject !== null,
            pullRequestAvailable: panels.pullRequestSurfaceAvailable,
            pullRequestsAvailable: panels.linkedItemsSurfaceAvailable,
            deviceAvailable: workspace.activeThreadRef !== null,
            sideChatAvailable: panels.sideChat.available,
            sideChatDisabledReason: panels.sideChatDisabledReason,
          }}
          surfaceContentProps={{
            surface: panels.renderedRightPanelSurface,
            activeSurfaceId: panels.activeRightPanelSurface?.id ?? null,
            threadRef: workspace.activeThreadRef,
            environmentId: activeThread.environmentId,
            visible: panels.rightPanelOpen,
            composerDraftTarget: route.composerDraftTarget,
            keybindings: workspace.keybindings,
            configuredPreviewUrls: workspace.configuredPreviewUrls,
            workspaceMutationId: workspace.workspaceMutationId,
            workspaceRevision: workspace.workspaceRevision.revision,
            getShortcutContext: getShortcutContextStable,
            onSendAnnotation: turnActions.sendPreviewAnnotationStable,
            onCloseSurface: panels.closeRightPanelSurface,
            sideChatParentPanel,
            terminal: {
              launchContext: panels.activeTerminalLaunchContext ?? null,
              keybindings: workspace.keybindings,
              onAddTerminalContext: panels.addTerminalContextToDraftStable,
              onSplitTerminal: panels.splitPanelTerminalStable,
              onSplitTerminalVertical: panels.splitPanelTerminalVerticalStable,
              onNewTerminal: panels.addTerminalSurfaceStable,
              onActiveTerminalChange: panels.activatePanelTerminalStable,
              onCloseTerminal: panels.closePanelTerminalStable,
              splitShortcutLabel: workspace.splitTerminalShortcutLabel ?? undefined,
              splitVerticalShortcutLabel: workspace.splitTerminalVerticalShortcutLabel ?? undefined,
              newShortcutLabel: workspace.newTerminalShortcutLabel ?? undefined,
              closeShortcutLabel: workspace.closeTerminalShortcutLabel ?? undefined,
            },
            pullRequest: {
              capabilityKnown: workspace.pullRequestsCapabilityKnown,
              supported: workspace.supportsPullRequests,
              projectId: activeThread.projectId,
              pullRequests: panels.visiblePullRequests,
              linkedPullRequest: panels.linkedThreadPullRequest,
              branchPullRequest:
                route.activeThreadShell?.branchPullRequest ?? activeThread.branchPullRequest,
              onBack:
                panels.pullRequestsSurfaceAvailable && panels.visiblePullRequestCount > 1
                  ? panels.addPullRequestsSurfaceStable
                  : undefined,
            },
            issuesSupported: workspace.serverConfig?.environment.capabilities.issues === true,
            files: {
              projectId: workspace.activeProject?.id,
              projectName: workspace.activeProject?.title ?? null,
              workspaceRoot: workspace.activeWorkspaceRoot,
              availableEditors: workspace.availableEditors,
              pendingSurfaceIds: workspace.pendingFileSurfaceIds,
              onOpenFile: panels.openFileSurfaceStable,
              onPendingChange: workspace.handleFilePendingChangeStable,
            },
          }}
        />
      ) : null}

      <ChatViewRootOverlays
        embedded={embedded}
        routeThreadKey={route.routeThreadKey}
        routeThreadRef={route.routeThreadRef}
        environmentId={environmentId}
        taskFolderPath={workspace.activeThreadWorktreePath}
        projection={route.serverProjection}
        worktreePath={activeThread.worktreePath ?? null}
        onConfirmRevert={turnActions.onConfirmRevertStable}
      />
    </div>
  );
  return (
    <FileMetadataThreadProvider
      threadRef={workspace.activeThreadRef}
      cwd={workspace.activeWorkspaceRoot}
      checkpoints={route.serverProjection?.checkpoints}
      checkpointScopes={route.serverProjection?.checkpointScopes}
    >
      {content}
    </FileMetadataThreadProvider>
  );
}

// Chromium on Linux pastes PRIMARY into the focused editable unless the middle mouseup is cancelled.
function preventMiddleClickPasteOutsideEditable(event: ReactMouseEvent) {
  if (event.button !== 1 || isEditableFocused(event.target)) return;
  event.preventDefault();
}
