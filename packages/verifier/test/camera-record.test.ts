// Covers a photo that arrives with its camera's own Content Credentials (Ram, 2026-09-26): the
// camera's location and serial never reach the signed file (item 1, which failed on the code
// before this order), the signed file holds Moolam's store only (2), the parent ingredient is the
// upload as it arrived and its reads never touch the network (3), every assertion and thumbnail
// that can hold a place or a serial is redacted in every manifest of the store (4), the signed
// file is read back and a record that fails is dropped with a log line (5), and what a kept and a
// dropped record look like (7). The answer's cameraRecord field (6) is in prepare.test.ts.
// Does NOT cover a real camera's files or signing certificate: the "camera" here is the
// development identity, and its record is built in test/cameraPhoto.ts. Nor a location stored
// under a key that names neither a place nor a serial, in a value the byte check cannot see as
// text, such as a CBOR number.

import { createServer } from "node:http";
import { Reader } from "@contentauth/c2pa-node";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { SignerRefusedFile, cameraRecordFault, cameraRecordOf, embedManifest, readManifest } from "../src/c2pa.js";
import { fingerprint } from "../src/fingerprint.js";
import { prepareOrFallback, prepareSealed } from "../src/prepare.js";
import { APP_LOCATION, CAMERA_SECRETS, DIGITAL_CAPTURE, cameraPhoto, editedByApp } from "./cameraPhoto.js";
import { makeImage } from "./helpers.js";
import { segment, segmentsBeforeScan, withSegments } from "./jpegParts.js";

type ManifestStore = ReturnType<Reader["json"]>;
type Manifest = NonNullable<ReturnType<Reader["getActive"]>>;

const SETTINGS = { title: "Harbour", claimGenerator: "moolam-studio/0.1.0", action: "c2pa.opened" as const };

function leaked(bytes: Buffer): string[] {
  return Object.values(CAMERA_SECRETS).filter((secret) => bytes.includes(Buffer.from(secret, "utf8")));
}

describe("item 1: the camera's location and serial", () => {
  it("are in the upload, and never reach the signed file, public or sealed", async () => {
    const upload = await cameraPhoto(81);
    expect(leaked(upload)).toEqual(Object.values(CAMERA_SECRETS));

    const published = await prepareOrFallback(upload, SETTINGS);
    const sealed = await prepareSealed(upload, SETTINGS);

    expect(published.embedded).toBe(true);
    expect(sealed.embedded).toBe(true);
    expect(leaked(published.bytes)).toEqual([]);
    expect(leaked(sealed.bytes)).toEqual([]);
    expect(published.cameraRecord).toBe("kept");
    expect(sealed.cameraRecord).toBe("kept");
  }, 60_000);
});

describe("a phone's computational capture", () => {
  it("is kept as the camera's own record, as a plain digital capture is", async () => {
    const upload = await cameraPhoto(96, {
      sourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/computationalCapture",
    });
    const prepared = await prepareOrFallback(upload, SETTINGS);
    expect(prepared.embedded).toBe(true);
    expect(prepared.cameraRecord).toBe("kept");
    expect(leaked(prepared.bytes)).toEqual([]);
  }, 60_000);
});

describe("item 2: the signed file holds one C2PA store, Moolam's", () => {
  it("carries none of the upload's APP11 segments", async () => {
    const upload = await cameraPhoto(83);
    const theirs = segmentsBeforeScan(upload, 0xeb);
    expect(theirs.length).toBeGreaterThan(0);

    const signed = (await prepareOrFallback(upload, SETTINGS)).bytes;

    const ours = segmentsBeforeScan(signed, 0xeb);
    for (const one of theirs) {
      expect(ours.some((mine) => mine.equals(one))).toBe(false);
    }
    expect(new Set(ours.map((mine) => mine.readUInt16BE(2))).size).toBe(1);
    expect((await readManifest(signed)).claimGenerator).toBe(SETTINGS.claimGenerator);
  }, 60_000);
});

describe("item 3: the parent ingredient is the upload as it arrived", () => {
  it("lists exactly one parent, the camera's manifest, whose hard binding matches the bytes the camera signed", async () => {
    const upload = await cameraPhoto(84);
    const camera = (await storeOf(upload)).active_manifest;

    const signed = (await prepareOrFallback(upload, SETTINGS)).bytes;

    const ingredients = activeOf(await storeOf(signed)).ingredients ?? [];
    expect(ingredients).toHaveLength(1);
    const [parent] = ingredients;
    expect(parent?.relationship).toBe("parentOf");
    expect(parent?.active_manifest).toBe(camera);
    const results = parent?.validation_results?.activeManifest;
    expect(results?.success.map((one) => one.code)).toContain("assertion.dataHash.match");
    expect(results?.failure.map((one) => one.code).filter((code) => /mismatch/.test(code))).toEqual([]);
  }, 60_000);

  it("signs an upload with no store exactly as before: one manifest, one plain parent, no camera record", async () => {
    const prepared = await prepareOrFallback(await makeImage(85), SETTINGS);

    const store = await storeOf(prepared.bytes);
    const active = activeOf(store);
    expect(Object.keys(store.manifests ?? {})).toHaveLength(1);
    expect(active.assertions?.map((one) => one.label)).toEqual(["c2pa.soft-binding", "c2pa.actions.v2"]);
    expect(actionsOf(active).map((one) => one.action)).toEqual(["c2pa.opened"]);
    expect(active.ingredients?.map((one) => [one.relationship, one.active_manifest ?? null])).toEqual([["parentOf", null]]);
    expect(active.thumbnail?.format).toBe("image/jpeg");
    expect(prepared.cameraRecord).toBeUndefined();
  }, 60_000);

  it("never requests the remote manifest an ingredient's XMP names", async () => {
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
    const pointing = await sharp(await makeImage(86)).withXmp(xmp).jpeg().toBuffer();
    const print = await fingerprint(pointing);

    try {
      const signed = await embedManifest(await makeImage(86), {
        ...SETTINGS,
        softBinding: { phash: print.phash, blockhash: print.blockhash },
        parent: { bytes: pointing, redactions: [] },
      });
      const prepared = await prepareOrFallback(pointing, SETTINGS);

      expect((await readManifest(signed)).validation).toBe("valid");
      expect(prepared.embedded).toBe(true);
      expect(prepared.cameraRecord).toBeUndefined();
      expect(hits).toEqual([]);
    } finally {
      server.close();
    }
  }, 60_000);
});

describe("item 4: every place a location or a serial can sit is redacted", () => {
  it("redacts the camera's EXIF and any assertion with a place or serial key, and keeps its actions and the rest", async () => {
    const upload = await cameraPhoto(87, {
      extra: [
        { label: "com.example.where", data: { spot: { geoPoint: "Marina-Lighthouse-Gate" } } },
        { label: "com.example.lens", data: { focalLength: 35, aperture: "f/2.8" } },
      ],
    });
    const camera = (await storeOf(upload)).active_manifest as string;

    const plan = await cameraRecordOf(upload);
    expect(plan).toEqual({
      kind: "store",
      redactions: [
        `self#jumbf=/c2pa/${camera}/c2pa.assertions/stds.exif`,
        `self#jumbf=/c2pa/${camera}/c2pa.assertions/com.example.where`,
      ],
      secrets: expect.arrayContaining([...Object.values(CAMERA_SECRETS), "Marina-Lighthouse-Gate"]),
      capture: true,
    });

    const signed = (await prepareOrFallback(upload, SETTINGS)).bytes;

    const kept = (await storeOf(signed)).manifests?.[camera];
    expect(kept?.assertions?.map((one) => one.label)).toEqual(["c2pa.actions.v2", "com.example.lens"]);
    expect(actionsOf(kept as Manifest)).toEqual([{ action: "c2pa.created", digitalSourceType: DIGITAL_CAPTURE }]);
    expect(signed.includes(Buffer.from("Marina-Lighthouse-Gate"))).toBe(false);
  }, 60_000);

  it("redacts in every manifest of the upload's store, the editing app's as well as the camera's", async () => {
    const upload = await editedByApp(await cameraPhoto(88));
    const store = await storeOf(upload);
    expect(Object.keys(store.manifests ?? {})).toHaveLength(2);

    const signed = (await prepareOrFallback(upload, SETTINGS)).bytes;

    const after = (await storeOf(signed)).manifests ?? {};
    for (const label of Object.keys(store.manifests ?? {})) {
      const labels = after[label]?.assertions?.map((one) => one.label) ?? [];
      expect(labels, label).not.toContain("stds.exif");
      expect(labels, label).not.toContain("stds.iptc");
      expect(labels.some((one) => one.startsWith("c2pa.actions")), label).toBe(true);
    }
    expect(leaked(signed)).toEqual([]);
    expect(signed.includes(Buffer.from(APP_LOCATION))).toBe(false);
  }, 60_000);

  it("redacts a thumbnail in the record that carries the camera's EXIF", async () => {
    const upload = await cameraPhoto(89, { exifThumbnail: true });
    const camera = (await storeOf(upload)).active_manifest as string;
    expect(activeOf(await storeOf(upload)).thumbnail?.format).toBe("image/jpeg");

    const plan = await cameraRecordOf(upload);
    expect(plan.kind === "store" && plan.redactions).toContain(`self#jumbf=/c2pa/${camera}/c2pa.assertions/c2pa.thumbnail.claim`);

    const prepared = await prepareOrFallback(upload, SETTINGS);

    const after = await storeOf(prepared.bytes);
    expect(after.manifests?.[camera]?.thumbnail).toBeUndefined();
    expect(prepared.cameraRecord).toBe("kept");
    expect(leaked(prepared.bytes)).toEqual([]);
  }, 60_000);
});

describe("item 5: the signed file is read back before it is returned", () => {
  it("finds nothing wrong with a kept record, and names the value check when a secret survives", async () => {
    const upload = await cameraPhoto(90);
    const plan = await cameraRecordOf(upload);
    const prepared = await prepareOrFallback(upload, SETTINGS);
    expect(plan.kind).toBe("store");
    const secrets = plan.kind === "store" ? plan.secrets : [];

    expect(prepared.cameraRecord).toBe("kept");
    expect(await cameraRecordFault(prepared.bytes, secrets)).toBeUndefined();
    expect(await cameraRecordFault(prepared.bytes, [...secrets, "Harbour"])).toMatch(/still in the signed bytes/);
    expect(await cameraRecordFault(await makeImage(90), [])).toBe("the signed file carries no manifest");
  }, 60_000);

  it("drops a record whose hard binding no longer matches the upload, logs why, and signs it plain", async () => {
    // A comment inserted after the camera signed moves every byte its hash covers.
    const upload = withSegments(await cameraPhoto(91), [segment(0xfe, Buffer.from("touched after capture"))]);
    const warnings: { details: Record<string, unknown>; message: string }[] = [];
    const log = { warn: (details: Record<string, unknown>, message: string) => warnings.push({ details, message }) };

    const prepared = await prepareOrFallback(upload, { ...SETTINGS, log });

    expect(prepared.embedded).toBe(true);
    expect(prepared.cameraRecord).toBe("dropped");
    expect(warnings.map((one) => one.message)).toEqual(["prepare: camera record dropped"]);
    expect(String(warnings[0]?.details.reason)).toMatch(/mismatch/);
    const store = await storeOf(prepared.bytes);
    expect(Object.keys(store.manifests ?? {})).toHaveLength(1);
    expect(activeOf(store).ingredients?.map((one) => one.active_manifest ?? null)).toEqual([null]);
    expect((await readManifest(prepared.bytes)).validation).toBe("valid");
    expect(leaked(prepared.bytes)).toEqual([]);
  }, 60_000);

  it("refuses to sign when a redaction names what the standard never lets go, so the caller drops the record", async () => {
    const upload = await cameraPhoto(92);
    const camera = (await storeOf(upload)).active_manifest as string;
    const print = await fingerprint(upload);

    await expect(
      embedManifest(await makeImage(92), {
        ...SETTINGS,
        softBinding: { phash: print.phash, blockhash: print.blockhash },
        parent: { bytes: upload, redactions: [`self#jumbf=/c2pa/${camera}/c2pa.assertions/c2pa.actions.v2`] },
      }),
    ).rejects.toThrow(SignerRefusedFile);
  }, 60_000);
});

describe("item 7: what a kept record and a dropped one look like", () => {
  it("keeps the camera's c2pa.created action, with one c2pa.redacted action per redacted assertion", async () => {
    const upload = await cameraPhoto(94, {
      exifThumbnail: true,
      extra: [{ label: "com.example.where", data: { spot: { geoPoint: "Marina-Lighthouse-Gate" } } }],
    });
    const camera = (await storeOf(upload)).active_manifest as string;
    const plan = await cameraRecordOf(upload);
    expect(plan.kind === "store" && plan.redactions).toHaveLength(3);

    const prepared = await prepareOrFallback(upload, SETTINGS);

    expect(prepared.cameraRecord).toBe("kept");
    const store = await storeOf(prepared.bytes);
    expect(actionsOf(store.manifests?.[camera] as Manifest).map((one) => [one.action, one.digitalSourceType])).toEqual([
      ["c2pa.created", DIGITAL_CAPTURE],
    ]);
    const redacted = actionsOf(activeOf(store)).filter((one) => one.action === "c2pa.redacted");
    expect(redacted.map((one) => one.parameters?.redacted).sort()).toEqual([...(plan.kind === "store" ? plan.redactions : [])].sort());
    expect(redacted.every((one) => one.reason === "c2pa.PII.present")).toBe(true);
  }, 60_000);

  it("drops a record that writes its GPS into an action, which can never be redacted, and logs why", async () => {
    const upload = await cameraPhoto(95, { gpsInAction: true });
    const warnings: { details: Record<string, unknown>; message: string }[] = [];
    const log = { warn: (details: Record<string, unknown>, message: string) => warnings.push({ details, message }) };

    const prepared = await prepareOrFallback(upload, { ...SETTINGS, log });
    const sealed = await prepareSealed(upload, { ...SETTINGS, log });

    for (const result of [prepared, sealed]) {
      expect(result.embedded).toBe(true);
      expect(result.cameraRecord).toBe("dropped");
      expect(leaked(result.bytes)).toEqual([]);
      expect(Object.keys((await storeOf(result.bytes)).manifests ?? {})).toHaveLength(1);
    }
    expect(warnings).toEqual([
      {
        details: { reason: "a location or serial value from the upload's record is still in the signed bytes" },
        message: "prepare: camera record dropped",
      },
      {
        details: { reason: "a location or serial value from the upload's record is still in the signed bytes" },
        message: "prepare: camera record dropped",
      },
    ]);
  }, 60_000);
});

describe("WO-317: a place or serial written as a number where nothing can be redacted", () => {
  // The byte check after signing looks for the record's place and serial as text, so a CBOR number
  // under a GPS key passed it, was kept inside the actions, and was pinned publicly. These failed
  // on the code before this order: the plan was "store" and the record was kept. The reader shows
  // a list of numbers as an empty string or as base64, so the list shapes are the ones a check on
  // the reader's numbers alone would still miss.
  const shapes: [string, Record<string, unknown>][] = [
    ["a GPS reading", { "exif:GPSLatitude": 12.9716 }],
    ["a position as a list", { geoPoint: [12.9716, 77.5946] }],
    ["a position as a list of whole numbers", { geoPoint: [12, 58] }],
    ["a unit's serial", { "vendor:LensSerial": 48392011 }],
    ["a position under a nested key", { shot: { gps: { lat: 12.9716, lon: 77.5946 } } }],
  ];

  for (const [index, [name, actionParameters]] of shapes.entries()) {
    it(`drops the record for ${name} in the c2pa.created action`, async () => {
      const plan = await cameraRecordOf(await cameraPhoto(120 + index, { actionParameters }));
      expect(plan.kind).toBe("unusable");
      expect(plan.kind === "unusable" && plan.why).toMatch(/cannot be redacted/);
    }, 60_000);
  }

  it("signs the picture plain, public and sealed, and says why in the log", async () => {
    const upload = await cameraPhoto(125, { actionParameters: { "exif:GPSLatitude": 12.9716 } });
    const warnings: { details: Record<string, unknown>; message: string }[] = [];
    const log = { warn: (details: Record<string, unknown>, message: string) => warnings.push({ details, message }) };

    for (const result of [await prepareOrFallback(upload, { ...SETTINGS, log }), await prepareSealed(upload, { ...SETTINGS, log })]) {
      expect(result.embedded).toBe(true);
      expect(result.cameraRecord).toBe("dropped");
      expect(Object.keys((await storeOf(result.bytes)).manifests ?? {})).toHaveLength(1);
    }
    expect(warnings.map((one) => one.message)).toEqual(["prepare: camera record dropped", "prepare: camera record dropped"]);
    expect(String(warnings[0]?.details.reason)).toMatch(/cannot be redacted/);
  }, 60_000);

  it("keeps a record whose action holds numbers under keys that name no place or serial", async () => {
    const plan = await cameraRecordOf(await cameraPhoto(126, { actionParameters: { "exif:ExposureTime": 0.008, "exif:ISOSpeedRatings": 200 } }));
    expect(plan.kind).toBe("store");
  }, 60_000);

  it("keeps a record whose number sits in an assertion that is redacted whole", async () => {
    const upload = await cameraPhoto(127, { extra: [{ label: "com.example.where", data: { geoPoint: [12.9716, 77.5946] } }] });
    const plan = await cameraRecordOf(upload);
    expect(plan.kind === "store" && plan.redactions).toHaveLength(2);

    const prepared = await prepareOrFallback(upload, SETTINGS);
    expect(prepared.cameraRecord).toBe("kept");
    expect(await readManifest(prepared.bytes)).toMatchObject({ validation: "valid" });
  }, 60_000);
});

async function storeOf(bytes: Buffer): Promise<ManifestStore> {
  const reader = await Reader.fromAsset({ buffer: bytes, mimeType: "image/jpeg" });
  if (reader === null) {
    throw new Error("this file carries no C2PA store");
  }
  return reader.json();
}

function activeOf(store: ManifestStore): Manifest {
  const active = store.active_manifest == null ? undefined : store.manifests?.[store.active_manifest];
  if (active === undefined) {
    throw new Error("this store has no active manifest");
  }
  return active;
}

function actionsOf(
  manifest: Manifest,
): { action: string; digitalSourceType?: string; parameters?: Record<string, unknown>; reason?: string }[] {
  return (manifest.assertions ?? [])
    .filter((one) => one.label.startsWith("c2pa.actions"))
    .flatMap((one) => (one.data as { actions: { action: string }[] }).actions);
}
