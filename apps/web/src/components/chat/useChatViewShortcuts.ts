import type { EnvironmentServerConfig } from "@zerocode/client-runtime/connection";
import type {
  EditorId,
  EnvironmentId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
  UnifiedSettings,
} from "@zerocode/contracts";
import { type RefObject, useEffect } from "react";
import { isInSideChatPane } from "~/lib/sideChatPane";
import { projectScriptIdFromCommand } from "~/projectScripts";
import { composerRequiresModifier } from "../../composer-logic";
import { isElectron } from "../../env";
import { useStableCallback } from "../../hooks/useStableCallback";
import { isEditableFocused } from "../../lib/editableFocus";
import { isPreviewFocused } from "../../lib/previewFocus";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import type { RightPanelSurface } from "../../rightPanelStore";
import type { PendingUserInput } from "../../session-logic";
import type { SessionPhase } from "../../types";
import type { BranchToolbarHandle } from "../BranchToolbar";
import type { ChatComposerHandle } from "./ChatComposer";
import { useOpenFavoriteEditorShortcut } from "./OpenInPickerShortcut";
import type { QueuedRunsControlHandle } from "./QueuedRunsControl";
import { closeThreadFind, openThreadFind } from "./threadFindStore";
import { type ChatShortcutCommands, useChatShortcuts } from "./useChatShortcuts";
import { usePasteToFocusComposer } from "./usePasteToFocusComposer";

interface ChatViewShortcutsInput {
  readonly environmentId: EnvironmentId;
  readonly routeKind: "server" | "draft";
  readonly activeThreadId: ThreadId | null;
  readonly activeThreadKey: string | null;
  readonly isServerThread: boolean;
  readonly backgroundThread: boolean;
  readonly embedded: boolean;
  readonly terminalOpen: boolean;
  readonly previewPanelOpen: boolean;
  readonly rightPanelOpen: boolean;
  readonly isThreadFindActive: boolean;
  readonly phase: SessionPhase;
  readonly isEditingQueuedRun: boolean;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly composerHasNonPromptContent: boolean;
  readonly settings: UnifiedSettings;
  readonly serverConfig: EnvironmentServerConfig | null;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly scriptKeybindings: ResolvedKeybindingsConfig;
  readonly showOpenInPicker: boolean;
  readonly openInEnvironmentId: EnvironmentId;
  readonly availableEditors: ReadonlyArray<EditorId>;
  readonly gitCwd: string | null;
  readonly canChangeEnvironment: boolean;
  readonly logicalProjectEnvironments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>;
  readonly readPendingEnvironmentChange: () => { readonly environmentId: EnvironmentId } | null;
  readonly onEnvironmentChangeStable: (environmentId: EnvironmentId) => void;
  readonly canInterruptRunningThread: boolean;
  readonly onInterruptStable: () => Promise<void>;
  readonly copyActiveThreadReference: () => void;
  readonly hasActiveProject: boolean;
  readonly canOperateTerminal: boolean;
  readonly activeProjectScripts: ReadonlyArray<ProjectScript>;
  readonly runProjectScriptStable: (script: ProjectScript) => Promise<void>;
  readonly activeRightPanelSurface: RightPanelSurface | null;
  readonly closeRightPanelSurface: (surface: RightPanelSurface) => void;
  readonly toggleRightPanelStable: () => void;
  readonly toggleRightPanelMaximizedStable: () => void;
  readonly focusComposerStable: () => void;
  readonly composerOverlayElement: HTMLDivElement | null;
  readonly promptRef: RefObject<string>;
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly branchToolbarRef: RefObject<BranchToolbarHandle | null>;
  readonly queuedRunsControlRef: RefObject<QueuedRunsControlHandle | null>;
  readonly terminalShortcuts: ChatShortcutCommands;
  readonly rightPanelShortcuts: ChatShortcutCommands;
  readonly threadLifecycleShortcuts: ChatShortcutCommands;
}

export function useChatViewShortcuts(input: ChatViewShortcutsInput) {
  const {
    environmentId,
    routeKind,
    activeThreadId,
    activeThreadKey,
    isServerThread,
    backgroundThread,
    embedded,
    terminalOpen,
    previewPanelOpen,
    rightPanelOpen,
    isThreadFindActive,
    phase,
    isEditingQueuedRun,
    pendingUserInputs,
    composerHasNonPromptContent,
    settings,
    serverConfig,
    keybindings,
    scriptKeybindings,
    showOpenInPicker,
    openInEnvironmentId,
    availableEditors,
    gitCwd,
    canChangeEnvironment,
    logicalProjectEnvironments,
    readPendingEnvironmentChange,
    onEnvironmentChangeStable,
    canInterruptRunningThread,
    onInterruptStable,
    copyActiveThreadReference,
    hasActiveProject,
    canOperateTerminal,
    activeProjectScripts,
    runProjectScriptStable,
    activeRightPanelSurface,
    closeRightPanelSurface,
    toggleRightPanelStable,
    toggleRightPanelMaximizedStable,
    focusComposerStable,
    composerOverlayElement,
    promptRef,
    composerRef,
    branchToolbarRef,
    queuedRunsControlRef,
    terminalShortcuts,
    rightPanelShortcuts,
    threadLifecycleShortcuts,
  } = input;

  useOpenFavoriteEditorShortcut({
    enabled: showOpenInPicker && !backgroundThread,
    environmentId: openInEnvironmentId,
    keybindings,
    availableEditors,
    openInCwd: gitCwd,
  });

  const getShortcutContext = (eventTarget: EventTarget | null = document.activeElement) => ({
    terminalFocus: getTerminalFocusOwner() !== null,
    terminalOpen,
    previewFocus: isPreviewFocused(),
    previewOpen: previewPanelOpen,
    rightPanelOpen,
    editableFocus: isEditableFocused(eventTarget),
    modelPickerOpen: composerRef.current?.isModelPickerOpen() ?? false,
    composerFocus:
      document.activeElement?.getAttribute("data-testid") === "composer-editor" &&
      isInSideChatPane(document.activeElement) === embedded,
    draftThreadRoute: routeKind === "draft",
    turnRunning: phase === "running" || phase === "connecting",
    // A queued-message edit or a question's answer owns the composer even when its text is empty.
    composerEmpty:
      !isEditingQueuedRun &&
      pendingUserInputs.length === 0 &&
      !composerHasNonPromptContent &&
      promptRef.current.trim().length === 0,
    composerRequiresModifier: composerRequiresModifier(settings.sendShortcut, promptRef.current),
    isWeb: !isElectron,
    isDesktop: isElectron,
  });
  const getShortcutContextStable = useStableCallback(getShortcutContext);

  useChatShortcuts({
    enabled: activeThreadId !== null && !backgroundThread,
    embedded,
    composerElement: composerOverlayElement,
    keybindings,
    scriptKeybindings,
    getShortcutContext,
    threadFindActive: isThreadFindActive,
    composerRef,
    branchToolbarRef,
    closeThreadFind: () => {
      closeThreadFind();
      focusComposerStable();
    },
    commands: {
      ...terminalShortcuts,
      ...rightPanelShortcuts,
      ...threadLifecycleShortcuts,
      "thread.copyReference": ({ event }) => {
        if (!event.repeat) copyActiveThreadReference();
      },
      "chat.find": () => {
        if (!isServerThread || serverConfig?.threadFind !== true || activeThreadKey === null)
          return false;
        openThreadFind(activeThreadKey);
      },
      "composer.cycleHost": ({ event }) => {
        if (!canChangeEnvironment) return false;
        if (event.repeat) return;
        const currentId = readPendingEnvironmentChange()?.environmentId ?? environmentId;
        const index = logicalProjectEnvironments.findIndex(
          (env) => env.environmentId === currentId,
        );
        const next = logicalProjectEnvironments[(index + 1) % logicalProjectEnvironments.length];
        if (next) onEnvironmentChangeStable(next.environmentId);
      },
      "thread.steerQueuedMessage": ({ event }) =>
        routeKind !== "draft" && queuedRunsControlRef.current?.steerNext(event.repeat) === true,
      "thread.editQueuedMessage": ({ event }) =>
        routeKind !== "draft" &&
        composerRef.current?.isCaretAtStart() === true &&
        queuedRunsControlRef.current?.editLatest(event.repeat) === true,
      "thread.stop": ({ event }) => {
        if (!canInterruptRunningThread) return false;
        if (!event.repeat) void onInterruptStable();
      },
    },
    fallback: (command) => {
      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !hasActiveProject || !canOperateTerminal) return undefined;
      const script = activeProjectScripts.find((entry) => entry.id === scriptId);
      return script ? () => void runProjectScriptStable(script) : undefined;
    },
  });

  const closeActiveRightPanelSurfaceStable = useStableCallback(() => {
    if (activeRightPanelSurface) closeRightPanelSurface(activeRightPanelSurface);
  });

  // A focused desktop browser page forwards these chords as menu actions.
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- subscribes to desktop bridge menu actions that toggle or close the right panel
  useEffect(() => {
    if (embedded || backgroundThread) return;
    return window.desktopBridge?.onMenuAction((action) => {
      if (action === "rightPanel.toggle") toggleRightPanelStable();
      else if (action === "rightPanel.toggleMaximized") toggleRightPanelMaximizedStable();
      else if (action === "rightPanel.close") closeActiveRightPanelSurfaceStable();
    });
  }, [
    embedded,
    backgroundThread,
    toggleRightPanelStable,
    toggleRightPanelMaximizedStable,
    closeActiveRightPanelSurfaceStable,
  ]);

  usePasteToFocusComposer(embedded ? null : activeThreadId, composerRef);

  return { getShortcutContextStable };
}
