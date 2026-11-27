import type {
  ChatWallpaperAsciiColorMode,
  ChatWallpaperAsciiPreset,
} from "@zerocode/contracts/settings";

export interface AsciiPresetSpec {
  readonly id: ChatWallpaperAsciiPreset;
  readonly mode: "ramp" | "braille";
  readonly ramp: string;
  readonly sample: string;
  /** Width-to-height ratio of a single monospace cell. */
  readonly cellAspect: number;
}

export const ASCII_PRESET_SPECS: Readonly<Record<ChatWallpaperAsciiPreset, AsciiPresetSpec>> = {
  classic: {
    id: "classic",
    mode: "ramp",
    ramp: " .:-=+*#%@",
    sample: ".:-=+*#%@",
    cellAspect: 0.6,
  },
  detailed: {
    id: "detailed",
    mode: "ramp",
    ramp: " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
    sample: ".:;i+?*#M@",
    cellAspect: 0.6,
  },
  blocks: {
    id: "blocks",
    mode: "ramp",
    ramp: " ░▒▓█",
    sample: "░▒▓█",
    cellAspect: 0.62,
  },
  braille: {
    id: "braille",
    mode: "braille",
    ramp: " ⠀⠁⠃⠇⠏⠟⠿⣿",
    sample: "⠁⠃⠏⠿⣿",
    cellAspect: 0.6,
  },
  dots: {
    id: "dots",
    mode: "ramp",
    ramp: " ·∘○◎●",
    sample: "·∘○◎●",
    cellAspect: 0.68,
  },
  binary: {
    id: "binary",
    mode: "ramp",
    ramp: " 01",
    sample: "010101",
    cellAspect: 0.6,
  },
  katakana: {
    id: "katakana",
    mode: "ramp",
    ramp: " ･:ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ",
    sample: "ｦｱｲｳｴｵｶ",
    cellAspect: 0.72,
  },
};

export interface AsciiGridCell {
  readonly glyph: string;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface AsciiGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cells: readonly AsciiGridCell[];
}

// ISO/IEC 10646 Braille 2x4 dot bit positions for (dx, dy) in [0..1] x [0..3].
const BRAILLE_DOT_BITS: readonly (readonly [number, number])[] = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Computes cover-crop source rectangle so the image fills the target aspect
 * ratio cleanly without stretching.
 */
export function computeCoverCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): { readonly sx: number; readonly sy: number; readonly sw: number; readonly sh: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    return { sx: 0, sy: 0, sw: Math.max(1, sourceWidth), sh: Math.max(1, sourceHeight) };
  }
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;
  if (sourceAspect > targetAspect) {
    const sw = sourceHeight * targetAspect;
    return { sx: (sourceWidth - sw) / 2, sy: 0, sw, sh: sourceHeight };
  }
  const sh = sourceWidth / targetAspect;
  return { sx: 0, sy: (sourceHeight - sh) / 2, sw: sourceWidth, sh };
}

/**
 * Transforms sampled RGBA pixel buffers into an ASCII/Unicode cell grid.
 * For `braille`, expects `pixels` at resolution `(cols * 2) x (rows * 4)`.
 * For ramp presets, expects `pixels` at resolution `cols x rows`.
 */
export function samplePixelsToAsciiGrid(input: {
  readonly pixels: Uint8ClampedArray;
  readonly sampleWidth: number;
  readonly sampleHeight: number;
  readonly cols: number;
  readonly rows: number;
  readonly preset: ChatWallpaperAsciiPreset;
  readonly invertLuminance: boolean;
}): AsciiGrid {
  const { pixels, sampleWidth, sampleHeight, cols, rows, preset, invertLuminance } = input;
  const spec = ASCII_PRESET_SPECS[preset];
  const cells: AsciiGridCell[] = [];

  if (spec.mode === "braille") {
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        let mask = 0;
        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        let aSum = 0;
        let count = 0;
        for (let dy = 0; dy < 4; dy += 1) {
          const py = row * 4 + dy;
          if (py >= sampleHeight) continue;
          const bitPair = BRAILLE_DOT_BITS[dy]!;
          for (let dx = 0; dx < 2; dx += 1) {
            const px = col * 2 + dx;
            if (px >= sampleWidth) continue;
            const offset = (py * sampleWidth + px) * 4;
            const r = pixels[offset] ?? 0;
            const g = pixels[offset + 1] ?? 0;
            const b = pixels[offset + 2] ?? 0;
            const a = pixels[offset + 3] ?? 255;
            rSum += r;
            gSum += g;
            bSum += b;
            aSum += a;
            count += 1;
            const luma = luminance(r, g, b);
            const intensity = invertLuminance ? 1 - luma : luma;
            if (a > 24 && intensity >= 0.34) {
              mask |= bitPair[dx]!;
            }
          }
        }
        const denom = Math.max(1, count);
        cells.push({
          glyph: mask === 0 ? " " : String.fromCodePoint(0x2800 | mask),
          r: Math.round(rSum / denom),
          g: Math.round(gSum / denom),
          b: Math.round(bSum / denom),
          a: Math.round(aSum / denom),
        });
      }
    }
    return { cols, rows, cells };
  }

  const glyphs = Array.from(spec.ramp);
  const maxIndex = glyphs.length - 1;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const offset = (row * sampleWidth + col) * 4;
      const r = pixels[offset] ?? 0;
      const g = pixels[offset + 1] ?? 0;
      const b = pixels[offset + 2] ?? 0;
      const a = pixels[offset + 3] ?? 255;
      if (a <= 16) {
        cells.push({ glyph: " ", r, g, b, a: 0 });
        continue;
      }
      const luma = luminance(r, g, b);
      const intensity = invertLuminance ? 1 - luma : luma;
      const index = Math.min(maxIndex, Math.max(0, Math.round(intensity * maxIndex)));
      cells.push({ glyph: glyphs[index] ?? " ", r, g, b, a });
    }
  }
  return { cols, rows, cells };
}

export interface DrawAsciiCanvasOptions {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly preset: ChatWallpaperAsciiPreset;
  readonly glyphSizePx: number;
  readonly colorMode: ChatWallpaperAsciiColorMode;
  readonly appearance: "dark" | "light";
  readonly monochromeColor: string;
}

/**
 * Draws a static DPR-scaled ASCII/Unicode rendering of `image` onto `canvas`.
 * Runs once per setting or resize change; zero ongoing animation frames.
 */
export function drawAsciiArtToCanvas(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  options: DrawAsciiCanvasOptions,
): void {
  const width = Math.max(1, Math.floor(options.width));
  const height = Math.max(1, Math.floor(options.height));
  const dpr = Math.min(2, Math.max(1, options.dpr || 1));
  const spec = ASCII_PRESET_SPECS[options.preset];
  const glyphSize = Math.max(6, Math.min(28, Math.round(options.glyphSizePx)));
  const cellHeight = glyphSize;
  const cellWidth = Math.max(4, Math.round(glyphSize * spec.cellAspect));
  const cols = Math.max(1, Math.ceil(width / cellWidth));
  const rows = Math.max(1, Math.ceil(height / cellHeight));

  const sampleWidth = spec.mode === "braille" ? cols * 2 : cols;
  const sampleHeight = spec.mode === "braille" ? rows * 4 : rows;

  const sampler = document.createElement("canvas");
  sampler.width = sampleWidth;
  sampler.height = sampleHeight;
  const samplerCtx = sampler.getContext("2d", { willReadFrequently: true });
  if (!samplerCtx) return;

  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  const crop = computeCoverCrop(naturalWidth, naturalHeight, width, height);
  samplerCtx.drawImage(image, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, sampleWidth, sampleHeight);
  const imageData = samplerCtx.getImageData(0, 0, sampleWidth, sampleHeight);

  const grid = samplePixelsToAsciiGrid({
    pixels: imageData.data,
    sampleWidth,
    sampleHeight,
    cols,
    rows,
    preset: options.preset,
    invertLuminance: options.appearance === "light",
  });

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = `${glyphSize}px ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  const isMonochrome = options.colorMode === "monochrome";
  if (isMonochrome) {
    ctx.fillStyle = options.monochromeColor;
  }

  for (let row = 0; row < grid.rows; row += 1) {
    const y = row * cellHeight;
    if (isMonochrome) {
      let line = "";
      for (let col = 0; col < grid.cols; col += 1) {
        line += grid.cells[row * grid.cols + col]!.glyph;
      }
      ctx.fillText(line, 0, y);
    } else {
      for (let col = 0; col < grid.cols; col += 1) {
        const cell = grid.cells[row * grid.cols + col]!;
        if (cell.glyph === " " || cell.a <= 16) continue;
        ctx.fillStyle = `rgb(${cell.r}, ${cell.g}, ${cell.b})`;
        ctx.fillText(cell.glyph, col * cellWidth, y);
      }
    }
  }
}
