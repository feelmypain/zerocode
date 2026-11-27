import type {
  DesktopPreviewAnnotationTheme,
  DesktopPreviewColorScheme,
  DesktopPreviewFavicon,
  DesktopPreviewFindResultEvent,
  DesktopPreviewOpenLinkEvent,
  DesktopPreviewPointerEvent,
  DesktopPreviewRecordingFrame,
  DesktopPreviewRecordingInputEvent,
} from "@zerocode/contracts/ipc";
import type { BrowserWindow } from "electron";
import type * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Semaphore from "effect/Semaphore";

import type { RecordingInputOptions } from "./RecordingInput.ts";

export type PreviewNavStatus =
  | { kind: "Idle" }
  | { kind: "Loading"; url: string; title: string }
  | { kind: "Success"; url: string; title: string }
  | {
      kind: "LoadFailed";
      url: string;
      title: string;
      code: number;
      description: string;
    };

export interface PreviewTabState {
  tabId: string;
  webContentsId: number | null;
  navStatus: PreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  pictureInPicture: boolean;
  colorScheme: DesktopPreviewColorScheme;
  audioMuted: boolean;
  audible: boolean;
  controller: "human" | "agent" | "none";
  capturing: boolean;
  favicon?: DesktopPreviewFavicon;
  serverTab?: { readonly threadId: string; readonly tabId: string };
  updatedAt: string;
}

const ZOOM_LEVELS: ReadonlyArray<number> = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
];

export const DEFAULT_ZOOM_FACTOR = 1.0;
export const ZOOM_EPSILON = 0.001;
// Cold guests can reject capturePage with UnknownVizError or stall; bound each attempt.
export const CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS = 1_000;

export const DEFAULT_ANNOTATION_THEME: DesktopPreviewAnnotationTheme = {
  colorScheme: "light",
  radius: "0.625rem",
  background: "white",
  foreground: "oklch(0.269 0 0)",
  popover: "white",
  popoverForeground: "oklch(0.269 0 0)",
  primary: "oklch(0.488 0.217 264)",
  primaryForeground: "white",
  muted: "rgb(0 0 0 / 4%)",
  mutedForeground: "oklch(0.556 0 0)",
  accent: "rgb(0 0 0 / 4%)",
  accentForeground: "oklch(0.269 0 0)",
  border: "rgb(0 0 0 / 8%)",
  input: "rgb(0 0 0 / 10%)",
  ring: "oklch(0.488 0.217 264)",
  fontSans: "system-ui, sans-serif",
  fontMono: "ui-monospace, monospace",
};

export const PreviewAutomationSelectorKind = Schema.Literals([
  "focused-element",
  "selector",
  "locator",
]);
export type PreviewAutomationSelectorKind = typeof PreviewAutomationSelectorKind.Type;

export const PreviewAutomationEvaluationDetailKind = Schema.Literals([
  "exception-description",
  "exception-text",
  "unknown",
]);
export type PreviewAutomationEvaluationDetailKind =
  typeof PreviewAutomationEvaluationDetailKind.Type;

export interface PreviewOperationContext {
  readonly operation: string;
  readonly tabId?: string;
  readonly webContentsId?: number;
  readonly artifactPath?: string;
}

const findZoomStep = (current: number): number => {
  const index = ZOOM_LEVELS.findIndex(
    (level) => Math.abs(level - current) < ZOOM_EPSILON || level > current,
  );
  if (index < 0) return ZOOM_LEVELS.length - 1;
  return Math.abs(ZOOM_LEVELS[index]! - current) < ZOOM_EPSILON ? index : index - 1;
};

export const normalizeZoomFactor = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_ZOOM_FACTOR;
  let closest = ZOOM_LEVELS[0]!;
  for (const level of ZOOM_LEVELS) {
    if (Math.abs(level - value) < Math.abs(closest - value)) closest = level;
  }
  return closest;
};

export const nextZoomLevel = (current: number, direction: "in" | "out"): number => {
  const step = findZoomStep(current);
  if (direction === "in") {
    return ZOOM_LEVELS[Math.min(step + 1, ZOOM_LEVELS.length - 1)] ?? current;
  }
  return ZOOM_LEVELS[Math.max(step - 1, 0)] ?? current;
};

export type Listener = (tabId: string, state: PreviewTabState) => Effect.Effect<void>;

export type PreviewInputSignal =
  | { readonly kind: "pointer"; readonly x: number; readonly y: number; readonly button: number }
  | { readonly kind: "key"; readonly key: string; readonly code: string };

export interface ManagedListeners {
  readonly attachmentId: symbol;
  readonly cancelFaviconCapture: () => void;
  readonly scope: Scope.Closeable;
  readonly webContents: Electron.WebContents;
}

// Each still-image request owns a separate, short-lived rendering lease.
export type FrameCaptureConsumer = "picture-in-picture" | "recording" | symbol;

export interface FrameCaptureSession {
  readonly recordingInputOptions?: RecordingInputOptions;
  readonly scope: Scope.Closeable | null;
  readonly screencastScope: Scope.Closeable | null;
  readonly screencastWebContentsId: number | null;
  readonly consumers: ReadonlySet<FrameCaptureConsumer>;
  readonly unthrottledWebContentsIds: ReadonlySet<number>;
  readonly lastPictureInPictureFingerprint: string | null;
  readonly lastPictureInPictureFrame: DesktopPreviewRecordingFrame | null;
}

export interface PictureInPictureSession {
  readonly window: BrowserWindow;
  readonly webContentsId: number;
  readonly ready: Deferred.Deferred<void, PreviewManagerError>;
  readonly initializationScope: Scope.Closeable;
}

export interface PendingRecording {
  readonly tabId: string;
  readonly webContents: Electron.WebContents;
  readonly requestingFrameTreeNodeId: number;
  readonly armedAtMillis: number;
}

export interface PickSession {
  readonly voiceSessionId?: string | undefined;
  readonly cancel: Effect.Effect<void>;
}

export interface BrowserControlSession {
  readonly webContentsId: number;
  // Retain the attached Debugger to prevent GC crashes (electron/electron#53376); wc.debugger throws after destruction.
  readonly debugger: Electron.Debugger;
  readonly semaphore: Semaphore.Semaphore;
  readonly scope: Scope.Closeable;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
  ) => void;
}

export type RecordingInputListener = (
  event: DesktopPreviewRecordingInputEvent,
) => Effect.Effect<void>;

export type PointerEventListener = (event: DesktopPreviewPointerEvent) => Effect.Effect<void>;

export type OpenLinkListener = (event: DesktopPreviewOpenLinkEvent) => Effect.Effect<void>;

export type FindResultListener = (event: DesktopPreviewFindResultEvent) => Effect.Effect<void>;

export type PreviewEventKind =
  | "state-change"
  | "recording-input"
  | "pointer-event"
  | "open-link"
  | "find-result";

export const replaceMap = <K, V>(
  source: ReadonlyMap<K, V>,
  update: (copy: Map<K, V>) => void,
): ReadonlyMap<K, V> => {
  const copy = new Map(source);
  update(copy);
  return copy;
};

export const attempt = <A>(errorContext: PreviewOperationContext, evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: (cause) => new PreviewOperationError({ ...errorContext, cause }),
  });

export const attemptPromise = <A>(
  errorContext: PreviewOperationContext,
  evaluate: () => PromiseLike<A>,
) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new PreviewOperationError({ ...errorContext, cause }),
  });

export class PreviewTabNotFoundError extends Schema.TaggedError<PreviewTabNotFoundError>()(
  "PreviewTabNotFoundError",
  { tabId: Schema.String },
) {
  override get message(): string {
    return `Preview tab not found: ${this.tabId}`;
  }
}

export class PreviewWebContentsNotFoundError extends Schema.TaggedError<PreviewWebContentsNotFoundError>()(
  "PreviewWebContentsNotFoundError",
  { tabId: Schema.String, webContentsId: Schema.Number },
) {
  override get message(): string {
    return `WebContents ${this.webContentsId} not found for preview tab ${this.tabId}`;
  }
}

export class PreviewWebviewNotInitializedError extends Schema.TaggedError<PreviewWebviewNotInitializedError>()(
  "PreviewWebviewNotInitializedError",
  { tabId: Schema.String },
) {
  override get message(): string {
    return `Preview tab "${this.tabId}" has no webview registered`;
  }
}

export class PreviewMainWindowClosedError extends Schema.TaggedError<PreviewMainWindowClosedError>()(
  "PreviewMainWindowClosedError",
  { tabId: Schema.String },
) {
  override get message(): string {
    return `Cannot start preview frame capture while the main window is closed: ${this.tabId}`;
  }
}

export class PreviewRecordingArmConflictError extends Schema.TaggedError<PreviewRecordingArmConflictError>()(
  "PreviewRecordingArmConflictError",
  {
    tabId: Schema.String,
    webContentsId: Schema.Number,
    armedTabId: Schema.String,
  },
) {
  override get message(): string {
    return `Preview tab ${this.armedTabId} is still claiming the capture stream, so recording could not start for tab ${this.tabId}`;
  }
}

export class PreviewRecordingCaptureUnavailableError extends Schema.TaggedError<PreviewRecordingCaptureUnavailableError>()(
  "PreviewRecordingCaptureUnavailableError",
  {
    tabId: Schema.String,
    webContentsId: Schema.Number,
  },
) {
  override get message(): string {
    return `Preview recording capture is unavailable for tab ${this.tabId} in WebContents ${this.webContentsId}`;
  }
}

export class PreviewOperationError extends Schema.TaggedError<PreviewOperationError>()(
  "PreviewOperationError",
  {
    operation: Schema.String,
    tabId: Schema.optional(Schema.String),
    webContentsId: Schema.optional(Schema.Number),
    artifactPath: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  static toTimelineMessage(error: PreviewOperationError): string {
    return error.cause instanceof Error ? error.cause.message : String(error.cause);
  }

  override get message(): string {
    const context = [
      this.tabId === undefined ? undefined : `tab ${this.tabId}`,
      this.webContentsId === undefined ? undefined : `WebContents ${this.webContentsId}`,
      this.artifactPath === undefined ? undefined : `artifact ${this.artifactPath}`,
    ].filter((value): value is string => value !== undefined);
    return `Desktop preview operation failed: ${this.operation}${context.length === 0 ? "" : ` (${context.join(", ")})`}`;
  }
}

export const isPreviewOperationError = Schema.is(PreviewOperationError);

export class PreviewArtifactPathOutsideDirectoryError extends Schema.TaggedError<PreviewArtifactPathOutsideDirectoryError>()(
  "PreviewArtifactPathOutsideDirectoryError",
  {
    artifactPath: Schema.String,
    artifactDirectory: Schema.String,
  },
) {
  override get message(): string {
    return `Preview artifact path ${this.artifactPath} is outside ${this.artifactDirectory}`;
  }
}

export class PreviewArtifactImageLoadError extends Schema.TaggedError<PreviewArtifactImageLoadError>()(
  "PreviewArtifactImageLoadError",
  { artifactPath: Schema.String },
) {
  override get message(): string {
    return `Preview artifact could not be loaded as an image: ${this.artifactPath}`;
  }
}

export class PreviewAutomationDevToolsOpenError extends Schema.TaggedError<PreviewAutomationDevToolsOpenError>()(
  "PreviewAutomationDevToolsOpenError",
  { webContentsId: Schema.Number },
) {
  override get message(): string {
    return `Close preview DevTools before using agent browser control for WebContents ${this.webContentsId}`;
  }
}

export class PreviewAutomationDebuggerAttachedError extends Schema.TaggedError<PreviewAutomationDebuggerAttachedError>()(
  "PreviewAutomationDebuggerAttachedError",
  { webContentsId: Schema.Number },
) {
  override get message(): string {
    return `Preview control cannot attach to WebContents ${this.webContentsId} because another debugger owns it`;
  }
}

export const PreviewManagerError = Schema.Union([
  PreviewTabNotFoundError,
  PreviewWebContentsNotFoundError,
  PreviewWebviewNotInitializedError,
  PreviewMainWindowClosedError,
  PreviewRecordingArmConflictError,
  PreviewRecordingCaptureUnavailableError,
  PreviewOperationError,
  PreviewArtifactPathOutsideDirectoryError,
  PreviewArtifactImageLoadError,
  PreviewAutomationDevToolsOpenError,
  PreviewAutomationDebuggerAttachedError,
]);
export type PreviewManagerError = typeof PreviewManagerError.Type;
