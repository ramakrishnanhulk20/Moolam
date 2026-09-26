// Covers review pass 8, V70 and V74: no single caller can shut /verify for everyone else. One
// rate-limit key may hold two uploads' worth of the ceiling at once, so idle uploads from one
// address cannot starve another. A share shrinks to the bytes actually read once the body is in,
// for a URL fetch and for an upload. A socket whose body stops arriving is closed after the idle
// limit and gives its share back, while a request whose body is in stays open past that limit as
// it waits on a match. At the match gate one key holds one slot at a time, and /prepare keeps a
// slot of its own that verifies can never take. A caller turned away hears a busy service in
// general words (WO-185a follow-up).
// Callers are told apart by X-Forwarded-For, believed here because TRUST_PROXY names loopback.
// Does NOT cover /prepare, /edit and /unseal taking a share (test/studio-ceiling.test.ts), the
// ceiling's plain rules (test/upload-ceiling.test.ts), or the 180 second whole-request limit, which
// Node checks only every 30 seconds and which is set, not driven, here. The /prepare slot is
// shown through runPrepare, the gate call /prepare makes, not through the route with Pinata.

import { request as httpRequest, type ClientRequest } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.hoisted(() => {
  process.env.TRUST_PROXY = "loopback";
});

const remote = vi.hoisted(() => ({
  answer: undefined as (() => Response) | undefined,
}));

/** Lets a test hold chosen pictures inside the match, so it can see who holds a gate slot. */
const matching = vi.hoisted(() => ({
  stall: undefined as ((bytes: Buffer) => boolean) | undefined,
  release: Promise.resolve(),
  entered: 0,
}));

vi.mock("../src/net/safeFetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/net/safeFetch.js")>()),
  safeFetch: async () => {
    if (remote.answer === undefined) {
      throw new Error("this test did not say what the remote host answers");
    }
    return remote.answer();
  },
}));

vi.mock("../src/match.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/match.js")>();
  return {
    ...real,
    matchImage: async (...args: Parameters<typeof real.matchImage>) => {
      if (matching.stall?.(args[0]) === true) {
        matching.entered += 1;
        await matching.release;
      }
      return await real.matchImage(...args);
    },
  };
});

const { MAX_UPLOAD_BYTES } = await import("../src/env.js");
const { CALLER_CEILING_BYTES, UPLOAD_CEILING_BYTES, heldUploads } = await import("../src/routes/shared.js");
const { buildServer } = await import("../src/server.js");
const { Busy } = await import("../src/generate/gate.js");
const { makeImage, multipartBody } = await import("./helpers.js");

const FIRST = "203.0.113.1";
const SECOND = "203.0.113.2";
const THIRD = "203.0.113.3";
const FOURTH = "203.0.113.4";

let app: FastifyInstance;
let port: number;
let picture: Buffer;
let other: Buffer;
let third: Buffer;
/** Every request a test opened, so a failed test cannot leave an idle upload holding the ceiling. */
const sockets: ClientRequest[] = [];
/** Lets go of every held match, so a failed test cannot leave requests parked in the gate. */
let releaseMatches: () => void = () => undefined;

interface Answer {
  status: number;
  body: string;
}

interface Opened {
  request: ClientRequest;
  answer: Promise<Answer>;
  closed: Promise<void>;
}

/** Opens POST /verify from `from` on `at` and writes only `first` of the body. */
function open(from: string, headers: Record<string, string | number>, first?: Buffer, at = port): Opened {
  let request: ClientRequest | undefined;
  const answer = new Promise<Answer>((resolve, reject) => {
    request = httpRequest(
      { host: "127.0.0.1", port: at, method: "POST", path: "/verify", headers: { ...headers, "x-forwarded-for": from } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    request.on("error", reject);
    request.flushHeaders();
    if (first !== undefined) {
      request.write(first);
    }
  });
  answer.catch(() => undefined);
  const sent = request as unknown as ClientRequest;
  sockets.push(sent);
  const closed = new Promise<void>((resolve) => sent.once("close", () => resolve()));
  return { request: sent, answer, closed };
}

/** An upload that declares a whole upload's worth and sends only its multipart head. */
function idle(from: string, at = port): Opened {
  const { payload, headers } = multipartBody("file", "idle.jpg", "image/jpeg", Buffer.alloc(0));
  return open(from, { ...headers, "content-length": MAX_UPLOAD_BYTES }, payload.subarray(0, 60), at);
}

async function upload(from: string, content: Buffer): Promise<Answer> {
  const { payload, headers } = multipartBody("file", "harbour.jpg", "image/jpeg", content);
  const { request, answer } = open(from, { ...headers, "content-length": payload.length });
  request.end(payload);
  return await answer;
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

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Holds every picture `stall` picks inside the match until the returned function is called. */
function holdMatches(stall: (bytes: Buffer) => boolean): () => void {
  let release: () => void = () => undefined;
  matching.release = new Promise<void>((resolve) => {
    release = resolve;
  });
  matching.entered = 0;
  matching.stall = stall;
  releaseMatches = release;
  return release;
}

async function inject(from: string, content: Buffer): Promise<Answer> {
  const { payload, headers } = multipartBody("file", "harbour.jpg", "image/jpeg", content);
  const response = await app.inject({
    method: "POST",
    url: "/verify",
    payload,
    headers: { ...headers, "x-forwarded-for": from },
  });
  return { status: response.statusCode, body: response.body };
}

beforeAll(async () => {
  picture = await makeImage(71);
  other = await makeImage(72);
  third = await makeImage(73);
  app = await buildServer({ source: { load: async () => [] }, logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
}, 60_000);

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  heldUploads.limit = UPLOAD_CEILING_BYTES;
  remote.answer = undefined;
  matching.stall = undefined;
  releaseMatches();
  vi.restoreAllMocks();
  await until(() => heldUploads.held === 0);
});

afterAll(async () => {
  await app.close();
});

describe("V70: one caller cannot hold the upload ceiling", () => {
  it("is ten uploads in all and two for one caller", () => {
    expect(UPLOAD_CEILING_BYTES).toBe(10 * MAX_UPLOAD_BYTES);
    expect(CALLER_CEILING_BYTES).toBe(2 * MAX_UPLOAD_BYTES);
    expect(heldUploads.limit).toBe(UPLOAD_CEILING_BYTES);
    expect(heldUploads.perCaller).toBe(CALLER_CEILING_BYTES);
  });

  it("lets three idle uploads from one key take two uploads' worth, and another key is still served", async () => {
    // The ceiling the review attacked: three full uploads.
    heldUploads.limit = 3 * MAX_UPLOAD_BYTES;
    idle(FIRST);
    idle(FIRST);
    await until(() => heldUploads.held === 2 * MAX_UPLOAD_BYTES);
    const third = idle(FIRST);

    const refused = await within(third.answer, 3_000);
    const served = await within(upload(SECOND, picture), 30_000);

    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toEqual({ error: "busy" });
    expect(served.status, served.body).toBe(200);
  }, 60_000);

  it("answers busy to a key past two uploads' worth while another key is served", async () => {
    idle(FIRST);
    idle(FIRST);
    await until(() => heldUploads.held === 2 * MAX_UPLOAD_BYTES);

    const refused = await within(upload(FIRST, picture), 3_000);
    const served = await within(upload(SECOND, picture), 30_000);

    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toEqual({ error: "busy" });
    expect(served.status, served.body).toBe(200);
  }, 60_000);

  it("trims a share to the bytes actually read, for a URL fetch sent without a length and for an upload", async () => {
    const release = holdMatches(() => true);
    remote.answer = () => new Response(new Uint8Array(picture), { status: 200 });
    const body = JSON.stringify({ url: "https://pictures.example/harbour.jpg" });
    const fetched = open(FIRST, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    fetched.request.end(body);
    await until(() => matching.entered === 1);

    expect(heldUploads.held).toBe(picture.length);

    const sent = upload(SECOND, other);
    await until(() => matching.entered === 2);

    expect(heldUploads.held).toBe(picture.length + other.length);

    release();
    expect((await within(fetched.answer, 30_000)).status).toBe(200);
    expect((await within(sent, 30_000)).status).toBe(200);
  }, 60_000);
});

describe("V70: a body that stops arriving gives its share back", () => {
  let quick: FastifyInstance;
  let quickPort: number;

  beforeAll(async () => {
    quick = await buildServer({ source: { load: async () => [] }, logger: false, timeouts: { idleMs: 300 } });
    await quick.listen({ port: 0, host: "127.0.0.1" });
    quickPort = (quick.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await quick.close();
  });

  it("closes an idle upload socket after the idle limit and gives its share back", async () => {
    const stalled = idle(FIRST, quickPort);
    await until(() => heldUploads.held === MAX_UPLOAD_BYTES);

    await within(stalled.closed, 3_000);
    await until(() => heldUploads.held === 0, 1_000);
  });

  it("keeps a request whose body is in open past the idle limit while its match runs", async () => {
    const release = holdMatches(() => true);
    const { payload, headers } = multipartBody("file", "harbour.jpg", "image/jpeg", picture);
    const waiting = open(FIRST, { ...headers, "content-length": payload.length }, undefined, quickPort);
    waiting.request.end(payload);
    await until(() => matching.entered === 1);

    await pause(900);
    release();

    expect((await within(waiting.answer, 30_000)).status).toBe(200);
  }, 30_000);
});

describe("V74: fair turns at the match gate", () => {
  it("lets one key sending many verifies hold one slot while a second key is served", async () => {
    const release = holdMatches((bytes) => bytes.equals(picture));
    const flood = [inject(FIRST, picture), inject(FIRST, picture), inject(FIRST, picture)];
    await until(() => matching.entered >= 1);
    await pause(300);

    expect(matching.entered).toBe(1);
    const served = await within(inject(SECOND, other), 20_000);
    expect(served.status, served.body).toBe(200);

    release();
    for (const answer of await Promise.all(flood)) {
      expect(answer.status, answer.body).toBe(200);
    }
  }, 60_000);

  it("runs a /prepare with both verify slots busy, and a third verify waits", async () => {
    const release = holdMatches((bytes) => bytes.equals(picture) || bytes.equals(other));
    const busy = [inject(FIRST, picture), inject(SECOND, other)];
    await until(() => matching.entered === 2);

    const ran = await within(app.verifier.runPrepare(async () => "prepared"), 2_000);
    expect(ran).toBe("prepared");

    // The prepare slot is free again, and a verify still may not take it.
    let thirdDone = false;
    const waiting = inject(THIRD, third).then((answer) => {
      thirdDone = true;
      return answer;
    });
    await pause(1_000);
    expect(thirdDone).toBe(false);

    release();
    for (const answer of [...(await Promise.all(busy)), await waiting]) {
      expect(answer.status, answer.body).toBe(200);
    }
    expect((await inject(FOURTH, third)).status).toBe(200);
  }, 60_000);

  it("says busy in general words when no turn comes free, naming no generation slot", () => {
    // The fair gate throws it for verifies, prepares, edits and unseals, none of which draw anything.
    const message = new Busy(30_000).message;
    expect(message).toMatch(/busy/);
    expect(message).not.toMatch(/generation/);
  });
});
