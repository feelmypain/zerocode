import type {
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ServerProvider,
  ThreadId,
  UnifiedSettings,
} from "@zerocode/contracts";
import { useGT } from "gt-react";
import { PlayIcon } from "lucide-react";
import type { ComponentProps, MouseEvent, ReactNode, Ref } from "react";
import { cn } from "~/lib/utils";
import { composerRequiresModifier } from "../../composer-logic";
import type { ComposerImageAttachment } from "../../composerDraftStore";
import { shortcutLabelForCommand } from "../../keybindings";
import type { useEnvironmentSpeechInput } from "../../speech/useEnvironmentSpeechInput";
import type { SessionPhase } from "../../types";
import type { ComposerDraftContextRecords } from "../composerContextPresentation";
import { Spinner } from "../ui/spinner";
import { CollapsedComposerPromptPreview } from "./CollapsedComposerPromptPreview";
import { ComposerRestingImagePreviews } from "./ComposerAttachmentStrip";
import { ComposerFooterPrimaryActions } from "./ComposerFooterControls";
import { CollapsedComposerStopAction } from "./ComposerPrimaryActions";
import { ComposerSpeechButton, ComposerSpeechRecordingPill } from "./ComposerSpeechButton";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { VoiceInputSetup } from "./VoiceInputSetup";

export function ChatComposerCollapsedMobileRow(props: {
  readonly environmentId: EnvironmentId;
  readonly activeThreadId: ThreadId | null;
  readonly activeRunId: ComponentProps<typeof CollapsedComposerStopAction>["runId"];
  readonly prompt: string;
  readonly selectedProviderSkills: ServerProvider["skills"];
  readonly composerContextRecords: ComposerDraftContextRecords;
  readonly resolvedTheme: "light" | "dark";
  readonly showProviderUnavailable: boolean;
  readonly standaloneComposerImages: ReadonlyArray<ComposerImageAttachment>;
  readonly composerImages: ReadonlyArray<ComposerImageAttachment>;
  readonly canOperateThread: boolean;
  readonly canInterrupt: boolean;
  readonly hasMessageToSend: boolean;
  readonly isEditingQueuedMessage: boolean;
  readonly collapsedComposerPrimaryActionDisabled: boolean;
  readonly collapsedComposerPrimaryActionLabel: string;
  readonly composerSendHeld: boolean;
  readonly isSendBusy: boolean;
  readonly showResumeAction: boolean;
  readonly resumeCompactionTokens: number | null;
  readonly keepFullHistory: boolean;
  readonly onExpandMobileComposer: () => void;
  readonly onExpandImage: (preview: ExpandedImagePreview) => void;
  readonly onCopySnapshot: (imageId: string) => Promise<void>;
  readonly onInterrupt: () => void;
  readonly onResume: () => void;
  readonly onSubmit: () => void;
}) {
  const {
    environmentId,
    activeThreadId,
    activeRunId,
    prompt,
    selectedProviderSkills,
    composerContextRecords,
    resolvedTheme,
    showProviderUnavailable,
    standaloneComposerImages,
    composerImages,
    canOperateThread,
    canInterrupt,
    hasMessageToSend,
    isEditingQueuedMessage,
    collapsedComposerPrimaryActionDisabled,
    collapsedComposerPrimaryActionLabel,
    composerSendHeld,
    isSendBusy,
    showResumeAction,
    resumeCompactionTokens,
    keepFullHistory,
    onExpandMobileComposer,
    onExpandImage,
    onCopySnapshot,
    onInterrupt,
    onResume,
    onSubmit,
  } = props;
  const gt = useGT();

  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2">
      <button
        type="button"
        data-chat-composer-transition-prompt="true"
        className={cn(
          "min-w-0 flex-1 truncate bg-transparent p-0 text-left text-sm focus:outline-none",
          prompt.trim() ? "text-foreground" : "text-placeholder",
        )}
        onPointerDown={(event) => event.preventDefault()}
        onClick={onExpandMobileComposer}
        aria-label={gt("Expand composer")}
      >
        {prompt.trim() ? (
          <CollapsedComposerPromptPreview
            prompt={prompt}
            skills={selectedProviderSkills}
            contextRecords={composerContextRecords}
            theme={resolvedTheme}
          />
        ) : showProviderUnavailable ? (
          gt("Enable a provider in Settings")
        ) : (
          gt("Ask anything...")
        )}
      </button>
      {standaloneComposerImages.length > 0 ? (
        <ComposerRestingImagePreviews
          images={standaloneComposerImages}
          allImages={composerImages}
          resolvedTheme={resolvedTheme}
          onExpandImage={onExpandImage}
          onCopySnapshot={onCopySnapshot}
          onShowMore={onExpandMobileComposer}
        />
      ) : null}
      <CollapsedComposerStopAction
        key={`${environmentId}:${activeThreadId ?? "new"}`}
        canOperateThread={canOperateThread}
        canInterrupt={canInterrupt}
        runId={activeRunId}
        hasSendableContent={hasMessageToSend}
        isEditingQueuedMessage={isEditingQueuedMessage}
        onInterrupt={onInterrupt}
      >
        <button
          type="button"
          data-chat-composer-transition-actions="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-message-action text-message-action-foreground hover:bg-message-action-hover disabled:opacity-64"
          disabled={collapsedComposerPrimaryActionDisabled}
          aria-label={collapsedComposerPrimaryActionLabel}
          aria-busy={composerSendHeld || isSendBusy || undefined}
          onPointerDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            if (showResumeAction) onResume();
            else if (resumeCompactionTokens !== null && !keepFullHistory) onExpandMobileComposer();
            else onSubmit();
          }}
        >
          {composerSendHeld || isSendBusy ? (
            <Spinner size="sm" aria-hidden="true" />
          ) : showResumeAction ? (
            <PlayIcon className="size-4 fill-current" aria-hidden="true" />
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 3L8 13M8 3L4 7M8 3L12 7"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      </CollapsedComposerStopAction>
    </div>
  );
}

export function ChatComposerFooterBar(props: {
  readonly environmentId: EnvironmentId;
  readonly activeThreadId: ThreadId | null;
  readonly activeRunId: ComponentProps<typeof CollapsedComposerStopAction>["runId"];
  readonly routeKind: "server" | "draft";
  readonly prompt: string;
  readonly settings: UnifiedSettings;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly phase: SessionPhase;
  readonly draftRunsLocally: boolean;
  readonly isComposerCollapsedMobile: boolean;
  readonly isMobileViewport: boolean;
  readonly showMobilePendingAnswerActions: boolean;
  readonly hasPendingUserInputs: boolean;
  readonly dictationTakesFooter: boolean;
  readonly isComposerPrimaryActionsCompact: boolean;
  readonly composerAttachButton: ReactNode;
  readonly composerControls: ReactNode;
  readonly attachExpandedComposerControls: Ref<HTMLDivElement>;
  readonly showInlineRestingControls: boolean;
  readonly setInlineRestingControlsHost: Ref<HTMLDivElement>;
  readonly attachRestingComposerControls: Ref<HTMLDivElement>;
  readonly restingControlsVisible: boolean;
  readonly canOperateThread: boolean;
  readonly pendingPrimaryAction: ComponentProps<
    typeof ComposerFooterPrimaryActions
  >["pendingAction"];
  readonly canInterrupt: boolean;
  readonly followUpBehavior: "steer" | "queue";
  readonly canSteer: boolean;
  readonly voiceInputActive: boolean;
  readonly isSendBusy: boolean;
  readonly composerSendHeld: boolean;
  readonly primaryActionSendDisabledReason: string | null;
  readonly primaryActionEnvironmentUnavailable: boolean;
  readonly isPreparingWorktree: boolean;
  readonly hasMessageToSend: boolean;
  readonly showResumeAction: boolean;
  readonly isEditingQueuedMessage: boolean;
  readonly onSubmitMessage: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly onResume: () => void;
  readonly onPreviousPendingQuestion: () => void;
  readonly onInterrupt: () => void;
  readonly resumeCompactionTokens: number | null;
  readonly keepFullHistory: boolean;
  readonly onToggleKeepFullHistory: () => void;
  readonly speechInput: ReturnType<typeof useEnvironmentSpeechInput>;
  readonly dictationShortcutLabel: string | null;
  readonly dictationDisabled: boolean;
}) {
  const {
    environmentId,
    activeThreadId,
    activeRunId,
    routeKind,
    prompt,
    settings,
    keybindings,
    phase,
    draftRunsLocally,
    isComposerCollapsedMobile,
    isMobileViewport,
    showMobilePendingAnswerActions,
    hasPendingUserInputs,
    dictationTakesFooter,
    isComposerPrimaryActionsCompact,
    composerAttachButton,
    composerControls,
    attachExpandedComposerControls,
    showInlineRestingControls,
    setInlineRestingControlsHost,
    attachRestingComposerControls,
    restingControlsVisible,
    canOperateThread,
    pendingPrimaryAction,
    canInterrupt,
    followUpBehavior,
    canSteer,
    voiceInputActive,
    isSendBusy,
    composerSendHeld,
    primaryActionSendDisabledReason,
    primaryActionEnvironmentUnavailable,
    isPreparingWorktree,
    hasMessageToSend,
    showResumeAction,
    isEditingQueuedMessage,
    onSubmitMessage,
    onResume,
    onPreviousPendingQuestion,
    onInterrupt,
    resumeCompactionTokens,
    keepFullHistory,
    onToggleKeepFullHistory,
    speechInput,
    dictationShortcutLabel,
    dictationDisabled,
  } = props;
  const gt = useGT();

  return (
    <>
      {speechInput.preview ? (
        // column-reverse pins the scroll to the bottom; the single inner div keeps the text in normal order.
        <div
          aria-label={gt("Live transcription")}
          className="mx-3 mb-3 flex max-h-32 flex-col-reverse overflow-y-auto rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap sm:mx-4"
        >
          <div>
            <span>{speechInput.preview.committed}</span>
            <span className="text-muted-foreground">{speechInput.preview.tentative}</span>
          </div>
        </div>
      ) : null}

      {isComposerCollapsedMobile && speechInput.state.phase === "idle" ? null : (
        <div
          data-chat-composer-footer="true"
          className={cn(
            "flex min-w-0 flex-nowrap items-center overflow-visible px-2 pb-2",
            hasPendingUserInputs && "pt-2",
            showMobilePendingAnswerActions &&
              speechInput.state.phase === "idle" &&
              "hidden sm:flex",
          )}
        >
          {composerAttachButton && !dictationTakesFooter ? (
            <div className="me-2">{composerAttachButton}</div>
          ) : null}
          <div
            data-chat-composer-actions="right"
            data-chat-composer-transition-actions="true"
            data-chat-composer-primary-actions-compact={
              isComposerPrimaryActionsCompact ? "true" : "false"
            }
            className="flex min-w-0 flex-1 flex-nowrap items-center justify-end gap-2"
          >
            <div
              ref={attachExpandedComposerControls}
              data-chat-composer-controls="footer"
              data-chat-composer-footer-controls="true"
              className={cn(
                "relative flex min-w-0 flex-1 items-center justify-end gap-0.5",
                dictationTakesFooter && "hidden",
              )}
            >
              {composerControls}
            </div>
            <ComposerFooterPrimaryActions
              // Stop state belongs to one thread; the composer stays mounted across threads.
              key={`${environmentId}:${activeThreadId ?? "new"}`}
              compact={isComposerPrimaryActionsCompact}
              canOperateThread={canOperateThread}
              pendingAction={pendingPrimaryAction}
              isRunning={(phase === "running" || phase === "connecting") && !draftRunsLocally}
              canInterrupt={canInterrupt}
              runId={activeRunId}
              followUpBehavior={followUpBehavior}
              canSteer={canSteer}
              alternateShortcutLabel={shortcutLabelForCommand(
                keybindings,
                "composer.sendAlternate",
                {
                  context: {
                    composerFocus: true,
                    draftThreadRoute: routeKind === "draft",
                    turnRunning: true,
                    composerRequiresModifier: composerRequiresModifier(
                      settings.sendShortcut,
                      prompt,
                    ),
                  },
                },
              )}
              voiceInputActive={voiceInputActive}
              isSendBusy={isSendBusy}
              isSendHeld={composerSendHeld}
              sendDisabledReason={primaryActionSendDisabledReason}
              isEnvironmentUnavailable={primaryActionEnvironmentUnavailable}
              isPreparingWorktree={isPreparingWorktree}
              hasSendableContent={hasMessageToSend || voiceInputActive}
              canResume={showResumeAction}
              preserveComposerFocusOnPointerDown={isMobileViewport}
              isEditingQueuedMessage={isEditingQueuedMessage}
              onSubmitMessage={onSubmitMessage}
              onResume={onResume}
              onPreviousPendingQuestion={onPreviousPendingQuestion}
              onInterrupt={onInterrupt}
              compactBeforeSendTokens={resumeCompactionTokens}
              hideCompactToggle={dictationTakesFooter}
              keepFullHistory={keepFullHistory}
              onToggleKeepFullHistory={onToggleKeepFullHistory}
            >
              {speechInput.available ? (
                <>
                  <ComposerSpeechRecordingPill
                    state={speechInput.state}
                    progress={null}
                    finishShortcutLabel={dictationShortcutLabel}
                    cancelShortcutLabel="Esc"
                    level={speechInput.level}
                    recordingStartedAt={speechInput.recordingStartedAt}
                    disabled={dictationDisabled}
                    onStart={() => void speechInput.start()}
                    onStop={() => void speechInput.stop()}
                    onCancel={() => speechInput.cancel()}
                    onSkipPostProcessing={() => speechInput.skipPostProcessing()}
                  />
                  <ComposerSpeechButton
                    state={speechInput.state}
                    shortcutLabel={dictationShortcutLabel}
                    disabled={dictationDisabled}
                    onStart={() => void speechInput.start()}
                  />
                </>
              ) : null}
              <VoiceInputSetup
                environmentId={speechInput.transcriptionEnvironmentId}
                open={speechInput.setup.open}
                step={speechInput.setup.step}
                status={speechInput.status}
                model={speechInput.setup.model}
                language={speechInput.setup.language}
                downloading={speechInput.setup.downloading}
                error={speechInput.setup.error}
                onOpenChange={speechInput.setup.setOpen}
                onRetryCatalog={speechInput.setup.retryCatalog}
                onDownload={() => void speechInput.setup.download()}
                onCancelDownload={() => void speechInput.setup.cancelDownload()}
                onStartRecording={() => void speechInput.setup.startRecording()}
              />
            </ComposerFooterPrimaryActions>
          </div>
        </div>
      )}
      {showInlineRestingControls ? (
        <div className="h-8">
          <div ref={setInlineRestingControlsHost} className="absolute bottom-2 inset-x-4 min-w-0">
            <div
              ref={attachRestingComposerControls}
              data-chat-composer-resting-controls="true"
              aria-hidden={restingControlsVisible ? undefined : true}
              inert={restingControlsVisible ? undefined : true}
              className={cn(
                "relative flex w-max min-w-0 max-w-full items-center gap-1 text-muted-foreground/70 [&_button]:text-xs!",
                !restingControlsVisible && "invisible",
              )}
            >
              {composerControls}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
