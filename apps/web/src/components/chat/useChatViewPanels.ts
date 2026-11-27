import type { EnvironmentServerConfig } from "@zerocode/client-runtime/connection";
import { sourceControlClients } from "@zerocode/client-runtime/source-control-clients";
import type { EnvironmentThreadShell, ThreadStructure } from "@zerocode/client-runtime/state/shell";
import type { deriveThreadStructureRuntime } from "@zerocode/client-runtime/state/thread-execution";
import { resolveThreadReferenceCopyTarget } from "@zerocode/client-runtime/thread-reference";
import {
  AuthPreviewOperateScope,
  type EnvironmentId,
  type ProjectScript,
  type RuntimeMode,
  type ScopedThreadRef,
  type ThreadId,
  type UnifiedSettings,
  type VcsStatusResult,
} from "@zerocode/contracts";
import { orchestrationV2WorktreePending } from "@zerocode/shared/orchestrationV2ThreadError";
import { projectScriptCwd } from "@zerocode/shared/projectScripts";
import { visibleThreadPullRequests } from "@zerocode/shared/threadPullRequests";
import { useGT, useMessages } from "gt-react";
import { type RefObject, useEffect, useState } from "react";
import { useStore } from "zustand";
import { useDeviceState } from "~/state/device";
import { useEnvironmentScope } from "~/state/session";
import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import { configuredHostedAppUrl } from "../../hostedPairing";
import { useOpenPanelPullRequestUrl } from "../../hooks/useOpenPanelPullRequestUrl";
import { useOpenSurfaceInMainView } from "../../hooks/useOpenSurfaceInMainView";
import { useProactivePanels } from "../../hooks/useProactivePanels";
import { useRightPanelSurfaceClose } from "../../hooks/useRightPanelSurfaceClose";
import { useStableCallback } from "../../hooks/useStableCallback";
import { copyThreadReference } from "../../lib/copyThreadReference";
import { usePanelPresence } from "../../panelAnimations";
import {
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "../../previewMiniPlayerStore";
import { useThreadPreviewState } from "../../previewStateStore";
import {
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectThreadPanelOpen,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import { isLatestRunSettled } from "../../session-logic";
import type { selectThreadTerminalUiState } from "../../terminalUiStateStore";
import type { Project, TurnDiffSummary } from "../../types";
import { shouldRenderPreviewMiniPlayer } from "../ChatView.logic";
import { useThreadPreviewCanvasSource } from "../preview/ThreadPreviewMiniPlayer";
import { threadPullRequestPanelTarget } from "../pullRequest/pullRequestDetail.logic";
import { useThreadLinkedPullRequest } from "../pullRequest/useThreadLinkedPullRequest";
import { PopoverCreateHandle } from "../ui/popover";
import { createChatCanvasStore, resolveChatCanvasModel } from "./canvasStore";
import type { ChatComposerHandle } from "./ChatComposer";
import { type TerminalLaunchContext, useChatTerminalActions } from "./useChatTerminalActions";
import { useProjectScriptEditing } from "./useProjectScriptEditing";
import { useRightPanelActions } from "./useRightPanelActions";
import { useSideChat } from "./useSideChat";

interface ChatViewPanelsInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly embedded: boolean;
  readonly isServerThread: boolean;
  readonly isSubagentThread: boolean;
  readonly canOperateThread: boolean;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly activeThreadId: ThreadId | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeThreadKey: string | null;
  readonly activeThreadShell: EnvironmentThreadShell | null;
  readonly panelHostShell: EnvironmentThreadShell | null;
  readonly activeProject: Project | null;
  readonly activeProjectCwd: string | null;
  readonly activeProjectScripts: ReadonlyArray<ProjectScript>;
  readonly activeThreadWorktreePath: string | null;
  readonly activeLatestRun: EnvironmentThreadShell["latestRun"];
  readonly activeRuntime: ReturnType<typeof deriveThreadStructureRuntime>;
  readonly serverProjection: ThreadStructure | null;
  readonly serverConfig: EnvironmentServerConfig | null;
  readonly settings: UnifiedSettings;
  readonly clientSettingsHydrated: boolean;
  readonly threadDetailLoading: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly browserAvailable: boolean;
  readonly diffAvailable: boolean;
  readonly pullRequestsCapabilityKnown: boolean;
  readonly supportsPullRequests: boolean;
  readonly prefersPlanSidebarSheet: boolean;
  readonly panelAnimationsActive: boolean;
  readonly panelAnimationDurationMs: number;
  readonly terminalUiState: ReturnType<typeof selectThreadTerminalUiState>;
  readonly runningTerminalIds: ReadonlyArray<string>;
  readonly activeServerOrderedTerminalIds: ReadonlyArray<string>;
  readonly activeTerminalLabelsById: ReadonlyMap<string, string>;
  readonly canReuseTerminal: boolean;
  readonly gitCwd: string | null;
  readonly gitStatusData:
    | Pick<VcsStatusResult, "isRepo" | "refName" | "hasWorkingTreeChanges" | "pr">
    | null
    | undefined;
  readonly turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  readonly onDiffPanelOpen: (() => void) | undefined;
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly setThreadError: (threadId: ThreadId | null, error: string | null) => void;
}

export function useChatViewPanels(input: ChatViewPanelsInput) {
  const {
    environmentId,
    routeThreadRef,
    embedded,
    isServerThread,
    isSubagentThread,
    canOperateThread,
    activeThread,
    activeThreadId,
    activeThreadRef,
    activeThreadKey,
    activeThreadShell,
    panelHostShell,
    activeProject,
    activeProjectCwd,
    activeProjectScripts,
    activeThreadWorktreePath,
    activeLatestRun,
    activeRuntime,
    serverProjection,
    serverConfig,
    settings,
    clientSettingsHydrated,
    threadDetailLoading,
    runtimeMode,
    browserAvailable,
    diffAvailable,
    pullRequestsCapabilityKnown,
    supportsPullRequests,
    prefersPlanSidebarSheet,
    panelAnimationsActive,
    panelAnimationDurationMs,
    terminalUiState,
    runningTerminalIds,
    activeServerOrderedTerminalIds,
    activeTerminalLabelsById,
    canReuseTerminal,
    gitCwd,
    gitStatusData,
    turnDiffSummaries,
    onDiffPanelOpen,
    composerRef,
    setThreadError,
  } = input;
  const gt = useGT();
  const messages = useMessages();

  const [terminalUiLaunchContext, setTerminalUiLaunchContext] =
    useState<TerminalLaunchContext | null>(null);
  if (
    terminalUiLaunchContext !== null &&
    (terminalUiLaunchContext.threadId !== activeThreadId ||
      !terminalUiState.terminalOpen ||
      (activeProjectCwd !== null &&
        projectScriptCwd({
          project: { cwd: activeProjectCwd },
          worktreePath: activeThreadWorktreePath,
        }) === terminalUiLaunchContext.cwd &&
        (activeThreadWorktreePath ?? null) === terminalUiLaunchContext.worktreePath))
  ) {
    setTerminalUiLaunchContext(null);
  }
  const activeTerminalLaunchContext =
    terminalUiLaunchContext?.threadId === activeThreadId ? terminalUiLaunchContext : null;

  const activeRightPanelKind = useRightPanelStore((state) =>
    selectActiveRightPanel(state.byThreadKey, activeThreadRef),
  );
  const diffOpen = activeRightPanelKind === "diff";
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, activeThreadRef),
  );
  const shouldUsePlanSidebarSheet = prefersPlanSidebarSheet && rightPanelState.maximized !== true;
  const activeRightPanelSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, activeThreadRef),
  );
  const activePreviewState = useThreadPreviewState(activeThreadRef);
  const activePreviewServerEpoch = activePreviewState.serverEpoch;
  const resolvePreviewRuntimeTabId = activeThreadRef
    ? (tabId: string) => previewRuntimeTabId(activeThreadRef, activePreviewServerEpoch, tabId)
    : undefined;
  const activePreviewMiniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, activeThreadRef),
  );
  const panelTerminalIds = new Set(
    rightPanelState.surfaces.flatMap((surface) =>
      surface.kind === "terminal" ? surface.terminalIds : [],
    ),
  );
  const previewPanelOpen = activeRightPanelKind === "preview" && browserAvailable;
  const rightPanelOpen = rightPanelState.isOpen;
  const rightPanelPresenceValue = {
    activeSurface: activeRightPanelSurface,
    surfaces: rightPanelState.surfaces,
  };
  const rightPanelPresence = usePanelPresence(
    rightPanelOpen && activeThreadRef !== null,
    rightPanelPresenceValue,
    panelAnimationsActive,
    activeThreadKey,
    panelAnimationDurationMs,
  );
  const rightPanelPresent = rightPanelPresence.present;
  const rightPanelControlsInPanel =
    shouldUsePlanSidebarSheet && rightPanelPresent && rightPanelOpen;
  const rightPanelControlsAtRoot = rightPanelPresent && !shouldUsePlanSidebarSheet;
  const renderedRightPanelSurface = rightPanelPresence.value?.activeSurface ?? null;
  const renderedRightPanelSurfaces = rightPanelPresence.value?.surfaces ?? [];
  const previewMiniPlayerVisible = shouldRenderPreviewMiniPlayer(
    activePreviewMiniPlayer?.source ?? null,
    renderedRightPanelSurface,
  );
  const canMaximizeRightPanel = rightPanelOpen;
  // An embedded side chat has no panel; a stale maximized flag would hide its own column.
  const rightPanelMaximized =
    !embedded && canMaximizeRightPanel && rightPanelState.maximized === true;
  const inlineRightPanelOwnsTitleBar = rightPanelOpen && !shouldUsePlanSidebarSheet;
  const [threadPanelPopoverHandle] = useState(PopoverCreateHandle);
  const [chatCanvasStore] = useState(createChatCanvasStore);

  const {
    activatePanelTerminalStable,
    addTerminalContextToDraftStable,
    addTerminalSurfaceStable,
    closePanelTerminalStable,
    lastInvokedScriptByProjectId,
    runProjectScriptStable,
    runShellCommandStable,
    splitPanelTerminalStable,
    splitPanelTerminalVerticalStable,
    toggleTerminalVisibilityStable,
    shortcuts: terminalShortcuts,
  } = useChatTerminalActions({
    environmentId,
    composerRef,
    terminalUiState,
    activeThread,
    activeThreadId,
    activeThreadRef,
    activeProject,
    activeRightPanelSurface,
    runningTerminalIds,
    activeServerOrderedTerminalIds,
    activeTerminalLabelsById,
    panelTerminalIds,
    canReuseTerminal,
    gitCwd,
    setTerminalUiLaunchContext,
    setThreadError,
  });
  const {
    saveProjectScript: saveProjectScriptStable,
    updateProjectScript: updateProjectScriptStable,
    deleteProjectScript: deleteProjectScriptStable,
  } = useProjectScriptEditing({
    environmentId,
    project: activeProject,
    scripts: activeProjectScripts,
    settings,
  });

  const canOperatePreview = useEnvironmentScope(
    activeThreadRef?.environmentId ?? null,
    AuthPreviewOperateScope,
  );
  const shownPreviewMiniPlayer =
    activeThreadRef &&
    activePreviewMiniPlayer &&
    previewMiniPlayerVisible &&
    (activePreviewMiniPlayer.source.kind === "device" || canOperatePreview)
      ? activePreviewMiniPlayer
      : null;
  const canvasPreview = useThreadPreviewCanvasSource(activeThreadRef, shownPreviewMiniPlayer);
  const threadPanelInlineOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, activeThreadRef, "inline"),
  );
  // Selects only the mode, so canvas resizes rerender the chat view only when the
  // card switches presentation.
  const threadPanelPresentation = useStore(
    chatCanvasStore,
    (state) =>
      resolveChatCanvasModel({
        measurements: state.measurements,
        detailsCardMeasurement: state.detailsCardMeasurement,
        threadRef: activeThreadRef,
        preview: canvasPreview,
        detailsCardInlineOpen: threadPanelInlineOpen,
      }).detailsCardMode,
  );
  const threadPanelOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(
      state.threadPanelVisibilityByThreadKey,
      activeThreadRef,
      threadPanelPresentation,
    ),
  );
  const supportsThreadPullRequests = serverConfig !== null;
  const visiblePullRequests = visibleThreadPullRequests(
    (activeThreadShell ?? activeThread)?.pullRequests ?? [],
  );
  const visiblePullRequestCount = visiblePullRequests.length;
  const pullRequestsSurfaceAvailable =
    isServerThread && supportsThreadPullRequests && visiblePullRequestCount > 0;
  const linkedItemsSurfaceAvailable =
    pullRequestsSurfaceAvailable ||
    (isServerThread && (activeThreadShell?.issues?.length ?? 0) > 0);
  const { state: deviceState, loaded: deviceStateLoaded } = useDeviceState(
    activeThreadRef?.environmentId ?? null,
  );
  // The thread's own change request, placed against the project it belongs to. Without a
  // project there is nothing to resolve it against, so the caller falls back to the browser.
  const activeProjectRepository = sourceControlClients.repositorySelector(
    activeProject?.repositoryIdentity,
  );
  const {
    linked: linkedThreadPullRequest,
    linkedKey: linkedThreadPullRequestKey,
    hasDetail: hasLinkedPullRequestDetail,
  } = useThreadLinkedPullRequest({
    serverThreadRef: isServerThread ? activeThreadRef : null,
    environmentId: activeThreadRef?.environmentId ?? null,
    persisted: isServerThread
      ? (activeThreadShell?.linkedPullRequest ?? activeThread?.linkedPullRequest ?? null)
      : (activeThread?.linkedPullRequest ?? null),
    projectId: activeProject?.id ?? null,
    projectRepository: activeProjectRepository,
    threadBranch: activeThread?.branch ?? null,
    gitStatus: gitStatusData ?? null,
  });
  const proactivePullRequestsKey = pullRequestsSurfaceAvailable
    ? JSON.stringify(
        visiblePullRequests.map((link) => [link.host, link.repository, link.number]).sort(),
      )
    : linkedThreadPullRequestKey;
  const activeRunningTurnId = activeRuntime?.activeRunId ?? null;
  const latestRunSettled = isLatestRunSettled(activeLatestRun, activeRuntime);
  useProactivePanels({
    threadRef: isServerThread && !embedded ? activeThreadRef : null,
    enabled: settings.proactivePanelsEnabled && !shouldUsePlanSidebarSheet && !embedded,
    settingsHydrated: clientSettingsHydrated,
    threadDetailLoading,
    runningTurnId: activeRunningTurnId,
    latestRun: activeLatestRun,
    latestRunSettled,
    turnDiffSummaries,
    isGitRepo: gitStatusData?.isRepo,
    linkedPullRequest: linkedThreadPullRequest,
    hasLinkedPullRequestDetail,
    pullRequestsKey: proactivePullRequestsKey,
    pullRequestsCapabilityKnown,
    supportsPullRequests,
    pullRequestsSurfaceAvailable,
    visiblePullRequestCount,
    onDiffPanelOpen,
  });
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- consumes a pending maximize request from the right panel store once the panel can maximize
  useEffect(() => {
    if (!canMaximizeRightPanel) return;
    if (useRightPanelStore.getState().consumeMaximizeRequest(routeThreadRef)) {
      useRightPanelStore.getState().setMaximized(routeThreadRef, true);
    }
  }, [canMaximizeRightPanel, routeThreadRef]);
  const {
    closeSurface: closeRightPanelSurface,
    closeOtherSurfaces: closeOtherRightPanelSurfacesStable,
    closeSurfacesToRight: closeRightPanelSurfacesToRightStable,
    closeAllSurfaces: closeAllRightPanelSurfacesStable,
  } = useRightPanelSurfaceClose({
    threadRef: activeThreadRef,
    terminalLabelsById: activeTerminalLabelsById,
  });

  const openPanelPullRequestUrl = useOpenPanelPullRequestUrl(activeThreadRef);
  const activeThreadReferenceCopyTarget =
    activeThreadRef === null || !isServerThread
      ? null
      : resolveThreadReferenceCopyTarget(
          {
            threadRef: activeThreadRef,
            title: activeThread?.title ?? "",
            openPanelPullRequestUrl,
            pullRequests: activeThread?.pullRequests,
            linkedPullRequestUrl: linkedThreadPullRequest?.url ?? null,
            hostedAppUrl: configuredHostedAppUrl(),
          },
          messages,
        );
  const copyActiveThreadReference = () => {
    if (activeThreadReferenceCopyTarget === null) return;
    void copyThreadReference(activeThreadReferenceCopyTarget);
  };
  const pullRequestPanelTarget = activeThread
    ? threadPullRequestPanelTarget({
        projectId: activeThread.projectId,
        pullRequests: visiblePullRequests,
        linkedPullRequest: linkedThreadPullRequest,
        branchPullRequest: activeThreadShell?.branchPullRequest ?? activeThread.branchPullRequest,
      })
    : null;
  const {
    activateRightPanelSurfaceStable,
    addDeviceSurfaceStable,
    addDiffSurfaceStable,
    addFilesSurfaceStable,
    addPullRequestSurfaceStable,
    addPullRequestsSurfaceStable,
    closePreviewPanelStable,
    copyRightPanelFilePathStable,
    createBrowserSurface,
    createBrowserSurfaceStable,
    duplicateBrowserSurfaceStable,
    moveRightPanelSurfaceStable,
    onOpenToolDiffStable,
    openChangesFromThreadPanelStable,
    openFileSurfaceStable,
    toggleRightPanelMaximizedStable,
    toggleRightPanelStable,
    toggleThreadPanelStable,
    shortcuts: rightPanelShortcuts,
  } = useRightPanelActions({
    activeThreadRef,
    activeProject,
    activeRightPanelSurface,
    activePreviewState,
    deviceState,
    deviceStateLoaded,
    pullRequestPanelTarget,
    threadPanelPresentation,
    isServerThread,
    embedded,
    diffAvailable,
    browserAvailable,
    canOperatePreview,
    diffOpen,
    previewPanelOpen,
    rightPanelOpen,
    canMaximizeRightPanel,
    rightPanelMaximized,
    supportsPullRequests,
    pullRequestsSurfaceAvailable: linkedItemsSurfaceAvailable,
    gitCwd,
    activeProjectCwd,
    onDiffPanelOpen,
    closeRightPanelSurface,
  });
  const pullRequestSurfaceAvailable = supportsPullRequests && pullRequestPanelTarget !== null;

  // Side chats do not nest or start from subagents, and older servers would fork a listed thread.
  const sideChatsOffered =
    !embedded &&
    canOperateThread &&
    activeThread?.lineage.sideChat !== true &&
    !isSubagentThread &&
    serverConfig?.environment.capabilities.sideChats === true;
  const sideChat = useSideChat({
    threadRef: sideChatsOffered && isServerThread ? activeThreadRef : null,
    readSettings: () => ({
      runtimeMode,
      modelSelection: composerRef.current?.getSendContext().selectedModelSelection,
    }),
    onError: (message) => {
      if (activeThread) setThreadError(activeThread.id, message);
    },
  });
  // An embedded thread's commands run in its host's terminal, which is the host's checkout.
  const runsOutsideHostCheckout =
    embedded && (activeThread?.worktreePath ?? null) !== (panelHostShell?.worktreePath ?? null);
  // A maximized panel covers the terminal drawer the command runs in.
  const runSideChatShellCommandStable = useStableCallback((command: string) => {
    if (activeThreadRef) useRightPanelStore.getState().setMaximized(activeThreadRef, false);
    runShellCommandStable(command);
  });
  // Main-thread surfaces show this reason; `/side` sent anyway gets it as a toast.
  const sideChatDisabledReason =
    activeThread?.lineage.sideChat === true
      ? gt("Side chats cannot start side chats.")
      : isSubagentThread
        ? gt("Subagent threads cannot start side chats.")
        : serverConfig === null
          ? gt("Side chats are not ready yet. Try again in a moment.")
          : serverConfig.environment.capabilities.sideChats !== true
            ? gt("Update this environment's ZeroCode server to use side chats.")
            : sideChatsOffered && !isServerThread
              ? gt("Side chats start after the first message.")
              : sideChat.available &&
                  orchestrationV2WorktreePending(
                    activeThread?.worktreePath ?? null,
                    serverProjection?.runs ?? [],
                  )
                ? gt("Available once the thread's worktree is set up.")
                : null;
  const openSideChatStable = useStableCallback(() => void sideChat.open());
  const openSurfaceInMainView = useOpenSurfaceInMainView(activeThreadRef);
  const sendSideChatStable = useStableCallback(sideChat.open);

  return {
    activeTerminalLaunchContext,
    shouldUsePlanSidebarSheet,
    activeRightPanelSurface,
    activePreviewState,
    resolvePreviewRuntimeTabId,
    previewPanelOpen,
    rightPanelOpen,
    rightPanelPresent,
    rightPanelControlsInPanel,
    rightPanelControlsAtRoot,
    renderedRightPanelSurface,
    renderedRightPanelSurfaces,
    rightPanelMaximized,
    inlineRightPanelOwnsTitleBar,
    threadPanelPopoverHandle,
    chatCanvasStore,
    activatePanelTerminalStable,
    addTerminalContextToDraftStable,
    addTerminalSurfaceStable,
    closePanelTerminalStable,
    lastInvokedScriptByProjectId,
    runProjectScriptStable,
    runShellCommandStable,
    splitPanelTerminalStable,
    splitPanelTerminalVerticalStable,
    toggleTerminalVisibilityStable,
    terminalShortcuts,
    saveProjectScriptStable,
    updateProjectScriptStable,
    deleteProjectScriptStable,
    canOperatePreview,
    shownPreviewMiniPlayer,
    canvasPreview,
    threadPanelPresentation,
    threadPanelOpen,
    visiblePullRequests,
    visiblePullRequestCount,
    pullRequestsSurfaceAvailable,
    linkedItemsSurfaceAvailable,
    deviceState,
    activeProjectRepository,
    linkedThreadPullRequest,
    activeRunningTurnId,
    closeRightPanelSurface,
    closeOtherRightPanelSurfacesStable,
    closeRightPanelSurfacesToRightStable,
    closeAllRightPanelSurfacesStable,
    copyActiveThreadReference,
    activateRightPanelSurfaceStable,
    addDeviceSurfaceStable,
    addDiffSurfaceStable,
    addFilesSurfaceStable,
    addPullRequestSurfaceStable,
    addPullRequestsSurfaceStable,
    closePreviewPanelStable,
    copyRightPanelFilePathStable,
    createBrowserSurface,
    createBrowserSurfaceStable,
    duplicateBrowserSurfaceStable,
    moveRightPanelSurfaceStable,
    onOpenToolDiffStable,
    openChangesFromThreadPanelStable,
    openFileSurfaceStable,
    toggleRightPanelMaximizedStable,
    toggleRightPanelStable,
    toggleThreadPanelStable,
    rightPanelShortcuts,
    pullRequestSurfaceAvailable,
    sideChatsOffered,
    sideChat,
    runsOutsideHostCheckout,
    runSideChatShellCommandStable,
    sideChatDisabledReason,
    openSideChatStable,
    openSurfaceInMainView,
    sendSideChatStable,
  };
}
