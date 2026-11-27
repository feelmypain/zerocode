import { scopeThreadRef } from "@zerocode/client-runtime/environment";
import type { resolvePendingHandoff } from "@zerocode/client-runtime/handoff";
import type { EnvironmentThreadShell, ThreadStructure } from "@zerocode/client-runtime/state/shell";
import type {
  ChatFileAttachment,
  EnvironmentId,
  ScopedThreadRef,
  ServerProvider,
  TimestampFormat,
} from "@zerocode/contracts";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { previewMiniPlayerSourceKey } from "../../previewMiniPlayerStore";
import type { ChatMessage } from "../../types";
import { ThreadPreviewMiniPlayer } from "../preview/ThreadPreviewMiniPlayer";
import { usePreviewSession } from "../preview/usePreviewSession";
import { LinkPullRequestDialogHost } from "../pullRequest/LinkPullRequestDialog";
import {
  BranchRestoreConfirmHost,
  PullRequestThreadDialogHost,
  RevertConfirmHost,
} from "./ChatOverlayHosts";
import { ExpandedImageDialogHost } from "./ExpandedImageDialog";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { GuestPendingMessages } from "./GuestShareControls";
import { QueuedRunsControl, type QueuedRunsControlHandle } from "./QueuedRunsControl";
import { ThreadDetailsPanel } from "./ThreadDetailsPanel";
import { ThreadNow } from "./ThreadNow";
import { ThreadVisitWatermark } from "./ThreadVisitWatermark";
import { HandoffRow } from "./V2LifecycleRow";

function PreviewSessionSync(props: { readonly threadRef: ScopedThreadRef }) {
  usePreviewSession(props.threadRef);
  return null;
}

export function ChatViewCanvasOverlays(props: {
  readonly embedded: boolean;
  readonly canOperatePreview: boolean;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeThreadKey: string | null;
  readonly activeEnvironmentServerBrowser: boolean;
  readonly shownPreviewMiniPlayer:
    | ComponentProps<typeof ThreadPreviewMiniPlayer>["miniPlayer"]
    | null;
  readonly branchRestoreThreadBranch: string;
  readonly canWriteSourceControl: boolean;
  readonly onConfirmBranchRestore: () => void;
  readonly threadDetailsProps: ComponentProps<typeof ThreadDetailsPanel>;
  readonly pullRequestDialogProps: ComponentProps<typeof PullRequestThreadDialogHost>;
}) {
  const {
    embedded,
    canOperatePreview,
    activeThreadRef,
    activeThreadKey,
    activeEnvironmentServerBrowser,
    shownPreviewMiniPlayer,
    branchRestoreThreadBranch,
    canWriteSourceControl,
    onConfirmBranchRestore,
    threadDetailsProps,
    pullRequestDialogProps,
  } = props;

  if (embedded) return null;

  return (
    <>
      {canOperatePreview && activeThreadRef && activeEnvironmentServerBrowser ? (
        <PreviewSessionSync threadRef={activeThreadRef} />
      ) : null}
      {activeThreadRef && shownPreviewMiniPlayer ? (
        <ThreadPreviewMiniPlayer
          key={`${activeThreadKey}:${previewMiniPlayerSourceKey(shownPreviewMiniPlayer.source)}`}
          threadRef={activeThreadRef}
          miniPlayer={shownPreviewMiniPlayer}
        />
      ) : null}
      <BranchRestoreConfirmHost
        threadKey={activeThreadKey}
        threadBranch={branchRestoreThreadBranch}
        canWriteSourceControl={canWriteSourceControl}
        onConfirm={onConfirmBranchRestore}
      />
      <ThreadDetailsPanel {...threadDetailsProps} />
      <PullRequestThreadDialogHost {...pullRequestDialogProps} />
    </>
  );
}

export function ChatViewRootOverlays(props: {
  readonly embedded: boolean;
  readonly routeThreadKey: string;
  readonly routeThreadRef: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly taskFolderPath: string | null;
  readonly projection: ThreadStructure | null;
  readonly worktreePath: string | null;
  readonly onConfirmRevert: ComponentProps<typeof RevertConfirmHost>["onConfirm"];
}) {
  const {
    embedded,
    routeThreadKey,
    routeThreadRef,
    environmentId,
    taskFolderPath,
    projection,
    worktreePath,
    onConfirmRevert,
  } = props;

  return (
    <>
      <RevertConfirmHost
        threadKey={routeThreadKey}
        environmentId={environmentId}
        taskFolderPath={taskFolderPath}
        projection={projection}
        worktreePath={worktreePath}
        onConfirm={onConfirmRevert}
      />
      {embedded ? null : <LinkPullRequestDialogHost />}
      <ThreadVisitWatermark threadRef={routeThreadRef} />
      <ExpandedImageDialogHost threadKey={routeThreadKey} />
    </>
  );
}

export function ChatViewTimelineFooter(props: {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly isServerThread: boolean;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly pendingHandoff: ReturnType<typeof resolvePendingHandoff>;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly attentionNow: ComponentProps<typeof ThreadNow>["attention"];
  readonly workNow: ComponentProps<typeof ThreadNow>["work"];
  readonly shownThreadSyncPhase: ComponentProps<typeof ThreadNow>["syncPhase"];
  readonly goalNow: ComponentProps<typeof ThreadNow>["goal"];
  readonly threadStatusLine: ReactNode;
  readonly pendingGuestMessageCount: number;
  readonly hasQueuedTurns: boolean;
  readonly queuedRunsControlRef: RefObject<QueuedRunsControlHandle | null>;
  readonly steerShortcutLabel: string | null;
  readonly editShortcutLabel: string | null;
  readonly optimisticUserMessages: ReadonlyArray<ChatMessage>;
  readonly editingRunId: ComponentProps<typeof QueuedRunsControl>["editingRunId"];
  readonly editBlockedReason: string | null;
  readonly onEditQueuedRun: ComponentProps<typeof QueuedRunsControl>["onEditQueuedRun"];
  readonly onCancelEdit: () => void;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: ComponentProps<typeof QueuedRunsControl>["onOpenThread"];
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
  readonly onFileOpen: (attachment: ChatFileAttachment) => void;
}) {
  const {
    environmentId,
    routeThreadKey,
    isServerThread,
    activeThread,
    pendingHandoff,
    providerStatuses,
    attentionNow,
    workNow,
    shownThreadSyncPhase,
    goalNow,
    threadStatusLine,
    pendingGuestMessageCount,
    hasQueuedTurns,
    queuedRunsControlRef,
    steerShortcutLabel,
    editShortcutLabel,
    optimisticUserMessages,
    editingRunId,
    editBlockedReason,
    onEditQueuedRun,
    onCancelEdit,
    timestampFormat,
    onOpenThread,
    onImageExpand,
    onFileOpen,
  } = props;

  return (
    <>
      {pendingHandoff === null ? null : (
        <div className="chat-content-lane">
          <HandoffRow
            environmentId={environmentId}
            endpoints={pendingHandoff}
            providers={providerStatuses}
            pending
          />
        </div>
      )}
      <ThreadNow
        key={routeThreadKey}
        attention={attentionNow}
        work={workNow}
        syncPhase={shownThreadSyncPhase}
        goal={goalNow}
      />
      {threadStatusLine}
      {pendingGuestMessageCount > 0 && isServerThread && activeThread ? (
        <GuestPendingMessages
          threadRef={scopeThreadRef(activeThread.environmentId, activeThread.id)}
          onImageExpand={onImageExpand}
          onFileOpen={onFileOpen}
        />
      ) : null}
      {hasQueuedTurns && isServerThread && activeThread ? (
        <QueuedRunsControl
          ref={queuedRunsControlRef}
          steerShortcutLabel={steerShortcutLabel}
          editShortcutLabel={editShortcutLabel}
          environmentId={activeThread.environmentId}
          threadId={activeThread.id}
          optimisticMessages={optimisticUserMessages}
          editingRunId={editingRunId}
          editBlockedReason={editBlockedReason}
          onEditQueuedRun={onEditQueuedRun}
          onCancelEdit={onCancelEdit}
          timestampFormat={timestampFormat}
          onOpenThread={onOpenThread}
          onImageExpand={onImageExpand}
        />
      ) : null}
    </>
  );
}
