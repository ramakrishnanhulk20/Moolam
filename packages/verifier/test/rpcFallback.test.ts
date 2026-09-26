// Covers the one transport every Monad read in this service is built from: the two endpoints in the
// order they are written, a plain transport when both names hold the same address, and a first
// endpoint answering 429 followed by a successful read from the second, for a registry read, a
// consent read and the owner check the edit route makes. It also covers a first endpoint that takes
// the request and never answers (review pass 8, answers 3, V75): the consent and dispute facts come
// back from the second inside their five second budget. The chain is a stubbed fetch, so viem's
// encoding, its timeouts and its own failover are real and no request leaves this machine.
// Does NOT cover the live endpoints themselves, and does not cover what a caller is told when both
// endpoints fail, which is test/rpc-leak.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeFunctionResult, getAddress } from "viem";
import type { Hex } from "../src/types.js";
import type { PictureReader } from "../src/unseal.js";

const BUSY = "https://busy.example/FIRST-ENDPOINT";
const SPARE = "https://spare.example/SECOND-ENDPOINT";

vi.hoisted(() => {
  process.env.MONAD_MAINNET_RPC_URL = "https://busy.example/FIRST-ENDPOINT";
  process.env.MONAD_RPC_FALLBACK_URL = "https://spare.example/SECOND-ENDPOINT";
});

const { consentAbi, consentReader } = await import("../src/consentRead.js");
const { disputeAbi, disputeReader, withPassportFacts } = await import("../src/disputeRead.js");
const { parentOwner, registryEditAbi } = await import("../src/edit/registry.js");
const { monadTransport, readClient } = await import("../src/reputation/registry.js");

const PASSPORT = "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638" as Hex;
const REGISTRY = "0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0" as Hex;
const CONSENT = "0x1151E69a82947920546e779c4C8c785b2a3C1277" as Hex;
const HOLDER = "0xC5ead1E4E5C6d56E87e02317f3fB3731cB0b6Ef7" as Hex;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

interface BuiltTransport {
  config: { type: string };
  value?: { url?: string; transports?: { value?: { url?: string } }[] };
}

function built(transport: ReturnType<typeof monadTransport>): BuiltTransport {
  return transport({}) as unknown as BuiltTransport;
}

/**
 * A chain where the first endpoint is rate limited and the second answers `result`. Returns the
 * list of addresses fetch was called with, in order.
 */
function stubChain(result: Hex): string[] {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    asked.push(url);
    if (url === BUSY) {
      return new Response("too many requests", { status: 429 });
    }
    const body = JSON.parse(String(init?.body)) as { id: number };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return asked;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Monad transport", () => {
  it("puts the configured endpoint first and the public one behind it", () => {
    const transport = built(monadTransport());

    expect(transport.config.type).toBe("fallback");
    expect(transport.value?.transports?.map((inner) => inner.value?.url)).toEqual([BUSY, SPARE]);
  });

  it("is a plain transport when both names hold the same address", () => {
    const transport = built(monadTransport({ rpcUrl: SPARE }));

    expect(transport.config.type).toBe("http");
    expect(transport.value?.url).toBe(SPARE);
  });
});

describe("an endpoint answering 429", () => {
  it("is followed by the second for a registry read", async () => {
    const asked = stubChain(
      encodeFunctionResult({
        abi: disputeAbi,
        functionName: "getDispute",
        result: { challenger: ZERO_ADDRESS, bond: 0n, evidenceHash: ZERO_HASH, status: 1, openedAt: 0n },
      }),
    );

    const answer = await disputeReader({ address: REGISTRY }).answerFor(PASSPORT);

    expect(answer).toMatchObject({ source: "chain", status: "open" });
    expect(asked).toEqual([BUSY, SPARE]);
  });

  it("is followed by the second for a consent read", async () => {
    const asked = stubChain(
      encodeAbiParameters(consentAbi[0].outputs, [
        true,
        {
          at: 1_788_880_000n,
          writer: HOLDER,
          consent: { aiTraining: 2, aiGenerativeTraining: 2, aiInference: 1, dataMining: 0 },
          constraintInfo: "",
        },
      ]),
    );

    const answer = await consentReader({ address: CONSENT }).answerFor(PASSPORT);

    expect(answer).toMatchObject({ source: "chain", stated: true, aiTraining: "notAllowed" });
    expect(asked).toEqual([BUSY, SPARE]);
  });

  it("is followed by the second for the owner check the edit route makes", async () => {
    const asked = stubChain(
      encodeFunctionResult({ abi: registryEditAbi, functionName: "ownerOf", result: HOLDER }),
    );

    const owner = await parentOwner(readClient(), REGISTRY, PASSPORT);

    expect(owner).toBe(getAddress(HOLDER));
    expect(asked).toEqual([BUSY, SPARE]);
  });
});

describe("a first endpoint that takes the request and never answers", () => {
  it("leaves time for the second to answer the consent and dispute facts inside the five second budget", async () => {
    const consentResult = encodeAbiParameters(consentAbi[0].outputs, [
      true,
      {
        at: 1_788_880_000n,
        writer: HOLDER,
        consent: { aiTraining: 2, aiGenerativeTraining: 1, aiInference: 1, dataMining: 2 },
        constraintInfo: "",
      },
    ]);
    const disputeResult = encodeFunctionResult({
      abi: disputeAbi,
      functionName: "getDispute",
      result: { challenger: ZERO_ADDRESS, bond: 0n, evidenceHash: ZERO_HASH, status: 0, openedAt: 0n },
    });
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      asked.push(url);
      if (url === BUSY) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("the stalled endpoint was given up on")));
        });
      }
      // A healthy endpoint still takes a moment on the wire, so its answer cannot land in the same
      // turn of the event loop as the timer that gives up on the first.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const body = JSON.parse(String(init?.body)) as { id: number; params: [{ to: string }] };
      const to = body.params[0].to.toLowerCase();
      const result = to === CONSENT.toLowerCase() ? consentResult : disputeResult;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const picture: PictureReader = { answerFor: async () => ({ source: "unavailable" }) };
    const payload = { result: { exact: PASSPORT, matches: [{ id: PASSPORT }], best: { id: PASSPORT } } };

    const started = Date.now();
    const answered = await withPassportFacts(
      payload,
      consentReader({ address: CONSENT }),
      disputeReader({ address: REGISTRY }),
      () => undefined,
      picture,
    );
    const took = Date.now() - started;

    const best = (answered.result as { best: Record<string, unknown> }).best;
    expect(best.consent).toMatchObject({ source: "chain", stated: true, aiTraining: "notAllowed", dataMining: "notAllowed" });
    expect(best.dispute).toMatchObject({ source: "chain", status: "none" });
    expect(took).toBeLessThan(5_000);
    expect(asked.filter((url) => url === BUSY)).toHaveLength(2);
    expect(asked.filter((url) => url === SPARE)).toHaveLength(2);
  }, 15_000);

  it("keeps viem's own endpoint timeout for every caller that does not ask for a shorter one", () => {
    const inner = (monadTransport()({}) as unknown as { value: { transports: { config: { timeout: number } }[] } }).value
      .transports;

    expect(inner).toHaveLength(2);
    for (const transport of inner) {
      expect(transport.config.timeout).toBe(10_000);
    }
  });
});
