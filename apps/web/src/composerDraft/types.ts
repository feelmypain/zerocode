import {
  ElementContextDetails,
  EnvironmentContextRecord,
  EnvironmentId,
  ModelSelection,
  PastedTextAttachmentSource,
  PreviewAnnotationPayloadSchema,
  type PreviewAnnotationPayload,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderOptionSelection,
  ProviderOptionSelections,
  ResponseContextRecord,
  RuntimeMode,
  type ScopedProjectRef,
  type ScopedThreadRef,
  SnapShotSource,
  ThreadContextRecord,
  ThreadId,
} from "@zerocode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ComposerContextReference } from "../lib/composerContextReferences";
import type { TerminalContextDraft } from "../lib/terminalContext";
import { ReviewCommentContextSchema, type ReviewCommentContext } from "../reviewCommentContext";
import type { ChatFileAttachment, ChatImageAttachment } from "../types";

export const isElementContextDetails = Schema.is(ElementContextDetails);
export const isRuntimeMode = Schema.is(RuntimeMode);
export const isProviderDriverKind = Schema.is(ProviderDriverKind);
export const isReviewCommentContext = Schema.is(ReviewCommentContextSchema);
export const isThreadContextRecord = Schema.is(ThreadContextRecord);
export const isEnvironmentContextRecord = Schema.is(EnvironmentContextRecord);
export const isSnapShotSource = Schema.is(SnapShotSource);
export const isPreviewAnnotationPayload = Schema.is(PreviewAnnotationPayloadSchema);
export const isResponseContextRecord = Schema.is(ResponseContextRecord);

export const COMPOSER_DRAFT_STORAGE_KEY = "zerocode:composer-drafts:v1";
export const COMPOSER_DRAFT_STORAGE_VERSION = 9;
const DraftThreadEnvModeSchema = Schema.Literals(["local", "worktree"]);
export type DraftThreadEnvMode = typeof DraftThreadEnvModeSchema.Type;

export const DraftId = Schema.String.pipe(Schema.brand("DraftId"));
export type DraftId = typeof DraftId.Type;

export const COMPOSER_PERSIST_DEBOUNCE_MS = 300;

export type ComposerPersistState =
  | { capturedState: ComposerDraftStoreState }
  | PersistedComposerDraftStoreState;

export const PersistedComposerImageAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  source: Schema.optional(SnapShotSource),
  dataUrl: Schema.String,
});
export type PersistedComposerImageAttachment = typeof PersistedComposerImageAttachment.Type;

export interface ComposerImageAttachment extends Omit<ChatImageAttachment, "previewUrl"> {
  previewUrl: string;
  file: File;
}

export interface ComposerFileAttachment extends Omit<ChatFileAttachment, "previewUrl"> {
  file: File | null;
  uploadedAttachmentId?: string;
  uploadEnvironmentId?: EnvironmentId;
}

export function composerFileNeedsReattach(file: ComposerFileAttachment): boolean {
  return file.file === null && file.uploadedAttachmentId === undefined;
}

export const PersistedComposerFileAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  attachmentId: Schema.String,
  environmentId: EnvironmentId,
  source: Schema.optional(PastedTextAttachmentSource),
});
export type PersistedComposerFileAttachment = typeof PersistedComposerFileAttachment.Type;

/** File handles cannot serialize; metadata-only markers hydrate as needs-reattach rows. */
export const PersistedComposerDraftFileAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  attachmentId: Schema.optionalKey(Schema.String),
  environmentId: Schema.optionalKey(EnvironmentId),
  source: Schema.optional(PastedTextAttachmentSource),
});
export type PersistedComposerDraftFileAttachment = typeof PersistedComposerDraftFileAttachment.Type;
export const isPersistedComposerDraftFileAttachment = Schema.is(
  PersistedComposerDraftFileAttachment,
);

const PersistedTerminalContextDraftSchema = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  createdAt: Schema.String,
  terminalId: Schema.String,
  terminalLabel: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
  text: Schema.optionalKey(Schema.String),
});
export type PersistedTerminalContextDraft = typeof PersistedTerminalContextDraftSchema.Type;

const PersistedComposerThreadDraftStateSchema = Schema.Struct({
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
  files: Schema.optionalKey(Schema.Array(PersistedComposerDraftFileAttachment)),
  terminalContexts: Schema.optionalKey(Schema.Array(PersistedTerminalContextDraftSchema)),
  previewAnnotations: Schema.optionalKey(Schema.Array(PreviewAnnotationPayloadSchema)),
  reviewComments: Schema.optionalKey(Schema.Array(ReviewCommentContextSchema)),
  threadContexts: Schema.optionalKey(Schema.Array(ThreadContextRecord)),
  environmentContexts: Schema.optionalKey(Schema.Array(EnvironmentContextRecord)),
  replyTo: Schema.optionalKey(ResponseContextRecord),
  modelSelectionByProvider: Schema.optionalKey(Schema.Record(ProviderInstanceId, ModelSelection)),
  activeProvider: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
  modelSelectionExplicit: Schema.optionalKey(Schema.Boolean),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
});
export type PersistedComposerThreadDraftState = typeof PersistedComposerThreadDraftStateSchema.Type;

export type ProviderOptionSelectionsByProvider = Partial<
  Record<string, ReadonlyArray<ProviderOptionSelection>>
>;

export type LegacyCodexFields = {
  effort?: unknown;
  codexFastMode?: unknown;
  serviceTier?: unknown;
};

type LegacyThreadModelFields = {
  provider?: unknown;
  model?: unknown;
  modelOptions?: unknown;
};

type LegacyV2ThreadDraftFields = {
  modelSelection?: ModelSelection | null;
  modelOptions?: unknown;
};

export type LegacyPersistedComposerThreadDraftState = PersistedComposerThreadDraftState &
  LegacyCodexFields &
  LegacyThreadModelFields &
  LegacyV2ThreadDraftFields;

type LegacyStickyModelFields = {
  stickyProvider?: unknown;
  stickyModel?: unknown;
  stickyModelOptions?: unknown;
};

type LegacyV2StoreFields = {
  stickyModelSelection?: ModelSelection | null;
  stickyModelOptions?: unknown;
  projectDraftThreadIdByProjectId?: Record<string, string> | null;
  draftsByThreadId?: Record<string, PersistedComposerThreadDraftState> | null;
  draftThreadsByThreadId?: Record<string, PersistedDraftThreadState> | null;
  projectDraftThreadIdByProjectKey?: Record<string, string> | null;
  draftsByThreadKey?: Record<string, PersistedComposerThreadDraftState> | null;
  draftThreadsByThreadKey?: Record<string, PersistedDraftThreadState> | null;
  projectDraftThreadKeyByProjectKey?: Record<string, string> | null;
  logicalProjectDraftThreadKeyByLogicalProjectKey?: Record<string, string> | null;
};

export type LegacyPersistedComposerDraftStoreState = PersistedComposerDraftStoreState &
  LegacyStickyModelFields &
  LegacyV2StoreFields;

const PersistedDraftThreadStateSchema = Schema.Struct({
  threadId: ThreadId,
  environmentId: Schema.String,
  projectId: ProjectId,
  logicalProjectKey: Schema.optionalKey(Schema.String),
  environmentSelection: Schema.optionalKey(Schema.Literals(["auto", "manual"])),
  loadBalancedEnvironmentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  envMode: DraftThreadEnvModeSchema,
  startFromOrigin: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  checkoutPullRequest: Schema.optionalKey(
    Schema.Struct({ url: Schema.String, branch: Schema.String }),
  ),
  worktreeRepositories: Schema.optionalKey(Schema.Array(Schema.String)),
  promotedTo: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        environmentId: Schema.String,
        threadId: Schema.String,
      }),
    ),
  ),
});
export type PersistedDraftThreadState = typeof PersistedDraftThreadStateSchema.Type;

const PersistedComposerDraftStoreStateSchema = Schema.Struct({
  draftsByThreadKey: Schema.Record(Schema.String, PersistedComposerThreadDraftStateSchema),
  draftThreadsByThreadKey: Schema.Record(Schema.String, PersistedDraftThreadStateSchema),
  logicalProjectDraftThreadKeyByLogicalProjectKey: Schema.Record(Schema.String, Schema.String),
  stickyModelSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderInstanceId, ModelSelection),
  ),
  stickyOptionsByModelByProvider: Schema.optionalKey(
    Schema.Record(ProviderInstanceId, Schema.Record(Schema.String, ProviderOptionSelections)),
  ),
  stickyActiveProvider: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
});
export type PersistedComposerDraftStoreState = typeof PersistedComposerDraftStoreStateSchema.Type;

export const PersistedComposerDraftStoreStorage = Schema.Struct({
  version: Schema.Number,
  state: PersistedComposerDraftStoreStateSchema,
});

export interface ComposerContextAddOptions {
  appendReference?: boolean;
  allowDuplicateReference?: boolean;
  /** `false` to append synchronously instead of asking a mounted editor for its current caret. */
  insertAtCaret?: boolean;
}

export type ComposerContextInsertionHandler = (
  references: ReadonlyArray<ComposerContextReference>,
) => boolean;

export interface ComposerThreadDraftState {
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  terminalContexts: TerminalContextDraft[];
  previewAnnotations: PreviewAnnotationPayload[];
  reviewComments: ReviewCommentContext[];
  threadContexts: ThreadContextRecord[];
  environmentContexts: EnvironmentContextRecord[];
  /** The response this message replies to. It becomes a context record when the message is sent. */
  replyTo: ResponseContextRecord | null;
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  activeProvider: ProviderInstanceId | null;
  modelSelectionExplicit?: boolean;
  runtimeMode: RuntimeMode | null;
  interactionMode: ProviderInteractionMode | null;
}

export function composerDraftHasUserContent(
  draft: ComposerThreadDraftState | null | undefined,
): boolean {
  if (!draft) {
    return false;
  }
  return (
    draft.prompt.trim().length > 0 ||
    draft.images.length > 0 ||
    draft.files.length > 0 ||
    draft.persistedAttachments.length > 0 ||
    draft.terminalContexts.length > 0 ||
    draft.previewAnnotations.length > 0 ||
    draft.reviewComments.length > 0 ||
    draft.threadContexts.length > 0 ||
    draft.environmentContexts.length > 0 ||
    draft.replyTo !== null
  );
}

export interface DraftSessionState {
  threadId: ThreadId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  logicalProjectKey: string;
  environmentSelection?: "auto" | "manual";
  loadBalancedEnvironmentId?: EnvironmentId | null;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
  startFromOrigin: boolean;
  /** Temporary chat draft: excluded from localStorage persistence and deleted when leaving the app. */
  ephemeral?: boolean;
  /** Linked to the thread when the draft is sent on this branch. */
  checkoutPullRequest?: DraftCheckoutPullRequest;
  /**
   * Tracked repositories a new worktree thread gets a worktree for, by tracked path. Absent
   * until the user chooses, which leaves the choice to the server's default.
   */
  worktreeRepositories?: ReadonlyArray<string>;
  promotedTo?: ScopedThreadRef | null;
}

export type DraftThreadState = DraftSessionState;

export interface DraftCheckoutPullRequest {
  readonly url: string;
  readonly branch: string;
}

/**
 * The pull request to link when this draft becomes a thread. Matching the branch at send time,
 * rather than clearing on every branch write, matters: right after a local checkout the live
 * branch sync briefly writes the stale pre-checkout branch back onto the draft before the fresh
 * git status lands.
 */
export function checkoutPullRequestUrlToLink(
  draft: Pick<DraftSessionState, "branch" | "checkoutPullRequest"> | null | undefined,
): string | null {
  const checkout = draft?.checkoutPullRequest;
  return checkout && draft.branch === checkout.branch ? checkout.url : null;
}

export interface ProjectDraftSession extends DraftSessionState {
  draftId: DraftId;
}

export type ComposerThreadTarget = ScopedThreadRef | DraftId;

export type ComposerDraftStoreSet = (
  partial:
    | ComposerDraftStoreState
    | Partial<ComposerDraftStoreState>
    | ((
        state: ComposerDraftStoreState,
      ) => ComposerDraftStoreState | Partial<ComposerDraftStoreState>),
  replace?: false,
) => void;

export type ComposerDraftStoreGet = () => ComposerDraftStoreState;

export interface ComposerDraftStoreState {
  draftsByThreadKey: Record<string, ComposerThreadDraftState>;
  draftThreadsByThreadKey: Record<string, DraftThreadState>;
  logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string>;
  backgroundSubmissionThreadKeys: Record<string, true>;
  /**
   * Where each finalized draft went, so `/draft/<id>` keeps leading to its thread (Back, an
   * "Open draft" toast) after the draft is gone. In memory only, one small entry per sent draft.
   */
  promotedDraftRedirects: Record<string, ScopedThreadRef>;
  rewindingThreadKeys: ReadonlySet<string>;
  stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  stickyOptionsByModelByProvider: Partial<
    Record<ProviderInstanceId, Partial<Record<string, ReadonlyArray<ProviderOptionSelection>>>>
  >;
  stickyActiveProvider: ProviderInstanceId | null;
  getComposerDraft: (target: ComposerThreadTarget) => ComposerThreadDraftState | null;
  getDraftSessionByLogicalProjectKey: (logicalProjectKey: string) => ProjectDraftSession | null;
  getDraftThreadByProjectRef: (projectRef: ScopedProjectRef) => ProjectDraftSession | null;
  getDraftSessionByProjectRef: (projectRef: ScopedProjectRef) => ProjectDraftSession | null;
  getDraftSession: (draftId: DraftId) => DraftSessionState | null;
  getDraftSessionByRef: (threadRef: ScopedThreadRef) => DraftSessionState | null;
  getDraftIdByRef: (threadRef: ScopedThreadRef) => DraftId | null;
  getPromotedDraftRedirect: (draftId: DraftId) => ScopedThreadRef | null;
  getDraftThreadByRef: (threadRef: ScopedThreadRef) => DraftThreadState | null;
  getDraftThread: (threadRef: ComposerThreadTarget) => DraftThreadState | null;
  listDraftThreadKeys: () => string[];
  hasDraftThreadsInEnvironment: (environmentId: EnvironmentId) => boolean;
  setLogicalProjectDraftThreadId: (
    logicalProjectKey: string,
    projectRef: ScopedProjectRef,
    draftId: DraftId,
    options?: {
      threadId?: ThreadId;
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
      environmentSelection?: "auto" | "manual";
      loadBalancedEnvironmentId?: EnvironmentId | null;
      checkoutPullRequest?: DraftCheckoutPullRequest | null;
      ephemeral?: boolean;
    },
  ) => void;
  setProjectDraftThreadId: (
    projectRef: ScopedProjectRef,
    draftId: DraftId,
    options?: {
      threadId?: ThreadId;
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
      environmentSelection?: "auto" | "manual";
      loadBalancedEnvironmentId?: EnvironmentId | null;
      checkoutPullRequest?: DraftCheckoutPullRequest | null;
      ephemeral?: boolean;
    },
  ) => void;
  setDraftThreadContext: (
    threadRef: ComposerThreadTarget,
    options: {
      branch?: string | null;
      worktreePath?: string | null;
      projectRef?: ScopedProjectRef;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
      environmentSelection?: "auto" | "manual";
      loadBalancedEnvironmentId?: EnvironmentId | null;
      checkoutPullRequest?: DraftCheckoutPullRequest | null;
      worktreeRepositories?: ReadonlyArray<string> | null;
      ephemeral?: boolean;
    },
  ) => void;
  clearProjectDraftThreadId: (projectRef: ScopedProjectRef) => void;
  clearProjectDraftThreadById: (
    projectRef: ScopedProjectRef,
    threadRef: ComposerThreadTarget,
  ) => void;
  markDraftThreadPromoting: (threadRef: ComposerThreadTarget, promotedTo?: ScopedThreadRef) => void;
  finalizePromotedDraftThread: (threadRef: ComposerThreadTarget) => void;
  clearDraftThread: (threadRef: ComposerThreadTarget) => void;
  setStickyModelSelection: (modelSelection: ModelSelection | null | undefined) => void;
  setPrompt: (threadRef: ComposerThreadTarget, prompt: string) => void;
  setTerminalContexts: (threadRef: ComposerThreadTarget, contexts: TerminalContextDraft[]) => void;
  setModelSelection: (
    threadRef: ComposerThreadTarget,
    modelSelection: ModelSelection | null | undefined,
    opts?: {
      explicit?: boolean;
      /** Replace existing options even when the incoming selection has none. */
      replaceOptions?: boolean;
    },
  ) => void;
  /** Lets the thread's model show again once the server accepted this exact pick. */
  releaseModelSelection: (threadRef: ScopedThreadRef, modelSelection: ModelSelection) => void;
  applyStickyState: (threadRef: ComposerThreadTarget) => void;
  setProviderModelOptions: (
    threadRef: ComposerThreadTarget,
    provider: ProviderDriverKind,
    nextProviderOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
    options?: {
      instanceId?: ProviderInstanceId | null | undefined;
      model?: string | null | undefined;
      persistSticky?: boolean;
    },
  ) => void;
  setRuntimeMode: (
    threadRef: ComposerThreadTarget,
    runtimeMode: RuntimeMode | null | undefined,
  ) => void;
  setInteractionMode: (
    threadRef: ComposerThreadTarget,
    interactionMode: ProviderInteractionMode | null | undefined,
  ) => void;
  addImage: (threadRef: ComposerThreadTarget, image: ComposerImageAttachment) => boolean;
  addImages: (
    threadRef: ComposerThreadTarget,
    images: ComposerImageAttachment[],
    options?: {
      allowDuplicates?: boolean;
      onCapacityExceeded?: (image: ComposerImageAttachment) => void;
    },
  ) => string[];
  removeImage: (threadRef: ComposerThreadTarget, imageId: string) => void;
  /** Returns the ids of files appended; a re-pick that replaces a marker is not listed. */
  addFiles: (
    threadRef: ComposerThreadTarget,
    files: ComposerFileAttachment[],
    options?: { allowDuplicates?: boolean; appendReference?: boolean },
  ) => string[];
  removeFile: (threadRef: ComposerThreadTarget, fileId: string) => void;
  setFileUpload: (
    threadRef: ComposerThreadTarget,
    fileId: string,
    environmentId: EnvironmentId,
    attachmentId: string,
  ) => void;
  markFileUploadMissing: (
    threadRef: ComposerThreadTarget,
    fileId: string,
    environmentId: EnvironmentId,
    attachmentId: string,
  ) => boolean;
  insertTerminalContext: (
    threadRef: ComposerThreadTarget,
    prompt: string,
    context: TerminalContextDraft,
    index: number,
  ) => boolean;
  addTerminalContexts: (
    threadRef: ComposerThreadTarget,
    contexts: TerminalContextDraft[],
    options?: ComposerContextAddOptions,
  ) => void;
  removeTerminalContext: (threadRef: ComposerThreadTarget, contextId: string) => void;
  clearTerminalContexts: (threadRef: ComposerThreadTarget) => void;
  addPreviewAnnotation: (
    threadRef: ComposerThreadTarget,
    annotation: PreviewAnnotationPayload,
    options?: ComposerContextAddOptions,
  ) => void;
  setPreviewAnnotations: (
    threadRef: ComposerThreadTarget,
    annotations: ReadonlyArray<PreviewAnnotationPayload>,
  ) => void;
  removePreviewAnnotation: (threadRef: ComposerThreadTarget, annotationId: string) => void;
  setReplyTo: (threadRef: ComposerThreadTarget, response: ResponseContextRecord | null) => void;
  addReviewComment: (
    threadRef: ComposerThreadTarget,
    comment: ReviewCommentContext,
    options?: ComposerContextAddOptions,
  ) => void;
  setContextInsertionHandler: (
    threadRef: ComposerThreadTarget,
    handler: ComposerContextInsertionHandler | null,
  ) => (() => void) | undefined;
  setReviewComments: (
    threadRef: ComposerThreadTarget,
    comments: ReadonlyArray<ReviewCommentContext>,
  ) => void;
  removeReviewComment: (threadRef: ComposerThreadTarget, commentId: string) => void;
  addThreadContexts: (
    threadRef: ComposerThreadTarget,
    records: ReadonlyArray<ThreadContextRecord>,
    options?: ComposerContextAddOptions,
  ) => void;
  setThreadContexts: (
    threadRef: ComposerThreadTarget,
    records: ReadonlyArray<ThreadContextRecord>,
  ) => void;
  /** Mentions machines as context; already-mentioned machines are skipped. */
  addEnvironmentContexts: (
    threadRef: ComposerThreadTarget,
    records: ReadonlyArray<EnvironmentContextRecord>,
    options?: ComposerContextAddOptions,
  ) => void;
  setEnvironmentContexts: (
    threadRef: ComposerThreadTarget,
    records: ReadonlyArray<EnvironmentContextRecord>,
  ) => void;
  clearPersistedAttachments: (threadRef: ComposerThreadTarget) => void;
  syncPersistedAttachments: (
    threadRef: ComposerThreadTarget,
    attachments: PersistedComposerImageAttachment[],
  ) => Promise<void>;
  /** Saves records for the supplied images that the draft still owns after serialization. */
  appendPersistedAttachments: (
    threadRef: ComposerThreadTarget,
    images: ReadonlyArray<ComposerImageAttachment>,
    attachments: ReadonlyArray<PersistedComposerImageAttachment>,
  ) => Promise<void>;
  clearComposerContent: (threadRef: ComposerThreadTarget) => void;
  /** Clears text and attachments, preserving terminal/element contexts, preview annotations, and review comments. */
  clearComposerPromptAndImages: (threadRef: ComposerThreadTarget) => void;
  /** Moves all user content into a destination that has none; otherwise leaves both drafts alone. */
  moveComposerContent: (from: ComposerThreadTarget, to: ComposerThreadTarget) => void;
}

export interface EffectiveComposerModelState {
  selectedModel: string;
  modelOptions: ProviderOptionSelectionsByProvider | null;
}

export interface ComposerDraftModelState {
  activeProvider: ProviderInstanceId | null;
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  modelSelectionExplicit: boolean;
}

export type ComposerThreadLookupState = Pick<
  ComposerDraftStoreState,
  "draftsByThreadKey" | "draftThreadsByThreadKey"
>;

export const EMPTY_PERSISTED_DRAFT_STORE_STATE = Object.freeze<PersistedComposerDraftStoreState>({
  draftsByThreadKey: {},
  draftThreadsByThreadKey: {},
  logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  stickyModelSelectionByProvider: {},
  stickyOptionsByModelByProvider: {},
  stickyActiveProvider: null,
});

const EMPTY_IMAGES: ComposerImageAttachment[] = [];
const EMPTY_FILES: ComposerFileAttachment[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_PERSISTED_ATTACHMENTS: PersistedComposerImageAttachment[] = [];
const EMPTY_TERMINAL_CONTEXTS: TerminalContextDraft[] = [];
const EMPTY_PREVIEW_ANNOTATIONS: PreviewAnnotationPayload[] = [];
const EMPTY_REVIEW_COMMENTS: ReviewCommentContext[] = [];
const EMPTY_THREAD_CONTEXTS: ThreadContextRecord[] = [];
const EMPTY_ENVIRONMENT_CONTEXTS: EnvironmentContextRecord[] = [];
Object.freeze(EMPTY_IMAGES);
Object.freeze(EMPTY_FILES);
Object.freeze(EMPTY_IDS);
Object.freeze(EMPTY_PERSISTED_ATTACHMENTS);
Object.freeze(EMPTY_PREVIEW_ANNOTATIONS);
Object.freeze(EMPTY_REVIEW_COMMENTS);
Object.freeze(EMPTY_THREAD_CONTEXTS);
Object.freeze(EMPTY_ENVIRONMENT_CONTEXTS);
const EMPTY_MODEL_SELECTION_BY_PROVIDER: Partial<Record<ProviderDriverKind, ModelSelection>> =
  Object.freeze({});

export const EMPTY_COMPOSER_DRAFT_MODEL_STATE = Object.freeze<ComposerDraftModelState>({
  activeProvider: null,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
  modelSelectionExplicit: false,
});

export const EMPTY_THREAD_DRAFT = Object.freeze<ComposerThreadDraftState>({
  prompt: "",
  images: EMPTY_IMAGES,
  files: EMPTY_FILES,
  nonPersistedImageIds: EMPTY_IDS,
  persistedAttachments: EMPTY_PERSISTED_ATTACHMENTS,
  terminalContexts: EMPTY_TERMINAL_CONTEXTS,
  previewAnnotations: EMPTY_PREVIEW_ANNOTATIONS,
  reviewComments: EMPTY_REVIEW_COMMENTS,
  threadContexts: EMPTY_THREAD_CONTEXTS,
  environmentContexts: EMPTY_ENVIRONMENT_CONTEXTS,
  replyTo: null,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
});

export function createEmptyThreadDraft(): ComposerThreadDraftState {
  return {
    prompt: "",
    images: [],
    files: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
    environmentContexts: [],
    replyTo: null,
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
  };
}

/** Keep these content fields aligned with composerDraftHasUserContent. */
export function composerDraftContent({
  modelSelectionByProvider: _modelSelectionByProvider,
  activeProvider: _activeProvider,
  modelSelectionExplicit: _modelSelectionExplicit,
  runtimeMode: _runtimeMode,
  interactionMode: _interactionMode,
  ...content
}: ComposerThreadDraftState) {
  return content;
}

export function shouldRemoveDraft(draft: ComposerThreadDraftState): boolean {
  return (
    draft.prompt.length === 0 &&
    draft.images.length === 0 &&
    draft.files.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.terminalContexts.length === 0 &&
    draft.previewAnnotations.length === 0 &&
    draft.reviewComments.length === 0 &&
    draft.threadContexts.length === 0 &&
    draft.environmentContexts.length === 0 &&
    draft.replyTo === null &&
    Object.keys(draft.modelSelectionByProvider).length === 0 &&
    draft.activeProvider === null &&
    draft.runtimeMode === null &&
    draft.interactionMode === null
  );
}
