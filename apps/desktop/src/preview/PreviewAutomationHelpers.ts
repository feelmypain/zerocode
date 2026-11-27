import type {
  DesktopPreviewColorScheme,
  DesktopPreviewPointerEvent,
} from "@zerocode/contracts/ipc";
import { webContents } from "electron";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import type * as BrowserSession from "./BrowserSession.ts";
import type * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import { HUMAN_INPUT_TRACKING_CHANNEL, RECORDING_POINTER_CHANNEL } from "./GuestProtocol.ts";
import {
  PreviewAutomationDebuggerAttachedError,
  PreviewAutomationDevToolsOpenError,
  PreviewOperationError,
  PreviewTabNotFoundError,
  attempt,
  attemptPromise,
  replaceMap,
  type BrowserControlSession,
  type FrameCaptureConsumer,
  type FrameCaptureSession,
  type PickSession,
  type PointerEventListener,
  type PreviewEventKind,
  type PreviewManagerError,
  type PreviewTabState,
} from "./PreviewTypes.ts";

const BUSY_PAGE_PROBE_MS = 1_000;

export interface PreviewAutomationControllerDeps {
  readonly parentScope: Scope.Scope;
  readonly browserHost: DesktopBrowserHost.DesktopBrowserHost["Service"];
  readonly browserSession: BrowserSession.BrowserSession["Service"];
  readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly tabsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, PreviewTabState>>;
  readonly pickSessionsRef: Ref.Ref<ReadonlyMap<string, PickSession>>;
  readonly controlSessionsRef: SynchronizedRef.SynchronizedRef<
    ReadonlyMap<number, BrowserControlSession>
  >;
  readonly frameCaptureSessionsRef: SynchronizedRef.SynchronizedRef<
    ReadonlyMap<string, FrameCaptureSession>
  >;
  readonly pointerEventListenersRef: Ref.Ref<ReadonlySet<PointerEventListener>>;
  readonly agentTrackedTabIds: Set<string>;
  readonly activePictureInPictureScreencasts: Map<number, Set<Scope.Closeable>>;
  readonly currentIso: Effect.Effect<string>;
  readonly deliverEvent: (
    eventKind: PreviewEventKind,
    tabId: string,
    delivery: () => Effect.Effect<void>,
  ) => Effect.Effect<void>;
  readonly update: (tabId: string, patch: Partial<PreviewTabState>) => Effect.Effect<void>;
  readonly tabIdForWebContents: (webContentsId: number) => Effect.Effect<string | null>;
  readonly startFrameCapture: (
    tabId: string,
    consumer: FrameCaptureConsumer,
  ) => Effect.Effect<void, PreviewManagerError>;
  readonly stopFrameCapture: (tabId: string, consumer: FrameCaptureConsumer) => Effect.Effect<void>;
}

export const makePreviewAutomationController = (deps: PreviewAutomationControllerDeps) => {
  const {
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
    startFrameCapture,
    stopFrameCapture,
  } = deps;

  // Closes a session already removed from `controlSessionsRef`. The server can
  // only drive a tab while the desktop holds its debugger.
  const releaseControlSession = Effect.fnUntraced(function* (
    control: BrowserControlSession,
    closedServerTab?: PreviewTabState["serverTab"],
  ) {
    if (closedServerTab) browserHost.detach(closedServerTab);
    for (const tab of (yield* SynchronizedRef.get(tabsRef)).values()) {
      if (tab.webContentsId === control.webContentsId && tab.serverTab) {
        browserHost.detach(tab.serverTab);
      }
    }
    yield* Scope.close(control.scope, Exit.void).pipe(Effect.ignore);
  });

  const detachControlSession = Effect.fn("PreviewManager.detachControlSession")(function* (
    webContentsId: number,
    closedServerTab?: PreviewTabState["serverTab"],
  ) {
    const control = yield* SynchronizedRef.modify(controlSessionsRef, (sessions) => [
      sessions.get(webContentsId),
      replaceMap(sessions, (copy) => {
        copy.delete(webContentsId);
      }),
    ]);
    if (control) yield* releaseControlSession(control, closedServerTab);
  });

  const ensureControlSession = Effect.fn("PreviewManager.ensureControlSession")(function* (
    wc: Electron.WebContents,
  ) {
    return yield* SynchronizedRef.modifyEffect(
      controlSessionsRef,
      (
        sessions,
      ): Effect.Effect<
        readonly [BrowserControlSession, ReadonlyMap<number, BrowserControlSession>],
        PreviewManagerError
      > => {
        const existing = sessions.get(wc.id);
        if (existing) return Effect.succeed([existing, sessions] as const);
        if (wc.isDestroyed()) {
          return Effect.fail(
            new PreviewOperationError({
              operation: "ensureControlSession",
              webContentsId: wc.id,
              cause: new Error("WebContents was destroyed"),
            }),
          );
        }
        if (wc.isDevToolsOpened()) {
          return Effect.fail(
            new PreviewAutomationDevToolsOpenError({
              webContentsId: wc.id,
            }),
          );
        }
        if (wc.debugger.isAttached()) {
          return Effect.fail(
            new PreviewAutomationDebuggerAttachedError({
              webContentsId: wc.id,
            }),
          );
        }
        const createControlSession = Effect.fn("PreviewManager.createControlSession")(function* () {
          const semaphore = yield* Semaphore.make(1);
          const scope = yield* Scope.fork(parentScope, "sequential");
          const wcDebugger = wc.debugger;
          const consoleReleases = yield* Queue.sliding<void>(1);
          // Console eviction leaves strong debugger handles; release the group because we keep only text.
          yield* Effect.forkIn(
            Effect.forever(
              Queue.take(consoleReleases).pipe(
                Effect.andThen(
                  attemptPromise({ operation: "releaseConsoleObjects", webContentsId: wc.id }, () =>
                    wcDebugger.sendCommand("Runtime.releaseObjectGroup", {
                      objectGroup: "console",
                    }),
                  ).pipe(Effect.ignore),
                ),
              ),
            ),
            scope,
          );
          const handleDebuggerMessage = Effect.fnUntraced(function* (method: string) {
            if (method === "Runtime.consoleAPICalled" || method === "Runtime.exceptionThrown") {
              yield* Queue.offer(consoleReleases, undefined);
            }
          });
          const onMessage: BrowserControlSession["onMessage"] = (_event, method) => {
            runFork(handleDebuggerMessage(method));
          };
          const control: BrowserControlSession = {
            webContentsId: wc.id,
            debugger: wcDebugger,
            semaphore,
            scope,
            onMessage,
          };
          // Electron emits `detach` when Chromium closes the debugger session on its
          // own. The cached session would then fail every command until the webview
          // is replaced.
          let dropped = false;
          const onDetach = () => {
            dropped = true;
            runFork(recoverDetachedControlSession(wc, control));
          };
          // The listener comes off before detach() so a detach this manager requested
          // never looks like a dropped one. A dropped session has nothing left to
          // detach: `wc.debugger` is shared, so detaching here would hit a successor.
          yield* Scope.addFinalizer(
            scope,
            attempt({ operation: "detachControlSession", webContentsId: wc.id }, () => {
              wcDebugger.off("message", onMessage);
              wcDebugger.off("detach", onDetach);
              if (!dropped && wcDebugger.isAttached()) wcDebugger.detach();
            }).pipe(Effect.ignore),
          );
          const initialize = Effect.fn("PreviewManager.initializeControlSession")(function* () {
            yield* attempt({ operation: "attachDebuggerListeners", webContentsId: wc.id }, () => {
              wcDebugger.on("message", onMessage);
              wcDebugger.on("detach", onDetach);
              wcDebugger.attach("1.3");
            });
            // Set an opaque base before first paint or background-less dark pages retain white-on-white text.
            yield* attemptPromise(
              { operation: "initializeDebugger.defaultBackground", webContentsId: wc.id },
              () =>
                wcDebugger.sendCommand("Emulation.setDefaultBackgroundColorOverride", {
                  color: { r: 255, g: 255, b: 255, a: 1 },
                }),
            );
            return [
              control,
              replaceMap(sessions, (copy) => {
                copy.set(wc.id, control);
              }),
            ] as const;
          });
          return yield* initialize().pipe(
            Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
          );
        });
        return createControlSession();
      },
    );
  });

  /**
   * A same-site navigation reuses the renderer, so it never commits while a page script holds it.
   * Runs before the navigation starts: Chromium does not deliver a terminate once one is pending.
   */
  const leaveBusyPage = Effect.fn("PreviewManager.leaveBusyPage")(function* (
    wc: Electron.WebContents,
  ) {
    const control = (yield* SynchronizedRef.get(controlSessionsRef)).get(wc.id);
    if (!control) return;
    const answered = yield* Effect.promise(() =>
      control.debugger.sendCommand("Runtime.evaluate", { expression: "0" }).then(
        () => undefined,
        () => undefined,
      ),
    ).pipe(Effect.timeoutOption(BUSY_PAGE_PROBE_MS));
    if (Option.isSome(answered)) return;
    // Not awaited: a renderer blocked on something other than script may never acknowledge it.
    yield* Effect.sync(() => {
      void control.debugger.sendCommand("Runtime.terminateExecution").catch(() => undefined);
    });
  });

  // Media emulation belongs to the debugger session and must be restored after every reattach.
  const applyColorScheme = Effect.fn("PreviewManager.applyColorScheme")(function* (
    tabId: string,
    wc: Electron.WebContents,
    colorScheme: DesktopPreviewColorScheme,
  ) {
    const control = yield* ensureControlSession(wc);
    yield* attemptPromise({ operation: "applyColorScheme", tabId, webContentsId: wc.id }, () =>
      control.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: [
          {
            name: "prefers-color-scheme",
            value: colorScheme === "system" ? "" : colorScheme,
          },
        ],
      }),
    );
  });

  let pointerSequence = 0;
  const emitAgentPointer = Effect.fn("PreviewManager.emitAgentPointer")(function* (pointer: {
    readonly key: { readonly threadId: string; readonly tabId: string };
    readonly phase: "move" | "click";
    readonly x: number;
    readonly y: number;
  }) {
    const tab = [...(yield* SynchronizedRef.get(tabsRef)).values()].find(
      (candidate) =>
        candidate.serverTab?.threadId === pointer.key.threadId &&
        candidate.serverTab.tabId === pointer.key.tabId,
    );
    if (!tab) return;
    const event: DesktopPreviewPointerEvent = {
      tabId: tab.tabId,
      phase: pointer.phase,
      x: pointer.x,
      y: pointer.y,
      sequence: ++pointerSequence,
      createdAt: yield* currentIso,
    };
    const newlyAgentTracked = !agentTrackedTabIds.has(tab.tabId);
    if (newlyAgentTracked) agentTrackedTabIds.add(tab.tabId);
    const recording = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tab.tabId);
    const webContentsId = tab.webContentsId;
    if (newlyAgentTracked && webContentsId != null) {
      yield* attempt({ operation: "humanInputTracking", tabId: tab.tabId, webContentsId }, () => {
        const contents = webContents.fromId(webContentsId);
        if (contents && !contents.isDestroyed()) {
          contents.send(HUMAN_INPUT_TRACKING_CHANNEL, true);
        }
      }).pipe(Effect.ignore);
    }
    if (recording?.consumers.has("recording") && webContentsId != null) {
      yield* attempt({ operation: "recording.pointer", tabId: tab.tabId }, () => {
        const contents = webContents.fromId(webContentsId);
        if (contents && !contents.isDestroyed()) contents.send(RECORDING_POINTER_CHANNEL, event);
      }).pipe(Effect.ignore);
    }
    const listeners = yield* Ref.get(pointerEventListenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => deliverEvent("pointer-event", tab.tabId, () => listener(event)),
      { discard: true },
    );
  });

  // A hidden or locked window draws no frames, so a guest it hid stays unpainted until unthrottled.
  const serverCaptureLeases = new Map<string, { readonly tabId: string; readonly lease: symbol }>();
  const updateServerTabCapturing = Effect.fn("PreviewManager.updateServerTabCapturing")(
    function* (painting: {
      readonly key: { readonly threadId: string; readonly tabId: string };
      readonly active: boolean;
    }) {
      const tab = [...(yield* SynchronizedRef.get(tabsRef)).values()].find(
        (candidate) =>
          candidate.serverTab?.threadId === painting.key.threadId &&
          candidate.serverTab.tabId === painting.key.tabId,
      );
      const key = `${painting.key.threadId}\u0000${painting.key.tabId}`;
      const held = serverCaptureLeases.get(key);
      if (!painting.active && held) {
        serverCaptureLeases.delete(key);
        yield* stopFrameCapture(held.tabId, held.lease);
      } else if (painting.active && !held && tab) {
        const lease = Symbol("server-capture");
        yield* startFrameCapture(tab.tabId, lease).pipe(
          Effect.andThen(
            Effect.sync(() => serverCaptureLeases.set(key, { tabId: tab.tabId, lease })),
          ),
          Effect.catch((error) =>
            Effect.logWarning("Failed to unthrottle a server tab for its capture.", {
              tabId: tab.tabId,
              error,
            }),
          ),
        );
      }
      if (painting.active && tab && !agentTrackedTabIds.has(tab.tabId)) {
        agentTrackedTabIds.add(tab.tabId);
        const webContentsId = tab.webContentsId;
        if (webContentsId != null) {
          yield* attempt(
            { operation: "humanInputTracking", tabId: tab.tabId, webContentsId },
            () => {
              const contents = webContents.fromId(webContentsId);
              if (contents && !contents.isDestroyed()) {
                contents.send(HUMAN_INPUT_TRACKING_CHANNEL, true);
              }
            },
          ).pipe(Effect.ignore);
        }
      }
      if (tab && tab.capturing !== painting.active) {
        yield* update(tab.tabId, { capturing: painting.active });
      }
    },
  );

  let browserHostStarted = false;
  // Subscribes before the attach that follows, so no event falls between the two.
  const listenToBrowserHost = Effect.suspend(() => {
    if (browserHostStarted) return Effect.void;
    browserHostStarted = true;
    const listen = Effect.forkIn(parentScope, { startImmediately: true });
    return Effect.all(
      [
        browserHost.pointers.pipe(Stream.runForEach(emitAgentPointer), listen),
        browserHost.painting.pipe(Stream.runForEach(updateServerTabCapturing), listen),
      ],
      { discard: true },
    );
  });

  // The scheme is read after the session attaches so a concurrent setColorScheme is not
  // overwritten with a stale snapshot.
  const restoreControlSession = Effect.fn("PreviewManager.restoreControlSession")(
    function* (tabId: string, wc: Electron.WebContents) {
      const beforeAttach = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
      if (beforeAttach?.webContentsId !== wc.id) return;
      const control = yield* ensureControlSession(wc);
      if (beforeAttach.serverTab) yield* listenToBrowserHost;
      const afterAttach = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
      if (afterAttach?.webContentsId !== wc.id) {
        yield* detachControlSession(wc.id);
        return;
      }
      if (afterAttach.serverTab) {
        browserHost.attach(afterAttach.serverTab, {
          webContents: wc,
          debugger: control.debugger,
          cookiesCleared: () => runPromise(browserSession.cookiesCleared(wc.session)),
          annotating: () => Ref.getUnsafe(pickSessionsRef).has(tabId),
          screencasting: () => (activePictureInPictureScreencasts.get(wc.id)?.size ?? 0) > 0,
        });
        // CDP cannot recover a failure that happened before it attached.
        const { navStatus } = afterAttach;
        if (navStatus.kind === "LoadFailed") {
          browserHost.loadFailed(afterAttach.serverTab, {
            url: navStatus.url,
            code: navStatus.code,
            description: navStatus.description,
          });
        }
      }
      if (afterAttach.colorScheme !== "system") {
        yield* attemptPromise({ operation: "applyColorScheme", tabId, webContentsId: wc.id }, () =>
          control.debugger.sendCommand("Emulation.setEmulatedMedia", {
            features: [
              {
                name: "prefers-color-scheme",
                value: afterAttach.colorScheme,
              },
            ],
          }),
        );
      }
    },
    (effect, _tabId, _wc) => effect.pipe(Effect.ignore),
  );

  // Only the session that saw the detach is replaced: by the time the event is
  // handled the guest may already hold a newer one, which must stay.
  const recoverDetachedControlSession = Effect.fn("PreviewManager.recoverDetachedControlSession")(
    function* (wc: Electron.WebContents, detached: BrowserControlSession) {
      const removed = yield* SynchronizedRef.modify(controlSessionsRef, (sessions) =>
        sessions.get(wc.id) === detached
          ? ([
              true,
              replaceMap(sessions, (copy) => {
                copy.delete(wc.id);
              }),
            ] as const)
          : ([false, sessions] as const),
      );
      if (!removed) return;
      yield* releaseControlSession(detached);
      if (wc.isDestroyed()) return;
      const tabId = yield* tabIdForWebContents(wc.id);
      if (tabId === null) return;
      yield* restoreControlSession(tabId, wc);
    },
    (recover) => Effect.ignore(recover),
  );

  const setColorScheme = Effect.fn("PreviewManager.setColorScheme")(function* (
    tabId: string,
    colorScheme: DesktopPreviewColorScheme,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    if (tab.colorScheme !== colorScheme) {
      yield* update(tabId, { colorScheme });
    }
    // registerWebview may swap guests during the update; apply to the current one.
    const webContentsId = (yield* SynchronizedRef.get(tabsRef)).get(tabId)?.webContentsId;
    if (webContentsId == null) return;
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;
    yield* applyColorScheme(tabId, wc, colorScheme);
  });

  const setShown = Effect.fn("PreviewManager.setShown")(function* (tabId: string, shown: boolean) {
    const serverTab = (yield* SynchronizedRef.get(tabsRef)).get(tabId)?.serverTab;
    if (serverTab) browserHost.setShown(serverTab, shown);
  });

  const setCaptureDrawn = Effect.fn("PreviewManager.setCaptureDrawn")(function* (
    tabId: string,
    drawn: boolean,
  ) {
    const serverTab = (yield* SynchronizedRef.get(tabsRef)).get(tabId)?.serverTab;
    if (serverTab) browserHost.setCaptureDrawn(serverTab, drawn);
  });

  // A window reload or guest crash destroys the guest without the renderer reporting it hidden.
  // The renderer reports again once a new guest registers.
  const hideDestroyedGuest = Effect.fnUntraced(function* (webContentsId: number) {
    for (const tab of (yield* SynchronizedRef.get(tabsRef)).values()) {
      if (tab.webContentsId === webContentsId && tab.serverTab) {
        browserHost.setShown(tab.serverTab, false);
        browserHost.setCaptureDrawn(tab.serverTab, false);
      }
    }
  });

  return {
    detachControlSession,
    ensureControlSession,
    leaveBusyPage,
    restoreControlSession,
    recoverDetachedControlSession,
    setColorScheme,
    setShown,
    setCaptureDrawn,
    hideDestroyedGuest,
  };
};
