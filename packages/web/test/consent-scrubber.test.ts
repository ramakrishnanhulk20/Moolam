import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chain = vi.hoisted(() => ({ consentAt: vi.fn() }));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => Promise<unknown>) => fn,
}));

// The route only wants the reader and the error line, and pulling in the real
// client would open a viem transport inside a node test.
vi.mock("@/lib/chain/client", () => ({
  chain: { readContract: vi.fn() },
  addresses: {
    registry: "0x0000000000000000000000000000000000000001",
    policy: "0x0000000000000000000000000000000000000002",
    consent: "0x1151E69a82947920546e779c4C8c785b2a3C1277",
  },
  registryAbi: [],
  policyAbi: [],
  consentAbi: [],
  CACHE_TAGS: { index: "moolam-index", chain: "moolam-chain", metadata: "moolam-metadata" },
  HOLD_SECONDS: 60,
  REPUTATION_REGISTRY: "0x0000000000000000000000000000000000000003",
  gatewayUrl: (uri: string) => uri,
  reason: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

// Everything except the live read is the real module, so the id and the time
// are checked by the same two functions the app uses.
vi.mock("@/lib/chain/consent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chain/consent")>()),
  consentAt: chain.consentAt,
}));

const { GET } = await import("@/app/api/lab/consent-at/route");

const ID = "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638";
const WRITER = "0x85a88Ca81ff5f681D96AB86fa60ccB8452A139a6";

function ask(query: string): Request {
  return new Request(`http://localhost:3210/api/lab/consent-at?${query}`);
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_LAB_PAGES = "1";
  chain.consentAt.mockReset();
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_LAB_PAGES;
});

describe("what the scrubber's reader refuses", () => {
  it("turns away an id that is not a passport id, without calling the chain", async () => {
    const answer = await GET(ask(`id=0xnope&at=1789717128`));

    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: "id must be a passport id: 32 bytes of hex" });
    expect(chain.consentAt).not.toHaveBeenCalled();
  });

  it("turns away a time that is not a number of seconds, without calling the chain", async () => {
    const answer = await GET(ask(`id=${ID}&at=yesterday`));

    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: "at must be a moment in whole seconds" });
    expect(chain.consentAt).not.toHaveBeenCalled();
  });

  it("exists only where the lab pages do", async () => {
    delete process.env.NEXT_PUBLIC_LAB_PAGES;
    const answer = await GET(ask(`id=${ID}&at=1789717128`));

    expect(answer.status).toBe(404);
    expect(chain.consentAt).not.toHaveBeenCalled();
  });
});

describe("what the scrubber's reader answers", () => {
  it("hands back the statement the chain says was in force, with the moment asked", async () => {
    chain.consentAt.mockResolvedValue({
      stated: true,
      entry: {
        at: 1_789_717_128n,
        writer: WRITER,
        consent: {
          aiTraining: "notAllowed",
          aiGenerativeTraining: "notAllowed",
          aiInference: "notAllowed",
          dataMining: "notAllowed",
        },
        constraintInfo: "",
      },
    });

    const answer = await GET(ask(`id=${ID.toUpperCase().replace("0X", "0x")}&at=1789717200`));

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      asked: 1_789_717_200,
      stated: true,
      entry: {
        at: 1_789_717_128,
        writer: WRITER,
        consent: {
          aiTraining: "notAllowed",
          aiGenerativeTraining: "notAllowed",
          aiInference: "notAllowed",
          dataMining: "notAllowed",
        },
        constraintInfo: "",
      },
    });
    expect(chain.consentAt).toHaveBeenCalledWith(ID, 1_789_717_200);
  });

  it("says nothing was stated rather than answering with an empty statement", async () => {
    chain.consentAt.mockResolvedValue({ stated: false, entry: null });

    const answer = await GET(ask(`id=${ID}&at=1789713528`));
    expect(await answer.json()).toEqual({ asked: 1_789_713_528, stated: false, entry: null });
  });

  it("passes a failed read on as one line, with no endpoint in it", async () => {
    chain.consentAt.mockRejectedValue(new Error("the endpoint refused"));

    const answer = await GET(ask(`id=${ID}&at=1789717128`));
    expect(answer.status).toBe(502);
    expect(await answer.json()).toEqual({ error: "the endpoint refused" });
  });
});
