// Covers review pass 9 on when a /prepare gives its upload share back. V79: a caller who has left
// before the body is read is refused without a byte of it being read. V90: a caller who hangs up
// after signing leaves the share counted while the route still holds the bytes through its pins,
// and it comes back when the handler ends. V80: a sealed answer the client never reads is cut at
// the idle limit, and the share is back once the handler has ended, not when the socket closes.
// Over real connections on this machine with a short idle limit, because only a real socket can
// hang up.
// Does NOT cover Privy, Pinata or the chain: the token is signed here and its check can be held
// by the test, every pin is answered by a stub at the fetch layer, and the duplicate read is
// stubbed. /edit and /unseal give their shares back through the same wrapper and are not driven
// here. Nor a real client that stops reading: on this Windows machine the kernel took a single
// 30 MB write to a loopback client that read nothing and reported it sent (measured 2026-09-26),
// so the V80 test holds the server socket's writes instead, the way a full receive window holds
// them on Linux.

import { tracingChannel } from "node:diagnostics_channel";
import { request as httpRequest, type ClientRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { SignJWT, generateKeyPair } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, FastifyReply } from "fastify";

const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000011";
  process.env.PRIVY_APP_ID = id;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  return id;
});

/** Lets a test hold the token check, so the caller can leave before the route reads the body. */
const token = vi.hoisted(() => ({ gate: Promise.resolve() }));

vi.mock("../src/c2pa.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/c2pa.js")>()),
  ensureSigner: async () => undefined,
}));

vi.mock("../src/edit/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/registry.js")>()),
  passportExists: async () => false,
}));

vi.mock("../src/auth/privy.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/auth/privy.js")>();
  return {
    ...real,
    verifyPrivyToken: async (...args: Parameters<typeof real.verifyPrivyToken>) => {
      await token.gate;
      return await real.verifyPrivyToken(...args);
    },
  };
});

const { UPLOAD_CEILING_BYTES, heldUploads } = await import("../src/routes/shared.js");
const { contentIdOf } = await import("../src/ipfs/pinata.js");
const { buildServer } = await import("../src/server.js");
const { makeImage } = await import("./helpers.js");

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const IDLE_MS = 500;

let app: FastifyInstance;
let port: number;
let picture: Buffer;
let signing: CryptoKey;
let verifying: CryptoKey;

/** What each Pinata upload is answered with. Set per test. */
let pin: (bytes: Buffer) => Promise<Response> = async () => {
  throw new Error("this test did not say what Pinata answers");
};
let pinCalls = 0;

/** Every request the server received and the response Node made for it, newest last. */
const arrivals: { request: IncomingMessage; response: ServerResponse }[] = [];

/** Every handler that ended, with the status its reply carried. */
const ended: { url: string; status: number }[] = [];
const handlers = tracingChannel<{ request: { url: string }; reply: FastifyReply }>("fastify.request.handler");
const onEnd = {
  start: () => undefined,
  end: () => undefined,
  asyncStart: () => undefined,
  error: () => undefined,
  asyncEnd: (store: { request: { url: string }; reply: FastifyReply }) => {
    ended.push({ url: store.request.url, status: store.reply.statusCode });
  },
};

/** Clients a test opened, so a failed test cannot leave one holding the ceiling. */
const clients: ClientRequest[] = [];

/** True while the next request's answer should never leave the server, as for a client that reads nothing. */
let stallNext = false;

/** Makes a socket take every write and never finish sending it, as a full receive window does. */
function neverFlushes(socket: Socket): void {
  const held = socket as unknown as { _write: unknown; _writev: unknown };
  held._write = () => undefined;
  held._writev = () => undefined;
}

async function bearer(subject: string): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("privy.io")
    .setAudience(APP_ID)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signing);
}

/** A /prepare body with a title, the one kind the studio takes, the sealed flag and `bytes` as the file. */
function studioBody(bytes: Buffer, sealed: boolean): { payload: Buffer; contentType: string } {
  const boundary = "----moolamrelease";
  const field = (name: string, value: string): string =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  return {
    payload: Buffer.concat([
      Buffer.from(field("title", "Harbour") + field("kind", "human") + field("sealed", String(sealed))),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="harbour.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** Sends a whole /prepare and answers the client request, which the test may hang up. */
async function prepare(bytes: Buffer, sealed: boolean, subject: string): Promise<ClientRequest> {
  const { payload, contentType } = studioBody(bytes, sealed);
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: "/prepare",
    headers: { "content-type": contentType, "content-length": payload.length, authorization: `Bearer ${await bearer(subject)}` },
  });
  request.on("error", () => undefined);
  request.end(payload);
  clients.push(request);
  return request;
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

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** A Pinata answer for bytes that landed, in the shape the client reads. */
function pinned(bytes: Buffer): Response {
  return new Response(JSON.stringify({ data: { cid: contentIdOf(bytes), size: bytes.length, network: "public" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  signing = pair.privateKey;
  verifying = pair.publicKey;
  picture = await makeImage(111);
  handlers.subscribe(onEnd);

  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== UPLOAD_URL) {
      return await realFetch(input, init);
    }
    pinCalls += 1;
    const file = (init?.body as FormData).get("file") as File;
    return await pin(Buffer.from(await file.arrayBuffer()));
  });

  app = await buildServer({
    source: { load: async () => [] },
    logger: false,
    prepare: { keys: verifying },
    timeouts: { idleMs: IDLE_MS },
  });
  app.server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    arrivals.push({ request, response });
    if (stallNext) {
      stallNext = false;
      neverFlushes(request.socket);
    }
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
}, 60_000);

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.destroy();
  }
  token.gate = Promise.resolve();
  stallNext = false;
  pin = async () => {
    throw new Error("this test did not say what Pinata answers");
  };
  heldUploads.limit = UPLOAD_CEILING_BYTES;
  await until(() => heldUploads.held === 0, 30_000);
});

afterAll(async () => {
  handlers.unsubscribe(onEnd);
  vi.unstubAllGlobals();
  await app.close();
});

describe("V79: a caller who left before the read", () => {
  it("is refused without a byte of its body being read", async () => {
    let letTokenGo: () => void = () => undefined;
    token.gate = new Promise<void>((resolve) => {
      letTokenGo = resolve;
    });
    const before = arrivals.length;
    const client = await prepare(picture, false, "did:privy:left-early");
    await until(() => arrivals.length > before);
    const { request: incoming } = arrivals[before] as { request: IncomingMessage };
    await pause(200);

    client.destroy();
    await until(() => incoming.socket?.destroyed === true);
    const endedBefore = ended.length;
    letTokenGo();
    await until(() => ended.slice(endedBefore).some((one) => one.url === "/prepare"), 10_000);

    const handler = ended.slice(endedBefore).find((one) => one.url === "/prepare");
    expect(handler?.status).toBe(499);
    expect(incoming.readableFlowing).toBe(null);
    expect(heldUploads.held).toBe(0);
  }, 30_000);
});

describe("V90: a /prepare that is still pinning", () => {
  it("keeps a hung-up caller's share counted until the handler has ended", async () => {
    let letPinsGo: () => void = () => undefined;
    const pinsHeld = new Promise<void>((resolve) => {
      letPinsGo = resolve;
    });
    pin = async () => {
      await pinsHeld;
      throw new Error("this test reaches no network");
    };
    pinCalls = 0;
    const endedBefore = ended.length;
    const client = await prepare(picture, false, "did:privy:hung-up-pinning");
    await until(() => pinCalls >= 1, 30_000);

    client.destroy();
    await pause(300);
    expect(heldUploads.held).toBe(picture.length);

    letPinsGo();
    await until(() => ended.slice(endedBefore).some((one) => one.url === "/prepare"), 30_000);
    await until(() => heldUploads.held === 0, 1_000);
  }, 60_000);
});

describe("V80: a sealed answer the client never reads", () => {
  it("is cut at the idle limit, and its share is back once the handler has ended", async () => {
    pin = async (bytes) => pinned(bytes);
    stallNext = true;
    const before = arrivals.length;
    await prepare(picture, true, "did:privy:never-reads");

    await until(() => arrivals.length > before);
    const { request: incoming, response } = arrivals[before] as { request: IncomingMessage; response: ServerResponse };
    const serverSide = incoming.socket;
    await until(() => response.writableEnded, 30_000);

    // The handler has written the whole sealed answer and none of it has left.
    expect(response.statusCode).toBe(200);
    expect(response.writableFinished).toBe(false);
    await until(() => heldUploads.held === 0, 1_000);
    await until(() => serverSide.destroyed, IDLE_MS * 6);
  }, 60_000);
});
