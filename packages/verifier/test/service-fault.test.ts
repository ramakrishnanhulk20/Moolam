// Covers review pass 6, answers 7 (V49): a fault of this service while matching is answered 503
// with a plain "try again" and logged, never 400 blaming the upload, while an upload that does not
// decode keeps its 400. The blockhash worker is replaced by a stand-in that hashes on this thread
// with the same library, or stops with code 1 when told to, so a dying worker can be shown without
// killing a real one.
// Does NOT execute a worker running past its 30 second limit, a hash of the wrong length or a
// decoder out of memory: fingerprint.ts raises the same FingerprintFault for each, which is read
// there and not driven here. Nor /verify/paid, which calls the same verifyBytes, or /verify's own
// body for a 503, which routes/verify.ts writes as "busy".

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeImage, multipartBody } from "./helpers.js";

const worker = vi.hoisted(() => ({ dies: false, started: 0 }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:worker_threads")>();
  // A mock factory runs before this file's own imports, so what it needs it loads itself.
  const { EventEmitter } = await import("node:events");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const imghash = require("imghash") as { hash: (input: Buffer, bits: number, format: "hex") => Promise<string> };

  class StandInWorker extends EventEmitter {
    constructor() {
      super();
      worker.started += 1;
    }
    postMessage(job: { bytes: Uint8Array; bits: number }): void {
      if (worker.dies) {
        setImmediate(() => this.emit("exit", 1));
        return;
      }
      imghash.hash(Buffer.from(job.bytes), job.bits, "hex").then(
        (hex) => this.emit("message", { hex }),
        (error: unknown) => this.emit("message", { error: error instanceof Error ? error.message : String(error) }),
      );
    }
    ref(): void {}
    unref(): void {}
    async terminate(): Promise<number> {
      return 0;
    }
  }
  return { ...real, Worker: StandInWorker };
});

const { buildServer } = await import("../src/server.js");
const { verifyBytes, SERVICE_FAULT_REASON } = await import("../src/routes/shared.js");
const { FingerprintFault, fingerprint } = await import("../src/fingerprint.js");

let app: FastifyInstance;
let picture: Buffer;

async function verify(bytes: Buffer) {
  const { payload, headers } = multipartBody("file", "harbour.jpg", "image/jpeg", bytes);
  return await app.inject({ method: "POST", url: "/verify", payload, headers });
}

describe("V49: who a failure during matching is blamed on", () => {
  beforeAll(async () => {
    picture = await makeImage(90);
    app = await buildServer({ source: { load: async () => [] }, logger: false });
    await app.ready();
  });

  beforeEach(() => {
    worker.dies = false;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it("answers 503, not 400, when the blockhash worker stops, and logs why", async () => {
    worker.dies = true;
    const logged = vi.spyOn(app.log, "error");

    const response = await verify(picture);

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("not an image we can read");
    await expect(verifyBytes(app, picture)).rejects.toMatchObject({ statusCode: 503, message: SERVICE_FAULT_REASON });
    expect(SERVICE_FAULT_REASON).toBe("the service could not read this picture right now, try again");
    expect(logged).toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls[0])).toContain("the blockhash worker stopped with code 1");
  }, 30_000);

  it("raises FingerprintFault from fingerprint() when the worker stops", async () => {
    worker.dies = true;

    await expect(fingerprint(picture)).rejects.toBeInstanceOf(FingerprintFault);
  }, 30_000);

  it("still answers 400 for a truncated JPEG, which is the upload's fault", async () => {
    const truncated = picture.subarray(0, Math.floor(picture.length * 0.55));

    const response = await verify(truncated);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/not an image we can read/);
  }, 30_000);

  it("matches as before once the worker is back", async () => {
    const response = await verify(picture);

    expect(response.statusCode).toBe(200);
    expect(worker.started).toBeGreaterThan(0);
  }, 30_000);
});
