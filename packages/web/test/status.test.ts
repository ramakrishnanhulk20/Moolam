import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The footer's three reads. The chain head goes through viem and is covered by
 * the pages that already read it; what matters here is that a service which
 * answers badly, slowly or not at all comes back as "unreachable" instead of
 * throwing into a render.
 */

const INDEX_URL = "https://index.example/v1/graphql";

type Read = typeof import("@/lib/status/read");
let read: Read;

beforeAll(async () => {
  // The public environment is parsed once at import, so the index has to be
  // configured before the module under test is pulled in.
  vi.stubEnv("NEXT_PUBLIC_ENVIO_GRAPHQL_URL", INDEX_URL);
  vi.stubEnv("NEXT_PUBLIC_VERIFIER_URL", "https://verify.example");
  read = await import("@/lib/status/read");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function answering(body: unknown, ok = true): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response));
}

describe("the verify service", () => {
  it("reports the record count it holds", async () => {
    answering({ ok: true, records: 29, version: "0.1.0" });
    expect(await read.readVerifier()).toEqual({ state: "live", records: 29 });
  });

  it("asks the /health route on the configured origin", async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, records: 1 }) }) as unknown as Response);
    vi.stubGlobal("fetch", spy);
    await read.readVerifier();
    expect(spy.mock.calls[0][0]).toBe("https://verify.example/health");
  });

  it("is unreachable when the answer is not the health shape", async () => {
    answering({ status: "fine" });
    expect(await read.readVerifier()).toEqual({ state: "unreachable" });
  });

  it("is unreachable when the service answers an error status", async () => {
    answering({ ok: true, records: 4 }, false);
    expect(await read.readVerifier()).toEqual({ state: "unreachable" });
  });

  it("is unreachable when nothing is listening", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await read.readVerifier()).toEqual({ state: "unreachable" });
  });

  it("gives up at the deadline rather than holding the page", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const started = Date.now();
    expect(await read.readVerifier(40)).toEqual({ state: "unreachable" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("the index", () => {
  it("reads the newest block it has processed", async () => {
    answering({ data: { chain_metadata: [{ latest_processed_block: 104_398_009 }] } });
    expect(await read.readIndexBlock()).toBe(104_398_009);
  });

  it("asks the configured endpoint for chain_metadata", async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { chain_metadata: [{ latest_processed_block: 7 }] } }),
    }) as unknown as Response);
    vi.stubGlobal("fetch", spy);
    await read.readIndexBlock();
    expect(spy.mock.calls[0][0]).toBe(INDEX_URL);
    expect(String((spy.mock.calls[0][1] as RequestInit).body)).toContain("chain_metadata");
  });

  it("is unknown when the index answers without a block", async () => {
    answering({ errors: [{ message: "table not found" }] });
    expect(await read.readIndexBlock()).toBeNull();
  });

  it("is unknown when the index refuses the query", async () => {
    answering({ data: { chain_metadata: [] } }, false);
    expect(await read.readIndexBlock()).toBeNull();
  });

  it("gives up at the deadline", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const started = Date.now();
    expect(await read.readIndexBlock(40)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("where the index stands", () => {
  it("is live when it is at the head", () => {
    expect(read.indexStanding(104_398_009, 104_398_009)).toEqual({ state: "live", block: 104_398_009 });
  });

  it("is live while it trails by less than the allowance", () => {
    expect(read.indexStanding(1_000, 1_000 + read.BEHIND_BLOCKS)).toEqual({ state: "live", block: 1_000 });
  });

  it("is behind, by how many blocks, once it trails further", () => {
    expect(read.indexStanding(1_000, 1_000 + read.BEHIND_BLOCKS + 1)).toEqual({
      state: "behind",
      blocks: read.BEHIND_BLOCKS + 1,
    });
  });

  it("still reports its own block when the chain head is unknown", () => {
    expect(read.indexStanding(500, null)).toEqual({ state: "live", block: 500 });
  });

  it("is unreachable when it gave no block", () => {
    expect(read.indexStanding(null, 104_398_009)).toEqual({ state: "unreachable" });
  });
});
