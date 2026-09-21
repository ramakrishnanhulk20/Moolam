import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Hex } from "viem";
import type { Consent } from "@/lib/chain/consent";
import type { StoryData, StoryFocal, StoryStatement } from "@/components/story/data";
import { STATED_COPY, statedWhyNot } from "@/components/story/statedCopy";
import { InlineLedger, ledgerShape } from "@/components/story/StatedLedger";
import { fractionOf } from "@/components/consent/ledger";

/**
 * The beat about the holder's word on AI use.
 *
 * The one thing that must never happen here is a beat that says something the
 * chain did not. So the cases below are the three ways there is nothing to say,
 * and then the drawing, checked against the statement it was handed.
 */

const PASSPORT = `0x${"f0".repeat(32)}` as Hex;
const WRITER = "0x85a88Ca81ff5f681D96AB86fa60ccB8452A139a6" as Hex;

/** Registered on 17 September 2026, spoken for on the 18th, read on the 21st. */
const REGISTERED = 1_789_648_000;
const WRITTEN = 1_789_717_128;
const NOW = 1_789_990_000;

const CLOSED: Consent = {
  aiTraining: "notAllowed",
  aiGenerativeTraining: "notAllowed",
  aiInference: "notAllowed",
  dataMining: "notAllowed",
};

const NOTHING: Consent = {
  aiTraining: "unspecified",
  aiGenerativeTraining: "unspecified",
  aiInference: "unspecified",
  dataMining: "unspecified",
};

const focal: StoryFocal = {
  id: PASSPORT,
  picture: "https://example.test/picture.jpg",
  creator: WRITER,
  agentId: "7",
  registeredAt: REGISTERED,
  block: "12345678",
  kind: 0,
  manifest: true,
  attestations: 1,
  why: "full",
  measured: false,
};

const statement: StoryStatement = {
  summary: "closed",
  consent: CLOSED,
  at: WRITTEN,
  writer: WRITER,
  constraintInfo: "",
};

function story(over: Partial<StoryData> = {}): StoryData {
  return {
    source: "envio",
    plates: [],
    focal,
    attestation: null,
    agent: null,
    statement,
    statementError: null,
    passportCount: 12,
    attestationCount: 3,
    error: null,
    ...over,
  };
}

describe("when the beat cannot be told", () => {
  it("plays the film as it ships when nobody has written a statement", () => {
    expect(statedWhyNot(story({ statement: null }))).toContain("Nobody has written a statement");
  });

  it("says so in the register's own words when the read failed, rather than calling it silence", () => {
    const why = statedWhyNot(story({ statement: null, statementError: "the endpoint answered 503" }));
    expect(why).toContain("the endpoint answered 503");
    expect(why).not.toContain("Nobody has written");
  });

  it("refuses a statement that speaks about none of the four uses", () => {
    expect(statedWhyNot(story({ statement: { ...statement, summary: "none", consent: NOTHING } }))).toContain(
      "speaks about none of the four uses",
    );
  });

  it("refuses a beat with no passport to tell it on", () => {
    expect(statedWhyNot(story({ focal: null, statement: null }))).toContain("No passport could be read");
  });

  it("is happy only when the register really answered for this passport", () => {
    expect(statedWhyNot(story())).toBeNull();
  });
});

describe("the words of the beat", () => {
  it("is the statement's own plain summary, said as a sentence", () => {
    expect(STATED_COPY.title("closed")).toBe("Not for AI training.");
    expect(STATED_COPY.title("open")).toBe("Open to AI use.");
    expect(STATED_COPY.title("ask")).toBe("Ask the holder first.");
    expect(STATED_COPY.title("mixed")).toBe("Stated use by use.");
  });

  it("quotes the day the statement was written, in the words it was handed", () => {
    expect(STATED_COPY.readout("18 September 2026")).toContain("18 September 2026");
    expect(STATED_COPY.readout("18 September 2026")).toContain("Monad");
  });

  it("names the four uses the contract stores, in its order", () => {
    expect(STATED_COPY.uses).toEqual(["AI training", "Generative AI", "Inference", "Data mining"]);
  });
});

describe("the drawing", () => {
  const view = {
    consent: CLOSED,
    notch: fractionOf(WRITTEN, REGISTERED, NOW),
    registered: "17 Sep 2026",
    writtenShort: "18 Sep 2026",
  };

  it("puts the notch where the statement really falls between the registration day and today", () => {
    expect(view.notch).toBeCloseTo((WRITTEN - REGISTERED) / (NOW - REGISTERED), 12);
    expect(view.notch).toBeGreaterThan(0);
    expect(view.notch).toBeLessThan(1);
  });

  it("draws the rule first, lands the notch as the rule reaches it, then stamps the four marks in turn", () => {
    expect(ledgerShape(0, view.notch)).toEqual({ drawn: 0, landed: 0, marks: [0, 0, 0, 0] });

    const early = ledgerShape(0.1, view.notch);
    expect(early.drawn).toBeGreaterThan(0);
    expect(early.marks.every((mark) => mark === 0)).toBe(true);

    const drawn = ledgerShape(0.5, view.notch);
    expect(drawn.drawn).toBeCloseTo(1, 6);
    expect(drawn.landed).toBe(1);

    // One after another, never all at once.
    const stamping = ledgerShape(0.62, view.notch);
    expect(stamping.marks[0]).toBe(1);
    expect(stamping.marks[3]).toBeLessThan(1);

    const done = ledgerShape(1, view.notch);
    expect(done.marks).toEqual([1, 1, 1, 1]);
  });

  it("has all four marks down before the words begin to leave", () => {
    // The caption starts to fade at the end of its own reading, and the beat's
    // own movement runs over 0.92 of it.
    expect(ledgerShape(0.9, view.notch).marks).toEqual([1, 1, 1, 1]);
  });

  it("draws the statement the chain gave and nothing else", () => {
    const markup = renderToStaticMarkup(createElement(InlineLedger, { view }));

    // The struck square is the not-allowed mark in components/consent/Marks.tsx.
    expect(markup.split("M1.8 10.2 L10.2 1.8").length - 1).toBe(4);
    expect(markup).not.toContain("strokeDasharray");
    expect(markup).toContain("17 Sep 2026");
    expect(markup).toContain("18 Sep 2026");
    expect(markup).toContain(STATED_COPY.today);
    for (const use of STATED_COPY.uses) {
      expect(markup).toContain(use);
    }
  });

  it("draws a mixed statement use by use rather than folding it into one answer", () => {
    const mixed: Consent = { ...CLOSED, aiInference: "allowed", dataMining: "constrained" };
    const markup = renderToStaticMarkup(createElement(InlineLedger, { view: { ...view, consent: mixed } }));

    // Two struck, one filled square, one half filled: the card's own shapes.
    expect(markup.split("M1.8 10.2 L10.2 1.8").length - 1).toBe(2);
    expect(markup).toContain('fill="currentColor"');
    expect(markup).toContain("M1 1 L11 11 L1 11 Z");
  });
});
