import { resolveTimelineMinimapPreview, type TimelineMinimapItem } from "./timelineMinimapItems";
import { memo, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { T, useGT } from "gt-react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  isTimelineMinimapTurnVisible,
  resolveTimelineMinimapCurrentIndex,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapHitStrip,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapNavigationInteractive,
  resolveTimelineMinimapTopPercent,
  resolveTimelineMinimapVisibleRange,
  TIMELINE_MINIMAP_MIN_ITEMS,
  TIMELINE_MINIMAP_TARGET_OFFSET,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";

interface TimelineMinimapHandlers {
  readonly onRefresh: () => void;
  readonly onGutter: (sideGutter: number) => void;
  readonly onHeaderSize: (headerSize: number) => void;
}

interface TimelineMinimapController {
  readonly scheduleRefresh: () => void;
  readonly updateGutter: (sideGutter: number) => void;
  readonly updateHeaderSize: (headerSize: number) => void;
  readonly attach: (handlers: TimelineMinimapHandlers) => () => void;
}

/** Imperative bridge so scroll and gutter updates only re-render the minimap, never the timeline. */
export function createTimelineMinimapController(): TimelineMinimapController {
  let handlers: TimelineMinimapHandlers | null = null;
  let lastSideGutter: number | null = null;
  let lastHeaderSize = 0;
  let refreshQueued = false;

  return {
    scheduleRefresh: () => {
      if (handlers) handlers.onRefresh();
      else refreshQueued = true;
    },
    updateGutter: (sideGutter: number) => {
      lastSideGutter = sideGutter;
      handlers?.onGutter(sideGutter);
    },
    updateHeaderSize: (headerSize: number) => {
      lastHeaderSize = headerSize;
      handlers?.onHeaderSize(headerSize);
    },
    attach: (nextHandlers) => {
      handlers = nextHandlers;
      nextHandlers.onHeaderSize(lastHeaderSize);
      if (lastSideGutter !== null) nextHandlers.onGutter(lastSideGutter);
      if (refreshQueued) {
        refreshQueued = false;
        nextHandlers.onRefresh();
      }
      return () => {
        if (handlers === nextHandlers) handlers = null;
      };
    },
  };
}

// A release outside the window can skip `mouseup`, so the next button-free
// `mousemove` also counts.
function onMouseButtonsReleased(onRelease: () => void): () => void {
  const check = (event: globalThis.MouseEvent) => {
    if (event.buttons !== 0) return;
    stop();
    onRelease();
  };
  const stop = () => {
    window.removeEventListener("mouseup", check);
    window.removeEventListener("mousemove", check);
  };
  window.addEventListener("mouseup", check);
  window.addEventListener("mousemove", check);
  return stop;
}

export const TimelineMinimap = memo(function TimelineMinimap({
  controller,
  listRef,
  rows,
  items,
  restoringThreadPosition,
  onWheel,
  onSelect,
}: {
  controller: TimelineMinimapController;
  listRef: RefObject<LegendListRef | null>;
  rows: ReadonlyArray<MessagesTimelineRow>;
  items: ReadonlyArray<TimelineMinimapItem>;
  restoringThreadPosition: boolean;
  onWheel: (event: WheelEvent) => void;
  onSelect: (item: TimelineMinimapItem) => void;
}) {
  const gt = useGT();
  const [hasPersistentGutter, setHasPersistentGutter] = useState(false);
  const [hitStrip, setHitStrip] = useState({ left: 0, width: 0 });
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [atEnd, setAtEnd] = useState(false);
  const [stripMap] = useState(() => new Map<string, HTMLSpanElement>());
  const headerSizeRef = useRef(0);
  const refreshFrameRef = useRef<number | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const wheelTargetRef = (node: HTMLDivElement | null) => {
    if (!node) return;
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  };

  const pressedOnStripRef = useRef(false);
  const [passThrough, setPassThrough] = useState(false);
  const minimapRowIndices = items.map((item) => item.rowIndex);

  const refreshMinimap = useStableCallback(() => {
    const state = listRef.current?.getState?.();
    if (restoringThreadPosition || !state || state.data !== rows || items.length === 0) {
      return;
    }

    // Cached row positions exclude the header; subtract the observed header height to avoid layout reads.
    const scroll = Math.max(0, state.scroll - headerSizeRef.current);
    const nextAtEnd =
      Number.isFinite(state.contentLength) &&
      Number.isFinite(state.scroll) &&
      Number.isFinite(state.scrollLength)
        ? state.contentLength - state.scroll - state.scrollLength <= 1
        : false;
    const visibleRange = resolveTimelineMinimapVisibleRange({ ...state, scroll });
    for (const [index, item] of items.entries()) {
      const strip = stripMap.get(item.id);
      const inView = isTimelineMinimapTurnVisible(
        item.rowIndex,
        items[index + 1]?.rowIndex,
        visibleRange.start,
        visibleRange.end,
      );
      const next = inView ? "true" : "false";
      // Avoid dirtying style state on every scroll tick for unchanged strips.
      if (strip && strip.dataset.inView !== next) {
        strip.dataset.inView = next;
      }
    }
    // Ignore rows ending within the offset minimap navigation leaves above its target, or
    // Next turn keeps retargeting the same row. 1px absorbs device-pixel scroll rounding.
    const currentInset = TIMELINE_MINIMAP_TARGET_OFFSET + 1;
    const currentRange = resolveTimelineMinimapVisibleRange({
      ...state,
      scroll: scroll + currentInset,
      scrollLength: state.scrollLength - currentInset,
    });
    const nextCurrentIndex = resolveTimelineMinimapCurrentIndex({
      visibleStart: currentRange.start,
      visibleEnd: currentRange.end,
      rowIndices: minimapRowIndices,
    });
    setCurrentIndex((current) => (current === nextCurrentIndex ? current : nextCurrentIndex));
    // The exact bottom, not the follow re-arm zone: Next can still scroll inside that zone.
    setAtEnd((current) => (current === nextAtEnd ? current : nextAtEnd));
  });

  const scheduleRefresh = useStableCallback(() => {
    if (refreshFrameRef.current !== null) return;
    // LegendList recycles row containers before React commits their positions.
    refreshFrameRef.current = requestAnimationFrame(() => {
      refreshFrameRef.current = null;
      refreshMinimap();
    });
  });

  const applyGutter = useStableCallback((sideGutter: number) => {
    const nextHasPersistentGutter = resolveTimelineMinimapHasPersistentGutter(sideGutter);
    setHasPersistentGutter((current) =>
      current === nextHasPersistentGutter ? current : nextHasPersistentGutter,
    );
    const nextHitStrip = resolveTimelineMinimapHitStrip(sideGutter);
    setHitStrip((current) =>
      current.left === nextHitStrip.left && current.width === nextHitStrip.width
        ? current
        : nextHitStrip,
    );
  });

  const applyHeaderSize = useStableCallback((headerSize: number) => {
    if (headerSizeRef.current === headerSize) return;
    headerSizeRef.current = headerSize;
    scheduleRefresh();
  });

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- subscribes the minimap to imperative timeline scroll and layout notifications without re-rendering the timeline
  useLayoutEffect(() => {
    const detach = controller.attach({
      onRefresh: scheduleRefresh,
      onGutter: applyGutter,
      onHeaderSize: applyHeaderSize,
    });
    return () => {
      detach();
      if (refreshFrameRef.current !== null) {
        cancelAnimationFrame(refreshFrameRef.current);
        refreshFrameRef.current = null;
      }
    };
  }, [applyGutter, applyHeaderSize, controller, scheduleRefresh]);

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- the minimap skips refreshes until the restore commits, and the restore can land without a scroll event
  useLayoutEffect(() => {
    if (!restoringThreadPosition) scheduleRefresh();
  }, [restoringThreadPosition, scheduleRefresh]);

  const { left: hitStripLeft, width: hitStripWidth } = hitStrip;

  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem = resolveTimelineMinimapPreview(
    resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null),
  );
  const navigationInteractive =
    resolveTimelineMinimapNavigationInteractive(hitStripWidth) && !passThrough;
  const activeTopPercent =
    resolvedActiveIndex === null
      ? 0
      : resolveTimelineMinimapTopPercent(resolvedActiveIndex, items.length);
  const resolvedCurrentIndex =
    currentIndex !== null && currentIndex >= 0 && currentIndex < items.length ? currentIndex : null;
  const previousItem =
    resolvedCurrentIndex === null ? null : (items[resolvedCurrentIndex - 1] ?? null);
  const nextItem =
    resolvedCurrentIndex === null || atEnd ? null : (items[resolvedCurrentIndex + 1] ?? null);

  const resolveActiveIndexFromPointer = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return resolveTimelineMinimapIndexFromPointer({
      itemCount: items.length,
      railTop: rect.top,
      railHeight: rect.height,
      pointerY: event.clientY,
    });
  };

  const updateActiveIndexFromPointer = (event: MouseEvent<HTMLElement>) => {
    const nextIndex = resolveActiveIndexFromPointer(event);
    setActiveIndex(nextIndex);
  };

  const moveActiveIndex = (delta: number) => {
    setActiveIndex((current) => {
      const base = current ?? 0;
      return Math.max(0, Math.min(items.length - 1, base + delta));
    });
  };

  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS) {
    return null;
  }

  return (
    <div
      className={cn(
        "group/minimap pointer-events-none absolute bottom-0 left-0 top-[calc(-1*var(--chat-header-height,0px))] z-40 w-18",
        hasPersistentGutter
          ? "opacity-100"
          : "hidden opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100 [@media(pointer:fine)]:block",
      )}
      data-testid="timeline-minimap"
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
      ref={wheelTargetRef}
    >
      <div className="relative h-full w-full select-none">
        <div
          className={cn(
            "absolute top-1/2 -translate-y-1/2",
            hitStripWidth > 0 && !passThrough ? "pointer-events-auto" : "pointer-events-none",
          )}
          onMouseDown={() => {
            if (pressedOnStripRef.current) return;
            pressedOnStripRef.current = true;
            onMouseButtonsReleased(() => {
              pressedOnStripRef.current = false;
            });
          }}
          onMouseMove={(event) => {
            if (event.buttons === 0 || pressedOnStripRef.current || passThrough) return;
            setPassThrough(true);
            onMouseButtonsReleased(() => setPassThrough(false));
          }}
          style={{
            height: resolveTimelineMinimapHeightStyle(items.length),
            left: hitStripLeft,
            width: hitStripWidth,
          }}
        >
          <TimelineMinimapNavigationButton
            direction="previous"
            disabled={previousItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (previousItem) onSelect(previousItem);
            }}
          />
          <button
            aria-label={gt("Jump to message: {text}", {
              text: activeItem?.userText ?? gt("User message"),
            })}
            className="absolute inset-y-0 left-0 w-full cursor-pointer bg-transparent before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            onBlur={() => setActiveIndex(null)}
            onClick={(event) => {
              const nextIndex = resolveActiveIndexFromPointer(event);
              const selectedItem = nextIndex === null ? null : (items[nextIndex] ?? null);
              if (selectedItem) {
                onSelect(selectedItem);
              }
              event.currentTarget.blur();
            }}
            onFocus={() => setActiveIndex((current) => current ?? resolvedCurrentIndex ?? 0)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActiveIndex(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActiveIndex(-1);
              } else if (event.key === "Home") {
                event.preventDefault();
                setActiveIndex(0);
              } else if (event.key === "End") {
                event.preventDefault();
                setActiveIndex(items.length - 1);
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (activeItem) {
                  onSelect(activeItem);
                }
              }
            }}
            onMouseLeave={() => setActiveIndex(null)}
            onMouseMove={(event) => {
              if (event.buttons !== 0 && !pressedOnStripRef.current) return;
              updateActiveIndexFromPointer(event);
            }}
            onMouseDown={(event) => event.preventDefault()}
            type="button"
          >
            {items.map((item, index) => {
              const top = `${resolveTimelineMinimapTopPercent(index, items.length)}%`;
              const activeDistance =
                resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex);
              return (
                // Compositor-friendly on purpose: in-view state and the hover
                // fisheye animate constantly (every scroll tick and streaming
                // update flips a band of strips), so the strip animates only
                // transform and opacity.
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute left-0 h-0.5 w-6 origin-left -translate-y-1/2 rounded-full transition-transform duration-150 after:absolute after:inset-0 after:rounded-full after:bg-foreground/55 after:opacity-0 after:transition-opacity after:duration-150 data-[in-view=true]:after:opacity-100",
                    activeDistance === 0 ? "bg-muted-foreground/60" : "bg-muted-foreground/25",
                    activeDistance === 0
                      ? "scale-x-100"
                      : activeDistance === 1
                        ? "scale-x-[0.667]"
                        : activeDistance === 2
                          ? "scale-x-[0.417]"
                          : "scale-x-[0.333]",
                  )}
                  data-in-view="false"
                  data-minimap-strip
                  key={item.id}
                  ref={(node) => {
                    if (node) {
                      stripMap.set(item.id, node);
                    } else {
                      stripMap.delete(item.id);
                    }
                  }}
                  style={{ top }}
                />
              );
            })}
            {activeItem ? (
              // Display-only: it overlaps the message column, and the strip keeps tracking beneath it.
              <span
                className="pointer-events-none absolute left-8 w-80 -translate-y-1/2"
                style={{ top: `${activeTopPercent}%` }}
              >
                <span className="dropdown-glass block rounded-xl p-3 text-left text-popover-foreground shadow-xl shadow-black/25">
                  <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                    {activeItem.userText ?? <T>User message</T>}
                  </span>
                  {activeItem.assistantText ? (
                    <span
                      className="mt-1 max-h-[3.75rem] overflow-hidden text-muted-foreground text-sm leading-5"
                      style={{
                        display: "-webkit-box",
                        WebkitBoxOrient: "vertical",
                        WebkitLineClamp: 3,
                      }}
                    >
                      {activeItem.assistantText}
                    </span>
                  ) : null}
                </span>
              </span>
            ) : null}
          </button>
          <TimelineMinimapNavigationButton
            direction="next"
            disabled={nextItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (nextItem) onSelect(nextItem);
            }}
          />
        </div>
      </div>
    </div>
  );
});

function TimelineMinimapNavigationButton({
  direction,
  disabled,
  interactive,
  onClick,
}: {
  direction: "previous" | "next";
  disabled: boolean;
  interactive: boolean;
  onClick: () => void;
}) {
  const gt = useGT();
  const previous = direction === "previous";
  const label = previous ? gt("Previous turn") : gt("Next turn");
  const Icon = previous ? ChevronUpIcon : ChevronDownIcon;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "absolute left-1 z-10 inline-flex -translate-x-1/2 opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
              interactive ? "pointer-events-auto" : "pointer-events-none",
              previous ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]",
            )}
          />
        }
      >
        <Button
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          size="icon-micro"
          type="button"
          variant="ghost-muted"
        >
          <Icon className="size-4 text-foreground/90" />
        </Button>
      </TooltipTrigger>
      <TooltipPopup side={previous ? "top" : "bottom"}>{label}</TooltipPopup>
    </Tooltip>
  );
}
