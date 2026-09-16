import { afterEach, describe, expect, it, vi } from "vitest";
import { NoGatewayAnswered, pictureSources, pinnedBytes } from "@/lib/images";

/**
 * How the "try one of these" samples get their bytes.
 *
 * The panel used to fetch one address and wait. A Pinata gateway that takes the
 * connection and then never answers left it reading "fingerprinting" forever,
 * with nothing on its way to the verify service, which is the failure these
 * tests hold shut.
 */

const CID = "bafkreic2hhpha2tojkx7xxy5och55vttafuolwsl3wuzq2sxgvuuklhe3i";
const URI = `ipfs://${CID}`;
const WALK = pictureSources(URI);

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A gateway that answers with bytes, one that refuses, and one that never answers at all. */
function gateways(answers: Record<string, "bytes" | number | "stall">) {
  const asked: string[] = [];
  const stalled: AbortSignal[] = [];

  const fake = vi.fn(async (url: string, options: { signal?: AbortSignal } = {}) => {
    asked.push(url);
    const answer = answers[url] ?? "stall";
    if (answer === "stall") {
      if (options.signal !== undefined) {
        stalled.push(options.signal);
      }
      return await new Promise<Response>((_, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    if (answer === "bytes") {
      return { ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/jpeg" }) } as Response;
    }
    return { ok: false, status: answer, blob: async () => new Blob([]) } as Response;
  });

  vi.stubGlobal("fetch", fake);
  return { asked, stalled };
}

describe("the bytes behind one offered sample", () => {
  it("does not wait on a gateway that never answers: the next one is asked beside it and wins", async () => {
    const { asked } = gateways({ [WALK[0]]: "stall", [WALK[1]]: "bytes" });

    const blob = await pinnedBytes(URI, { patienceMs: 20, timeoutMs: 500 });

    expect(blob.size).toBe(4);
    expect(asked[0]).toBe(WALK[0]);
    expect(asked).toContain(WALK[1]);
  });

  it("moves on the moment a gateway refuses, without spending the patience window", async () => {
    const { asked } = gateways({ [WALK[0]]: 429, [WALK[1]]: 429, [WALK[2]]: "bytes" });

    const started = Date.now();
    const blob = await pinnedBytes(URI, { patienceMs: 5000, timeoutMs: 5000 });

    expect(blob.size).toBe(4);
    expect(asked).toEqual([WALK[0], WALK[1], WALK[2]]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("asks the account's own gateway once more at the end, since the stall is one held connection", async () => {
    const asked: string[] = [];
    let seen = 0;

    // The second request to the same host is the one that answers, which is what
    // the browser does when the gateway leaves the first connection hanging.
    vi.stubGlobal("fetch", async (url: string, options: { signal?: AbortSignal } = {}) => {
      asked.push(url);
      if (url === WALK[0]) {
        seen += 1;
        if (seen === 1) {
          return await new Promise<Response>((_, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }
        return { ok: true, blob: async () => new Blob([new Uint8Array([9])], { type: "image/jpeg" }) } as Response;
      }
      return { ok: false, status: 429, blob: async () => new Blob([]) } as Response;
    });

    const blob = await pinnedBytes(URI, { patienceMs: 20, timeoutMs: 800 });

    expect(blob.size).toBe(1);
    expect(asked.filter((url) => url === WALK[0])).toHaveLength(2);
  });

  it("refuses with the hosts it tried when every gateway turns the file down", async () => {
    gateways({ [WALK[0]]: 500, [WALK[1]]: 429, [WALK[2]]: 404 });

    const failure = await pinnedBytes(URI, { patienceMs: 20, timeoutMs: 500 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NoGatewayAnswered);
    expect((failure as NoGatewayAnswered).tried.join(" ")).toContain("500");
    expect((failure as NoGatewayAnswered).tried.join(" ")).toContain("ipfs.io");
  });

  it("gives up inside its own window when nothing answers, so the panel cannot sit on pending", async () => {
    const { stalled } = gateways({});

    const started = Date.now();
    const failure = await pinnedBytes(URI, { patienceMs: 20, timeoutMs: 200 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NoGatewayAnswered);
    expect(Date.now() - started).toBeLessThan(1500);
    // The held connections are dropped on the way out rather than left open.
    expect(stalled.every((signal) => signal.aborted)).toBe(true);
  });

  it("treats an empty body as a refusal, because a zero byte file fingerprints as nothing", async () => {
    vi.stubGlobal("fetch", async (url: string) => ({
      ok: true,
      blob: async () => (url === WALK[1] ? new Blob([new Uint8Array([7, 7])]) : new Blob([])),
    }));

    const blob = await pinnedBytes(URI, { patienceMs: 20, timeoutMs: 500 });

    expect(blob.size).toBe(2);
  });
});
