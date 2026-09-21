import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type { Hex } from "viem";
import type { Consent } from "@/lib/chain/consent";
import type { StoryData, StoryFocal, StoryStatement } from "@/components/story/data";
import { statedBlock, storyCut } from "@/components/story/stated";
import { InlineLedger, ledgerShape } from "@/components/story/StatedLedger";
import { fractionOf } from "@/components/consent/ledger";
import en from "@/messages/en.json";

/**
 * The beat about the holder's word on AI use.
 *
 * The one thing that must never happen here is a beat that says something the
 * chain did not. So the cases below are the three ways there is nothing to say,
 * and then the drawing, checked against the statement it was handed.
 */

type Tree = Record<string, unknown>;

const PASSPORT = `0x${"f0".repeat(32)}` as Hex;
const WRITER = "0x85a88Ca81ff5f681D96AB86fa60ccB8452A139a6" as Hex;

/** The drawing reads its labels from the message files, as it does in the film. */
function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

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
    expect(statedBlock(story({ statement: null }))).toBe("silence");
  });

  it("keeps a read that failed apart from silence, so neither is told as the other", () => {
    expect(statedBlock(story({ statement: null, statementError: "the endpoint answered 503" }))).toBe("readFailed");
  });

  it("refuses a statement that speaks about none of the four uses", () => {
    expect(statedBlock(story({ statement: { ...statement, summary: "none", consent: NOTHING } }))).toBe("nothingStated");
  });

  it("refuses a beat with no passport to tell it on", () => {
    expect(statedBlock(story({ focal: null, statement: null }))).toBe("noPassport");
  });

  it("is happy only when the register really answered for this passport", () => {
    expect(statedBlock(story())).toBeNull();
  });
});

/**
 * The home page asks for the stated cut on every visit. What it gets on a day
 * with nothing to draw is the film Ram approved, unchanged, and that fallback
 * is this. The page itself is read from disk, because a page that quietly went
 * back to the classic cut would pass every other test in this file.
 */
describe("the cut the home page really plays", () => {
  it("asks for the stated cut", () => {
    const page = readFileSync("app/[locale]/page.tsx", "utf8");
    expect(page).toContain('variant="stated"');
  });

  it("plays it when the register answered for this passport", () => {
    expect(storyCut("stated", story())).toBe("stated");
  });

  it("falls back to the approved film when there is no statement to draw", () => {
    expect(storyCut("stated", story({ statement: null }))).toBe("classic");
    expect(storyCut("stated", story({ statement: null, statementError: "the endpoint answered 503" }))).toBe("classic");
    expect(storyCut("stated", story({ focal: null, statement: null }))).toBe("classic");
    expect(storyCut("stated", story({ statement: { ...statement, summary: "none", consent: NOTHING } }))).toBe(
      "classic",
    );
  });

  it("never reaches the new beat from the classic cut, whatever the day holds", () => {
    expect(storyCut("classic", story())).toBe("classic");
  });
});

/**
 * The chapter's words, counted in every language.
 *
 * A key written in English only leaves nine languages reading the key itself
 * where the sentence should be, in the middle of the film. So the English tree
 * is the list, every file on disk is counted against it, and the count is
 * printed: ten for each key.
 */
describe("the chapter in ten languages", () => {
  const locales = readdirSync("messages")
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(".json", ""));

  const files = new Map(
    locales.map((locale) => [locale, JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")) as Tree]),
  );

  const keys = Object.keys(en.story.stated);

  /** The long dash Ram's house rules ban, built from its code point. */
  const LONG_DASH = String.fromCodePoint(0x2014);

  it("is ten message files", () => {
    expect(locales.length).toBe(10);
  });

  it("carries every key of the chapter in all ten, and says so", () => {
    const counted: string[] = [];

    for (const key of keys) {
      let found = 0;
      for (const [locale, tree] of files) {
        const value = (tree.story as Tree).stated as Tree;
        expect(typeof value[key], `${locale}.story.stated.${key}`).toBe("string");
        expect((value[key] as string).trim().length, `${locale}.story.stated.${key}`).toBeGreaterThan(0);
        found += 1;
      }
      counted.push(`story.stated.${key} ${found}`);
      expect(found, key).toBe(10);
    }

    console.log(counted.join("\n"));
    console.log(`${keys.length} stated keys, each in ${locales.length} message files`);
  });

  it("keeps the placeholders the film fills in every language", () => {
    for (const [locale, tree] of files) {
      const stated = (tree.story as Tree).stated as Record<string, string>;
      expect(stated.title, locale).toContain("{summary}");
      expect(stated.readout, locale).toContain("{written}");
      expect(stated.registered, locale).toContain("{when}");
    }
  });

  it("says the summary in the passport card's own words rather than a second set", () => {
    const film = readFileSync("components/story/LandingStory.tsx", "utf8");
    expect(film).toContain('useTranslations("passport.consent.summary")');
    const ledger = readFileSync("components/story/StatedLedger.tsx", "utf8");
    expect(ledger).toContain('useTranslations("passport.consent.usesShort")');
  });

  it("writes each language in its own words, not in English", () => {
    for (const locale of ["ta", "hi", "zh", "ja", "ko"]) {
      const body = ((files.get(locale)?.story as Tree).stated as Record<string, string>).body;
      expect(body, locale).not.toBe(en.story.stated.body);
      expect(body, locale).toMatch(/[^ -]/);
    }
  });

  it("has none of the long dash in any language", () => {
    for (const [locale, tree] of files) {
      for (const [key, value] of Object.entries((tree.story as Tree).stated as Record<string, string>)) {
        expect(value, `${locale}.story.stated.${key}`).not.toContain(LONG_DASH);
      }
    }
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
    const markup = render(createElement(InlineLedger, { view }));

    // The struck square is the not-allowed mark in components/consent/Marks.tsx.
    expect(markup.split("M1.8 10.2 L10.2 1.8").length - 1).toBe(4);
    expect(markup).not.toContain("strokeDasharray");
    expect(markup).toContain("17 Sep 2026");
    expect(markup).toContain("18 Sep 2026");
    expect(markup).toContain(en.story.stated.today);
    for (const use of Object.values(en.passport.consent.usesShort)) {
      expect(markup).toContain(use);
    }
  });

  it("draws a mixed statement use by use rather than folding it into one answer", () => {
    const mixed: Consent = { ...CLOSED, aiInference: "allowed", dataMining: "constrained" };
    const markup = render(createElement(InlineLedger, { view: { ...view, consent: mixed } }));

    // Two struck, one filled square, one half filled: the card's own shapes.
    expect(markup.split("M1.8 10.2 L10.2 1.8").length - 1).toBe(2);
    expect(markup).toContain('fill="currentColor"');
    expect(markup).toContain("M1 1 L11 11 L1 11 Z");
  });
});
