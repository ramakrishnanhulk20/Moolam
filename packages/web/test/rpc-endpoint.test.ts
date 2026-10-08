// Covers how the server reaches Monad and what a visitor is shown when a read fails: which
// endpoints answer in which order with and without MONAD_RPC_URL, a first endpoint that rate
// limits or never answers being followed by a good read from the second, the boot refusing a
// malformed variable, and every address being taken out of the line pages print.
// Does NOT cover the endpoints themselves. No socket is opened here, so nothing in this file says
// the address the operator sets is reachable, fast, or still paid for. That is the live check in the README.

import { afterEach, describe, expect, it, vi } from "vitest";

/** Shaped like a QuickNode address, where the path is the credential. Nothing here is real. */
const DEDICATED = "https://moolam-test.monad-mainnet.example/TOKEN-IN-THE-ADDRESS/";
const PUBLIC = "https://rpc1.monad.xyz";
const BACKUPS = ["https://rpc.monad.xyz", "https://rpc2.monad.xyz", "https://rpc3.monad.xyz"];
const BLOCK = 123_456n;

interface CreatedTransport {
  value: { url: string };
}

/**
 * Imports the chain client with the environment this case wants.
 *
 * The transport is built once when the module loads, which is the thing under test, so the module
 * graph is thrown away between cases rather than the client being rebuilt by hand.
 */
async function loadClient(dedicated?: string): Promise<typeof import("@/lib/chain/client")> {
  vi.resetModules();
  process.env.NEXT_PUBLIC_MONAD_RPC_URL = PUBLIC;
  if (dedicated === undefined) {
    delete process.env.MONAD_RPC_URL;
  } else {
    process.env.MONAD_RPC_URL = dedicated;
  }
  return await import("@/lib/chain/client");
}

/** The JSON-RPC answer a healthy endpoint gives, in the batched shape viem sends. */
function blockNumberAnswer(init: RequestInit | undefined): Response {
  const sent = JSON.parse(String(init?.body ?? "[]")) as { id: number } | { id: number }[];
  const one = (request: { id: number }) => ({ jsonrpc: "2.0", id: request.id, result: `0x${BLOCK.toString(16)}` });
  const body = Array.isArray(sent) ? sent.map(one) : one(sent);
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.MONAD_RPC_URL;
});

describe("which endpoint the server reads through", () => {
  it("reads through the public endpoints, the configured one first, when no dedicated one is set", async () => {
    const { chain } = await loadClient();

    expect(chain.transport.type).toBe("fallback");
    expect((chain.transport.transports as CreatedTransport[]).map((one) => one.value.url)).toEqual([
      PUBLIC,
      ...BACKUPS,
    ]);
  });

  it("puts the dedicated endpoint first and the public one behind it when one is set", async () => {
    const { chain } = await loadClient(DEDICATED);

    expect(chain.transport.type).toBe("fallback");
    expect((chain.transport.transports as CreatedTransport[]).map((one) => one.value.url)).toEqual([
      DEDICATED,
      PUBLIC,
      ...BACKUPS,
    ]);
  });

  it("refuses to boot on a value that is not an https address, without printing it", async () => {
    await expect(loadClient("not-a-url")).rejects.toThrow(/MONAD_RPC_URL is set but is not an https URL/);

    const thrown = await loadClient("http://plain.example").catch((error: unknown) => error as Error);
    expect(thrown.message).toContain("packages/web/.env.example");
    expect(thrown.message).not.toContain("plain.example");
  });
});

describe("a bad minute on the dedicated endpoint", () => {
  it("reads through the public endpoint when the first one rate limits, and keeps the order", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push(url);
      if (url === DEDICATED) {
        return new Response("rate limited", { status: 429 });
      }
      return blockNumberAnswer(init);
    });
    const { chain } = await loadClient(DEDICATED);

    await expect(chain.getBlockNumber({ cacheTime: 0 })).resolves.toBe(BLOCK);
    await expect(chain.getBlockNumber({ cacheTime: 0 })).resolves.toBe(BLOCK);

    // viem calls the address it parsed, which is why the public one gains a trailing slash here.
    // The dedicated endpoint is asked first on the second read too: a rate limit does not demote it.
    expect(asked).toEqual([DEDICATED, `${PUBLIC}/`, DEDICATED, `${PUBLIC}/`]);
  });

  it("reads through the public endpoint when the first one never answers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== DEDICATED) {
        return blockNumberAnswer(init);
      }
      // Answers nothing at all until viem's own timeout aborts it, the shape of a dead endpoint.
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      });
    });
    const { chain } = await loadClient(DEDICATED);

    const read = chain.getBlockNumber({ cacheTime: 0 });
    // The clock is moved in steps rather than in one jump, because the second endpoint only
    // schedules its own work once the first has given up, and a single jump would land before it.
    for (let step = 0; step < 20; step += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
    }

    await expect(read).resolves.toBe(BLOCK);
  });
});

describe("the line a page prints when a read fails", () => {
  it("names no address for viem's HTTP error", async () => {
    const { reason } = await loadClient(DEDICATED);
    const { HttpRequestError } = await import("viem");

    const line = reason(new HttpRequestError({ status: 429, url: DEDICATED, body: { method: "eth_call" } }));

    expect(line).not.toContain("TOKEN-IN-THE-ADDRESS");
    expect(line).not.toMatch(/https?:\/\//);
  });

  it("names no address for viem's timeout", async () => {
    const { reason } = await loadClient(DEDICATED);
    const { TimeoutError } = await import("viem");

    const line = reason(new TimeoutError({ url: DEDICATED, body: { method: "eth_call" } }));

    expect(line).not.toContain("TOKEN-IN-THE-ADDRESS");
    expect(line).not.toMatch(/https?:\/\//);
  });

  it("takes an address out of any error, wherever it sits in the first line", async () => {
    const { reason } = await loadClient(DEDICATED);

    expect(reason(new Error(`fetch failed for ${DEDICATED}\nsecond line`))).toBe(
      "fetch failed for the RPC endpoint",
    );
    expect(reason(`request to ${DEDICATED} was refused`)).toBe("request to the RPC endpoint was refused");
  });

  it("leaves a message with no address in it exactly as it was", async () => {
    const { reason } = await loadClient();

    expect(reason(new Error("execution reverted: NotTheHolder"))).toBe("execution reverted: NotTheHolder");
  });
});
