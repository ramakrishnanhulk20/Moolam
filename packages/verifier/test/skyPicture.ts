import sharp from "sharp";

/**
 * The review's picture for an unstable fingerprint: a sky that only changes from top to bottom over
 * a dark horizon band, with plus or minus 4 of grain. The pHash never reads row 0 or column 0 of its
 * DCT block, so almost nothing in this picture decides its bits except the grain, and its own
 * thumbnail lands about 30 bits away. A copy of the prepare test's picture, kept here so this order's
 * tests do not lean on a file another order is changing.
 */
export async function skyOverHorizon(seed: number): Promise<Buffer> {
  const width = 1200;
  const height = 900;
  const horizon = Math.round(height * 0.7);
  const raw = Buffer.alloc(width * height * 3);
  let state = seed;
  const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
  for (let y = 0; y < height; y += 1) {
    const t = y / horizon;
    for (let x = 0; x < width; x += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      const grain = ((state >> 16) % 9) - 4;
      const i = (y * width + x) * 3;
      const [r, g, b] = y < horizon ? [90 + 120 * t, 150 + 80 * t, 230 + 20 * t] : [30, 34, 28];
      raw[i] = clamp(r + grain);
      raw[i + 1] = clamp(g + grain);
      raw[i + 2] = clamp(b + grain);
    }
  }
  return await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}
