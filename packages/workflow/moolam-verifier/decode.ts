import { decode } from "jpeg-js";

/**
 * JPEG decoding inside the CRE sandbox. jpeg-js is pure JavaScript, which matters because the
 * sandbox is QuickJS compiled to WebAssembly: no native modules, no node:crypto, no Buffer. The
 * spike in ../spike measured a 512 by 384 thumbnail at about 300 ms to decode, well inside the
 * 5 minute execution budget.
 */

export interface DecodedImage {
	pixels: Uint8Array;
	width: number;
	height: number;
	channels: number;
}

/**
 * Decodes JPEG bytes to interleaved samples.
 *
 * Throws when the bytes are empty, are not a JPEG, or decode to a zero-sized image.
 */
export const decodeJpeg = (bytes: Uint8Array): DecodedImage => {
	if (bytes.length === 0) {
		throw new Error("no image bytes to decode");
	}

	// useTArray keeps jpeg-js on Uint8Array instead of Node's Buffer, which does not exist here.
	// formatAsRGBA off drops the alpha channel nobody needs and saves a quarter of the memory.
	// With that flag off jpeg-js writes three interleaved channels whatever the file holds: a grey
	// JPEG is copied into R, G and B, and a CMYK or YCCK JPEG is converted to RGB inside its own
	// copyToImageData. So `channels` below is 3 for every JPEG this decoder accepts.
	const image = decode(bytes, { useTArray: true, formatAsRGBA: false });

	if (!image.width || !image.height) {
		throw new Error("decoded image has no pixels");
	}

	const pixels = image.data as unknown as Uint8Array;
	return {
		pixels,
		width: image.width,
		height: image.height,
		channels: pixels.length / (image.width * image.height),
	};
};
