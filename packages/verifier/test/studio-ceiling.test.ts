// Covers review pass 8, V69: /prepare, /edit and /unseal count their multipart body against the
// upload ceiling as it arrives, as /verify does. The moment a body would pass the ceiling each
// answers 503 busy, and what a body counted while it arrived comes back once the route's handler
// has finished. Over real connections on this machine, because only a real socket can withhold a body.
// Also the studio's turn at the gate (WO-185a follow-ups): one caller holds one studio turn at a
// time while another caller's /prepare runs, and a caller who hangs up while its /prepare waits
// for a turn keeps its share counted until that work lets go of the bytes.
// Does NOT cover what each route does with an upload it read (test/prepare.test.ts,
// test/edit.test.ts and test/unseal.test.ts do), nor Privy, Pinata or the chain: the token is
// signed here, the signer check is stubbed, and the two /prepare bodies that get past the reader
// meet a fetch that refuses every call, so nothing leaves this machine. The turn and the hang-up
// are shown on /prepare; /edit and /unseal reach the gate through the same studioTurn call.

import { request as httpRequest, type ClientRequest } from "node:http";
import { SignJWT, generateKeyPair } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000009";
  process.env.PRIVY_APP_ID = id;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.PRIVY_EDIT_SIGNER_ID = "moolamtesteditsigner09";
  process.env.PRIVY_EDIT_POLICY_ID = "moolamtesteditpolicy09";
  // Long enough for a test to hang up on a request waiting at the gate, short enough to wait out.
  process.env.MATCH_WAIT_MS = "4000";
  return id;
});

vi.mock("../src/c2pa.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/c2pa.js")>()),
  ensureSigner: async () => undefined,
}));

vi.mock("../src/generate/privy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/privy.js")>()),
  privy: () => ({}),
  ownerContext: () => ({}),
}));

const { UPLOAD_CEILING_BYTES, heldUploads } = await import("../src/routes/shared.js");
const { rateLimitKey } = await import("../src/limits/addressKey.js");
const { buildServer } = await import("../src/server.js");
const { makeImage, multipartBody } = await import("./helpers.js");

const ROUTES = ["/prepare", "/edit", "/unseal"] as const;

let app: FastifyInstance;
let port: number;
let picture: Buffer;
let bearer: string;

interface Answer {
  status: number;
  body: string;
}

/** Opens a POST on `path` with a good token and writes only `first` of the body. */
function open(path: string, headers: Record<string, string | number>, first: Buffer): { request: ClientRequest; answer: Promise<Answer> } {
  let request: ClientRequest | undefined;
  const answer = new Promise<Answer>((resolve, reject) => {
    request = httpRequest(
      { host: "127.0.0.1", port, method: "POST", path, headers: { ...headers, authorization: `Bearer ${bearer}` } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    request.on("error", reject);
    request.flushHeaders();
    request.write(first);
  });
  answer.catch(() => undefined);
  return { request: request as unknown as ClientRequest, answer };
}

/** A /prepare body with a title, the one kind the studio takes, and `bytes` as the file. */
function studioBody(bytes: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----moolamstudio";
  const lines = (...parts: string[]): Buffer => Buffer.from(parts.join(String.fromCharCode(13, 10)));
  const field = (name: string, value: string): Buffer =>
    lines(`--${boundary}`, `Content-Disposition: form-data; name="${name}"`, "", value, "");
  return {
    payload: Buffer.concat([
      field("title", "Harbour"),
      field("kind", "human"),
      lines(
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="harbour.jpg"',
        "Content-Type: image/jpeg",
        "",
        "",
      ),
      bytes,
      lines("", `--${boundary}--`, ""),
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

/** Holds `count` turns at the gate in `lane` until the returned function is called. */
function holdTurns(lane: "verify" | "studio", count: number, caller?: string): () => Promise<void> {
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = lane === "verify" ? app.verifier.runVerify.bind(app.verifier) : app.verifier.runPrepare.bind(app.verifier);
  const held = Array.from({ length: count }, () => run(() => blocked, caller));
  return async () => {
    release();
    await Promise.all(held);
  };
}

async function within<T>(pending: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    pending,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`nothing within ${ms} ms`)), ms)),
  ]);
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) {
      throw new Error(`still not true after ${ms} ms, ${heldUploads.held} bytes held`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  bearer = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("privy.io")
    .setAudience(APP_ID)
    .setSubject("did:privy:studio-ceiling")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(pair.privateKey);
  picture = await makeImage(91);
  const keys = { keys: pair.publicKey };
  app = await buildServer({ source: { load: async () => [] }, logger: false, prepare: keys, edit: keys, unseal: keys });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
}, 60_000);

afterEach(async () => {
  heldUploads.limit = UPLOAD_CEILING_BYTES;
  await until(() => heldUploads.held === 0);
});

afterAll(async () => {
  await app.close();
});

describe("V69: the studio routes under the upload ceiling", () => {
  it.each(ROUTES)("%s answers 503 busy the moment its body would pass the ceiling", async (path) => {
    heldUploads.limit = 1_000;
    const { payload, headers } = multipartBody("file", "big.jpg", "image/jpeg", Buffer.alloc(5_000, 1));
    const { request, answer } = open(path, { ...headers, "content-length": payload.length }, payload.subarray(0, 2_000));

    const refused = await within(answer, 3_000);
    request.destroy();

    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toEqual({ error: "busy" });
    expect(heldUploads.held).toBe(0);
  });

  it.each(ROUTES)("%s holds its share while the body arrives and gives it back after answering", async (path) => {
    // No title and no passport id, so each route answers 400 once the whole body is read.
    const { payload, headers } = multipartBody("file", "harbour.jpg", "image/jpeg", picture);
    const { request, answer } = open(path, { ...headers, "content-length": payload.length }, payload.subarray(0, 100));
    await until(() => heldUploads.held === 100);

    request.end(payload.subarray(100));

    expect((await within(answer, 10_000)).status).toBe(400);
    await until(() => heldUploads.held === 0);
  }, 30_000);
});

describe("the studio's turn at the gate (WO-185a follow-ups)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("makes a caller's /prepare wait behind its own studio turn while another caller's runs", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("this test reaches no network");
    });
    const letGo = holdTurns("studio", 1, rateLimitKey("203.0.113.40"));
    try {
      const { payload, headers } = studioBody(picture);
      const call = (remoteAddress: string) =>
        app.inject({
          method: "POST",
          url: "/prepare",
          payload,
          headers: { ...headers, authorization: `Bearer ${bearer}` },
          remoteAddress,
        });
      const [same, other] = await Promise.all([call("203.0.113.40"), call("203.0.113.41")]);

      expect(same.statusCode).toBe(503);
      expect(same.json()).toEqual({ error: "busy" });
      // The other caller's picture was signed and only then met the refusing fetch at the pin.
      expect(other.statusCode).toBe(502);
      expect(other.json()).toEqual({ error: "pin-failed" });
    } finally {
      await letGo();
    }
  }, 60_000);

  it("keeps a hung-up /prepare's share counted until its work at the gate lets go of the bytes", async () => {
    // The route carries on after its caller left, so the test waits for its pins to be refused
    // before the real fetch comes back.
    let pins = 0;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
      if (String(input instanceof Request ? input.url : input).includes("pinata.cloud")) {
        pins += 1;
      }
      throw new Error("this test reaches no network");
    });
    const letVerifiesGo = holdTurns("verify", 2);
    const letStudioGo = holdTurns("studio", 1);
    let released = false;
    const letGo = async (): Promise<void> => {
      if (!released) {
        released = true;
        await Promise.all([letVerifiesGo(), letStudioGo()]);
      }
    };
    try {
      const { payload, headers } = studioBody(picture);
      const { request } = open("/prepare", { ...headers, "content-length": payload.length }, payload);
      request.end();
      // Trimmed to the file once the body is in, then the route reaches the full gate and waits.
      await until(() => heldUploads.held === picture.length);
      await new Promise((resolve) => setTimeout(resolve, 500));

      request.destroy();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(heldUploads.held).toBe(picture.length);

      await letGo();
      await until(() => heldUploads.held === 0, 30_000);
    } finally {
      await letGo();
      // Waited for even when an expectation above failed, so the refusing fetch is still in place
      // when the route reaches its pins. A route that gave up busy never pins, and is not waited on.
      await until(() => pins >= 2, 15_000).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }, 60_000);
});
