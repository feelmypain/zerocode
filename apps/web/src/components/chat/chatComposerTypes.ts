import type { EnvironmentConnectionPresentation } from "@zerocode/client-runtime/connection";
import type { ComposerDispatchMode } from "@zerocode/client-runtime/state/composer-dispatch";
import type {
  AssistantCitation,
  ChatAttachment as ContractChatAttachment,
  ChatFileAttachment,
  ComposerContextId,
  EnvironmentContextRecord,
  EnvironmentId,
  KeybindingCommand,
  ModelSelection,
  OrchestrationV2Run,
  PreviewAnnotationPayload,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ResolvedKeybindingsConfig,
  ResponseContextRecord,
  RuntimeMode,
  RuntimeRequestId,
  ScopedThreadRef,
  ServerProvider,
  ThreadContextRecord,
  ThreadId,
  ThreadPullRequestLink,
} from "@zerocode/contracts";
import type { UnifiedSettings } from "@zerocode/contracts/settings";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import type { ComposerSubmissionIntent } from "../../composer-logic";
import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
  DraftId,
} from "../../composerDraftStore";
import type { ShortcutMatchContext } from "../../keybindings";
import type { TerminalContextDraft, TerminalContextSelection } from "../../lib/terminalContext";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import type { PendingApproval, PendingUserInput, TimelineEntry } from "../../session-logic";
import type { SessionPhase, Thread } from "../../types";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import type { QueuedAttachmentContextBinding } from "./composerContextUndo";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

export interface ChatComposerHandle {
  focusAtEnd: () => void;
  focusAt: (cursor: number) => void;
  addDroppedFiles: (files: File[]) => void;
  addDroppedFolders: (folders: File[]) => void;
  hasPendingAttachments: () => boolean;
  insertTextAtEnd: (
    text: string,
    options?: { ensureLeadingBoundary?: boolean; clipboardData?: DataTransfer },
  ) => boolean;
  pasteTextAtEnd: (text: string, options?: { bypassAutoAttachment?: boolean }) => boolean;
  citeAssistantText: (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => boolean;
  replyToResponse: (response: ResponseContextRecord) => boolean;
  openModelPicker: () => void;
  stepReasoningEffort: (direction: 1 | -1) => void;
  toggleModelPicker: () => void;
  openControl: (command: KeybindingCommand) => void;
  isModelPickerOpen: () => boolean;
  isCaretAtStart: () => boolean;
  compactContext: () => void;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  };
  resetCursorState: (options?: {
    cursor?: number;
    prompt?: string;
    detectTrigger?: boolean;
  }) => void;
  addTerminalContext: (selection: TerminalContextSelection) => void;
  getSendContext: () => {
    answeringPendingUserInput: boolean;
    prompt: string;
    images: ComposerImageAttachment[];
    files: ComposerFileAttachment[];
    terminalContexts: TerminalContextDraft[];
    previewAnnotations: PreviewAnnotationPayload[];
    reviewComments: ReviewCommentContext[];
    threadContexts: ThreadContextRecord[];
    environmentContexts: EnvironmentContextRecord[];
    selectedPromptEffort: string | null;
    selectedModelSelection: ModelSelection;
    multipleModelSelections: ReadonlyArray<ModelSelection> | null;
    providerAvailable: boolean;
    selectedProvider: ProviderDriverKind;
    selectedModel: string;
    selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
    shownPendingApprovalIds: ReadonlyArray<RuntimeRequestId>;
  };
  validateProviderInput: (providerInput: string) => boolean;
  setMultipleModelSelections: (selections: ReadonlyArray<ModelSelection>) => void;
}

export interface ChatComposerProps {
  composerDraftTarget: ScopedThreadRef | DraftId;
  environmentId: EnvironmentId;
  canOperateThread: boolean;
  attachmentUploadsCapabilityKnown: boolean;
  supportsAttachmentUploads: boolean;
  supportsQuestionAttachments: boolean;
  maxFileAttachmentBytes: number | null;
  routeKind: "server" | "draft";
  routeThreadRef: ScopedThreadRef;
  draftId: DraftId | null;
  multipleModelSelections: ReadonlyArray<ModelSelection> | null;
  supportsMultipleModels: boolean;
  onMultipleModelSelectionsChange: React.Dispatch<
    React.SetStateAction<ReadonlyArray<ModelSelection> | null>
  >;

  activeThreadId: ThreadId | null;
  activeThread: Thread | undefined;
  activeThreadRuns: ReadonlyArray<OrchestrationV2Run>;
  promptHistoryEntries: ReadonlyArray<TimelineEntry>;
  forceExpandedOnMobile: boolean;
  projectSelectionRequired: boolean;

  phase: SessionPhase;
  canInterrupt: boolean;
  isSendBusy: boolean;
  canResume: boolean;
  isRevertingCheckpoint?: boolean;
  sendDisabledReason: string | null;
  isPreparingWorktree: boolean;
  canSteer: boolean;
  bannerItems: readonly ComposerBannerStackItem[];
  resumeCompactionTokens: number | null;
  keepFullHistory: boolean;
  onToggleKeepFullHistory: () => void;
  onUsageLimitsCommand?: (() => void) | undefined;
  sideChatAvailable?: boolean;
  sideChatDisabledReason?: string | null;
  /** Arms a fresh session for the next message; absent where `/clear` is unavailable. */
  onFreshSession?: (() => void) | undefined;
  /** Toggles ephemeral mode on drafts, promotes ephemeral server chats, or opens a fresh ephemeral draft. */
  onToggleEphemeral?: (() => void) | undefined;
  environmentUnavailable: {
    readonly label: string;
    readonly connection: EnvironmentConnectionPresentation;
  } | null;

  activePendingApproval: PendingApproval | null;
  pendingApprovals: PendingApproval[];
  onHeldRequestIdsChange: (requestIds: ReadonlySet<string>) => void;
  pendingUserInputs: PendingUserInput[];
  activePendingIsResponding: boolean;
  respondingRequestIds: RuntimeRequestId[];

  runtimeMode: RuntimeMode;
  defaultRuntimeMode?: RuntimeMode;

  lockedProvider: ProviderDriverKind | null;
  providerStatuses: ServerProvider[];
  providerCatalogKnown: boolean;
  activeProjectDefaultModelSelection: ModelSelection | null | undefined;
  activeThreadModelSelection: ModelSelection | null | undefined;
  reportedModelSelection?: ModelSelection | null;
  activeProjectId: ProjectId | null;
  projectName?: string | undefined;

  compactThreadUnavailable: boolean;
  compactDisabled: boolean;

  resolvedTheme: "light" | "dark";
  settings: UnifiedSettings;
  keybindings: ResolvedKeybindingsConfig;
  getShortcutContext: (eventTarget: EventTarget | null) => ShortcutMatchContext;
  terminalOpen: boolean;
  gitCwd: string | null;
  pullRequestProjectId: ProjectId | null;
  pullRequestRepository: string | null;
  threadPullRequests: ReadonlyArray<ThreadPullRequestLink> | undefined;
  onComposerOverlayHeightChange: (height: number) => void;
  /** The new-thread strip names the permissions, so the controls row hides its chip. */
  permissionsShownInStrip: boolean;

  promptRef: React.RefObject<string>;
  composerImagesRef: React.RefObject<ComposerImageAttachment[]>;
  composerFilesRef: React.RefObject<ComposerFileAttachment[]>;
  composerTerminalContextsRef: React.RefObject<TerminalContextDraft[]>;
  composerRef: React.RefObject<ChatComposerHandle | null>;
  onPageScrollKeyDown: (key: "PageUp" | "PageDown") => void;
  onPageScrollKeyUp: (key: string) => void;
  onPageScrollRelease: () => void;

  editingQueuedAttachments: ReadonlyArray<{
    readonly attachment: ContractChatAttachment;
    readonly url: string | null;
    readonly contextIds?: ReadonlyArray<ComposerContextId> | undefined;
  }> | null;
  removedEditingQueuedAttachments?: ReadonlyArray<QueuedAttachmentContextBinding> | undefined;
  onRemoveEditingQueuedAttachment: (attachmentId: string) => void;
  onRestoreEditingQueuedAttachment?: ((attachment: ContractChatAttachment) => void) | undefined;

  onCompactContext: () => void;
  onSend: (
    e?: { preventDefault: () => void },
    dispatchMode?: ComposerDispatchMode,
    submissionIntent?: ComposerSubmissionIntent,
  ) => void;
  captureDetachedSend?: () => (
    e?: { preventDefault: () => void },
    dispatchMode?: ComposerDispatchMode,
    submissionIntent?: ComposerSubmissionIntent,
    directAnnotation?: {
      annotation: PreviewAnnotationPayload;
      image: ComposerImageAttachment | null;
    },
    detachedOverride?: {
      readonly prompt: string;
      readonly sendContext: ReturnType<ChatComposerHandle["getSendContext"]>;
    },
  ) => void;
  onResume: () => void;
  onInterrupt: () => void;
  onSelectActivePendingUserInputOption: (questionId: string, optionValue: string) => void;
  onAdvanceActivePendingUserInput: () => void;
  onDismissActivePendingUserInput: (requestId: RuntimeRequestId) => void;
  onPreviousActivePendingUserInputQuestion: () => void;
  onChangeActivePendingUserInputCustomAnswer: (
    questionId: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;

  onProviderModelSelect: (
    instanceId: ProviderInstanceId,
    model: string,
    options?: { focusComposer?: boolean },
  ) => void;
  onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;

  focusComposer: () => void;
  scheduleComposerFocus: () => void;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  onFileOpen: (attachment: ChatFileAttachment) => void;
}
