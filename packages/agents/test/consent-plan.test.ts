// Covers the rules a consent plan has to pass before anything reads the chain: the statement
// names, the shape of a passport id, and the three constraint text rules MoolamConsent enforces.
// Also loads the plan this package ships, so a bad edit to it fails here rather than on chain.
// Does NOT cover the chain agreeing. The contract's own copy of these rules is tested in
// packages/contracts, and a dry run of the consent script against the live deployment is what
// proves the two agree there.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPlan, parsePlan, PlanError } from "../src/consent/plan.js";

const PLAN_FILE = join(import.meta.dirname, "..", "consent-plan.json");

const OPEN = {
  name: "open",
  consent: {
    aiTraining: "allowed",
    aiGenerativeTraining: "allowed",
    aiInference: "allowed",
    dataMining: "allowed",
  },
};

const ASK = {
  name: "ask",
  consent: {
    aiTraining: "constrained",
    aiGenerativeTraining: "constrained",
    aiInference: "constrained",
    dataMining: "constrained",
  },
  constraintInfo: "Ask first: open an issue.",
};

const ID_A = `0x${"11".repeat(32)}`;
const ID_B = `0x${"22".repeat(32)}`;

function plan(statements: unknown[], passports: Record<string, string>): unknown {
  return { statements, passports };
}

function problems(value: unknown): string[] {
  try {
    parsePlan(value);
  } catch (error) {
    if (error instanceof PlanError) return error.problems;
    throw error;
  }
  throw new Error("that plan was accepted");
}

describe("the consent plan schema", () => {
  it("turns the words into statements and keeps the passports in the order they are written", () => {
    const parsed = parsePlan(plan([OPEN, ASK], { [ID_A]: "open", [ID_B]: "ask" }));

    expect([...parsed.statements.keys()]).toEqual(["open", "ask"]);
    expect(parsed.statements.get("open")?.constraintInfo).toBe("");
    expect(parsed.entries.map((entry) => [entry.passportId, entry.statement.name])).toEqual([
      [ID_A, "open"],
      [ID_B, "ask"],
    ]);
  });

  it("lowercases every passport id, so the chain reads and the calldata come from one spelling", () => {
    const upper = `0x${"AB".repeat(32)}`;
    const parsed = parsePlan(plan([OPEN], { [upper]: "open" }));

    expect(parsed.entries[0]?.passportId).toBe(upper.toLowerCase());
  });

  it("refuses a statement name nothing defines", () => {
    expect(problems(plan([OPEN], { [ID_A]: "quiet" }))).toEqual([
      `passports.${ID_A}: there is no statement called "quiet"`,
    ]);
  });

  it("refuses an id that is not 32 bytes of hex, and an unknown word", () => {
    expect(problems(plan([OPEN], { "0xabc": "open" })).join(" ")).toContain(
      "it must be 0x and 64 hex characters",
    );
    const wrongWord = { ...OPEN, consent: { ...OPEN.consent, aiTraining: "maybe" } };
    expect(problems(plan([wrongWord], { [ID_A]: "open" })).join(" ")).toContain("aiTraining");
  });

  it("refuses the same passport written twice in different case", () => {
    const lower = `0x${"ab".repeat(32)}`;
    const upper = `0x${"AB".repeat(32)}`;
    expect(problems(plan([OPEN], { [lower]: "open", [upper]: "open" })).join(" ")).toContain(
      "the same passport",
    );
  });

  it("wants constraint text exactly when a use is constrained", () => {
    const askWithNoText = { name: "ask", consent: ASK.consent };
    expect(problems(plan([askWithNoText], { [ID_A]: "ask" })).join(" ")).toContain("needs constraintInfo");

    const openWithText = { ...OPEN, constraintInfo: "nobody asked" };
    expect(problems(plan([openWithText], { [ID_A]: "open" })).join(" ")).toContain("no use here is constrained");
  });

  it("refuses constraint text the contract would refuse: too long, or not printable ASCII", () => {
    const long = { ...ASK, constraintInfo: "a".repeat(257) };
    expect(problems(plan([long], { [ID_A]: "ask" })).join(" ")).toContain("257 bytes");

    const newline = { ...ASK, constraintInfo: "ask first\nthen train" };
    expect(problems(plan([newline], { [ID_A]: "ask" })).join(" ")).toContain("not printable ASCII");

    const accented = { ...ASK, constraintInfo: "ask first, s'il vous plaît" };
    expect(problems(plan([accented], { [ID_A]: "ask" })).join(" ")).toContain("not printable ASCII");
  });

  it("refuses a field the schema does not know rather than dropping it", () => {
    const extra = { ...OPEN, note: "please train" };
    expect(problems(plan([extra], { [ID_A]: "open" })).join(" ")).toContain("note");
  });

  it("loads the plan this package ships: eleven pictures across three statements", () => {
    const shipped = loadPlan(PLAN_FILE);

    expect([...shipped.statements.keys()]).toEqual(["open", "closed", "ask"]);
    expect(shipped.entries).toHaveLength(11);
    expect(shipped.entries.filter((entry) => entry.statement.name === "open")).toHaveLength(4);
    expect(shipped.entries.filter((entry) => entry.statement.name === "closed")).toHaveLength(4);
    expect(shipped.entries.filter((entry) => entry.statement.name === "ask")).toHaveLength(3);
    expect(shipped.statements.get("ask")?.constraintInfo).toMatch(/^Ask first: /);
  });
});
