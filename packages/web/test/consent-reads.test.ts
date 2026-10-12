import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

const held = vi.hoisted(() => ({
  readContract: vi.fn(),
  /** What every held read was filed under, and the options it was filed with. */
  filed: [] as { keyParts: string[]; options: { revalidate?: number; tags?: string[] } }[],
  store: new Map<string, unknown>(),
}));

// The same stand-in the passport hold test uses: Next's cache needs a request
// behind it, which a node test has none of, so answers are kept under the key
// Next would have used and a second ask is served from the hold.
vi.mock("next/cache", () => ({
  unstable_cache: (
    fn: (...args: unknown[]) => Promise<unknown>,
    keyParts: string[],
    options: { revalidate?: number; tags?: string[] },
  ) => {
    held.filed.push({ keyParts, options });
    return async (...args: unknown[]) => {
      const key = [...keyParts, JSON.stringify(args)].join("|");
      if (held.store.has(key)) {
        return held.store.get(key);
      }
      const answer = await fn(...args);
      held.store.set(key, JSON.parse(JSON.stringify(answer)) as unknown);
      return held.store.get(key);
    };
  },
}));

vi.mock("@/lib/chain/client", () => ({
  chain: { readContract: held.readContract },
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
}));

const {
  MalformedConsent,
  entryFrom,
  heldConsent,
  heldConsentHistory,
  passportIdFrom,
  plainStatement,
  secondsFrom,
  asUseWord,
} = await import("@/lib/chain/consent");
const { passportTag } = await import("@/lib/chain/registry");

const ID = "0xCDB25D3755452EFA3B746F168CF9CEFD3A1B693AB2B81D260A2D64F13D771638" as Hex;
const WRITER = "0x85a88Ca81ff5f681D96AB86fa60ccB8452A139a6";

/** The four uses at one value, which is how the eleven real statements were written. */
function all(value: number) {
  return { aiTraining: value, aiGenerativeTraining: value, aiInference: value, dataMining: value };
}

function words(value: "unspecified" | "allowed" | "notAllowed" | "constrained") {
  return { aiTraining: value, aiGenerativeTraining: value, aiInference: value, dataMining: value };
}

function raw(over: Partial<{ at: bigint; writer: string; constraintInfo: string }> = {}, value = 2) {
  return {
    at: 1_789_717_128n,
    writer: WRITER,
    consent: all(value),
    constraintInfo: "",
    ...over,
  };
}

/** The consent register's answers, one per call the held reads make. */
function register(stated = true) {
  return ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case "consentOf":
        return Promise.resolve([stated, raw()] as const);
      case "historyPage":
        return Promise.resolve(stated ? [raw()] : []);
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };
}

beforeEach(() => {
  held.readContract.mockReset();
  held.filed.length = 0;
  held.store.clear();
});

describe("the contract's enum as words", () => {
  it("reads 0 to 3 in the contract's own order", () => {
    expect([0, 1, 2, 3].map(asUseWord)).toEqual(["unspecified", "allowed", "notAllowed", "constrained"]);
  });

  it("guesses at nothing outside the enum", () => {
    expect(asUseWord(4)).toBeUndefined();
    expect(asUseWord(-1)).toBeUndefined();
    expect(asUseWord(1.5)).toBeUndefined();
    expect(asUseWord(Number.NaN)).toBeUndefined();
  });

  it("fails the whole read when one use is outside the enum, rather than half stating it", () => {
    expect(() => entryFrom(raw({}, 9))).toThrow(MalformedConsent);
    expect(() => entryFrom({ ...raw(), writer: "0xnotanaddress" })).toThrow(MalformedConsent);
    expect(() => entryFrom(raw({ at: 2n ** 63n }))).toThrow(MalformedConsent);
  });

  it("keeps a statement the contract could really have written", () => {
    const entry = entryFrom(raw({ constraintInfo: "Ask first" }, 3));
    expect(entry.consent.aiInference).toBe("constrained");
    expect(entry.writer).toBe(WRITER);
    expect(entry.at).toBe(1_789_717_128n);
    expect(entry.constraintInfo).toBe("Ask first");
  });
});

describe("the one plain line a statement reduces to", () => {
  it("names all four allowed as open", () => {
    expect(plainStatement(words("allowed"))).toBe("open");
  });

  it("names all four refused as closed", () => {
    expect(plainStatement(words("notAllowed"))).toBe("closed");
  });

  it("names all four conditional as ask", () => {
    expect(plainStatement(words("constrained"))).toBe("ask");
  });

  it("names nothing stated as none", () => {
    expect(plainStatement(words("unspecified"))).toBe("none");
  });

  it("names anything else with one use stated as mixed", () => {
    expect(plainStatement({ ...words("allowed"), aiTraining: "notAllowed" })).toBe("mixed");
    expect(plainStatement({ ...words("unspecified"), dataMining: "allowed" })).toBe("mixed");
    expect(plainStatement({ ...words("notAllowed"), aiInference: "constrained" })).toBe("mixed");
  });
});

describe("holding one passport's statement", () => {
  it("files it under that passport alone, for a minute, so one write drops one card", async () => {
    held.readContract.mockImplementation(register());

    await heldConsent(ID);
    await heldConsentHistory(ID);

    expect(held.filed[0].keyParts).toEqual(["moolam-consent", ID.toLowerCase()]);
    expect(held.filed[0].options).toEqual({ revalidate: 60, tags: ["moolam-chain", passportTag(ID)] });
    expect(held.filed[1].keyParts).toEqual(["moolam-consent-history", ID.toLowerCase()]);
    expect(held.filed[1].options).toEqual({ revalidate: 60, tags: ["moolam-chain", passportTag(ID)] });
  });

  it("reads the register once for a render that asks twice", async () => {
    held.readContract.mockImplementation(register());

    const first = await heldConsent(ID);
    const second = await heldConsent(ID);

    expect(first.stated).toBe(true);
    expect(second.stated).toBe(true);
    expect(held.readContract).toHaveBeenCalledTimes(1);
  });

  it("hands the timestamp back as a bigint, where it crossed the hold as a string", async () => {
    held.readContract.mockImplementation(register());

    await heldConsent(ID);
    const again = await heldConsent(ID);
    await heldConsentHistory(ID);
    const history = await heldConsentHistory(ID);

    expect(again.entry?.at).toBe(1_789_717_128n);
    expect(again.entry?.consent).toEqual(words("notAllowed"));
    expect(history[0].at).toBe(1_789_717_128n);
  });

  it("says nothing was stated rather than inventing an empty statement", async () => {
    held.readContract.mockImplementation(register(false));

    const reading = await heldConsent(ID);
    expect(reading).toEqual({ stated: false, entry: null });
    expect(await heldConsentHistory(ID)).toEqual([]);
  });
});

describe("what the scrubber's reader accepts", () => {
  it("takes a passport id in either case and hands it on in lower case", () => {
    expect(passportIdFrom(ID)).toBe(ID.toLowerCase());
  });

  it("refuses anything that is not thirty two bytes of hex", () => {
    expect(passportIdFrom("0x1234")).toBeNull();
    expect(passportIdFrom(`0x${"g".repeat(64)}`)).toBeNull();
    expect(passportIdFrom(ID.slice(2))).toBeNull();
    expect(passportIdFrom(null)).toBeNull();
  });

  it("takes a moment written in whole seconds", () => {
    expect(secondsFrom("1789717128")).toBe(1_789_717_128);
    expect(secondsFrom("0")).toBe(0);
  });

  it("refuses a time that is not a number of seconds", () => {
    expect(secondsFrom("yesterday")).toBeNull();
    expect(secondsFrom("17897171.5")).toBeNull();
    expect(secondsFrom("-1")).toBeNull();
    expect(secondsFrom("1e9")).toBeNull();
    expect(secondsFrom("9".repeat(20))).toBeNull();
    expect(secondsFrom(1_789_717_128)).toBeNull();
  });
});

const { daysAcross, secondsForDay, segmentAt, segmentsOf } = await import("@/components/consent/ledger");

/** One statement, in the shape the rule is drawn from. */
function written(at: number, value: "allowed" | "notAllowed" = "notAllowed") {
  return { at, writer: WRITER, consent: words(value), constraintInfo: "" };
}

describe("the passport's life cut into stretches", () => {
  const REGISTERED = 1_788_881_666;
  const STATED = 1_789_717_128;
  const NOW = 1_789_800_000;

  it("draws the stretch before the first statement as nobody having spoken", () => {
    const segments = segmentsOf(REGISTERED, NOW, [written(STATED)]);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ from: REGISTERED, to: STATED, entry: null, summary: "none" });
    expect(segments[1]).toMatchObject({ from: STATED, to: NOW, summary: "closed" });
  });

  it("gives a passport with no statement one stretch and no second one to decorate it with", () => {
    expect(segmentsOf(REGISTERED, NOW, [])).toEqual([
      { from: REGISTERED, to: NOW, entry: null, summary: "none" },
    ]);
  });

  it("ends each statement where the next one begins", () => {
    const segments = segmentsOf(REGISTERED, NOW, [written(STATED), written(STATED + 600, "allowed")]);

    expect(segments.map((segment) => segment.summary)).toEqual(["none", "closed", "open"]);
    expect(segments[1].to).toBe(STATED + 600);
    expect(segments[2].to).toBe(NOW);
  });

  it("finds the stretch a day falls in, including the last one", () => {
    const segments = segmentsOf(REGISTERED, NOW, [written(STATED)]);

    expect(segmentAt(segments, REGISTERED)).toBe(0);
    expect(segmentAt(segments, STATED - 1)).toBe(0);
    expect(segmentAt(segments, STATED)).toBe(1);
    expect(segmentAt(segments, NOW)).toBe(1);
  });

  it("steps a day at a time and never asks about a moment that has not happened", () => {
    expect(daysAcross(REGISTERED, NOW)).toBe(11);
    expect(secondsForDay(0, REGISTERED, NOW)).toBe(REGISTERED);
    expect(secondsForDay(1, REGISTERED, NOW)).toBe(REGISTERED + 86_400);
    expect(secondsForDay(11, REGISTERED, NOW)).toBe(NOW);
  });
});
