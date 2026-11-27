import {
  DesktopPreviewAnnotationVoiceEventSchema,
  type DesktopPreviewAnnotationTheme,
  type DesktopPreviewAnnotationVoiceConfig,
  type DesktopPreviewAnnotationVoiceState,
  type PreviewAnnotationSubmissionResult,
} from "@zerocode/contracts/ipc";
import { type BrowserWindow, webContents } from "electron";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { PREVIEW_ANNOTATION_VOICE_EVENT_CHANNEL } from "../ipc/channels.ts";
import {
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_SEND_ENABLED_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  ANNOTATION_VOICE_EVENT_CHANNEL,
  ANNOTATION_VOICE_STATE_CHANNEL,
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  START_PICK_CHANNEL,
} from "./GuestProtocol.ts";
import { isPreviewAnnotationPayload } from "./PickedElementPayload.ts";
import { cropAnnotationScreenshot, normalizeCaptureRect } from "./PreviewCaptureHelpers.ts";
import {
  attempt,
  replaceMap,
  type PickSession,
  type PreviewManagerError,
  type PreviewOperationContext,
  type PreviewTabState,
} from "./PreviewTypes.ts";

const decodeAnnotationVoiceEvent = Schema.decodeUnknownOption(
  DesktopPreviewAnnotationVoiceEventSchema,
);

export interface PreviewAnnotationControllerDeps {
  readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly mainWindowRef: Ref.Ref<Option.Option<BrowserWindow>>;
  readonly tabsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, PreviewTabState>>;
  readonly annotationThemeRef: Ref.Ref<DesktopPreviewAnnotationTheme>;
  readonly pickSessionsRef: Ref.Ref<ReadonlyMap<string, PickSession>>;
  readonly annotationSendEnabled: Map<string, boolean>;
  readonly requireWebContents: (
    tabId: string,
  ) => Effect.Effect<Electron.WebContents, PreviewManagerError>;
  readonly capturePageWithRetry: (
    errorContext: PreviewOperationContext,
    tabId: string,
    wc: Electron.WebContents,
  ) => Effect.Effect<Electron.NativeImage, PreviewManagerError>;
}

export const makePreviewAnnotationController = (deps: PreviewAnnotationControllerDeps) => {
  const {
    runFork,
    mainWindowRef,
    tabsRef,
    annotationThemeRef,
    pickSessionsRef,
    annotationSendEnabled,
    requireWebContents,
    capturePageWithRetry,
  } = deps;

  const cancelPickElement = Effect.fn("PreviewManager.cancelPickElement")(function* (
    tabId: string,
  ) {
    const session = (yield* Ref.get(pickSessionsRef)).get(tabId);
    if (session) yield* session.cancel;
  });

  const setAnnotationTheme = Effect.fn("PreviewManager.setAnnotationTheme")(function* (
    theme: DesktopPreviewAnnotationTheme,
  ) {
    yield* Ref.set(annotationThemeRef, theme);
    const tabs = yield* SynchronizedRef.get(tabsRef);
    yield* Effect.forEach(
      tabs.values(),
      (tab) => {
        if (tab.webContentsId == null) return Effect.void;
        const wc = webContents.fromId(tab.webContentsId);
        return !wc || wc.isDestroyed()
          ? Effect.void
          : attempt(
              {
                operation: "setAnnotationTheme",
                tabId: tab.tabId,
                webContentsId: tab.webContentsId,
              },
              () => wc.send(ANNOTATION_THEME_CHANNEL, theme),
            ).pipe(Effect.ignore);
      },
      { discard: true },
    );
  });

  const setAnnotationSendEnabled = Effect.fn("PreviewManager.setAnnotationSendEnabled")(function* (
    tabId: string,
    enabled: boolean,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* attempt({ operation: "setAnnotationSendEnabled", tabId, webContentsId: wc.id }, () => {
      annotationSendEnabled.set(tabId, enabled);
      wc.send(ANNOTATION_SEND_ENABLED_CHANNEL, enabled);
    });
  });

  // Voice state reaches a guest only while its pick session, by id, still owns the tab.
  const updateAnnotationVoice = Effect.fn("PreviewManager.updateAnnotationVoice")(function* (
    state: DesktopPreviewAnnotationVoiceState,
  ) {
    const sessions = yield* Ref.get(pickSessionsRef);
    if (sessions.get(state.tabId)?.voiceSessionId !== state.sessionId) return;
    const wc = yield* requireWebContents(state.tabId);
    yield* attempt({ operation: "annotationVoice.update", tabId: state.tabId }, () =>
      wc.send(ANNOTATION_VOICE_STATE_CHANNEL, state),
    );
  });

  const pickElement = Effect.fn("PreviewManager.pickElement")(function* (
    tabId: string,
    voice?: DesktopPreviewAnnotationVoiceConfig,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* cancelPickElement(tabId);
    const annotationTheme = yield* Ref.get(annotationThemeRef);
    return yield* Effect.callback<PreviewAnnotationSubmissionResult | null, PreviewManagerError>(
      (resume) => {
        const session: PickSession = {
          voiceSessionId: voice?.sessionId,
          cancel: Effect.suspend(() => cancelPickSession()),
        };
        const cleanup = Effect.fn("PreviewManager.cleanupPickElement")(function* () {
          yield* attempt({ operation: "pickElement.cleanup", tabId, webContentsId: wc.id }, () => {
            wc.ipc.removeListener(ELEMENT_PICKED_CHANNEL, onMessage);
            wc.ipc.removeListener(ANNOTATION_VOICE_EVENT_CHANNEL, onVoiceEvent);
            wc.off("destroyed", onDestroyed);
            wc.off("did-start-navigation", onNavigated);
          }).pipe(Effect.ignore);
          // A newer session may already own the slot when this one is cancelled.
          yield* Ref.update(pickSessionsRef, (sessions) =>
            sessions.get(tabId) === session
              ? replaceMap(sessions, (copy) => {
                  copy.delete(tabId);
                })
              : sessions,
          );
        });
        let settled = false;
        const claimSettle = (): boolean => {
          if (settled) return false;
          settled = true;
          return true;
        };
        const finishPick = Effect.fn("PreviewManager.finishPickElement")(function* (
          payload: PreviewAnnotationSubmissionResult | null,
        ) {
          yield* cleanup();
          resume(Effect.succeed(payload));
        });
        const settlePick = Effect.fn("PreviewManager.settlePickElement")(function* (
          payload: PreviewAnnotationSubmissionResult | null,
        ) {
          if (!claimSettle()) return;
          yield* finishPick(payload);
        });
        const settle = (payload: PreviewAnnotationSubmissionResult | null) => {
          runFork(settlePick(payload));
        };
        const cancelPickSession = Effect.fn("PreviewManager.cancelPickSession")(function* () {
          if (!claimSettle()) return;
          yield* cleanup();
          const tabs = yield* SynchronizedRef.get(tabsRef);
          const activeTab = tabs.get(tabId);
          if (activeTab?.webContentsId != null) {
            const activeWc = webContents.fromId(activeTab.webContentsId);
            if (activeWc && !activeWc.isDestroyed()) {
              yield* attempt(
                {
                  operation: "cancelPickElement",
                  tabId,
                  webContentsId: activeWc.id,
                },
                () => activeWc.send(CANCEL_PICK_CHANNEL),
              ).pipe(Effect.ignore);
            }
          }
          resume(Effect.succeed(null));
        });
        const onMessage = (_event: Electron.IpcMainEvent, ...args: unknown[]): void => {
          const payload = args[0];
          if (!isPreviewAnnotationPayload(payload)) {
            settle(null);
            return;
          }
          const cropRect = normalizeCaptureRect(args[1]);
          const submission =
            args[2] === "send" && annotationSendEnabled.get(tabId) === true ? "send" : "attach";
          const devicePixelRatio = typeof args[3] === "number" ? args[3] : 1;
          const targetRects = [
            ...payload.elements.map((target) => target.rect),
            ...payload.regions.map((target) => target.rect),
            ...payload.strokes.map((target) => target.bounds),
          ];
          runFork(
            capturePageWithRetry(
              { operation: "captureAnnotationScreenshot", tabId, webContentsId: wc.id },
              tabId,
              wc,
            ).pipe(
              Effect.map((image) =>
                cropAnnotationScreenshot(image, cropRect, devicePixelRatio, targetRects),
              ),
              Effect.tapError((error) =>
                Effect.logWarning("preview annotation screenshot failed").pipe(
                  Effect.annotateLogs({ tabId, webContentsId: wc.id, error: error.message }),
                ),
              ),
              Effect.withSpan("PreviewManager.captureAnnotationScreenshot"),
              Effect.match({
                onFailure: (): PreviewAnnotationSubmissionResult => ({
                  annotation: payload,
                  submission,
                  screenshotFailed: true,
                }),
                onSuccess: (screenshot): PreviewAnnotationSubmissionResult =>
                  screenshot === null
                    ? { annotation: payload, submission, screenshotFailed: true }
                    : { annotation: { ...payload, screenshot }, submission },
              }),
              Effect.flatMap((result) => {
                // Late captures must not signal an overlay that may now belong to a newer pick.
                if (!claimSettle()) return Effect.void;
                return attempt(
                  { operation: "pickElement.captureComplete", tabId, webContentsId: wc.id },
                  () => {
                    if (!wc.isDestroyed()) wc.send(ANNOTATION_CAPTURED_CHANNEL);
                  },
                ).pipe(Effect.ignore, Effect.andThen(finishPick(result)));
              }),
            ),
          );
        };
        // Only this guest's listener sees these; the renderer still checks the session id.
        const onVoiceEvent = (_event: Electron.IpcMainEvent, value: unknown) => {
          const decoded = decodeAnnotationVoiceEvent(value);
          if (settled || !voice || Option.isNone(decoded)) return;
          if (decoded.value.sessionId !== voice.sessionId) return;
          runFork(
            Effect.gen(function* () {
              const window = yield* Ref.get(mainWindowRef);
              if (Option.isNone(window) || window.value.isDestroyed()) return;
              yield* attempt({ operation: "annotationVoice.forward", tabId }, () =>
                window.value.webContents.send(
                  PREVIEW_ANNOTATION_VOICE_EVENT_CHANNEL,
                  tabId,
                  decoded.value,
                ),
              ).pipe(Effect.ignore);
            }),
          );
        };
        const onDestroyed = () => settle(null);
        const onNavigated = (
          event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
        ) => {
          if (event.isMainFrame) settle(null);
        };
        const registerPickElement = Effect.fn("PreviewManager.registerPickElement")(function* () {
          // Atomically swap/cancel overlapping picks so another pick cannot claim a transient empty slot.
          const replaced = yield* Ref.modify(pickSessionsRef, (sessions) => [
            sessions.get(tabId) ?? null,
            replaceMap(sessions, (copy) => {
              copy.set(tabId, session);
            }),
          ]);
          if (replaced) yield* replaced.cancel;
          // A newer pick may cancel during teardown; do not leak listeners or start an abandoned overlay.
          if (settled) return;
          yield* attempt({ operation: "pickElement.register", tabId, webContentsId: wc.id }, () => {
            wc.ipc.on(ELEMENT_PICKED_CHANNEL, onMessage);
            if (voice) wc.ipc.on(ANNOTATION_VOICE_EVENT_CHANNEL, onVoiceEvent);
            wc.once("destroyed", onDestroyed);
            wc.on("did-start-navigation", onNavigated);
            if (!wc.isFocused()) wc.focus();
            wc.send(
              START_PICK_CHANNEL,
              annotationTheme,
              annotationSendEnabled.get(tabId) === true,
              voice,
            );
          });
        });
        runFork(
          registerPickElement().pipe(
            Effect.catch((error: PreviewManagerError) => {
              if (!claimSettle()) return Effect.void;
              resume(Effect.fail(error));
              return cleanup();
            }),
          ),
        );
        return session.cancel;
      },
    );
  });

  return {
    cancelPickElement,
    setAnnotationTheme,
    setAnnotationSendEnabled,
    updateAnnotationVoice,
    pickElement,
  };
};
