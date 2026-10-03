import sharp from "sharp";

/**
 * The robustness proof's 24 generated pictures, drawn by the same deterministic code as
 * scripts/robustness.ts (copied, because that file runs its report the moment it is imported), so
 * the guard is measured on the corpus the proof already reports.
 */
export const CORPUS_SIZE = 24;

/** A small deterministic random number generator, so the corpus is the same on every run. */
function rng(seed: number): () => number {
  let state = (seed + 1) * 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draws one corpus image straight into a pixel buffer.
 *
 * Each seed picks its own palette, background pattern, texture, noise level and
 * set of shapes. Variations of a single gradient would all share nearly the same
 * block hash, and a false positive count taken over such a corpus would be
 * meaningless.
 */
export async function generateImage(seed: number): Promise<Buffer> {
  const random = rng(seed);
  const width = seed % 3 === 0 ? 800 : seed % 3 === 1 ? 640 : 720;
  const height = seed % 3 === 0 ? 600 : seed % 3 === 1 ? 480 : 540;
  const pixels = Buffer.alloc(width * height * 3);

  const palette: number[][] = [0, 1, 2].map(() => [random() * 255, random() * 255, random() * 255]);
  const background = seed % 4;
  const texture = Math.floor(random() * 4);
  const noise = 6 + random() * 44;
  const bandWidth = 12 + Math.floor(random() * 60);
  const [warm, cool, accent] = palette as [number[], number[], number[]];

  const shapes = Array.from({ length: 2 + Math.floor(random() * 4) }, () => ({
    x: random() * width,
    y: random() * height,
    r: 30 + random() * Math.min(width, height) * 0.28,
    kind: Math.floor(random() * 3),
    colour: [random() * 255, random() * 255, random() * 255] as const,
  }));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x / width;
      const v = y / height;
      let mix: number;
      if (background === 0) {
        mix = u;
      } else if (background === 1) {
        mix = v;
      } else if (background === 2) {
        mix = Math.hypot(u - 0.5, v - 0.5) * 1.6;
      } else {
        mix = (u + v) / 2;
      }

      let r = (warm[0] as number) * (1 - mix) + (cool[0] as number) * mix;
      let g = (warm[1] as number) * (1 - mix) + (cool[1] as number) * mix;
      let b = (warm[2] as number) * (1 - mix) + (cool[2] as number) * mix;

      if (texture === 0 && (Math.floor(x / bandWidth) + Math.floor(y / bandWidth)) % 2 === 0) {
        r = r * 0.55 + (accent[0] as number) * 0.45;
        g = g * 0.55 + (accent[1] as number) * 0.45;
        b = b * 0.55 + (accent[2] as number) * 0.45;
      } else if (texture === 1 && Math.floor(x / bandWidth) % 2 === 0) {
        r *= 0.7;
        g *= 0.7;
        b *= 0.7;
      } else if (texture === 2 && (x % bandWidth < 3 || y % bandWidth < 3)) {
        r = 245 - r * 0.3;
        g = 245 - g * 0.3;
        b = 245 - b * 0.3;
      }

      for (const shape of shapes) {
        const dx = x - shape.x;
        const dy = y - shape.y;
        const inside =
          shape.kind === 0
            ? dx * dx + dy * dy < shape.r * shape.r
            : shape.kind === 1
              ? Math.abs(dx) < shape.r && Math.abs(dy) < shape.r * 0.6
              : Math.abs(dx) + Math.abs(dy) < shape.r;
        if (inside) {
          r = shape.colour[0];
          g = shape.colour[1];
          b = shape.colour[2];
        }
      }

      const grain = (random() - 0.5) * noise;
      const offset = (y * width + x) * 3;
      pixels[offset] = clamp(r + grain);
      pixels[offset + 1] = clamp(g + grain);
      pixels[offset + 2] = clamp(b + grain);
    }
  }

  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}
