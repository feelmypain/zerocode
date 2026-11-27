import { useNavigate } from "@tanstack/react-router";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@zerocode/client-runtime/environment";
import { sideThreadComposer, sideThreadKindOf } from "@zerocode/client-runtime/side-thread";
import type { EnvironmentThreadShell, ThreadStructure } from "@zerocode/client-runtime/state/shell";
import {
  resolveWorkflowOpening,
  workflowOpeningParentThreadId,
} from "@zerocode/client-runtime/state/subagentRuntime";
import {
  canResumeThread,
  deriveLatestThreadRun,
  deriveProviderSubagentStatus,
  deriveResumableRunId,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadStructureRuntime,
  limitRecoveryOwnsSnooze,
} from "@zerocode/client-runtime/state/thread-execution";
import { threadSupportsProviderHandoff } from "@zerocode/client-runtime/state/thread-workflows";
import type {
  EnvironmentId,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
  UnifiedSettings,
} from "@zerocode/contracts";
import { resolveProjectSettings } from "@zerocode/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@zerocode/shared/usageLimits";
import { useGT, useMessages } from "gt-react";
import { useState } from "react";
import { resolveThreadOpenRoute, type SideChatParentPanel } from "~/lib/sideChatPane";
import type { DraftId, DraftSessionState } from "../../composerDraftStore";
import { useNowMinute } from "../../hooks/useNowMinute";
import {
  NO_PROVIDER_MODEL_SELECTION,
  resolveProjectDefaultProviderModelSelection,
} from "../../providerInstances";
import { useProject, useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  buildLocalDraftThread,
  type LocalThreadErrorEntry,
  makeThreadErrorSetter,
  resolveThreadErrorBanner,
} from "../ChatView.logic";
import {
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
} from "./ThreadErrorBanner";

interface ChatViewThreadResolutionInput {
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeThreadKey: string;
  readonly threadId: ThreadId;
  readonly draftId: DraftId | null;
  readonly draftThread: DraftSessionState | null;
  readonly serverThread: EnvironmentThreadShell | null;
  readonly serverProjection: ThreadStructure | null;
  readonly settings: UnifiedSettings;
  readonly providersByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<ServerProvider>>;
  readonly embedded: boolean;
  readonly parentPanel: SideChatParentPanel | undefined;
}

export function useChatViewThreadResolution(input: ChatViewThreadResolutionInput) {
  const {
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
  } = input;
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();

  const [localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [localServerErrorsByThreadKey, setLocalServerErrorsByThreadKey] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});

  const fallbackDraftProjectRef = draftThread
    ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
    : null;
  const fallbackDraftProject = useProject(fallbackDraftProjectRef);
  const localDraftError = serverThread
    ? null
    : ((draftId ? localDraftErrorsByDraftId[draftId]?.message : null) ?? null);
  const localServerError = localServerErrorsByThreadKey[routeThreadKey]?.message ?? null;
  const promotedDraftError =
    serverThread && draftId ? localDraftErrorsByDraftId[draftId] : undefined;
  if (promotedDraftError !== undefined && draftId) {
    const remainingDraftErrors = { ...localDraftErrorsByDraftId };
    delete remainingDraftErrors[draftId];
    setLocalDraftErrorsByDraftId(remainingDraftErrors);
    const currentEntry = localServerErrorsByThreadKey[routeThreadKey];
    if (
      currentEntry === undefined ||
      (currentEntry.at <= promotedDraftError.at &&
        currentEntry.message !== promotedDraftError.message)
    ) {
      setLocalServerErrorsByThreadKey({
        ...localServerErrorsByThreadKey,
        [routeThreadKey]: promotedDraftError,
      });
    }
  }

  const draftNowMinute = useNowMinute(draftThread !== null);
  const draftDefaultModelSelection = draftThread
    ? resolveProjectSettings(
        settings,
        fallbackDraftProject?.id ?? null,
        fallbackDraftProject ?? undefined,
      ).settings.defaultModelSelection
    : null;
  const draftModelResolution = draftThread
    ? resolveNewThreadModelSelection({
        defaultSelection:
          draftDefaultModelSelection ??
          resolveProjectDefaultProviderModelSelection(
            providersByEnvironment.get(draftThread.environmentId) ?? [],
            settings,
            draftThread.projectId,
          ),
        fallbackSelection: settings.fallbackModelSelection,
        providers: providersByEnvironment.get(draftThread.environmentId) ?? [],
        settings,
        projectId: draftThread.projectId,
        now: Date.parse(`${draftNowMinute}:00Z`),
      })
    : null;
  const draftFallback = draftModelResolution?.fallback ? draftModelResolution : null;
  const localDraftThread = draftThread
    ? buildLocalDraftThread(
        threadId,
        draftThread,
        (draftFallback ? draftFallback.selection : draftDefaultModelSelection) ??
          NO_PROVIDER_MODEL_SELECTION,
        messages,
      )
    : undefined;
  const isServerThread = serverThread !== null;
  const activeThread = isServerThread ? serverThread : localDraftThread;
  const serverLatestRun =
    serverProjection === null ? null : deriveLatestThreadRun(serverProjection);
  const serverActivityRun =
    serverProjection === null
      ? null
      : deriveThreadActivityRun(
          serverProjection,
          serverThread === null
            ? undefined
            : providersByEnvironment.get(serverThread.environmentId),
        );
  const serverRuntime =
    serverProjection === null ? null : deriveThreadStructureRuntime(serverProjection);
  const runlessWorkStartedAt =
    serverProjection === null ? null : deriveRunlessWorkStartedAt(serverProjection);
  const providerSubagentStatus =
    serverProjection === null ? null : deriveProviderSubagentStatus(serverProjection);
  const sideThreadKind = serverThread === null ? null : sideThreadKindOf(serverThread.source);
  const isProviderSubagent =
    sideThreadKind !== null && sideThreadComposer(sideThreadKind) === "read-only";
  const supportsProviderSwitchingViaHandoff = threadSupportsProviderHandoff(serverProjection);
  const activeLatestRun = isServerThread ? serverLatestRun : (activeThread?.latestRun ?? null);
  const activeActivityRun = isServerThread ? serverActivityRun : (activeThread?.latestRun ?? null);
  const activeRuntime = isServerThread ? serverRuntime : (activeThread?.runtime ?? null);
  const hasHeldQueuedRuns =
    isServerThread &&
    serverProjection?.runs.some((run) => run.status === "queued" && run.queueHeld === true) ===
      true;
  const resumableRunId =
    !isServerThread || serverProjection === null
      ? null
      : deriveResumableRunId(serverProjection, serverRuntime);
  const canResume =
    serverProjection !== null &&
    canResumeThread(serverProjection, resumableRunId, hasHeldQueuedRuns);

  const parentSubagentThreadId =
    activeThread?.lineage.relationshipToParent === "subagent"
      ? activeThread.lineage.parentThreadId
      : null;
  const parentSubagentEnvironmentId = activeThread?.environmentId ?? null;
  const parentSubagentThreadRef = (() => {
    if (parentSubagentEnvironmentId === null || parentSubagentThreadId === null) {
      return null;
    }
    return scopeThreadRef(parentSubagentEnvironmentId, parentSubagentThreadId);
  })();
  const parentSubagentThread = useQuietThreadShell(parentSubagentThreadRef);
  // Workflow threads open with a script; their replacement plan lives on the parent's coordinator row.
  const workflowOpeningParentId =
    serverProjection === null
      ? null
      : workflowOpeningParentThreadId({
          thread: serverProjection.thread,
          messages: serverProjection.messages,
        });
  const workflowOpeningParentProjection = useQuietThreadProjection(
    workflowOpeningParentId === null || parentSubagentEnvironmentId === null
      ? null
      : scopeThreadRef(parentSubagentEnvironmentId, workflowOpeningParentId),
  );
  const workflowOpening =
    serverProjection === null || workflowOpeningParentId === null
      ? null
      : resolveWorkflowOpening(
          {
            thread: serverProjection.thread,
            messages: serverProjection.messages,
            parentSubagents: workflowOpeningParentProjection?.projection.subagents ?? null,
          },
          messages,
        );
  // A linked environment's agent may have delegated this thread from there.
  const delegatedFrom = activeThread?.delegatedFrom ?? null;
  const delegatedFromEnvironment = useEnvironment(delegatedFrom?.environmentId ?? null);
  const delegatedFromRef =
    delegatedFrom === null
      ? null
      : scopeThreadRef(delegatedFrom.environmentId, delegatedFrom.threadId);
  // The title it had at delegation, until this client sees the parent itself.
  const delegatedFromThread = useQuietThreadShell(delegatedFromRef);
  const sideChatParentRef =
    activeThread?.lineage.sideChat === true && activeThread.lineage.parentThreadId !== null
      ? scopeThreadRef(activeThread.environmentId, activeThread.lineage.parentThreadId)
      : null;
  const sideChatParent = useQuietThreadShell(sideChatParentRef);
  const parentThreadLink = (() => {
    if (sideChatParentRef !== null) {
      const title = sideChatParent?.title ?? gt("Parent thread");
      // Embedded, the parent is the view around it.
      if (embedded) return { title, sideChat: true };
      return {
        title,
        sideChat: true,
        open: (): void => {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(sideChatParentRef),
          });
        },
      };
    }
    if (parentSubagentThreadRef !== null) {
      const title = parentSubagentThread?.title ?? gt("Parent thread");
      // Embedded in its parent's panel, the parent is the view around it.
      if (
        parentPanel !== undefined &&
        scopedThreadKey(parentPanel.hostRef) === scopedThreadKey(parentSubagentThreadRef)
      ) {
        return { title };
      }
      return {
        title,
        open: (): void => {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(
              resolveThreadOpenRoute(parentSubagentThreadRef, parentSubagentThread),
            ),
          });
        },
      };
    }
    // An agent step of a workflow run leads back to the run, which is where its work is read.
    const workflowRun = activeThread?.workflowRun ?? null;
    if (workflowRun !== null) {
      return {
        title: `${workflowRun.workflow} · ${workflowRun.step}`,
        relation: { label: gt("Step of the workflow run"), actionLabel: gt("Open run") },
        open: (): void => {
          void navigate({
            to: "/workflows",
            search: { env: workflowRun.environmentId, run: workflowRun.runId },
          });
        },
      };
    }
    if (delegatedFrom === null || delegatedFromRef === null) return null;
    const parentRef = delegatedFromRef;
    return {
      title: delegatedFromThread?.title ?? delegatedFrom.title,
      environmentLabel: delegatedFromEnvironment?.label ?? activeThread?.linkOrigin?.label ?? "",
      // Only an environment this client is connected to can open the parent.
      ...(delegatedFromEnvironment === null
        ? {}
        : {
            open: (): void => {
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(parentRef),
              });
            },
          }),
    };
  })();
  // The header's breadcrumb opens a parent in this environment only.
  const headerParentThreadLink =
    parentSubagentThreadRef === null
      ? null
      : {
          threadId: parentSubagentThreadRef.threadId,
          title: parentSubagentThread?.title ?? gt("Parent thread"),
        };

  const { threadError, sessionDismissal: threadErrorSessionDismissal } = resolveThreadErrorBanner({
    isServerThread,
    localServerError,
    localDraftError,
    runtimeError: serverRuntime?.lastError ?? null,
    runtimeErrorSource: serverRuntime?.lastErrorSource ?? null,
  });
  const threadErrorBannerKey =
    threadErrorSessionDismissal === null
      ? null
      : getThreadErrorBannerKey(
          routeThreadKey,
          threadErrorSessionDismissal.error,
          threadErrorSessionDismissal.source,
        );
  const visibleThreadError = shouldShowThreadErrorBanner(
    routeThreadKey,
    threadError,
    isThreadErrorBannerDismissedForSession(threadErrorBannerKey),
  )
    ? threadError
    : null;
  const [, setThreadErrorBannerDismissTick] = useState(0);
  const threadErrorIsServerRuntimeError =
    localServerError === null && visibleThreadError === serverRuntime?.lastError;
  const activeThreadShell = serverThread;
  const limitRecoveryRun =
    serverRuntime?.status === "failed" && serverRuntime.lastErrorClass === "usage_limit"
      ? (activeThreadShell?.latestRun ?? null)
      : null;
  // The recovery banner offers Wake now for a snooze it set.
  const limitRecoveryHoldsSnooze = limitRecoveryOwnsSnooze({
    runId: limitRecoveryRun?.runId,
    resetAt: serverRuntime?.usageLimitResetAt,
    recovery: activeThreadShell?.limitRecovery,
    snoozedUntil: activeThreadShell?.snoozedUntil,
  });
  // The run whose limit rows client-runtime hides (deriveUsageLimitNoticeRows).
  const usageLimitRunId =
    serverRuntime?.status === "failed" && serverRuntime.lastErrorClass === "usage_limit"
      ? (serverLatestRun?.runId ?? null)
      : null;
  const timelineThreadError =
    limitRecoveryRun !== null && visibleThreadError === serverRuntime?.lastError
      ? null
      : visibleThreadError;
  const serverThreadId = serverThread?.id;
  const serverThreadEnvironmentId = serverThread?.environmentId;
  const setThreadError = makeThreadErrorSetter({
    routeThreadRef,
    routeThreadKey,
    draftId,
    serverThreadRef:
      serverThreadId !== undefined && serverThreadEnvironmentId !== undefined
        ? { threadId: serverThreadId, environmentId: serverThreadEnvironmentId }
        : null,
    setLocalServerErrorsByThreadKey,
    setLocalDraftErrorsByDraftId,
  });
  // A delegated task is a remote thread's subagent.
  const isSubagentThread =
    activeThread?.lineage.relationshipToParent === "subagent" || delegatedFrom !== null;

  return {
    draftDefaultModelSelection,
    draftFallback,
    localDraftThread,
    isServerThread,
    activeThread,
    activeThreadShell,
    serverRuntime,
    runlessWorkStartedAt,
    providerSubagentStatus,
    isProviderSubagent,
    supportsProviderSwitchingViaHandoff,
    activeLatestRun,
    activeActivityRun,
    activeRuntime,
    hasHeldQueuedRuns,
    resumableRunId,
    canResume,
    workflowOpening,
    parentThreadLink,
    headerParentThreadLink,
    isSubagentThread,
    threadError,
    threadErrorBannerKey,
    setThreadErrorBannerDismissTick,
    threadErrorIsServerRuntimeError,
    limitRecoveryRun,
    limitRecoveryHoldsSnooze,
    usageLimitRunId,
    timelineThreadError,
    setThreadError,
  };
}
