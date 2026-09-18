// Covers the training consent statement end to end inside a file: what the boundary schema
// accepts and refuses, and what a real signed manifest gives back when the C2PA library's own
// reader opens it again.
// Does NOT cover the two routes, which prepare.test.ts and generate.test.ts do, nor what any
// other reader shows a person: Adobe's verify site and c2patool render assertions their own way
// and neither was run here. It also does not check the statement against a trust list, because
// the development certificate is on none.

import { Reader } from "@contentauth/c2pa-node";
import { describe, expect, it } from "vitest";
import { embedManifest } from "../src/c2pa.js";
import {
  TRAINING_ASSERTION_LABEL,
  TRAINING_STANDARD,
  trainingAssertion,
  trainingSchema,
  trainingStatement,
  type TrainingConsent,
} from "../src/consent.js";
import { fingerprint } from "../src/fingerprint.js";
import { makeImage } from "./helpers.js";

/** Signs a picture with the statement and hands back every assertion the reader finds in it. */
async function signAndRead(seed: number, training?: TrainingConsent): Promise<{ label?: string; data?: unknown }[]> {
  const bytes = await makeImage(seed);
  const print = await fingerprint(bytes);
  const signed = await embedManifest(bytes, {
    title: "consent-test.jpg",
    claimGenerator: "moolam-verifier/0.1.0",
    action: "c2pa.created",
    softBinding: { phash: print.phash, blockhash: print.blockhash },
    training,
  });

  const reader = await Reader.fromAsset({ buffer: signed, mimeType: "image/jpeg" });
  const active = reader?.getActive();
  return active?.assertions ?? [];
}

function trainingEntries(assertions: { label?: string; data?: unknown }[]): unknown {
  const found = assertions.filter((assertion) => assertion.label?.startsWith(TRAINING_ASSERTION_LABEL));
  expect(found.length).toBe(1);
  return (found[0] as { data?: unknown }).data;
}

describe("the training statement inside a signed manifest", () => {
  it("writes each of the three choices and reads them back unchanged", async () => {
    const cases: { use: "allowed" | "notAllowed" | "constrained"; consent: TrainingConsent; entries: unknown }[] = [
      {
        use: "allowed",
        consent: {
          aiTraining: "allowed",
          aiGenerativeTraining: "allowed",
          aiInference: "allowed",
          dataMining: "allowed",
        },
        entries: {
          "cawg.ai_training": { use: "allowed" },
          "cawg.ai_generative_training": { use: "allowed" },
          "cawg.ai_inference": { use: "allowed" },
          "cawg.data_mining": { use: "allowed" },
        },
      },
      {
        use: "notAllowed",
        consent: {
          aiTraining: "notAllowed",
          aiGenerativeTraining: "notAllowed",
          aiInference: "notAllowed",
          dataMining: "notAllowed",
        },
        entries: {
          "cawg.ai_training": { use: "notAllowed" },
          "cawg.ai_generative_training": { use: "notAllowed" },
          "cawg.ai_inference": { use: "notAllowed" },
          "cawg.data_mining": { use: "notAllowed" },
        },
      },
      {
        use: "constrained",
        consent: {
          aiTraining: "constrained",
          aiGenerativeTraining: "constrained",
          aiInference: "constrained",
          dataMining: "constrained",
          constraintInfo: "Ask first: hello@moolam.app",
        },
        entries: {
          "cawg.ai_training": { use: "constrained", constraint_info: "Ask first: hello@moolam.app" },
          "cawg.ai_generative_training": { use: "constrained", constraint_info: "Ask first: hello@moolam.app" },
          "cawg.ai_inference": { use: "constrained", constraint_info: "Ask first: hello@moolam.app" },
          "cawg.data_mining": { use: "constrained", constraint_info: "Ask first: hello@moolam.app" },
        },
      },
    ];

    for (const one of cases) {
      const assertions = await signAndRead(51 + cases.indexOf(one), one.consent);
      expect(trainingEntries(assertions), one.use).toEqual({ entries: one.entries });
    }
  }, 120_000);

  it("writes a mixed statement with only the choices the creator made", async () => {
    const assertions = await signAndRead(55, {
      aiGenerativeTraining: "notAllowed",
      dataMining: "constrained",
      constraintInfo: "may only be mined by researchers, ask hello@moolam.app",
    });

    // The two choices the creator left out carry no entry at all: not stated is not the same as
    // allowed, and the standard has no word for silence.
    expect(trainingEntries(assertions)).toEqual({
      entries: {
        "cawg.ai_generative_training": { use: "notAllowed" },
        "cawg.data_mining": {
          use: "constrained",
          constraint_info: "may only be mined by researchers, ask hello@moolam.app",
        },
      },
    });
  }, 60_000);

  it("writes no assertion at all when the creator said nothing", async () => {
    for (const nothing of [undefined, {} as TrainingConsent]) {
      const assertions = await signAndRead(56, nothing);
      expect(assertions.some((assertion) => assertion.label?.startsWith(TRAINING_ASSERTION_LABEL))).toBe(false);
      expect(assertions.some((assertion) => assertion.label?.startsWith("c2pa.soft-binding"))).toBe(true);
    }
  }, 120_000);

  it("never writes the retired c2pa. label", async () => {
    const assertions = await signAndRead(57, { aiTraining: "notAllowed" });
    expect(assertions.some((assertion) => assertion.label === "c2pa.training-mining")).toBe(false);
    expect(assertions.some((assertion) => assertion.label === TRAINING_ASSERTION_LABEL)).toBe(true);
  }, 60_000);
});

describe("what the boundary takes and refuses", () => {
  it("treats an empty statement, and one with only unstated choices, as nothing said", () => {
    expect(trainingSchema.safeParse({}).data).toBeUndefined();
    expect(trainingSchema.safeParse({ aiTraining: undefined }).data).toBeUndefined();
    expect(trainingAssertion(undefined)).toBeUndefined();
    expect(trainingStatement(undefined)).toBeUndefined();
  });

  it("refuses constraintInfo with nothing constrained, a constrained choice with no note, and a bad choice", () => {
    const refusals: { statement: unknown; field: string }[] = [
      { statement: { aiTraining: "allowed", constraintInfo: "ask me" }, field: "constraintInfo" },
      { statement: { aiTraining: "constrained" }, field: "constraintInfo" },
      { statement: { aiTraining: "maybe" }, field: "aiTraining" },
      { statement: { aiTraining: "constrained", constraintInfo: "x".repeat(257) }, field: "constraintInfo" },
      { statement: { aiTraining: "constrained", constraintInfo: "ask me\nor do not" }, field: "constraintInfo" },
      { statement: { aiTraining: "constrained", constraintInfo: "ask me © 2026" }, field: "constraintInfo" },
    ];

    for (const refusal of refusals) {
      const parsed = trainingSchema.safeParse(refusal.statement);
      expect(parsed.success, JSON.stringify(refusal.statement)).toBe(false);
      const fields = parsed.error?.issues.map((issue) => issue.path.join(".")) ?? [];
      expect(fields, JSON.stringify(refusal.statement)).toContain(refusal.field);
    }
  });

  it("takes a note of exactly 256 bytes and refuses one byte more", () => {
    const full = { aiTraining: "constrained" as const, constraintInfo: "x".repeat(256) };
    expect(trainingSchema.safeParse(full).success).toBe(true);
    expect(trainingSchema.safeParse({ ...full, constraintInfo: "x".repeat(257) }).success).toBe(false);
  });

  it("refuses a key the standard has no room for rather than dropping it", () => {
    const parsed = trainingSchema.safeParse({ aiTraining: "allowed", aiTrainingg: "notAllowed" });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("aiTrainingg");
  });

  it("refuses to write a statement that would not have got past the boundary", () => {
    const broken = { aiTraining: "constrained" } as TrainingConsent;
    expect(() => trainingAssertion(broken)).toThrow(/not one this service may write/);
    expect(() => trainingStatement(broken)).toThrow(/not one this service may write/);
  });

  it("names the standard in the pinned statement and keeps the request's own words", () => {
    expect(trainingStatement({ aiGenerativeTraining: "notAllowed" })).toEqual({
      aiGenerativeTraining: "notAllowed",
      standard: TRAINING_STANDARD,
    });
  });
});
