import { useEffect, useRef } from "react";

import { useChatWallpaper } from "~/chatWallpaper";
import { useClientSettings } from "~/hooks/useSettings";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { drawAsciiArtToCanvas } from "~/lib/asciiArt";
import { observeResize } from "~/lib/observeResize";

export function ChatWallpaperOverlay() {
  const { url, source } = useChatWallpaper();
  const asciiEnabled = useClientSettings((settings) => settings.chatWallpaperAsciiEnabled);
  const preset = useClientSettings((settings) => settings.chatWallpaperAsciiPreset);
  const glyphSizePx = useClientSettings((settings) => settings.chatWallpaperAsciiSize);
  const colorMode = useClientSettings((settings) => settings.chatWallpaperAsciiColorMode);
  const opacity = useClientSettings((settings) => settings.chatWallpaperOpacity);
  const appearance = useRenderedAppearance();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const showAscii = url !== null && asciiEnabled;
  const showCustomImage = url !== null && !asciiEnabled && source === "custom";

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- Synchronizes imperative HTML5 canvas pixels with the wallpaper image, ASCII settings, and container resize events.
  useEffect(() => {
    if (!showAscii || url === null) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let rafId: number | null = null;
    const image = new Image();

    const draw = () => {
      if (cancelled) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const monochromeColor = getComputedStyle(canvas).color || "currentColor";
      drawAsciiArtToCanvas(canvas, image, {
        width: rect.width,
        height: rect.height,
        dpr: window.devicePixelRatio || 1,
        preset,
        glyphSizePx,
        colorMode,
        appearance,
        monochromeColor,
      });
    };

    const scheduleDraw = () => {
      if (cancelled || !image.complete || image.naturalWidth === 0) return;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        draw();
      });
    };

    image.onload = () => {
      draw();
    };
    image.src = url;

    const stopObserving = observeResize(canvas, scheduleDraw);

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      stopObserving();
    };
  }, [appearance, colorMode, glyphSizePx, preset, showAscii, url]);

  if (showAscii) {
    return (
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        data-chat-wallpaper-ascii-canvas="true"
        className="pointer-events-none absolute inset-0 z-0 h-full w-full select-none text-foreground"
        style={{ opacity: opacity / 100 }}
      />
    );
  }

  if (showCustomImage && url !== null) {
    return (
      <img
        alt=""
        aria-hidden="true"
        data-chat-wallpaper-image="true"
        className="pointer-events-none absolute inset-0 z-0 h-full w-full select-none object-cover"
        src={url}
        style={{ opacity: opacity / 100 }}
      />
    );
  }

  return null;
}
