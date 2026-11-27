import type { EnvironmentServerConfig } from "@zerocode/client-runtime/connection";
import { scopedThreadKey } from "@zerocode/client-runtime/environment";
import { resolvePendingHandoff } from "@zerocode/client-runtime/handoff";
import {
  type deriveLatestContextWindowSnapshot,
  type latestProviderTurnTokenUsage,
  shouldOfferResumeCompaction,
} from "@zerocode/client-runtime/state/context-window";
import type {
  EnvironmentThreadShell,
  ThreadStructure,
  ThreadStructureVisibleTurnItem,
} from "@zerocode/client-runtime/state/shell";
import type { deriveThreadStructureRuntime } from "@zerocode/client-runtime/state/thread-execution";
import { getUserQueuedThreadRuns } from "@zerocode/client-runtime/state/thread-workflows";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProviderDriverKind,
  ProviderInstanceId,
  resolveIdleCompaction,
  type RuntimeMode,
  type ScopedThreadRef,
  type ServerProvider,
  type ThreadId,
  type VcsStatusResult,
} from "@zerocode/contracts";
import type { UnifiedSettings } from "@zerocode/contracts/settings";
import { useGT } from "gt-react";
import {
  type ComponentProps,
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useState,
} from "react";
import {
  composerTargetKey,
  type ComposerThreadTarget,
  type DraftThreadEnvMode,
  type DraftThreadState,
} from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useStableCallback } from "../../hooks/useStableCallback";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { PendingApproval, PendingUserInput } from "../../session-logic";
import type { ChatMessage, SessionPhase } from "../../types";
import {
  resolveEffectiveEnvMode,
  resolveLocalCheckoutBranchMismatch,
} from "../BranchToolbar.logic";
import { hasCompactableConversation, resolveSendEnvMode } from "../ChatView.logic";
import { openBranchRestoreConfirm } from "./ChatOverlayHosts";
import type { ChatViewTimelineFooter } from "./ChatViewDialogs";
import { armFreshSession, useFreshSessionArmed } from "./freshSessionArms";
import { cancelHeldComposerSend, useComposerSendHeld } from "./preparingComposerImages";
import { openThreadFind, useThreadFindOpen } from "./threadFindStore";
import { useScrollToEndClearanceSync } from "./useChatViewOverlayLayout";
import { useThreadLifecycle } from "./useThreadLifecycle";

const EMPTY_TURN_ITEMS: ThreadStructure["turnItems"] = [];

interface ChatViewLifecycleStateInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly isServerThread: boolean;
  readonly isLocalDraftThread: boolean;
  readonly canOperateThread: boolean;
  readonly canWriteSourceControl: boolean;
  readonly clientSettingsHydrated: boolean;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly activeThreadId: ThreadId | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly routeThreadDetailRef: ScopedThreadRef | null;
  readonly activeThreadKey: string | null;
  readonly activeThreadBranch: string | null;
  readonly activeThreadShell: EnvironmentThreadShell | null;
  readonly activeLatestRun: EnvironmentThreadShell["latestRun"];
  readonly activeRuntime: ReturnType<typeof deriveThreadStructureRuntime> | null;
  readonly hasActiveProject: boolean;
  readonly activeProjectCwd: string | null;
  readonly activeMessageCount: number;
  readonly draftThread: DraftThreadState | null;
  readonly serverThreadLatestUserMessageAt: string | null;
  readonly serverProjection: ThreadStructure | null;
  readonly serverVisibleTurnItems: ReadonlyArray<ThreadStructureVisibleTurnItem>;
  readonly serverThreadHistoryHasMore: boolean;
  readonly serverConfig: EnvironmentServerConfig | null;
  readonly settings: UnifiedSettings;
  readonly runtimeMode: RuntimeMode;
  readonly phase: SessionPhase;
  readonly selectedProvider: ProviderDriverKind;
  readonly activeProviderInstanceId: ProviderInstanceId | null;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly composerModelSelectionApplies: boolean;
  readonly composerSelectedModelSelection: ModelSelection | null;
  readonly multipleModelSelections: ReadonlyArray<ModelSelection> | null;
  readonly manualCompactionProviderAvailable: boolean;
  readonly activeEnvironmentUnavailable: boolean;
  readonly isGitRepo: boolean;
  readonly tracksGitRepositories: boolean;
  readonly canOverrideServerThreadEnvMode: boolean;
  readonly pendingServerThreadEnvMode: DraftThreadEnvMode | null;
  readonly gitStatusQuery: {
    readonly data?:
      | Pick<VcsStatusResult, "isRepo" | "refName" | "hasWorkingTreeChanges" | "pr">
      | null
      | undefined;
    readonly refresh: () => void;
  };
  readonly isWorking: boolean;
  readonly isPreparingWorktree: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly threadDetailLoading: boolean;
  readonly feedbackUploading: boolean;
  readonly hasHeldQueuedRuns: boolean;
  readonly limitRecoveryHoldsSnooze: boolean;
  readonly resumeCompactionPermanentlyDismissed: boolean;
  readonly nativeResumeCompactionDismissed: boolean;
  readonly activeContextWindow: ReturnType<typeof deriveLatestContextWindowSnapshot>;
  readonly activeThreadLiveTokenUsage: ReturnType<typeof latestProviderTurnTokenUsage>;
  readonly pendingBackgroundTasks: Parameters<
    typeof useThreadLifecycle
  >[0]["pendingBackgroundTasks"];
  readonly pendingApprovals: ReadonlyArray<PendingApproval>;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly activePendingApproval: Parameters<typeof useThreadLifecycle>[0]["activePendingApproval"];
  readonly activePendingUserInput: Parameters<
    typeof useThreadLifecycle
  >[0]["activePendingUserInput"];
  readonly delayedThreadSyncPhase: ComponentProps<
    typeof ChatViewTimelineFooter
  >["shownThreadSyncPhase"];
  readonly optimisticUserMessages: ChatMessage[];
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly composerRef: ComposerHandleRef;
  readonly sendInFlightRef: { current: boolean };
  readonly showScrollToBottom: boolean;
  readonly composerOverlayElement: HTMLDivElement | null;
  readonly composerTimelineInsetRef: RefObject<number>;
  readonly updateScrollToEndClearanceCssVarStable: Parameters<
    typeof useScrollToEndClearanceSync
  >[0]["updateScrollToEndClearanceCssVarStable"];
  readonly setOptimisticUserMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  readonly setThreadError: Parameters<typeof useThreadLifecycle>[0]["setThreadError"];
  readonly clearUsageLimitsFor: (threadKey: string) => void;
  readonly beginLocalDispatch: Parameters<typeof useThreadLifecycle>[0]["beginLocalDispatch"];
  readonly resetLocalDispatch: Parameters<typeof useThreadLifecycle>[0]["resetLocalDispatch"];
  readonly scrollToEnd: (animated?: boolean) => void;
  readonly focusComposerStable: () => void;
  readonly persistThreadSettingsForNextTurn: Parameters<
    typeof useThreadLifecycle
  >[0]["persistThreadSettingsForNextTurn"];
}

export function useChatViewLifecycleState(input: ChatViewLifecycleStateInput) {
  const gt = useGT();
  const {
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    isServerThread,
    isLocalDraftThread,
    canOperateThread,
    canWriteSourceControl,
    clientSettingsHydrated,
    activeThread,
    activeThreadId,
    activeThreadRef,
    routeThreadDetailRef,
    activeThreadKey,
    activeThreadBranch,
    activeThreadShell,
    activeLatestRun,
    activeRuntime,
    hasActiveProject,
    activeProjectCwd,
    activeMessageCount,
    draftThread,
    serverThreadLatestUserMessageAt,
    serverProjection,
    serverVisibleTurnItems,
    serverThreadHistoryHasMore,
    serverConfig,
    settings,
    runtimeMode,
    phase,
    selectedProvider,
    activeProviderInstanceId,
    providerStatuses,
    providerInstanceEntries,
    composerModelSelectionApplies,
    composerSelectedModelSelection,
    multipleModelSelections,
    manualCompactionProviderAvailable,
    activeEnvironmentUnavailable,
    isGitRepo,
    tracksGitRepositories,
    canOverrideServerThreadEnvMode,
    pendingServerThreadEnvMode,
    gitStatusQuery,
    isWorking,
    isPreparingWorktree,
    isRevertingCheckpoint,
    threadDetailLoading,
    feedbackUploading,
    hasHeldQueuedRuns,
    limitRecoveryHoldsSnooze,
    resumeCompactionPermanentlyDismissed,
    nativeResumeCompactionDismissed,
    activeContextWindow,
    activeThreadLiveTokenUsage,
    pendingBackgroundTasks,
    pendingApprovals,
    pendingUserInputs,
    activePendingApproval,
    activePendingUserInput,
    delayedThreadSyncPhase,
    optimisticUserMessages,
    composerDraftTarget,
    composerRef,
    sendInFlightRef,
    showScrollToBottom,
    composerOverlayElement,
    composerTimelineInsetRef,
    updateScrollToEndClearanceCssVarStable,
    setOptimisticUserMessages,
    setThreadError,
    clearUsageLimitsFor,
    beginLocalDispatch,
    resetLocalDispatch,
    scrollToEnd,
    focusComposerStable,
    persistThreadSettingsForNextTurn,
  } = input;

  const activeWorktreePath = activeThread?.worktreePath ?? null;
  const derivedEnvMode: DraftThreadEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread: isServerThread,
    draftThreadEnvMode: isLocalDraftThread ? draftThread?.envMode : undefined,
    preparingWorktree: isPreparingWorktree,
  });
  const envMode: DraftThreadEnvMode = canOverrideServerThreadEnvMode
    ? (pendingServerThreadEnvMode ?? draftThread?.envMode ?? derivedEnvMode)
    : derivedEnvMode;
  const sendEnvMode = resolveSendEnvMode({
    requestedEnvMode: envMode,
    isGitRepo,
    tracksGitRepositories,
  });
  const localCheckoutBranchMismatch = isServerThread
    ? resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: envMode,
        activeWorktreePath,
        activeThreadBranch,
        currentGitBranch: gitStatusQuery.data?.refName ?? null,
      })
    : null;

  const needsServerMinuteTick =
    activeThreadShell?.snoozedUntil != null ||
    activeThreadShell?.settledOverride === "settled" ||
    (activeContextWindow !== null &&
      selectedProvider === "claudeAgent" &&
      !isWorking &&
      !resumeCompactionPermanentlyDismissed &&
      !nativeResumeCompactionDismissed &&
      !hasHeldQueuedRuns);
  const serverNowMinute = useNowMinute(needsServerMinuteTick);
  const lifecycle = useThreadLifecycle({
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    canOperateThread,
    clientSettingsHydrated,
    activeThread,
    activeThreadId,
    activeThreadRef,
    threadDetailRef: routeThreadDetailRef,
    activeThreadKey,
    activeThreadShell,
    activeLatestRun,
    limitRecoveryHoldsSnooze,
    activeProjectCwd,
    serverConfig,
    runtimeMode,
    isWorking,
    // A waiting run is checkpoint drain; Stop there reaches its background work.
    runIsLive: (isWorking && activeRuntime?.status !== "waiting") || phase === "connecting",
    pendingBackgroundTasks,
    turnItems: serverProjection?.turnItems ?? EMPTY_TURN_ITEMS,
    activePendingApproval,
    activePendingUserInput,
    localCheckoutBranchMismatch,
    gitStatusQuery,
    nowMinute: serverNowMinute,
    composerRef,
    composerDraftTarget,
    sendInFlightRef,
    setOptimisticUserMessages,
    setThreadError,
    clearUsageLimitsFor,
    beginLocalDispatch,
    resetLocalDispatch,
    scrollToEnd,
    persistThreadSettingsForNextTurn,
  });

  const activeThreadHasCompactableConversation = hasCompactableConversation({
    visibleTurnItems: serverVisibleTurnItems,
    hasMoreHistory: serverThreadHistoryHasMore,
    latestUserMessageAt: serverThreadLatestUserMessageAt,
  });
  const pendingHandoffSelection =
    (composerModelSelectionApplies ? composerSelectedModelSelection : null) ??
    activeThread?.modelSelection;
  const pendingHandoffSelectionUsable = providerInstanceEntries.some(
    (entry) =>
      entry.instanceId === pendingHandoffSelection?.instanceId &&
      entry.enabled &&
      entry.isAvailable,
  );
  const pendingHandoff = resolvePendingHandoff(
    serverProjection,
    pendingHandoffSelectionUsable ? pendingHandoffSelection : null,
    providerStatuses,
  );
  const compactThreadUnavailable =
    !canOperateThread ||
    !activeThread ||
    !activeThreadHasCompactableConversation ||
    !hasActiveProject ||
    !isServerThread ||
    !manualCompactionProviderAvailable ||
    isWorking ||
    isRevertingCheckpoint ||
    threadDetailLoading ||
    isPreparingWorktree ||
    activeEnvironmentUnavailable ||
    feedbackUploading ||
    pendingApprovals.length > 0 ||
    pendingUserInputs.length > 0;
  const compactDisabled = compactThreadUnavailable;
  const freshSessionAvailable =
    activeMessageCount > 0 && serverConfig?.environment.capabilities.freshContext === true;
  const freshSessionArmed = useFreshSessionArmed(routeThreadKey);
  const freshSessionPending = freshSessionAvailable && freshSessionArmed;
  // The context window is the current conversation's, so neither a handoff destination nor
  // the fresh session armed by /clear inherits it.
  const resumeCompactionTokens =
    activeContextWindow &&
    pendingHandoff === null &&
    !freshSessionPending &&
    resolveIdleCompaction(
      settings,
      activeProviderInstanceId ?? ProviderInstanceId.make("claudeAgent"),
    ) !== "off" &&
    !resumeCompactionPermanentlyDismissed &&
    !nativeResumeCompactionDismissed &&
    !compactDisabled &&
    !hasHeldQueuedRuns &&
    multipleModelSelections === null &&
    shouldOfferResumeCompaction({
      provider: selectedProvider,
      usedTokens: activeContextWindow.usedTokens,
      updatedAt: activeContextWindow.updatedAt,
      promptCacheTtlMs: activeThreadLiveTokenUsage?.promptCacheTtlMs,
      now: `${serverNowMinute}:00.000Z`,
    })
      ? activeContextWindow.usedTokens
      : null;
  const [fullHistoryThreadKeys, setFullHistoryThreadKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const keepFullHistory = fullHistoryThreadKeys.has(routeThreadKey);
  const setKeepFullHistory = (threadKey: string, keep: boolean) => {
    setFullHistoryThreadKeys((current) => {
      if (current.has(threadKey) === keep) return current;
      const next = new Set(current);
      if (keep) next.add(threadKey);
      else next.delete(threadKey);
      return next;
    });
  };
  // While a question or approval owns the composer, its text answers that, not the agent.
  const freshSessionCommandAvailable =
    freshSessionAvailable && activePendingApproval === null && pendingUserInputs.length === 0;
  const composerDraftTargetKey = composerTargetKey(composerDraftTarget);
  const composerSendHeld = useComposerSendHeld(composerDraftTargetKey);
  const cancelHeldSendStable = useStableCallback(() => {
    cancelHeldComposerSend(composerDraftTargetKey);
    focusComposerStable();
  });
  const toggleKeepFullHistoryStable = useStableCallback(() => {
    cancelHeldComposerSend(composerDraftTargetKey);
    setKeepFullHistory(routeThreadKey, !keepFullHistory);
  });
  const armFreshSessionStable = useStableCallback(() => armFreshSession(routeThreadKey));
  const handleRestoreThreadBranchStable = useStableCallback(() => {
    if (!canWriteSourceControl) return;
    if (gitStatusQuery.data?.hasWorkingTreeChanges) {
      if (activeThreadKey !== null) openBranchRestoreConfirm(activeThreadKey);
      return;
    }
    void lifecycle.handleSwitchCheckoutToThread();
  });

  const threadFindEnabled = isServerThread && serverConfig?.threadFind === true;
  const isThreadFindActive = useThreadFindOpen(activeThreadRef, threadFindEnabled);
  useScrollToEndClearanceSync({
    showScrollToBottom,
    isThreadFindActive,
    composerOverlayElement,
    composerTimelineInsetRef,
    updateScrollToEndClearanceCssVarStable,
  });
  const openThreadFindStable = useStableCallback((threadRef: ScopedThreadRef) => {
    if (threadFindEnabled && scopedThreadKey(threadRef) === activeThreadKey) {
      openThreadFind(activeThreadKey);
    }
  });

  const shownThreadSyncPhase = activeEnvironmentUnavailable ? null : delayedThreadSyncPhase;
  const hasThreadNow =
    lifecycle.attentionNow !== null ||
    lifecycle.workNow !== null ||
    lifecycle.goalNow !== null ||
    shownThreadSyncPhase !== null;
  const queuedRunCount = serverProjection ? getUserQueuedThreadRuns(serverProjection).length : 0;
  // The queue control is mounted for every server thread but joins the footer only while it shows
  // something, by its own rule: an optimistic message stops counting once the server has it.
  const hasQueuedTurns =
    queuedRunCount > 0 ||
    optimisticUserMessages.some(
      (message) =>
        message.inputIntent === "queued_turn" &&
        !serverProjection?.messages.some((committed) => committed.id === message.id),
    );
  const scrollToEndSummary =
    [
      lifecycle.childInputNow?.waitingLabel ?? null,
      queuedRunCount === 0
        ? null
        : gt("{count, plural, one {{count} queued} other {{count} queued}}", {
            count: queuedRunCount,
          }),
    ]
      .filter((part) => part !== null)
      .join(" · ") || null;

  return {
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
  };
}
