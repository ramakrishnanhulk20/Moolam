import sharp from "sharp";

export type TransformName =
  | "reencode-q60"
  | "reencode-q30"
  | "resize-50"
  | "resize-25"
  | "resize-10"
  | "crop-10"
  | "crop-25"
  | "rotate-90"
  | "rotate-180"
  | "mirror"
  | "brightness-120"
  | "watermark-text"
  | "screenshot"
  | "social-chain"
  | "strip-metadata";

const JPEG_QUALITY = 90;

/**
 * Runs the fifteen transforms a real re-upload puts an image through and
 * returns one JPEG buffer per transform.
 *
 * Every transform except strip-metadata asks sharp to keep metadata, because
 * the point of the pair is to show whether a C2PA manifest survives an edit at
 * all when the tool is trying to preserve it. sharp drops metadata by default,
 * so strip-metadata is simply the same re-encode without that request.
 *
 * The last three are not single operations but stand-ins for real journeys:
 * screenshot is the slight downscale and middling quality a screen capture
 * produces, and social-chain is two rounds of the resize and recompress a
 * platform applies, which is what a picture looks like after it has been shared
 * twice.
 *
 * Throws when the buffer is empty or is not an image sharp can decode.
 */
export async function transforms(bytes: Buffer): Promise<Record<TransformName, Buffer>> {
  if (bytes.length === 0) {
    throw new Error("transforms needs a non-empty image buffer");
  }

  const metadata = await sharp(bytes).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width === 0 || height === 0) {
    throw new Error("transforms could not read the image dimensions");
  }

  const builders: Record<TransformName, () => Promise<Buffer>> = {
    "reencode-q60": () => sharp(bytes).keepMetadata().jpeg({ quality: 60 }).toBuffer(),
    "reencode-q30": () => sharp(bytes).keepMetadata().jpeg({ quality: 30 }).toBuffer(),
    "resize-50": () => scaled(bytes, width, 0.5),
    "resize-25": () => scaled(bytes, width, 0.25),
    "resize-10": () => scaled(bytes, width, 0.1),
    "crop-10": () => cropped(bytes, width, height, 0.1),
    "crop-25": () => cropped(bytes, width, height, 0.25),
    "rotate-90": () => sharp(bytes).keepMetadata().rotate(90).jpeg({ quality: JPEG_QUALITY }).toBuffer(),
    "rotate-180": () => sharp(bytes).keepMetadata().rotate(180).jpeg({ quality: JPEG_QUALITY }).toBuffer(),
    mirror: () => sharp(bytes).keepMetadata().flop().jpeg({ quality: JPEG_QUALITY }).toBuffer(),
    "brightness-120": () =>
      sharp(bytes).keepMetadata().modulate({ brightness: 1.2 }).jpeg({ quality: JPEG_QUALITY }).toBuffer(),
    "watermark-text": () => watermarked(bytes, width, height),
    screenshot: () => scaled(bytes, width, 0.9, 75),
    "social-chain": async () => {
      const once = await scaled(bytes, width, 0.8, 80);
      const meta = await sharp(once).metadata();
      return scaled(once, meta.width ?? Math.round(width * 0.8), 0.8, 80);
    },
    "strip-metadata": () => sharp(bytes).jpeg({ quality: JPEG_QUALITY }).toBuffer(),
  };

  const names = Object.keys(builders) as TransformName[];
  const buffers = await Promise.all(names.map((name) => (builders[name] as () => Promise<Buffer>)()));

  const out = {} as Record<TransformName, Buffer>;
  names.forEach((name, index) => {
    out[name] = buffers[index] as Buffer;
  });
  return out;
}

function scaled(bytes: Buffer, width: number, factor: number, quality = JPEG_QUALITY): Promise<Buffer> {
  return sharp(bytes)
    .keepMetadata()
    .resize(Math.max(1, Math.round(width * factor)))
    .jpeg({ quality })
    .toBuffer();
}

/** Cuts `fraction` off each of the four edges, so crop-25 keeps the middle half of the picture. */
function cropped(bytes: Buffer, width: number, height: number, fraction: number): Promise<Buffer> {
  const left = Math.round(width * fraction);
  const top = Math.round(height * fraction);
  return sharp(bytes)
    .keepMetadata()
    .extract({ left, top, width: Math.max(1, width - left * 2), height: Math.max(1, height - top * 2) })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}

/**
 * Stamps a caption bar across the lower part of the image, the way a repost
 * account or a meme tool does. The bar is deliberately wide and opaque, because
 * a faint corner logo would prove nothing.
 */
function watermarked(bytes: Buffer, width: number, height: number): Promise<Buffer> {
  const barHeight = Math.max(24, Math.round(height * 0.12));
  const fontSize = Math.max(14, Math.round(barHeight * 0.55));
  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect x="0" y="${Math.round(height * 0.72)}" width="${width}" height="${barHeight}" fill="rgba(0,0,0,0.72)"/>` +
      `<text x="${Math.round(width * 0.04)}" y="${Math.round(height * 0.72 + barHeight * 0.72)}" ` +
      `font-family="sans-serif" font-size="${fontSize}" fill="#ffffff">reposted by @someone</text>` +
      `</svg>`,
  );

  return sharp(bytes)
    .keepMetadata()
    .composite([{ input: overlay, top: 0, left: 0 }])
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}
