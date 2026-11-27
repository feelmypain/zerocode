import type {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ResolvedKeybindingsConfig,
  ServerProvider,
  ThreadId,
  ThreadPullRequestLink,
} from "@zerocode/contracts";
import type { UnifiedSettings } from "@zerocode/contracts/settings";
import { useGT, useMessages } from "gt-react";
import type { ComponentProps, Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import { cn } from "~/lib/utils";
import type { ComposerTrigger } from "../../composer-logic";
import type { ComposerFileAttachment, DraftId } from "../../composerDraftStore";
import { DEFAULT_COMPOSER_PLACEHOLDER } from "../../composerPlaceholder";
import { shortcutLabelForCommand } from "../../keybindings";
import type { AppModelOption } from "../../modelSelection";
import type { PendingUserInputProgress } from "../../pendingUserInput";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { PendingApproval } from "../../session-logic";
import type { Thread } from "../../types";
import {
  ComposerContextActionsContext,
  type ComposerDraftContextRecords,
} from "../composerContextPresentation";
import {
  type ComposerPromptEditorHandle,
  ComposerPromptEditorTiptap as ComposerPromptEditor,
} from "../ComposerPromptEditorTiptap";
import { Kbd } from "../ui/kbd";
import type { ChatComposerProps } from "./chatComposerTypes";
import { ComposerFilePreviewDialog, ComposerQueuedAttachmentRow } from "./ComposerAttachmentStrip";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import {
  ComposerCommandMenuController,
  type ComposerCommandMenuControllerHandle,
} from "./ComposerCommandMenuController";
import { ComposerCommandMenuLayer } from "./ComposerCommandMenuLayer";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerPromptLengthValidation } from "./ComposerPromptLengthValidation";
import { ComposerStashMenu } from "./ComposerStashMenu";
import { promptSuggestionToAccept } from "./usePromptSuggestion";

interface ChatComposerBodyProps {
  readonly environmentId: EnvironmentId;
  readonly linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  readonly gitCwd: string | null;
  readonly activeThreadId: ThreadId | null;
  readonly activeThread: Thread | undefined;
  readonly composerDraftTargetKey: string;
  readonly composerSessionKey: string;
  readonly composerSuggestionListId: string;
  readonly isComposerCollapsedMobile: boolean;
  readonly isStashMenuOpen: boolean;
  readonly setIsStashMenuOpen: Dispatch<SetStateAction<boolean>>;
  readonly composerMenuOpen: boolean;
  readonly composerMenuAnchor: HTMLDivElement | null;
  readonly setComposerMenuAnchor: Dispatch<SetStateAction<HTMLDivElement | null>>;
  readonly observeWrappedPrompt: (node: HTMLDivElement | null) => (() => void) | void;
  readonly composerFormRef: RefObject<HTMLFormElement | null>;
  readonly stashQueue: ComponentProps<typeof ComposerStashMenu>["entries"];
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly terminalOpen: boolean;
  readonly restoreStashEntryStable: ComponentProps<typeof ComposerStashMenu>["onRestore"];
  readonly deleteStashEntryStable: ComponentProps<typeof ComposerStashMenu>["onDelete"];
  readonly composerTrigger: ComposerTrigger | null;
  readonly composerMenuControllerRef: RefObject<ComposerCommandMenuControllerHandle | null>;
  readonly resolvedTheme: "light" | "dark";
  readonly pullRequestProjectId: ProjectId | null;
  readonly pullRequestRepository: string | null;
  readonly threadPullRequests: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly sideChatAvailable: boolean;
  readonly sideChatDisabledReason: string | null;
  readonly freshSessionAvailable: boolean;
  readonly compactSlashCommandAvailable: boolean;
  readonly selectedProvider: ProviderDriverKind;
  readonly selectedProviderSkills: ServerProvider["skills"];
  readonly selectedProviderSlashCommands: ServerProvider["slashCommands"];
  readonly settings: UnifiedSettings;
  readonly workspaceSkillsScanning: boolean;
  readonly questionAttachmentTarget: DraftId | null;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  readonly composerMenuItemsRef: RefObject<ComposerCommandItem[]>;
  readonly activeComposerMenuItemRef: RefObject<ComposerCommandItem | null>;
  readonly onSelectComposerItemStable: (item: ComposerCommandItem) => void;
  readonly activeSuggestionId: string | undefined;
  readonly setActiveSuggestionId: Dispatch<SetStateAction<string | undefined>>;
  readonly activeEditingQueuedAttachments: ChatComposerProps["editingQueuedAttachments"];
  readonly onRemoveEditingQueuedAttachment: (attachmentId: string) => void;
  readonly composerAttachmentMediaRow: ReactNode;
  readonly composerAttachmentFileList: ReactNode;
  readonly composerSendHeld: boolean;
  readonly previewFile: ComposerFileAttachment | undefined;
  readonly removeComposerFileFromDraft: (fileId: string) => void;
  readonly setPreviewFileId: Dispatch<SetStateAction<string | null>>;
  readonly composerContextActions: ComponentProps<typeof ComposerContextActionsContext>["value"];
  readonly composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly isLiteralPendingAnswer: boolean;
  readonly isPathQueryActiveStable: () => boolean;
  readonly activePendingProgress: PendingUserInputProgress | null;
  readonly prompt: string;
  readonly composerCursor: number;
  readonly composerContextRecords: ComposerDraftContextRecords;
  readonly buildContextClipboardFragmentStable: (
    contextIds: ReadonlyArray<string>,
  ) => string | null;
  readonly importContextFragmentStable: ComponentProps<
    typeof ComposerPromptEditor
  >["importContextFragment"];
  readonly showMobilePendingAnswerActions: boolean;
  readonly onPromptChangeStable: ComponentProps<typeof ComposerPromptEditor>["onChange"];
  readonly onComposerCommandKeyStable: NonNullable<
    ComponentProps<typeof ComposerPromptEditor>["onCommandKeyDown"]
  >;
  readonly onPageScrollKeyDown: (key: "PageUp" | "PageDown") => void;
  readonly onPageScrollKeyUp: (key: string) => void;
  readonly onPageScrollRelease: () => void;
  readonly submitCitationAndSendStable: () => boolean;
  readonly saveCitationDraftToPromptStable: (replacedValue: string, savedValue: string) => void;
  readonly onComposerPasteStable: ComponentProps<typeof ComposerPromptEditor>["onPaste"];
  readonly isComposerApprovalState: boolean;
  readonly activePendingApproval: PendingApproval | null;
  readonly isChoiceOnlyPendingQuestion: boolean;
  readonly projectSelectionRequired: boolean;
  readonly showProviderUnavailable: boolean;
  readonly offeredPromptSuggestion: string | null;
  readonly promptRef: RefObject<string>;
  readonly applyPromptReplacementStable: (
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
  ) => boolean;
  readonly activePendingIsResponding: boolean;
  readonly speechFreezesEditor: boolean;
  readonly canOperateThread: boolean;
  readonly pendingPrimaryAction: ComponentProps<typeof ComposerPrimaryActions>["pendingAction"];
  readonly isSendBusy: boolean;
  readonly primaryActionSendDisabledReason: string | null;
  readonly primaryActionEnvironmentUnavailable: boolean;
  readonly onPreviousActivePendingUserInputQuestion: () => void;
  readonly handleInterruptPrimaryActionStable: () => void;
  readonly validationMessage: string | null;
}

export function ChatComposerBody(props: ChatComposerBodyProps) {
  const {
    environmentId,
    linkedEnvironments,
    gitCwd,
    activeThreadId,
    activeThread,
    composerDraftTargetKey,
    composerSessionKey,
    composerSuggestionListId,
    isComposerCollapsedMobile,
    isStashMenuOpen,
    setIsStashMenuOpen,
    composerMenuOpen,
    composerMenuAnchor,
    setComposerMenuAnchor,
    observeWrappedPrompt,
    composerFormRef,
    stashQueue,
    keybindings,
    terminalOpen,
    restoreStashEntryStable,
    deleteStashEntryStable,
    composerTrigger,
    composerMenuControllerRef,
    resolvedTheme,
    pullRequestProjectId,
    pullRequestRepository,
    threadPullRequests,
    sideChatAvailable,
    sideChatDisabledReason,
    freshSessionAvailable,
    compactSlashCommandAvailable,
    selectedProvider,
    selectedProviderSkills,
    selectedProviderSlashCommands,
    settings,
    workspaceSkillsScanning,
    questionAttachmentTarget,
    providerInstanceEntries,
    modelOptionsByInstance,
    composerMenuItemsRef,
    activeComposerMenuItemRef,
    onSelectComposerItemStable,
    activeSuggestionId,
    setActiveSuggestionId,
    activeEditingQueuedAttachments,
    onRemoveEditingQueuedAttachment,
    composerAttachmentMediaRow,
    composerAttachmentFileList,
    composerSendHeld,
    previewFile,
    removeComposerFileFromDraft,
    setPreviewFileId,
    composerContextActions,
    composerEditorRef,
    isLiteralPendingAnswer,
    isPathQueryActiveStable,
    activePendingProgress,
    prompt,
    composerCursor,
    composerContextRecords,
    buildContextClipboardFragmentStable,
    importContextFragmentStable,
    showMobilePendingAnswerActions,
    onPromptChangeStable,
    onComposerCommandKeyStable,
    onPageScrollKeyDown,
    onPageScrollKeyUp,
    onPageScrollRelease,
    submitCitationAndSendStable,
    saveCitationDraftToPromptStable,
    onComposerPasteStable,
    isComposerApprovalState,
    activePendingApproval,
    isChoiceOnlyPendingQuestion,
    projectSelectionRequired,
    showProviderUnavailable,
    offeredPromptSuggestion,
    promptRef,
    applyPromptReplacementStable,
    activePendingIsResponding,
    speechFreezesEditor,
    canOperateThread,
    pendingPrimaryAction,
    isSendBusy,
    primaryActionSendDisabledReason,
    primaryActionEnvironmentUnavailable,
    onPreviousActivePendingUserInputQuestion,
    handleInterruptPrimaryActionStable,
    validationMessage,
  } = props;
  const gt = useGT();
  const m = useMessages();

  return (
    <>
      <div
        ref={(node) => {
          setComposerMenuAnchor(node);
          const stopObserving = observeWrappedPrompt(node);
          return () => {
            setComposerMenuAnchor(null);
            stopObserving?.();
          };
        }}
        data-chat-composer-body="true"
        className={cn(
          "relative px-4 pb-2",
          "pt-3.5 sm:pt-4",
          isComposerCollapsedMobile && "hidden",
        )}
      >
        {isStashMenuOpen && !composerMenuOpen && (
          <ComposerCommandMenuLayer anchor={composerMenuAnchor} canOverflowTop>
            <ComposerStashMenu
              composerFormRef={composerFormRef}
              entries={stashQueue}
              stashShortcutLabel={shortcutLabelForCommand(keybindings, "composer.stash", {
                context: {
                  terminalFocus: false,
                  terminalOpen,
                  modelPickerOpen: false,
                },
              })}
              onRestore={restoreStashEntryStable}
              onDelete={deleteStashEntryStable}
              onClose={() => setIsStashMenuOpen(false)}
            />
          </ComposerCommandMenuLayer>
        )}

        {composerTrigger !== null ? (
          <ComposerCommandMenuController
            key={composerSessionKey}
            controllerRef={composerMenuControllerRef}
            composerTrigger={composerTrigger}
            suggestionListId={composerSuggestionListId}
            anchor={composerMenuAnchor}
            resolvedTheme={resolvedTheme}
            environmentId={environmentId}
            linkedEnvironments={linkedEnvironments}
            gitCwd={gitCwd}
            activeThreadId={activeThreadId}
            pullRequestProjectId={pullRequestProjectId}
            pullRequestRepository={pullRequestRepository}
            threadPullRequests={threadPullRequests}
            sideChatAvailable={sideChatAvailable}
            sideChatDisabledReason={sideChatDisabledReason}
            freshSessionAvailable={freshSessionAvailable}
            compactSlashCommandAvailable={compactSlashCommandAvailable}
            selectedProvider={selectedProvider}
            selectedProviderSkills={selectedProviderSkills}
            selectedProviderSlashCommands={selectedProviderSlashCommands}
            showSkillsInSlashMenu={settings.showSkillsInSlashMenu}
            workspaceSkillsScanning={workspaceSkillsScanning}
            questionAttachmentTarget={questionAttachmentTarget}
            modelMentions={{
              instanceEntries: providerInstanceEntries,
              modelOptionsByInstance,
            }}
            menuItemsRef={composerMenuItemsRef}
            activeMenuItemRef={activeComposerMenuItemRef}
            onSelect={onSelectComposerItemStable}
            onActiveSuggestionIdChange={setActiveSuggestionId}
          />
        ) : null}

        {!isComposerCollapsedMobile &&
          activeEditingQueuedAttachments !== null &&
          activeEditingQueuedAttachments.length > 0 && (
            <ComposerQueuedAttachmentRow
              attachments={activeEditingQueuedAttachments}
              onRemove={onRemoveEditingQueuedAttachment}
            />
          )}

        {composerAttachmentMediaRow}

        {composerAttachmentFileList}

        <div
          className={cn(
            "relative transition-opacity duration-150",
            composerSendHeld && "opacity-65",
          )}
        >
          {previewFile ? (
            <ComposerFilePreviewDialog
              file={previewFile}
              onRemove={removeComposerFileFromDraft}
              onPreviewFileIdChange={setPreviewFileId}
            />
          ) : null}
          <ComposerContextActionsContext value={composerContextActions}>
            <ComposerPromptEditor
              draftKey={composerDraftTargetKey}
              // Switching threads lands focus here, so the label names the thread.
              ariaLabel={
                activeThread
                  ? gt("Message {title}", { title: activeThread.title })
                  : gt("Message", { $context: "noun, label of the message input" })
              }
              suggestionListId={composerSuggestionListId}
              activeSuggestionId={composerMenuOpen ? activeSuggestionId : undefined}
              editorRef={composerEditorRef}
              richTextEnabled={settings.composerRichTextEnabled}
              literalText={isLiteralPendingAnswer}
              isPathQueryActive={isPathQueryActiveStable}
              value={activePendingProgress ? activePendingProgress.customAnswer : prompt}
              cursor={composerCursor}
              contextRecords={composerContextRecords}
              buildContextClipboardFragment={buildContextClipboardFragmentStable}
              importContextFragment={importContextFragmentStable}
              skills={selectedProviderSkills}
              className={cn(showMobilePendingAnswerActions && "max-sm:pb-12")}
              onChange={onPromptChangeStable}
              onCommandKeyDown={onComposerCommandKeyStable}
              onPageScrollKeyDown={onPageScrollKeyDown}
              onPageScrollKeyUp={onPageScrollKeyUp}
              onPageScrollRelease={onPageScrollRelease}
              onCitationSubmitAndSend={submitCitationAndSendStable}
              onCitationDraftSave={saveCitationDraftToPromptStable}
              onPaste={onComposerPasteStable}
              placeholder={
                isComposerApprovalState
                  ? activePendingApproval?.supportsFeedback
                    ? gt("Send feedback to decline this request")
                    : gt("Send a message to decline and redirect the agent")
                  : activePendingProgress
                    ? isChoiceOnlyPendingQuestion
                      ? gt("Choose an option above")
                      : activePendingProgress.activeQuestion?.options.length === 0
                        ? gt("Type your answer")
                        : gt("Type your own answer, or leave this blank to use the selected option")
                    : projectSelectionRequired
                      ? gt("Choose a project above to start a thread")
                      : showProviderUnavailable
                        ? gt("Enable a provider in Settings to send a message")
                        : (offeredPromptSuggestion ?? m(DEFAULT_COMPOSER_PLACEHOLDER))
              }
              placeholderSuffix={
                offeredPromptSuggestion !== null ? (
                  // The placeholder ignores pointer events so clicks reach the editor; only this hint opts back in.
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={gt("Use suggested prompt")}
                    className="pointer-events-auto ml-2 inline-flex cursor-pointer rounded align-[1px] [&:hover_kbd]:text-foreground"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => {
                      const accepted = promptSuggestionToAccept(
                        offeredPromptSuggestion,
                        promptRef.current,
                      );
                      if (accepted !== null) applyPromptReplacementStable(0, 0, accepted);
                    }}
                  >
                    <Kbd variant="outline">⇥ Tab</Kbd>
                  </button>
                ) : undefined
              }
              disabled={
                projectSelectionRequired ||
                isChoiceOnlyPendingQuestion ||
                activePendingIsResponding ||
                speechFreezesEditor
              }
            />
          </ComposerContextActionsContext>
          {showMobilePendingAnswerActions ? (
            <div
              data-chat-composer-mobile-pending-actions="true"
              className="absolute bottom-0 right-0 flex items-center justify-end gap-1"
            >
              <ComposerPrimaryActions
                compact
                canOperateThread={canOperateThread}
                pendingAction={pendingPrimaryAction}
                isRunning={false}
                canInterrupt={false}
                isSendBusy={isSendBusy}
                sendDisabledReason={primaryActionSendDisabledReason}
                isEnvironmentUnavailable={primaryActionEnvironmentUnavailable}
                isPreparingWorktree={false}
                hasSendableContent={false}
                preserveComposerFocusOnPointerDown
                onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                onInterrupt={handleInterruptPrimaryActionStable}
              />
            </div>
          ) : null}
        </div>
      </div>

      <ComposerPromptLengthValidation message={validationMessage} />
    </>
  );
}
