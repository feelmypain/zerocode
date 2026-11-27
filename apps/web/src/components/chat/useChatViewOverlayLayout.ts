import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { observeResize } from "~/lib/observeResize";
import { useStableCallback } from "../../hooks/useStableCallback";
import { resolveScrollToEndClearance } from "../composerFooterLayout";

interface ChatViewOverlayLayoutInput {
  readonly activeThreadKey: string | null;
  readonly composerMounted: boolean;
  readonly isDraftHeroState: boolean;
}

export function useChatViewOverlayLayout(input: ChatViewOverlayLayoutInput) {
  const { activeThreadKey, composerMounted, isDraftHeroState } = input;
  const [composerOverlayElement, setComposerOverlayElement] = useState<HTMLDivElement | null>(null);
  const [composerTimelineInset, setComposerTimelineInset] = useState(0);
  const composerTimelineInsetRef = useRef(0);
  const [composerReservedHeight, setComposerReservedHeight] = useState(0);
  const composerReservedHeightRef = useRef(0);
  const composerExpandedHeightRef = useRef(0);
  const scrollToEndClearanceRef = useRef(-1);

  const updateScrollToEndClearanceCssVar = (overlayHeight: number) => {
    const container = composerOverlayElement?.parentElement;
    if (!composerOverlayElement || !container || overlayHeight <= 0) return;
    const mainSurface = composerOverlayElement.querySelector<HTMLElement>(
      '[data-chat-composer-main-surface="true"]',
    );
    const button = container.querySelector<HTMLElement>("[data-scroll-to-end]");
    const clearance =
      mainSurface && button
        ? resolveScrollToEndClearance({
            overlayHeight,
            mainSurfaceTop: mainSurface.getBoundingClientRect().top,
            button: button.getBoundingClientRect(),
            attachments: Array.from(
              composerOverlayElement.querySelectorAll<HTMLElement>(
                '[data-composer-banner-surface="attached"]',
              ),
              (element) => element.getBoundingClientRect(),
            ),
          })
        : overlayHeight;
    if (scrollToEndClearanceRef.current !== clearance) {
      scrollToEndClearanceRef.current = clearance;
      container.style.setProperty("--chat-scroll-to-end-clearance", `${clearance}px`);
    }
  };
  const updateScrollToEndClearanceCssVarStable = useStableCallback(
    updateScrollToEndClearanceCssVar,
  );

  const publishComposerOverlayHeight = (height: number) => {
    const nextHeight = Math.ceil(height);
    if (nextHeight <= 0) return;
    const container = composerOverlayElement?.parentElement;
    if (composerTimelineInsetRef.current !== nextHeight) {
      composerTimelineInsetRef.current = nextHeight;
      container?.style.setProperty("--chat-composer-overlay-height", `${nextHeight}px`);
      setComposerTimelineInset(nextHeight);
    }
    // Reserve the expanded composer height for the terminal drawer and empty placeholder.
    // Keep it while the mobile strip collapses, but allow growth from approvals or tasks.
    // A hero overlay fills the pane, so reserve only its stack.
    const stack = composerOverlayElement?.querySelector<HTMLElement>(
      '[data-chat-composer-stack="true"]',
    );
    const expandedComposerHeight =
      isDraftHeroState && stack ? Math.ceil(stack.getBoundingClientRect().height) : nextHeight;
    const mobileCollapsed = Boolean(
      stack?.querySelector('[data-chat-composer-mobile-collapsed="true"]'),
    );
    if (!mobileCollapsed) composerExpandedHeightRef.current = expandedComposerHeight;
    const reservedHeight = Math.max(composerExpandedHeightRef.current, expandedComposerHeight);
    if (composerReservedHeightRef.current !== reservedHeight) {
      composerReservedHeightRef.current = reservedHeight;
      container?.style.setProperty("--chat-composer-reserved-height", `${reservedHeight}px`);
      setComposerReservedHeight(reservedHeight);
    }
    updateScrollToEndClearanceCssVar(nextHeight);
  };
  const publishComposerOverlayHeightStable = useStableCallback(publishComposerOverlayHeight);

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- measures the composer overlay element before paint for a new thread or composer mount
  useLayoutEffect(() => {
    if (!composerOverlayElement) return;
    composerTimelineInsetRef.current = 0;
    composerReservedHeightRef.current = 0;
    composerExpandedHeightRef.current = 0;
    scrollToEndClearanceRef.current = -1;
    publishComposerOverlayHeightStable(composerOverlayElement.getBoundingClientRect().height);
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A thread switch or a composer mount/unmount must re-measure the overlay for the new timeline.
    activeThreadKey,
    composerMounted,
    composerOverlayElement,
    publishComposerOverlayHeightStable,
  ]);

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- observes the composer overlay element's size and publishes its height without flushSync
  useLayoutEffect(() => {
    if (!composerOverlayElement) return;

    const updateHeight = () => {
      publishComposerOverlayHeightStable(composerOverlayElement.getBoundingClientRect().height);
    };

    updateHeight();
    // The hero overlay fills the pane, so the composer's own growth only shows on its stack.
    const stack = isDraftHeroState
      ? composerOverlayElement.querySelector<HTMLElement>('[data-chat-composer-stack="true"]')
      : null;
    return observeResize(
      stack ? [composerOverlayElement, stack] : composerOverlayElement,
      updateHeight,
      { sync: false },
    );
  }, [composerOverlayElement, isDraftHeroState, publishComposerOverlayHeightStable]);

  return {
    composerOverlayElement,
    setComposerOverlayElement,
    composerTimelineInset,
    composerReservedHeight,
    composerTimelineInsetRef,
    publishComposerOverlayHeightStable,
    updateScrollToEndClearanceCssVarStable,
  };
}

export function useScrollToEndClearanceSync(input: {
  readonly showScrollToBottom: boolean;
  readonly isThreadFindActive: boolean;
  readonly composerOverlayElement: HTMLDivElement | null;
  readonly composerTimelineInsetRef: RefObject<number>;
  readonly updateScrollToEndClearanceCssVarStable: (overlayHeight: number) => void;
}) {
  const {
    showScrollToBottom,
    isThreadFindActive,
    composerOverlayElement,
    composerTimelineInsetRef,
    updateScrollToEndClearanceCssVarStable,
  } = input;

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- positions the scroll-to-end button via CSS variable when it mounts without re-subscribing ResizeObserver
  useLayoutEffect(() => {
    if (!showScrollToBottom || isThreadFindActive || !composerOverlayElement) return;
    const height =
      composerTimelineInsetRef.current > 0
        ? composerTimelineInsetRef.current
        : Math.ceil(composerOverlayElement.getBoundingClientRect().height);
    updateScrollToEndClearanceCssVarStable(height);
  }, [
    composerOverlayElement,
    composerTimelineInsetRef,
    isThreadFindActive,
    showScrollToBottom,
    updateScrollToEndClearanceCssVarStable,
  ]);
}
