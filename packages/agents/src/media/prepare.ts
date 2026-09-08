import sharp from "sharp";
import type { Hex } from "viem";
// The verifier package declares no "exports" and ships no build, so its modules are imported by
// file path. Node, TypeScript and tsx all follow the workspace link to the TypeScript source.
import { embedManifest, readManifest, type ManifestSummary } from "@moolam/verifier/src/c2pa.js";
import { fingerprint, type Fingerprint } from "@moolam/verifier/src/fingerprint.js";

export type { Fingerprint, ManifestSummary };

/**
 * The Chainlink verifier downloads this thumbnail inside a sandbox with a 100 KB fetch cap, so
 * the file has to stay well under that with room for gateway overhead.
 */
export const THUMBNAIL_MAX_BYTES = 60_000;

/** Longest side of the thumbnail in pixels. Small enough to decode fast, large enough to hash. */
export const THUMBNAIL_LONGEST_SIDE = 512;

const QUALITY_START = 85;
const QUALITY_FLOOR = 30;
const QUALITY_STEP = 5;

export interface PreparedImage {
  original: Buffer;
  thumbnail: Buffer;
  fingerprint: Fingerprint;
  manifestHash: Hex;
  manifest: ManifestSummary;
}

export interface PrepareOptions {
  title: string;
  claimGenerator: string;
  action: "c2pa.created" | "c2pa.edited";
  digitalSourceType?: string;
}

/**
 * Turns a raw image into everything a passport needs: the C2PA signed JPEG that gets registered,
 * a small baseline thumbnail the Chainlink verifier can fetch and decode, the fingerprint of the
 * signed bytes, and the hash of the manifest store the chain commits to.
 *
 * The soft binding written into the manifest is the fingerprint of the source pixels, and the
 * function refuses to continue if signing moved the perceptual hash, because a manifest that
 * describes a different picture than the one being registered is worse than no manifest.
 *
 * Throws when the buffer is empty, when the C2PA library will not sign the container, when the
 * signed file carries no readable manifest, or when no thumbnail small enough can be produced.
 */
export async function prepareImage(source: Buffer, opts: PrepareOptions): Promise<PreparedImage> {
  if (source.length === 0) {
    throw new Error("prepareImage needs a non-empty image buffer.");
  }

  const sourcePrint = await fingerprint(source);
  const signed = await embedManifest(source, {
    title: opts.title,
    claimGenerator: opts.claimGenerator,
    action: opts.action,
    softBinding: { phash: sourcePrint.phash, blockhash: sourcePrint.blockhash },
    digitalSourceType: opts.digitalSourceType,
  });

  const signedPrint = await fingerprint(signed);
  if (signedPrint.phash !== sourcePrint.phash) {
    throw new Error("Signing changed the perceptual hash, so the soft binding would describe other pixels.");
  }

  const manifest = await readManifest(signed);
  if (!manifest.present || manifest.manifestHash === undefined) {
    throw new Error("The signed image carries no manifest this reader can find.");
  }
  if (manifest.softBinding === undefined) {
    throw new Error("The signed manifest lost its soft binding, so a re-encoded copy could never be matched.");
  }

  return {
    original: signed,
    thumbnail: await makeThumbnail(signed),
    fingerprint: signedPrint,
    manifestHash: manifest.manifestHash,
    manifest,
  };
}

/**
 * Shrinks the image until it fits the verifier's fetch budget.
 *
 * The output is a baseline JPEG on purpose: the Chainlink sandbox decodes with jpeg-js, which
 * reads baseline files only, so a progressive thumbnail would fail every verification.
 */
async function makeThumbnail(image: Buffer): Promise<Buffer> {
  const resized = sharp(image).resize({
    width: THUMBNAIL_LONGEST_SIDE,
    height: THUMBNAIL_LONGEST_SIDE,
    fit: "inside",
    withoutEnlargement: true,
  });

  let smallest = Number.POSITIVE_INFINITY;
  for (let quality = QUALITY_START; quality >= QUALITY_FLOOR; quality -= QUALITY_STEP) {
    const candidate = await resized.clone().jpeg({ quality, progressive: false }).toBuffer();
    if (candidate.length <= THUMBNAIL_MAX_BYTES) {
      return candidate;
    }
    smallest = candidate.length;
  }

  throw new Error(
    `The thumbnail is still ${smallest} bytes at quality ${QUALITY_FLOOR}, over the ${THUMBNAIL_MAX_BYTES} byte cap.`,
  );
}
