import type { DesktopPreviewRecordingFrame } from "@zerocode/contracts/ipc";
import { BrowserWindow } from "electron";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import type * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { msg } from "gt-i18n";

import { m } from "../i18n/messages.ts";
import { PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL } from "../ipc/channels.ts";
import type * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import type * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import { fingerprintCapturedFrame } from "./PreviewCaptureHelpers.ts";
import {
  CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS,
  PreviewOperationError,
  attempt,
  attemptPromise,
  replaceMap,
  type BrowserControlSession,
  type FrameCaptureConsumer,
  type FrameCaptureSession,
  type PictureInPictureSession,
  type PreviewManagerError,
  type PreviewTabState,
} from "./PreviewTypes.ts";

const PICTURE_IN_PICTURE_FRAME_INTERVAL_MS = Math.ceil(1_000 / 12);
const PICTURE_IN_PICTURE_JPEG_QUALITY = 80;
const PICTURE_IN_PICTURE_INITIAL_WIDTH = 480;
const PICTURE_IN_PICTURE_INITIAL_HEIGHT = 320;
const PICTURE_IN_PICTURE_MIN_WIDTH = 240;
const PICTURE_IN_PICTURE_MIN_HEIGHT = 160;
const PICTURE_IN_PICTURE_ASPECT_RATIO_EPSILON = 0.002;

const buildPreviewPictureInPictureDataUrl = (): string => {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    >
    <meta name="color-scheme" content="dark">
    <style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #111; }
      body { display: grid; place-items: center; }
      img { width: 100%; height: 100%; object-fit: contain; user-select: none; -webkit-user-drag: none; }
    </style>
  </head>
  <body>
    <img id="preview-frame" alt="Live browser preview">
    <script>
      const frame = document.getElementById("preview-frame");
      window.previewPictureInPicture.onFrame((next) => {
        frame.src = "data:image/jpeg;base64," + next.data;
      });
    </script>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
};

export const fitPictureInPictureContentSize = (
  current: ReadonlyArray<number>,
  aspectRatio: number,
): readonly [width: number, height: number] => {
  const currentWidth = Math.max(1, current[0] ?? PICTURE_IN_PICTURE_INITIAL_WIDTH);
  const currentHeight = Math.max(1, current[1] ?? PICTURE_IN_PICTURE_INITIAL_HEIGHT);
  const currentArea = currentWidth * currentHeight;
  let width = Math.sqrt(currentArea * aspectRatio);
  let height = width / aspectRatio;
  const minimumScale = Math.max(
    1,
    PICTURE_IN_PICTURE_MIN_WIDTH / width,
    PICTURE_IN_PICTURE_MIN_HEIGHT / height,
  );
  width *= minimumScale;
  height *= minimumScale;
  return [Math.round(width), Math.round(height)];
};

export interface PreviewScreencastControllerDeps {
  readonly rendererHistory: DesktopRendererHistory.DesktopRendererHistory["Service"];
  readonly hostPlatform: NodeJS.Platform;
  readonly parentScope: Scope.Scope;
  readonly browserHost: DesktopBrowserHost.DesktopBrowserHost["Service"];
  readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly pictureInPicturePreloadPath: string;
  readonly tabsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, PreviewTabState>>;
  readonly controlSessionsRef: SynchronizedRef.SynchronizedRef<
    ReadonlyMap<number, BrowserControlSession>
  >;
  readonly frameCaptureSessionsRef: SynchronizedRef.SynchronizedRef<
    ReadonlyMap<string, FrameCaptureSession>
  >;
  readonly pictureInPictureSessionsRef: SynchronizedRef.SynchronizedRef<
    ReadonlyMap<string, PictureInPictureSession>
  >;
  readonly pictureInPictureAspectRatiosRef: Ref.Ref<ReadonlyMap<string, number>>;
  readonly pictureInPictureMutationSemaphore: Semaphore.Semaphore;
  readonly activePictureInPictureScreencasts: Map<number, Set<Scope.Closeable>>;
  readonly currentIso: Effect.Effect<string>;
  readonly update: (tabId: string, patch: Partial<PreviewTabState>) => Effect.Effect<void>;
  readonly requireWebContents: (
    tabId: string,
  ) => Effect.Effect<Electron.WebContents, PreviewManagerError>;
  readonly startFrameCapture: (
    tabId: string,
    consumer: FrameCaptureConsumer,
    onStartPictureInPicture?: (
      tabId: string,
      wc: Electron.WebContents,
      scope: Scope.Closeable,
    ) => Effect.Effect<void>,
  ) => Effect.Effect<void, PreviewManagerError>;
  readonly stopFrameCapture: (tabId: string, consumer: FrameCaptureConsumer) => Effect.Effect<void>;
  readonly ensureControlSession: (
    wc: Electron.WebContents,
  ) => Effect.Effect<BrowserControlSession, PreviewManagerError>;
  readonly detachControlSession: (
    webContentsId: number,
    closedServerTab?: PreviewTabState["serverTab"],
  ) => Effect.Effect<void>;
  readonly recoverDetachedControlSession: (
    wc: Electron.WebContents,
    detached: BrowserControlSession,
  ) => Effect.Effect<void>;
}

export const makePreviewScreencastController = (deps: PreviewScreencastControllerDeps) => {
  const {
    rendererHistory,
    hostPlatform,
    parentScope,
    browserHost,
    runFork,
    pictureInPicturePreloadPath,
    tabsRef,
    controlSessionsRef,
    frameCaptureSessionsRef,
    pictureInPictureSessionsRef,
    pictureInPictureAspectRatiosRef,
    pictureInPictureMutationSemaphore,
    activePictureInPictureScreencasts,
    currentIso,
    update,
    requireWebContents,
    startFrameCapture,
    stopFrameCapture,
    ensureControlSession,
    detachControlSession,
    recoverDetachedControlSession,
  } = deps;

  const deliverPictureInPictureFrame = Effect.fn("PreviewManager.deliverPictureInPictureFrame")(
    function* (
      tabId: string,
      webContentsId: number,
      frame: DesktopPreviewRecordingFrame,
      onDelivered?: Effect.Effect<void>,
    ) {
      const pictureInPictureWindow = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(
        tabId,
      )?.window;
      if (!pictureInPictureWindow || pictureInPictureWindow.isDestroyed()) return;
      yield* Effect.gen(function* () {
        const previousAspectRatio = (yield* Ref.get(pictureInPictureAspectRatiosRef)).get(tabId);
        const aspectRatio = frame.width / frame.height;
        if (
          previousAspectRatio === undefined ||
          Math.abs(previousAspectRatio - aspectRatio) > PICTURE_IN_PICTURE_ASPECT_RATIO_EPSILON
        ) {
          yield* attempt(
            {
              operation: "pictureInPicture.setAspectRatio",
              tabId,
              webContentsId,
            },
            () => {
              const contentSize = fitPictureInPictureContentSize(
                pictureInPictureWindow.getContentSize(),
                aspectRatio,
              );
              pictureInPictureWindow.setAspectRatio(0);
              pictureInPictureWindow.setContentSize(contentSize[0], contentSize[1], false);
              pictureInPictureWindow.setAspectRatio(aspectRatio);
            },
          );
          yield* Ref.update(pictureInPictureAspectRatiosRef, (aspectRatios) =>
            replaceMap(aspectRatios, (copy) => {
              copy.set(tabId, aspectRatio);
            }),
          );
        }
        yield* attempt(
          {
            operation: "pictureInPicture.deliverFrame",
            tabId,
            webContentsId,
          },
          () => {
            pictureInPictureWindow.webContents.send(
              PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL,
              frame,
            );
          },
        );
        if (onDelivered) yield* onDelivered;
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Picture-in-picture frame delivery failed.", {
            tabId,
            error,
          }),
        ),
      );
    },
  );

  const capturePreviewFrame = Effect.fn("PreviewManager.capturePreviewFrame")(function* (
    tabId: string,
  ) {
    const captureSession = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
    if (!captureSession?.consumers.has("picture-in-picture") || captureSession.scope === null)
      return;
    const wc = yield* requireWebContents(tabId);
    const captureContext = { operation: "frameCapture.capturePage", tabId, webContentsId: wc.id };
    const image = yield* attemptPromise(captureContext, () => wc.capturePage()).pipe(
      Effect.timeout(CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS),
      Effect.catchTags({
        TimeoutError: (cause) =>
          Effect.fail(new PreviewOperationError({ ...captureContext, cause })),
      }),
    );
    const currentCaptureSession = yield* Effect.all(
      [SynchronizedRef.get(frameCaptureSessionsRef), SynchronizedRef.get(tabsRef)],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([captureSessions, tabs]) => {
        const current = captureSessions.get(tabId);
        return current?.scope === captureSession.scope &&
          tabs.get(tabId)?.webContentsId === wc.id &&
          !wc.isDestroyed()
          ? current
          : undefined;
      }),
    );
    if (!currentCaptureSession) return;
    const size = yield* attempt(
      {
        operation: "frameCapture.measureFrame",
        tabId,
        webContentsId: wc.id,
      },
      () => image.getSize(),
    );
    if (
      !Number.isFinite(size.width) ||
      !Number.isFinite(size.height) ||
      size.width <= 0 ||
      size.height <= 0
    ) {
      return;
    }
    const frameSession = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
    if (frameSession?.scope !== captureSession.scope) return;
    // Fingerprint before encoding so unchanged frames skip JPEG, base64, and IPC; unreadable frames must still be sent.
    const fingerprint = fingerprintCapturedFrame(image, size);
    const pictureInPicture =
      frameSession.consumers.has("picture-in-picture") &&
      (fingerprint === null || frameSession.lastPictureInPictureFingerprint !== fingerprint);
    if (!pictureInPicture) return;
    const encoded = yield* attempt(
      {
        operation: "frameCapture.encodeFrame",
        tabId,
        webContentsId: wc.id,
      },
      () => image.toJPEG(PICTURE_IN_PICTURE_JPEG_QUALITY),
    );
    const receivedAt = yield* currentIso;
    const frame: DesktopPreviewRecordingFrame = {
      tabId,
      data: encoded.toString("base64"),
      width: size.width,
      height: size.height,
      receivedAt,
    };
    yield* deliverPictureInPictureFrame(
      tabId,
      wc.id,
      frame,
      SynchronizedRef.update(frameCaptureSessionsRef, (sessions) => {
        if (sessions.get(tabId) !== frameSession) return sessions;
        return replaceMap(sessions, (copy) => {
          copy.set(tabId, {
            ...frameSession,
            lastPictureInPictureFingerprint: fingerprint,
            lastPictureInPictureFrame: frame,
          });
        });
      }),
    );
  });

  const startPictureInPicturePolling = Effect.fn("PreviewManager.startPictureInPicturePolling")(
    function* (tabId: string, scope: Scope.Closeable) {
      const captureNextFrame = Effect.sleep(PICTURE_IN_PICTURE_FRAME_INTERVAL_MS).pipe(
        Effect.andThen(capturePreviewFrame(tabId)),
        Effect.catch((error) =>
          Effect.logWarning("Background preview frame capture failed.", {
            tabId,
            error,
          }),
        ),
      );
      yield* Effect.forkIn(Effect.forever(captureNextFrame), scope);
      yield* capturePreviewFrame(tabId).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Initial background preview frame was not ready; capture will retry.", {
            tabId,
            consumer: "picture-in-picture",
            error,
          }),
        ),
      );
    },
  );

  const tryStartPictureInPictureScreencast = Effect.fn(
    "PreviewManager.tryStartPictureInPictureScreencast",
  )(function* (
    tabId: string,
    wc: Electron.WebContents,
    scope: Scope.Closeable,
  ): Effect.fn.Return<boolean> {
    if (
      wc.isDestroyed() ||
      typeof wc.isDevToolsOpened !== "function" ||
      typeof wc.debugger?.attach !== "function" ||
      typeof wc.debugger?.sendCommand !== "function" ||
      typeof wc.debugger?.on !== "function" ||
      typeof wc.debugger?.off !== "function"
    ) {
      return false;
    }
    return yield* Effect.gen(function* () {
      const existedBefore = (yield* SynchronizedRef.get(controlSessionsRef)).has(wc.id);
      const control = yield* ensureControlSession(wc);
      const wcDebugger = control.debugger;
      const screencastScope = yield* Scope.fork(scope, "sequential");
      let detachedByChromium = false;
      let screencastStarted = false;
      let stopped = false;
      let pendingFrame: {
        readonly ackId: number | undefined;
        readonly data: string;
        readonly width: number;
        readonly height: number;
      } | null = null;
      const frameAvailable = yield* Queue.sliding<void>(1);
      const ack = (ackId: number | undefined) => {
        if (ackId === undefined) return;
        void wcDebugger
          .sendCommand("Page.screencastFrameAck", { sessionId: ackId })
          .catch(() => {});
      };
      const onMessage = (
        _event: Electron.Event,
        method: string,
        params: Record<string, unknown>,
        sessionId?: string,
      ) => {
        if (stopped || sessionId || method !== "Page.screencastFrame") return;
        const ackId = typeof params?.["sessionId"] === "number" ? params["sessionId"] : undefined;
        const data = params?.["data"];
        const metadata = params?.["metadata"] as
          | { readonly deviceWidth?: unknown; readonly deviceHeight?: unknown }
          | undefined;
        const width = metadata?.deviceWidth;
        const height = metadata?.deviceHeight;
        if (
          typeof data !== "string" ||
          data.length === 0 ||
          typeof width !== "number" ||
          !Number.isFinite(width) ||
          width <= 0 ||
          typeof height !== "number" ||
          !Number.isFinite(height) ||
          height <= 0
        ) {
          ack(ackId);
          return;
        }
        if (pendingFrame !== null) ack(pendingFrame.ackId);
        pendingFrame = { ackId, data, width, height };
        Queue.offerUnsafe(frameAvailable, undefined);
      };
      const onDetach = () => {
        if (stopped) return;
        detachedByChromium = true;
        runFork(
          Scope.close(screencastScope, Exit.void).pipe(
            Effect.andThen(recoverDetachedControlSession(wc, control)),
            Effect.andThen(recoverPictureInPictureCapture(tabId, scope)),
            Effect.ignore,
          ),
        );
      };
      yield* Scope.addFinalizer(
        screencastScope,
        Effect.gen(function* () {
          stopped = true;
          const activeScopes = activePictureInPictureScreencasts.get(wc.id);
          activeScopes?.delete(screencastScope);
          if (activeScopes?.size === 0) activePictureInPictureScreencasts.delete(wc.id);
          yield* attempt(
            { operation: "pictureInPicture.stopScreencast", tabId, webContentsId: wc.id },
            () => {
              wcDebugger.off("message", onMessage);
              wcDebugger.off("detach", onDetach);
            },
          ).pipe(Effect.ignore);
          if (pendingFrame !== null) {
            ack(pendingFrame.ackId);
            pendingFrame = null;
          }
          yield* SynchronizedRef.update(frameCaptureSessionsRef, (sessions) => {
            const current = sessions.get(tabId);
            if (
              !current ||
              current.scope !== scope ||
              current.screencastScope !== screencastScope
            ) {
              return sessions;
            }
            return replaceMap(sessions, (copy) => {
              copy.set(tabId, {
                ...current,
                screencastScope: null,
                screencastWebContentsId: null,
              });
            });
          });
          const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
          const keepScreencast =
            tab?.serverTab !== undefined && browserHost.hasActiveScreencast(tab.serverTab);
          if (screencastStarted && !detachedByChromium && !keepScreencast) {
            yield* attemptPromise(
              { operation: "pictureInPicture.stopScreencast", tabId, webContentsId: wc.id },
              () => wcDebugger.sendCommand("Page.stopScreencast"),
            ).pipe(Effect.ignore);
          }
          if (
            !existedBefore &&
            !detachedByChromium &&
            tab?.serverTab === undefined &&
            (tab?.colorScheme ?? "system") === "system"
          ) {
            yield* detachControlSession(wc.id);
          }
        }),
      );
      if (stopped) return true;
      yield* attempt(
        { operation: "pictureInPicture.listenScreencast", tabId, webContentsId: wc.id },
        () => {
          wcDebugger.on("message", onMessage);
          wcDebugger.on("detach", onDetach);
        },
      ).pipe(Effect.onError(() => Scope.close(screencastScope, Exit.void).pipe(Effect.ignore)));
      yield* attemptPromise(
        { operation: "pictureInPicture.startScreencast", tabId, webContentsId: wc.id },
        () =>
          wcDebugger.sendCommand("Page.startScreencast", {
            format: "jpeg",
            quality: PICTURE_IN_PICTURE_JPEG_QUALITY,
            everyNthFrame: 1,
          }),
      ).pipe(
        Effect.timeout(CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS),
        Effect.onError(() => Scope.close(screencastScope, Exit.void).pipe(Effect.ignore)),
      );
      if (stopped) {
        const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
        const keepScreencast =
          tab?.serverTab !== undefined && browserHost.hasActiveScreencast(tab.serverTab);
        if (!detachedByChromium && !keepScreencast) {
          yield* attemptPromise(
            { operation: "pictureInPicture.stopScreencast", tabId, webContentsId: wc.id },
            () => wcDebugger.sendCommand("Page.stopScreencast"),
          ).pipe(Effect.ignore);
        }
        return true;
      }
      screencastStarted = true;
      const activeScopes = activePictureInPictureScreencasts.get(wc.id) ?? new Set();
      activeScopes.add(screencastScope);
      activePictureInPictureScreencasts.set(wc.id, activeScopes);
      const committed = yield* SynchronizedRef.modify(frameCaptureSessionsRef, (sessions) => {
        const current = sessions.get(tabId);
        if (!current || current.scope !== scope || !current.consumers.has("picture-in-picture")) {
          return [false, sessions] as const;
        }
        return [
          true,
          replaceMap(sessions, (copy) => {
            copy.set(tabId, {
              ...current,
              screencastScope,
              screencastWebContentsId: wc.id,
            });
          }),
        ] as const;
      });
      if (!committed) {
        yield* Scope.close(screencastScope, Exit.void).pipe(Effect.ignore);
        return true;
      }
      yield* Effect.forkIn(
        Effect.forever(
          Queue.take(frameAvailable).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const next = pendingFrame;
                if (next === null) return;
                pendingFrame = null;
                const [captureSessions, tabs] = yield* Effect.all(
                  [SynchronizedRef.get(frameCaptureSessionsRef), SynchronizedRef.get(tabsRef)],
                  { concurrency: 2 },
                );
                const activeSession = captureSessions.get(tabId);
                if (
                  activeSession?.scope !== scope ||
                  !activeSession.consumers.has("picture-in-picture") ||
                  tabs.get(tabId)?.webContentsId !== wc.id ||
                  wc.isDestroyed()
                ) {
                  ack(next.ackId);
                  return;
                }
                const receivedAt = yield* currentIso;
                const frame: DesktopPreviewRecordingFrame = {
                  tabId,
                  data: next.data,
                  width: next.width,
                  height: next.height,
                  receivedAt,
                };
                yield* deliverPictureInPictureFrame(
                  tabId,
                  wc.id,
                  frame,
                  SynchronizedRef.update(frameCaptureSessionsRef, (sessions) => {
                    const current = sessions.get(tabId);
                    if (!current || current.scope !== scope) return sessions;
                    return replaceMap(sessions, (copy) => {
                      copy.set(tabId, { ...current, lastPictureInPictureFrame: frame });
                    });
                  }),
                );
                ack(next.ackId);
              }),
            ),
          ),
        ),
        screencastScope,
      );
      return true;
    }).pipe(Effect.orElseSucceed(() => false));
  });

  const startPictureInPictureCapture = Effect.fn("PreviewManager.startPictureInPictureCapture")(
    function* (tabId: string, wc: Electron.WebContents, scope: Scope.Closeable) {
      if (yield* tryStartPictureInPictureScreencast(tabId, wc, scope)) return;
      const current = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
      if (current?.scope !== scope || !current.consumers.has("picture-in-picture")) return;
      yield* startPictureInPicturePolling(tabId, scope);
    },
  );

  const recoverPictureInPictureCapture: (
    tabId: string,
    scope: Scope.Closeable,
  ) => Effect.Effect<void> = Effect.fn("PreviewManager.recoverPictureInPictureCapture")(function* (
    tabId: string,
    scope: Scope.Closeable,
  ) {
    const session = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
    if (!session || session.scope !== scope || !session.consumers.has("picture-in-picture")) {
      return;
    }
    if (session.screencastScope !== null) {
      yield* Scope.close(session.screencastScope, Exit.void).pipe(Effect.ignore);
    }
    const wc = yield* requireWebContents(tabId).pipe(Effect.option);
    if (Option.isNone(wc) || wc.value.isDestroyed()) return;
    const latest = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
    if (!latest || latest.scope !== scope || !latest.consumers.has("picture-in-picture")) return;
    if (latest.screencastWebContentsId === wc.value.id) return;
    yield* startPictureInPictureCapture(tabId, wc.value, scope);
  });

  const releasePictureInPicture = Effect.fn("PreviewManager.releasePictureInPicture")(function* (
    tabId: string,
    expectedSession: PictureInPictureSession,
    closeWindow: boolean,
  ) {
    const removed = yield* SynchronizedRef.modify(pictureInPictureSessionsRef, (sessions) => {
      if (sessions.get(tabId) !== expectedSession) {
        return [false, sessions] as const;
      }
      return [
        true,
        replaceMap(sessions, (copy) => {
          copy.delete(tabId);
        }),
      ] as const;
    });
    if (!removed) return;
    yield* Deferred.interrupt(expectedSession.ready);
    yield* Scope.close(expectedSession.initializationScope, Exit.void).pipe(Effect.ignore);
    yield* Ref.update(pictureInPictureAspectRatiosRef, (aspectRatios) =>
      replaceMap(aspectRatios, (copy) => {
        copy.delete(tabId);
      }),
    );
    yield* stopFrameCapture(tabId, "picture-in-picture");
    const tabs = yield* SynchronizedRef.get(tabsRef);
    if (tabs.has(tabId)) {
      yield* update(tabId, { pictureInPicture: false });
    }
    if (closeWindow && !expectedSession.window.isDestroyed()) {
      yield* attempt({ operation: "pictureInPicture.close", tabId }, () =>
        expectedSession.window.close(),
      ).pipe(Effect.ignore);
    }
  });

  const closePictureInPictureUnlocked = Effect.fn("PreviewManager.closePictureInPictureUnlocked")(
    function* (tabId: string) {
      const pictureInPictureSession = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(
        tabId,
      );
      if (!pictureInPictureSession) {
        yield* stopFrameCapture(tabId, "picture-in-picture");
        const tabs = yield* SynchronizedRef.get(tabsRef);
        if (tabs.has(tabId)) {
          yield* update(tabId, { pictureInPicture: false });
        }
        return;
      }
      yield* releasePictureInPicture(tabId, pictureInPictureSession, true);
    },
  );

  const closePictureInPicture = Effect.fn("PreviewManager.closePictureInPicture")(function* (
    tabId: string,
  ) {
    yield* pictureInPictureMutationSemaphore.withPermit(closePictureInPictureUnlocked(tabId));
  });

  const closeAllPictureInPicture = Effect.fn("PreviewManager.closeAllPictureInPicture")(
    function* () {
      const sessions = yield* SynchronizedRef.get(pictureInPictureSessionsRef);
      yield* Effect.forEach(sessions.keys(), closePictureInPicture, {
        concurrency: "unbounded",
        discard: true,
      });
    },
  );

  const openPictureInPicture = Effect.fn("PreviewManager.openPictureInPicture")(function* (
    tabId: string,
  ) {
    const claim = yield* pictureInPictureMutationSemaphore.withPermit(
      Effect.gen(function* () {
        const existing = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(tabId);
        if (existing && !existing.window.isDestroyed()) {
          return { kind: "existing" as const, session: existing };
        }
        if (existing) {
          yield* releasePictureInPicture(tabId, existing, false);
        }
        const wc = yield* requireWebContents(tabId);
        const title = yield* attempt(
          {
            operation: "pictureInPicture.readTitle",
            tabId,
            webContentsId: wc.id,
          },
          () => wc.getTitle().trim(),
        );
        const pictureInPictureWindow = yield* attempt(
          {
            operation: "pictureInPicture.create",
            tabId,
            webContentsId: wc.id,
          },
          () =>
            new BrowserWindow({
              width: PICTURE_IN_PICTURE_INITIAL_WIDTH,
              height: PICTURE_IN_PICTURE_INITIAL_HEIGHT,
              minWidth: PICTURE_IN_PICTURE_MIN_WIDTH,
              minHeight: PICTURE_IN_PICTURE_MIN_HEIGHT,
              title:
                title.length > 0
                  ? m(msg("Preview · {title}"), { title })
                  : m(msg("Browser preview")),
              show: false,
              alwaysOnTop: true,
              autoHideMenuBar: true,
              fullscreenable: false,
              maximizable: false,
              minimizable: false,
              resizable: true,
              skipTaskbar: true,
              backgroundColor: "#111111",
              ...(hostPlatform === "darwin" ? { type: "panel" as const } : {}),
              webPreferences: {
                preload: pictureInPicturePreloadPath,
                backgroundThrottling: false,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
              },
            }),
        );
        yield* rendererHistory.register(pictureInPictureWindow.webContents, {
          surface: "picture-in-picture",
          tabId,
        });
        const initializationScope = yield* Scope.fork(parentScope, "sequential");
        const ready = yield* Deferred.make<void, PreviewManagerError>();
        const session: PictureInPictureSession = {
          window: pictureInPictureWindow,
          webContentsId: wc.id,
          ready,
          initializationScope,
        };
        const onClosed = () => {
          runFork(
            pictureInPictureMutationSemaphore.withPermit(
              releasePictureInPicture(tabId, session, false),
            ),
          );
        };
        const onDidFinishLoad = () => {
          runFork(
            Effect.gen(function* () {
              const current = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
              if (!current?.consumers.has("picture-in-picture")) return;
              if (current.lastPictureInPictureFrame !== null) {
                yield* deliverPictureInPictureFrame(
                  tabId,
                  session.webContentsId,
                  current.lastPictureInPictureFrame,
                );
              }
              yield* SynchronizedRef.update(frameCaptureSessionsRef, (sessions) => {
                const latest = sessions.get(tabId);
                if (!latest?.consumers.has("picture-in-picture")) return sessions;
                return replaceMap(sessions, (copy) => {
                  copy.set(tabId, { ...latest, lastPictureInPictureFingerprint: null });
                });
              });
            }),
          );
        };
        const pipWebContents = pictureInPictureWindow.webContents;
        yield* attempt(
          {
            operation: "pictureInPicture.configure",
            tabId,
            webContentsId: wc.id,
          },
          () => {
            pictureInPictureWindow.once("closed", onClosed);
            pictureInPictureWindow.setAlwaysOnTop(
              true,
              hostPlatform === "darwin" ? "floating" : "normal",
            );
            if (hostPlatform === "darwin") {
              pictureInPictureWindow.setVisibleOnAllWorkspaces(true, {
                visibleOnFullScreen: true,
                // Electron's temporary UIElement transformation would remove the app from the Dock.
                skipTransformProcessType: true,
              });
            }
            pipWebContents.on("did-finish-load", onDidFinishLoad);
          },
        ).pipe(
          Effect.onError(() =>
            Effect.all(
              [
                Scope.close(initializationScope, Exit.void).pipe(Effect.ignore),
                attempt({ operation: "pictureInPicture.close", tabId }, () =>
                  pictureInPictureWindow.close(),
                ).pipe(Effect.ignore),
              ],
              { discard: true },
            ),
          ),
        );
        yield* Scope.addFinalizer(
          initializationScope,
          Effect.sync(() => {
            pipWebContents.off("did-finish-load", onDidFinishLoad);
          }).pipe(Effect.ignore),
        );
        yield* SynchronizedRef.update(pictureInPictureSessionsRef, (sessions) =>
          replaceMap(sessions, (copy) => {
            copy.set(tabId, session);
          }),
        );
        return { kind: "created" as const, session };
      }),
    );
    const pictureInPictureSession = claim.session;
    if (claim.kind === "existing") {
      yield* Deferred.await(pictureInPictureSession.ready);
      return yield* pictureInPictureMutationSemaphore.withPermit(
        Effect.gen(function* () {
          const current = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(tabId);
          if (current !== pictureInPictureSession || pictureInPictureSession.window.isDestroyed()) {
            return yield* new PreviewOperationError({
              operation: "pictureInPicture.showExisting",
              tabId,
              webContentsId: pictureInPictureSession.webContentsId,
              cause: new Error("Picture-in-picture session closed before it became visible."),
            });
          }
          yield* attempt(
            {
              operation: "pictureInPicture.showExisting",
              tabId,
              webContentsId: pictureInPictureSession.webContentsId,
            },
            () => pictureInPictureSession.window.showInactive(),
          );
        }),
      );
    }

    const initialize = Effect.gen(function* () {
      yield* attemptPromise(
        {
          operation: "pictureInPicture.load",
          tabId,
          webContentsId: pictureInPictureSession.webContentsId,
        },
        () => pictureInPictureSession.window.loadURL(buildPreviewPictureInPictureDataUrl()),
      );
      const currentWebContents = yield* requireWebContents(tabId);
      if (
        currentWebContents.id !== pictureInPictureSession.webContentsId ||
        currentWebContents.isDestroyed()
      ) {
        return yield* new PreviewOperationError({
          operation: "pictureInPicture.validateWebContents",
          tabId,
          webContentsId: pictureInPictureSession.webContentsId,
          cause: new Error("Preview webview changed while picture-in-picture was opening."),
        });
      }
      yield* startFrameCapture(tabId, "picture-in-picture", startPictureInPictureCapture);
      yield* attempt(
        {
          operation: "pictureInPicture.show",
          tabId,
          webContentsId: pictureInPictureSession.webContentsId,
        },
        () => pictureInPictureSession.window.showInactive(),
      );
    });
    const initializationExit = yield* Effect.gen(function* () {
      const initializationFiber = yield* Effect.forkIn(
        initialize,
        pictureInPictureSession.initializationScope,
      );
      return yield* Fiber.await(initializationFiber);
    }).pipe(
      Effect.onInterrupt(() =>
        pictureInPictureMutationSemaphore.withPermit(
          releasePictureInPicture(tabId, pictureInPictureSession, true),
        ),
      ),
    );
    if (Exit.isSuccess(initializationExit)) {
      const published = yield* pictureInPictureMutationSemaphore.withPermit(
        Effect.gen(function* () {
          const current = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(tabId);
          if (current !== pictureInPictureSession || pictureInPictureSession.window.isDestroyed()) {
            if (current === pictureInPictureSession) {
              yield* releasePictureInPicture(tabId, pictureInPictureSession, false);
            }
            return false;
          }
          yield* update(tabId, { pictureInPicture: true });
          yield* Deferred.done(pictureInPictureSession.ready, initializationExit);
          return true;
        }),
      );
      if (published) return;
      return yield* Deferred.await(pictureInPictureSession.ready);
    }
    yield* Deferred.done(pictureInPictureSession.ready, initializationExit);
    const current = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(tabId);
    if (current === pictureInPictureSession) {
      yield* pictureInPictureMutationSemaphore.withPermit(
        releasePictureInPicture(tabId, pictureInPictureSession, true),
      );
    }
    return yield* Effect.failCause(initializationExit.cause);
  });

  return {
    recoverPictureInPictureCapture,
    closePictureInPicture,
    closeAllPictureInPicture,
    openPictureInPicture,
  };
};
