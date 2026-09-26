// Covers review pass 8, V69: /prepare, /edit and /unseal take their share of the upload ceiling
// before their multipart body is read, as /verify does. Past the ceiling each answers 503 busy
// with its body never read, and a share taken while the body arrives comes back once the route has
// answered. Over real connections on this machine, because only a real socket can withhold a body.
// Does NOT cover what each route does with an upload it read (test/prepare.test.ts,
// test/edit.test.ts and test/unseal.test.ts do), nor Privy, Pinata or the chain: the token is
// signed here, the signer check is stubbed, and every body here stops at the reader.

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
  it.each(ROUTES)("%s answers 503 busy past the ceiling before a byte of its body is read", async (path) => {
    heldUploads.limit = 1_000;
    const { payload, headers } = multipartBody("file", "big.jpg", "image/jpeg", Buffer.alloc(5_000, 1));
    const { request, answer } = open(path, { ...headers, "content-length": payload.length }, payload.subarray(0, 60));

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
    await until(() => heldUploads.held === payload.length);

    request.end(payload.subarray(100));

    expect((await within(answer, 10_000)).status).toBe(400);
    await until(() => heldUploads.held === 0);
  }, 30_000);
});
