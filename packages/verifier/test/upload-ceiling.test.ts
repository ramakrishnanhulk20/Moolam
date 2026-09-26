// Covers review pass 7, V62: the upload bytes /verify holds at once have a ceiling. A request takes
// its share before its body is read (the Content-Length when it gives one, the upload cap when it
// does not), and past the ceiling it answers 503 busy at once, with its body never read. The share
// comes back when the response is sent, whether it was a 200, a refusal, a thrown error or a caller
// who hung up, and a caller who hangs up while their picture is being matched keeps its share
// counted until the match lets go of the bytes. The URL form is held to the same ceiling before the
// remote body is read. readManifest waits for a match slot instead of running beside the queue.
// Over a real connection on this machine, because only a real socket can withhold a body or hang up.
// Does NOT cover /verify/paid, which reads its upload through the same function and is tested in
// test/x402.test.ts, nor /prepare, /edit and /unseal, which need a token and read their multipart
// bodies through their own loops. The ceiling's size is argued in src/routes/shared.ts, not measured.

import { request as httpRequest, type ClientRequest } from "node:http";
import { Reader } from "@contentauth/c2pa-node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const remote = vi.hoisted(() => ({
  answer: undefined as (() => Response) | undefined,
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

const { MAX_UPLOAD_BYTES } = await import("../src/env.js");
const { UPLOAD_CEILING_BYTES, heldUploads } = await import("../src/routes/shared.js");
const { buildServer } = await import("../src/server.js");
const { makeImage, multipartBody } = await import("./helpers.js");

let app: FastifyInstance;
let port: number;
let picture: Buffer;

interface Answer {
  status: number;
  body: string;
}

/**
 * Opens POST /verify and writes only `first` of the body, so a test decides when the rest comes or
 * whether it ever does.
 */
function open(headers: Record<string, string | number>, first?: Buffer): { request: ClientRequest; answer: Promise<Answer> } {
  let request: ClientRequest | undefined;
  const answer = new Promise<Answer>((resolve, reject) => {
    request = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/verify", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.flushHeaders();
    if (first !== undefined) {
      request.write(first);
    }
  });
  answer.catch(() => undefined);
  return { request: request as unknown as ClientRequest, answer };
}

async function upload(content: Buffer, field = "file"): Promise<Answer> {
  const { payload, headers } = multipartBody(field, "harbour.jpg", "image/jpeg", content);
  const { request, answer } = open({ ...headers, "content-length": payload.length });
  request.end(payload);
  return await answer;
}

/** The answer, or a failure naming the wait: a server that is still reading never answers. */
async function within(answer: Promise<Answer>, ms: number): Promise<Answer> {
  return await Promise.race([
    answer,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)),
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
  picture = await makeImage(71);
  app = await buildServer({ source: { load: async () => [] }, logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
}, 60_000);

afterEach(async () => {
  heldUploads.limit = UPLOAD_CEILING_BYTES;
  remote.answer = undefined;
  vi.restoreAllMocks();
  await until(() => heldUploads.held === 0);
});

afterAll(async () => {
  await app.close();
});

describe("V62: the ceiling on upload bytes held at once", () => {
  it("is three full uploads", () => {
    expect(UPLOAD_CEILING_BYTES).toBe(3 * MAX_UPLOAD_BYTES);
    expect(heldUploads.limit).toBe(UPLOAD_CEILING_BYTES);
  });

  it("answers 503 busy at once past the ceiling, before a byte of the body is read", async () => {
    heldUploads.limit = 1_000;
    const { payload, headers } = multipartBody("file", "big.jpg", "image/jpeg", Buffer.alloc(5_000, 1));
    const { request, answer } = open({ ...headers, "content-length": payload.length });

    const refused = await within(answer, 3_000);
    request.destroy();

    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toEqual({ error: "busy" });
    expect(heldUploads.held).toBe(0);
  });

  it("holds a body with no Content-Length at the upload cap", async () => {
    heldUploads.limit = MAX_UPLOAD_BYTES - 1;
    const { headers } = multipartBody("file", "chunked.jpg", "image/jpeg", Buffer.alloc(0));
    const { request, answer } = open({ ...headers, "transfer-encoding": "chunked" }, Buffer.from("--"));

    const refused = await within(answer, 3_000);
    request.destroy();

    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toEqual({ error: "busy" });
  });

  it("holds a body by the Content-Length it gives, so a small upload fits under a small ceiling", async () => {
    const { payload } = multipartBody("file", "harbour.jpg", "image/jpeg", picture);
    heldUploads.limit = payload.length;

    const answered = await within(upload(picture), 30_000);

    expect(answered.status, answered.body).toBe(200);
  }, 30_000);

  it("refuses a second upload while the first holds the ceiling, and takes it once the first is answered", async () => {
    const { payload, headers } = multipartBody("file", "harbour.jpg", "image/jpeg", picture);
    heldUploads.limit = payload.length + 100;
    const first = open({ ...headers, "content-length": payload.length }, payload.subarray(0, 100));
    await until(() => heldUploads.held === payload.length);

    const second = await within(upload(picture), 3_000);
    expect(second.status).toBe(503);

    first.request.end(payload.subarray(100));
    expect((await within(first.answer, 30_000)).status).toBe(200);
    await until(() => heldUploads.held === 0);
    expect((await within(upload(picture), 30_000)).status).toBe(200);
  }, 60_000);

  it("gives the share back after a 200, a refused upload and a thrown error", async () => {
    expect((await upload(picture)).status).toBe(200);
    await until(() => heldUploads.held === 0);

    const misnamed = await upload(picture, "photo");
    expect(misnamed.status).toBe(400);
    await until(() => heldUploads.held === 0);

    vi.spyOn(app.verifier, "runMatch").mockRejectedValueOnce(new Error("the blockhash worker stopped with code 1"));
    const faulted = await upload(picture);
    expect(faulted.status).toBe(503);
    expect(JSON.parse(faulted.body).error).toBe("service-fault");
    await until(() => heldUploads.held === 0);
  }, 60_000);

  it("gives the share back when the caller hangs up half way through the body", async () => {
    const { payload, headers } = multipartBody("file", "harbour.jpg", "image/jpeg", picture);
    const { request } = open({ ...headers, "content-length": payload.length }, payload.subarray(0, 200));
    await until(() => heldUploads.held === payload.length);

    request.destroy();

    await until(() => heldUploads.held === 0);
  });

  it("keeps a hung-up caller's share counted until the match lets go of the bytes", async () => {
    let entered: () => void = () => undefined;
    const matching = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish: (error: Error) => void = () => undefined;
    const match = new Promise<never>((_, reject) => {
      finish = reject;
    });
    vi.spyOn(app.verifier, "runMatch").mockImplementationOnce(async () => {
      entered();
      return await match;
    });
    const { payload, headers } = multipartBody("file", "harbour.jpg", "image/jpeg", picture);
    const { request } = open({ ...headers, "content-length": payload.length });
    request.end(payload);
    await matching;

    request.destroy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(heldUploads.held).toBe(payload.length);

    finish(new Error("the match was let go"));
    await until(() => heldUploads.held === 0);
  }, 30_000);
});

describe("V62: the URL form under the same ceiling", () => {
  /** A remote picture whose body counts how often it was read. */
  function remotePicture(bytes: Buffer, declared: boolean): { pulls: () => number } {
    let pulls = 0;
    remote.answer = () =>
      new Response(
        // A high-water mark of 0 means the stream is pulled only when someone reads it.
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls += 1;
              controller.enqueue(new Uint8Array(bytes));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 200, headers: declared ? { "content-length": String(bytes.length) } : {} },
      );
    return { pulls: () => pulls };
  }

  async function verifyUrl(): Promise<Answer> {
    const body = JSON.stringify({ url: "https://pictures.example/harbour.jpg" });
    const { request, answer } = open({ "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    request.end(body);
    return await within(answer, 30_000);
  }

  it("answers 503 busy before reading a remote body past the ceiling, declared or not", async () => {
    for (const declared of [true, false]) {
      heldUploads.limit = declared ? picture.length - 1 : MAX_UPLOAD_BYTES - 1;
      const body = remotePicture(picture, declared);

      const refused = await verifyUrl();

      expect(refused.status, `declared ${String(declared)}`).toBe(503);
      expect(JSON.parse(refused.body)).toEqual({ error: "busy" });
      expect(body.pulls(), `declared ${String(declared)}`).toBe(0);
    }
  }, 30_000);

  it("reads a remote picture that fits and gives the share back once answered", async () => {
    heldUploads.limit = picture.length;
    remotePicture(picture, true);

    const answered = await verifyUrl();

    expect(answered.status, answered.body).toBe(200);
    await until(() => heldUploads.held === 0);
  }, 30_000);
});

describe("V62: the manifest read waits for a match slot", () => {
  it("does not read the manifest while both match slots are taken", async () => {
    const reads = vi.spyOn(Reader, "fromAsset");
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = [app.verifier.runPrepare(() => blocked), app.verifier.runPrepare(() => blocked)];

    const answer = upload(picture);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reads).not.toHaveBeenCalled();

    release();
    await Promise.all(held);
    expect((await within(answer, 30_000)).status).toBe(200);
    expect(reads).toHaveBeenCalledTimes(1);
  }, 30_000);
});
