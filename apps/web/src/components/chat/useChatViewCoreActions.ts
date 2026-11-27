import { thrownErrorMessage } from "@zerocode/client-runtime/errors";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
} from "@zerocode/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@zerocode/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  type ChatFileAttachment,
  type EnvironmentId,
  ProviderInteractionMode,
  RuntimeMode,
  type ScopedThreadRef,
  type ThreadId,
} from "@zerocode/contracts";
import type { CodexArtifactTemplate } from "@zerocode/shared/codexArtifactTemplates";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react";
import { type RefObject, useEffect } from "react";
import { isInSideChatPane } from "~/lib/sideChatPane";
import { newMessageId } from "~/lib/utils";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { m } from "../../i18n/messages";
import { subscribeSnapShotComposerFocus } from "../../lib/desktopSnapShot";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  isSameSidebarThreadRef,
  useSidebarPendingFileDropStore,
} from "../../sidebarPendingFileDropStore";
import { assetEnvironment } from "../../state/assets";
import { readEnvironmentScope, readPreparedConnection } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { DEFAULT_INTERACTION_MODE } from "../../types";
import {
  codexArtifactTemplatePromptToAppend,
  resolveFileAttachmentUrl,
  resolveThreadMetadataUpdateForNextTurn,
  shouldRefocusComposerOnWindowFocus,
} from "../ChatView.logic";
import { toastManager } from "../ui/toast";
import type { ChatComposerHandle } from "./ChatComposer";
import { openExpandedImagePreview } from "./ExpandedImageDialog";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

interface ChatViewCoreActionsInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly embedded: boolean;
  readonly isServerThread: boolean;
  readonly serverThread: EnvironmentThreadShell | null;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly activeThreadId: ThreadId | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly runtimeMode: RuntimeMode;
  readonly terminalOpen: boolean;
  readonly isMobileViewport: boolean;
  readonly isCoarsePointer: boolean;
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly focusComposerStable: () => void;
  readonly scheduleComposerFocusStable: () => void;
  readonly setThreadError: (threadId: ThreadId | null, error: string | null) => void;
}

export function useChatViewCoreActions(input: ChatViewCoreActionsInput) {
  const {
    environmentId,
    routeThreadKey,
    embedded,
    isServerThread,
    serverThread,
    activeThread,
    activeThreadId,
    activeThreadRef,
    composerDraftTarget,
    runtimeMode,
    terminalOpen,
    isMobileViewport,
    isCoarsePointer,
    composerRef,
    focusComposerStable,
    scheduleComposerFocusStable,
    setThreadError,
  } = input;
  const gt = useGT();
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setThreadRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useOrchestrationCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const createAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const interruptThreadTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });

  const downloadFileAttachment = async (attachment: ChatFileAttachment) => {
    const connection = readPreparedConnection(environmentId);
    if (!connection) {
      toastManager.add({ type: "error", title: gt("The environment is not connected.") });
      return;
    }

    try {
      const url = await resolveFileAttachmentUrl({
        attachment,
        environmentId,
        httpBaseUrl: connection.httpBaseUrl,
        createAssetUrl: createAttachmentAssetUrl,
      });
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.name;
      anchor.click();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: gt("Could not download {name}", { name: attachment.name }),
        description: thrownErrorMessage(error, m) ?? gt("The attachment is unavailable."),
      });
    }
  };
  const downloadFileAttachmentStable = useStableCallback(downloadFileAttachment);

  const openFileAttachment = (attachment: ChatFileAttachment) => {
    if (activeThreadRef) {
      useRightPanelStore.getState().openAttachment(activeThreadRef, attachment);
    }
  };
  const openFileAttachmentStable = useStableCallback(openFileAttachment);

  const onInterrupt = async () => {
    if (
      !activeThread ||
      !readEnvironmentScope(activeThread.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const result = await interruptThreadTurn({
      environmentId,
      input: { threadId: activeThread.id },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        thrownErrorMessage(error, m) ?? gt("Failed to interrupt the current turn."),
      );
    }
  };
  const onInterruptStable = useStableCallback(onInterrupt);

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- window listener for the desktop snapshot event that focuses the composer
  useEffect(
    () => (embedded ? undefined : subscribeSnapShotComposerFocus(focusComposerStable)),
    [embedded, focusComposerStable],
  );

  const insertArtifactTemplate = (template: CodexArtifactTemplate) => {
    const composer = composerRef.current;
    if (!composer) return;

    const currentDraft = composer.getSendContext().prompt;
    const prompt = codexArtifactTemplatePromptToAppend(currentDraft, template);
    if (prompt !== null && !composer.insertTextAtEnd(prompt, { ensureLeadingBoundary: true })) {
      toastManager.add({
        type: "error",
        title: gt("Unable to add to chat"),
        description: gt("The composer is busy; try again once it is ready."),
      });
      return;
    }
    scheduleComposerFocusStable();
  };
  const insertArtifactTemplateStable = useStableCallback(insertArtifactTemplate);

  const sendAppMessage = async (text: string) => {
    if (!isServerThread || activeThreadId === null) {
      throw new Error(gt("Messages from apps need a started thread."));
    }
    const result = await startThreadTurn({
      environmentId,
      input: {
        threadId: activeThreadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        runtimeMode,
        interactionMode: DEFAULT_INTERACTION_MODE,
        dispatchMode: "queue",
      },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      throw error instanceof Error ? error : new Error(gt("Could not send the app's message."));
    }
  };
  const sendAppMessageStable = useStableCallback(sendAppMessage);

  const persistThreadSettingsForNextTurn = async (next: {
    threadId: ThreadId;
    createdAt: string;
    branch?: string;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }): Promise<AtomCommandResult<void, unknown>> => {
    if (!serverThread) {
      return AsyncResult.success(undefined);
    }

    let result: AtomCommandResult<void, unknown> = AsyncResult.success(undefined);
    const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
      currentModelSelection: serverThread.modelSelection,
      currentBranch: serverThread.branch,
      ...(next.branch ? { nextBranch: next.branch } : {}),
    });
    if (metadataUpdate) {
      result = mapAtomCommandResult(
        await updateThreadMetadata({
          environmentId,
          input: {
            threadId: next.threadId,
            ...metadataUpdate,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        return result;
      }
    }

    if (next.runtimeMode !== serverThread.runtimeMode) {
      result = mapAtomCommandResult(
        await setThreadRuntimeMode({
          environmentId,
          input: {
            threadId: next.threadId,
            runtimeMode: next.runtimeMode,
            createdAt: next.createdAt,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        return result;
      }
    }

    if (next.interactionMode !== serverThread.interactionMode) {
      result = mapAtomCommandResult(
        await setThreadInteractionMode({
          environmentId,
          input: {
            threadId: next.threadId,
            interactionMode: next.interactionMode,
            createdAt: next.createdAt,
          },
        }),
        () => undefined,
      );
    }
    return result;
  };

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- window focus listener that refocuses the composer after the window regains focus on a fine pointer
  useEffect(() => {
    if (embedded || !activeThread?.id || terminalOpen || isMobileViewport || isCoarsePointer) {
      return;
    }
    let frame: number | null = null;
    const onWindowFocus = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      // Wait an extra frame after window focus so the composer treats focus as an expansion request.
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          frame = null;
          if (document.querySelector("[data-mcp-app-fullscreen]") !== null) return;
          if (
            !isInSideChatPane(document.activeElement) &&
            shouldRefocusComposerOnWindowFocus(document.activeElement, document.getSelection())
          ) {
            focusComposerStable();
          }
        });
      });
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [
    activeThread?.id,
    embedded,
    focusComposerStable,
    isCoarsePointer,
    isMobileViewport,
    terminalOpen,
  ]);

  const onExpandTimelineImage = (preview: ExpandedImagePreview) => {
    openExpandedImagePreview(routeThreadKey, preview);
  };
  const onExpandTimelineImageStable = useStableCallback(onExpandTimelineImage);

  const pendingSidebarFileDrops = useSidebarPendingFileDropStore((state) => state.pending);
  const consumePendingFileDrop = useSidebarPendingFileDropStore(
    (state) => state.consumePendingFileDrop,
  );
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- hands pending sidebar file drops to the composer's imperative API once it mounts
  useEffect(() => {
    if (pendingSidebarFileDrops.length === 0) return;
    if (
      typeof composerDraftTarget === "string" ||
      !pendingSidebarFileDrops.some((drop) =>
        isSameSidebarThreadRef(composerDraftTarget, drop.threadRef),
      )
    ) {
      return;
    }
    if (!activeThread) return;
    if (!composerRef.current) {
      const raf = window.requestAnimationFrame(() => {
        if (!composerRef.current || typeof composerDraftTarget === "string") return;
        const files = consumePendingFileDrop(composerDraftTarget);
        if (files !== null) composerRef.current?.addDroppedFiles(files);
      });
      return () => window.cancelAnimationFrame(raf);
    }
    const files = consumePendingFileDrop(composerDraftTarget);
    if (files !== null) composerRef.current.addDroppedFiles(files);
  }, [
    activeThread,
    composerDraftTarget,
    composerRef,
    consumePendingFileDrop,
    pendingSidebarFileDrops,
  ]);

  const addDroppedFilesToComposer = useStableCallback(
    (files: Parameters<ChatComposerHandle["addDroppedFiles"]>[0]) =>
      composerRef.current?.addDroppedFiles(files),
  );
  const addDroppedFoldersToComposer = useStableCallback(
    (folders: Parameters<ChatComposerHandle["addDroppedFolders"]>[0]) =>
      composerRef.current?.addDroppedFolders(folders),
  );

  return {
    downloadFileAttachmentStable,
    openFileAttachmentStable,
    onInterruptStable,
    insertArtifactTemplateStable,
    sendAppMessageStable,
    persistThreadSettingsForNextTurn,
    onExpandTimelineImageStable,
    addDroppedFilesToComposer,
    addDroppedFoldersToComposer,
  };
}
