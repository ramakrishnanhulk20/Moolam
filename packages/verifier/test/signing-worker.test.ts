// Covers where C2PA signing runs (review pass 8, intake 4, V71): the thread that answers requests
// never calls the library's blocking sign, its timers keep firing while a large file is signed, a
// file signed on the worker reads back with the manifest embedManifest always wrote and validates,
// and a refusal or a missing identity reaches the caller as the same error class as before.
// Does NOT cover the size of the stall itself, which is measured rather than asserted (the report
// for WO-185b gives the before and after), nor a worker that crashes or hangs, which would need a
// broken native library to provoke.

import path from "node:path";
import { Builder, Reader } from "@contentauth/c2pa-node";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SOFT_BINDING_ALG, SignerRefusedFile, embedManifest, readManifest } from "../src/c2pa.js";
import { PACKAGE_ROOT } from "../src/env.js";
import { fingerprint } from "../src/fingerprint.js";
import { makeImage } from "./helpers.js";

const AI_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

/** A detailed 9 megapixel JPEG: large enough that signing it takes hundreds of milliseconds. */
async function makeDetailedPicture(): Promise<Buffer> {
  const side = 750;
  const raw = Buffer.alloc(side * side * 3);
  let state = 4242;
  for (let i = 0; i < raw.length; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = (state >> 16) & 0xff;
  }
  return await sharp(raw, { raw: { width: side, height: side, channels: 3 } })
    .resize(3000, 3000, { kernel: "nearest" })
    .jpeg({ quality: 90 })
    .toBuffer();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("V71: signing off the thread that answers requests", () => {
  it("never calls the blocking sign here, and a 5 ms timer keeps firing while a large file is signed", async () => {
    const bytes = await makeDetailedPicture();
    const blocking = vi.spyOn(Builder.prototype, "sign");

    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);
    let signed: Buffer;
    try {
      signed = await embedManifest(bytes, {
        title: "detailed.jpg",
        claimGenerator: "moolam-studio/0.1.0",
        action: "c2pa.opened",
        softBinding: { phash: 1n, blockhash: `0x${"ab".repeat(32)}` },
      });
    } finally {
      clearInterval(timer);
    }

    expect(blocking).not.toHaveBeenCalled();
    expect(ticks).toBeGreaterThan(0);
    expect((await readManifest(signed)).validation).toBe("valid");
  }, 60_000);

  it("reads back a created picture with the same manifest shape, the training statement included, and it validates", async () => {
    const bytes = await makeImage(71);
    const print = await fingerprint(bytes);

    const signed = await embedManifest(bytes, {
      title: "generated.jpg",
      claimGenerator: "moolam-generator/0.1.0",
      action: "c2pa.created",
      digitalSourceType: AI_SOURCE_TYPE,
      softBinding: { phash: print.phash, blockhash: print.blockhash },
      training: { aiTraining: "notAllowed", dataMining: "allowed" },
    });

    const manifest = await readManifest(signed);
    expect(manifest).toMatchObject({
      present: true,
      validation: "valid",
      title: "generated.jpg",
      claimGenerator: "moolam-generator/0.1.0",
      actions: ["c2pa.created"],
      ingredients: 0,
      softBinding: { alg: SOFT_BINDING_ALG, phash: print.phash, blockhash: print.blockhash },
    });
    expect(manifest.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);

    const reader = await Reader.fromAsset({ buffer: signed, mimeType: "image/jpeg" });
    const labels = (reader?.getActive()?.assertions ?? []).map((one) => one.label);
    expect(labels).toEqual(expect.arrayContaining(["c2pa.soft-binding", "cawg.training-mining"]));
    expect(labels.some((label) => label.startsWith("c2pa.actions"))).toBe(true);
  }, 60_000);

  it("reads back an opened and an edited file with the file as their one parent", async () => {
    const bytes = await makeImage(72);
    const print = await fingerprint(bytes);
    for (const [action, actions] of [
      ["c2pa.opened", ["c2pa.opened"]],
      ["c2pa.edited", ["c2pa.opened", "c2pa.edited"]],
    ] as const) {
      const manifest = await readManifest(
        await embedManifest(bytes, {
          title: "handed-over.jpg",
          claimGenerator: "moolam-studio/0.1.0",
          action,
          softBinding: { phash: print.phash, blockhash: print.blockhash },
        }),
      );
      expect(manifest).toMatchObject({ present: true, validation: "valid", actions, ingredients: 1 });
    }
  }, 60_000);

  it("hands back a file the library refuses as SignerRefusedFile, and signs the next file as before", async () => {
    const softBinding = { phash: 1n, blockhash: `0x${"cd".repeat(32)}` as const };
    await expect(
      embedManifest(Buffer.from("these bytes are no picture at all"), {
        title: "nothing.jpg",
        claimGenerator: "moolam-studio/0.1.0",
        action: "c2pa.opened",
        softBinding,
      }),
    ).rejects.toBeInstanceOf(SignerRefusedFile);

    const signed = await embedManifest(await makeImage(73), {
      title: "after.jpg",
      claimGenerator: "moolam-studio/0.1.0",
      action: "c2pa.opened",
      softBinding,
    });
    expect((await readManifest(signed)).validation).toBe("valid");
  }, 60_000);

  it("says SignerUnavailable when the signing identity is not on disk", async () => {
    vi.resetModules();
    vi.doMock("../src/env.js", async (importOriginal) => {
      const real = await importOriginal<typeof import("../src/env.js")>();
      const missing = path.join(PACKAGE_ROOT, "test-assets", "certs", "nothing.pem");
      return { ...real, env: { ...real.env, MOOLAM_C2PA_CERT_PATH: missing, MOOLAM_C2PA_KEY_PATH: missing } };
    });
    const fresh = await import("../src/c2pa.js");

    await expect(
      fresh.embedManifest(await makeImage(74), {
        title: "unsigned.jpg",
        claimGenerator: "moolam-studio/0.1.0",
        action: "c2pa.opened",
        softBinding: { phash: 1n, blockhash: `0x${"ef".repeat(32)}` },
      }),
    ).rejects.toBeInstanceOf(fresh.SignerUnavailable);
    vi.doUnmock("../src/env.js");
  }, 60_000);
});
