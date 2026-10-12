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
  LIST_HOLD_SECONDS: 600,
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

const { GET } = await import("@/app/api/consent-at/route");

const ID = "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638";
const WRITER = "0x85a88Ca81ff5f681D96AB86fa60ccB8452A139a6";
const CLOSED = {
  aiTraining: "notAllowed",
  aiGenerativeTraining: "notAllowed",
  aiInference: "notAllowed",
  dataMining: "notAllowed",
};

/**
 * A moment inside the window the route accepts, kept apart per test so the hold
 * is not in the way. The route rounds every ask down to its minute, so the step
 * is two minutes: one test's question must not land in another's minute.
 */
let moment = 1_789_717_000;

function nextMoment(): number {
  moment += 120;
  return moment;
}

/** The minute an ask falls in, which is what the route reads and answers about. */
function minuteOf(at: number): number {
  return at - (at % 60);
}

function ask(query: string): Request {
  return new Request(`http://localhost:3210/api/consent-at?${query}`);
}

beforeEach(() => {
  chain.consentAt.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("what the scrubber's reader refuses", () => {
  it("turns away an id that is not a passport id, without calling the chain", async () => {
    const answer = await GET(ask(`id=0xnope&at=${nextMoment()}`));

    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: "id must be a passport id: 32 bytes of hex" });
    expect(chain.consentAt).not.toHaveBeenCalled();
  });

  it("turns away a time that is not a number of seconds, without calling the chain", async () => {
    const answer = await GET(ask(`id=${ID}&at=yesterday`));

    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: "at must be a moment since the registry was deployed" });
    expect(chain.consentAt).not.toHaveBeenCalled();
  });

  it("turns away a moment from before the registry existed", async () => {
    const answer = await GET(ask(`id=${ID}&at=1700000000`));

    expect(answer.status).toBe(400);
    expect(chain.consentAt).not.toHaveBeenCalled();
  });

  it("turns away a moment more than a day ahead of now", async () => {
    const twoDaysOn = Math.floor(Date.now() / 1000) + 172_800;
    const answer = await GET(ask(`id=${ID}&at=${twoDaysOn}`));

    expect(answer.status).toBe(400);
    expect(chain.consentAt).not.toHaveBeenCalled();
  });
});

describe("what the scrubber's reader answers", () => {
  it("hands back the statement the chain says was in force, with the moment asked", async () => {
    const at = nextMoment();
    chain.consentAt.mockResolvedValue({
      stated: true,
      entry: { at: 1_789_717_128n, writer: WRITER, consent: CLOSED, constraintInfo: "" },
    });

    const answer = await GET(ask(`id=${ID.toUpperCase().replace("0X", "0x")}&at=${at}`));

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      asked: minuteOf(at),
      stated: true,
      entry: { at: 1_789_717_128, writer: WRITER, consent: CLOSED, constraintInfo: "" },
    });
    expect(chain.consentAt).toHaveBeenCalledWith(ID, minuteOf(at));
  });

  it("lets a shared cache hold the answer to a whole minute for a minute", async () => {
    chain.consentAt.mockResolvedValue({ stated: false, entry: null });

    const answer = await GET(ask(`id=${ID}&at=${minuteOf(nextMoment())}`));
    expect(answer.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=60");
  });

  it("refuses the shared cache an ask that carries seconds, which would be sixty entries for one answer", async () => {
    chain.consentAt.mockResolvedValue({ stated: false, entry: null });
    const at = nextMoment();
    expect(at % 60, "the fixture has to carry seconds for this to mean anything").not.toBe(0);

    const answer = await GET(ask(`id=${ID}&at=${at}`));

    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers the same moment twice without asking the chain twice", async () => {
    const at = nextMoment();
    chain.consentAt.mockResolvedValue({ stated: false, entry: null });

    const first = await GET(ask(`id=${ID}&at=${at}`));
    const second = await GET(ask(`id=${ID}&at=${at}`));

    expect(await first.json()).toEqual(await second.json());
    expect(chain.consentAt).toHaveBeenCalledTimes(1);
  });

  it("says nothing was stated rather than answering with an empty statement", async () => {
    const at = nextMoment();
    chain.consentAt.mockResolvedValue({ stated: false, entry: null });

    const answer = await GET(ask(`id=${ID}&at=${at}`));
    expect(await answer.json()).toEqual({ asked: minuteOf(at), stated: false, entry: null });
  });

  it("answers 503 for a failed read, with no endpoint or address in the body", async () => {
    chain.consentAt.mockRejectedValue(new Error("the endpoint refused"));

    const answer = await GET(ask(`id=${ID}&at=${nextMoment()}`));

    expect(answer.status).toBe(503);
    const body = (await answer.json()) as { error: string };
    expect(body.error).toBe("the endpoint refused");
    expect(body.error).not.toMatch(/https?:\/\/|0x[0-9a-fA-F]{20}/);
  });

  it("never holds a failed read, so the next reader gets a real attempt", async () => {
    const at = nextMoment();
    chain.consentAt.mockRejectedValueOnce(new Error("the endpoint refused"));
    chain.consentAt.mockResolvedValueOnce({ stated: false, entry: null });

    expect((await GET(ask(`id=${ID}&at=${at}`))).status).toBe(503);
    expect((await GET(ask(`id=${ID}&at=${at}`))).status).toBe(200);
    expect(chain.consentAt).toHaveBeenCalledTimes(2);
  });
});
