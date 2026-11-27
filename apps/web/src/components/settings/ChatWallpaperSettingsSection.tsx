import type { ChangeEvent, CSSProperties } from "react";
import { useEffect, useRef } from "react";
import { msg, useGT, useMessages } from "gt-react";
import {
  CHAT_WALLPAPER_ASCII_PRESETS,
  DEFAULT_UNIFIED_SETTINGS,
  MAX_CHAT_WALLPAPER_ASCII_SIZE,
  MAX_CHAT_WALLPAPER_OPACITY,
  MIN_CHAT_WALLPAPER_ASCII_SIZE,
  MIN_CHAT_WALLPAPER_OPACITY,
  type ChatWallpaperAsciiColorMode,
  type ChatWallpaperAsciiPreset,
} from "@zerocode/contracts/settings";

import {
  clearCustomChatWallpaper,
  setCustomChatWallpaper,
  useChatWallpaper,
} from "~/chatWallpaper";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { ASCII_PRESET_SPECS, drawAsciiArtToCanvas } from "~/lib/asciiArt";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const ASCII_PRESET_LABELS: Record<ChatWallpaperAsciiPreset, string> = {
  blocks: msg("Unicode blocks"),
  braille: msg("Unicode braille"),
  classic: msg("Classic ASCII"),
  detailed: msg("Detailed ASCII"),
  dots: msg("Geometric dots"),
  binary: msg("Binary"),
  katakana: msg("Katakana"),
};

const ASCII_COLOR_MODE_LABELS: Record<ChatWallpaperAsciiColorMode, string> = {
  color: msg("Original colors"),
  monochrome: msg("Monochrome"),
};

function WallpaperThumbnailPreview({
  url,
  asciiEnabled,
  preset,
  glyphSizePx,
  colorMode,
  opacity,
}: {
  readonly url: string | null;
  readonly asciiEnabled: boolean;
  readonly preset: ChatWallpaperAsciiPreset;
  readonly glyphSizePx: number;
  readonly colorMode: ChatWallpaperAsciiColorMode;
  readonly opacity: number;
}) {
  const appearance = useRenderedAppearance();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gt = useGT();

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- Draws imperative ASCII preview pixels onto the mounted canvas when image or preset settings change.
  useEffect(() => {
    if (!asciiEnabled || url === null) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const rect = canvas.getBoundingClientRect();
      const width = rect.width >= 1 ? rect.width : 112;
      const height = rect.height >= 1 ? rect.height : 64;
      const monochromeColor = getComputedStyle(canvas).color || "currentColor";
      drawAsciiArtToCanvas(canvas, image, {
        width,
        height,
        dpr: window.devicePixelRatio || 1,
        preset,
        glyphSizePx: Math.max(6, Math.round(glyphSizePx * 0.7)),
        colorMode,
        appearance,
        monochromeColor,
      });
    };
    image.src = url;
    return () => {
      cancelled = true;
    };
  }, [appearance, asciiEnabled, colorMode, glyphSizePx, preset, url]);

  if (url === null) {
    return (
      <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded-md border border-dashed border-border bg-muted/40 text-2xs text-muted-foreground">
        {gt("None")}
      </div>
    );
  }

  return (
    <div className="relative h-12 w-20 shrink-0 overflow-hidden rounded-md border border-border bg-background">
      {asciiEnabled ? (
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="h-full w-full text-foreground"
          style={{ opacity: opacity / 100 }}
        />
      ) : (
        <img
          alt=""
          aria-hidden="true"
          className="h-full w-full object-cover"
          src={url}
          style={{ opacity: opacity / 100 }}
        />
      )}
    </div>
  );
}

export function ChatWallpaperSettingsSection() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { url, source, customName } = useChatWallpaper();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const asciiSizeRatio =
    (settings.chatWallpaperAsciiSize - MIN_CHAT_WALLPAPER_ASCII_SIZE) /
    (MAX_CHAT_WALLPAPER_ASCII_SIZE - MIN_CHAT_WALLPAPER_ASCII_SIZE);
  const asciiSizeSliderStyle = {
    "--settings-slider-progress": `${asciiSizeRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - asciiSizeRatio}rem`,
  } as CSSProperties;

  const opacityRatio =
    (settings.chatWallpaperOpacity - MIN_CHAT_WALLPAPER_OPACITY) /
    (MAX_CHAT_WALLPAPER_OPACITY - MIN_CHAT_WALLPAPER_OPACITY);
  const opacitySliderStyle = {
    "--settings-slider-progress": `${opacityRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - opacityRatio}rem`,
  } as CSSProperties;

  const wallpaperDescription =
    source === "custom"
      ? customName
        ? gt("Using local image {name} behind the chat.", { name: customName })
        : gt("Using a local image behind the chat.")
      : source === "theme"
        ? gt(
            "Using the active theme background image. Choose a local image to override it on this device.",
          )
        : gt(
            "Pick an image to display behind the chat, or publish a background image with your theme.",
          );

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    void setCustomChatWallpaper(file, file.name).then((result) => {
      if (result.ok) return;
      toastManager.add({
        type: "error",
        title: gt("Could not set chat wallpaper"),
        description:
          result.reason === "too-large"
            ? gt("Choose an image smaller than 16 MB.")
            : gt("Choose a PNG, JPEG, WebP, GIF, or AVIF image."),
      });
    });
  };

  return (
    <SettingsSection id="appearance-wallpaper" title={gt("Chat wallpaper")}>
      <SettingsRow
        {...searchableSetting("chat-wallpaper")}
        description={wallpaperDescription}
        control={
          <div className="flex flex-wrap items-center gap-2.5">
            <WallpaperThumbnailPreview
              url={url}
              asciiEnabled={settings.chatWallpaperAsciiEnabled}
              preset={settings.chatWallpaperAsciiPreset}
              glyphSizePx={settings.chatWallpaperAsciiSize}
              colorMode={settings.chatWallpaperAsciiColorMode}
              opacity={settings.chatWallpaperOpacity}
            />
            <input
              ref={fileInputRef}
              accept="image/*"
              className="sr-only"
              onChange={handleFileChange}
              type="file"
            />
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
            >
              {source === "custom" ? gt("Change image") : gt("Choose image")}
            </Button>
            {source === "custom" ? (
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => {
                  void clearCustomChatWallpaper();
                }}
              >
                {gt("Remove")}
              </Button>
            ) : null}
          </div>
        }
      />

      <SettingsRow
        {...searchableSetting("chat-wallpaper-ascii")}
        description={gt(
          "Transform the chat wallpaper into overlaid ASCII and Unicode art behind messages.",
        )}
        resetAction={
          settings.chatWallpaperAsciiEnabled !==
          DEFAULT_UNIFIED_SETTINGS.chatWallpaperAsciiEnabled ? (
            <SettingResetButton
              ariaLabel={gt("Reset ASCII wallpaper overlay to default")}
              onClick={() =>
                updateSettings({
                  chatWallpaperAsciiEnabled: DEFAULT_UNIFIED_SETTINGS.chatWallpaperAsciiEnabled,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            aria-label={gt("ASCII art overlay")}
            checked={settings.chatWallpaperAsciiEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ chatWallpaperAsciiEnabled: Boolean(checked) })
            }
          />
        }
      />

      <SettingsRow
        {...searchableSetting("chat-wallpaper-ascii-preset")}
        description={gt("Choose the ASCII or Unicode character set used for the overlay.")}
        resetAction={
          settings.chatWallpaperAsciiPreset !==
          DEFAULT_UNIFIED_SETTINGS.chatWallpaperAsciiPreset ? (
            <SettingResetButton
              ariaLabel={gt("Reset ASCII preset to default")}
              onClick={() =>
                updateSettings({
                  chatWallpaperAsciiPreset: DEFAULT_UNIFIED_SETTINGS.chatWallpaperAsciiPreset,
                })
              }
            />
          ) : null
        }
        control={
          <div className="w-full sm:w-52">
            <Select
              value={settings.chatWallpaperAsciiPreset}
              onValueChange={(value) => {
                if (CHAT_WALLPAPER_ASCII_PRESETS.includes(value as ChatWallpaperAsciiPreset)) {
                  updateSettings({ chatWallpaperAsciiPreset: value as ChatWallpaperAsciiPreset });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full min-w-0" aria-label={gt("ASCII preset")}>
                <SelectValue>
                  {m(ASCII_PRESET_LABELS[settings.chatWallpaperAsciiPreset])}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {CHAT_WALLPAPER_ASCII_PRESETS.map((presetId) => (
                  <SelectItem key={presetId} value={presetId}>
                    <span className="flex w-full items-center justify-between gap-3">
                      <span>{m(ASCII_PRESET_LABELS[presetId])}</span>
                      <span className="font-mono text-2xs text-muted-foreground">
                        {ASCII_PRESET_SPECS[presetId].sample}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        }
      />

      <SettingsRow
        {...searchableSetting("setting-chat-wallpaper-ascii-size")}
        description={gt(
          "Adjust the size of each ASCII or Unicode character. Smaller sizes add detail.",
        )}
        resetAction={
          settings.chatWallpaperAsciiSize !== DEFAULT_UNIFIED_SETTINGS.chatWallpaperAsciiSize ? (
            <SettingResetButton
              ariaLabel={gt("Reset Unicode size to default")}
              onClick={() =>
                updateSettings({
                  chatWallpaperAsciiSize: DEFAULT_UNIFIED_SETTINGS.chatWallpaperAsciiSize,
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex w-full items-center gap-3 sm:w-52">
            <output
              className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
              htmlFor="chat-wallpaper-ascii-size"
            >
              {settings.chatWallpaperAsciiSize} px
            </output>
            <input
              aria-label={gt("Unicode size")}
              className="settings-slider min-w-0 flex-1"
              id="chat-wallpaper-ascii-size"
              max={MAX_CHAT_WALLPAPER_ASCII_SIZE}
              min={MIN_CHAT_WALLPAPER_ASCII_SIZE}
              onChange={(event) => {
                const chatWallpaperAsciiSize = Number(event.currentTarget.value);
                if (
                  Number.isInteger(chatWallpaperAsciiSize) &&
                  chatWallpaperAsciiSize >= MIN_CHAT_WALLPAPER_ASCII_SIZE &&
                  chatWallpaperAsciiSize <= MAX_CHAT_WALLPAPER_ASCII_SIZE
                ) {
                  updateSettings({ chatWallpaperAsciiSize });
                }
              }}
              step={1}
              style={asciiSizeSliderStyle}
              type="range"
              value={settings.chatWallpaperAsciiSize}
            />
          </div>
        }
      />

      <SettingsRow
        {...searchableSetting("chat-wallpaper-ascii-color-mode")}
        description={gt(
          "Keep the image colors on each character or tint the art with your theme foreground.",
        )}
        resetAction={
          settings.chatWallpaperAsciiColorMode !==
          DEFAULT_UNIFIED_SETTINGS.chatWallpaperAsciiColorMode ? (
            <SettingResetButton
              ariaLabel={gt("Reset ASCII color mode to default")}
              onClick={() =>
                updateSettings({
                  chatWallpaperAsciiColorMode: DEFAULT_UNIFIED_SETTINGS.chatWallpaperAsciiColorMode,
                })
              }
            />
          ) : null
        }
        control={
          <div className="w-full sm:w-44">
            <Select
              value={settings.chatWallpaperAsciiColorMode}
              onValueChange={(value) => {
                if (value === "color" || value === "monochrome") {
                  updateSettings({ chatWallpaperAsciiColorMode: value });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full min-w-0"
                aria-label={gt("ASCII color mode")}
              >
                <SelectValue>
                  {m(ASCII_COLOR_MODE_LABELS[settings.chatWallpaperAsciiColorMode])}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="color">{m(ASCII_COLOR_MODE_LABELS.color)}</SelectItem>
                <SelectItem value="monochrome">{m(ASCII_COLOR_MODE_LABELS.monochrome)}</SelectItem>
              </SelectPopup>
            </Select>
          </div>
        }
      />

      <SettingsRow
        {...searchableSetting("setting-chat-wallpaper-opacity")}
        description={gt("Control how strongly the wallpaper or ASCII art shows behind messages.")}
        resetAction={
          settings.chatWallpaperOpacity !== DEFAULT_UNIFIED_SETTINGS.chatWallpaperOpacity ? (
            <SettingResetButton
              ariaLabel={gt("Reset wallpaper opacity to default")}
              onClick={() =>
                updateSettings({
                  chatWallpaperOpacity: DEFAULT_UNIFIED_SETTINGS.chatWallpaperOpacity,
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex w-full items-center gap-3 sm:w-52">
            <output
              className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
              htmlFor="chat-wallpaper-opacity"
            >
              {settings.chatWallpaperOpacity}%
            </output>
            <input
              aria-label={gt("Wallpaper opacity")}
              className="settings-slider min-w-0 flex-1"
              id="chat-wallpaper-opacity"
              max={MAX_CHAT_WALLPAPER_OPACITY}
              min={MIN_CHAT_WALLPAPER_OPACITY}
              onChange={(event) => {
                const chatWallpaperOpacity = Number(event.currentTarget.value);
                if (
                  Number.isInteger(chatWallpaperOpacity) &&
                  chatWallpaperOpacity >= MIN_CHAT_WALLPAPER_OPACITY &&
                  chatWallpaperOpacity <= MAX_CHAT_WALLPAPER_OPACITY
                ) {
                  updateSettings({ chatWallpaperOpacity });
                }
              }}
              step={5}
              style={opacitySliderStyle}
              type="range"
              value={settings.chatWallpaperOpacity}
            />
          </div>
        }
      />
    </SettingsSection>
  );
}
