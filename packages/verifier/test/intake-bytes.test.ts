// Covers what the bytes of a registered picture may carry, from review pass 6. V38: the upright
// baseline path rebuilds the file from the segments a picture needs, so a GoPro GPS block, an APP12
// segment, a comment, bytes after the end marker and an appended second image with its own EXIF all
// stay out of the signed file, public or sealed, while the pixels, the colour profile and the Adobe
// marker survive untouched. V42: the manifest hash covers the C2PA store alone, so a foreign JUMBF
// box beside it changes nothing, and a file carrying only Moolam's store hashes as it always did.
// V45: reading a manifest never reaches the network, even when the file names a remote manifest,
// and a read that hangs is given up after five seconds as unreadable while /verify still answers;
// that answer is marked for callers as timed out and its JSON is the plain unreadable one.
// Does NOT cover what the C2PA signer does with a store the upload already carried (the camera
// record, test/camera-record.test.ts), HEIF, AVIF or JPEG XL, or a real camera's files: the
// review's file is built here segment by segment.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Reader } from "@contentauth/c2pa-node";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { READ_MANIFEST_TIMEOUT_MS, readManifest, readTimedOut } from "../src/c2pa.js";
import { prepareOrFallback, prepareSealed, uprightImage } from "../src/prepare.js";
import { buildServer } from "../src/server.js";
import { makeImage, multipartBody } from "./helpers.js";
import { HIDDEN, bytesAfterScan, jumbfSegment, markersBeforeScan, reviewersFile, segment, segmentsBeforeScan, withSegments } from "./jpegParts.js";

const SETTINGS = { title: "Harbour", claimGenerator: "moolam-studio/0.1.0", action: "c2pa.opened" as const };

/** The hash the old code took: every JUMBF APP11 payload before the scan, joined in order. */
function everyJumbfHash(jpeg: Buffer): string {
  const chunks = segmentsBeforeScan(jpeg, 0xeb)
    .filter((payload) => payload.subarray(0, 2).toString("latin1") === "JP")
    .map((payload) => payload.subarray(payload.readUInt32BE(4) === 1 ? 8 : 16));
  return `0x${createHash("sha256").update(Buffer.concat(chunks)).digest("hex")}`;
}

describe("V38: what an upright baseline JPEG keeps", () => {
  it("drops the review's GPS block, APP12, comment, trailer and second image, public or sealed, with no pixel changed", async () => {
    const upload = await reviewersFile(await makeImage(61));
    for (const text of Object.values(HIDDEN)) {
      expect(upload.includes(Buffer.from(text, "latin1")), text).toBe(true);
    }
    expect((await sharp(upload).metadata()).isProgressive).toBe(false);

    const published = await prepareOrFallback(upload, SETTINGS);
    const sealed = await prepareSealed(upload, SETTINGS);
    for (const [path, signed] of [["public", published.bytes], ["sealed", sealed.bytes]] as const) {
      expect(published.embedded, path).toBe(true);
      for (const text of Object.values(HIDDEN)) {
        expect(signed.includes(Buffer.from(text, "latin1")), `${path}: ${text}`).toBe(false);
      }
      const markers = markersBeforeScan(signed);
      for (const marker of [0xe1, 0xe6, 0xec, 0xfe]) {
        expect(markers, `${path}: ${marker.toString(16)}`).not.toContain(marker);
      }
      expect(bytesAfterScan(signed), path).toBe(0);
      const before = await sharp(upload).raw().toBuffer();
      const after = await sharp(signed).raw().toBuffer();
      expect(after.equals(before), path).toBe(true);
    }
  }, 60_000);

  it("keeps the colour profile and the Adobe marker, byte for byte, and the pixels", async () => {
    const profiled = await sharp(await makeImage(62)).withIccProfile("p3").jpeg({ quality: 92 }).toBuffer();
    // Transform 1 says YCbCr, which is what this file already is, so the marker changes no pixel.
    const adobe = segment(0xee, Buffer.from([0x41, 0x64, 0x6f, 0x62, 0x65, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x01]));
    const upload = withSegments(profiled, [adobe]);
    const profile = segmentsBeforeScan(upload, 0xe2).filter((one) => one.subarray(0, 12).toString("latin1") === "ICC_PROFILE\u0000");
    expect(profile.length).toBeGreaterThan(0);

    const upright = await uprightImage(upload);

    expect(segmentsBeforeScan(upright, 0xe2)).toEqual(profile);
    expect(segmentsBeforeScan(upright, 0xee)).toEqual([adobe.subarray(4)]);
    expect((await sharp(upright).raw().toBuffer()).equals(await sharp(upload).raw().toBuffer())).toBe(true);
  }, 60_000);

  it("keeps none of the APP11 segments an upload carries, its C2PA store included", async () => {
    const signed = (await prepareOrFallback(await makeImage(63), SETTINGS)).bytes;
    const upload = withSegments(signed, [jumbfSegment(7, "jpeg360")]);
    expect(segmentsBeforeScan(upload, 0xeb).length).toBeGreaterThan(1);

    const upright = await uprightImage(upload);

    expect(upright.includes(Buffer.from("jpeg360", "latin1"))).toBe(false);
    expect(markersBeforeScan(upright)).not.toContain(0xeb);
    expect((await sharp(upright).raw().toBuffer()).equals(await sharp(upload).raw().toBuffer())).toBe(true);
  }, 60_000);

  it("re-encodes a file whose header carries a segment no rule here knows", async () => {
    // DAC, the arithmetic coding table, says how the scan is to be decoded, so it is never dropped.
    const upload = withSegments(await makeImage(64), [segment(0xcc, Buffer.from([0x00, 0x10]))]);

    const upright = await uprightImage(upload);

    expect(markersBeforeScan(upright)).not.toContain(0xcc);
    expect((await sharp(upright).metadata()).format).toBe("jpeg");
  }, 60_000);
});

describe("V42: the manifest hash covers the C2PA store alone", () => {
  it("is not moved by the review's jpeg360 box beside the store", async () => {
    const signed = (await prepareOrFallback(await makeImage(65), SETTINGS)).bytes;
    const alone = await readManifest(signed);
    const beside = await readManifest(withSegments(signed, [jumbfSegment(7, "jpeg360")]));

    expect(alone.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(beside.manifestHash).toBe(alone.manifestHash);
  }, 60_000);

  it("hashes a file carrying only Moolam's store exactly as before", async () => {
    const signed = (await prepareOrFallback(await makeImage(66), SETTINGS)).bytes;

    expect((await readManifest(signed)).manifestHash).toBe(everyJumbfHash(signed));
  }, 60_000);

  it("reads a file whose only JUMBF box is foreign as carrying no manifest", async () => {
    const foreign = withSegments(await makeImage(67), [jumbfSegment(7, "jpeg360")]);

    expect(await readManifest(foreign)).toEqual({ present: false });
  }, 60_000);
});

describe("V45: reading a manifest stays off the network and inside five seconds", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("never requests the remote manifest a file names in its XMP", async () => {
    const hits: string[] = [];
    const server = createServer((request, response) => {
      hits.push(String(request.url));
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const xmp =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      `<rdf:Description rdf:about="" xmlns:dcterms="http://purl.org/dc/terms/" dcterms:provenance="http://127.0.0.1:${port}/m.c2pa"/>` +
      "</rdf:RDF></x:xmpmeta>";
    const pointing = await sharp(await makeImage(68)).withXmp(xmp).jpeg().toBuffer();

    try {
      const summary = await readManifest(pointing);
      expect(summary.present).toBe(false);
      expect(hits).toEqual([]);
    } finally {
      server.close();
    }
  }, 30_000);

  it("gives up on a read that hangs after five seconds and calls it unreadable", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Reader, "fromAsset").mockImplementation(() => new Promise(() => {}));
    const picture = await makeImage(69);

    const reading = readManifest(picture);
    await vi.advanceTimersByTimeAsync(READ_MANIFEST_TIMEOUT_MS);

    expect(READ_MANIFEST_TIMEOUT_MS).toBe(5_000);
    await expect(reading).resolves.toEqual({ present: false, validation: "unreadable" });
  }, 30_000);

  it("marks a read it gave up on as timed out for callers, while its JSON stays the plain unreadable answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Reader, "fromAsset").mockImplementation(() => new Promise(() => {}));

    const reading = readManifest(await makeImage(71));
    await vi.advanceTimersByTimeAsync(READ_MANIFEST_TIMEOUT_MS);
    const summary = await reading;

    expect(readTimedOut(summary)).toBe(true);
    expect(JSON.stringify(summary)).toBe(JSON.stringify({ present: false, validation: "unreadable" }));
    expect(readTimedOut({ present: false, validation: "unreadable" })).toBe(false);
  }, 30_000);

  it("still answers /verify when the manifest read hangs", async () => {
    vi.spyOn(Reader, "fromAsset").mockImplementation(() => new Promise(() => {}));
    const app = await buildServer({ source: { load: async () => [] }, logger: false });
    await app.ready();
    try {
      const { payload, headers } = multipartBody("file", "harbour.jpg", "image/jpeg", await makeImage(70));
      const response = await app.inject({ method: "POST", url: "/verify", payload, headers });

      expect(response.statusCode).toBe(200);
      expect(response.json().manifest).toEqual({ present: false, validation: "unreadable" });
    } finally {
      await app.close();
    }
  }, 30_000);
});
