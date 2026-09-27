// Covers review pass 10, V97: a decoder running out of memory while prepare.ts makes the upright copy
// is this service's fault, so /prepare answers 503 service-fault and hands back no unsigned picture,
// even when the fallback's second try would have worked. sharp is wrapped so that the next baseline
// re-encode at quality 95, which only the upright copy makes, fails once with libjpeg's own words;
// every other call is the real library. Does NOT cover isProgressive or makeThumbnail meeting the
// same fault, which take the same classification, nor a real out-of-memory from libvips.

import { SignJWT, generateKeyPair } from "jose";
import { getAddress } from "viem";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeImage } from "./helpers.js";

const SETTINGS = vi.hoisted(() => {
  const settings = { appId: "moolamtestapp0000197" };
  process.env.PRIVY_APP_ID = settings.appId;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.GLOBAL_PREPARES_PER_DAY = "50";
  process.env.EXPECT_ROUTES = "";
  process.env.X402_ENABLED = "false";
  return settings;
});

const fault = vi.hoisted(() => ({ armed: false, thrown: 0 }));
const stubs = vi.hoisted(() => ({ passportExists: vi.fn() }));

vi.mock("sharp", async (importOriginal) => {
  const real = (await importOriginal<{ default: (typeof import("sharp"))["default"] }>()).default;
  const wrapped = ((...args: Parameters<typeof real>) => {
    const pipeline = real(...args);
    const jpeg = pipeline.jpeg.bind(pipeline);
    pipeline.jpeg = (options?: import("sharp").JpegOptions) => {
      const next = jpeg(options);
      if (fault.armed && options?.quality === 95 && options.progressive === false) {
        fault.armed = false;
        fault.thrown += 1;
        next.toBuffer = (async () => {
          throw new Error("VipsJpeg: Insufficient memory");
        }) as unknown as typeof next.toBuffer;
      }
      return next;
    };
    return pipeline;
  }) as typeof real;
  Object.assign(wrapped, real);
  return { default: wrapped };
});

vi.mock("../src/edit/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/registry.js")>()),
  passportExists: stubs.passportExists,
}));

const { buildServer } = await import("../src/server.js");
const { contentIdOf } = await import("../src/ipfs/pinata.js");
const { SERVICE_FAULT_REASON } = await import("../src/routes/shared.js");

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";

let pins = 0;
let signing: CryptoKey;
let app: FastifyInstance;
let picture: Buffer;

async function token(subject: string): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("privy.io")
    .setAudience(SETTINGS.appId)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signing);
}

async function prepareUpload(user: string) {
  const boundary = "----moolamupright";
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries({ title: "Harbour at first light", kind: "human", sealed: "false" })) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="picture.png"\r\nContent-Type: image/png\r\n\r\n`),
    picture,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return await app.inject({
    method: "POST",
    url: "/prepare",
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${await token(user)}` },
    remoteAddress: "203.0.113.97",
  });
}

describe("V97: a memory fault while making the upright copy", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    // A PNG is always re-encoded into the upright baseline JPEG, so the upright copy meets sharp.
    picture = await makeImage(197, "png");
    stubs.passportExists.mockResolvedValue(false);

    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== UPLOAD_URL) {
        return await realFetch(input, init);
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

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it("answers /prepare 503 service-fault, not an unsigned 200, and pins nothing", async () => {
    fault.armed = true;
    const response = await prepareUpload("did:privy:upright-memory");

    expect(fault.thrown).toBe(1);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "service-fault", reason: SERVICE_FAULT_REASON });
    expect(pins).toBe(0);
  }, 60_000);

  it("prepares the same picture signed once the fault has passed", async () => {
    const response = await prepareUpload("did:privy:upright-memory-after");

    expect(response.statusCode).toBe(200);
    expect(response.json().manifest.embedded).toBe(true);
  }, 60_000);
});
