// Covers a WO-186b follow-up on photos that arrive with a camera's own record: when the read back of
// the file signed with that record runs out of time, the fault is this service's, so preparing
// throws ReadBackFault (a FingerprintFault, which every studio route answers 503 service-fault)
// rather than dropping the camera's record for good. A record that truly fails its checks is still
// dropped: test/camera-record.test.ts item 5 drives that path, and it is run once more here.
// Review pass 11, V111: the three other reads on that path that can give up, the read of the upload's
// own store, the signing worker's read of it as the parent, and the read of a thumbnail in the
// signed store, answer /prepare 503 service-fault too, and nothing is pinned, signed plain or not.
// The slow reads are a stubbed Reader.fromAsset or resourceToAsset that never answer, so each of
// those waits out the real five second limit. The worker's slow read is stood in for by
// embedManifest throwing the fault the worker's "slow" answer becomes; the worker's own answer is
// in signing-worker.test.ts. Does NOT cover a real slow C2PA read, a real pin or a real chain read.

import { SignJWT, generateKeyPair } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000188";
  process.env.PRIVY_APP_ID = id;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  return id;
});

/**
 * Which read should never answer: `on` the read back of a file Moolam signed, `upload` the read of
 * a camera's photo as it arrived, `thumbnail` a thumbnail read out of a file Moolam signed, and
 * `ingredient` the signing worker's read of the parent.
 */
const slow = vi.hoisted(() => ({ on: false, upload: false, thumbnail: false, ingredient: false }));

const stubs = vi.hoisted(() => ({ passportExists: vi.fn() }));

vi.mock("@contentauth/c2pa-node", async (importOriginal) => {
  const real = await importOriginal<typeof import("@contentauth/c2pa-node")>();
  const never = () => new Promise<never>(() => undefined);
  const fromAsset: typeof real.Reader.fromAsset = async (asset, settings) => {
    const bytes = (asset as { buffer?: Buffer }).buffer;
    const signed = bytes !== undefined && bytes.includes(Buffer.from("moolam-studio", "utf8"));
    const camera = bytes !== undefined && bytes.includes(Buffer.from("moolam-test-camera", "utf8"));
    if ((slow.on && signed) || (slow.upload && camera && !signed)) {
      return await never();
    }
    const reader = await real.Reader.fromAsset(asset, settings);
    if (slow.thumbnail && signed && reader !== null) {
      reader.resourceToAsset = never;
    }
    return reader;
  };
  return { ...real, Reader: Object.assign(Object.create(real.Reader) as typeof real.Reader, { fromAsset }) };
});

vi.mock("../src/c2pa.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/c2pa.js")>();
  const { FingerprintFault } = await import("../src/fingerprint.js");
  return {
    ...real,
    ensureSigner: async () => undefined,
    embedManifest: async (bytes: Buffer, opts: Parameters<typeof real.embedManifest>[1]) => {
      if (slow.ingredient && opts.parent !== undefined) {
        throw new FingerprintFault(`the C2PA read of the parent was still running after ${real.READ_MANIFEST_TIMEOUT_MS} ms`);
      }
      return await real.embedManifest(bytes, opts);
    },
  };
});

vi.mock("../src/edit/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/registry.js")>()),
  passportExists: stubs.passportExists,
}));

const { READ_MANIFEST_TIMEOUT_MS, cameraRecordFault } = await import("../src/c2pa.js");
const { FingerprintFault } = await import("../src/fingerprint.js");
const { ReadBackFault, prepareOrFallback, prepareSealed } = await import("../src/prepare.js");
const { buildServer } = await import("../src/server.js");
const { contentIdOf } = await import("../src/ipfs/pinata.js");
const { SERVICE_FAULT_REASON } = await import("../src/routes/shared.js");
const { cameraPhoto } = await import("./cameraPhoto.js");
const { segment, withSegments } = await import("./jpegParts.js");

const SETTINGS = { title: "Harbour", claimGenerator: "moolam-studio/0.1.0", action: "c2pa.opened" as const };

describe("a camera record whose read back runs out of time", () => {
  it("makes cameraRecordFault throw FingerprintFault instead of naming a fault in the record", async () => {
    const kept = await prepareOrFallback(await cameraPhoto(161), SETTINGS);
    expect(kept.cameraRecord).toBe("kept");

    slow.on = true;
    try {
      const started = Date.now();
      await expect(cameraRecordFault(kept.bytes, [])).rejects.toBeInstanceOf(FingerprintFault);
      expect(Date.now() - started).toBeGreaterThanOrEqual(READ_MANIFEST_TIMEOUT_MS - 50);
    } finally {
      slow.on = false;
    }
  }, 30_000);

  it("fails the preparation with ReadBackFault, public and sealed, rather than dropping the record", async () => {
    const upload = await cameraPhoto(162);
    const dropped: string[] = [];
    const log = { warn: (_details: Record<string, unknown>, message: string) => dropped.push(message) };

    slow.on = true;
    try {
      await expect(prepareOrFallback(upload, { ...SETTINGS, log })).rejects.toBeInstanceOf(ReadBackFault);
      await expect(prepareSealed(upload, { ...SETTINGS, log })).rejects.toBeInstanceOf(ReadBackFault);
    } finally {
      slow.on = false;
    }
    expect(dropped).toEqual([]);
  }, 60_000);

  it("still drops a record that truly fails its checks, and signs the picture plain", async () => {
    const touched = withSegments(await cameraPhoto(163), [segment(0xfe, Buffer.from("touched after capture"))]);

    const prepared = await prepareOrFallback(touched, SETTINGS);

    expect(prepared.embedded).toBe(true);
    expect(prepared.cameraRecord).toBe("dropped");
  }, 60_000);
});

describe("V111: every read on a camera record's path that gives up", () => {
  const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
  let app: FastifyInstance;
  let signing: CryptoKey;
  let pins = 0;

  async function token(): Promise<string> {
    return await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer("privy.io")
      .setAudience(APP_ID)
      .setSubject("did:privy:slow-camera")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(signing);
  }

  async function prepare(picture: Buffer, sealed: boolean) {
    const boundary = "----moolamslowcamera";
    const fields = { title: "Harbour at first light", kind: "human", sealed: String(sealed) };
    const parts: Buffer[] = [];
    for (const [name, value] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="camera.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      picture,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    );
    return await app.inject({
      method: "POST",
      url: "/prepare",
      payload: Buffer.concat(parts),
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${await token()}` },
      remoteAddress: "203.0.113.188",
    });
  }

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    stubs.passportExists.mockResolvedValue(false);
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== UPLOAD_URL) {
        throw new Error(`no network in this test: ${url}`);
      }
      pins += 1;
      const bytes = Buffer.from(await ((init?.body as FormData).get("file") as File).arrayBuffer());
      return new Response(JSON.stringify({ data: { cid: contentIdOf(bytes), size: bytes.length, network: "public" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    app = await buildServer({ source: { load: async () => [] }, logger: false, prepare: { keys: pair.publicKey } });
    await app.ready();
  }, 60_000);

  beforeEach(() => {
    Object.assign(slow, { on: false, upload: false, thumbnail: false, ingredient: false });
    pins = 0;
  });

  afterAll(async () => {
    Object.assign(slow, { on: false, upload: false, thumbnail: false, ingredient: false });
    vi.unstubAllGlobals();
    await app.close();
  });

  const cases = [
    ["the read of the upload's own store", "upload", false],
    ["the signing worker's read of the upload as the parent", "ingredient", true],
    ["a thumbnail read out of the signed store", "thumbnail", false],
  ] as const;

  for (const [name, which, sealed] of cases) {
    it(`answers 503 service-fault when ${name} gives up, and pins or hands back nothing`, async () => {
      const upload = await cameraPhoto(170 + cases.findIndex((one) => one[1] === which));
      const warnings: string[] = [];
      const log = { warn: (_details: Record<string, unknown>, message: string) => warnings.push(message) };

      slow[which] = true;
      const refused = await prepare(upload, sealed);
      await expect(prepareOrFallback(upload, { ...SETTINGS, log })).rejects.toBeInstanceOf(FingerprintFault);
      slow[which] = false;

      expect(refused.statusCode).toBe(503);
      expect(refused.json()).toEqual({ error: "service-fault", reason: SERVICE_FAULT_REASON });
      expect(refused.body).not.toContain("signedFile");
      expect(pins).toBe(0);
      expect(warnings).toEqual([]);

      const retried = await prepare(upload, sealed);
      expect(retried.statusCode).toBe(200);
      expect(retried.json().manifest).toEqual({ embedded: true, cameraRecord: "kept" });
    }, 60_000);
  }
});
