import { afterEach, describe, expect, it, vi } from "vitest";
import { NoGatewayAnswered, pictureSources, pinnedBytes } from "@/lib/images";

/**
 * How the "try one of these" samples get their bytes.
 *
 * The panel used to fetch one address and wait. A Pinata gateway that takes the
 * connection and then never answers left it reading "fingerprinting" forever,
 * with nothing on its way to the verify service, which is the failure these
 * tests hold shut.
 *
 * There is one gateway in the list now, so the walk is that gateway asked
 * twice. A stall is a held connection rather than a host that is down, and the
 * second request answers while the first is still hanging.
 */

const CID = "bafkreic2hhpha2tojkx7xxy5och55vttafuolwsl3wuzq2sxgvuuklhe3i";
const URI = `ipfs://${CID}`;
const WALK = pictureSources(URI);

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The answers the gateway gives, in the order it is asked. Anything past the list stalls. */
function gateway(answers: ("bytes" | "empty" | number | "stall")[]) {
  const asked: string[] = [];
  const stalled: AbortSignal[] = [];

  const fake = vi.fn(async (url: string, options: { signal?: AbortSignal } = {}) => {
    const answer = answers[asked.length] ?? "stall";
    asked.push(url);

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
    if (answer === "empty") {
      return { ok: true, blob: async () => new Blob([]) } as Response;
    }
    return { ok: false, status: answer, blob: async () => new Blob([]) } as Response;
  });

  vi.stubGlobal("fetch", fake);
  return { asked, stalled };
}

describe("the bytes behind one offered sample", () => {
  it("does not wait on a gateway that never answers: a second request is sent beside it and wins", async () => {
    const { asked } = gateway(["stall", "bytes"]);

    const blob = await pinnedBytes(URI, { patienceMs: 20, timeoutMs: 500 });

    expect(blob.size).toBe(4);
    expect(asked).toEqual([WALK[0], WALK[0]]);
  });

  it("asks again the moment the gateway refuses, without spending the patience window", async () => {
    const { asked } = gateway([429, "bytes"]);

    const started = Date.now();
    const blob = await pinnedBytes(URI, { patienceMs: 5000, timeoutMs: 5000 });

    expect(blob.size).toBe(4);
    expect(asked).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reads one picture from the account's own gateway and from nowhere else", async () => {
    const { asked } = gateway(["bytes"]);

    await pinnedBytes(URI, { patienceMs: 20, timeoutMs: 500 });

    expect(WALK).toHaveLength(1);
    for (const url of asked) {
      expect(url).toBe(WALK[0]);
    }
  });

  it("refuses with what it tried when the file is turned down every time", async () => {
    gateway([500, 500]);

    const failure = await pinnedBytes(URI, { patienceMs: 20, timeoutMs: 500 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NoGatewayAnswered);
    expect((failure as NoGatewayAnswered).tried).toHaveLength(2);
    expect((failure as NoGatewayAnswered).tried.join(" ")).toContain("500");
  });

  it("gives up inside its own window when nothing answers, so the panel cannot sit on pending", async () => {
    const { stalled } = gateway([]);

    const started = Date.now();
    const failure = await pinnedBytes(URI, { patienceMs: 20, timeoutMs: 200 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NoGatewayAnswered);
    expect(Date.now() - started).toBeLessThan(1500);
    // The held connections are dropped on the way out rather than left open.
    expect(stalled.every((signal) => signal.aborted)).toBe(true);
  });

  it("treats an empty body as a refusal, because a zero byte file fingerprints as nothing", async () => {
    const { asked } = gateway(["empty", "bytes"]);

    const blob = await pinnedBytes(URI, { patienceMs: 20, timeoutMs: 500 });

    expect(blob.size).toBe(4);
    expect(asked).toHaveLength(2);
  });
});
