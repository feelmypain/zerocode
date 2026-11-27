import { describe, expect, it } from "vite-plus/test";
import { CHAT_WALLPAPER_ASCII_PRESETS } from "@zerocode/contracts/settings";

import { ASCII_PRESET_SPECS, computeCoverCrop, samplePixelsToAsciiGrid } from "./asciiArt";

describe("asciiArt", () => {
  it("computes cover crop preserving aspect ratio for wider and taller images", () => {
    expect(computeCoverCrop(1920, 1080, 500, 500)).toEqual({
      sx: 420,
      sy: 0,
      sw: 1080,
      sh: 1080,
    });
    expect(computeCoverCrop(1000, 2000, 1000, 500)).toEqual({
      sx: 0,
      sy: 750,
      sw: 1000,
      sh: 500,
    });
  });

  it("maps luminance across every ramp preset and respects light-mode inversion", () => {
    // 2x1 image: pure black left, pure white right
    const pixels = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
    for (const preset of CHAT_WALLPAPER_ASCII_PRESETS) {
      const spec = ASCII_PRESET_SPECS[preset];
      if (spec.mode !== "ramp") continue;
      const glyphs = Array.from(spec.ramp);
      const dark = samplePixelsToAsciiGrid({
        pixels,
        sampleWidth: 2,
        sampleHeight: 1,
        cols: 2,
        rows: 1,
        preset,
        invertLuminance: false,
      });
      expect(dark.cells[0]?.glyph).toBe(glyphs[0]);
      expect(dark.cells[1]?.glyph).toBe(glyphs[glyphs.length - 1]);

      const light = samplePixelsToAsciiGrid({
        pixels,
        sampleWidth: 2,
        sampleHeight: 1,
        cols: 2,
        rows: 1,
        preset,
        invertLuminance: true,
      });
      expect(light.cells[0]?.glyph).toBe(glyphs[glyphs.length - 1]);
      expect(light.cells[1]?.glyph).toBe(glyphs[0]);
    }
  });

  it("encodes 2x4 sub-pixels into ISO 10646 Unicode Braille cells", () => {
    // 2 cols x 1 row => 4x4 sub-pixels.
    // Left cell (cols 0..1): only top-left dot lit => U+2801 ('⠁').
    // Right cell (cols 2..3): all 8 dots lit => U+28FF ('⣿').
    const sampleWidth = 4;
    const sampleHeight = 4;
    const pixels = new Uint8ClampedArray(sampleWidth * sampleHeight * 4);
    const setPixel = (x: number, y: number, r: number, g: number, b: number) => {
      const idx = (y * sampleWidth + x) * 4;
      pixels[idx] = r;
      pixels[idx + 1] = g;
      pixels[idx + 2] = b;
      pixels[idx + 3] = 255;
    };
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        setPixel(x, y, 0, 0, 0);
      }
    }
    setPixel(0, 0, 255, 255, 255);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 2; x < 4; x += 1) {
        setPixel(x, y, 255, 128, 64);
      }
    }

    const grid = samplePixelsToAsciiGrid({
      pixels,
      sampleWidth,
      sampleHeight,
      cols: 2,
      rows: 1,
      preset: "braille",
      invertLuminance: false,
    });
    expect(grid.cells[0]?.glyph).toBe("\u2801");
    expect(grid.cells[1]?.glyph).toBe("\u28ff");
    expect(grid.cells[1]?.r).toBe(255);
    expect(grid.cells[1]?.g).toBe(128);
    expect(grid.cells[1]?.b).toBe(64);
  });
});
