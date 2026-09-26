import sharp from "sharp";

// Builders for JPEG files whose segments a test chooses, and the review's pictures from pass 6.
// Kept apart from helpers.ts so the other open work order can rely on that file staying as it is.

/** One JPEG marker segment: FF, the marker, a two byte length that counts itself, the payload. */
export function segment(marker: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
}

/** The same JPEG with extra segments right after its start marker. */
export function withSegments(jpeg: Buffer, segments: Buffer[]): Buffer {
  return Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
}

/** Every marker a JPEG carries before its first scan, in order. */
export function markersBeforeScan(jpeg: Buffer): number[] {
  const markers: number[] = [];
  let offset = 2;
  while (offset + 4 <= jpeg.length && jpeg[offset] === 0xff) {
    const marker = jpeg[offset + 1] as number;
    markers.push(marker);
    if (marker === 0xda) {
      break;
    }
    offset += 2 + jpeg.readUInt16BE(offset + 2);
  }
  return markers;
}

/** The payloads of every segment with this marker before the first scan. */
export function segmentsBeforeScan(jpeg: Buffer, marker: number): Buffer[] {
  const found: Buffer[] = [];
  let offset = 2;
  while (offset + 4 <= jpeg.length && jpeg[offset] === 0xff) {
    const at = jpeg[offset + 1] as number;
    if (at === 0xda) {
      break;
    }
    const end = offset + 2 + jpeg.readUInt16BE(offset + 2);
    if (at === marker) {
      found.push(jpeg.subarray(offset + 4, end));
    }
    offset = end;
  }
  return found;
}

/**
 * One APP11 segment holding a whole JUMBF superbox in packet 1: the "JP" tag, the box instance,
 * the packet number, then a jumb box whose description box carries `label`.
 */
export function jumbfSegment(instance: number, label: string, content: Buffer = Buffer.from("not a manifest")): Buffer {
  const labelBytes = Buffer.from(`${label}\u0000`, "latin1");
  const description = Buffer.concat([Buffer.alloc(16, 0x11), Buffer.from([0x03]), labelBytes]);
  const jumd = Buffer.concat([u32(description.length + 8), Buffer.from("jumd", "latin1"), description]);
  const json = Buffer.concat([u32(content.length + 8), Buffer.from("json", "latin1"), content]);
  const jumb = Buffer.concat([u32(jumd.length + json.length + 8), Buffer.from("jumb", "latin1"), jumd, json]);
  const header = Buffer.concat([Buffer.from("JP", "latin1"), u16(instance), u32(1)]);
  return segment(0xeb, Buffer.concat([header, jumb]));
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
}

/** The camera secrets the review hid in the file, each one a string a test can search for. */
export const HIDDEN = {
  exif: "Serial 0042",
  gpmf: "GPS5 12,58.2960N 80,16.1100E",
  app12: "Ducky camera SERIAL-1212",
  comment: "shot by SERIAL-4242",
  trailer: "motion clip SERIAL-9999",
  secondImage: "second image GPS 13,04.0000N",
} as const;

/**
 * The review's file for V38: an upright baseline JPEG with EXIF in APP1, a GoPro GPMF block with
 * GPS text in APP6, an APP12 segment, a comment, bytes after its end marker, and a second JPEG
 * appended whose own APP1 names a place.
 */
export async function reviewersFile(base: Buffer): Promise<Buffer> {
  const tagged = await sharp(base)
    .withExif({ IFD0: { Make: "Moolam Test Camera", Model: HIDDEN.exif } })
    .jpeg({ quality: 92 })
    .toBuffer();
  const withHeaders = withSegments(tagged, [
    segment(0xe6, Buffer.from(`GoPro\u0000GPMF${HIDDEN.gpmf}`, "latin1")),
    segment(0xec, Buffer.from(HIDDEN.app12, "latin1")),
    segment(0xfe, Buffer.from(HIDDEN.comment, "latin1")),
  ]);
  const second = withSegments(
    await sharp({ create: { width: 32, height: 24, channels: 3, background: "#806040" } }).jpeg().toBuffer(),
    [segment(0xe1, Buffer.from(`Exif\u0000\u0000${HIDDEN.secondImage}`, "latin1"))],
  );
  return Buffer.concat([withHeaders, Buffer.from(HIDDEN.trailer, "latin1"), second]);
}

/**
 * The review's picture for intake 1: a sky that only changes from top to bottom over a dark
 * horizon band, with plus or minus 4 of grain. The pHash never reads row 0 or column 0 of its
 * DCT block, so almost nothing in this picture decides its bits except the grain.
 */
export async function skyOverHorizon(seed: number, width = 1200, height = 900): Promise<Buffer> {
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

/**
 * The same JPEG grown to `target` bytes with repeated quantisation tables, which every decoder
 * reads and which change no pixel: each copy redefines the first table with the values it already has.
 * It stands in for a large camera file the byte path keeps as it is.
 */
export function grownWithTables(jpeg: Buffer, target: number): Buffer {
  const table = segmentsBeforeScan(jpeg, 0xdb)[0];
  if (table === undefined) {
    throw new Error("this JPEG has no quantisation table to repeat");
  }
  const first = firstTable(table);
  const perSegment = Math.floor(65_533 / first.length);
  const segments: Buffer[] = [];
  let size = jpeg.length;
  while (size + 4 + first.length <= target) {
    const count = Math.min(perSegment, Math.floor((target - size - 4) / first.length));
    const payload = Buffer.concat(Array.from({ length: count }, () => first));
    segments.push(segment(0xdb, payload));
    size += payload.length + 4;
  }
  return withSegments(jpeg, segments);
}

/** The first table defined in a DQT payload: its precision byte and 64 or 128 bytes of values. */
function firstTable(payload: Buffer): Buffer {
  const precision = (payload[0] as number) >> 4;
  return payload.subarray(0, 1 + (precision === 0 ? 64 : 128));
}

/**
 * How many bytes follow the end marker of the file's first scan, found the way a decoder finds it:
 * past the scan header, skipping stuffed bytes and restart markers. A C2PA store can hold a whole
 * thumbnail JPEG, end marker included, so counting FF D9 anywhere in the file would say nothing.
 */
export function bytesAfterScan(jpeg: Buffer): number {
  let offset = 2;
  while (jpeg[offset + 1] !== 0xda) {
    offset += 2 + jpeg.readUInt16BE(offset + 2);
  }
  let at = offset + 2 + jpeg.readUInt16BE(offset + 2);
  while (at + 1 < jpeg.length) {
    const next = jpeg[at + 1] as number;
    if (jpeg[at] === 0xff && next === 0xd9) {
      return jpeg.length - (at + 2);
    }
    at += jpeg[at] === 0xff && next !== 0xff ? 2 : 1;
  }
  throw new Error("this JPEG's first scan has no end marker");
}
