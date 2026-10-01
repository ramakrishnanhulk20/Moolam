/**
 * The 256-bit block hash Moolam stores beside the pHash, recomputed in plain TypeScript for the CRE
 * sandbox. The verify service takes it with imghash 1.1.4, whose hashRaw is blockhash-core 0.1.0's
 * bmvbhash at 16 bits per row; every step below is that function, copied, including its float
 * weights for sizes that do not divide by 16 and its tie rule against each band's median. Fed the
 * same pixels it answers the same 64 hex characters, which
 * packages/verifier/test/workflow-blockhash.test.ts checks against imghash itself.
 *
 * No imports on purpose: the verifier's tests load this file under Node, where the CRE SDK does not.
 */

const BITS_PER_ROW = 16;

/** A read that refuses an undefined sample, for the same reasons phash.ts gives for its own. */
const at = (values: ArrayLike<number>, index: number): number => {
	const value: number | undefined = values[index];
	if (value === undefined) {
		throw new Error(`sample ${index} is outside a ${values.length} entry buffer`);
	}
	return value;
};

/** Sorts a copy, so the caller's block order is kept for the bit pass. */
const median = (values: number[]): number => {
	const sorted = values.slice().sort((a, b) => a - b);
	const half = sorted.length / 2;
	if (sorted.length % 2 === 0) {
		return (at(sorted, half - 1) + at(sorted, half)) / 2;
	}
	return at(sorted, Math.floor(half));
};

const blocksToHex = (blocks: number[], pixelsPerBlock: number): string => {
	// blockhash-core's rule for a picture that is mostly black or mostly white: a block equal to its
	// band's median reads as 1 only when the median sits in the bright half, so such a picture does
	// not hash to all zeros or all ones.
	const halfBlockValue = (pixelsPerBlock * 256 * 3) / 2;
	const bandSize = blocks.length / 4;
	const bits: number[] = [];
	for (let band = 0; band < 4; band++) {
		const slice = blocks.slice(band * bandSize, (band + 1) * bandSize);
		const m = median(slice);
		for (const value of slice) {
			bits.push(value > m || (Math.abs(value - m) < 1 && m > halfBlockValue) ? 1 : 0);
		}
	}

	let hex = "";
	for (let i = 0; i < bits.length; i += 4) {
		hex += ((at(bits, i) << 3) | (at(bits, i + 1) << 2) | (at(bits, i + 2) << 1) | at(bits, i + 3)).toString(16);
	}
	return hex;
};

/**
 * The brightness of one pixel as blockhash-core sums it: red plus green plus blue. A JPEG has no
 * alpha, so the library's transparent-pixel rule never applies here; a grey sample counts three
 * times, as the canvas decoder the service uses spreads it into all three channels.
 */
const brightness = (pixels: Uint8Array, pixel: number, channels: number): number => {
	const base = pixel * channels;
	if (channels === 1) return 3 * at(pixels, base);
	return at(pixels, base) + at(pixels, base + 1) + at(pixels, base + 2);
};

const evenBlocks = (pixels: Uint8Array, width: number, height: number, channels: number): string => {
	const blockWidth = Math.floor(width / BITS_PER_ROW);
	const blockHeight = Math.floor(height / BITS_PER_ROW);
	const blocks: number[] = [];
	for (let y = 0; y < BITS_PER_ROW; y++) {
		for (let x = 0; x < BITS_PER_ROW; x++) {
			let total = 0;
			for (let iy = 0; iy < blockHeight; iy++) {
				for (let ix = 0; ix < blockWidth; ix++) {
					total += brightness(pixels, (y * blockHeight + iy) * width + x * blockWidth + ix, channels);
				}
			}
			blocks.push(total);
		}
	}
	return blocksToHex(blocks, blockWidth * blockHeight);
};

/**
 * The block hash of one decoded image, as `0x` and 64 hex characters.
 *
 * @param pixels Interleaved samples, one byte each, width by height by channels of them.
 * @param channels 3 for colour or 1 for grey; anything else throws rather than guess.
 * Throws when a side is under 16 pixels, since a block would then hold no pixel at all.
 */
export const blockHash = (pixels: Uint8Array, width: number, height: number, channels: number): `0x${string}` => {
	if (width < BITS_PER_ROW || height < BITS_PER_ROW) {
		throw new Error(`image is ${width}x${height}, too small for a block hash`);
	}
	if (channels !== 3 && channels !== 1) {
		throw new Error(`image has ${channels} samples per pixel, expected 3 for colour or 1 for grey`);
	}
	if (pixels.length < width * height * channels) {
		throw new Error(`image needs ${width * height * channels} samples, got ${pixels.length}`);
	}

	const evenX = width % BITS_PER_ROW === 0;
	const evenY = height % BITS_PER_ROW === 0;
	if (evenX && evenY) {
		return `0x${evenBlocks(pixels, width, height, channels)}`;
	}

	const blocks = new Float64Array(BITS_PER_ROW * BITS_PER_ROW);
	const add = (row: number, column: number, value: number): void => {
		const index = row * BITS_PER_ROW + column;
		blocks[index] = at(blocks, index) + value;
	};
	const blockWidth = width / BITS_PER_ROW;
	const blockHeight = height / BITS_PER_ROW;

	for (let y = 0; y < height; y++) {
		let blockTop: number;
		let blockBottom: number;
		let weightTop: number;
		let weightBottom: number;
		if (evenY) {
			blockTop = blockBottom = Math.floor(y / blockHeight);
			weightTop = 1;
			weightBottom = 0;
		} else {
			const yMod = (y + 1) % blockHeight;
			const yFrac = yMod - Math.floor(yMod);
			const yInt = yMod - yFrac;
			weightTop = 1 - yFrac;
			weightBottom = yFrac;
			if (yInt > 0 || y + 1 === height) {
				blockTop = blockBottom = Math.floor(y / blockHeight);
			} else {
				blockTop = Math.floor(y / blockHeight);
				blockBottom = Math.ceil(y / blockHeight);
			}
		}

		for (let x = 0; x < width; x++) {
			const value = brightness(pixels, y * width + x, channels);
			let blockLeft: number;
			let blockRight: number;
			let weightLeft: number;
			let weightRight: number;
			if (evenX) {
				blockLeft = blockRight = Math.floor(x / blockWidth);
				weightLeft = 1;
				weightRight = 0;
			} else {
				const xMod = (x + 1) % blockWidth;
				const xFrac = xMod - Math.floor(xMod);
				const xInt = xMod - xFrac;
				weightLeft = 1 - xFrac;
				weightRight = xFrac;
				if (xInt > 0 || x + 1 === width) {
					blockLeft = blockRight = Math.floor(x / blockWidth);
				} else {
					blockLeft = Math.floor(x / blockWidth);
					blockRight = Math.ceil(x / blockWidth);
				}
			}

			// The same four adds in the same order as blockhash-core, so the float sums round alike.
			add(blockTop, blockLeft, value * weightTop * weightLeft);
			add(blockTop, blockRight, value * weightTop * weightRight);
			add(blockBottom, blockLeft, value * weightBottom * weightLeft);
			add(blockBottom, blockRight, value * weightBottom * weightRight);
		}
	}

	return `0x${blocksToHex(Array.from(blocks), blockWidth * blockHeight)}`;
};

/** How many of the bits differ between two block hashes of the same length, both `0x` and hex. */
export const hammingHex = (a: string, b: string): number => {
	const left = a.slice(2).toLowerCase();
	const right = b.slice(2).toLowerCase();
	if (left.length !== right.length || !/^[0-9a-f]*$/.test(left) || !/^[0-9a-f]*$/.test(right)) {
		throw new Error("hammingHex needs two 0x hex strings of the same length");
	}
	let bits = 0;
	for (let i = 0; i < left.length; i++) {
		let nibble = Number.parseInt(left.charAt(i), 16) ^ Number.parseInt(right.charAt(i), 16);
		while (nibble !== 0) {
			nibble &= nibble - 1;
			bits++;
		}
	}
	return bits;
};
