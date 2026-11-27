import { useAtomValue } from "@effect/atom-react";
import { useLocation } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@zerocode/client-runtime/environment";
import { deriveReportedModelSelection } from "@zerocode/client-runtime/state/thread-execution";
import {
  type CodexFeedbackSubmission,
  shouldShowLoadEarlierControl,
} from "@zerocode/client-runtime/state/threads";
import {
  type AssistantCitation,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ModelSelection,
  type ResponseContextRecord,
  type ScopedThreadRef,
  type ThreadId,
} from "@zerocode/contracts";
import { useGT } from "gt-react";
import { type RefObject, type SetStateAction, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import type { SideChatParentPanel } from "~/lib/sideChatPane";
import { useEnvironmentScope } from "~/state/session";
import {
  composerDraftHasUserContent,
  type DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useDelayedStatus } from "../../hooks/useDelayedStatus";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useClientSettingsHydrated, useEnvironmentSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useTheme } from "../../hooks/useTheme";
import {
  assistantCitationFromLocation,
  useSideChatCitationReveal,
} from "../../lib/assistantCitationNavigation";
import { collectInlineContextIds } from "../../lib/composerContextReferences";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  resolveThreadDetailRef,
  useQuietThreadProjection,
  useQuietThreadShell,
  useQuietThreadVisibleTurnItems,
  useThreadError,
  useThreadHistory,
  useThreadLastVisitedAt,
  useThreadStatus,
  useThreadUpdatedAt,
} from "../../state/entities";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironment,
} from "../../state/environments";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { resolveThreadSyncPhase } from "../../threadSync";
import type { ChatMessage } from "../../types";
import {
  deriveCommittedServerUserMessageIds,
  presentThreadShellFromProjection,
} from "../ChatView.logic";
import { toastManager } from "../ui/toast";
import type { AssistantCitationRequest } from "./AssistantCitationSource";
import type { ChatComposerHandle } from "./ChatComposer";
import { draftFanoutSelectionsAtom } from "./chatViewSend";
import { useCitedHistory } from "./citationProcedure";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";
import {
  applyOptimisticUserMessagesAction,
  createOptimisticBlobPreviews,
  emptyOptimisticUserMessages,
  reconcileOptimisticUserMessages,
} from "./optimisticUserMessages";
import { useChatViewThreadResolution } from "./useChatViewThreadResolution";
import { useQueuedRunEdit } from "./useQueuedRunEdit";

const EMPTY_FEEDBACK_SUBMISSIONS: ReadonlyArray<CodexFeedbackSubmission> = [];

interface ChatViewRouteDataInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly routeKind: "server" | "draft";
  readonly draftId: DraftId | null;
  readonly embedded: boolean;
  readonly parentPanel: SideChatParentPanel | undefined;
  readonly promptRef: RefObject<string>;
  readonly composerRef: RefObject<ChatComposerHandle | null>;
}

export function useChatViewRouteData(input: ChatViewRouteDataInput) {
  const {
    environmentId,
    threadId,
    routeKind,
    draftId,
    embedded,
    parentPanel,
    promptRef,
    composerRef,
  } = input;
  const gt = useGT();
  const panelHostShell = useQuietThreadShell(parentPanel?.hostRef ?? null);
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const routeThreadRef = scopeThreadRef(environmentId, threadId);
  const routeThreadKey = scopedThreadKey(routeThreadRef);
  const loadEarlierThreadHistory = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const baseComposerDraftTarget: ScopedThreadRef | DraftId =
    routeKind === "server" ? routeThreadRef : draftId!;
  const draftThread = useComposerDraftStore((store) =>
    routeKind === "server"
      ? store.getDraftSessionByRef(routeThreadRef)
      : draftId
        ? store.getDraftSession(draftId)
        : null,
  );
  const serverThreadShell = useQuietThreadShell(routeThreadRef);
  const routeThreadDetailRef = resolveThreadDetailRef(routeThreadRef, {
    shellExists: serverThreadShell !== null,
    waitForShell: draftThread !== null,
  });
  const serverThreadProjection = useQuietThreadProjection(routeThreadDetailRef);
  const serverProjection = serverThreadProjection?.projection ?? null;
  // Only the shell-less fallback needs these; with a shell, the shell carries them.
  const fallbackDetailRef = serverThreadShell === null ? routeThreadDetailRef : null;
  const fallbackUpdatedAt = useThreadUpdatedAt(fallbackDetailRef);
  const fallbackLastVisitedAt = useThreadLastVisitedAt(fallbackDetailRef);
  const serverThread =
    serverThreadShell !== null || serverProjection === null || fallbackUpdatedAt === null
      ? serverThreadShell
      : presentThreadShellFromProjection(environmentId, threadId, serverProjection, {
          updatedAt: fallbackUpdatedAt,
          lastVisitedAt: fallbackLastVisitedAt,
        });
  const queuedRunEdit = useQueuedRunEdit({
    environmentId,
    routeThreadRef,
    threadDraftTarget: baseComposerDraftTarget,
    activeThreadId: serverThread !== null || draftThread !== null ? threadId : null,
    serverProjection,
    promptRef,
    composerRef,
  });
  const composerDraftTarget = queuedRunEdit.draftTarget;
  const reportedModelSelection = serverProjection
    ? deriveReportedModelSelection(serverProjection)
    : null;
  const threadStatus = useThreadStatus(routeThreadDetailRef);
  const threadSyncError = useThreadError(routeThreadDetailRef);
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: serverProjection !== null,
    shellExists: serverThread !== null,
    status: threadStatus,
    hasError: threadSyncError !== null,
  });
  const threadDetailLoading = threadSyncPhase === "loading";
  // Held back briefly, so a quick sync does not flash a status line at the end of the timeline.
  const delayedThreadSyncPhase = useDelayedStatus(routeThreadKey, threadSyncPhase);
  const serverVisibleTurnItems = useQuietThreadVisibleTurnItems(routeThreadDetailRef);
  const serverThreadHistory = useThreadHistory(routeThreadDetailRef);
  const threadHistoryControls = (() => {
    if (routeThreadDetailRef === null || !shouldShowLoadEarlierControl(serverThreadHistory)) {
      return undefined;
    }
    return {
      hasMoreHistory: serverThreadHistory.hasMoreHistory,
      loading: serverThreadHistory.loading,
      error: serverThreadHistory.error,
      onLoadEarlier: (throughEntryId) => {
        void loadEarlierThreadHistory({
          environmentId: routeThreadDetailRef.environmentId,
          input: {
            threadId: routeThreadDetailRef.threadId,
            ...(throughEntryId === undefined ? {} : { throughEntryId }),
          },
        });
      },
    };
  })() as MessagesTimelineHistoryControls | undefined;
  const committedServerMessageIds = deriveCommittedServerUserMessageIds(serverVisibleTurnItems);
  // Queued messages have no turn item until starting, so cancellation must retire their optimistic rows
  // separately.
  const serverAcknowledgedUserMessageIds = (() => {
    const ids = new Set(committedServerMessageIds);
    for (const message of serverProjection?.messages ?? []) {
      if (message.role === "user") ids.add(message.id);
    }
    return ids;
  })();
  const settings = useEnvironmentSettings(environmentId);
  const clientSettingsHydrated = useClientSettingsHydrated();
  const timestampFormat = settings.timestampFormat;
  // Selects primitives: an object here is new on every router store update, which
  // re-renders ChatView on unrelated navigation state changes.
  const citationHref = useLocation({ select: (location) => location.href });
  const citationKey = useLocation({
    select: (location) => location.state.assistantCitationActivation ?? location.state.__TSR_key,
  });
  const citationLocation = { href: citationHref, key: citationKey };
  const locationCitation = assistantCitationFromLocation(citationLocation.href);
  const citationActivation = citationLocation.key ?? citationLocation.href;
  const citationRequest = (
    locationCitation &&
    locationCitation.environmentId === environmentId &&
    locationCitation.threadId === threadId
      ? { citation: locationCitation, key: citationActivation }
      : null
  ) as AssistantCitationRequest | null;
  useSideChatCitationReveal(embedded ? null : routeThreadRef, locationCitation, citationActivation);
  const citationHistory = useCitedHistory(citationRequest);
  const { resolvedTheme } = useTheme();
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  );
  const composerActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  );
  const composerModelSelectionExplicit = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.modelSelectionExplicit === true,
  );
  const composerSelectedModelSelection = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return draft?.activeProvider
      ? (draft.modelSelectionByProvider[draft.activeProvider] ?? null)
      : null;
  });
  const composerHasAttachments = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return (draft?.images.length ?? 0) > 0 || (draft?.files.length ?? 0) > 0;
  });
  const referencedThreadContexts = useComposerDraftStore(
    useShallow((store) => {
      const draft = store.getComposerDraft(composerDraftTarget);
      if (!draft?.threadContexts.length) return [];
      // Linked prompts can replace text without pruning stored context records.
      const referenced = new Set(collectInlineContextIds(draft.prompt));
      return draft.threadContexts.filter((record) => referenced.has(record.contextId));
    }),
  );
  const composerHasNonPromptContent = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return draft ? composerDraftHasUserContent({ ...draft, prompt: "" }) : false;
  });
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);

  const citeAssistantText = (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => {
    const inserted = composerRef.current?.citeAssistantText(citation, sourceAnchor) ?? false;
    if (!inserted) {
      toastManager.add({
        type: "warning",
        title: gt("The composer is not ready"),
        description: gt(
          "Try citing the selection after the connection or pending input is resolved.",
        ),
      });
    }
    return inserted;
  };
  const citeAssistantTextStable = useStableCallback(citeAssistantText);
  const replyToResponseStable = useStableCallback((response: ResponseContextRecord) => {
    const accepted = composerRef.current?.replyToResponse(response) ?? false;
    if (!accepted) {
      toastManager.add({
        type: "warning",
        title: gt("The composer is not ready"),
        description: gt("Try replying after the connection or pending input is resolved."),
      });
    }
    return accepted;
  });

  const [isWorkspaceFileDragActive, setIsWorkspaceFileDragActive] = useState(false);
  const [optimisticBlobPreviews] = useState(createOptimisticBlobPreviews);
  const [heldOptimisticUserMessages, setHeldOptimisticUserMessages] = useState(() =>
    emptyOptimisticUserMessages(threadId),
  );
  // Acknowledged messages leave the timeline in the same render the server's copy enters it.
  const optimisticState = reconcileOptimisticUserMessages(
    heldOptimisticUserMessages,
    threadId,
    serverAcknowledgedUserMessageIds,
  );
  if (optimisticState !== heldOptimisticUserMessages) {
    // Idempotent, and a discarded render only delays revocation to the thread's end.
    optimisticBlobPreviews.handOff(optimisticState);
    setHeldOptimisticUserMessages(optimisticState);
  }
  const optimisticUserMessages = optimisticState.messages;
  const setOptimisticUserMessages = (action: SetStateAction<ChatMessage[]>) =>
    setHeldOptimisticUserMessages((state) =>
      applyOptimisticUserMessagesAction(state, threadId, action),
    );
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const feedbackSubmissions =
    feedbackSubmissionsByThreadKey[routeThreadKey] ?? EMPTY_FEEDBACK_SUBMISSIONS;
  const feedbackUploading = feedbackSubmissions.some(
    (submission) => submission.status === "uploading",
  );
  const isRevertingCheckpoint = useComposerDraftStore((store) =>
    store.rewindingThreadKeys.has(routeThreadKey),
  );

  const workspaceFileDragRouteKey = `${routeThreadKey}:${draftId ?? ""}`;
  const [workspaceFileDragRoute, setWorkspaceFileDragRoute] = useState(workspaceFileDragRouteKey);
  if (workspaceFileDragRoute !== workspaceFileDragRouteKey) {
    setWorkspaceFileDragRoute(workspaceFileDragRouteKey);
    setIsWorkspaceFileDragActive(false);
  }
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- window dragend listener that clears the workspace file drag state
  useEffect(() => {
    if (!isWorkspaceFileDragActive) return;
    const clearWorkspaceFileDrag = () => setIsWorkspaceFileDragActive(false);
    window.addEventListener("dragend", clearWorkspaceFileDrag);
    return () => window.removeEventListener("dragend", clearWorkspaceFileDrag);
  }, [isWorkspaceFileDragActive]);

  const prefersPlanSidebarSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const isMobileViewport = useMediaQuery("max-sm");
  // Focusing the composer without a tap raises the on-screen keyboard on touch devices.
  const isCoarsePointer = useMediaQuery({ pointer: "coarse" });
  const fanoutSelectionsAtom = draftFanoutSelectionsAtom(routeThreadKey);
  const multipleModelSelections = useAtomValue(fanoutSelectionsAtom);
  const setMultipleModelSelections = (
    selections: SetStateAction<ReadonlyArray<ModelSelection> | null>,
  ) => {
    appAtomRegistry.update(fanoutSelectionsAtom, (current) =>
      typeof selections === "function" ? selections(current) : selections,
    );
  };
  const setMultipleModelSelectionsStable = useStableCallback(setMultipleModelSelections);
  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef),
  );

  const resolution = useChatViewThreadResolution({
    routeThreadRef,
    routeThreadKey,
    threadId,
    draftId,
    draftThread,
    serverThread,
    serverProjection,
    settings,
    providersByEnvironment,
    embedded,
    parentPanel,
  });

  return {
    ...resolution,
    panelHostShell,
    canOperateThread,
    canOperateTerminal,
    canWriteSourceControl,
    routeThreadRef,
    routeThreadKey,
    environments,
    providersByEnvironment,
    primaryEnvironment,
    environmentById,
    draftThread,
    serverThreadShell,
    routeThreadDetailRef,
    serverProjection,
    serverThread,
    queuedRunEdit,
    composerDraftTarget,
    reportedModelSelection,
    threadStatus,
    threadSyncPhase,
    threadDetailLoading,
    delayedThreadSyncPhase,
    serverVisibleTurnItems,
    serverThreadHistory,
    threadHistoryControls,
    committedServerMessageIds,
    settings,
    clientSettingsHydrated,
    timestampFormat,
    citationRequest,
    citationHistory,
    resolvedTheme,
    composerRuntimeMode,
    composerActiveProvider,
    composerModelSelectionExplicit,
    composerSelectedModelSelection,
    composerHasAttachments,
    referencedThreadContexts,
    composerHasNonPromptContent,
    setComposerDraftPrompt,
    citeAssistantTextStable,
    replyToResponseStable,
    isWorkspaceFileDragActive,
    setIsWorkspaceFileDragActive,
    optimisticBlobPreviews,
    optimisticState,
    optimisticUserMessages,
    setHeldOptimisticUserMessages,
    setOptimisticUserMessages,
    setFeedbackSubmissionsByThreadKey,
    feedbackSubmissions,
    feedbackUploading,
    isRevertingCheckpoint,
    prefersPlanSidebarSheet,
    isMobileViewport,
    isCoarsePointer,
    multipleModelSelections,
    setMultipleModelSelectionsStable,
    terminalUiState,
  };
}
