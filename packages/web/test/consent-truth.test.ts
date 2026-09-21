// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { act, createElement, type FunctionComponent, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import { createFormatter, createTranslator } from "next-intl";
import type { Hex } from "viem";
import type { ConsentEntry, ConsentReading, Statement } from "@/lib/chain/consent";
import { DAY_SECONDS, type LedgerEntry } from "@/components/consent/ledger";
import { ConsentLedger } from "@/components/consent/ConsentLedger";
import { shareDescription } from "@/components/consent/share";

/**
 * The rule's right end, and the four marks beside the headline.
 *
 * A passport page is built before its first visitor and then held, so the
 * moment the server rendered it can be a day old by the time anybody reads it.
 * The rule that draws the passport's whole life would then stop short of today
 * and a statement written this morning would sit beyond its end, which is the
 * one thing this card exists to get right.
 */

const PASSPORT = `0x${"5c".repeat(32)}`;
const WRITER = "0x85a88Ca81Ff5F681D96AB86fA60ccB8452a139a6";

const CLOSED = {
  aiTraining: "notAllowed",
  aiGenerativeTraining: "notAllowed",
  aiInference: "notAllowed",
  dataMining: "notAllowed",
} as const;

/** The app renders every chain timestamp in UTC, so the expected day is read the same way. */
const DAY = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

function provider(node: ReactElement): ReactElement {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node);
}

async function mount(node: ReactElement): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(provider(node));
  });
  return host;
}

function ledger(now: number, entries: LedgerEntry[]): ReactElement {
  const standing = entries.length === 0 ? { stated: false, entry: null } : { stated: true, entry: entries[0] };
  return createElement(ConsentLedger, {
    id: PASSPORT,
    // Half a day off a whole number of days, so the notch count cannot fall
    // either side of a boundary while the test itself is running.
    registeredAt: now - 30 * DAY_SECONDS - DAY_SECONDS / 2,
    now,
    entries,
    standing,
  });
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });

  // Nothing here should reach the scrubber's reader at all. A call would be the
  // finding, so it is a spy rather than a stub with an answer.
  vi.stubGlobal("fetch", vi.fn());
});

describe("where the rule ends", () => {
  const today = Math.floor(Date.now() / 1000);
  const yesterday = today - DAY_SECONDS;

  it("moves the last stop to the reader's own day when the page was built a day ago", async () => {
    const host = await mount(ledger(yesterday, []));

    const text = host.textContent ?? "";
    expect(text).toContain(DAY.format(new Date(today * 1000)));
    expect(text).not.toContain(DAY.format(new Date(yesterday * 1000)));

    // One more notch than the server's clock had, and the thumb is still on the
    // last one rather than a day behind it.
    const scrubber = host.querySelector("input[type=range]") as HTMLInputElement;
    expect(Number(scrubber.max)).toBe(32);
    expect(scrubber.value).toBe("32");
  });

  it("asks the chain for nothing on arrival, since the server already answered for now", async () => {
    await mount(ledger(yesterday, []));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("captions the statement rather than opening a sentence it cannot finish", async () => {
    const entry: LedgerEntry = { at: today - DAY_SECONDS, writer: WRITER, consent: CLOSED, constraintInfo: "" };
    const host = await mount(ledger(yesterday, [entry]));
    const text = host.textContent ?? "";

    expect(text).toContain(en.passport.consent.inForceToday);
    expect(text).not.toContain(en.passport.consent.onThisDay);
    // The old caption ran straight into the statement and said nothing true.
    expect(text).not.toContain("On this day, AI could");
  });

  it("names every mark beside the headline, and reads the four out as one description", async () => {
    const entry: LedgerEntry = { at: today - DAY_SECONDS, writer: WRITER, consent: CLOSED, constraintInfo: "" };
    const host = await mount(ledger(yesterday, [entry]));

    const legend = host.querySelector('[role="img"]') as HTMLElement;
    for (const name of Object.values(en.passport.consent.usesShort)) {
      expect(legend.textContent).toContain(name);
    }

    const said = legend.getAttribute("aria-label") ?? "";
    expect(said).toContain(`${en.passport.consent.uses.aiTraining}: ${en.passport.consent.state.notAllowed}`);
    expect(said).toContain(`${en.passport.consent.uses.dataMining}: ${en.passport.consent.state.notAllowed}`);
    expect(legend.getAttribute("aria-hidden")).toBeNull();
  });

  it("offers the arrow keys to a pointer that has them, and the drag to one that does not", async () => {
    const host = await mount(ledger(yesterday, []));
    const spans = [...host.querySelectorAll("span")];

    const long = spans.find((span) => span.textContent === `${en.passport.consent.scrub}${en.passport.consent.scrubStep}`);
    const short = spans.find((span) => span.textContent === en.passport.consent.scrubTouch);

    expect(long?.className).toContain("pointer-fine:sm:inline");
    expect(long?.className).toContain("hidden");
    expect(short?.className).toContain("pointer-fine:sm:hidden");
    expect(en.passport.consent.scrubTouch).not.toContain("arrow");
  });

  it("never pulls the end of the rule back when the reader's clock runs behind the chain's", async () => {
    const ahead = today + 2 * DAY_SECONDS;
    const entry: LedgerEntry = { at: ahead - 60, writer: WRITER, consent: CLOSED, constraintInfo: "" };
    const host = await mount(ledger(ahead, [entry]));

    const text = host.textContent ?? "";
    expect(text).toContain(DAY.format(new Date(ahead * 1000)));
    expect(text).toContain(en.passport.consent.summary.closed);
  });
});

/**
 * The words a passport link carries into a chat.
 *
 * The sentence is built here exactly as the head builds it, from the message
 * file and the app's own formatter, so a translation that lost a placeholder or
 * a summary that read wrongly would show up as a sentence rather than as a
 * passing assertion about a template.
 */
describe("what a shared passport link says", () => {
  const WRITTEN = 1_789_717_128;
  const PICTURE = "A cormorant on a fishing stake at dawn.";
  const APP_LINE = en.meta.description;

  const words = createTranslator({ locale: "en", messages: en, namespace: "passport.consent" });
  const format = createFormatter({ locale: "en", timeZone: "UTC" });

  const lead = (statement: Exclude<Statement, "none">, at: number) =>
    words("shared", {
      statement: words(`summary.${statement}`),
      when: format.dateTime(new Date(at * 1000), { dateStyle: "medium" }),
    });

  const entry = (consent: ConsentEntry["consent"]): ConsentEntry => ({
    at: BigInt(WRITTEN),
    writer: WRITER as Hex,
    consent,
    constraintInfo: "",
  });

  const stated: ConsentReading = { stated: true, entry: entry(CLOSED) };
  const silent: ConsentReading = { stated: false, entry: null };

  it("leads with the statement, then the picture's own words", () => {
    expect(shareDescription(stated, PICTURE, APP_LINE, lead)).toBe(
      `Not for AI training, stated on Monad on ${DAY.format(new Date(WRITTEN * 1000))}. ${PICTURE}`,
    );
  });

  it("falls back to the app's line for a picture that came with no words of its own", () => {
    expect(shareDescription(stated, undefined, APP_LINE, lead)).toBe(
      `Not for AI training, stated on Monad on ${DAY.format(new Date(WRITTEN * 1000))}. ${APP_LINE}`,
    );
  });

  it("leaves the description alone when the holder has stated nothing", () => {
    expect(shareDescription(silent, PICTURE, APP_LINE, lead)).toBe(PICTURE);
    expect(shareDescription(silent, undefined, APP_LINE, lead)).toBeUndefined();
  });

  it("leaves the description alone when the register could not be read", () => {
    expect(shareDescription(null, PICTURE, APP_LINE, lead)).toBe(PICTURE);
    expect(shareDescription(null, undefined, APP_LINE, lead)).toBeUndefined();
  });

  it("carries the sentence in all ten languages, with both of its placeholders", () => {
    const locales = readdirSync("messages").filter((name) => name.endsWith(".json"));
    expect(locales.length).toBe(10);

    for (const name of locales) {
      const tree = JSON.parse(readFileSync(`messages/${name}`, "utf8")) as {
        passport: { consent: { shared: string } };
      };
      const sentence = tree.passport.consent.shared;
      expect(sentence, name).toContain("{statement}");
      expect(sentence, name).toContain("{when}");
    }
  });

  it("says nothing for a statement that answered none of the four uses", () => {
    const nothing = {
      aiTraining: "unspecified",
      aiGenerativeTraining: "unspecified",
      aiInference: "unspecified",
      dataMining: "unspecified",
    } as const;
    expect(shareDescription({ stated: true, entry: entry(nothing) }, PICTURE, APP_LINE, lead)).toBe(PICTURE);
  });
});
