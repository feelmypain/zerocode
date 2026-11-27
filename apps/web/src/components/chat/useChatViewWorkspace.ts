import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { scopedThreadKey, scopeProjectRef } from "@zerocode/client-runtime/environment";
import {
  resolveProviderSkillsForCwd,
  resolveProvidersForCwd,
} from "@zerocode/client-runtime/providerSkills";
import { clampFileAttachmentUploadBytes } from "@zerocode/client-runtime/state/attachments";
import { hasDismissedResumeCompaction } from "@zerocode/client-runtime/state/context-window";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@zerocode/client-runtime/state/project-grouping";
import { isScratchProject } from "@zerocode/client-runtime/state/projects";
import {
  type EnvironmentThreadShell,
  threadRuntimeIsActive,
  type ThreadStructure,
  type ThreadStructureVisibleTurnItem,
} from "@zerocode/client-runtime/state/shell";
import {
  type deriveThreadStructureRuntime,
  formatModelSelectionEffort,
} from "@zerocode/client-runtime/state/thread-execution";
import { resolveWorktreeRepositorySelection } from "@zerocode/client-runtime/state/thread-repositories";
import { deriveWorkspaceMutationId } from "@zerocode/client-runtime/state/threads";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
  UnifiedSettings,
} from "@zerocode/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@zerocode/shared/keybindings";
import { formatModelSlugName, resolveSelectableModel } from "@zerocode/shared/model";
import { projectScriptCwd, resolveProjectScripts } from "@zerocode/shared/projectScripts";
import { resolveProjectSettings } from "@zerocode/shared/projectSettings";
import { resolveTerminalSessionLabel } from "@zerocode/shared/terminalLabelsCopy";
import type { resolveNewThreadModelSelection } from "@zerocode/shared/usageLimits";
import * as Schema from "effect/Schema";
import { useMessages } from "gt-react";
import { useEffect, useState } from "react";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useRemoteOpenState } from "~/remoteOpen";
import type { DraftId, DraftSessionState, DraftThreadEnvMode } from "../../composerDraftStore";
import { useActiveThreadRef } from "../../hooks/useActiveThreadRef";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useLogicalProjectEnvironments } from "../../hooks/useLogicalProjectEnvironments";
import { usePullRequestLinking } from "../../hooks/usePullRequestLinking";
import { useClientSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useWorkspaceRevision } from "../../hooks/useWorkspaceRevision";
import { useWorktreeRepositoryChoices } from "../../hooks/useWorktreeRepositoryChoices";
import { shortcutLabelForCommand } from "../../keybindings";
import { draftModelSelectionApplies, threadHasStarted } from "../../lib/chatThreadActions";
import { isPreviewSupportedInRuntime } from "../../previewStateStore";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useRightPanelStore } from "../../rightPanelStore";
import { derivePhase, findRevertCheckpoint } from "../../session-logic";
import {
  useEnvironmentSupportsServerBrowser,
  useProject,
  useThreadCheckpointSummaries,
} from "../../state/entities";
import type { EnvironmentPresentation } from "../../state/environments";
import { hostEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { useEnvironmentQueryRefresh } from "../../state/query";
import { revisionedQuery } from "../../state/revisionedQuery";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { useEnvironmentShellHasSnapshot } from "../../state/shell";
import {
  useKnownTerminalSessions,
  useThreadRunningTerminalIds,
} from "../../state/terminalSessions";
import { chatGitStatusAtom, NO_CHAT_GIT_STATUS_ATOM, vcsEnvironment } from "../../state/vcs";
import { useRememberedWorktreeRepositories } from "../../worktreeRepositoryChoiceStore";
import { offersWorkspaceModes, shouldShowEnvironmentIndicator } from "../BranchToolbar.logic";
import {
  deriveAvailableRevertTurnCounts,
  deriveLockedProvider,
  isThreadEnvironmentLocked,
  recallCheckoutIsRepo,
  rememberCheckoutIsRepo,
  resolveComposerProviderSelection,
  startNewThreadForProject,
} from "../ChatView.logic";
import { getConfiguredPreviewUrls } from "../preview/previewEmptyStateLogic";
import { hasAvailableCompactionProvider } from "./compaction.logic";
import { shouldShowOpenInPicker } from "./OpenInPicker.logic";
import { getTriggerDisplayModelName } from "./providerIconUtils";
import {
  getProviderStatusDismissalKey,
  shouldShowProviderStatusBanner,
  useProviderStatusBannerDismissed,
} from "./ProviderStatusBanner";
import { useProjectCloneBanner } from "./useProjectCloneBanner";
import { usePullRequestDraftThread } from "./usePullRequestDraftThread";

const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PROVIDER_MODELS: ServerProvider["models"] = [];
const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];
const EMPTY_AUTO_UPDATE_ENVIRONMENTS: ReadonlyArray<EnvironmentPresentation> = [];
const EMPTY_PENDING_FILE_SURFACE_IDS: ReadonlySet<string> = new Set();

interface ChatViewWorkspaceInput {
  readonly environmentId: EnvironmentId;
  readonly routeKind: "server" | "draft";
  readonly draftId: DraftId | null;
  readonly routeThreadDetailRef: ScopedThreadRef | null;
  readonly isServerThread: boolean;
  readonly isLocalDraftThread: boolean;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly serverThread: EnvironmentThreadShell | null;
  readonly serverThreadShell: EnvironmentThreadShell | null;
  readonly serverProjection: ThreadStructure | null;
  readonly serverVisibleTurnItems: ReadonlyArray<ThreadStructureVisibleTurnItem>;
  readonly serverThreadHistoryHasMore: boolean;
  readonly threadStatus: string;
  readonly draftThread: DraftSessionState | null;
  readonly draftFallback: ReturnType<typeof resolveNewThreadModelSelection> | null;
  readonly activeRuntime: ReturnType<typeof deriveThreadStructureRuntime>;
  readonly reportedModelSelection: ModelSelection | null;
  readonly supportsProviderSwitchingViaHandoff: boolean;
  readonly canOperateThread: boolean;
  readonly canWriteSourceControl: boolean;
  readonly committedServerMessageCount: number;
  readonly environmentById: ReadonlyMap<EnvironmentId, EnvironmentPresentation>;
  readonly providersByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<ServerProvider>>;
  readonly primaryEnvironment: EnvironmentPresentation | null;
  readonly settings: UnifiedSettings;
  readonly clientSettingsHydrated: boolean;
  readonly composerRuntimeMode: EnvironmentThreadShell["runtimeMode"] | null;
  readonly composerActiveProvider: ProviderInstanceId | null;
  readonly composerModelSelectionExplicit: boolean;
  readonly composerSelectedModelSelection: ModelSelection | null;
  readonly composerHasAttachments: boolean;
  readonly timelineThreadError: string | null;
  readonly terminalOpen: boolean;
}

export function useChatViewWorkspace(input: ChatViewWorkspaceInput) {
  const {
    environmentId,
    routeKind,
    draftId,
    routeThreadDetailRef,
    isServerThread,
    isLocalDraftThread,
    activeThread,
    serverThread,
    serverThreadShell,
    serverProjection,
    serverVisibleTurnItems,
    serverThreadHistoryHasMore,
    threadStatus,
    draftThread,
    draftFallback,
    activeRuntime,
    reportedModelSelection,
    supportsProviderSwitchingViaHandoff,
    canOperateThread,
    canWriteSourceControl,
    committedServerMessageCount,
    environmentById,
    providersByEnvironment,
    primaryEnvironment,
    settings,
    clientSettingsHydrated,
    composerRuntimeMode,
    composerActiveProvider,
    composerModelSelectionExplicit,
    composerSelectedModelSelection,
    composerHasAttachments,
    timelineThreadError,
    terminalOpen,
  } = input;
  const messages = useMessages();
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();

  const defaultRuntimeMode = resolveProjectSettings(settings, activeThread?.projectId ?? null)
    .settings.defaultRuntimeMode;
  const runtimeMode =
    composerRuntimeMode ??
    (isServerThread ? activeThread?.runtimeMode : undefined) ??
    defaultRuntimeMode;
  const canCheckoutPullRequestIntoThread = canWriteSourceControl && isLocalDraftThread;
  const activeThreadId = activeThread?.id ?? null;
  // Turn items can lag projection hydration; keep the environment locked through that gap.
  const activeMessageCount = isServerThread
    ? Math.max(committedServerMessageCount, serverProjection?.messages.length ?? 0)
    : 0;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  const activeThreadKnownSessionsRaw = useKnownTerminalSessions({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  const activeThreadKnownSessions = (() => {
    if (activeThreadId === null || activeThreadKnownSessionsRaw === null) {
      return [];
    }
    return activeThreadKnownSessionsRaw.filter(
      (session) => session.target.threadId === activeThreadId,
    );
  })();
  const activeServerOrderedTerminalIds = activeThreadKnownSessions.map(
    (session) => session.target.terminalId,
  );
  const activeTerminalLabelsById = (() => {
    const labels = new Map<string, string>();
    for (const session of activeThreadKnownSessions) {
      labels.set(
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary, messages),
      );
    }
    return labels;
  })();
  const canReuseTerminal = activeThreadKnownSessionsRaw !== null;
  const activeThreadRef = useActiveThreadRef(activeThread);
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const activeEnvironmentServerBrowser = useEnvironmentSupportsServerBrowser(
    activeThreadRef?.environmentId ?? null,
  );
  const browserAvailable = isPreviewSupportedInRuntime() || activeEnvironmentServerBrowser;

  const activeThreadEnvironmentId = activeThread?.environmentId;
  const activeThreadProjectId = activeThread?.projectId;
  const activeProjectRef =
    activeThreadEnvironmentId !== undefined && activeThreadProjectId !== undefined
      ? scopeProjectRef(activeThreadEnvironmentId, activeThreadProjectId)
      : null;
  const activeProject = useProject(activeProjectRef);
  const activeProjectSettings = resolveProjectSettings(
    settings,
    activeProject?.id ?? null,
    activeProject ?? undefined,
  );
  const activeProjectScripts = activeProject ? resolveProjectScripts(settings, activeProject) : [];
  const { projectCloneBannerItem, projectCloneSendBlockReason } =
    useProjectCloneBanner(activeProjectRef);
  const activeProjectDefaultModelSelection =
    !isServerThread && draftFallback
      ? draftFallback.selection
      : activeProjectSettings.settings.defaultModelSelection;
  const handleNewThreadInActiveProject = () => {
    startNewThreadForProject(activeProjectRef, handleNewThread);
  };
  const handleNewThreadInActiveProjectStable = useStableCallback(handleNewThreadInActiveProject);
  const projectGroupingSettings = selectProjectGroupingSettings(settings);
  const activeDraftLogicalProjectKey =
    !isServerThread && activeProject
      ? deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings)
      : undefined;
  const handleOpenDraftProjectSettings = () => {
    if (!activeDraftLogicalProjectKey) return;
    void navigate({
      to: "/projects/$projectKey",
      params: { projectKey: activeDraftLogicalProjectKey },
    });
  };
  const handleOpenDraftProjectSettingsStable = useStableCallback(handleOpenDraftProjectSettings);
  const activeEnvironmentBootstrapComplete = useEnvironmentShellHasSnapshot(
    activeThread?.environmentId ?? null,
  );
  const activeProjectKey = activeProject
    ? `${activeProject.environmentId}:${activeProject.workspaceRoot}`
    : null;
  const [pendingFileSurfaceIdsByProject, setPendingFileSurfaceIdsByProject] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());
  const pendingFileSurfaceIds = activeProjectKey
    ? (pendingFileSurfaceIdsByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS)
    : EMPTY_PENDING_FILE_SURFACE_IDS;
  const handleFilePendingChange = (relativePath: string, pending: boolean) => {
    if (!activeProjectKey) return;
    setPendingFileSurfaceIdsByProject((currentByProject) => {
      const current = currentByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS;
      const surfaceId = `file:${relativePath}`;
      if (current.has(surfaceId) === pending) return currentByProject;
      const next = new Set(current);
      if (pending) next.add(surfaceId);
      else next.delete(surfaceId);
      const nextByProject = new Map(currentByProject);
      if (next.size === 0) nextByProject.delete(activeProjectKey);
      else nextByProject.set(activeProjectKey, next);
      return nextByProject;
    });
  };
  const handleFilePendingChangeStable = useStableCallback(handleFilePendingChange);
  const configuredPreviewUrls = getConfiguredPreviewUrls(activeProjectScripts);

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- drops file surfaces from the right panel store once bootstrap shows the thread has no workspace
  useEffect(() => {
    if (!activeThreadRef || !activeEnvironmentBootstrapComplete) return;
    useRightPanelStore.getState().reconcileFileSurfaces(activeThreadRef, activeProject !== null);
  }, [activeEnvironmentBootstrapComplete, activeProject, activeThreadRef]);

  const activeEnvironment =
    activeThread == null ? null : (environmentById.get(activeThread.environmentId) ?? null);
  const activeEnvironmentUnavailable =
    activeEnvironment !== null && activeEnvironment.connection.phase !== "connected";
  const activeEnvironmentUnavailableLabel = activeEnvironment?.label ?? null;
  const activeEnvironmentUnavailableState =
    activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel && activeEnvironment
      ? {
          environmentId: activeEnvironment.environmentId,
          label: activeEnvironmentUnavailableLabel,
          connection: activeEnvironment.connection,
        }
      : null;
  const activeProjectIsScratch =
    activeProject !== null &&
    isScratchProject(
      activeProject,
      environmentById.get(activeProject.environmentId)?.serverConfig?.scratchWorkspaceRoot ?? null,
    );
  const logicalProjectEnvironments = useLogicalProjectEnvironments(
    activeProject,
    activeProjectIsScratch && draftId !== null,
  );
  const hasMultipleEnvironments = logicalProjectEnvironments.length > 1;
  const canAutoBalanceEnvironments = hasMultipleEnvironments && !activeProjectIsScratch;
  const activeEnvironmentOption =
    logicalProjectEnvironments.find(
      (environment) => environment.environmentId === activeThread?.environmentId,
    ) ?? null;
  const showComposerEnvironmentIndicator = shouldShowEnvironmentIndicator({
    activeEnvironment: activeEnvironmentOption,
    canPickEnvironment: hasMultipleEnvironments,
  });

  const pullRequestLinking = usePullRequestLinking(environmentId);
  // Best effort: the thread already exists, so a failed link is only logged.
  const linkCheckoutPullRequest = useStableCallback((threadRef: ScopedThreadRef, url: string) => {
    pullRequestLinking.changeLink(threadRef, url, true).catch((error: unknown) => {
      console.warn("Failed to link the checked-out pull request to its thread.", error);
    });
  });
  const { handlePreparedPullRequestThreadStable, openPullRequestDialogStable } =
    usePullRequestDraftThread({
      routeKind,
      draftId,
      settings,
      projectGroupingSettings,
      activeProject,
      activeThreadKey,
      isServerThread,
      canCheckoutPullRequestIntoThread,
    });
  const serverConfig = activeThread
    ? (activeEnvironment?.serverConfig ?? null)
    : (primaryEnvironment?.serverConfig ?? null);
  const providerEnvironmentId = (activeThread ? activeEnvironment : primaryEnvironment)
    ?.environmentId;
  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.workspaceRoot },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  const providerStatuses = resolveProvidersForCwd(
    (providerEnvironmentId === undefined
      ? undefined
      : providersByEnvironment.get(providerEnvironmentId)) ?? EMPTY_PROVIDERS,
    gitCwd,
  );
  const composerModelSelectionApplies = draftModelSelectionApplies(
    { modelSelectionExplicit: composerModelSelectionExplicit },
    threadHasStarted(activeThread),
  );
  const selectedProviderByThreadId = composerModelSelectionApplies ? composerActiveProvider : null;
  const threadProvider =
    activeThread?.modelSelection.instanceId ??
    activeProjectDefaultModelSelection?.instanceId ??
    null;
  const lockedProvider = deriveLockedProvider({
    thread: activeThread,
    selectedProvider: selectedProviderByThreadId,
    threadProvider,
    providers: providerStatuses,
  });
  const modelPickerLockedProvider = supportsProviderSwitchingViaHandoff ? null : lockedProvider;
  const pullRequestsCapabilityKnown = serverConfig !== null;
  const supportsPullRequests = serverConfig !== null;
  const attachmentEnvironmentConfig = environmentById.get(environmentId)?.serverConfig ?? null;
  const attachmentUploadsCapabilityKnown = attachmentEnvironmentConfig !== null;
  const supportsQuestionAttachments = attachmentEnvironmentConfig !== null;
  const supportsAttachmentUploads = attachmentEnvironmentConfig !== null;
  const advertisedFileAttachmentBytes =
    attachmentEnvironmentConfig?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null;
  const maxFileAttachmentBytes =
    advertisedFileAttachmentBytes === null
      ? null
      : clampFileAttachmentUploadBytes(advertisedFileAttachmentBytes);
  const envLocked =
    Boolean(activeThread) &&
    isThreadEnvironmentLocked({
      messageCount: activeMessageCount,
      hasRuntime: activeRuntime !== null,
      activeProviderThreadId: serverThread?.activeProviderThreadId ?? null,
    });
  // onEnvironmentChange only retargets an unsent draft. envLocked alone does not
  // rule out a started thread: one whose machine is offline never loads its
  // messages, so it would otherwise be offered a machine picker that does nothing.
  const canChangeEnvironment =
    hasMultipleEnvironments && !envLocked && draftId !== null && !draftThread?.promotedTo;

  const loadBalancingSettings = useClientSettings((clientSettings) => ({
    loadBalancingEnabled: clientSettings.loadBalancingEnabled,
    loadBalancingWeights: clientSettings.loadBalancingWeights,
  }));
  const automaticEnvironment = Boolean(
    clientSettingsHydrated &&
    draftId &&
    !envLocked &&
    canAutoBalanceEnvironments &&
    loadBalancingSettings.loadBalancingEnabled &&
    draftThread?.environmentSelection !== "manual" &&
    (!composerHasAttachments || Boolean(draftThread?.loadBalancedEnvironmentId)) &&
    (!draftThread?.branch || draftThread.environmentSelection === "auto") &&
    !draftThread?.worktreePath,
  );
  const autoUpdateEnvironments = automaticEnvironment
    ? logicalProjectEnvironments.flatMap(({ environmentId: envId }) => {
        const environment = environmentById.get(envId);
        return environment ? [environment] : [];
      })
    : EMPTY_AUTO_UPDATE_ENVIRONMENTS;
  const providerInstanceEntries = providerInstanceEntriesFor(
    providerStatuses,
    settings,
    activeProject?.id ?? null,
  );
  const activeThreadModelInstanceId = activeThread?.modelSelection.instanceId;
  const { selectedProviderEntry, requestedDriverKind } = resolveComposerProviderSelection({
    entries: providerInstanceEntries,
    candidateInstanceIds: [
      selectedProviderByThreadId,
      activeRuntime?.providerInstanceId,
      activeThreadModelInstanceId,
      activeProjectDefaultModelSelection?.instanceId,
    ],
    lockedProvider,
    lockedInstanceId: activeRuntime?.providerInstanceId ?? activeThreadModelInstanceId,
  });
  const selectedProvider = selectedProviderEntry?.driverKind ?? requestedDriverKind;
  const activeProviderInstanceId = selectedProviderEntry?.instanceId ?? null;
  const activeProviderStatus = selectedProviderEntry?.snapshot ?? null;
  const activeUsageModel =
    [
      composerModelSelectionApplies ? composerSelectedModelSelection : null,
      activeThread?.modelSelection,
    ].find((selection) => selection?.instanceId === activeProviderInstanceId)?.model ?? null;
  const conversationProviderStatus =
    providerStatuses.find((status) => status.instanceId === activeRuntime?.providerInstanceId) ??
    activeProviderStatus;
  const supportsConversationRollback =
    canOperateThread &&
    conversationProviderStatus !== null &&
    conversationProviderStatus.supportsConversationRollback !== false;
  const phase = derivePhase(activeRuntime);

  const turnDiffSummaries = useThreadCheckpointSummaries(routeThreadDetailRef);
  const availableRevertTurnCounts = deriveAvailableRevertTurnCounts(serverProjection);
  // A paged history window cannot identify the first loaded run as the thread start.
  const threadStartCheckpointAvailable =
    !serverThreadHistoryHasMore && findRevertCheckpoint(serverProjection, 0) !== undefined;
  const workspaceMutationId = deriveWorkspaceMutationId(
    serverVisibleTurnItems,
    turnDiffSummaries.at(-1)?.completedAt ?? null,
  );
  const gitStatusCwd = activeThread?.worktreePath ?? gitCwd;
  const gitStatusAtom =
    gitStatusCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd: gitStatusCwd },
        });
  const workspaceRevision = useWorkspaceRevision({
    threadKey: activeThreadKey,
    // A running thread can change the workspace after this visit's reads began.
    unloaded:
      routeThreadDetailRef !== null &&
      threadStatus !== "live" &&
      threadStatus !== "deleted" &&
      !threadRuntimeIsActive(serverThreadShell?.runtime),
    mutationId: workspaceMutationId,
  });
  // Per thread: opening a thread with workspace changes reads a cached status again.
  const gitStatusRevision =
    workspaceRevision.revision === null
      ? undefined
      : `${activeThreadKey ?? ""}\u0000${workspaceRevision.revision}`;
  const gitStatusQuery = {
    data: useAtomValue(
      gitStatusAtom
        ? chatGitStatusAtom(
            workspaceRevision.pending
              ? revisionedQuery(gitStatusAtom, undefined, { startedUnder: gitStatusRevision })
              : revisionedQuery(
                  gitStatusAtom,
                  workspaceMutationId === null ? undefined : gitStatusRevision,
                ),
          )
        : NO_CHAT_GIT_STATUS_ATOM,
    ),
    refresh: useEnvironmentQueryRefresh(gitStatusAtom).refresh,
  };
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const scriptKeybindings =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.keybindings ??
    DEFAULT_RESOLVED_KEYBINDINGS;
  const openInEnvironmentId = activeThread?.environmentId ?? environmentId;
  const availableEditors =
    useAtomValue(serverEnvironment.configValueAtom(openInEnvironmentId))?.availableEditors ?? [];
  const hostEnvironmentId = useAtomValue(hostEnvironmentIdAtom);
  const remoteOpenState = useRemoteOpenState(openInEnvironmentId);
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName: activeProject?.title,
    activeThreadEnvironmentId: openInEnvironmentId,
    primaryEnvironmentId: primaryEnvironment?.environmentId ?? null,
    hostEnvironmentId,
    remoteOpenMode: remoteOpenState.mode,
  });
  const manualCompactionProviderAvailable = hasAvailableCompactionProvider({
    providers: providerInstanceEntries,
    driverKind: selectedProvider,
    instanceId: activeProviderInstanceId,
    lockedInstanceId: lockedProvider
      ? (activeRuntime?.providerInstanceId ?? activeThread?.modelSelection.instanceId ?? null)
      : null,
  });
  const [resumeCompactionPermanentlyDismissed, setResumeCompactionPermanentlyDismissed] =
    useLocalStorage(
      `zerocode:resume-compaction-dismissed:${environmentId}:${activeProviderInstanceId ?? "claudeAgent"}`,
      false,
      Schema.Boolean,
    );
  const nativeResumeCompactionDismissed = hasDismissedResumeCompaction(
    (serverProjection?.runtimeRequests ?? [])
      .filter((request) => request.kind === "user_input" && request.status === "resolved")
      .map((request) => ({
        kind: "user-input.resolved",
        payload: { answers: request.answers },
      })),
  );
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- persists the server-reported resume compaction dismissal to localStorage
  useEffect(() => {
    if (nativeResumeCompactionDismissed && !resumeCompactionPermanentlyDismissed) {
      setResumeCompactionPermanentlyDismissed(true);
    }
  }, [
    nativeResumeCompactionDismissed,
    resumeCompactionPermanentlyDismissed,
    setResumeCompactionPermanentlyDismissed,
  ]);
  const providerStatusDismissalKey = getProviderStatusDismissalKey(
    providerEnvironmentId,
    activeProviderStatus,
  );
  const providerStatusDismissed = useProviderStatusBannerDismissed(providerStatusDismissalKey);
  const visibleProviderStatus = shouldShowProviderStatusBanner(
    activeProviderStatus,
    providerStatusDismissed,
  )
    ? activeProviderStatus
    : null;
  const hasTimelineTopBanner = Boolean(timelineThreadError) || visibleProviderStatus !== null;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const activeWorkspaceRoot = activeThreadWorktreePath ?? activeProjectCwd ?? undefined;
  const liveIsGitRepo = gitStatusQuery.data?.isRepo;
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- records live git repo status in the session cache read while the status query is unavailable
  useEffect(() => {
    if (gitStatusCwd !== null && liveIsGitRepo !== undefined) {
      rememberCheckoutIsRepo(environmentId, gitStatusCwd, liveIsGitRepo);
    }
  }, [environmentId, gitStatusCwd, liveIsGitRepo]);
  const isGitRepo = liveIsGitRepo ?? recallCheckoutIsRepo(environmentId, gitStatusCwd) ?? true;
  // A plain folder holding tracked repositories has turn diffs without being a Git repository.
  const diffAvailable =
    isGitRepo ||
    (activeProject?.trackedFolders?.length ?? 0) > 0 ||
    turnDiffSummaries.some((summary) => summary.repositories !== undefined);

  const providerSubagentModels = selectedProviderEntry?.models ?? EMPTY_PROVIDER_MODELS;
  // Providers can report dated model ids or aliases.
  const providerSubagentModelSlug = selectedProviderEntry
    ? resolveSelectableModel(
        selectedProviderEntry.driverKind,
        activeThread?.modelSelection.model,
        providerSubagentModels,
      )
    : null;
  const providerSubagentCatalogModel = providerSubagentModels.find(
    (model) => model.slug === providerSubagentModelSlug,
  );
  const providerSubagentModelLabel = providerSubagentCatalogModel
    ? getTriggerDisplayModelName(providerSubagentCatalogModel, selectedProviderEntry?.driverKind)
    : formatModelSlugName(activeThread?.modelSelection.model ?? "");
  const providerSubagentEffortLabel =
    activeThread === undefined
      ? null
      : formatModelSelectionEffort(
          activeThread.modelSelection,
          providerSubagentModels,
          reportedModelSelection,
        );
  const terminalShortcutLabelOptions = {
    context: {
      terminalFocus: true,
      terminalOpen,
    },
  };
  const splitTerminalShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "terminal.split",
    terminalShortcutLabelOptions,
  );
  const splitTerminalVerticalShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "terminal.splitVertical",
    terminalShortcutLabelOptions,
  );
  const newTerminalShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "terminal.new",
    terminalShortcutLabelOptions,
  );
  const closeTerminalShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "terminal.close",
    terminalShortcutLabelOptions,
  );
  const timelineSkills = activeProviderStatus
    ? resolveProviderSkillsForCwd(activeProviderStatus, gitCwd)
    : EMPTY_PROVIDER_SKILLS;

  // Overrides chosen before a server thread's first turn; they belong to that thread only.
  const [pendingServerThreadEnvModeEntry, setPendingServerThreadEnvModeEntry] = useState<{
    readonly threadId: ThreadId;
    readonly mode: DraftThreadEnvMode;
  } | null>(null);
  const [pendingServerThreadBranchEntry, setPendingServerThreadBranchEntry] = useState<{
    readonly threadId: ThreadId;
    readonly branch: string | null;
  } | null>(null);
  const [
    pendingServerThreadStartFromOriginByThreadId,
    setPendingServerThreadStartFromOriginByThreadId,
  ] = useState<Record<string, boolean>>({});
  const canOverrideServerThreadEnvMode = Boolean(
    isServerThread &&
    activeThread &&
    activeMessageCount === 0 &&
    activeThread.worktreePath === null &&
    !envLocked,
  );
  if (
    !canOverrideServerThreadEnvMode &&
    (pendingServerThreadEnvModeEntry !== null || pendingServerThreadBranchEntry !== null)
  ) {
    setPendingServerThreadEnvModeEntry(null);
    setPendingServerThreadBranchEntry(null);
  }
  const pendingServerThreadEnvMode =
    pendingServerThreadEnvModeEntry !== null &&
    pendingServerThreadEnvModeEntry.threadId === activeThread?.id
      ? pendingServerThreadEnvModeEntry.mode
      : null;
  const pendingServerThreadBranchEntryForThread =
    pendingServerThreadBranchEntry?.threadId === activeThread?.id
      ? pendingServerThreadBranchEntry
      : null;
  const setPendingServerThreadBranch = (branch: string | null) => {
    if (activeThread) setPendingServerThreadBranchEntry({ threadId: activeThread.id, branch });
  };
  const activeThreadBranch =
    canOverrideServerThreadEnvMode && pendingServerThreadBranchEntryForThread !== null
      ? pendingServerThreadBranchEntryForThread.branch
      : (activeThread?.branch ?? null);
  const startFromOrigin = isLocalDraftThread
    ? (draftThread?.startFromOrigin ?? false)
    : canOverrideServerThreadEnvMode
      ? (pendingServerThreadStartFromOriginByThreadId[activeThread?.id ?? ""] ??
        activeProjectSettings.settings.newWorktreesStartFromOrigin)
      : false;
  const worktreeRepositoryChoices = useWorktreeRepositoryChoices(activeProject);
  const workspaceModesOffered = offersWorkspaceModes({
    isScratchProject: activeProjectIsScratch,
    isGitRepo,
    tracksGitRepositories: worktreeRepositoryChoices.tracksGitRepositories,
  });
  const rememberedWorktreeRepositories = useRememberedWorktreeRepositories(activeProject ?? null);
  // Only a new thread's draft holds a choice; anything else leaves it to the server's default.
  const worktreeRepositories = resolveWorktreeRepositorySelection({
    choices: worktreeRepositoryChoices.choices,
    chosen: isLocalDraftThread
      ? (draftThread?.worktreeRepositories ?? rememberedWorktreeRepositories)
      : undefined,
  }).strategyRepositories;

  return {
    defaultRuntimeMode,
    runtimeMode,
    canCheckoutPullRequestIntoThread,
    activeThreadId,
    activeMessageCount,
    runningTerminalIds,
    activeServerOrderedTerminalIds,
    activeTerminalLabelsById,
    canReuseTerminal,
    activeThreadRef,
    activeThreadKey,
    activeEnvironmentServerBrowser,
    browserAvailable,
    activeProjectRef,
    activeProject,
    activeProjectSettings,
    activeProjectScripts,
    projectCloneBannerItem,
    projectCloneSendBlockReason,
    activeProjectDefaultModelSelection,
    handleNewThreadInActiveProject,
    handleNewThreadInActiveProjectStable,
    projectGroupingSettings,
    activeDraftLogicalProjectKey,
    handleOpenDraftProjectSettingsStable,
    activeProjectKey,
    pendingFileSurfaceIds,
    handleFilePendingChangeStable,
    configuredPreviewUrls,
    activeEnvironment,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    activeEnvironmentUnavailableState,
    activeProjectIsScratch,
    logicalProjectEnvironments,
    hasMultipleEnvironments,
    canAutoBalanceEnvironments,
    showComposerEnvironmentIndicator,
    linkCheckoutPullRequest,
    handlePreparedPullRequestThreadStable,
    openPullRequestDialogStable,
    serverConfig,
    gitCwd,
    providerStatuses,
    composerModelSelectionApplies,
    lockedProvider,
    modelPickerLockedProvider,
    pullRequestsCapabilityKnown,
    supportsPullRequests,
    attachmentUploadsCapabilityKnown,
    supportsQuestionAttachments,
    supportsAttachmentUploads,
    maxFileAttachmentBytes,
    envLocked,
    canChangeEnvironment,
    loadBalancingSettings,
    automaticEnvironment,
    autoUpdateEnvironments,
    providerInstanceEntries,
    selectedProviderEntry,
    selectedProvider,
    activeProviderInstanceId,
    activeProviderStatus,
    activeUsageModel,
    supportsConversationRollback,
    phase,
    turnDiffSummaries,
    availableRevertTurnCounts,
    threadStartCheckpointAvailable,
    workspaceMutationId,
    workspaceRevision,
    gitStatusQuery,
    keybindings,
    scriptKeybindings,
    openInEnvironmentId,
    availableEditors,
    showOpenInPicker,
    manualCompactionProviderAvailable,
    resumeCompactionPermanentlyDismissed,
    nativeResumeCompactionDismissed,
    providerStatusDismissalKey,
    visibleProviderStatus,
    hasTimelineTopBanner,
    activeProjectCwd,
    activeThreadWorktreePath,
    activeWorkspaceRoot,
    isGitRepo,
    diffAvailable,
    providerSubagentModelLabel,
    providerSubagentEffortLabel,
    splitTerminalShortcutLabel,
    splitTerminalVerticalShortcutLabel,
    newTerminalShortcutLabel,
    closeTerminalShortcutLabel,
    timelineSkills,
    setPendingServerThreadEnvModeEntry,
    setPendingServerThreadStartFromOriginByThreadId,
    canOverrideServerThreadEnvMode,
    pendingServerThreadEnvMode,
    setPendingServerThreadBranch,
    activeThreadBranch,
    startFromOrigin,
    worktreeRepositoryChoices,
    workspaceModesOffered,
    worktreeRepositories,
  };
}
