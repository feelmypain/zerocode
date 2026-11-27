import { DEFAULT_CLIENT_SETTINGS } from "@zerocode/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { clearCustomChatWallpaper, setCustomChatWallpaper } from "~/chatWallpaper";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  updateClientSettings,
} from "~/hooks/useSettings";
import { render } from "../../../test/render";
import { ChatWallpaperOverlay } from "./ChatWallpaperOverlay";

async function createGradientPngBlob(): Promise<Blob> {
  const source = document.createElement("canvas");
  source.width = 64;
  source.height = 64;
  const ctx = source.getContext("2d")!;
  const grad = ctx.createLinearGradient(0, 0, 64, 64);
  grad.addColorStop(0, "#080808");
  grad.addColorStop(0.5, "#3b82f6");
  grad.addColorStop(1, "#ffffff");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const blob = await new Promise<Blob | null>((resolve) => source.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Failed to encode test PNG blob");
  return blob;
}

function countNonTransparentPixels(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width === 0 || canvas.height === 0) return 0;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let lit = 0;
  for (let i = 3; i < data.length; i += 4) {
    if ((data[i] ?? 0) > 0) lit += 1;
  }
  return lit;
}

describe("ChatWallpaperOverlay", () => {
  it("transforms the wallpaper image into rendered ASCII art across presets and Unicode sizes", async () => {
    await using _cleanup = {
      [Symbol.asyncDispose]: async () => {
        await clearCustomChatWallpaper();
        __resetClientSettingsPersistenceForTests();
      },
    };
    const blob = await createGradientPngBlob();
    const saved = await setCustomChatWallpaper(blob, "gradient.png");
    expect(saved).toEqual({ ok: true });

    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      chatWallpaperAsciiEnabled: false,
      chatWallpaperOpacity: 60,
    });

    await using screen = await render(
      <div
        data-workspace-area="conversation"
        className="relative h-[240px] w-[360px]"
        style={{ backgroundImage: "linear-gradient(red, blue)" }}
      >
        <ChatWallpaperOverlay />
      </div>,
    );

    const img = screen.container.querySelector('[data-chat-wallpaper-image="true"]');
    expect(img).not.toBeNull();
    expect(screen.container.querySelector('[data-chat-wallpaper-ascii-canvas="true"]')).toBeNull();

    // Enable ASCII art overlay with Unicode blocks at 10px.
    await updateClientSettings({
      chatWallpaperAsciiEnabled: true,
      chatWallpaperAsciiPreset: "blocks",
      chatWallpaperAsciiSize: 10,
      chatWallpaperOpacity: 75,
    });

    await expect
      .poll(() => {
        const canvas = screen.container.querySelector<HTMLCanvasElement>(
          '[data-chat-wallpaper-ascii-canvas="true"]',
        );
        return canvas ? countNonTransparentPixels(canvas) : 0;
      })
      .toBeGreaterThan(100);

    const conversation = screen.container.querySelector<HTMLElement>(
      '[data-workspace-area="conversation"]',
    )!;
    expect(getComputedStyle(conversation).backgroundImage).toBe("none");

    const canvas = screen.container.querySelector<HTMLCanvasElement>(
      '[data-chat-wallpaper-ascii-canvas="true"]',
    )!;
    const blocksSnapshot = canvas.toDataURL();

    // Switch preset to Unicode Braille and verify rendered pixels change.
    await updateClientSettings({
      chatWallpaperAsciiPreset: "braille",
      chatWallpaperAsciiSize: 10,
    });
    await expect.poll(() => canvas.toDataURL()).not.toBe(blocksSnapshot);
    const braille10Snapshot = canvas.toDataURL();

    // Increase Unicode glyph size to 22px and verify rendered pixels change again.
    await updateClientSettings({
      chatWallpaperAsciiSize: 22,
    });
    await expect.poll(() => canvas.toDataURL()).not.toBe(braille10Snapshot);

    // Reverse state: clearing custom wallpaper removes the overlay cleanly.
    await clearCustomChatWallpaper();
    await expect
      .poll(() => screen.container.querySelector('[data-chat-wallpaper-ascii-canvas="true"]'))
      .toBeNull();
  });
});
