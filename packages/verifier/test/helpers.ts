import sharp from "sharp";
import type { Fingerprint } from "../src/fingerprint.js";
import type { Hex, PassportRecord } from "../src/types.js";

const WIDTH = 640;
const HEIGHT = 480;

/**
 * Draws a deterministic test picture from an SVG.
 *
 * The shapes are placed off centre and at different sizes per seed so the two
 * hashes see real structure. A flat or symmetric image would give every seed a
 * near-identical block hash and quietly turn the distance assertions into
 * nonsense.
 */
export async function makeImage(seed: number, format: "jpeg" | "png" = "jpeg"): Promise<Buffer> {
  const hue = (seed * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="hsl(${hue},55%,22%)"/>
    <circle cx="${80 + seed * 37 % 420}" cy="${70 + seed * 53 % 300}" r="${40 + seed * 11 % 90}" fill="hsl(${(hue + 140) % 360},80%,68%)"/>
    <rect x="${30 + seed * 23 % 300}" y="${300 + seed * 17 % 120}" width="${140 + seed * 29 % 260}" height="${40 + seed * 13 % 70}" fill="hsl(${(hue + 40) % 360},70%,45%)"/>
    <polygon points="${420 + seed % 90},${40 + seed % 60} ${600 - seed % 70},${210 + seed % 50} ${400 + seed % 60},${260 + seed % 40}" fill="hsl(${(hue + 250) % 360},60%,80%)"/>
    <rect x="0" y="${430 - seed % 40}" width="${WIDTH}" height="24" fill="#101018"/>
  </svg>`;

  const pipeline = sharp(Buffer.from(svg));
  return format === "png" ? pipeline.png().toBuffer() : pipeline.jpeg({ quality: 92 }).toBuffer();
}

/** Builds a passport record whose id is the sha256 of the bytes, as the registry stores it. */
export function recordFor(print: Fingerprint, overrides: Partial<PassportRecord> = {}): PassportRecord {
  return {
    id: print.sha256,
    phash: print.phash,
    blockhash: print.blockhash,
    creator: "0x1111111111111111111111111111111111111111" as Hex,
    parentId: null,
    registeredAt: 1_757_000_000,
    metadataURI: "ipfs://placeholder",
    ...overrides,
  };
}

/** A 32 byte id built from one repeated byte, for index tests that do not need a real image. */
export function idFrom(byte: number): Hex {
  return `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as Hex;
}

/** A 32 byte blockhash with `bits` low bits flipped away from all zeroes. */
export function blockhashWithBits(bits: number): Hex {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bits; i += 1) {
    const index = 31 - Math.floor(i / 8);
    bytes[index] = (bytes[index] as number) | (1 << i % 8);
  }
  return `0x${Buffer.from(bytes).toString("hex")}` as Hex;
}

/**
 * A small JPEG that unpacks to 48 megapixels, past the decode limit. Flat
 * colour, so the file is a few hundred kilobytes and the upload path is not the
 * thing under test.
 */
export async function makeOversizeImage(): Promise<Buffer> {
  return await sharp({ create: { width: 8000, height: 6000, channels: 3, background: "#204060" } })
    .jpeg({ quality: 30 })
    .toBuffer();
}

/** A JPEG that stores its pixels sideways and carries EXIF orientation 6, as a phone camera does. */
export async function makeRotatedImage(seed: number): Promise<{ tagged: Buffer; upright: Buffer }> {
  const source = await makeImage(seed);
  const sideways = await sharp(source).rotate(270).jpeg({ quality: 92 }).toBuffer();
  return {
    tagged: await sharp(sideways).withMetadata({ orientation: 6 }).jpeg({ quality: 92 }).toBuffer(),
    upright: await sharp(sideways).rotate(90).jpeg({ quality: 92 }).toBuffer(),
  };
}

/** A multipart body with one file part, the shape both verify routes read. */
export function multipartBody(
  field: string,
  filename: string,
  contentType: string,
  content: Buffer,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----moolamtest";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, content, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}
