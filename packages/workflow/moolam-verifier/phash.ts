/**
 * The 64-bit perceptual fingerprint Moolam stores on chain, recomputed in plain TypeScript so it
 * can run inside the CRE WASM sandbox where sharp (a native library) cannot.
 *
 * Every step here is copied from sharp-phash 2.2.0, the library the verifier service uses:
 * grey, 32 by 32, 2D DCT, the 8 by 8 block next to the DC term, one bit per coefficient above the
 * average of that block, read column first, 64 bits big endian. Two things had to be measured
 * rather than read: libvips converts colour to grey through linear light, and its Lanczos
 * downscale is tracked closely enough by area averaging at these ratios. With both in place this
 * lands 0 to 2 bits away from sharp on the verifier's 17 test images, against a match threshold
 * of 10, so the workflow's verdict agrees with the verifier's own.
 */

const SAMPLE_SIZE = 32;
const LOW_SIZE = 8;

/**
 * A read that refuses to hand back an undefined sample.
 *
 * Every index below is inside its array by construction, so this never throws in practice. It is
 * written out because the verifier's test project compiles this file with checked indexed access,
 * and because a fingerprint quietly built from a missing byte would be wrong rather than merely
 * late. The local is annotated so the check also compiles under this package's own config, which
 * does not add undefined to an indexed read.
 */
const at = (values: Float64Array | Uint8Array, index: number): number => {
	const value: number | undefined = values[index];
	if (value === undefined) {
		throw new Error(`sample ${index} is outside a ${values.length} entry buffer`);
	}
	return value;
};

const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
	const c = i / 255;
	SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const linearToSrgb = (v: number): number =>
	(v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255;

// Flat rather than an array of rows: one indexed read per lookup instead of two, so the checked
// read above stays cheap in the DCT's inner loop. Entry k * SAMPLE_SIZE + n is cos for row k, term n.
const COS = new Float64Array(SAMPLE_SIZE * SAMPLE_SIZE);
for (let k = 0; k < SAMPLE_SIZE; k++) {
	for (let n = 0; n < SAMPLE_SIZE; n++) {
		COS[SAMPLE_SIZE * k + n] = Math.cos(((2 * k + 1) / (2 * SAMPLE_SIZE)) * n * Math.PI);
	}
}

const SQRT = new Float64Array(SAMPLE_SIZE);
for (let i = 0; i < SAMPLE_SIZE; i++) SQRT[i] = i === 0 ? 1 / Math.sqrt(2) : 1;

const grayGrid = (
	pixels: Uint8Array,
	width: number,
	height: number,
	channels: number,
): Float64Array => {
	const gray = new Float64Array(width * height);
	for (let i = 0; i < width * height; i++) {
		const base = i * channels;
		if (channels === 3) {
			const light =
				0.2126 * at(SRGB_TO_LINEAR, at(pixels, base)) +
				0.7152 * at(SRGB_TO_LINEAR, at(pixels, base + 1)) +
				0.0722 * at(SRGB_TO_LINEAR, at(pixels, base + 2));
			gray[i] = linearToSrgb(light);
		} else {
			gray[i] = at(pixels, base);
		}
	}

	const grid = new Float64Array(SAMPLE_SIZE * SAMPLE_SIZE);
	for (let oy = 0; oy < SAMPLE_SIZE; oy++) {
		const y0 = (oy * height) / SAMPLE_SIZE;
		const y1 = ((oy + 1) * height) / SAMPLE_SIZE;
		for (let ox = 0; ox < SAMPLE_SIZE; ox++) {
			const x0 = (ox * width) / SAMPLE_SIZE;
			const x1 = ((ox + 1) * width) / SAMPLE_SIZE;
			let sum = 0;
			let weight = 0;
			for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
				const wy = Math.min(y + 1, y1) - Math.max(y, y0);
				if (wy <= 0) continue;
				for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
					const wx = Math.min(x + 1, x1) - Math.max(x, x0);
					if (wx <= 0) continue;
					sum += at(gray, y * width + x) * wx * wy;
					weight += wx * wy;
				}
			}
			grid[oy * SAMPLE_SIZE + ox] = sum / weight;
		}
	}
	return grid;
};

/**
 * The 2D DCT of the 32 by 32 grid, as `dct[SAMPLE_SIZE * u + v]` where u runs along x.
 *
 * The transform is separable, so this runs it once along y and once along x instead of summing
 * over both axes for every output coefficient: 65,536 multiplications instead of 1,048,576. The
 * result is the same, which matters because the workflow's verdict has to agree bit for bit with
 * the verifier's own fingerprint.
 */
const dct2d = (grid: Float64Array): Float64Array => {
	const alongY = new Float64Array(SAMPLE_SIZE * SAMPLE_SIZE);
	for (let x = 0; x < SAMPLE_SIZE; x++) {
		for (let v = 0; v < SAMPLE_SIZE; v++) {
			let sum = 0;
			for (let y = 0; y < SAMPLE_SIZE; y++) {
				sum += at(COS, SAMPLE_SIZE * y + v) * at(grid, SAMPLE_SIZE * y + x);
			}
			alongY[SAMPLE_SIZE * x + v] = sum;
		}
	}

	const dct = new Float64Array(SAMPLE_SIZE * SAMPLE_SIZE);
	for (let u = 0; u < SAMPLE_SIZE; u++) {
		for (let v = 0; v < SAMPLE_SIZE; v++) {
			let sum = 0;
			for (let x = 0; x < SAMPLE_SIZE; x++) {
				sum += at(COS, SAMPLE_SIZE * x + u) * at(alongY, SAMPLE_SIZE * x + v);
			}
			dct[SAMPLE_SIZE * u + v] = (sum * at(SQRT, u) * at(SQRT, v)) / 4;
		}
	}
	return dct;
};

/**
 * The 64-bit fingerprint of one decoded image.
 *
 * @param pixels Interleaved samples, one byte each. Must hold width by height by channels bytes.
 * @param width Image width in pixels, must be at least 32.
 * @param height Image height in pixels, must be at least 32.
 * @param channels Samples per pixel: 3 for colour, 1 for grey. Any other count throws, because
 * guessing which bytes are which colour would quietly change the fingerprint.
 */
export const perceptualHash = (
	pixels: Uint8Array,
	width: number,
	height: number,
	channels: number,
): bigint => {
	if (width < SAMPLE_SIZE || height < SAMPLE_SIZE) {
		throw new Error(`image is ${width}x${height}, too small to fingerprint`);
	}
	if (channels !== 3 && channels !== 1) {
		throw new Error(`image has ${channels} samples per pixel, expected 3 for colour or 1 for grey`);
	}
	const expected = width * height * channels;
	if (pixels.length < expected) {
		throw new Error(`image needs ${expected} samples, got ${pixels.length}`);
	}

	const grid = grayGrid(pixels, width, height, channels);
	const dct = dct2d(grid);

	let total = 0;
	for (let x = 0; x < LOW_SIZE; x++) {
		for (let y = 0; y < LOW_SIZE; y++) total += at(dct, SAMPLE_SIZE * (x + 1) + y + 1);
	}
	const average = total / (LOW_SIZE * LOW_SIZE);

	let hash = 0n;
	for (let x = 0; x < LOW_SIZE; x++) {
		for (let y = 0; y < LOW_SIZE; y++) {
			hash = (hash << 1n) | (at(dct, SAMPLE_SIZE * (x + 1) + y + 1) > average ? 1n : 0n);
		}
	}
	return hash;
};

/** How many of the 64 bits differ between two fingerprints. */
export const hamming64 = (a: bigint, b: bigint): number => {
	let diff = (a ^ b) & 0xffffffffffffffffn;
	let bits = 0;
	while (diff !== 0n) {
		diff &= diff - 1n;
		bits++;
	}
	return bits;
};

/** A fingerprint as 16 hex characters with the 0x prefix, the form the logs use. */
export const toHex64 = (hash: bigint): `0x${string}` =>
	`0x${hash.toString(16).padStart(16, "0")}`;

/** A fingerprint widened to the bytes32 the registry stores it in, left padded with zeros. */
export const toBytes32 = (hash: bigint): `0x${string}` =>
	`0x${hash.toString(16).padStart(64, "0")}`;
