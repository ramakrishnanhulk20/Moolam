// Covers what /verify says about a Content Credentials manifest that is damaged, tampered with or
// moved onto another picture: the fingerprint answer always stands, a manifest that fails the C2PA
// library's own validation says so, and one that cannot be read says that instead.
// Does NOT cover trust lists (the development certificate is on none, so a clean manifest reads as
// valid, never trusted), and does not cover PNG or WebP containers, which the damage cases here do
// not reach.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { embedManifest, readManifest } from "../src/c2pa.js";
import { fingerprint } from "../src/fingerprint.js";
import { buildServer } from "../src/server.js";
import { makeImage, multipartBody, recordFor } from "./helpers.js";

/** Every APP11 segment of a JPEG, marker and length included, which is where C2PA keeps its store. */
function app11Segments(bytes: Buffer): Buffer[] {
  const segments: Buffer[] = [];
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff && bytes[offset + 1] !== 0xda) {
    const length = bytes.readUInt16BE(offset + 2);
    if (bytes[offset + 1] === 0xeb) {
      segments.push(bytes.subarray(offset, offset + 2 + length));
    }
    offset += 2 + length;
  }
  return segments;
}

/** The bytes right after the start-of-image marker, where a stray segment is the easiest to slip in. */
function insertAfterSoi(bytes: Buffer, extra: Buffer): Buffer {
  return Buffer.concat([bytes.subarray(0, 2), extra, bytes.subarray(2)]);
}

describe("a damaged manifest on /verify", () => {
  let app: FastifyInstance;
  let signed: Buffer;
  let passportId: string;

  beforeAll(async () => {
    const picture = await makeImage(41);
    const print = await fingerprint(picture);
    signed = await embedManifest(picture, {
      title: "moolam-damage.jpg",
      claimGenerator: "moolam-verifier/0.1.0",
      action: "c2pa.created",
      softBinding: { phash: print.phash, blockhash: print.blockhash },
    });
    const record = recordFor(await fingerprint(signed));
    passportId = record.id;
    app = await buildServer({ source: { load: async () => [record] }, logger: false });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  async function verify(bytes: Buffer): Promise<{ statusCode: number; body: Record<string, any> }> {
    const { payload, headers } = multipartBody("file", "copy.jpg", "image/jpeg", bytes);
    const response = await app.inject({ method: "POST", url: "/verify", payload, headers });
    return { statusCode: response.statusCode, body: response.json() };
  }

  it("reports a clean signed picture's manifest as valid", async () => {
    const { statusCode, body } = await verify(signed);

    expect(statusCode).toBe(200);
    expect(body.result.exact).toBe(passportId);
    expect(body.manifest.present).toBe(true);
    expect(body.manifest.validation).toBe("valid");
    expect(body.manifest.title).toBe("moolam-damage.jpg");
  });

  it("still matches a copy with six inserted bytes, and says its manifest fails validation", async () => {
    const copy = insertAfterSoi(signed, Buffer.from([0xff, 0xeb, 0x00, 0x04, 0x4a, 0x50]));
    const { statusCode, body } = await verify(copy);

    expect(statusCode, JSON.stringify(body)).toBe(200);
    await expect(readManifest(copy)).resolves.toBeDefined();
    expect(body.result.best.id).toBe(passportId);
    expect(body.result.best.phashDistance).toBe(0);
    expect(body.manifest.present).toBe(true);
    expect(body.manifest.validation).toBe("invalid");
    expect(body.manifest.failures).toContain("assertion.dataHash.mismatch");
  });

  it("says a manifest moved onto another picture fails validation", async () => {
    const other = await makeImage(77);
    const transplanted = insertAfterSoi(other, Buffer.concat(app11Segments(signed)));

    const { statusCode, body } = await verify(transplanted);

    expect(statusCode).toBe(200);
    expect(body.result.best).toBeNull();
    expect(body.manifest.present).toBe(true);
    expect(body.manifest.validation).toBe("invalid");
    expect(body.manifest.failures).toContain("assertion.dataHash.mismatch");
  });

  it("says a manifest it cannot read could not be read, and the match still stands", async () => {
    const broken = Buffer.from(signed);
    const [first] = app11Segments(signed);
    const start = signed.indexOf(first as Buffer);
    // Zeroes the JUMBF box header inside the first APP11 packet, so the store is there but unparseable.
    broken.fill(0x00, start + 4 + 16, start + 4 + 40);

    const { statusCode, body } = await verify(broken);

    expect(statusCode).toBe(200);
    expect(body.result.best.id).toBe(passportId);
    expect(body.manifest.present).toBe(false);
    expect(body.manifest.validation).toBe("unreadable");
  });

  it("leaves a picture with no manifest at all as plainly absent", async () => {
    const { statusCode, body } = await verify(await makeImage(42));

    expect(statusCode).toBe(200);
    expect(body.manifest).toEqual({ present: false });
  });
});
