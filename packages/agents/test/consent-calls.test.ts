// Covers the decisions made between reading the chain and sending: refusing a passport this
// wallet does not hold, skipping a picture whose newest entry already says what the plan says,
// grouping what is left into batches of at most 32, and the bytes of the call itself, decoded
// back with the deployed contract's own ABI.
// Does NOT cover the reads that feed it or the send. Those need the live chain, and the dry run
// saved in kitchen/reports/WO-88-dry-run.txt is where they are proven.

import { describe, expect, it } from "vitest";
import { decodeFunctionData, type Hex } from "viem";
import { consentAbi } from "../src/consent/abi.js";
import { batchCalldata, NotTheHolder, planWork, type ChainView } from "../src/consent/calls.js";
import { parsePlan, type Plan } from "../src/consent/plan.js";
import { consentValues, type OnChainEntry, type Statement } from "../src/consent/statements.js";

const WALLET = "0x85a88Ca81ff5f681D96AB86fa60ccB8452A139a6" as Hex;
const STRANGER = "0x000000000000000000000000000000000000dEaD" as Hex;
const NOBODY = "0x0000000000000000000000000000000000000000" as Hex;

const STATEMENTS = [
  {
    name: "open",
    consent: {
      aiTraining: "allowed",
      aiGenerativeTraining: "allowed",
      aiInference: "allowed",
      dataMining: "allowed",
    },
  },
  {
    name: "closed",
    consent: {
      aiTraining: "notAllowed",
      aiGenerativeTraining: "notAllowed",
      aiInference: "notAllowed",
      dataMining: "notAllowed",
    },
  },
  {
    name: "ask",
    consent: {
      aiTraining: "constrained",
      aiGenerativeTraining: "constrained",
      aiInference: "constrained",
      dataMining: "constrained",
    },
    constraintInfo: "Ask first: open an issue.",
  },
];

function id(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}` as Hex;
}

function planOf(passports: Record<string, string>): Plan {
  return parsePlan({ statements: STATEMENTS, passports });
}

function chainOf(plan: Plan, options: { holder?: Hex; latest?: Map<Hex, OnChainEntry> } = {}): ChainView {
  const holders = new Map<Hex, Hex>();
  for (const entry of plan.entries) holders.set(entry.passportId, options.holder ?? WALLET);
  return { wallet: WALLET, holders, latest: options.latest ?? new Map() };
}

function entryFor(statement: Statement, writer: Hex = WALLET): OnChainEntry {
  return {
    at: 1_788_000_000n,
    writer,
    consent: consentValues(statement.consent),
    constraintInfo: statement.constraintInfo,
  };
}

describe("planning the consent calls", () => {
  it("refuses the whole run when one passport is held by somebody else", () => {
    const plan = planOf({ [id(1)]: "open", [id(2)]: "open" });
    const chain = chainOf(plan);
    chain.holders.set(id(2), STRANGER);

    expect(() => planWork(plan, chain)).toThrow(NotTheHolder);
    try {
      planWork(plan, chain);
    } catch (error) {
      expect((error as NotTheHolder).refused).toEqual([{ passportId: id(2), holder: STRANGER }]);
      expect((error as NotTheHolder).message).toContain(id(2));
    }
  });

  it("refuses a passport the registry knows no holder for", () => {
    const plan = planOf({ [id(1)]: "open" });
    const chain = chainOf(plan, { holder: NOBODY });

    expect(() => planWork(plan, chain)).toThrow(/nobody on this registry/);
  });

  it("skips a picture whose newest entry already says what the plan says", () => {
    const plan = planOf({ [id(1)]: "open", [id(2)]: "closed" });
    const open = plan.statements.get("open") as Statement;
    const latest = new Map<Hex, OnChainEntry>([[id(1), entryFor(open)]]);

    const work = planWork(plan, chainOf(plan, { latest }));

    expect(work.rows.map((row) => row.action)).toEqual(["skip", "send"]);
    expect(work.calls).toHaveLength(1);
    expect(work.calls[0]?.passportIds).toEqual([id(2)]);
  });

  it("sends again when the entry on chain is a different statement, and sends nothing when every entry matches", () => {
    const plan = planOf({ [id(1)]: "open" });
    const open = plan.statements.get("open") as Statement;
    const closed = plan.statements.get("closed") as Statement;

    const different = planWork(plan, chainOf(plan, { latest: new Map([[id(1), entryFor(closed)]]) }));
    expect(different.calls).toHaveLength(1);

    const same = planWork(plan, chainOf(plan, { latest: new Map([[id(1), entryFor(open)]]) }));
    expect(same.calls).toHaveLength(0);
    expect(same.rows.every((row) => row.action === "skip")).toBe(true);
  });

  it("counts a constrained entry as a match only when the text is the same too", () => {
    const plan = planOf({ [id(1)]: "ask" });
    const ask = plan.statements.get("ask") as Statement;
    const otherText = { ...entryFor(ask), constraintInfo: "Ask first: email us." };

    expect(planWork(plan, chainOf(plan, { latest: new Map([[id(1), otherText]]) })).calls).toHaveLength(1);
    expect(planWork(plan, chainOf(plan, { latest: new Map([[id(1), entryFor(ask)]]) })).calls).toHaveLength(0);
  });

  it("groups by identical statement and cuts each group into batches of at most 32", () => {
    const passports: Record<string, string> = {};
    for (let n = 1; n <= 40; n += 1) passports[id(n)] = "open";
    for (let n = 41; n <= 45; n += 1) passports[id(n)] = "closed";
    const plan = planOf(passports);

    const work = planWork(plan, chainOf(plan));

    expect(work.calls.map((call) => [call.statement.name, call.passportIds.length])).toEqual([
      ["open", 32],
      ["open", 8],
      ["closed", 5],
    ]);
    expect(work.calls.every((call) => call.passportIds.length <= 32)).toBe(true);
    expect(work.calls.flatMap((call) => call.passportIds)).toHaveLength(45);
  });

  it("builds calldata the deployed ABI decodes back to the same passports, numbers and text", () => {
    const plan = planOf({ [id(1)]: "ask", [id(2)]: "ask" });
    const ask = plan.statements.get("ask") as Statement;

    const work = planWork(plan, chainOf(plan));
    const data = work.calls[0]?.data as Hex;
    const decoded = decodeFunctionData({ abi: consentAbi(), data });

    expect(decoded.functionName).toBe("setConsentBatch");
    expect(decoded.args?.[0]).toEqual([id(1), id(2)]);
    expect(decoded.args?.[1]).toEqual({
      aiTraining: 3,
      aiGenerativeTraining: 3,
      aiInference: 3,
      dataMining: 3,
    });
    expect(decoded.args?.[2]).toBe("Ask first: open an issue.");
    expect(data).toBe(batchCalldata(ask, [id(1), id(2)]));
  });

  it("maps the words onto the contract's enum: unspecified 0, allowed 1, notAllowed 2, constrained 3", () => {
    const plan = planOf({ [id(1)]: "open", [id(2)]: "closed" });
    const open = plan.statements.get("open") as Statement;
    const closed = plan.statements.get("closed") as Statement;

    expect(consentValues(open.consent)).toEqual({
      aiTraining: 1,
      aiGenerativeTraining: 1,
      aiInference: 1,
      dataMining: 1,
    });
    const decoded = decodeFunctionData({ abi: consentAbi(), data: batchCalldata(closed, [id(2)]) });
    expect(decoded.args?.[1]).toEqual({
      aiTraining: 2,
      aiGenerativeTraining: 2,
      aiInference: 2,
      dataMining: 2,
    });
  });

  it("refuses to build a batch with no passports or more than 32", () => {
    const plan = planOf({ [id(1)]: "open" });
    const open = plan.statements.get("open") as Statement;

    expect(() => batchCalldata(open, [])).toThrow(/between 1 and 32/);
    expect(() => batchCalldata(open, Array.from({ length: 33 }, (_, n) => id(n + 1)))).toThrow(/between 1 and 32/);
  });
});
