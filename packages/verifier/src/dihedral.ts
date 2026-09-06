import sharp, { type Sharp } from "sharp";
import { fingerprint, type Fingerprint } from "./fingerprint.js";
import type { DihedralName } from "./types.js";

/**
 * The eight symmetries of a square, in the order the rest of the code expects.
 * A rotated or mirrored copy of a registered image is still the same picture,
 * but pHash and blockhash both change wildly under those two operations (the
 * spike measured 31 of 64 bits for a quarter turn), so the only honest way to
 * catch them is to try every symmetry of the query image and see if any lands
 * on a stored fingerprint.
 */
export const DIHEDRAL_NAMES: readonly DihedralName[] = [
  "identity",
  "rot90",
  "rot180",
  "rot270",
  "mirror",
  "mirror-rot90",
  "mirror-rot180",
  "mirror-rot270",
];

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
}

/**
 * Produces all eight rotated and mirrored copies of an image as PNG buffers.
 *
 * A name says what was done to the registered original to produce this copy, so
 * each variant applies the inverse. Feed in a quarter-turned re-upload and the
 * entry called "rot90" is the one that comes back upright and matches, which
 * means a caller can show "this is the registered image, rotated 90 degrees"
 * straight from the name.
 *
 * The image is decoded to raw pixels once and every variant is re-encoded as
 * PNG rather than JPEG, because a lossy round trip would push its own
 * compression artefacts into the fingerprints and blur the very thing being
 * measured.
 *
 * The mirrored half flops the raw pixels first and rotates that result, in two
 * separate passes, so the composition is unambiguous and does not depend on the
 * internal order sharp applies its operations in.
 *
 * Throws when the buffer is empty or is not an image sharp can decode.
 */
export async function dihedralVariants(bytes: Buffer): Promise<Record<DihedralName, Buffer>> {
  if (bytes.length === 0) {
    throw new Error("dihedralVariants needs a non-empty image buffer");
  }

  const upright = await decodeRaw(sharp(bytes));
  const mirrored = await decodeRaw(fromRaw(upright).flop());

  const buffers = await Promise.all(
    DIHEDRAL_NAMES.map((name) => {
      const source = name.startsWith("mirror") ? mirrored : upright;
      return fromRaw(source).rotate(angleOf(name)).png({ compressionLevel: 6 }).toBuffer();
    }),
  );

  const out = {} as Record<DihedralName, Buffer>;
  DIHEDRAL_NAMES.forEach((name, index) => {
    out[name] = buffers[index] as Buffer;
  });
  return out;
}

/**
 * Fingerprints all eight rotated and mirrored copies of an image.
 *
 * The sha256 of each variant is the sha256 of that PNG, not of the input, so
 * only the identity entry can ever be used for an exact-bytes lookup.
 *
 * Throws when the buffer is empty or is not an image sharp can decode.
 */
export async function dihedralFingerprints(bytes: Buffer): Promise<Record<DihedralName, Fingerprint>> {
  const variants = await dihedralVariants(bytes);
  const prints = await Promise.all(DIHEDRAL_NAMES.map((name) => fingerprint(variants[name])));

  const out = {} as Record<DihedralName, Fingerprint>;
  DIHEDRAL_NAMES.forEach((name, index) => {
    out[name] = prints[index] as Fingerprint;
  });
  return out;
}

/**
 * The clockwise angle that undoes a variant.
 *
 * For the plain rotations that is simply the opposite turn, so "rot90" applies
 * 270. For the mirrored ones the flop happens first here, and flopping a
 * rotation is the same as rotating the flop the other way, which cancels the
 * two sign flips and leaves the angle as written.
 */
function angleOf(name: DihedralName): number {
  const quarters = name.endsWith("rot90") ? 1 : name.endsWith("rot180") ? 2 : name.endsWith("rot270") ? 3 : 0;
  if (quarters === 0) {
    return 0;
  }
  return name.startsWith("mirror") ? quarters * 90 : 360 - quarters * 90;
}

async function decodeRaw(pipeline: Sharp): Promise<RawImage> {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

function fromRaw(image: RawImage): Sharp {
  return sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: image.channels },
  });
}
