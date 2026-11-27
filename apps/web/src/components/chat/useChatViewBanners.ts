import type { EnvironmentServerConfig } from "@zerocode/client-runtime/connection";
import { squashAtomCommandFailure } from "@zerocode/client-runtime/state/runtime";
import type { EnvironmentThreadShell, ThreadStructure } from "@zerocode/client-runtime/state/shell";
import {
  deriveProviderExtensionStatuses,
  type deriveThreadStructureRuntime,
} from "@zerocode/client-runtime/state/thread-execution";
import type { CodexFeedbackSubmission } from "@zerocode/client-runtime/state/threads";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  ServerProvider,
  TimestampFormat,
  UnifiedSettings,
} from "@zerocode/contracts";
import type { resolveNewThreadModelSelection } from "@zerocode/shared/usageLimits";
import * as Schema from "effect/Schema";
import { useMessages } from "gt-react";
import type { Dispatch, SetStateAction } from "react";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import type { ComposerThreadTarget, DraftSessionState } from "../../composerDraftStore";
import { resolveProjectDefaultProviderModelSelection } from "../../providerInstances";
import type { PendingApproval, PendingUserInput } from "../../session-logic";
import type { EnvironmentPresentation } from "../../state/environments";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { resolveLocalCheckoutBranchMismatch } from "../BranchToolbar.logic";
import { dismissBranchMismatchForSession } from "../ChatView.logic";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { feedbackBannerItem } from "./ComposerFeedback";
import { freshSessionBannerItem } from "./ComposerFreshSession";
import { heldComposerSendBannerItem } from "./ComposerHeldSendBanner";
import { modelFallbackBannerItem } from "./ComposerUsageLimits";
import { disarmFreshSession } from "./freshSessionArms";
import { branchMismatchBannerItem, extensionStatusBannerItem } from "./ThreadActivityBanners";
import { useUsageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";
import {
  type EnvironmentUnavailableState,
  useSystemComposerBanners,
} from "./useSystemComposerBanners";

const DismissedFallbackWindowSchema = Schema.NullOr(Schema.String);

interface ChatViewBannersInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly isServerThread: boolean;
  readonly draftThread: DraftSessionState | null;
  readonly draftDefaultModelSelection: ModelSelection | null;
  readonly draftFallback: ReturnType<typeof resolveNewThreadModelSelection> | null;
  readonly activeThreadShell: EnvironmentThreadShell | null;
  readonly activeThreadEnvironmentId: EnvironmentId | null;
  readonly activeEnvironment: EnvironmentPresentation | null;
  readonly activeEnvironmentUnavailable: boolean;
  readonly activeEnvironmentUnavailableState: EnvironmentUnavailableState | null;
  readonly serverConfig: EnvironmentServerConfig | null;
  readonly serverProjection: ThreadStructure | null;
  readonly serverRuntime: ReturnType<typeof deriveThreadStructureRuntime>;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly timestampFormat: TimestampFormat;
  readonly hasMultipleRegisteredEnvironments: boolean;
  readonly automaticEnvironment: boolean;
  readonly autoUpdateEnvironments: ReadonlyArray<EnvironmentPresentation>;
  readonly multipleModelSelections: ReadonlyArray<ModelSelection> | null;
  readonly composerModelSelectionExplicit: boolean;
  readonly composerSelectedModelSelection: ModelSelection | null;
  readonly feedbackSubmissions: ReadonlyArray<CodexFeedbackSubmission>;
  readonly setFeedbackSubmissionsByThreadKey: Dispatch<
    SetStateAction<Record<string, ReadonlyArray<CodexFeedbackSubmission>>>
  >;
  readonly limitRecoveryRun: EnvironmentThreadShell["latestRun"];
  readonly pendingApprovals: ReadonlyArray<PendingApproval>;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly activePendingApproval: PendingApproval | null;
  readonly usageLimitsBanner: ComposerBannerStackItem | null;
  readonly projectCloneBannerItem: ComposerBannerStackItem | null;
  readonly freshSessionPending: boolean;
  readonly composerSendHeld: boolean;
  readonly cancelHeldSendStable: () => void;
  readonly localCheckoutBranchMismatch: ReturnType<typeof resolveLocalCheckoutBranchMismatch>;
  readonly showBranchMismatchBanner: boolean;
  readonly activeBranchMismatchKey: string | null;
  readonly canWriteSourceControl: boolean;
  readonly isRestoringThreadBranch: boolean;
  readonly handleRestoreThreadBranchStable: () => void;
  readonly setBranchMismatchDismissTick: Dispatch<SetStateAction<number>>;
  readonly onProviderModelSelectStable: (instanceId: ProviderInstanceId, model: string) => void;
}

export function useChatViewBanners(input: ChatViewBannersInput): ComposerBannerStackItem[] {
  const {
    environmentId,
    routeThreadKey,
    composerDraftTarget,
    isServerThread,
    draftThread,
    draftDefaultModelSelection,
    draftFallback,
    activeThreadShell,
    activeThreadEnvironmentId,
    activeEnvironment,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableState,
    serverConfig,
    serverProjection,
    serverRuntime,
    providerStatuses,
    settings,
    timestampFormat,
    hasMultipleRegisteredEnvironments,
    automaticEnvironment,
    autoUpdateEnvironments,
    multipleModelSelections,
    composerModelSelectionExplicit,
    composerSelectedModelSelection,
    feedbackSubmissions,
    setFeedbackSubmissionsByThreadKey,
    limitRecoveryRun,
    pendingApprovals,
    pendingUserInputs,
    activePendingApproval,
    usageLimitsBanner,
    projectCloneBannerItem,
    freshSessionPending,
    composerSendHeld,
    cancelHeldSendStable,
    localCheckoutBranchMismatch,
    showBranchMismatchBanner,
    activeBranchMismatchKey,
    canWriteSourceControl,
    isRestoringThreadBranch,
    handleRestoreThreadBranchStable,
    setBranchMismatchDismissTick,
    onProviderModelSelectStable,
  } = input;
  const messages = useMessages();
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });

  const systemComposerBannerItems = useSystemComposerBanners({
    activeEnvironment,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableState,
    activeThreadEnvironmentId,
    serverConfig,
    hasMultipleRegisteredEnvironments,
    automaticEnvironment,
    autoUpdateEnvironments,
  });

  const [dismissedFallbackWindow, setDismissedFallbackWindow] = useLocalStorage(
    `zerocode:fallback-notice-dismissed:${environmentId}`,
    null,
    DismissedFallbackWindowSchema,
  );

  const feedbackBannerItems = feedbackSubmissions.flatMap((submission) => {
    const item = feedbackBannerItem(
      submission,
      () => {
        setFeedbackSubmissionsByThreadKey((current) => ({
          ...current,
          [routeThreadKey]: (current[routeThreadKey] ?? []).filter(
            (entry) => entry.id !== submission.id,
          ),
        }));
      },
      messages,
    );
    return item ? [item] : [];
  });

  const limitRecoveryBanner = useUsageLimitRecoveryBannerItem(
    limitRecoveryRun !== null && activeThreadShell !== null
      ? {
          runId: limitRecoveryRun.runId,
          errorCode: serverRuntime?.lastErrorCode ?? null,
          resetAt: serverRuntime?.usageLimitResetAt ?? null,
          stoppedAt: limitRecoveryRun.completedAt ?? activeThreadShell.updatedAt,
          settled: activeThreadShell.settledOverride === "settled",
          requestPending: pendingApprovals.length > 0 || pendingUserInputs.length > 0,
          recovery: activeThreadShell.limitRecovery ?? null,
          snoozedUntil: activeThreadShell.snoozedUntil,
          timestampFormat,
          onChange: async (limitRecovery) => {
            const result = await updateThreadMetadata({
              environmentId,
              input: { threadId: activeThreadShell.id, limitRecovery },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          },
        }
      : null,
    messages,
  );

  const fallbackSelection = draftFallback?.selection;
  const defaultSelection =
    draftDefaultModelSelection ??
    resolveProjectDefaultProviderModelSelection(
      providerStatuses,
      settings,
      draftThread?.projectId ?? null,
    );
  const fallback =
    !isServerThread &&
    multipleModelSelections === null &&
    !composerModelSelectionExplicit &&
    draftFallback?.fallback &&
    (!composerSelectedModelSelection ||
      (composerSelectedModelSelection.instanceId === fallbackSelection?.instanceId &&
        composerSelectedModelSelection.model === fallbackSelection?.model))
      ? draftFallback.fallback
      : null;
  const fallbackWindow = fallback
    ? `${fallback.provider.instanceId}:${fallback.resetsAt ?? ""}`
    : null;
  const fallbackItems: ComposerBannerStackItem[] =
    fallback && fallbackSelection && defaultSelection && fallbackWindow !== dismissedFallbackWindow
      ? [
          modelFallbackBannerItem(
            {
              fallbackModelName:
                providerStatuses
                  .find((provider) => provider.instanceId === fallbackSelection.instanceId)
                  ?.models.find((model) => model.slug === fallbackSelection.model)?.name ??
                fallbackSelection.model,
              defaultProviderName: fallback.provider.displayName ?? fallback.provider.driver,
              defaultModelName:
                fallback.provider.models.find((model) => model.slug === defaultSelection.model)
                  ?.name ?? defaultSelection.model,
              resetsAt: fallback.resetsAt,
              timestampFormat,
              onUseDefault: () =>
                onProviderModelSelectStable(defaultSelection.instanceId, defaultSelection.model),
              onDismiss: () => setDismissedFallbackWindow(fallbackWindow),
            },
            messages,
          ),
        ]
      : [];
  const limitRecoveryItems = limitRecoveryBanner === null ? [] : [limitRecoveryBanner];
  const extensionStatusBanner = extensionStatusBannerItem(
    deriveProviderExtensionStatuses(serverProjection),
  );
  const extensionStatusItems = extensionStatusBanner === null ? [] : [extensionStatusBanner];
  const usageLimitsItems = usageLimitsBanner === null ? [] : [usageLimitsBanner];
  const projectCloneItems = projectCloneBannerItem === null ? [] : [projectCloneBannerItem];
  // An approval's feedback goes to that approval; the armed session waits for the next message.
  const freshSessionItems =
    freshSessionPending && activePendingApproval === null
      ? [freshSessionBannerItem(() => disarmFreshSession(routeThreadKey), messages)]
      : [];
  const heldSendItems = composerSendHeld
    ? [
        heldComposerSendBannerItem(
          { draftTarget: composerDraftTarget, onCancel: cancelHeldSendStable },
          messages,
        ),
      ]
    : [];
  if (!localCheckoutBranchMismatch || !showBranchMismatchBanner || !activeBranchMismatchKey) {
    return [
      ...feedbackBannerItems,
      ...fallbackItems,
      ...limitRecoveryItems,
      ...extensionStatusItems,
      ...usageLimitsItems,
      ...projectCloneItems,
      ...freshSessionItems,
      ...heldSendItems,
      ...systemComposerBannerItems,
    ];
  }
  return [
    ...feedbackBannerItems,
    ...fallbackItems,
    ...limitRecoveryItems,
    ...extensionStatusItems,
    ...usageLimitsItems,
    ...projectCloneItems,
    ...freshSessionItems,
    ...heldSendItems,
    ...systemComposerBannerItems,
    branchMismatchBannerItem(
      {
        mismatchKey: activeBranchMismatchKey,
        mismatch: localCheckoutBranchMismatch,
        restoreDisabled: !canWriteSourceControl || isRestoringThreadBranch,
        restoring: isRestoringThreadBranch,
        onRestore: handleRestoreThreadBranchStable,
        onDismiss: () => {
          dismissBranchMismatchForSession(activeBranchMismatchKey);
          setBranchMismatchDismissTick((tick) => tick + 1);
        },
      },
      messages,
    ),
  ];
}
