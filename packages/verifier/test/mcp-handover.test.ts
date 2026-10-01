// Covers the index read behind the platform credit: one query per passport for its first handover
// and its consent entries, the confirmation taken by confirmedAtFor across the index's lowercase
// addresses, and every way the read fails closed (an index without the new fields, a GraphQL error,
// a passport the index does not hold, half a handover, a confirmation dated before the handover, a
// history longer than one read), plus the per-passport memory that never keeps a failure.
// Does NOT cover the live Envio index (every answer here is a stub fetch), the index's own handler,
// which packages/indexer's tests cover, or how passportFacts uses the answer, which
// mcp-tools.test.ts covers.

import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  HANDOVER_ENTRIES_MAX,
  envioHandoverReader,
  handoverFromIndex,
  unavailableHandoverReader,
} from "../src/mcp/handover.js";
import type { Hex } from "../src/types.js";

const ID = `0x${"ab".repeat(32)}` as Hex;
const PLATFORM = "0x1111111111111111111111111111111111111111";
const PERSON = "0xabcdef0123456789abcdef0123456789abcdef01";
const BUYER = "0x3333333333333333333333333333333333333333";

function answer(
  passport: Record<string, unknown> | null,
  entries: { writer: string; at: string | number }[] = [],
): unknown {
  return { data: { Passport: passport === null ? [] : [passport], ConsentEntry: entries } };
}

function handed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { firstTransferTo: PERSON, firstTransferAt: "2000", consentCount: 0, ...overrides };
}

describe("handoverFromIndex", () => {
  it("credits the first recipient's earliest entry and ignores the platform's and a buyer's", () => {
    const entries = [
      { writer: PLATFORM, at: "1600" },
      { writer: PERSON, at: "2500" },
      { writer: BUYER, at: 2700 },
      { writer: PERSON, at: "2900" },
    ];
    expect(handoverFromIndex(answer(handed({ consentCount: 4 }), entries))).toEqual({
      firstRecipient: getAddress(PERSON),
      confirmedAt: 2_500n,
    });
  });

  it("reads a first recipient with no entry of their own as not confirmed", () => {
    const entries = [{ writer: BUYER, at: "2700" }];
    expect(handoverFromIndex(answer(handed({ consentCount: 1 }), entries))).toEqual({
      firstRecipient: getAddress(PERSON),
      confirmedAt: null,
    });
  });

  it("reads a passport that never left the creator as no handover", () => {
    const body = answer(handed({ firstTransferTo: null, firstTransferAt: null, consentCount: 1 }), [{ writer: PLATFORM, at: "1600" }]);
    expect(handoverFromIndex(body)).toEqual({ firstRecipient: null, confirmedAt: null });
  });

  it.each([
    ["an index deployed before the handover fields", { errors: [{ message: "field 'firstTransferTo' not found in type: 'Passport'" }] }],
    ["an answer missing the new fields", answer({ consentCount: 0 })],
    ["a GraphQL error beside data", { ...(answer(handed()) as object), errors: [{ message: "busy" }] }],
    ["a passport the index does not hold", answer(null)],
    ["half a handover", answer(handed({ firstTransferAt: null }))],
    ["a confirmation dated before the handover", answer(handed({ consentCount: 1 }), [{ writer: PERSON, at: "1999" }])],
    ["a recipient that is not an address", answer(handed({ firstTransferTo: "0x1234" }))],
  ])("refuses %s", (_case, body) => {
    expect(() => handoverFromIndex(body)).toThrow();
  });

  it("refuses to say 'not confirmed' when the history is longer than one read and the recipient is not in it", () => {
    const page = Array.from({ length: HANDOVER_ENTRIES_MAX }, (_, n) => ({ writer: BUYER, at: String(2_100 + n * 600) }));
    expect(() => handoverFromIndex(answer(handed({ consentCount: HANDOVER_ENTRIES_MAX + 1 }), page))).toThrow();
    const found = [{ writer: PERSON, at: "2050" }, ...page.slice(1)];
    expect(handoverFromIndex(answer(handed({ consentCount: HANDOVER_ENTRIES_MAX + 1 }), found)).confirmedAt).toBe(2_050n);
  });
});

describe("envioHandoverReader", () => {
  it("asks once per passport whatever the spelling, and never keeps a failure", async () => {
    const bodies: { variables: { id: string; limit: number } }[] = [];
    const statuses = [503, 200];
    const fetchStub = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as { variables: { id: string; limit: number } });
      const status = statuses.shift() ?? 200;
      return new Response(JSON.stringify(answer(handed())), { status });
    }) as unknown as typeof fetch;
    const read = envioHandoverReader("https://index.example/v1/graphql", fetchStub);

    await expect(read(ID)).rejects.toThrow();
    expect(await read(ID.toUpperCase().replace("0X", "0x") as Hex)).toEqual({ firstRecipient: getAddress(PERSON), confirmedAt: null });
    expect(await read(ID)).toEqual({ firstRecipient: getAddress(PERSON), confirmedAt: null });
    expect(bodies).toHaveLength(2);
    expect(bodies.map((body) => body.variables)).toEqual([
      { id: ID, limit: HANDOVER_ENTRIES_MAX },
      { id: ID, limit: HANDOVER_ENTRIES_MAX },
    ]);
  });

  it("has nothing to say on a host with no index", async () => {
    await expect(unavailableHandoverReader()(ID)).rejects.toThrow();
  });
});
