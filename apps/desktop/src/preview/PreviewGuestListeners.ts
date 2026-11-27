import {
  DesktopPreviewRecordingInputSchema,
  type DesktopPreviewFindResultEvent,
  type DesktopPreviewOpenLinkEvent,
} from "@zerocode/contracts/ipc";
import type { PreviewForwardedShortcut } from "@zerocode/contracts/server";
import { matchesKeybindingShortcut } from "@zerocode/shared/keybindings";
import { webContents } from "electron";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { MENU_ACTION_CHANNEL } from "../ipc/channels.ts";
import type * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import { captureFavicon, safeHttpOrigin, selectFaviconCandidates } from "./FaviconCapture.ts";
import {
  HUMAN_INPUT_CHANNEL,
  HUMAN_INPUT_TRACKING_CHANNEL,
  PAGE_UNHANDLED_SHORTCUT_CHANNEL,
  RECORDING_CONTROLLER_CHANNEL,
  RECORDING_CURSOR_CHANNEL,
  RECORDING_INPUT_CHANNEL,
  THUMB_PRESS_CHANNEL,
} from "./GuestProtocol.ts";
import type * as PreviewPasskeys from "./Passkeys.ts";
import {
  PreviewOperationError,
  attempt,
  attemptPromise,
  replaceMap,
  type FrameCaptureSession,
  type ManagedListeners,
  type PreviewEventKind,
  type PreviewInputSignal,
  type PreviewNavStatus,
  type PreviewTabState,
  type RecordingInputListener,
} from "./PreviewTypes.ts";

const isRecordingInput = Schema.is(DesktopPreviewRecordingInputSchema);

const PAGE_FIRST_FORWARDED_COMMANDS: ReadonlySet<PreviewForwardedShortcut["command"]> = new Set([
  "preview.find",
  "preview.zoomIn",
  "preview.zoomOut",
  "preview.resetZoom",
]);

const decodePageShortcutKeys = Schema.decodeUnknownOption(
  Schema.Struct({
    key: Schema.String,
    code: Schema.String,
    metaKey: Schema.Boolean,
    ctrlKey: Schema.Boolean,
    shiftKey: Schema.Boolean,
    altKey: Schema.Boolean,
  }),
);

// about:blank inherits relaxed guest preferences; external editor schemes must reach the OS handler.
const POPUP_PROTOCOLS = new Set(["http:", "https:"]);

// Main-process loadURL bypasses Chromium's renderer-side restrictions on local and inline URLs.
const IN_PLACE_DENIED_PROTOCOLS = new Set([
  "about:",
  "chrome:",
  "data:",
  "devtools:",
  "file:",
  "filesystem:",
  "javascript:",
  "view-source:",
]);

/** Popups bypass will-attach-webview hardening, so they are isolated and sandboxed here. */
const POPUP_WINDOW_OPTIONS = {
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
} satisfies Electron.BrowserWindowConstructorOptions;

/**
 * OAuth needs a surviving popup opener. `blob:`, app links (behind the session's `openExternal`
 * prompt) and form POSTs stay in place.
 */
export const previewWindowOpenAction = (details: {
  readonly url: string;
  readonly disposition: Electron.HandlerDetails["disposition"];
  readonly postBody?: Electron.PostBody;
}): "popup" | "new-tab" | "navigate" | "deny" => {
  const protocol = URL.parse(details.url)?.protocol;
  // MSAL redirects on a denied blank popup; navigating the tab would destroy that fallback.
  if (protocol === undefined || IN_PLACE_DENIED_PROTOCOLS.has(protocol)) return "deny";
  if (!POPUP_PROTOCOLS.has(protocol)) return "navigate";
  if (details.disposition === "new-window") return "popup";
  return !details.postBody &&
    (details.disposition === "foreground-tab" || details.disposition === "background-tab")
    ? "new-tab"
    : "navigate";
};

const isPreviewRefreshShortcut = (input: Electron.Input, platform: NodeJS.Platform): boolean =>
  input.type === "keyDown" &&
  input.key.toLowerCase() === "r" &&
  (platform === "darwin" ? input.meta && !input.control : input.control && !input.meta) &&
  !input.shift &&
  !input.alt;

export const isPreviewEditingShortcut = (
  input: Electron.Input,
  platform: NodeJS.Platform,
): boolean => {
  const isMac = platform === "darwin";
  if (isMac ? !input.meta || input.control : !input.control || input.meta) return false;

  const key = input.key.toLowerCase();
  // Option changes the DOM key for macOS Paste and Match Style (for example, to ◊).
  if (isMac && input.alt && input.shift && input.code === "KeyV") return true;
  if (key === "v" && input.shift) return input.alt === isMac;
  if (input.alt) return false;
  if (key === "z") return !input.shift || platform !== "win32";
  if (input.shift) return false;
  return (
    key === "a" ||
    key === "c" ||
    key === "v" ||
    key === "x" ||
    (key === "y" && platform === "win32")
  );
};

const isPreviewInputSignal = (value: unknown): value is PreviewInputSignal => {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if (value.kind === "pointer") {
    return (
      "x" in value &&
      typeof value.x === "number" &&
      "y" in value &&
      typeof value.y === "number" &&
      "button" in value &&
      typeof value.button === "number"
    );
  }
  return (
    value.kind === "key" &&
    "key" in value &&
    typeof value.key === "string" &&
    "code" in value &&
    typeof value.code === "string"
  );
};

export const computeNavStatus = (wc: Electron.WebContents): PreviewNavStatus => {
  const url = wc.getURL();
  const title = wc.getTitle();
  if (url === "" || url === "about:blank") return { kind: "Idle" };
  // isLoading() includes late iframes whose completion may never clear the tab's loading bar.
  if (wc.isLoadingMainFrame()) return { kind: "Loading", url, title };
  return { kind: "Success", url, title };
};

export interface PreviewGuestListenersDeps {
  readonly hostPlatform: NodeJS.Platform;
  readonly parentScope: Scope.Scope;
  readonly browserHost: DesktopBrowserHost.DesktopBrowserHost["Service"];
  readonly passkeys: PreviewPasskeys.PreviewPasskeys["Service"];
  readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly tabsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, PreviewTabState>>;
  readonly attachedRef: Ref.Ref<ReadonlyMap<number, ManagedListeners>>;
  readonly frameCaptureSessionsRef: SynchronizedRef.SynchronizedRef<
    ReadonlyMap<string, FrameCaptureSession>
  >;
  readonly recordingInputListenersRef: Ref.Ref<ReadonlySet<RecordingInputListener>>;
  readonly agentTrackedTabIds: Set<string>;
  readonly getForwardedShortcuts: () => ReadonlyArray<PreviewForwardedShortcut>;
  readonly currentIso: Effect.Effect<string>;
  readonly currentMillis: Effect.Effect<number>;
  readonly deliverEvent: (
    eventKind: PreviewEventKind,
    tabId: string,
    delivery: () => Effect.Effect<void>,
  ) => Effect.Effect<void>;
  readonly emitIfCurrent: (tabId: string, state: PreviewTabState) => Effect.Effect<void>;
  readonly emitOpenLink: (event: DesktopPreviewOpenLinkEvent) => Effect.Effect<void>;
  readonly emitFindResult: (event: DesktopPreviewFindResultEvent) => Effect.Effect<void>;
  readonly syncTabAudible: (
    tabId: string,
    wc: Electron.WebContents,
    audible: boolean,
  ) => Effect.Effect<void>;
}

export const makePreviewGuestListeners = (deps: PreviewGuestListenersDeps) => {
  const {
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
    getForwardedShortcuts,
    currentIso,
    currentMillis,
    deliverEvent,
    emitIfCurrent,
    emitOpenLink,
    emitFindResult,
    syncTabAudible,
  } = deps;

  const lastIgnoreMenuShortcuts = new WeakMap<Electron.WebContents, boolean>();
  const setIgnoreMenuShortcuts = (contents: Electron.WebContents, ignore: boolean): void => {
    if (lastIgnoreMenuShortcuts.get(contents) === ignore) return;
    lastIgnoreMenuShortcuts.set(contents, ignore);
    contents.setIgnoreMenuShortcuts(ignore);
  };

  const detachListeners = Effect.fn("PreviewManager.detachListeners")(function* (
    webContentsId: number,
  ) {
    const managed = yield* Ref.modify(attachedRef, (attached) => [
      attached.get(webContentsId),
      replaceMap(attached, (copy) => {
        copy.delete(webContentsId);
      }),
    ]);
    if (managed) {
      managed.cancelFaviconCapture();
      yield* Scope.close(managed.scope, Exit.void).pipe(Effect.ignore);
    }
  });

  const attachListeners = Effect.fn("PreviewManager.attachListeners")(function* (
    tabId: string,
    wc: Electron.WebContents,
  ) {
    const scope = yield* Scope.fork(parentScope, "sequential");
    const attachmentId = Symbol();
    let detachPasskeys = () => {};
    let documentId = 0;
    let nextRequestId = 0;
    let activeCapture: {
      readonly controller: AbortController;
      readonly documentId: number;
      readonly eventKey: string;
      readonly requestId: number;
    } | null = null;
    const cancelFaviconCapture = () => {
      documentId += 1;
      activeCapture?.controller.abort();
      activeCapture = null;
    };
    const syncState = Effect.fn("PreviewManager.syncWebContentsState")(function* (
      preserveLoadFailure: boolean,
      confirmedNavigation = false,
    ) {
      if (wc.isDestroyed()) return;
      const computedNavStatus = computeNavStatus(wc);
      const canGoBack = wc.navigationHistory.canGoBack();
      const canGoForward = wc.navigationHistory.canGoForward();
      const updatedAt = yield* currentIso;
      const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
        const current = tabs.get(tabId);
        if (!current || current.webContentsId !== wc.id || webContents.fromId(wc.id) !== wc) {
          return [Option.none<PreviewTabState>(), tabs] as const;
        }
        // did-stop-loading follows did-fail-load without proving successful navigation.
        const navStatus =
          preserveLoadFailure &&
          current.navStatus.kind === "LoadFailed" &&
          computedNavStatus.kind === "Success"
            ? current.navStatus
            : computedNavStatus;
        const clearFavicon =
          confirmedNavigation &&
          current.favicon !== undefined &&
          safeHttpOrigin(current.favicon.pageUrl) !==
            safeHttpOrigin(navStatus.kind === "Idle" ? wc.getURL() : navStatus.url);
        const { favicon: _favicon, ...currentWithoutFavicon } = current;
        const state: PreviewTabState = {
          ...(clearFavicon ? currentWithoutFavicon : current),
          navStatus,
          canGoBack,
          canGoForward,
          // Guest zoom inherits app zoom; mirroring it would overwrite the tab's own setting.
          updatedAt,
        };
        return [
          Option.some(state),
          replaceMap(tabs, (copy) => {
            copy.set(tabId, state);
          }),
        ] as const;
      });
      if (Option.isSome(next)) yield* emitIfCurrent(tabId, next.value);
    });
    const sync = () => runFork(syncState(true));
    const syncNavigation = () => runFork(syncState(false, true));
    const syncInPageNavigation = () => runFork(syncState(false));
    const restoreRecordingCursor = () =>
      runFork(
        Effect.gen(function* () {
          const session = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
          if (!wc.isDestroyed()) {
            const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
            const recording = session?.consumers.has("recording") ?? false;
            wc.send(
              RECORDING_CURSOR_CHANNEL,
              recording,
              session?.recordingInputOptions,
              tab?.controller,
            );
            if (recording || agentTrackedTabIds.has(tabId)) {
              wc.send(HUMAN_INPUT_TRACKING_CHANNEL, true);
            }
          }
        }),
      );
    const navigationStarted = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (event.isMainFrame && !event.isSameDocument) cancelFaviconCapture();
    };
    const audioStateChanged = (
      event: Electron.Event<Electron.WebContentsAudioStateChangedEventParams>,
    ) => runFork(syncTabAudible(tabId, wc, event.audible));
    const publishFavicon = Effect.fn("PreviewManager.publishFavicon")(function* (input: {
      readonly captureDocumentId: number;
      readonly dataUrl: string;
      readonly pageUrl: string;
      readonly requestId: number;
    }) {
      const pageOrigin = safeHttpOrigin(input.pageUrl);
      const managed = (yield* Ref.get(attachedRef)).get(wc.id);
      if (
        !pageOrigin ||
        wc.isDestroyed() ||
        webContents.fromId(wc.id) !== wc ||
        managed?.attachmentId !== attachmentId ||
        activeCapture?.documentId !== input.captureDocumentId ||
        activeCapture.requestId !== input.requestId ||
        safeHttpOrigin(wc.getURL()) !== pageOrigin
      ) {
        return;
      }
      const capturedAt = yield* currentMillis;
      const updatedAt = yield* currentIso;
      const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
        const current = tabs.get(tabId);
        if (
          !current ||
          current.webContentsId !== wc.id ||
          webContents.fromId(wc.id) !== wc ||
          activeCapture?.documentId !== input.captureDocumentId ||
          activeCapture.requestId !== input.requestId
        ) {
          return [Option.none<PreviewTabState>(), tabs] as const;
        }
        const state: PreviewTabState = {
          ...current,
          favicon: { dataUrl: input.dataUrl, pageUrl: pageOrigin, capturedAt },
          updatedAt,
        };
        return [
          Option.some(state),
          replaceMap(tabs, (copy) => {
            copy.set(tabId, state);
          }),
        ] as const;
      });
      if (Option.isSome(next)) yield* emitIfCurrent(tabId, next.value);
    });
    const faviconUpdated = (_event: Event, rawCandidates: ReadonlyArray<string>): void => {
      const pageUrl = wc.getURL();
      if (!safeHttpOrigin(pageUrl)) return;
      const candidates = selectFaviconCandidates(rawCandidates);
      if (candidates.length === 0) return;
      const eventKey = JSON.stringify([pageUrl, ...candidates]);
      if (activeCapture?.eventKey === eventKey) return;
      activeCapture?.controller.abort();
      const captureDocumentId = documentId;
      const requestId = ++nextRequestId;
      const controller = new AbortController();
      activeCapture = { controller, documentId: captureDocumentId, eventKey, requestId };
      runFork(
        Effect.tryPromise({
          try: () =>
            captureFavicon({ webContents: wc, pageUrl, candidates, signal: controller.signal }),
          catch: (cause) =>
            new PreviewOperationError({
              operation: "captureFavicon",
              tabId,
              webContentsId: wc.id,
              cause,
            }),
        }).pipe(
          Effect.flatMap((result) =>
            result.kind === "captured"
              ? publishFavicon({
                  captureDocumentId,
                  dataUrl: result.dataUrl,
                  pageUrl,
                  requestId,
                })
              : Effect.void,
          ),
          Effect.catch((error) =>
            controller.signal.aborted
              ? Effect.void
              : Effect.logDebug("Favicon capture failed.", { error, tabId, webContentsId: wc.id }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (activeCapture?.requestId === requestId) activeCapture = null;
            }),
          ),
        ),
      );
    };
    const failed = (
      _event: Event,
      code: number,
      description: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ): void => {
      if (code === -3 || !isMainFrame || wc.isDestroyed()) return;
      const url = validatedUrl || wc.getURL();
      runFork(
        Effect.gen(function* () {
          const updatedAt = yield* currentIso;
          const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
            const current = tabs.get(tabId);
            if (
              !current ||
              current.webContentsId !== wc.id ||
              wc.isDestroyed() ||
              webContents.fromId(wc.id) !== wc
            ) {
              return [Option.none<PreviewTabState>(), tabs] as const;
            }
            const state: PreviewTabState = {
              ...current,
              navStatus: { kind: "LoadFailed", url, title: wc.getTitle(), code, description },
              updatedAt,
            };
            return [
              Option.some(state),
              replaceMap(tabs, (copy) => copy.set(tabId, state)),
            ] as const;
          });
          if (Option.isNone(next)) return;
          const current = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
          if (current?.webContentsId !== wc.id || current.navStatus !== next.value.navStatus)
            return;
          if (current.serverTab) {
            browserHost.loadFailed(current.serverTab, { url, code, description });
          }
          yield* emitIfCurrent(tabId, next.value);
        }),
      );
    };
    let humanInputWorker = false;
    let humanInputDeadline = 0;
    let listening = true;
    const publishHumanController = Effect.fn("PreviewManager.publishHumanController")(function* (
      controller: "human" | "none",
      humanPoint?: { readonly x: number; readonly y: number },
    ) {
      const now = yield* currentMillis;
      const updatedAt = yield* currentIso;
      const result = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
        const current = tabs.get(tabId);
        if (
          !current ||
          current.webContentsId !== wc.id ||
          (controller === "human"
            ? !listening || webContents.fromId(wc.id) !== wc
            : current.controller !== "human" || humanInputDeadline > now)
        )
          return [undefined, tabs] as const;
        const changed = current.controller !== controller;
        const state = changed ? { ...current, controller, updatedAt } : current;
        return [
          { state, changed },
          changed
            ? replaceMap(tabs, (copy) => {
                copy.set(tabId, state);
              })
            : tabs,
        ] as const;
      });
      if (!result) return;
      const capture = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
      if (capture?.consumers.has("recording")) {
        yield* attempt({ operation: "recording.controller", tabId }, () => {
          if (!wc.isDestroyed()) wc.send(RECORDING_CONTROLLER_CHANNEL, controller, humanPoint);
        }).pipe(Effect.ignore);
      }
      if (result.changed) yield* emitIfCurrent(tabId, result.state);
    });
    yield* Scope.addFinalizer(
      scope,
      Effect.gen(function* () {
        listening = false;
        humanInputDeadline = 0;
        yield* publishHumanController("none");
      }),
    );
    const handleHumanInput = Effect.fn("PreviewManager.handleHumanInput")(function* (
      rawSignal?: unknown,
    ) {
      if (!listening) return;
      humanInputDeadline = (yield* currentMillis) + 750;
      if (!humanInputWorker) {
        humanInputWorker = true;
        yield* Effect.gen(function* () {
          let remaining: number;
          while ((remaining = humanInputDeadline - (yield* currentMillis)) > 0) {
            yield* Effect.sleep(remaining);
          }
          humanInputWorker = false;
          yield* publishHumanController("none");
        }).pipe(Effect.forkIn(scope));
      }
      yield* publishHumanController(
        "human",
        isPreviewInputSignal(rawSignal) && rawSignal.kind === "pointer"
          ? { x: rawSignal.x, y: rawSignal.y }
          : undefined,
      );
    });
    const recordingInput = (_event: unknown, input: unknown) => {
      if (!isRecordingInput(input)) return;
      return runFork(
        Effect.gen(function* () {
          const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
          const capture = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
          if (tab?.webContentsId !== wc.id || !capture?.consumers.has("recording")) return;
          if (input.type === "key" && !capture.recordingInputOptions?.showKeyPresses) return;
          if (input.type === "pointer" && !capture.recordingInputOptions?.showMousePresses) return;
          const listeners = yield* Ref.get(recordingInputListenersRef);
          yield* Effect.forEach(
            listeners,
            (listener) => deliverEvent("recording-input", tabId, () => listener({ tabId, input })),
            { discard: true },
          );
        }),
      );
    };
    // Chromium splits one search across several updates (the ordinal and the
    // final count can land separately), so every update is forwarded.
    const foundInPage = (_event: unknown, result: Electron.Result): void => {
      runFork(
        emitFindResult({
          tabId,
          activeMatchOrdinal: result.activeMatchOrdinal,
          matches: result.matches,
        }),
      );
    };
    const humanInput = (_event: unknown, rawSignal?: unknown): void => {
      runFork(handleHumanInput(rawSignal));
    };
    // Chromium navigates the outermost WebContents (the host app) on thumb buttons, even from guest iframes.
    const beforeMouse = (event: Electron.Event, mouse: Electron.MouseInputEvent): void => {
      // Electron reports thumb buttons as "back" and "forward", which its typings omit.
      const button: string | undefined = mouse.button;
      if (button !== "back" && button !== "forward") return;
      if (mouse.type !== "mouseDown" && mouse.type !== "mouseUp") return;
      event.preventDefault();
      // The page never sees the press, so the guest replays it; these coordinates are DIPs, not CSS px.
      const zoom = wc.getZoomFactor();
      const phase = mouse.type === "mouseDown" ? "down" : "up";
      wc.send(
        THUMB_PRESS_CHANNEL,
        phase,
        mouse.x / zoom,
        mouse.y / zoom,
        button === "back" ? 3 : 4,
      );
      if (phase !== "up") return;
      runFork(
        attempt({ operation: "mouseNavigate", tabId, webContentsId: wc.id }, () => {
          if (button === "back") {
            if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
          } else if (wc.navigationHistory.canGoForward()) {
            wc.navigationHistory.goForward();
          }
        }).pipe(Effect.ignore),
      );
    };
    // Every guest of a focused window reports focus; GuestInput handles guests without a focused frame.
    const holdsKeyboardFocus = (contents: Electron.WebContents) =>
      contents.isFocused() && contents.focusedFrame !== null;
    const syncMenuShortcuts = (contents: Electron.WebContents, input: Electron.Input): void => {
      if (input.type !== "keyDown") return;
      setIgnoreMenuShortcuts(
        contents,
        !isPreviewEditingShortcut(input, hostPlatform) || !holdsKeyboardFocus(contents),
      );
    };
    // Popups inherit Electron's unrestricted window handler; block nested popups to bound the chain.
    const windowCreated = (window: Electron.BrowserWindow): void => {
      setIgnoreMenuShortcuts(window.webContents, true);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("before-input-event", (_event, input) => {
        syncMenuShortcuts(window.webContents, input);
      });
    };
    const findForwardedShortcut = (keys: Parameters<typeof matchesKeybindingShortcut>[0]) =>
      !(
        hostPlatform !== "darwin" &&
        keys.ctrlKey &&
        keys.altKey &&
        /^(?:[^a-zA-Z0-9]|Dead)$/u.test(keys.key)
      ) &&
      getForwardedShortcuts().find(({ shortcut }) =>
        matchesKeybindingShortcut(
          keys,
          shortcut,
          hostPlatform === "darwin" ? "MacIntel" : hostPlatform,
        ),
      );
    const beforeInput = (event: Electron.Event, input: Electron.Input): void => {
      syncMenuShortcuts(wc, input);
      const host = wc.hostWebContents;
      const forwarded =
        input.type === "keyDown" &&
        !input.isComposing &&
        host &&
        !host.isDestroyed() &&
        holdsKeyboardFocus(wc) &&
        findForwardedShortcut({
          key: input.key,
          code: input.code,
          metaKey: input.meta,
          ctrlKey: input.control,
          shiftKey: input.shift,
          altKey: input.alt,
        });
      if (forwarded && host) {
        // The page keeps these keys. Only the main-frame preload can report one it
        // left unhandled, so a focused iframe (e.g. Google Docs' input) keeps its own find or zoom.
        if (PAGE_FIRST_FORWARDED_COMMANDS.has(forwarded.command)) return;
        event.preventDefault();
        if (!input.isAutoRepeat) {
          if (
            forwarded.command === "workspace.focusNext" ||
            forwarded.command === "workspace.focusPrevious" ||
            forwarded.command === "preview.focusUrl"
          ) {
            // DOM focus in the renderer cannot by itself release the guest's native keyboard focus.
            host.focus();
          }
          host.send(MENU_ACTION_CHANNEL, forwarded.command);
        }
        return;
      }
      if (isPreviewRefreshShortcut(input, hostPlatform)) {
        event.preventDefault();
        runFork(
          attempt({ operation: "shortcut.refresh", tabId, webContentsId: wc.id }, () =>
            wc.reload(),
          ).pipe(Effect.ignore),
        );
        return;
      }
    };
    const pageUnhandledShortcut = (_event: unknown, rawKeys?: unknown): void => {
      const host = wc.hostWebContents;
      if (!host || host.isDestroyed() || !holdsKeyboardFocus(wc)) return;
      const keys = decodePageShortcutKeys(rawKeys);
      if (Option.isNone(keys)) return;
      const forwarded = findForwardedShortcut(keys.value);
      if (!forwarded || !PAGE_FIRST_FORWARDED_COMMANDS.has(forwarded.command)) return;
      host.send(MENU_ACTION_CHANNEL, forwarded.command);
    };
    yield* Scope.addFinalizer(
      scope,
      attempt({ operation: "detachListeners", tabId, webContentsId: wc.id }, () => {
        cancelFaviconCapture();
        wc.off("did-start-navigation", navigationStarted);
        wc.off("did-navigate", syncNavigation);
        wc.off("did-navigate-in-page", syncInPageNavigation);
        wc.off("page-title-updated", sync);
        wc.off("page-favicon-updated", faviconUpdated as never);
        wc.off("did-start-loading", sync);
        wc.off("did-stop-loading", sync);
        wc.off("dom-ready", restoreRecordingCursor);
        wc.off("did-fail-load", failed as never);
        wc.off("audio-state-changed", audioStateChanged);
        wc.off("found-in-page", foundInPage as never);
        wc.off("did-create-window", windowCreated);
        wc.off("before-input-event", beforeInput);
        wc.off("before-mouse-event", beforeMouse);
        wc.ipc.off(HUMAN_INPUT_CHANNEL, humanInput);
        wc.ipc.off(RECORDING_INPUT_CHANNEL, recordingInput);
        wc.ipc.off(PAGE_UNHANDLED_SHORTCUT_CHANNEL, pageUnhandledShortcut);
        detachPasskeys();
      }).pipe(Effect.ignore),
    );
    const install = Effect.fn("PreviewManager.installWebContentsListeners")(function* () {
      yield* attempt({ operation: "attachListeners", tabId, webContentsId: wc.id }, () => {
        setIgnoreMenuShortcuts(wc, true);
        wc.on("did-start-navigation", navigationStarted);
        wc.on("did-navigate", syncNavigation);
        wc.on("did-navigate-in-page", syncInPageNavigation);
        wc.on("page-title-updated", sync);
        wc.on("page-favicon-updated", faviconUpdated as never);
        wc.on("did-start-loading", sync);
        wc.on("did-stop-loading", sync);
        wc.on("dom-ready", restoreRecordingCursor);
        wc.on("did-fail-load", failed as never);
        wc.on("audio-state-changed", audioStateChanged);
        wc.on("found-in-page", foundInPage as never);
        wc.ipc.on(HUMAN_INPUT_CHANNEL, humanInput);
        wc.ipc.on(RECORDING_INPUT_CHANNEL, recordingInput);
        wc.ipc.on(PAGE_UNHANDLED_SHORTCUT_CHANNEL, pageUnhandledShortcut);
        detachPasskeys = passkeys.attachGuest(wc);
        wc.setWindowOpenHandler((details) => {
          const action = previewWindowOpenAction(details);
          if (action === "popup") {
            return { action: "allow", overrideBrowserWindowOptions: POPUP_WINDOW_OPTIONS };
          }
          if (action === "deny") return { action: "deny" };
          if (action === "new-tab") {
            runFork(
              emitOpenLink({
                tabId,
                url: details.url,
                // A person's own click or key leaves the guest a focused frame; GuestInput hands
                // focus back after the agent's press, so a foreground tab would take it again.
                background:
                  details.disposition === "background-tab" ||
                  (wc.focusedFrame === null && browserHost.agentLedPage(wc)),
              }),
            );
            return { action: "deny" };
          }
          const { postBody } = details;
          runFork(
            attemptPromise({ operation: "openPreviewWindow", tabId, webContentsId: wc.id }, () =>
              postBody
                ? wc.loadURL(details.url, {
                    postData: postBody.data,
                    extraHeaders: postBody.boundary
                      ? `content-type: ${postBody.contentType}; boundary=${postBody.boundary}`
                      : `content-type: ${postBody.contentType}`,
                  })
                : wc.loadURL(details.url),
            ).pipe(Effect.ignore),
          );
          return { action: "deny" };
        });
        wc.on("did-create-window", windowCreated);
        wc.on("before-input-event", beforeInput);
        wc.on("before-mouse-event", beforeMouse);
      });
      yield* Ref.update(attachedRef, (attached) =>
        replaceMap(attached, (copy) => {
          copy.set(wc.id, { attachmentId, cancelFaviconCapture, scope, webContents: wc });
        }),
      );
    });
    yield* install().pipe(Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)));
  });

  return {
    detachListeners,
    attachListeners,
  };
};
