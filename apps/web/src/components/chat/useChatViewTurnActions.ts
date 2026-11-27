import type { ThreadStructure } from "@zerocode/client-runtime/state/shell";
import type { PreviewAnnotationPayload } from "@zerocode/contracts";
import { useGT } from "gt-react";
import { useEffect, useRef, useState } from "react";
import {
  type ComposerImageAttachment,
  type DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useComposerResume } from "./useComposerResume";
import { useComposerSelection } from "./useComposerSelection";
import { useComposerSend } from "./useComposerSend";
import { useTimelineRewind } from "./useTimelineRewind";
import type { useWorktreeSetup } from "./useWorktreeSetup";

interface ChatViewTurnActionsInput {
  readonly rewind: Parameters<typeof useTimelineRewind>[0];
  readonly selection: Parameters<typeof useComposerSelection>[0];
  readonly resume: Parameters<typeof useComposerResume>[0];
  readonly send: Parameters<typeof useComposerSend>[0];
  readonly routeThreadKey: string;
  readonly draftId: DraftId | null;
  readonly serverProjection: ThreadStructure | null;
  readonly compactDisabled: boolean;
  readonly sendStandaloneCommand: (command: string, errorFallback: string) => Promise<void>;
  readonly worktreeSetup: ReturnType<typeof useWorktreeSetup>["worktreeSetup"];
  readonly cancelWorktreeSetup: () => Promise<boolean>;
  readonly isLocalDraftThread: boolean;
  readonly isSendBusy: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly threadDetailLoading: boolean;
  readonly clientSettingsHydrated: boolean;
  readonly needsLoadBalancing: boolean;
  readonly activeEnvironmentUnavailable: boolean;
  readonly hasActivePendingUserInput: boolean;
  readonly feedbackUploading: boolean;
  readonly sendEnvMode: "local" | "worktree";
  readonly sendInFlightRef: { readonly current: boolean };
  readonly feedbackUploadsInFlightRef: { readonly current: ReadonlySet<string> };
  readonly timelineLiveFollowEnabled: boolean;
  readonly scrollToEnd: (force?: boolean) => void;
}

export function useChatViewTurnActions(input: ChatViewTurnActionsInput) {
  const {
    rewind,
    selection,
    resume,
    send,
    routeThreadKey,
    draftId,
    serverProjection,
    compactDisabled,
    sendStandaloneCommand,
    worktreeSetup,
    cancelWorktreeSetup,
    isLocalDraftThread,
    isSendBusy,
    isRevertingCheckpoint,
    threadDetailLoading,
    clientSettingsHydrated,
    needsLoadBalancing,
    activeEnvironmentUnavailable,
    hasActivePendingUserInput,
    feedbackUploading,
    sendEnvMode,
    sendInFlightRef,
    feedbackUploadsInFlightRef,
    timelineLiveFollowEnabled,
    scrollToEnd,
  } = input;
  const gt = useGT();
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const composerDraftTarget = send.composerDraftTarget;

  // Draft ids survive promotion and expire on navigation, keeping the pending resend scoped correctly.
  const [workLocallyResendDraftId, setWorkLocallyResendDraftId] = useState<DraftId | null>(null);

  const { onConfirmRevertStable, onForkFromRunStable, onRevertTimelineTurnStable } =
    useTimelineRewind(rewind);

  const onCompactContext = () => {
    if (compactDisabled) return;
    void sendStandaloneCommand("/compact", gt("Failed to compact context."));
  };
  const onComposerCompactContextStable = useStableCallback(onCompactContext);

  const {
    getModelDisabledReason,
    handleRuntimeModeChangeStable,
    onEnvModeChangeStable,
    onProviderModelSelectStable,
    onStartFromOriginChange,
    openProviderSetupStable,
  } = useComposerSelection(selection);

  const { onResume, isResuming } = useComposerResume(resume);
  const { onSend, captureDetachedSend } = useComposerSend(send);

  const onWorktreeSetupWorkLocally = () => {
    if (!worktreeSetup || worktreeSetup.phase !== "running" || !draftId) {
      return;
    }
    void cancelWorktreeSetup().then((cancelled) => {
      if (cancelled) setWorkLocallyResendDraftId(draftId);
    });
  };
  const onWorktreeSetupWorkLocallyStable = useStableCallback(onWorktreeSetupWorkLocally);
  const onComposerSendStable = useStableCallback(onSend);
  const sendPreviewAnnotation = (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => {
    void onSend(undefined, "auto", "foreground", { annotation, image });
  };
  const sendPreviewAnnotationStable = useStableCallback(sendPreviewAnnotation);
  const onComposerResumeStable = useStableCallback(onResume);

  // Read from the projection the footer renders, so the scroll below sees the new message.
  const pendingGuestMessageIds =
    serverProjection?.thread.guestShare?.messages.flatMap((message) =>
      message.status === "pending" ? [message.id] : [],
    ) ?? [];
  const pendingGuestMessageCount = pendingGuestMessageIds.length;
  const pendingGuestMessageKey = pendingGuestMessageIds.join(",");
  const previousPendingGuestMessagesRef = useRef({
    threadKey: routeThreadKey,
    key: pendingGuestMessageKey,
  });
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- scrolls the timeline list to the end when a new pending guest message joins its footer
  useEffect(() => {
    const previous = previousPendingGuestMessagesRef.current;
    previousPendingGuestMessagesRef.current = {
      threadKey: routeThreadKey,
      key: pendingGuestMessageKey,
    };
    // Opening another thread is not a new message; its own scroll position wins.
    if (previous.threadKey !== routeThreadKey) return;
    // Pending guest messages sit in the list footer, which the list does not follow on its own.
    // The follow flag reflects the owner's position before the footer grew; a live measure may not.
    // Any new id counts, even when another one was resolved in the same update.
    const previousIds = new Set(previous.key.split(","));
    const hasNewMessage = pendingGuestMessageKey
      .split(",")
      .some((id) => id !== "" && !previousIds.has(id));
    if (hasNewMessage && timelineLiveFollowEnabled) scrollToEnd(true);
  }, [routeThreadKey, pendingGuestMessageKey, timelineLiveFollowEnabled, scrollToEnd]);

  const resendAfterWorkLocally = () => {
    setWorkLocallyResendDraftId(null);
    void onComposerSendStable();
  };
  const resendAfterWorkLocallyStable = useStableCallback(resendAfterWorkLocally);
  const workLocallyResendReady =
    workLocallyResendDraftId !== null &&
    workLocallyResendDraftId === draftId &&
    isLocalDraftThread &&
    !isSendBusy &&
    !isRevertingCheckpoint &&
    !threadDetailLoading &&
    clientSettingsHydrated &&
    !needsLoadBalancing &&
    !activeEnvironmentUnavailable &&
    !hasActivePendingUserInput &&
    !feedbackUploading;
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- switches the draft to local mode, then resends the waiting message once sending is idle
  useEffect(() => {
    if (
      !workLocallyResendReady ||
      sendInFlightRef.current ||
      feedbackUploadsInFlightRef.current.has(routeThreadKey)
    ) {
      return;
    }
    if (sendEnvMode !== "local") {
      setDraftThreadContext(composerDraftTarget, { envMode: "local", startFromOrigin: false });
      return;
    }
    resendAfterWorkLocallyStable();
  }, [
    composerDraftTarget,
    feedbackUploadsInFlightRef,
    resendAfterWorkLocallyStable,
    sendInFlightRef,
    routeThreadKey,
    sendEnvMode,
    setDraftThreadContext,
    workLocallyResendReady,
  ]);

  return {
    onConfirmRevertStable,
    onForkFromRunStable,
    onRevertTimelineTurnStable,
    onComposerCompactContextStable,
    getModelDisabledReason,
    handleRuntimeModeChangeStable,
    onEnvModeChangeStable,
    onProviderModelSelectStable,
    onStartFromOriginChange,
    openProviderSetupStable,
    isResuming,
    captureDetachedSend,
    onWorktreeSetupWorkLocallyStable,
    onComposerSendStable,
    sendPreviewAnnotationStable,
    onComposerResumeStable,
    pendingGuestMessageCount,
  };
}
