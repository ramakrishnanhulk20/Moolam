import sharp from "sharp";

export type TransformName =
  | "reencode-q60"
  | "resize-50"
  | "resize-25"
  | "crop-10"
  | "rotate-90"
  | "mirror"
  | "brightness-120"
  | "strip-metadata";

const JPEG_QUALITY = 90;

/**
 * Runs the eight transforms a real re-upload puts an image through and returns
 * one JPEG buffer per transform.
 *
 * Every transform except strip-metadata asks sharp to keep metadata, because
 * the point of the pair is to show whether a C2PA manifest survives an edit at
 * all when the tool is trying to preserve it. sharp drops metadata by default,
 * so strip-metadata is simply the same re-encode without that request.
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

  const cropInset = { left: Math.round(width * 0.1), top: Math.round(height * 0.1) };
  const crop = {
    left: cropInset.left,
    top: cropInset.top,
    width: width - cropInset.left * 2,
    height: height - cropInset.top * 2,
  };

  const pipelines: Record<TransformName, sharp.Sharp> = {
    "reencode-q60": sharp(bytes).keepMetadata().jpeg({ quality: 60 }),
    "resize-50": sharp(bytes).keepMetadata().resize(Math.round(width / 2)).jpeg({ quality: JPEG_QUALITY }),
    "resize-25": sharp(bytes).keepMetadata().resize(Math.round(width / 4)).jpeg({ quality: JPEG_QUALITY }),
    "crop-10": sharp(bytes).keepMetadata().extract(crop).jpeg({ quality: JPEG_QUALITY }),
    "rotate-90": sharp(bytes).keepMetadata().rotate(90).jpeg({ quality: JPEG_QUALITY }),
    mirror: sharp(bytes).keepMetadata().flop().jpeg({ quality: JPEG_QUALITY }),
    "brightness-120": sharp(bytes).keepMetadata().modulate({ brightness: 1.2 }).jpeg({ quality: JPEG_QUALITY }),
    "strip-metadata": sharp(bytes).jpeg({ quality: JPEG_QUALITY }),
  };

  const names = Object.keys(pipelines) as TransformName[];
  const buffers = await Promise.all(names.map((name) => pipelines[name].toBuffer()));

  const out = {} as Record<TransformName, Buffer>;
  names.forEach((name, index) => {
    out[name] = buffers[index] as Buffer;
  });
  return out;
}
