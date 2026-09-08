// Covers POST /prepare with Pinata answered by a stub at the fetch layer: a real JPEG comes back
// as the passport fields the browser signs, the sha256 in the answer is the sha256 of the bytes
// that were actually pinned, and a missing token, a bad title and a text file are each refused.
// Does NOT cover a real pin to Pinata (the live check in the work order does that), the remote
// JWKS fetch, or the per-user rate limit reaching 20 in an hour.

import { SignJWT, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { PACKAGE_ROOT } from "../src/env.js";
import { fingerprint } from "../src/fingerprint.js";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import { makeImage } from "./helpers.js";

// env.ts validates once at import, so the token and the app id have to be set before any module
// in this file loads. vi.hoisted runs before the imports above. The token is a fake: every call
// to Pinata is answered by the stub below.
const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000001";
  process.env.PRIVY_APP_ID = id;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  return id;
});

let IMAGE: Buffer;

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const emptySource: PassportSource = { load: async () => [] };

/** Every file the stub was asked to pin, in order, by the name the route gave it. */
const pinned = new Map<string, Buffer>();
let signing: CryptoKey;
let verifying: CryptoKey;
let app: FastifyInstance;

async function token(subject = "did:privy:studio-user"): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("privy.io")
    .setAudience(APP_ID)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signing);
}

function body(parts: { file?: { name: string; type: string; bytes: Buffer }; fields?: Record<string, string> }): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = "----moolamprepare";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(parts.fields ?? {})) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (parts.file !== undefined) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${parts.file.name}"\r\n` +
          `Content-Type: ${parts.file.type}\r\n\r\n`,
      ),
      parts.file.bytes,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

describe("POST /prepare", () => {
  beforeAll(async () => {
    IMAGE = await makeImage(7);
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;

    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== UPLOAD_URL) {
        return await realFetch(input, init);
      }
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      pinned.set(String(form.get("name")), bytes);
      const cid = `bafytest${pinned.size}`;
      return new Response(JSON.stringify({ data: { cid, size: bytes.length } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    app = await buildServer({ source: emptySource, logger: false, prepare: { keys: verifying } });
    await app.ready();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it("pins the image, the thumbnail, the manifest and the metadata, and answers with the passport fields", async () => {
    const image = IMAGE;
    const { payload, headers } = body({
      file: { name: "storm.jpg", type: "image/jpeg", bytes: image },
      fields: { title: "Lighthouse in a storm", kind: "human" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/prepare",
      payload,
      headers: { ...headers, authorization: `Bearer ${await token()}` },
      remoteAddress: "203.0.113.20",
    });

    expect(response.statusCode).toBe(200);
    const answer = response.json();

    const pinnedImage = pinned.get("lighthouse-in-a-storm-" + answer.passport.exactHash.slice(2, 10) + ".jpg");
    expect(pinnedImage).toBeDefined();
    const print = await fingerprint(pinnedImage as Buffer);

    expect(answer.passport.exactHash).toBe(print.sha256);
    expect(answer.passport.phash).toBe(print.phash.toString());
    expect(answer.passport.blockhash256).toBe(print.blockhash);
    expect(answer.passport.kind).toBe(1);
    expect(answer.passport.fingerprintVersion).toBe(1);
    expect(answer.passport.parentId).toBe(`0x${"00".repeat(32)}`);
    expect(answer.passport.generatorAgentId).toBe("0");
    expect(answer.passport.metadataURI).toMatch(/^ipfs:\/\/.+/);
    expect(answer.passport.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(answer.manifest.embedded).toBe(true);
    expect(answer.image.bytes).toBe((pinnedImage as Buffer).length);
    expect(answer.image.width).toBe(print.width);
    expect(answer.thumbnail.gatewayUrl).toMatch(/^https:\/\/moolam-test\.mypinata\.cloud\/ipfs\//);
    expect(answer.preparedBy).toBe("did:privy:studio-user");
    expect(JSON.stringify(answer)).not.toContain("test-token-not-a-real-pinata-jwt");
  }, 60_000);

  it("refuses a request with no token before it reads the upload", async () => {
    const pinsBefore = pinned.size;
    const { payload, headers } = body({
      file: { name: "storm.jpg", type: "image/jpeg", bytes: IMAGE },
      fields: { title: "No token", kind: "human" },
    });

    const response = await app.inject({ method: "POST", url: "/prepare", payload, headers });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
    expect(pinned.size).toBe(pinsBefore);
  });

  it("refuses a file that is not an image with 415", async () => {
    const { payload, headers } = body({
      file: { name: "notes.txt", type: "text/plain", bytes: Buffer.from("not an image") },
      fields: { title: "Notes", kind: "human" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/prepare",
      payload,
      headers: { ...headers, authorization: `Bearer ${await token("did:privy:text-user")}` },
      remoteAddress: "203.0.113.21",
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({ error: "not-an-image" });
  });

  it("refuses an empty title, an over-long title and a kind the studio does not take", async () => {
    const image = IMAGE;
    const bearer = `Bearer ${await token("did:privy:title-user")}`;

    for (const fields of [
      { title: "   ", kind: "human" },
      { title: "x".repeat(121), kind: "human" },
      { title: "Fine title", kind: "generated" },
    ]) {
      const { payload, headers } = body({ file: { name: "storm.jpg", type: "image/jpeg", bytes: image }, fields });
      const response = await app.inject({
        method: "POST",
        url: "/prepare",
        payload,
        headers: { ...headers, authorization: bearer },
        remoteAddress: "203.0.113.22",
      });

      expect(response.statusCode, JSON.stringify(fields)).toBe(400);
    }
  }, 30_000);
});
