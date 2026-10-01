/**
 * The eight turns and mirrors of a decoded picture, and the two fingerprints of each, the way the
 * verify service's src/dihedral.ts builds them: same names, same order, same meaning. A name says
 * what was done to the registered original to give this copy, so each variant applies the inverse,
 * and the mirrored four flop the pixels first and then turn that result clockwise. Turning and
 * flopping only move pixels, so the service's lossless PNG round trip has nothing to add here.
 *
 * Imports only the two pure hash files, so the verifier's tests load it under Node.
 */

import { blockHash } from "./blockhash";
import { perceptualHash, toHex64 } from "./phash";

export type DihedralName =
	| "identity"
	| "rot90"
	| "rot180"
	| "rot270"
	| "mirror"
	| "mirror-rot90"
	| "mirror-rot180"
	| "mirror-rot270";

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

export interface Picture {
	pixels: Uint8Array;
	width: number;
	height: number;
	channels: number;
}

/** One variant's fingerprints, in the shapes the candidates route takes them. */
export interface FingerprintPair {
	variant: DihedralName;
	/** `0x` and 16 hex characters. */
	phash: string;
	/** `0x` and 64 hex characters. */
	blockhash: string;
}

/** The clockwise quarter turns that undo a variant, as the service's angleOf works them out. */
const quartersOf = (name: DihedralName): number => {
	const quarters = name.endsWith("rot90") ? 1 : name.endsWith("rot180") ? 2 : name.endsWith("rot270") ? 3 : 0;
	if (quarters === 0) return 0;
	return name.startsWith("mirror") ? quarters : 4 - quarters;
};

const copyPixel = (from: Picture, fromIndex: number, to: Uint8Array, toIndex: number): void => {
	const c = from.channels;
	for (let k = 0; k < c; k++) {
		const value: number | undefined = from.pixels[fromIndex * c + k];
		if (value === undefined) {
			throw new Error(`pixel ${fromIndex} is outside the picture`);
		}
		to[toIndex * c + k] = value;
	}
};

const flop = (picture: Picture): Picture => {
	const { width, height, channels } = picture;
	const out = new Uint8Array(width * height * channels);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			copyPixel(picture, y * width + (width - 1 - x), out, y * width + x);
		}
	}
	return { pixels: out, width, height, channels };
};

/** The picture turned clockwise by `quarters` quarter turns. */
const turnClockwise = (picture: Picture, quarters: number): Picture => {
	const { width, height, channels } = picture;
	if (quarters === 0) return picture;
	const sideways = quarters % 2 === 1;
	const outWidth = sideways ? height : width;
	const outHeight = sideways ? width : height;
	const out = new Uint8Array(width * height * channels);
	for (let y = 0; y < outHeight; y++) {
		for (let x = 0; x < outWidth; x++) {
			let sourceX: number;
			let sourceY: number;
			if (quarters === 1) {
				sourceX = y;
				sourceY = height - 1 - x;
			} else if (quarters === 2) {
				sourceX = width - 1 - x;
				sourceY = height - 1 - y;
			} else {
				sourceX = width - 1 - y;
				sourceY = x;
			}
			copyPixel(picture, sourceY * width + sourceX, out, y * outWidth + x);
		}
	}
	return { pixels: out, width: outWidth, height: outHeight, channels };
};

/** One variant of the picture, as the service's dihedralVariants would draw it. */
export const variantOf = (picture: Picture, name: DihedralName): Picture =>
	turnClockwise(name.startsWith("mirror") ? flop(picture) : picture, quartersOf(name));

/**
 * The pHash and the block hash of all eight variants, identity first. Each node computes these from
 * the bytes it fetched, and the run only goes on once a quorum of nodes produced the same eight.
 */
export const dihedralFingerprints = (picture: Picture): FingerprintPair[] => {
	const mirrored = flop(picture);
	return DIHEDRAL_NAMES.map((variant) => {
		const turned = turnClockwise(variant.startsWith("mirror") ? mirrored : picture, quartersOf(variant));
		return {
			variant,
			phash: toHex64(perceptualHash(turned.pixels, turned.width, turned.height, turned.channels)),
			blockhash: blockHash(turned.pixels, turned.width, turned.height, turned.channels),
		};
	});
};
