import * as NodeZlib from "node:zlib";
import {
  DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER,
  type PreviewAnnotationPayload,
  type PreviewAnnotationRect,
} from "@zerocode/contracts/ipc";
import {
  type BrowserWindow,
  ClipboardItem,
  type Session,
  clipboard,
  nativeImage,
  shell,
  webContents,
} from "electron";
import * as Clock from "effect/Clock";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { HUMAN_INPUT_TRACKING_CHANNEL, RECORDING_CURSOR_CHANNEL } from "./GuestProtocol.ts";
import {
  CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS,
  PreviewArtifactImageLoadError,
  PreviewArtifactPathOutsideDirectoryError,
  PreviewMainWindowClosedError,
  PreviewOperationError,
  PreviewRecordingArmConflictError,
  PreviewRecordingCaptureUnavailableError,
  PreviewTabNotFoundError,
  PreviewWebContentsNotFoundError,
  attempt,
  attemptPromise,
  isPreviewOperationError,
  replaceMap,
  type BrowserControlSession,
  type FrameCaptureConsumer,
  type FrameCaptureSession,
  type PendingRecording,
  type PreviewManagerError,
  type PreviewOperationContext,
  type PreviewTabState,
} from "./PreviewTypes.ts";
import { DEFAULT_RECORDING_INPUT_OPTIONS, type RecordingInputOptions } from "./RecordingInput.ts";

const RECORDING_ARM_GRACE_MS = 10_000;
const CAPTURE_PAGE_RETRY_ATTEMPTS = 3;
const CAPTURE_PAGE_RETRY_DELAY_MS = 120;
const MAX_ARTIFACT_SITE_SLUG_LENGTH = 80;

const requestRecordingCaptureExpression = (tabId: string): string =>
  `globalThis[${JSON.stringify(DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER)}]?.(${JSON.stringify(tabId)}) === true`;

const recordingFileExtension = (mimeType: string): string => {
  const subtype = mimeType.split(";", 1)[0]?.trim().toLowerCase().split("/")[1] ?? "";
  const extension = subtype.replace(/^x-/, "").replace(/[^a-z0-9]/g, "");
  return extension || "video";
};

const artifactSiteSlug = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    const slug = url.hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_ARTIFACT_SITE_SLUG_LENGTH)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

export const normalizeCaptureRect = (value: unknown): PreviewAnnotationRect | null => {
  if (typeof value !== "object" || value === null) return null;
  const rect = value as Record<string, unknown>;
  const x = rect["x"];
  const y = rect["y"];
  const width = rect["width"];
  const height = rect["height"];
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { x, y, width, height };
};

// capturePage returns a 1x NativeImage containing device pixels, so crop() uses
// CSS coordinates scaled by the guest's devicePixelRatio (including page zoom).
export const cropAnnotationScreenshot = (
  image: Electron.NativeImage,
  cropRect: PreviewAnnotationRect | null,
  devicePixelRatio: number,
  targetRects: ReadonlyArray<PreviewAnnotationRect>,
): PreviewAnnotationPayload["screenshot"] => {
  const full = image.getSize();
  if (full.width <= 0 || full.height <= 0) return null;
  const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  // Padding or a union of offscreen targets can overlap an empty viewport area.
  // A zero-width/height SVG line can still paint at the top or left edge.
  if (
    targetRects.length > 0 &&
    !targetRects.some(
      (rect) =>
        (rect.width > 0 || rect.height > 0) &&
        rect.x * scale < full.width &&
        rect.y * scale < full.height &&
        (rect.width === 0 ? rect.x >= 0 : rect.x + rect.width > 0) &&
        (rect.height === 0 ? rect.y >= 0 : rect.y + rect.height > 0),
    )
  ) {
    return null;
  }
  if (!cropRect) {
    return {
      dataUrl: image.toDataURL(),
      width: full.width,
      height: full.height,
      cropRect: { x: 0, y: 0, width: full.width, height: full.height },
    };
  }
  const x = Math.max(0, Math.floor(cropRect.x * scale));
  const y = Math.max(0, Math.floor(cropRect.y * scale));
  const right = Math.min(full.width, Math.ceil((cropRect.x + cropRect.width) * scale));
  const bottom = Math.min(full.height, Math.ceil((cropRect.y + cropRect.height) * scale));
  // A target scrolled out of view has no pixels in this capture. Clamping its
  // origin onto the edge would attach an unrelated strip as a successful crop.
  if (right <= x || bottom <= y) return null;
  const cropped = image.crop({
    x,
    y,
    width: right - x,
    height: bottom - y,
  });
  const size = cropped.getSize();
  if (size.width <= 0 || size.height <= 0) return null;
  return { dataUrl: cropped.toDataURL(), width: size.width, height: size.height, cropRect };
};

// An invalid color space skips costly P3-to-sRGB conversion; fingerprints need no color accuracy.
const FINGERPRINT_BITMAP_OPTIONS: Electron.ToBitmapOptions = {
  colorSpace: { primaries: "invalid", transfer: "invalid", matrix: "invalid", range: "invalid" },
};

/** Empty readPixels results have no fingerprint and must be treated as changed frames. */
export const fingerprintCapturedFrame = (image: Electron.NativeImage, size: Electron.Size) => {
  let bitmap: Buffer;
  try {
    bitmap = image.toBitmap(FINGERPRINT_BITMAP_OPTIONS);
  } catch {
    return null;
  }
  if (bitmap.byteLength === 0) return null;
  return `${size.width}x${size.height}:${NodeZlib.crc32(bitmap)}`;
};

export interface PreviewCaptureControllerDeps {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly random: SecureRandom.SecureRandom["Service"];
  readonly parentScope: Scope.Scope;
  readonly resolvedArtifactDirectory: string;
  readonly mainWindowRef: Ref.Ref<Option.Option<BrowserWindow>>;
  readonly tabsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, PreviewTabState>>;
  readonly controlSessionsRef: SynchronizedRef.SynchronizedRef<
    ReadonlyMap<number, BrowserControlSession>
  >;
  readonly frameCaptureSessionsRef: SynchronizedRef.SynchronizedRef<
    ReadonlyMap<string, FrameCaptureSession>
  >;
  readonly closingTabIdsRef: Ref.Ref<ReadonlySet<string>>;
  readonly agentTrackedTabIds: Set<string>;
  readonly isFrameCaptureWindowOpen: () => boolean;
  readonly currentIso: Effect.Effect<string>;
  readonly currentMillis: Effect.Effect<number>;
  readonly withTabLifecycleLock: <A, E, R>(
    tabId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly requireWebContents: (
    tabId: string,
  ) => Effect.Effect<Electron.WebContents, PreviewManagerError>;
}

export const makePreviewCaptureController = (deps: PreviewCaptureControllerDeps) => {
  const {
    fileSystem,
    path,
    random,
    parentScope,
    resolvedArtifactDirectory,
    mainWindowRef,
    tabsRef,
    controlSessionsRef,
    frameCaptureSessionsRef,
    closingTabIdsRef,
    agentTrackedTabIds,
    isFrameCaptureWindowOpen,
    currentIso,
    currentMillis,
    withTabLifecycleLock,
    requireWebContents,
  } = deps;

  // Legacy tab capture is unsupported (electron/electron#44618); recording uses setDisplayMediaRequestHandler.
  let pendingRecording: PendingRecording | null = null;
  const displayMediaHandlerSessions = new WeakSet<Session>();

  const capturePageWithRetry = Effect.fn("PreviewManager.capturePageWithRetry")(function* (
    errorContext: PreviewOperationContext,
    tabId: string,
    wc: Electron.WebContents,
  ) {
    const requireCurrentGuest = Effect.gen(function* () {
      const tabs = yield* SynchronizedRef.get(tabsRef);
      if (wc.isDestroyed() || tabs.get(tabId)?.webContentsId !== wc.id) {
        return yield* new PreviewWebContentsNotFoundError({ tabId, webContentsId: wc.id });
      }
    });
    const capture = Effect.gen(function* () {
      yield* requireCurrentGuest;
      const image = yield* Effect.tryPromise({
        try: (_signal) => wc.capturePage(),
        catch: (cause) => new PreviewOperationError({ ...errorContext, cause }),
      }).pipe(
        Effect.timeout(CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS),
        Effect.catchTags({
          TimeoutError: (cause) =>
            Effect.fail(new PreviewOperationError({ ...errorContext, cause })),
        }),
      );
      yield* requireCurrentGuest;
      return image;
    });
    return yield* capture.pipe(
      Effect.retry({
        times: CAPTURE_PAGE_RETRY_ATTEMPTS - 1,
        schedule: Schedule.spaced(CAPTURE_PAGE_RETRY_DELAY_MS),
        while: isPreviewOperationError,
      }),
    );
  });

  const setWindowBackgroundThrottling = Effect.fnUntraced(function* (
    window: BrowserWindow,
    enabled: boolean,
  ) {
    if (window.isDestroyed()) return;
    yield* attempt({ operation: "frameCapture.setBackgroundThrottling" }, () =>
      window.webContents.setBackgroundThrottling(enabled),
    );
  });

  const setFrameCaptureBackgroundThrottling = Effect.fnUntraced(function* (enabled: boolean) {
    const mainWindow = yield* Ref.get(mainWindowRef);
    if (Option.isNone(mainWindow)) return;
    yield* setWindowBackgroundThrottling(mainWindow.value, enabled);
  });

  const setFrameCaptureWebContentsBackgroundThrottling = Effect.fnUntraced(function* (
    wc: Electron.WebContents,
    enabled: boolean,
  ) {
    if (wc.isDestroyed()) return;
    yield* attempt(
      {
        operation: "frameCapture.setBackgroundThrottling",
        webContentsId: wc.id,
      },
      () => wc.setBackgroundThrottling(enabled),
    );
  });

  const restoreFrameCaptureWebContentsBackgroundThrottling = Effect.fnUntraced(function* (
    webContentsIds: ReadonlySet<number>,
  ) {
    yield* Effect.forEach(
      webContentsIds,
      (webContentsId) => {
        const wc = webContents.fromId(webContentsId);
        if (!wc || wc.isDestroyed()) return Effect.void;
        return setFrameCaptureWebContentsBackgroundThrottling(wc, true).pipe(
          Effect.retry({ times: 2 }),
          Effect.catch((error) =>
            Effect.logWarning("Failed to restore preview webview frame capture throttling.", {
              webContentsId,
              error,
            }),
          ),
        );
      },
      { concurrency: "unbounded", discard: true },
    );
  });

  const keepFrameCaptureWebContentsUnthrottled = Effect.fnUntraced(function* (
    tabId: string,
    wc: Electron.WebContents,
  ) {
    yield* SynchronizedRef.modifyEffect(frameCaptureSessionsRef, (sessions) => {
      const current = sessions.get(tabId);
      if (!current || current.unthrottledWebContentsIds.has(wc.id)) {
        return Effect.succeed([undefined, sessions] as const);
      }
      return setFrameCaptureWebContentsBackgroundThrottling(wc, false).pipe(
        Effect.tap(() =>
          Effect.gen(function* () {
            if (!current.consumers.has("recording")) return;
            const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
            yield* attempt({ operation: "recording.cursor", tabId, webContentsId: wc.id }, () => {
              wc.send(
                RECORDING_CURSOR_CHANNEL,
                true,
                current.recordingInputOptions,
                tab?.controller,
              );
              wc.send(HUMAN_INPUT_TRACKING_CHANNEL, true);
            });
          }),
        ),
        Effect.map(
          () =>
            [
              undefined,
              replaceMap(sessions, (copy) => {
                copy.set(tabId, {
                  ...current,
                  unthrottledWebContentsIds: new Set([...current.unthrottledWebContentsIds, wc.id]),
                });
              }),
            ] as const,
        ),
      );
    });
  });

  const startFrameCapture = Effect.fn("PreviewManager.startFrameCapture")(function* (
    tabId: string,
    consumer: FrameCaptureConsumer,
    onStartPictureInPicture?: (
      tabId: string,
      wc: Electron.WebContents,
      scope: Scope.Closeable,
    ) => Effect.Effect<void>,
  ) {
    const pictureInPictureStart = yield* SynchronizedRef.modifyEffect(
      frameCaptureSessionsRef,
      (sessions) => {
        return Effect.gen(function* () {
          if (!isFrameCaptureWindowOpen()) {
            return yield* new PreviewMainWindowClosedError({ tabId });
          }
          const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
          if (!tab || (yield* Ref.get(closingTabIdsRef)).has(tabId)) {
            return yield* new PreviewTabNotFoundError({ tabId });
          }
          const wc = yield* requireWebContents(tabId);
          const current = sessions.get(tabId);
          if (current) {
            if (current.consumers.has(consumer)) {
              return [null, sessions] as const;
            }
            if (!current.unthrottledWebContentsIds.has(wc.id)) {
              yield* setFrameCaptureWebContentsBackgroundThrottling(wc, false);
            }
            let scope = current.scope;
            if (consumer === "picture-in-picture" && scope === null) {
              scope = yield* Scope.fork(parentScope, "sequential");
            }
            return [
              consumer === "picture-in-picture" && scope !== null ? { wc, scope } : null,
              replaceMap(sessions, (copy) => {
                copy.set(tabId, {
                  ...current,
                  scope,
                  consumers: new Set([...current.consumers, consumer]),
                  unthrottledWebContentsIds: new Set([...current.unthrottledWebContentsIds, wc.id]),
                });
              }),
            ] as const;
          }
          if (sessions.size === 0) {
            yield* setFrameCaptureBackgroundThrottling(false);
          }
          yield* setFrameCaptureWebContentsBackgroundThrottling(wc, false).pipe(
            Effect.onError(() =>
              sessions.size === 0
                ? setFrameCaptureBackgroundThrottling(true).pipe(Effect.ignore)
                : Effect.void,
            ),
          );
          const scope =
            consumer === "picture-in-picture" ? yield* Scope.fork(parentScope, "sequential") : null;
          return [
            consumer === "picture-in-picture" && scope !== null ? { wc, scope } : null,
            replaceMap(sessions, (copy) => {
              copy.set(tabId, {
                scope,
                screencastScope: null,
                screencastWebContentsId: null,
                consumers: new Set([consumer]),
                unthrottledWebContentsIds: new Set([wc.id]),
                lastPictureInPictureFingerprint: null,
                lastPictureInPictureFrame: null,
              });
            }),
          ] as const;
        });
      },
    ).pipe(Effect.uninterruptible);
    if (!pictureInPictureStart || !onStartPictureInPicture) return;
    yield* onStartPictureInPicture(tabId, pictureInPictureStart.wc, pictureInPictureStart.scope);
  });

  const stopFrameCapture = Effect.fn("PreviewManager.stopFrameCapture")(function* (
    tabId: string,
    consumer: FrameCaptureConsumer,
  ) {
    yield* SynchronizedRef.modifyEffect(frameCaptureSessionsRef, (sessions) =>
      Effect.gen(function* () {
        const current = sessions.get(tabId);
        if (!current || !current.consumers.has(consumer)) {
          return [undefined, sessions] as const;
        }
        if (consumer === "recording") {
          const keepHumanTracking = agentTrackedTabIds.has(tabId);
          yield* Effect.forEach(current.unthrottledWebContentsIds, (id) =>
            attempt({ operation: "recording.cursor", tabId, webContentsId: id }, () => {
              const contents = webContents.fromId(id);
              if (contents && !contents.isDestroyed()) {
                contents.send(RECORDING_CURSOR_CHANNEL, false);
                if (!keepHumanTracking) contents.send(HUMAN_INPUT_TRACKING_CHANNEL, false);
              }
            }).pipe(Effect.ignore),
          );
        }
        const consumers = new Set(current.consumers);
        consumers.delete(consumer);
        if (consumers.size > 0) {
          return [
            consumer === "picture-in-picture" ? current.scope : undefined,
            replaceMap(sessions, (copy) => {
              copy.set(tabId, {
                ...current,
                scope: consumer === "picture-in-picture" ? null : current.scope,
                screencastScope: consumer === "picture-in-picture" ? null : current.screencastScope,
                screencastWebContentsId:
                  consumer === "picture-in-picture" ? null : current.screencastWebContentsId,
                consumers,
                lastPictureInPictureFingerprint:
                  consumer === "picture-in-picture"
                    ? null
                    : current.lastPictureInPictureFingerprint,
                lastPictureInPictureFrame:
                  consumer === "picture-in-picture" ? null : current.lastPictureInPictureFrame,
              });
            }),
          ] as const;
        }
        const remainingSessions = replaceMap(sessions, (copy) => {
          copy.delete(tabId);
        });
        yield* restoreFrameCaptureWebContentsBackgroundThrottling(
          current.unthrottledWebContentsIds,
        );
        if (remainingSessions.size === 0) {
          yield* setFrameCaptureBackgroundThrottling(true).pipe(
            Effect.retry({ times: 2 }),
            Effect.catch((error) =>
              Effect.logWarning("Failed to restore preview frame capture throttling.", { error }),
            ),
          );
        }
        return [current.scope, remainingSessions] as const;
      }),
    ).pipe(
      Effect.flatMap((captureScope) =>
        captureScope ? Scope.close(captureScope, Exit.void).pipe(Effect.ignore) : Effect.void,
      ),
      Effect.uninterruptible,
    );
  });

  const stopAllRecordings = Effect.fn("PreviewManager.stopAllRecordings")(function* () {
    pendingRecording = null;
    const sessions = yield* SynchronizedRef.get(frameCaptureSessionsRef);
    yield* Effect.forEach(sessions.keys(), (tabId) => stopFrameCapture(tabId, "recording"), {
      concurrency: "unbounded",
      discard: true,
    });
  });

  const resolveArtifactPath = (artifactPath: string) =>
    attempt({ operation: "resolveArtifactPath", artifactPath }, () => {
      const resolvedPath = path.resolve(artifactPath);
      const relativePath = path.relative(resolvedArtifactDirectory, resolvedPath);
      if (
        relativePath.length === 0 ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        return null;
      }
      return resolvedPath;
    }).pipe(
      Effect.filterOrFail(
        (resolvedPath) => resolvedPath !== null,
        () =>
          new PreviewArtifactPathOutsideDirectoryError({
            artifactPath,
            artifactDirectory: resolvedArtifactDirectory,
          }),
      ),
    );

  const captureStillImage = Effect.fn("PreviewManager.captureStillImage")(function* (
    errorContext: PreviewOperationContext,
    tabId: string,
    wc: Electron.WebContents,
  ) {
    const consumer = Symbol("still-image");
    return yield* Effect.acquireUseRelease(
      startFrameCapture(tabId, consumer),
      () =>
        Effect.gen(function* () {
          // A DOM mutation can precede its compositor frame even in a shown
          // window. Keep the original guest rendering through the next paint;
          // a hidden guest otherwise returns old pixels or never completes.
          const probe = Effect.fn("PreviewManager.probeStillImagePaint")(function* (
            send: (
              method: string,
              params?: Record<string, unknown>,
            ) => Effect.Effect<unknown, PreviewOperationError>,
          ) {
            // CDP executes against the current document without Electron's
            // did-stop-loading gate. Isolate scheduling globals from page code.
            const tree = (yield* send("Page.getFrameTree")) as
              | { frameTree?: { frame?: { id?: string } } }
              | undefined;
            const frameId = tree?.frameTree?.frame?.id;
            if (typeof frameId !== "string")
              return yield* new PreviewOperationError({
                ...errorContext,
                cause: new Error("The preview paint frame is unavailable."),
              });
            const world = (yield* send("Page.createIsolatedWorld", {
              frameId,
              worldName: "zerocode-preview-still-image",
            })) as { executionContextId?: number } | undefined;
            if (typeof world?.executionContextId !== "number")
              return yield* new PreviewOperationError({
                ...errorContext,
                cause: new Error("The preview paint context is unavailable."),
              });
            const response = (yield* send("Runtime.evaluate", {
              // Settle and release scheduled work when only timers keep running.
              // The outer deadline still bounds a frozen renderer.
              expression: `new Promise(resolve => { let frame; const timer = setTimeout(() => { cancelAnimationFrame(frame); resolve(false); }, ${CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS}); frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { clearTimeout(timer); resolve(true); }); }); })`,
              contextId: world.executionContextId,
              awaitPromise: true,
              returnByValue: true,
            })) as { result?: { value?: unknown }; exceptionDetails?: unknown } | undefined;
            if (response?.exceptionDetails || response?.result?.value !== true)
              return yield* new PreviewOperationError({
                ...errorContext,
                cause: new Error("The preview paint boundary was not confirmed."),
              });
          });
          const paintReady = Effect.gen(function* () {
            // Only use an existing owned session; never attach or displace
            // another debugger to obtain a screenshot.
            const control = (yield* SynchronizedRef.get(controlSessionsRef)).get(wc.id);
            if (!control)
              return yield* new PreviewOperationError({
                ...errorContext,
                cause: new Error("The preview paint session is unavailable."),
              });
            return yield* probe((method, params) =>
              attemptPromise(errorContext, () => control.debugger.sendCommand(method, params)),
            );
          }).pipe(
            Effect.timeout(CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS),
            Effect.catch((error) =>
              Effect.logWarning(
                "Preview paint readiness was not confirmed; capturing available pixels with mutation freshness unconfirmed.",
                { tabId, webContentsId: wc.id, error },
              ),
            ),
          );
          // Minimized guests can suspend frames even with throttling disabled.
          // A native capture can resume them; discard its pixels and read again
          // after the bounded paint probe.
          const warmup = capturePageWithRetry(errorContext, tabId, wc).pipe(
            Effect.catchTags({
              PreviewOperationError: (error) =>
                Effect.logWarning("Preview warmup capture failed; continuing with final capture.", {
                  tabId,
                  webContentsId: wc.id,
                  error,
                }),
            }),
          );
          yield* Effect.all([paintReady, warmup], { concurrency: 2, discard: true });
          return yield* capturePageWithRetry(errorContext, tabId, wc);
        }),
      () => stopFrameCapture(tabId, consumer),
    );
  });

  const captureScreenshot = Effect.fn("PreviewManager.captureScreenshot")(function* (
    tabId: string,
  ) {
    const wc = yield* requireWebContents(tabId);
    const [createdAt, millis, image] = yield* Effect.all([
      currentIso,
      currentMillis,
      captureStillImage(
        {
          operation: "captureScreenshot.capturePage",
          tabId,
          webContentsId: wc.id,
        },
        tabId,
        wc,
      ),
    ]);
    const uuid = yield* random.uuidV4();
    const id = `browser-screenshot-${artifactSiteSlug(wc.getURL())}-${millis.toString(36)}-${uuid.slice(0, 8)}`;
    const artifactPath = path.join(resolvedArtifactDirectory, `${id}.png`);
    const data = image.toPNG();
    yield* fileSystem.makeDirectory(resolvedArtifactDirectory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: "captureScreenshot.makeDirectory",
            tabId,
            webContentsId: wc.id,
            artifactPath,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFile(artifactPath, data).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: "captureScreenshot.writeFile",
            tabId,
            webContentsId: wc.id,
            artifactPath,
            cause,
          }),
      ),
    );
    return {
      id,
      tabId,
      path: artifactPath,
      mimeType: "image/png" as const,
      sizeBytes: data.byteLength,
      createdAt,
    };
  });

  const clearPendingRecording = (tabId: string) => {
    if (pendingRecording?.tabId === tabId) pendingRecording = null;
  };

  /** Display-media requests lack tab identity; only one tab may arm a recording to prevent stream redirection. */
  const armPendingRecording = Effect.fn("PreviewManager.armPendingRecording")(function* (
    tabId: string,
    wc: Electron.WebContents,
    requestingFrameTreeNodeId: number,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const previous = pendingRecording;
    if (
      previous !== null &&
      previous.tabId !== tabId &&
      !previous.webContents.isDestroyed() &&
      now - previous.armedAtMillis < RECORDING_ARM_GRACE_MS
    ) {
      return yield* new PreviewRecordingArmConflictError({
        tabId,
        webContentsId: wc.id,
        armedTabId: previous.tabId,
      });
    }
    const armed: PendingRecording = {
      tabId,
      webContents: wc,
      requestingFrameTreeNodeId,
      armedAtMillis: now,
    };
    pendingRecording = armed;
    // The synchronous callback cannot read a clock. Compare identity so expiry cannot clobber a re-arm.
    yield* Effect.forkIn(
      Effect.sleep(RECORDING_ARM_GRACE_MS).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (pendingRecording === armed) pendingRecording = null;
          }),
        ),
      ),
      parentScope,
    );
  });

  // Only serve the tab armed by startRecording; pages must not capture independently.
  const installDisplayMediaRequestHandler = (session: Session) => {
    if (displayMediaHandlerSessions.has(session)) return;
    displayMediaHandlerSessions.add(session);
    session.setDisplayMediaRequestHandler((request, callback) => {
      const armed = pendingRecording;
      if (!armed) {
        callback({});
        return;
      }
      if (armed.webContents.isDestroyed()) {
        pendingRecording = null;
        callback({});
        return;
      }
      if (request.frame?.frameTreeNodeId !== armed.requestingFrameTreeNodeId) {
        callback({});
        return;
      }
      pendingRecording = null;
      callback({ video: armed.webContents.mainFrame });
    });
  };

  const startRecording = Effect.fn("PreviewManager.startRecording")(function* (
    tabId: string,
    options: RecordingInputOptions = DEFAULT_RECORDING_INPUT_OPTIONS,
  ) {
    if ((yield* Ref.get(closingTabIdsRef)).has(tabId)) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    return yield* withTabLifecycleLock(
      tabId,
      Effect.gen(function* () {
        yield* startFrameCapture(tabId, "recording");
        yield* SynchronizedRef.update(frameCaptureSessionsRef, (sessions) =>
          replaceMap(sessions, (copy) => {
            const current = copy.get(tabId);
            if (current) copy.set(tabId, { ...current, recordingInputOptions: options });
          }),
        );
        const wc = yield* requireWebContents(tabId);
        const requestWebContents = wc.hostWebContents;
        if (requestWebContents === null) {
          return yield* new PreviewMainWindowClosedError({ tabId });
        }
        const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
        yield* attempt({ operation: "recording.cursor", tabId, webContentsId: wc.id }, () => {
          wc.send(RECORDING_CURSOR_CHANNEL, true, options, tab?.controller);
          wc.send(HUMAN_INPUT_TRACKING_CHANNEL, true);
        });
        const warmupContext = { operation: "recording.warmSource", tabId, webContentsId: wc.id };
        yield* Effect.tryPromise({
          // Electron cannot cancel capturePage, but a stalled warmup must release the tab lock.
          try: (_signal) => wc.capturePage(),
          catch: (cause) => new PreviewOperationError({ ...warmupContext, cause }),
        }).pipe(
          Effect.timeout(CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS),
          Effect.catchTags({
            TimeoutError: (cause) =>
              Effect.fail(new PreviewOperationError({ ...warmupContext, cause })),
          }),
          Effect.retry({ times: 1 }),
          Effect.ignore,
        );
        const currentWebContents = yield* requireWebContents(tabId);
        if (currentWebContents !== wc || wc.isDestroyed()) {
          return yield* new PreviewWebContentsNotFoundError({
            tabId,
            webContentsId: wc.id,
          });
        }
        if (!isFrameCaptureWindowOpen() || requestWebContents.isDestroyed()) {
          return yield* new PreviewMainWindowClosedError({ tabId });
        }
        installDisplayMediaRequestHandler(requestWebContents.session);
        yield* armPendingRecording(tabId, wc, requestWebContents.mainFrame.frameTreeNodeId);
        const captureRequested = yield* attemptPromise(
          {
            operation: "recording.requestCapture",
            tabId,
            webContentsId: requestWebContents.id,
          },
          () =>
            requestWebContents.executeJavaScript(requestRecordingCaptureExpression(tabId), true),
        );
        if (captureRequested !== true) {
          return yield* new PreviewRecordingCaptureUnavailableError({
            tabId,
            webContentsId: requestWebContents.id,
          });
        }
      }).pipe(
        Effect.onError(() => {
          clearPendingRecording(tabId);
          return stopFrameCapture(tabId, "recording").pipe(Effect.ignore);
        }),
      ),
    );
  });

  const stopRecording = Effect.fn("PreviewManager.stopRecording")(function* (tabId: string) {
    // Clearing runs under the tab lock so it cannot land before an in-flight start arms.
    yield* withTabLifecycleLock(
      tabId,
      Effect.suspend(() => {
        clearPendingRecording(tabId);
        return stopFrameCapture(tabId, "recording");
      }),
    );
  });

  const saveRecording = Effect.fn("PreviewManager.saveRecording")(function* (
    tabId: string,
    mimeType: string,
    data: Uint8Array,
  ) {
    const [createdAt, millis] = yield* Effect.all([currentIso, currentMillis]);
    const uuid = yield* random.uuidV4();
    const id = `browser-recording-${millis.toString(36)}-${uuid.slice(0, 8)}`;
    const extension = recordingFileExtension(mimeType);
    const artifactPath = path.join(resolvedArtifactDirectory, `${id}.${extension}`);
    yield* fileSystem.makeDirectory(resolvedArtifactDirectory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: "saveRecording.makeDirectory",
            tabId,
            artifactPath,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFile(artifactPath, data, { flag: "wx" }).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: "saveRecording.writeFile",
            tabId,
            artifactPath,
            cause,
          }),
      ),
    );
    return {
      id,
      tabId,
      path: artifactPath,
      mimeType,
      sizeBytes: data.byteLength,
      createdAt,
    };
  });

  const revealArtifact = Effect.fn("PreviewManager.revealArtifact")(function* (
    artifactPath: string,
  ) {
    const resolvedPath = yield* resolveArtifactPath(artifactPath);
    yield* attempt({ operation: "revealArtifact", artifactPath: resolvedPath }, () =>
      shell.showItemInFolder(resolvedPath),
    );
  });

  const copyArtifactToClipboard = Effect.fn("PreviewManager.copyArtifactToClipboard")(function* (
    artifactPath: string,
  ) {
    const resolvedPath = yield* resolveArtifactPath(artifactPath);
    const image = yield* attempt(
      { operation: "copyArtifactToClipboard.load", artifactPath: resolvedPath },
      () => nativeImage.createFromPath(resolvedPath),
    );
    if (image.isEmpty()) {
      return yield* new PreviewArtifactImageLoadError({ artifactPath: resolvedPath });
    }
    yield* attemptPromise(
      { operation: "copyArtifactToClipboard.write", artifactPath: resolvedPath },
      () =>
        clipboard.write([
          new ClipboardItem({
            "image/png": new Blob([Uint8Array.from(image.toPNG())], { type: "image/png" }),
          }),
        ]),
    );
  });

  return {
    capturePageWithRetry,
    setWindowBackgroundThrottling,
    keepFrameCaptureWebContentsUnthrottled,
    startFrameCapture,
    stopFrameCapture,
    stopAllRecordings,
    captureScreenshot,
    clearPendingRecording,
    startRecording,
    stopRecording,
    saveRecording,
    revealArtifact,
    copyArtifactToClipboard,
  };
};
