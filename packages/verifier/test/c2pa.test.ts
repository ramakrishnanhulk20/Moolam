// Covers the soft binding round trip through a signed C2PA manifest, and what the signed actions
// say about where a picture came from (pass 4, V22): a picture Moolam's own agent generated says
// trainedAlgorithmicMedia, and a file somebody handed Moolam says only that Moolam opened it,
// with the file as its parent ingredient and no source type at all.
// Does NOT cover trust list validation (the development certificate is not on
// any trust list, by design), nor manifest survival through a re-encode, which
// scripts/robustness.ts measures and the README states plainly.

import path from "node:path";
import { Reader } from "@contentauth/c2pa-node";
import { describe, expect, it } from "vitest";
import { SOFT_BINDING_ALG, SignerUnavailable, embedManifest, ensureSigner, loadSigner, readManifest } from "../src/c2pa.js";
import { PACKAGE_ROOT } from "../src/env.js";
import { fingerprint } from "../src/fingerprint.js";
import { makeImage } from "./helpers.js";

const DEV_CERT_DIR = path.join(PACKAGE_ROOT, "test-assets", "certs");

const AI_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

/** The actions the signed file carries, in order, read back with the C2PA library itself. */
async function signedActions(signed: Buffer): Promise<Record<string, unknown>[]> {
  const reader = await Reader.fromAsset({ buffer: signed, mimeType: "image/jpeg" });
  return (reader?.getActive()?.assertions ?? [])
    .filter((one) => one.label?.startsWith("c2pa.actions"))
    .flatMap((one) => (one.data as { actions: Record<string, unknown>[] }).actions);
}

describe("V22: the source a manifest states", () => {
  it("keeps trainedAlgorithmicMedia on a picture Moolam's own agent generated", async () => {
    const bytes = await makeImage(44);
    const print = await fingerprint(bytes);
    const signed = await embedManifest(bytes, {
      title: "generated.jpg",
      claimGenerator: "moolam-generator/0.1.0",
      action: "c2pa.created",
      digitalSourceType: AI_SOURCE_TYPE,
      softBinding: { phash: print.phash, blockhash: print.blockhash },
    });

    expect(await signedActions(signed)).toEqual([{ action: "c2pa.created", digitalSourceType: AI_SOURCE_TYPE }]);
    expect((await readManifest(signed)).validation).toBe("valid");
  }, 60_000);

  it("says only that Moolam opened a file it was handed, and edited one when told it is an edit", async () => {
    const bytes = await makeImage(45);
    const print = await fingerprint(bytes);
    for (const [action, expected] of [
      ["c2pa.opened", ["c2pa.opened"]],
      ["c2pa.edited", ["c2pa.opened", "c2pa.edited"]],
    ] as const) {
      const signed = await embedManifest(bytes, {
        title: "handed-over.jpg",
        claimGenerator: "moolam-studio/0.1.0",
        action,
        softBinding: { phash: print.phash, blockhash: print.blockhash },
      });

      const actions = await signedActions(signed);
      const manifest = await readManifest(signed);
      expect(actions.map((one) => one.action), action).toEqual(expected);
      expect(JSON.stringify(actions), action).not.toContain("digitalSourceType");
      expect(manifest.validation, action).toBe("valid");
      expect(manifest.ingredients, action).toBe(1);
      expect(manifest.softBinding?.phash, action).toBe(print.phash);
    }
  }, 60_000);

  it("refuses a source type on anything but a created picture, rather than sign one it cannot see", async () => {
    const bytes = await makeImage(46);
    const print = await fingerprint(bytes);
    await expect(
      embedManifest(bytes, {
        title: "handed-over.jpg",
        claimGenerator: "moolam-studio/0.1.0",
        action: "c2pa.opened",
        digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture",
        softBinding: { phash: print.phash, blockhash: print.blockhash },
      }),
    ).rejects.toThrow(/source type/);
  });
});

describe("C2PA soft binding", () => {
  it("writes the fingerprint into the manifest and reads it back unchanged", async () => {
    const bytes = await makeImage(41);
    const print = await fingerprint(bytes);

    const signed = await embedManifest(bytes, {
      title: "moolam-test.jpg",
      claimGenerator: "moolam-verifier/0.1.0",
      action: "c2pa.created",
      softBinding: { phash: print.phash, blockhash: print.blockhash },
    });

    const manifest = await readManifest(signed);
    expect(manifest.present).toBe(true);
    expect(manifest.actions).toContain("c2pa.created");
    expect(manifest.softBinding?.alg).toBe(SOFT_BINDING_ALG);
    expect(manifest.softBinding?.phash).toBe(print.phash);
    expect(manifest.softBinding?.blockhash).toBe(print.blockhash);
  }, 60_000);

  it("reports no manifest and no soft binding on a plain image", async () => {
    const manifest = await readManifest(await makeImage(42));
    expect(manifest.present).toBe(false);
    expect(manifest.softBinding).toBeUndefined();
  });

  it("refuses a fingerprint that is the wrong size", async () => {
    const bytes = await makeImage(43);
    await expect(
      embedManifest(bytes, {
        title: "bad.jpg",
        claimGenerator: "moolam-verifier/0.1.0",
        action: "c2pa.created",
        softBinding: { phash: 1n, blockhash: "0xdeadbeef" },
      }),
    ).rejects.toThrow(/32 byte blockhash/);
  });
});

describe("signing identity", () => {
  it("refuses a certificate without its key, and a key without its certificate", () => {
    const certPath = path.join(DEV_CERT_DIR, "chain.cert.pem");
    const keyPath = path.join(DEV_CERT_DIR, "signer.key.pem");

    expect(() => loadSigner({ certPath })).toThrow(/go together/);
    expect(() => loadSigner({ keyPath })).toThrow(/go together/);
  });

  it("says which file is missing when both paths are set", () => {
    expect(() =>
      loadSigner({ certPath: path.join(DEV_CERT_DIR, "nothing.pem"), keyPath: path.join(DEV_CERT_DIR, "nowhere.pem") }),
    ).toThrow(/no signing certificate or key found/);
  });

  it("falls back to the development identity when neither path is set", () => {
    expect(loadSigner({})).toBeDefined();
  });

  it("marks a host with nothing to sign with as SignerUnavailable, and passes one that can sign", async () => {
    expect(() =>
      loadSigner({ certPath: path.join(DEV_CERT_DIR, "nothing.pem"), keyPath: path.join(DEV_CERT_DIR, "nowhere.pem") }),
    ).toThrow(SignerUnavailable);

    await expect(ensureSigner()).resolves.toBeUndefined();
  });
});
