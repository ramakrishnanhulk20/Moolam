// get_passport carries the trust mark the site shows (L30), issued by the byte-copied mark.ts from
// the same inputs: the registry's dispute status, Chainlink's network verdicts only (L4), the
// passport's own newest valid network look-alike record (L5, L6), and whether it is sealed. A read
// that failed is "unavailable", never a better mark (L32).
// Does NOT cover the hosted index's real answer to these fields, which it serves only after the
// push-day redeploy; the index here is a stub of the query's documented shape.

import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import type { DisputeAnswer } from "../src/disputeRead.js";
import type { McpChain, ChainPassportRecord } from "../src/mcp/chain.js";
import { passportFacts, type McpDeps, type PassportAnswer } from "../src/mcp/facts.js";
import {
  envioMarkReader,
  markAnswer,
  pictureForMark,
  unavailableMarkReader,
  type IndexMarkFacts,
} from "../src/mcp/markFacts.js";
import type { Hex } from "../src/types.js";

const ID = `0x${"7c".repeat(32)}` as Hex;
const EARLIER = `0x${"e1".repeat(32)}` as Hex;
const CREATOR = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as const;

const record: ChainPassportRecord = {
  creator: CREATOR,
  parentId: null,
  generatorAgentId: 0n,
  manifestHash: `0x${"0".repeat(64)}` as Hex,
  kind: 1,
  registeredAt: 1_790_000_000n,
  disputed: false,
  metadataURI: "ipfs://bafkreidocument",
};

const NONE: IndexMarkFacts = { verdicts: [], lookalike: { read: true, record: null } };
const network = (matched: boolean, phashBits = 0) => ({ network: true, matched, phashBits, at: 1_790_000_600 });

function deps(over: {
  index?: IndexMarkFacts;
  dispute?: DisputeAnswer;
  document?: unknown;
  passport?: Partial<ChainPassportRecord>;
  unsealed?: boolean | null;
}): McpDeps {
  const chain = {
    passport: async () => ({ ...record, ...over.passport }),
    holder: async () => CREATOR,
  } as unknown as McpChain;
  const app = {
    verifier: {
      dispute: { answerFor: async () => over.dispute ?? { source: "chain", status: "none", readAt: 1 } },
      indexState: () => ({ stale: false }),
    },
  } as unknown as FastifyInstance;
  return {
    app,
    chain,
    readDocument: async () => {
      if (over.document === undefined) return { name: "Monsoon nets", image: "ipfs://bafkreipicture", thumbnail: "ipfs://bafkreithumb" };
      if (over.document === "unreadable") throw new Error("gateway down");
      return over.document;
    },
    readCard: async () => ({ status: "none", reason: "unreadable" }) as never,
    recent: async () => [],
    handover: async () => ({ firstRecipient: null, confirmedAt: null }),
    platforms: { ok: false, platforms: [], reason: "not under test" },
    mark: { index: async () => over.index ?? NONE, unsealed: async () => (over.unsealed === undefined ? false : over.unsealed) },
  };
}

async function mark(over: Parameters<typeof deps>[0]): Promise<PassportAnswer["mark"]> {
  const answer = await passportFacts(deps(over), ID);
  if (!answer.ok || !answer.value.found) throw new Error("no passport answer");
  return answer.value.mark;
}

describe("L30: get_passport's mark is the site's mark", () => {
  it("issues each state from the same inputs", async () => {
    expect(await mark({})).toEqual({ state: "waiting" });
    expect(await mark({ index: { ...NONE, verdicts: [network(true)] } })).toEqual({ state: "checked", phashDistance: 0, checkedAt: 1_790_000_600 });
    expect(await mark({ index: { ...NONE, verdicts: [network(false, 3)] } })).toMatchObject({ state: "mismatch", secondPrint: true });
    expect(await mark({ index: { ...NONE, verdicts: [network(false, 30)] } })).toMatchObject({ state: "mismatch", secondPrint: false });
    expect(await mark({ dispute: { source: "chain", status: "open", readAt: 1 } })).toEqual({ state: "challenged" });
    expect(await mark({ passport: { disputed: true } })).toEqual({ state: "upheld" });
    expect(await mark({ document: { name: "Kept", sealed: true } })).toEqual({ state: "sealed" });
    expect(await mark({ document: { name: "Kept", sealed: true }, unsealed: true })).toEqual({ state: "waiting" });
    expect(await mark({ document: { name: "No picture" } })).toEqual({ state: "nothing" });
    expect(await mark({ passport: { metadataURI: "https://example.com/doc.json" } })).toEqual({ state: "nothing" });
  });

  it("L4 and L5: lights the look-alike mark only for the network's valid record naming a passport", async () => {
    const found = { network: true, valid: true, earlier: EARLIER, executedAt: 1_790_000_900 };
    expect(await mark({ index: { verdicts: [network(true)], lookalike: { read: true, record: found } } })).toEqual({
      state: "lookalike",
      earlier: EARLIER,
      foundAt: 1_790_000_900,
    });
    expect(await mark({ index: { verdicts: [network(true)], lookalike: { read: true, record: { ...found, network: false } } } })).toMatchObject({ state: "checked" });
    expect(await mark({ index: { verdicts: [network(true)], lookalike: { read: true, record: { ...found, valid: false } } } })).toMatchObject({ state: "checked" });
    expect(await mark({ index: { verdicts: [network(true)], lookalike: { read: true, record: { ...found, earlier: null } } } })).toMatchObject({ state: "checked" });
  });

  it("L32: says unavailable when the index, the dispute or the document could not be read", async () => {
    expect(await mark({ index: { verdicts: null, lookalike: { read: false } } })).toEqual({ state: "unavailable" });
    expect(await mark({ dispute: { source: "unavailable" } })).toEqual({ state: "unavailable" });
    expect(await mark({ document: "unreadable" })).toEqual({ state: "unavailable" });
    expect(await mark({ document: { name: "Kept", sealed: true }, unsealed: null })).toEqual({ state: "unavailable" });
    // Nothing outranks an upheld challenge, so it stands even when the index is down.
    expect(await mark({ passport: { disputed: true }, index: { verdicts: null, lookalike: { read: false } } })).toEqual({ state: "upheld" });
    expect(await unavailableMarkReader()(ID)).toEqual({ verdicts: null, lookalike: { read: false } });
  });

  it("refuses a look-alike that names something other than a passport id", () => {
    expect(
      markAnswer({
        dispute: "none",
        index: { verdicts: [], lookalike: { read: true, record: { network: true, valid: true, earlier: "indexed", executedAt: 1 } } },
        picture: "public",
      }),
    ).toEqual({ state: "unavailable" });
  });

  it("reads the picture state by the site's rule", async () => {
    const read = (document: unknown) => ({ read: true as const, document });
    expect(await pictureForMark(ID, "ipfs://x", read({ image: "ipfs://a" }), async () => null)).toBe("public");
    expect(await pictureForMark(ID, "ipfs://x", { read: false }, async () => null)).toBeNull();
    expect(await pictureForMark(ID, "ipfs://x", read({ sealed: "yes" }), async () => null)).toBeNull();
  });
});

describe("L6 and L4 at the index: one network verdict and the passport's one newest record", () => {
  it("asks for network verdicts only, newest first, and the record keyed by the passport id", async () => {
    const asked: { query: string; variables: { id: string } }[] = [];
    const reader = envioMarkReader("http://127.0.0.1:9/graphql", (async (_url: string, init: { body: string }) => {
      asked.push(JSON.parse(init.body));
      return Response.json({
        data: {
          Attestation: [{ matched: true, distance: 1, at: "1790000600" }],
          Lookalike: [{ earlierId: `0x${"0".repeat(64)}`, network: true, valid: true, executedAt: "1790000900" }],
        },
      });
    }) as unknown as typeof fetch);
    const facts = await reader(ID.toUpperCase().replace("0X", "0x") as Hex);
    expect(asked[0]?.variables).toEqual({ id: ID });
    expect(asked[0]?.query).toContain("network: { _eq: true }");
    expect(asked[0]?.query).toContain("order_by: [{ at: desc }], limit: 1");
    expect(asked[0]?.query).toContain("Lookalike(where: { id: { _eq: $id } }, limit: 1)");
    // A zero earlierId is "none" (L5).
    expect(facts).toEqual({
      verdicts: [{ network: true, matched: true, phashBits: 1, at: 1_790_000_600 }],
      lookalike: { read: true, record: { network: true, valid: true, earlier: null, executedAt: 1_790_000_900 } },
    });
  });

  it("reads an index from before the redeploy, which refuses the query, as unavailable", async () => {
    const reader = envioMarkReader("http://127.0.0.1:9/graphql", (async () =>
      Response.json({ errors: [{ message: "field 'network' not found in type: 'Attestation_bool_exp'" }] })) as unknown as typeof fetch);
    expect(await reader(ID)).toEqual({ verdicts: null, lookalike: { read: false } });
  });
});
