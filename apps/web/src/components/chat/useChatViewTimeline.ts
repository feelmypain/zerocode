import type { EnvironmentServerConfig } from "@zerocode/client-runtime/connection";
import { parseScopedThreadKey } from "@zerocode/client-runtime/environment";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "@zerocode/client-runtime/state/context-window";
import type {
  EnvironmentThreadShell,
  ThreadStructure,
  ThreadStructureVisibleTurnItem,
} from "@zerocode/client-runtime/state/shell";
import {
  type deriveThreadStructureRuntime,
  presentProviderStarting,
} from "@zerocode/client-runtime/state/thread-execution";
import { threadCanSteer } from "@zerocode/client-runtime/state/thread-workflows";
import {
  codexFeedbackMessage,
  type CodexFeedbackSubmission,
  isCompleteTurnItemRow,
} from "@zerocode/client-runtime/state/threads";
import type {
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
  UsageLimitSourceSnapshots,
} from "@zerocode/contracts";
import { useMessages } from "gt-react";
import { type Dispatch, type RefObject, type SetStateAction, useState } from "react";
import { shallow } from "zustand/vanilla/shallow";
import type { ComposerThreadTarget, DraftId } from "../../composerDraftStore";
import { useIncrementalTimelineEntries } from "../../hooks/useIncrementalTimelineEntries";
import { useStableCallback } from "../../hooks/useStableCallback";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { deriveActiveWorkStartedAt, isLatestRunSettled } from "../../session-logic";
import type { ChatMessage, SessionPhase } from "../../types";
import {
  deriveThreadPendingBackgroundTasks,
  deriveTimelineWorking,
  isCompactCommandMessage,
  resolveDraftHeroState,
} from "../ChatView.logic";
import type { ChatComposerHandle } from "./ChatComposer";
import type {
  createOptimisticBlobPreviews,
  reconcileOptimisticUserMessages,
} from "./optimisticUserMessages";
import { useAttachmentPreviewHandoff } from "./useAttachmentPreviewHandoff";
import { useDraftHeroLayoutTransition } from "./useDraftHeroLayoutTransition";
import { useLocalDispatchState } from "./useLocalDispatchState";
import { usePendingThreadRequests } from "./usePendingThreadRequests";
import { useUsageLimitsPanel } from "./useUsageLimitsPanel";
import { useWorktreeSetup } from "./useWorktreeSetup";

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
const EMPTY_USAGE_LIMIT_SOURCES: UsageLimitSourceSnapshots = [];

interface ChatViewTimelineInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeThreadKey: string;
  readonly draftId: DraftId | null;
  readonly isServerThread: boolean;
  readonly isLocalDraftThread: boolean;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly activeThreadId: ThreadId | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeThreadKey: string | null;
  readonly serverProjection: ThreadStructure | null;
  readonly serverVisibleTurnItems: ReadonlyArray<ThreadStructureVisibleTurnItem>;
  readonly activeLatestRun: EnvironmentThreadShell["latestRun"];
  readonly activeActivityRun: EnvironmentThreadShell["latestRun"];
  readonly activeRuntime: ReturnType<typeof deriveThreadStructureRuntime>;
  readonly runlessWorkStartedAt: string | null;
  readonly phase: SessionPhase;
  readonly threadError: string | null;
  readonly supportsQuestionAttachments: boolean;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly setComposerDraftPrompt: (target: ComposerThreadTarget, prompt: string) => void;
  readonly promptRef: RefObject<string>;
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  readonly activeProviderInstanceId: ProviderInstanceId | null;
  readonly activeUsageModel: string | null;
  readonly activeProviderStatus: ServerProvider | null;
  readonly selectedProviderEntry: ProviderInstanceEntry | undefined;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly serverConfig: EnvironmentServerConfig | null;
  readonly optimisticState: ReturnType<typeof reconcileOptimisticUserMessages>;
  readonly optimisticBlobPreviews: ReturnType<typeof createOptimisticBlobPreviews>;
  readonly optimisticUserMessages: ChatMessage[];
  readonly setHeldOptimisticUserMessages: Dispatch<
    SetStateAction<ReturnType<typeof reconcileOptimisticUserMessages>>
  >;
  readonly feedbackSubmissions: ReadonlyArray<CodexFeedbackSubmission>;
  readonly panelAnimationsActive: boolean;
  readonly panelAnimationDurationMs: number;
}

export function useChatViewTimeline(input: ChatViewTimelineInput) {
  const {
    environmentId,
    threadId,
    routeThreadRef,
    routeThreadKey,
    draftId,
    isServerThread,
    isLocalDraftThread,
    activeThread,
    activeThreadId,
    activeThreadRef,
    activeThreadKey,
    serverProjection,
    serverVisibleTurnItems,
    activeLatestRun,
    activeActivityRun,
    activeRuntime,
    runlessWorkStartedAt,
    phase,
    threadError,
    supportsQuestionAttachments,
    composerDraftTarget,
    setComposerDraftPrompt,
    promptRef,
    composerRef,
    setThreadError,
    activeProviderInstanceId,
    activeUsageModel,
    activeProviderStatus,
    selectedProviderEntry,
    providerStatuses,
    serverConfig,
    optimisticState,
    optimisticBlobPreviews,
    optimisticUserMessages,
    setHeldOptimisticUserMessages,
    feedbackSubmissions,
    panelAnimationsActive,
    panelAnimationDurationMs,
  } = input;
  const messages = useMessages();

  const activeProviderThread = serverProjection?.providerThreads.find(
    (thread) => thread.id === serverProjection.thread.activeProviderThreadId,
  );
  const activeThreadLiveTokenUsage = latestProviderTurnTokenUsage(
    serverProjection?.providerTurns ?? [],
    serverProjection,
    activeProviderThread,
  );

  const [timelineAnchor, setTimelineAnchor] = useState<{
    readonly threadKey: string | null;
    readonly messageId: MessageId | null;
  }>({ threadKey: activeThreadKey, messageId: null });
  if (timelineAnchor.threadKey !== activeThreadKey) {
    setTimelineAnchor({ threadKey: activeThreadKey, messageId: null });
  }
  const timelineAnchorMessageId = timelineAnchor.messageId;
  // LegendList never recomputes anchored end-space geometry, leaving phantom scroll range after content fits.
  const anchorRunSettled = (() => {
    if (timelineAnchorMessageId === null) return false;
    const anchorRun = serverProjection?.runs.find(
      (run) => run.userMessageId === timelineAnchorMessageId,
    );
    if (anchorRun === undefined) return false;
    return (
      anchorRun.status !== "preparing" &&
      anchorRun.status !== "queued" &&
      anchorRun.status !== "starting" &&
      anchorRun.status !== "running" &&
      anchorRun.status !== "waiting"
    );
  })();
  if (anchorRunSettled) {
    setTimelineAnchor({ threadKey: activeThreadKey, messageId: null });
  }

  const {
    pendingApprovals,
    pendingUserInputs,
    activePendingApproval,
    activePendingUserInput,
    activePendingIsResponding,
    respondingRequestIds,
    onRespondToApproval: onRespondToApprovalStable,
    onDismissUserInput: onDismissUserInputStable,
    onSelectActivePendingUserInputOption: onSelectActivePendingUserInputOptionStable,
    onChangeActivePendingUserInputCustomAnswer,
    onAdvanceActivePendingUserInput,
    onAdvanceActivePendingUserInputStable,
    onPreviousActivePendingUserInputQuestion: onPreviousActivePendingUserInputQuestionStable,
  } = usePendingThreadRequests({
    environmentId,
    activeThreadId,
    serverProjection,
    supportsQuestionAttachments,
    composerDraftTarget,
    setComposerDraftPrompt,
    promptRef,
    composerRef,
    setThreadError,
  });
  const [heldApprovalRequestIds, setHeldApprovalRequestIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const onHeldRequestIdsChange = useStableCallback((requestIds: ReadonlySet<string>) => {
    setHeldApprovalRequestIds((current) => (shallow(current, requestIds) ? current : requestIds));
  });
  // Answering an approval or question on any client resumes quota spending, so include it in the key.
  const usageLimitsKey =
    activeProviderInstanceId === null || (isServerThread && activeThread === undefined)
      ? null
      : [
          routeThreadKey,
          activeProviderInstanceId,
          activeThread?.latestRun?.runId ?? "",
          activePendingApproval?.requestId ?? activePendingUserInput?.requestId ?? "",
        ].join(":");
  const {
    banner: usageLimitsBanner,
    offered: usageLimitsOffered,
    open: openUsageLimits,
    clearFor: clearUsageLimitsFor,
  } = useUsageLimitsPanel({
    environmentId,
    threadKey: routeThreadKey,
    panelKey: usageLimitsKey,
    providerInstanceId: activeProviderInstanceId,
    model: activeUsageModel,
    providerDriver: activeProviderStatus?.driver ?? null,
    providers: providerStatuses,
    sources: serverConfig?.usageLimitSources ?? EMPTY_USAGE_LIMIT_SOURCES,
  });
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree: isLocallyPreparingWorktree,
    isSendBusy,
    backgroundSubmissionPending,
  } = useLocalDispatchState({
    environmentId,
    activeThread,
    activeLatestRun,
    latestUserMessageId:
      serverProjection?.messages.findLast((message) => message.role === "user")?.id ?? null,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError,
  });
  // Promotion drops draftId while a send may still be dispatching, so key by thread.
  const [localDispatchThreadId, setLocalDispatchThreadId] = useState(threadId);
  if (localDispatchThreadId !== threadId) {
    setLocalDispatchThreadId(threadId);
    resetLocalDispatch();
  }

  const optimisticCompactionMessage = optimisticUserMessages.at(-1);
  const latestServerUserItem = serverVisibleTurnItems.findLast(
    (row) => row.item.type === "user_message",
  )?.item;
  const compactRequestIsActive =
    (isSendBusy &&
      optimisticCompactionMessage !== undefined &&
      isCompactCommandMessage(optimisticCompactionMessage)) ||
    (latestServerUserItem?.type === "user_message" &&
      latestServerUserItem.text.trim().toLowerCase() === "/compact" &&
      latestServerUserItem.attachments.length === 0 &&
      latestServerUserItem.runId === activeActivityRun?.runId &&
      !isLatestRunSettled(activeActivityRun, activeRuntime));
  const compactionSettled = serverVisibleTurnItems.some(
    ({ item }) =>
      item.type === "compaction" &&
      item.runId === activeActivityRun?.runId &&
      (item.status === "completed" ||
        item.status === "failed" ||
        item.status === "interrupted" ||
        item.status === "cancelled"),
  );
  const compactionRunning = serverVisibleTurnItems.some(
    ({ item }) =>
      item.type === "compaction" &&
      item.runId !== null &&
      item.runId === activeRuntime?.activeRunId &&
      item.status === "running",
  );
  const compactCommandIsActive = compactRequestIsActive && !compactionSettled;
  const isCompacting =
    (isSendBusy || phase === "connecting" || phase === "running") &&
    (compactionRunning || compactCommandIsActive);
  const canSteer = threadCanSteer(serverProjection, {
    compactCommandIsActive,
    compactionRunning,
    activeRunId: activeRuntime?.activeRunId,
  });
  const isWorking = deriveTimelineWorking({
    phase,
    isSendBusy,
    isCompacting,
    runlessWorkStartedAt,
  });
  const activeContextWindow = deriveLatestContextWindowSnapshot(
    serverVisibleTurnItems ?? [],
    activeThreadLiveTokenUsage,
    activeProviderThread,
  );
  const pendingBackgroundTasks = deriveThreadPendingBackgroundTasks(serverProjection);
  const activeWorkStartedAt =
    deriveActiveWorkStartedAt(activeActivityRun, activeRuntime, localDispatchStartedAt) ??
    runlessWorkStartedAt;
  // Until the server has the run, a send shows the provider it is starting, not the thinking brain.
  const providerStartingRun =
    activeActivityRun?.providerStartingLabelMsg !== undefined
      ? activeActivityRun
      : isSendBusy &&
          selectedProviderEntry !== undefined &&
          (activeActivityRun === null || !ACTIVE_RUN_STATUSES.has(activeActivityRun.status))
        ? presentProviderStarting({
            instanceId: selectedProviderEntry.instanceId,
            driver: selectedProviderEntry.driverKind,
          })
        : null;
  const activeRunPreparing = activeActivityRun?.status === "preparing";
  const sendQueuesBehindSetup =
    isServerThread && (activeRunPreparing || activeActivityRun?.status === "starting");
  const [setupQueueSendThreadKey, setSetupQueueSendThreadKey] = useState<string | null>(null);

  const { timelineAttachmentUrlById } = useAttachmentPreviewHandoff({
    environmentId,
    threadId,
    serverVisibleTurnItems,
    handoff: optimisticState.handoff,
    blobPreviews: optimisticBlobPreviews,
    setOptimisticUserMessages: setHeldOptimisticUserMessages,
  });
  const anchoredTimelineMessages = feedbackSubmissions.flatMap((submission) =>
    submission.status === "interrupted"
      ? []
      : [
          { ...codexFeedbackMessage(submission, "user", messages), runId: null },
          { ...codexFeedbackMessage(submission, "assistant", messages), runId: null },
        ],
  );
  const timelineEntriesInput = {
    optimisticMessages: optimisticUserMessages,
    anchoredMessages: anchoredTimelineMessages,
    attachmentUrlById: timelineAttachmentUrlById,
    ...(serverProjection === null
      ? {}
      : {
          attempts: serverProjection.attempts,
          nodes: serverProjection.nodes,
          plans: serverProjection.plans,
        }),
  };
  // The structure has no assistant or reasoning text, so those rows stay out of
  // ChatView's own entries (anchoring, rewind, prompt history); ThreadTimeline
  // renders every row from the live turn items.
  const serverTimelineRows = serverVisibleTurnItems.filter(isCompleteTurnItemRow);
  const hasStreamedTimelineRows =
    isServerThread && serverTimelineRows.length !== serverVisibleTurnItems.length;
  const serverTimelineEntries = useIncrementalTimelineEntries(activeThreadKey, {
    ...timelineEntriesInput,
    visibleTurnItems: serverTimelineRows,
  });
  const draftTimelineEntries = optimisticUserMessages.map(
    (message) =>
      ({
        id: message.id,
        kind: "message",
        createdAt: message.createdAt,
        message,
      }) as const,
  );
  const timelineEntries = isServerThread ? serverTimelineEntries : draftTimelineEntries;
  const timelineMessages = timelineEntries.flatMap((entry) =>
    entry.kind === "message" ? [entry.message] : [],
  );
  const timelineEmpty = timelineEntries.length === 0 && !hasStreamedTimelineRows;
  const displayedTimelineKey = activeThreadKey ?? routeThreadKey;
  const displayedThreadRef = parseScopedThreadKey(displayedTimelineKey);

  const {
    worktreeSetup,
    isPreparingWorktree,
    blocksSend: worktreeSetupBlocksSend,
    retryableRunIds: retryableWorkspacePreparationRunIds,
    begin: beginWorktreeSetup,
    cancel: cancelWorktreeSetup,
    retryPreparation: onRetryWorkspacePreparationStable,
    openSetupTerminal: onOpenWorktreeSetupTerminal,
  } = useWorktreeSetup({
    routeThreadRef,
    ownerKey: draftId ?? routeThreadKey,
    activeThread,
    threadRef: activeThreadRef,
    serverProjection,
    activityRun: activeActivityRun,
    localPreparing: isLocallyPreparingWorktree,
    sendQueuesBehindSetup,
    // Include optimistic sends to retire the row before the server echo.
    followUpSent: timelineMessages.filter((message) => message.role === "user").length > 1,
  });
  const onCancelWorktreeSetupStable = useStableCallback(() => void cancelWorktreeSetup());
  const [dockedDraftHeroThreadKey, setDockedDraftHeroThreadKey] = useState<string | null>(null);
  const draftHeroDockRequested =
    activeThreadKey !== null && dockedDraftHeroThreadKey === activeThreadKey;
  const isDraftHeroState = resolveDraftHeroState({
    isLocalDraftThread,
    hasTimelineEntries: !timelineEmpty,
    isWorking,
    draftHeroDockRequested,
    backgroundSubmissionPending,
    hasWorktreeSetupCard: worktreeSetup !== null,
  });
  const {
    transitionGroupRef: draftHeroTransitionGroupRef,
    composerAnchorRef: draftHeroComposerAnchorRef,
    captureComposerRect: captureDraftHeroComposerRect,
  } = useDraftHeroLayoutTransition(
    isDraftHeroState,
    panelAnimationsActive,
    panelAnimationDurationMs,
  );

  return {
    activeThreadLiveTokenUsage,
    timelineAnchorMessageId,
    setTimelineAnchor,
    pendingApprovals,
    pendingUserInputs,
    activePendingApproval,
    activePendingUserInput,
    activePendingIsResponding,
    respondingRequestIds,
    onRespondToApprovalStable,
    onDismissUserInputStable,
    onSelectActivePendingUserInputOptionStable,
    onChangeActivePendingUserInputCustomAnswer,
    onAdvanceActivePendingUserInput,
    onAdvanceActivePendingUserInputStable,
    onPreviousActivePendingUserInputQuestionStable,
    heldApprovalRequestIds,
    onHeldRequestIdsChange,
    usageLimitsKey,
    usageLimitsBanner,
    usageLimitsOffered,
    openUsageLimits,
    clearUsageLimitsFor,
    beginLocalDispatch,
    resetLocalDispatch,
    isSendBusy,
    isCompacting,
    canSteer,
    isWorking,
    activeContextWindow,
    pendingBackgroundTasks,
    activeWorkStartedAt,
    providerStartingRun,
    sendQueuesBehindSetup,
    setupQueueSendThreadKey,
    setSetupQueueSendThreadKey,
    timelineEntriesInput,
    draftTimelineEntries,
    timelineEntries,
    timelineMessages,
    displayedTimelineKey,
    displayedThreadRef,
    worktreeSetup,
    isPreparingWorktree,
    worktreeSetupBlocksSend,
    retryableWorkspacePreparationRunIds,
    beginWorktreeSetup,
    cancelWorktreeSetup,
    onRetryWorkspacePreparationStable,
    onOpenWorktreeSetupTerminal,
    onCancelWorktreeSetupStable,
    setDockedDraftHeroThreadKey,
    isDraftHeroState,
    draftHeroTransitionGroupRef,
    draftHeroComposerAnchorRef,
    captureDraftHeroComposerRect,
  };
}
