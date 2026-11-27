// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem.copyFile cannot request an exclusive copy.
import * as NodeFSP from "node:fs/promises";
import type {
  DesktopPreviewAnnotationTheme,
  DesktopPreviewAnnotationVoiceConfig,
  DesktopPreviewAnnotationVoiceState,
  DesktopPreviewColorScheme,
  DesktopPreviewFindResultEvent,
  DesktopPreviewOpenLinkEvent,
  DesktopPreviewRecordingArtifact,
  DesktopPreviewScreenshotArtifact,
  DesktopPreviewTabDefaults,
  PreviewAnnotationSubmissionResult,
} from "@zerocode/contracts/ipc";
import type { PreviewAutomationLoadError } from "@zerocode/contracts/preview";
import type { PreviewForwardedShortcut } from "@zerocode/contracts/server";
import * as HostProcess from "@zerocode/shared/HostProcess";
import { normalizePreviewUrl } from "@zerocode/shared/preview";
import { type BrowserWindow, app, type Session, shell, webContents } from "electron";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import {
  ANNOTATION_SEND_ENABLED_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  HUMAN_INPUT_TRACKING_CHANNEL,
} from "./GuestProtocol.ts";
import * as PreviewPasskeys from "./Passkeys.ts";
import { makePreviewAnnotationController } from "./PreviewAnnotationController.ts";
import { makePreviewAutomationController } from "./PreviewAutomationHelpers.ts";
import { makePreviewCaptureController } from "./PreviewCaptureHelpers.ts";
import {
  computeNavStatus,
  isPreviewEditingShortcut,
  makePreviewGuestListeners,
  previewWindowOpenAction,
} from "./PreviewGuestListeners.ts";
import {
  fitPictureInPictureContentSize,
  makePreviewScreencastController,
} from "./PreviewScreencastController.ts";
import {
  DEFAULT_ANNOTATION_THEME,
  DEFAULT_ZOOM_FACTOR,
  PreviewArtifactImageLoadError,
  PreviewArtifactPathOutsideDirectoryError,
  PreviewAutomationDebuggerAttachedError,
  PreviewAutomationDevToolsOpenError,
  PreviewAutomationEvaluationDetailKind,
  PreviewAutomationSelectorKind,
  PreviewMainWindowClosedError,
  PreviewManagerError,
  PreviewOperationError,
  PreviewRecordingArmConflictError,
  PreviewRecordingCaptureUnavailableError,
  PreviewTabNotFoundError,
  PreviewWebContentsNotFoundError,
  PreviewWebviewNotInitializedError,
  ZOOM_EPSILON,
  attempt,
  attemptPromise,
  nextZoomLevel,
  normalizeZoomFactor,
  replaceMap,
  type BrowserControlSession,
  type FindResultListener,
  type FrameCaptureSession,
  type Listener,
  type ManagedListeners,
  type OpenLinkListener,
  type PickSession,
  type PictureInPictureSession,
  type PointerEventListener,
  type PreviewEventKind,
  type PreviewNavStatus,
  type PreviewTabState,
  type RecordingInputListener,
} from "./PreviewTypes.ts";
import type { RecordingInputOptions } from "./RecordingInput.ts";

export {
  PreviewArtifactImageLoadError,
  PreviewArtifactPathOutsideDirectoryError,
  PreviewAutomationDebuggerAttachedError,
  PreviewAutomationDevToolsOpenError,
  PreviewAutomationEvaluationDetailKind,
  PreviewAutomationSelectorKind,
  PreviewMainWindowClosedError,
  PreviewManagerError,
  PreviewOperationError,
  PreviewRecordingArmConflictError,
  PreviewRecordingCaptureUnavailableError,
  PreviewTabNotFoundError,
  PreviewWebContentsNotFoundError,
  PreviewWebviewNotInitializedError,
  fitPictureInPictureContentSize,
  isPreviewEditingShortcut,
  previewWindowOpenAction,
  type PreviewNavStatus,
  type PreviewTabState,
};

const makeNativeOperations = Effect.fn("PreviewManager.makeOperations")(function* (
  artifactDirectory: string,
  pictureInPicturePreloadPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const rendererHistory = yield* DesktopRendererHistory.DesktopRendererHistory;
  const hostPlatform = yield* HostProcess.Platform;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const parentScope = yield* Scope.Scope;
  const browserHost = yield* DesktopBrowserHost.DesktopBrowserHost;
  const browserSession = yield* BrowserSession.BrowserSession;
  const passkeys = yield* PreviewPasskeys.PreviewPasskeys;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  const resolvedArtifactDirectory = path.resolve(artifactDirectory);

  let forwardedShortcuts: ReadonlyArray<PreviewForwardedShortcut> = [];
  const annotationThemeRef = yield* Ref.make(DEFAULT_ANNOTATION_THEME);
  const annotationSendEnabled = new Map<string, boolean>();
  const agentTrackedTabIds = new Set<string>();
  const mainWindowRef = yield* Ref.make<Option.Option<BrowserWindow>>(Option.none());
  const tabsRef = yield* SynchronizedRef.make<ReadonlyMap<string, PreviewTabState>>(new Map());
  const attachedRef = yield* Ref.make<ReadonlyMap<number, ManagedListeners>>(new Map());
  const listenersRef = yield* Ref.make<ReadonlySet<Listener>>(new Set());
  const pointerEventListenersRef = yield* Ref.make<ReadonlySet<PointerEventListener>>(new Set());
  const openLinkListenersRef = yield* Ref.make<ReadonlySet<OpenLinkListener>>(new Set());
  const findResultListenersRef = yield* Ref.make<ReadonlySet<FindResultListener>>(new Set());
  const recordingInputListenersRef = yield* Ref.make<ReadonlySet<RecordingInputListener>>(
    new Set(),
  );
  const pickSessionsRef = yield* Ref.make<ReadonlyMap<string, PickSession>>(new Map());
  const controlSessionsRef = yield* SynchronizedRef.make<
    ReadonlyMap<number, BrowserControlSession>
  >(new Map());
  const frameCaptureSessionsRef = yield* SynchronizedRef.make<
    ReadonlyMap<string, FrameCaptureSession>
  >(new Map());
  const pictureInPictureSessionsRef = yield* SynchronizedRef.make<
    ReadonlyMap<string, PictureInPictureSession>
  >(new Map());
  const pictureInPictureAspectRatiosRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const pictureInPictureMutationSemaphore = yield* Semaphore.make(1);
  const activePictureInPictureScreencasts = new Map<number, Set<Scope.Closeable>>();
  const closingTabIdsRef = yield* Ref.make<ReadonlySet<string>>(new Set());
  let frameCaptureWindowOpen = true;
  let currentMainWindow: BrowserWindow | undefined;
  let mainWindowCleanupFiber: Fiber.Fiber<void, never> | undefined;
  const tabLifecycleLocks = new Map<
    string,
    { readonly semaphore: Semaphore.Semaphore; users: number }
  >();
  const tabLifecycleGenerations = new Map<string, number>();
  // A guest can fail its first load before registerWebview installs its tab listeners.
  const guestLoadFailures = new Map<number, PreviewAutomationLoadError>();

  const currentIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const currentMillis = Clock.currentTimeMillis;

  const withTabLifecycleLock = <A, E, R>(
    tabId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const lifecycle = tabLifecycleLocks.get(tabId) ?? {
        semaphore: Semaphore.makeUnsafe(1),
        users: 0,
      };
      lifecycle.users += 1;
      tabLifecycleLocks.set(tabId, lifecycle);
      return lifecycle.semaphore.withPermit(effect).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lifecycle.users -= 1;
            if (lifecycle.users === 0 && tabLifecycleLocks.get(tabId) === lifecycle) {
              tabLifecycleLocks.delete(tabId);
            }
          }),
        ),
      );
    });

  const deliverEvent = (
    eventKind: PreviewEventKind,
    tabId: string,
    delivery: () => Effect.Effect<void>,
  ) =>
    Effect.suspend(delivery).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) =>
          Effect.logWarning("Desktop preview event listener failed.", {
            eventKind,
            tabId,
            cause,
          }),
      ),
    );

  const emit = Effect.fn("PreviewManager.emit")(function* (tabId: string, state: PreviewTabState) {
    const listeners = yield* Ref.get(listenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => deliverEvent("state-change", tabId, () => listener(tabId, state)),
      { discard: true },
    );
  });

  const emitIfCurrent = Effect.fn("PreviewManager.emitIfCurrent")(function* (
    tabId: string,
    state: PreviewTabState,
  ) {
    if ((yield* SynchronizedRef.get(tabsRef)).get(tabId) === state) {
      yield* emit(tabId, state);
    }
  });

  const update = Effect.fn("PreviewManager.update")(function* (
    tabId: string,
    patch: Partial<PreviewTabState>,
  ) {
    const updatedAt = yield* currentIso;
    const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const current = tabs.get(tabId);
      if (!current) return [Option.none<PreviewTabState>(), tabs] as const;
      const state: PreviewTabState = { ...current, ...patch, updatedAt };
      return [
        Option.some(state),
        replaceMap(tabs, (copy) => {
          copy.set(tabId, state);
        }),
      ] as const;
    });
    // syncTabAudible can commit after this update; emitIfCurrent prevents publishing a stale snapshot.
    if (Option.isSome(next)) {
      yield* emitIfCurrent(tabId, next.value);
    }
  });

  const emitOpenLink = Effect.fn("PreviewManager.emitOpenLink")(function* (
    event: DesktopPreviewOpenLinkEvent,
  ) {
    const listeners = yield* Ref.get(openLinkListenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => deliverEvent("open-link", event.tabId, () => listener(event)),
      { discard: true },
    );
  });

  const emitFindResult = Effect.fn("PreviewManager.emitFindResult")(function* (
    event: DesktopPreviewFindResultEvent,
  ) {
    const listeners = yield* Ref.get(findResultListenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => deliverEvent("find-result", event.tabId, () => listener(event)),
      { discard: true },
    );
  });

  /** Read zoom after awaits so concurrent zoom actions cannot be rolled back by an older snapshot. */
  const assertTabZoom = Effect.fn("PreviewManager.assertTabZoom")(function* (tabId: string) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab || tab.webContentsId == null) return;
    const wc = webContents.fromId(tab.webContentsId);
    if (!wc || wc.isDestroyed()) return;
    yield* attempt({ operation: "assertTabZoom", tabId, webContentsId: wc.id }, () =>
      wc.setZoomFactor(tab.zoomFactor),
    ).pipe(Effect.ignore);
  });

  /** Read committed mute and current guest at call time so stale snapshots cannot roll back newer actions. */
  const assertTabAudioMuted = Effect.fn("PreviewManager.assertTabAudioMuted")(function* (
    tabId: string,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab || tab.webContentsId == null) return;
    const wc = webContents.fromId(tab.webContentsId);
    if (!wc || wc.isDestroyed()) return;
    yield* attempt({ operation: "assertTabAudioMuted", tabId, webContentsId: wc.id }, () =>
      wc.setAudioMuted(tab.audioMuted),
    );
  });

  const syncTabAudible = Effect.fn("PreviewManager.syncTabAudible")(function* (
    tabId: string,
    wc: Electron.WebContents,
    audible: boolean,
  ) {
    if (wc.isDestroyed()) return;
    const updatedAt = yield* currentIso;
    const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const current = tabs.get(tabId);
      if (
        !current ||
        current.webContentsId !== wc.id ||
        webContents.fromId(wc.id) !== wc ||
        current.audible === audible
      ) {
        return [Option.none<PreviewTabState>(), tabs] as const;
      }
      const state: PreviewTabState = { ...current, audible, updatedAt };
      return [
        Option.some(state),
        replaceMap(tabs, (copy) => {
          copy.set(tabId, state);
        }),
      ] as const;
    });
    if (Option.isSome(next)) yield* emitIfCurrent(tabId, next.value);
  });

  const requireWebContents = Effect.fn("PreviewManager.requireWebContents")(function* (
    tabId: string,
  ) {
    const tabs = yield* SynchronizedRef.get(tabsRef);
    const tab = tabs.get(tabId);
    if (!tab) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    if (tab.webContentsId == null) {
      return yield* new PreviewWebviewNotInitializedError({ tabId });
    }
    const wc = webContents.fromId(tab.webContentsId);
    if (!wc) {
      return yield* new PreviewWebContentsNotFoundError({
        tabId,
        webContentsId: tab.webContentsId,
      });
    }
    return wc;
  });

  const tabIdForWebContents = Effect.fnUntraced(function* (webContentsId: number) {
    const tabs = yield* SynchronizedRef.get(tabsRef);
    return (
      Array.from(tabs.entries()).find(([, tab]) => tab.webContentsId === webContentsId)?.[0] ?? null
    );
  });

  const capture = makePreviewCaptureController({
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
    isFrameCaptureWindowOpen: () => frameCaptureWindowOpen,
    currentIso,
    currentMillis,
    withTabLifecycleLock,
    requireWebContents,
  });

  const automation = makePreviewAutomationController({
    parentScope,
    browserHost,
    browserSession,
    runFork,
    runPromise,
    tabsRef,
    pickSessionsRef,
    controlSessionsRef,
    frameCaptureSessionsRef,
    pointerEventListenersRef,
    agentTrackedTabIds,
    activePictureInPictureScreencasts,
    currentIso,
    deliverEvent,
    update,
    tabIdForWebContents,
    startFrameCapture: capture.startFrameCapture,
    stopFrameCapture: capture.stopFrameCapture,
  });

  const screencast = makePreviewScreencastController({
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
    startFrameCapture: capture.startFrameCapture,
    stopFrameCapture: capture.stopFrameCapture,
    ensureControlSession: automation.ensureControlSession,
    detachControlSession: automation.detachControlSession,
    recoverDetachedControlSession: automation.recoverDetachedControlSession,
  });

  const guestListeners = makePreviewGuestListeners({
    hostPlatform,
    parentScope,
    browserHost,
    passkeys,
    runFork,
    tabsRef,
    attachedRef,
    frameCaptureSessionsRef,
    recordingInputListenersRef,
    agentTrackedTabIds,
    getForwardedShortcuts: () => forwardedShortcuts,
    currentIso,
    currentMillis,
    deliverEvent,
    emitIfCurrent,
    emitOpenLink,
    emitFindResult,
    syncTabAudible,
  });

  const annotation = makePreviewAnnotationController({
    runFork,
    mainWindowRef,
    tabsRef,
    annotationThemeRef,
    pickSessionsRef,
    annotationSendEnabled,
    requireWebContents,
    capturePageWithRetry: capture.capturePageWithRetry,
  });

  const setMainWindow = Effect.fn("PreviewManager.setMainWindow")(function* (
    window: BrowserWindow,
  ) {
    if (mainWindowCleanupFiber) {
      yield* Fiber.join(mainWindowCleanupFiber);
      mainWindowCleanupFiber = undefined;
    }
    yield* SynchronizedRef.modifyEffect(frameCaptureSessionsRef, (sessions) =>
      Effect.gen(function* () {
        // Cleanup or lock acquisition can outlive the replacement window.
        if (window.isDestroyed()) return [undefined, sessions] as const;
        if (sessions.size > 0) {
          yield* capture.setWindowBackgroundThrottling(window, false);
        }
        yield* Ref.set(mainWindowRef, Option.some(window));
        currentMainWindow = window;
        frameCaptureWindowOpen = true;
        window.once("closed", () => {
          if (currentMainWindow !== window) return;
          currentMainWindow = undefined;
          frameCaptureWindowOpen = false;
          mainWindowCleanupFiber = runFork(
            Effect.all([screencast.closeAllPictureInPicture(), capture.stopAllRecordings()], {
              concurrency: "unbounded",
              discard: true,
            }).pipe(Effect.ignore),
          );
        });
        return [undefined, sessions] as const;
      }),
    ).pipe(Effect.uninterruptible);
  });

  const createTabUnlocked = Effect.fn("PreviewManager.createTabUnlocked")(function* (
    tabId: string,
    defaults?: DesktopPreviewTabDefaults,
  ) {
    const updatedAt = yield* currentIso;
    const result = yield* SynchronizedRef.modify(
      tabsRef,
      (
        tabs,
      ): readonly [
        { readonly state: PreviewTabState; readonly created: boolean },
        ReadonlyMap<string, PreviewTabState>,
      ] => {
        const existing = tabs.get(tabId);
        if (existing) return [{ state: existing, created: false }, tabs] as const;
        const initial: PreviewTabState = {
          tabId,
          webContentsId: null,
          navStatus: { kind: "Idle" },
          canGoBack: false,
          canGoForward: false,
          zoomFactor: normalizeZoomFactor(defaults?.zoomFactor),
          pictureInPicture: false,
          colorScheme: defaults?.colorScheme ?? "system",
          ...(defaults?.serverTab === undefined ? {} : { serverTab: defaults.serverTab }),
          audioMuted: false,
          audible: false,
          controller: "none",
          capturing: false,
          updatedAt,
        };
        return [
          { state: initial, created: true },
          replaceMap(tabs, (copy) => {
            copy.set(tabId, initial);
          }),
        ] as const;
      },
    );
    if (result.created) {
      tabLifecycleGenerations.set(tabId, (tabLifecycleGenerations.get(tabId) ?? 0) + 1);
    }
    yield* emit(tabId, result.state);
    return result.state;
  });

  const createTab = Effect.fn("PreviewManager.createTab")(function* (
    tabId: string,
    defaults?: DesktopPreviewTabDefaults,
  ) {
    return yield* withTabLifecycleLock(tabId, createTabUnlocked(tabId, defaults));
  });

  const closeTabUnlocked = Effect.fn("PreviewManager.closeTabUnlocked")(function* (tabId: string) {
    if (!(yield* SynchronizedRef.get(tabsRef)).has(tabId)) return;
    capture.clearPendingRecording(tabId);
    annotationSendEnabled.delete(tabId);
    agentTrackedTabIds.delete(tabId);
    yield* Effect.all(
      [
        annotation.cancelPickElement(tabId),
        screencast.closePictureInPicture(tabId),
        capture.stopFrameCapture(tabId, "recording"),
      ],
      {
        concurrency: 3,
        discard: true,
      },
    );
    const tab = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const current = tabs.get(tabId);
      if (!current) return [Option.none<PreviewTabState>(), tabs] as const;
      return [
        Option.some(current),
        replaceMap(tabs, (copy) => {
          copy.delete(tabId);
        }),
      ] as const;
    });
    if (Option.isNone(tab)) return;
    const closedTab = tab.value;
    if (closedTab.serverTab) {
      browserHost.setShown(closedTab.serverTab, undefined);
      browserHost.setCaptureDrawn(closedTab.serverTab, undefined);
    }
    if (closedTab.webContentsId != null) {
      yield* Effect.all(
        [
          automation.detachControlSession(closedTab.webContentsId, closedTab.serverTab),
          guestListeners.detachListeners(closedTab.webContentsId),
        ],
        { concurrency: 2, discard: true },
      );
    }
    const updatedAt = yield* currentIso;
    const closed: PreviewTabState = {
      ...closedTab,
      webContentsId: null,
      navStatus: { kind: "Idle" },
      canGoBack: false,
      canGoForward: false,
      zoomFactor: DEFAULT_ZOOM_FACTOR,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "none",
      capturing: false,
      updatedAt,
    };
    yield* emit(tabId, closed);
  });

  const closeTab = Effect.fn("PreviewManager.closeTab")(function* (tabId: string) {
    const claimed = yield* Ref.modify(closingTabIdsRef, (closingTabIds) => {
      if (closingTabIds.has(tabId)) return [false, closingTabIds] as const;
      return [true, new Set([...closingTabIds, tabId])] as const;
    });
    if (!claimed) return;
    return yield* withTabLifecycleLock(tabId, closeTabUnlocked(tabId)).pipe(
      Effect.ensuring(
        Ref.update(closingTabIdsRef, (closingTabIds) => {
          if (!closingTabIds.has(tabId)) return closingTabIds;
          const next = new Set(closingTabIds);
          next.delete(tabId);
          return next;
        }),
      ),
    );
  });

  const registerWebviewUnlocked = Effect.fn("PreviewManager.registerWebviewUnlocked")(function* (
    tabId: string,
    webContentsId: number,
    expectedGeneration: number | undefined,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (
      !tab ||
      tabLifecycleGenerations.get(tabId) !== expectedGeneration ||
      (yield* Ref.get(closingTabIdsRef)).has(tabId)
    ) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    const wc = webContents.fromId(webContentsId);
    const mainWindow = yield* Ref.get(mainWindowRef);
    if (
      !wc ||
      wc.isDestroyed() ||
      wc.getType() !== "webview" ||
      (Option.isSome(mainWindow) && wc.hostWebContents !== mainWindow.value.webContents)
    ) {
      return yield* new PreviewWebContentsNotFoundError({ tabId, webContentsId });
    }
    yield* rendererHistory.register(wc, { surface: "preview", tabId });
    const attached = yield* Ref.get(attachedRef);
    const annotationTheme = yield* Ref.get(annotationThemeRef);
    const currentAttachment = attached.get(webContentsId);
    yield* capture.keepFrameCaptureWebContentsUnthrottled(tabId, wc);
    if (tab.webContentsId === webContentsId && currentAttachment?.webContents === wc) {
      yield* assertTabZoom(tabId);
      const trackHumanInput =
        agentTrackedTabIds.has(tabId) ||
        (yield* SynchronizedRef.get(frameCaptureSessionsRef))
          .get(tabId)
          ?.consumers.has("recording") === true;
      yield* attempt({ operation: "registerWebview.sendTheme", tabId, webContentsId }, () => {
        wc.send(ANNOTATION_THEME_CHANNEL, annotationTheme);
        wc.send(ANNOTATION_SEND_ENABLED_CHANNEL, annotationSendEnabled.get(tabId) === true);
        if (trackHumanInput) wc.send(HUMAN_INPUT_TRACKING_CHANNEL, true);
      });
      return;
    }
    const replacedWebContentsId =
      tab.webContentsId != null &&
      (tab.webContentsId !== webContentsId || currentAttachment?.webContents !== wc)
        ? tab.webContentsId
        : null;
    if (replacedWebContentsId !== null) {
      capture.clearPendingRecording(tabId);
      yield* Effect.all(
        [
          automation.detachControlSession(replacedWebContentsId),
          guestListeners.detachListeners(replacedWebContentsId),
          annotation.cancelPickElement(tabId),
        ],
        { concurrency: 3, discard: true },
      );
    }
    const currentTab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (
      !currentTab ||
      tabLifecycleGenerations.get(tabId) !== expectedGeneration ||
      (yield* Ref.get(closingTabIdsRef)).has(tabId)
    ) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    // Restore the tab's zoom before publishing the guest so it never paints at inherited app zoom.
    yield* attempt({ operation: "registerWebview.restoreZoomFactor", tabId, webContentsId }, () =>
      wc.setZoomFactor(currentTab.zoomFactor),
    );
    // Replacement guests start unmuted; restore mute before publishing them.
    yield* attempt({ operation: "registerWebview.restoreAudioMuted", tabId, webContentsId }, () =>
      wc.setAudioMuted(currentTab.audioMuted),
    );
    yield* guestListeners.attachListeners(tabId, wc);
    const readAudible = attempt(
      { operation: "registerWebview.readAudible", tabId, webContentsId },
      () => wc.isCurrentlyAudible(),
    ).pipe(Effect.orElseSucceed(() => false));
    const attachedAudible = yield* readAudible;
    const registeredAt = yield* currentIso;
    const registration = yield* SynchronizedRef.modifyEffect(tabsRef, (tabs) =>
      Effect.gen(function* () {
        const current = tabs.get(tabId);
        if (
          !current ||
          tabLifecycleGenerations.get(tabId) !== expectedGeneration ||
          (yield* Ref.get(closingTabIdsRef)).has(tabId)
        ) {
          return [
            Option.none<{ readonly state: PreviewTabState; readonly pendingUrl: string | null }>(),
            tabs,
          ] as const;
        }
        const pendingUrl = current.navStatus.kind === "Loading" ? current.navStatus.url : null;
        const failure = guestLoadFailures.get(webContentsId);
        const { favicon: _favicon, ...currentWithoutFavicon } = current;
        const next: PreviewTabState = {
          ...currentWithoutFavicon,
          webContentsId,
          navStatus:
            failure && (pendingUrl === null || pendingUrl === failure.url)
              ? { kind: "LoadFailed", title: wc.getTitle(), ...failure }
              : pendingUrl === null
                ? computeNavStatus(wc)
                : current.navStatus,
          canGoBack: wc.navigationHistory.canGoBack(),
          canGoForward: wc.navigationHistory.canGoForward(),
          audible: attachedAudible,
          updatedAt: registeredAt,
        };
        return [
          Option.some({
            state: next,
            pendingUrl,
          }),
          replaceMap(tabs, (copy) => {
            copy.set(tabId, next);
          }),
        ] as const;
      }),
    );
    if (Option.isNone(registration)) {
      yield* Effect.all(
        [
          automation.detachControlSession(webContentsId),
          guestListeners.detachListeners(webContentsId),
        ],
        {
          concurrency: 2,
          discard: true,
        },
      );
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    const { state: registered, pendingUrl } = registration.value;
    // Concurrent actions targeted the previous guest; reconcile this one with committed zoom and mute.
    yield* assertTabZoom(tabId);
    yield* assertTabAudioMuted(tabId).pipe(Effect.ignore);
    runFork(automation.restoreControlSession(tabId, wc));
    yield* emitIfCurrent(tabId, registered);
    // Ownership checks dropped pre-attach audibility events; reconcile through the event path.
    yield* syncTabAudible(tabId, wc, yield* readAudible);
    const activeCapture = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
    if (
      activeCapture?.scope !== null &&
      activeCapture?.consumers.has("picture-in-picture") === true &&
      activeCapture.screencastWebContentsId !== null &&
      activeCapture.screencastWebContentsId !== webContentsId
    ) {
      runFork(screencast.recoverPictureInPictureCapture(tabId, activeCapture.scope));
    }
    const trackHumanInput =
      agentTrackedTabIds.has(tabId) || activeCapture?.consumers.has("recording") === true;
    yield* attempt({ operation: "registerWebview.sendTheme", tabId, webContentsId }, () => {
      wc.send(ANNOTATION_THEME_CHANNEL, annotationTheme);
      wc.send(ANNOTATION_SEND_ENABLED_CHANNEL, annotationSendEnabled.get(tabId) === true);
      if (trackHumanInput) wc.send(HUMAN_INPUT_TRACKING_CHANNEL, true);
    });
    const latestNavStatus = (yield* SynchronizedRef.get(tabsRef)).get(tabId)?.navStatus;
    if (
      pendingUrl &&
      latestNavStatus?.kind === "Loading" &&
      latestNavStatus.url === pendingUrl &&
      wc.getURL() !== pendingUrl
    ) {
      runFork(
        attemptPromise({ operation: "registerWebview.loadPendingUrl", tabId, webContentsId }, () =>
          wc.loadURL(pendingUrl),
        ).pipe(Effect.ignore),
      );
    }
  });

  const registerWebview = Effect.fn("PreviewManager.registerWebview")(function* (
    tabId: string,
    webContentsId: number,
  ) {
    const expectedGeneration = tabLifecycleGenerations.get(tabId);
    return yield* withTabLifecycleLock(
      tabId,
      registerWebviewUnlocked(tabId, webContentsId, expectedGeneration),
    );
  });

  // Clears a tab's dead guest so callers see "no webview" until the renderer registers a new one.
  const detachDestroyedWebContents = Effect.fn("PreviewManager.detachDestroyedWebContents")(
    function* (tabId: string, webContentsId: number) {
      const expectedAttachment = (yield* Ref.get(attachedRef)).get(webContentsId);
      yield* withTabLifecycleLock(
        tabId,
        Effect.gen(function* () {
          const currentTab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
          const currentAttachment = (yield* Ref.get(attachedRef)).get(webContentsId);
          const currentWebContents = webContents.fromId(webContentsId);
          if (
            currentTab?.webContentsId !== webContentsId ||
            currentAttachment !== expectedAttachment ||
            (currentWebContents && !currentWebContents.isDestroyed())
          ) {
            return;
          }
          yield* Effect.all(
            [
              automation.detachControlSession(webContentsId),
              guestListeners.detachListeners(webContentsId),
              annotation.cancelPickElement(tabId),
            ],
            { concurrency: 3, discard: true },
          );
          const detached = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
            const current = tabs.get(tabId);
            if (current?.webContentsId !== webContentsId) {
              return [Option.none<PreviewTabState>(), tabs] as const;
            }
            const { favicon: _favicon, ...currentWithoutFavicon } = current;
            const next: PreviewTabState = { ...currentWithoutFavicon, webContentsId: null };
            return [
              Option.some(next),
              replaceMap(tabs, (copy) => {
                copy.set(tabId, next);
              }),
            ] as const;
          });
          if (Option.isSome(detached)) yield* emitIfCurrent(tabId, detached.value);
        }),
      );
    },
  );

  // URL tabs can paint before registerWebview; set the background at attach time.
  const prepareWebview = Effect.fn("PreviewManager.prepareWebview")(function* (
    wc: Electron.WebContents,
  ) {
    yield* rendererHistory.register(wc, { surface: "preview" });
    const webContentsId = wc.id;
    wc.on("did-start-navigation", (event) => {
      if (event.isMainFrame && !event.isSameDocument) guestLoadFailures.delete(webContentsId);
    });
    wc.on("did-fail-load", (_event, code, description, validatedUrl, isMainFrame) => {
      if (code === -3 || !isMainFrame) return;
      guestLoadFailures.set(webContentsId, {
        url: validatedUrl || wc.getURL(),
        code,
        description,
      });
    });
    wc.once("destroyed", () => {
      guestLoadFailures.delete(webContentsId);
      runFork(
        Effect.gen(function* () {
          yield* automation.hideDestroyedGuest(webContentsId);
          const tabId = yield* tabIdForWebContents(webContentsId);
          if (tabId) yield* detachDestroyedWebContents(tabId, webContentsId);
        }),
      );
      runFork(automation.detachControlSession(webContentsId));
    });
    yield* automation.ensureControlSession(wc).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("Preview webview control session was not opened on attach.", {
          webContentsId,
          cause,
        }),
      ),
    );
  });

  const navigate = Effect.fn("PreviewManager.navigate")(function* (tabId: string, rawUrl: string) {
    const url = yield* attempt({ operation: "navigate.normalizeUrl", tabId }, () =>
      normalizePreviewUrl(rawUrl),
    );
    const updatedAt = yield* currentIso;
    const pending = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const current = tabs.get(tabId);
      const next: PreviewTabState = {
        tabId,
        webContentsId: current?.webContentsId ?? null,
        navStatus: {
          kind: "Loading",
          url,
          title: current?.navStatus.kind === "Idle" || !current ? "" : current.navStatus.title,
        },
        canGoBack: current?.canGoBack ?? false,
        canGoForward: current?.canGoForward ?? false,
        zoomFactor: current?.zoomFactor ?? DEFAULT_ZOOM_FACTOR,
        pictureInPicture: current?.pictureInPicture ?? false,
        colorScheme: current?.colorScheme ?? "system",
        // Keep audibility until Chromium replaces the document; clearing it here can lose the final transition.
        audioMuted: current?.audioMuted ?? false,
        audible: current?.audible ?? false,
        controller: current?.controller ?? "none",
        capturing: current?.capturing ?? false,
        ...(current?.favicon ? { favicon: current.favicon } : {}),
        ...(current?.serverTab ? { serverTab: current.serverTab } : {}),
        updatedAt,
      };
      return [
        next,
        replaceMap(tabs, (copy) => {
          copy.set(tabId, next);
        }),
      ] as const;
    });
    yield* emitIfCurrent(tabId, pending);
    if (pending.webContentsId == null) return;
    const webContentsId = pending.webContentsId;
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) {
      yield* detachDestroyedWebContents(tabId, webContentsId);
      return;
    }
    yield* automation.leaveBusyPage(wc);
    if (wc.getURL() === url) {
      yield* attempt({ operation: "navigate.reload", tabId, webContentsId: wc.id }, () =>
        wc.reload(),
      );
      return;
    }
    let unloadPrevented = false;
    const onPreventUnload = () => {
      unloadPrevented = true;
    };
    yield* attemptPromise({ operation: "navigate.loadURL", tabId, webContentsId: wc.id }, () => {
      wc.on("will-prevent-unload", onPreventUnload);
      return wc.loadURL(url);
    }).pipe(
      // Blocked unloads and superseding navigations both reject with ERR_ABORTED.
      Effect.catchIf(
        (error) =>
          !unloadPrevented &&
          Predicate.hasProperty(error.cause, "errno") &&
          error.cause.errno === -3,
        () => Effect.void,
      ),
      Effect.ensuring(Effect.sync(() => wc.off("will-prevent-unload", onPreventUnload))),
    );
  });

  const withWebContents = Effect.fn("PreviewManager.withWebContents")(function* (
    operation: string,
    tabId: string,
    use: (wc: Electron.WebContents) => void,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* attempt({ operation, tabId, webContentsId: wc.id }, () => use(wc));
  });

  const leavePage = Effect.fn("PreviewManager.leavePage")(function* (
    operation: string,
    tabId: string,
    use: (wc: Electron.WebContents) => void,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* automation.leaveBusyPage(wc);
    yield* attempt({ operation, tabId, webContentsId: wc.id }, () => use(wc));
  });

  const goBack = (tabId: string) =>
    leavePage("goBack", tabId, (wc) => {
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    });
  const goForward = (tabId: string) =>
    leavePage("goForward", tabId, (wc) => {
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    });
  const refresh = (tabId: string) => leavePage("refresh", tabId, (wc) => wc.reload());
  const stopLoading = (tabId: string) => withWebContents("stopLoading", tabId, (wc) => wc.stop());
  const hardReload = (tabId: string) =>
    leavePage("hardReload", tabId, (wc) => wc.reloadIgnoringCache());
  const findInPage = (
    tabId: string,
    text: string,
    options: { readonly forward: boolean; readonly newSession: boolean },
  ) =>
    withWebContents("findInPage", tabId, (wc) => {
      // Electron's `findNext` means "begin a new session", not "go to the next match".
      wc.findInPage(text, { forward: options.forward, findNext: options.newSession });
    });
  const stopFindInPage = (tabId: string) =>
    withWebContents("stopFindInPage", tabId, (wc) => wc.stopFindInPage("clearSelection")).pipe(
      Effect.catchTags({
        PreviewTabNotFoundError: () => Effect.void,
        PreviewWebContentsNotFoundError: () => Effect.void,
        PreviewWebviewNotInitializedError: () => Effect.void,
      }),
    );

  const openDevTools = Effect.fn("PreviewManager.openDevTools")(function* (tabId: string) {
    const wc = yield* requireWebContents(tabId);
    if (wc.isDevToolsOpened()) {
      yield* attempt({ operation: "openDevTools.focus", tabId, webContentsId: wc.id }, () =>
        wc.devToolsWebContents?.focus(),
      );
      return;
    }
    yield* automation.detachControlSession(wc.id);
    yield* attempt({ operation: "openDevTools", tabId, webContentsId: wc.id }, () => {
      wc.once("devtools-closed", () => {
        if (!wc.isDestroyed()) runFork(automation.restoreControlSession(tabId, wc));
      });
      wc.openDevTools({ mode: "detach" });
    });
  });

  const reapplyZoom = Effect.fn("PreviewManager.reapplyZoom")(function* () {
    const tabIds = Array.from((yield* SynchronizedRef.get(tabsRef)).keys());
    yield* Effect.forEach(tabIds, assertTabZoom, { discard: true });
  });

  const applyZoom = Effect.fn("PreviewManager.applyZoom")(function* (
    tabId: string,
    transform: (current: number) => number,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab) return;
    const next = transform(tab.zoomFactor);
    if (Math.abs(next - tab.zoomFactor) < ZOOM_EPSILON) return;
    if (tab.webContentsId != null) {
      const wc = webContents.fromId(tab.webContentsId);
      if (wc && !wc.isDestroyed()) {
        yield* attempt({ operation: "applyZoom", tabId, webContentsId: wc.id }, () =>
          wc.setZoomFactor(next),
        );
      }
    }
    yield* update(tabId, { zoomFactor: next });
  });

  const setAudioMuted = Effect.fn("PreviewManager.setAudioMuted")(function* (
    tabId: string,
    audioMuted: boolean,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    // Serialize commit/apply, then read committed mute so concurrent toggles cannot reach Chromium out of order.
    yield* withTabLifecycleLock(
      tabId,
      Effect.gen(function* () {
        const previous = (yield* SynchronizedRef.get(tabsRef)).get(tabId)?.audioMuted;
        const committed = previous !== undefined && previous !== audioMuted;
        if (committed) {
          yield* update(tabId, { audioMuted });
        }
        // Roll back rejected mute commits so the UI reflects actual playback.
        yield* assertTabAudioMuted(tabId).pipe(
          Effect.tapError(() =>
            committed ? update(tabId, { audioMuted: previous }) : Effect.void,
          ),
        );
      }),
    );
  });

  const subscribe = <A>(
    ref: Ref.Ref<ReadonlySet<A>>,
    listener: A,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
      Ref.update(ref, (listeners) => new Set([...listeners, listener])),
      () =>
        Ref.update(ref, (listeners) => {
          const next = new Set(listeners);
          next.delete(listener);
          return next;
        }),
    ).pipe(Effect.asVoid);

  const destroy = Effect.fn("PreviewManager.destroy")(function* () {
    const tabs = yield* SynchronizedRef.get(tabsRef);
    yield* Effect.forEach(tabs.keys(), closeTab, { discard: true });
    yield* Effect.all(
      [
        Ref.set(listenersRef, new Set()),
        Ref.set(pointerEventListenersRef, new Set()),
        Ref.set(openLinkListenersRef, new Set()),
        Ref.set(findResultListenersRef, new Set()),
        Ref.set(recordingInputListenersRef, new Set()),
      ],
      { discard: true },
    );
  });

  yield* Effect.addFinalizer(() => destroy().pipe(Effect.ignore));

  return {
    cancelPickElement: annotation.cancelPickElement,
    captureScreenshot: capture.captureScreenshot,
    closeTab,
    copyArtifactToClipboard: capture.copyArtifactToClipboard,
    createTab,
    findInPage,
    goBack,
    goForward,
    hardReload,
    navigate,
    openPictureInPicture: screencast.openPictureInPicture,
    openDevTools,
    pickElement: annotation.pickElement,
    updateAnnotationVoice: annotation.updateAnnotationVoice,
    prepareWebview,
    reapplyZoom,
    refresh,
    stopLoading,
    registerWebview,
    resetZoom: (tabId: string) => applyZoom(tabId, () => DEFAULT_ZOOM_FACTOR),
    setZoomFactor: (tabId: string, zoomFactor: number) =>
      applyZoom(tabId, () => normalizeZoomFactor(zoomFactor)),
    revealArtifact: capture.revealArtifact,
    saveRecording: capture.saveRecording,
    setAnnotationTheme: annotation.setAnnotationTheme,
    setAnnotationSendEnabled: annotation.setAnnotationSendEnabled,
    setAudioMuted,
    setShown: automation.setShown,
    setCaptureDrawn: automation.setCaptureDrawn,
    setColorScheme: automation.setColorScheme,
    setMainWindow,
    setForwardedShortcuts: (shortcuts: ReadonlyArray<PreviewForwardedShortcut>) =>
      Effect.sync(() => {
        forwardedShortcuts = shortcuts;
      }),
    startRecording: capture.startRecording,
    closePictureInPicture: screencast.closePictureInPicture,
    stopFindInPage,
    stopRecording: capture.stopRecording,
    subscribePointerEvents: (listener: PointerEventListener) =>
      subscribe(pointerEventListenersRef, listener),
    subscribeOpenLinks: (listener: OpenLinkListener) => subscribe(openLinkListenersRef, listener),
    subscribeFindResults: (listener: FindResultListener) =>
      subscribe(findResultListenersRef, listener),
    subscribeRecordingInputs: (listener: RecordingInputListener) =>
      subscribe(recordingInputListenersRef, listener),
    subscribeStateChanges: (listener: Listener) => subscribe(listenersRef, listener),
    zoomIn: (tabId: string) => applyZoom(tabId, (current) => nextZoomLevel(current, "in")),
    zoomOut: (tabId: string) => applyZoom(tabId, (current) => nextZoomLevel(current, "out")),
  };
});

export class PreviewManager extends Context.Service<
  PreviewManager,
  {
    readonly setMainWindow: (window: BrowserWindow) => Effect.Effect<void, PreviewManagerError>;
    readonly setForwardedShortcuts: (
      shortcuts: ReadonlyArray<PreviewForwardedShortcut>,
    ) => Effect.Effect<void>;
    readonly getBrowserSession: (
      scope?: string,
      persistent?: boolean,
      namespace?: BrowserSession.BrowserSessionPartitionNamespace,
    ) => Effect.Effect<Session, PreviewManagerError>;
    readonly isBrowserPartition: (partition: string) => boolean;
    readonly createTab: (
      tabId: string,
      defaults?: DesktopPreviewTabDefaults,
    ) => Effect.Effect<PreviewTabState, PreviewManagerError>;
    readonly closeTab: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly registerWebview: (
      tabId: string,
      webContentsId: number,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly prepareWebview: (webContents: Electron.WebContents) => Effect.Effect<void>;
    readonly navigate: (tabId: string, url: string) => Effect.Effect<void, PreviewManagerError>;
    readonly goBack: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly goForward: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly refresh: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly stopLoading: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly zoomIn: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly zoomOut: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly resetZoom: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly reapplyZoom: () => Effect.Effect<void>;
    readonly hardReload: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly findInPage: (
      tabId: string,
      text: string,
      options: { readonly forward: boolean; readonly newSession: boolean },
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly stopFindInPage: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly setColorScheme: (
      tabId: string,
      colorScheme: DesktopPreviewColorScheme,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly setZoomFactor: (
      tabId: string,
      zoomFactor: number,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly setAudioMuted: (
      tabId: string,
      audioMuted: boolean,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly setShown: (tabId: string, shown: boolean) => Effect.Effect<void>;
    readonly setCaptureDrawn: (tabId: string, drawn: boolean) => Effect.Effect<void>;
    readonly openDevTools: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly clearCookies: (
      partitions?: ReadonlyArray<string>,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly clearCache: (
      partitions?: ReadonlyArray<string>,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly getBrowserPartition: (
      scope?: string,
      persistent?: boolean,
      namespace?: BrowserSession.BrowserSessionPartitionNamespace,
    ) => Effect.Effect<string, PreviewManagerError>;
    readonly setAnnotationTheme: (
      theme: DesktopPreviewAnnotationTheme,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly setAnnotationSendEnabled: (
      tabId: string,
      enabled: boolean,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly pickElement: (
      tabId: string,
      voice?: DesktopPreviewAnnotationVoiceConfig,
    ) => Effect.Effect<PreviewAnnotationSubmissionResult | null, PreviewManagerError>;
    readonly updateAnnotationVoice: (
      state: DesktopPreviewAnnotationVoiceState,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly cancelPickElement: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly captureScreenshot: (
      tabId: string,
    ) => Effect.Effect<DesktopPreviewScreenshotArtifact, PreviewManagerError>;
    readonly revealArtifact: (path: string) => Effect.Effect<void, PreviewManagerError>;
    readonly copyArtifactToClipboard: (path: string) => Effect.Effect<void, PreviewManagerError>;
    readonly openPictureInPicture: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly closePictureInPicture: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly startRecording: (
      tabId: string,
      options?: RecordingInputOptions,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly stopRecording: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly saveRecording: (
      tabId: string,
      mimeType: string,
      data: Uint8Array,
    ) => Effect.Effect<DesktopPreviewRecordingArtifact, PreviewManagerError>;
    readonly subscribeStateChanges: (listener: Listener) => Effect.Effect<void, never, Scope.Scope>;
    readonly subscribePointerEvents: (
      listener: PointerEventListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly subscribeOpenLinks: (
      listener: OpenLinkListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly subscribeFindResults: (
      listener: FindResultListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly subscribeRecordingInputs: (
      listener: RecordingInputListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@zerocode/desktop/preview/Manager/PreviewManager") {}

/** @public */
export const make = Effect.gen(function* PreviewManagerMake() {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const browserSession = yield* BrowserSession.BrowserSession;
  const browserHost = yield* DesktopBrowserHost.DesktopBrowserHost;
  const passkeys = yield* PreviewPasskeys.PreviewPasskeys;
  const downloadSessions = new WeakSet<Electron.Session>();
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runForkDownload = Effect.runForkWith(yield* Effect.context<never>());
  const copyToDownloads = Effect.fn("PreviewManager.copyToDownloads")(function* (
    source: string,
    fileName: string,
  ) {
    const directory = app.getPath("downloads");
    const extension = path.extname(fileName);
    const stem = path.basename(fileName, extension) || "download";
    for (let attemptIndex = 0; attemptIndex < 100; attemptIndex += 1) {
      const target = path.join(
        directory,
        attemptIndex === 0 ? `${stem}${extension}` : `${stem} (${attemptIndex})${extension}`,
      );
      if (yield* fileSystem.exists(target)) continue;
      const copied = yield* Effect.tryPromise({
        try: () => NodeFSP.copyFile(source, target, NodeFSP.constants.COPYFILE_EXCL),
        catch: (cause) => new PreviewOperationError({ operation: "copyToDownloads", cause }),
      }).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) =>
            error.cause instanceof Error && "code" in error.cause && error.cause.code === "EEXIST",
          () => Effect.succeed(false),
        ),
      );
      if (!copied) continue;
      shell.showItemInFolder(target);
      return;
    }
  });
  const placeServerDownloads = (session: Electron.Session) => {
    if (downloadSessions.has(session)) return;
    downloadSessions.add(session);
    session.on("will-download", (_event, item, source) => {
      // Decided before the server's path is set: placing it consumes the guid.
      const human = browserHost.humanStartedDownload(source);
      if (!browserHost.placeDownload(source, item) || !human) return;
      item.once("done", (_doneEvent, state) => {
        if (state !== "completed") return;
        runForkDownload(
          copyToDownloads(item.getSavePath(), item.getFilename()).pipe(
            Effect.catch((error) =>
              Effect.logWarning("preview download copy failed", { cause: error }),
            ),
          ),
        );
      });
    });
  };

  const operations = yield* makeNativeOperations(
    environment.browserArtifactsDir,
    environment.path.join(environment.dirname, "preview-pip-preload.cjs"),
  );

  return PreviewManager.of({
    setMainWindow: operations.setMainWindow,
    setForwardedShortcuts: operations.setForwardedShortcuts,
    getBrowserSession: Effect.fn("PreviewManager.getBrowserSession")(
      function* (scope, persistent, namespace) {
        const session = yield* browserSession
          .getSession(scope, persistent, namespace)
          .pipe(
            Effect.mapError(
              (cause) => new PreviewOperationError({ operation: "getBrowserSession", cause }),
            ),
          );
        placeServerDownloads(session);
        passkeys.installSessionHandlers(session);
        return session;
      },
    ),
    isBrowserPartition: browserSession.isPartition,
    createTab: operations.createTab,
    closeTab: operations.closeTab,
    registerWebview: operations.registerWebview,
    prepareWebview: operations.prepareWebview,
    navigate: operations.navigate,
    goBack: operations.goBack,
    goForward: operations.goForward,
    refresh: operations.refresh,
    stopLoading: operations.stopLoading,
    zoomIn: operations.zoomIn,
    zoomOut: operations.zoomOut,
    resetZoom: operations.resetZoom,
    reapplyZoom: operations.reapplyZoom,
    hardReload: operations.hardReload,
    findInPage: operations.findInPage,
    stopFindInPage: operations.stopFindInPage,
    setColorScheme: operations.setColorScheme,
    setZoomFactor: operations.setZoomFactor,
    setAudioMuted: operations.setAudioMuted,
    setShown: operations.setShown,
    setCaptureDrawn: operations.setCaptureDrawn,
    openDevTools: operations.openDevTools,
    clearCookies: Effect.fn("PreviewManager.clearCookies")(function* (partitions) {
      yield* browserSession
        .clearCookies(partitions)
        .pipe(
          Effect.mapError(
            (cause) => new PreviewOperationError({ operation: "clearCookies", cause }),
          ),
        );
    }),
    clearCache: Effect.fn("PreviewManager.clearCache")(function* (partitions) {
      yield* browserSession
        .clearCache(partitions)
        .pipe(
          Effect.mapError((cause) => new PreviewOperationError({ operation: "clearCache", cause })),
        );
    }),
    getBrowserPartition: Effect.fn("PreviewManager.getBrowserPartition")(
      function* (scope, persistent, namespace) {
        return yield* browserSession
          .getPartition(scope, persistent, namespace)
          .pipe(
            Effect.mapError(
              (cause) => new PreviewOperationError({ operation: "getBrowserPartition", cause }),
            ),
          );
      },
    ),
    setAnnotationTheme: operations.setAnnotationTheme,
    setAnnotationSendEnabled: operations.setAnnotationSendEnabled,
    pickElement: operations.pickElement,
    updateAnnotationVoice: operations.updateAnnotationVoice,
    cancelPickElement: operations.cancelPickElement,
    captureScreenshot: operations.captureScreenshot,
    revealArtifact: operations.revealArtifact,
    copyArtifactToClipboard: operations.copyArtifactToClipboard,
    openPictureInPicture: operations.openPictureInPicture,
    closePictureInPicture: operations.closePictureInPicture,
    startRecording: operations.startRecording,
    stopRecording: operations.stopRecording,
    saveRecording: operations.saveRecording,
    subscribeStateChanges: operations.subscribeStateChanges,
    subscribePointerEvents: operations.subscribePointerEvents,
    subscribeOpenLinks: operations.subscribeOpenLinks,
    subscribeFindResults: operations.subscribeFindResults,
    subscribeRecordingInputs: operations.subscribeRecordingInputs,
  });
}).pipe(Effect.withSpan("PreviewManager.make"));

export const layer = Layer.effect(PreviewManager, make);
