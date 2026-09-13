// Covers the upload timeout on pinFile with fetch stubbed: an upload that never answers is
// abandoned rather than held open forever, and the retry after a 5xx gets a clock of its own.
// Does NOT cover a real pin to Pinata (the live check in the README does that), the gateway URL
// helper, or the JSON shape check, which the prepare and generate route tests exercise.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
});

const { pinFile } = await import("../src/ipfs/pinata.js");

const BYTES = Buffer.from("a few bytes that stand in for a picture");
const TIMEOUT_MS = 80;

/** Every signal the stub was handed, so a second attempt can be told apart from the first. */
const seen: AbortSignal[] = [];

/** Answers nothing and settles only when the caller's own timeout gives up. */
async function stall(signal: AbortSignal): Promise<Response> {
  return await new Promise<Response>((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(signal.reason);
    });
  });
}

describe("pinning through Pinata", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    seen.length = 0;
  });

  it("gives up on an upload that stalls past the timeout", async () => {
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      seen.push(signal);
      return await stall(signal);
    });

    const started = Date.now();
    await expect(pinFile(BYTES, "stalled.jpg", "image/jpeg", { timeoutMs: TIMEOUT_MS })).rejects.toThrow(
      /abort|timeout|timed out/i,
    );

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(true);
  });

  it("gives the retry after a server error its own signal", async () => {
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      seen.push(signal);
      if (seen.length === 1) {
        return new Response("the gateway is unhappy", { status: 502 });
      }
      return await stall(signal);
    });

    await expect(pinFile(BYTES, "retried.jpg", "image/jpeg", { timeoutMs: TIMEOUT_MS })).rejects.toThrow(
      /abort|timeout|timed out/i,
    );

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});
