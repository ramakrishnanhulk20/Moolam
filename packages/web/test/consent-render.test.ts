import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { Consent, ConsentEntry, ConsentReading } from "@/lib/chain/consent";
import { ConsentSection } from "@/components/consent/ConsentSection";
import { ConsentStamp } from "@/components/consent/ConsentStamp";
import type { MatchConsent } from "@/lib/verifier/client";

/**
 * The card and the stamp, rendered on the server exactly as a passport page and
 * a verify answer render them.
 *
 * What is being pinned down here is the difference between the three answers a
 * reader can be given. A holder who said nothing, a register that could not be
 * read, and a holder who said no are three different sentences, and any two of
 * them collapsing into one would be the one bug on this screen that matters.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
  useRouter: () => ({ refresh: () => undefined }),
}));

const PASSPORT = `0x${"5c".repeat(32)}` as Hex;
const OWNER = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;
const WRITER = "0x85a88Ca81Ff5F681D96AB86fA60ccB8452a139a6" as Hex;
const REGISTERED = 1_788_876_082;
const NOW = 1_789_719_047;
const WRITTEN = 1_789_717_128;

const CLOSED: Consent = {
  aiTraining: "notAllowed",
  aiGenerativeTraining: "notAllowed",
  aiInference: "notAllowed",
  dataMining: "notAllowed",
};

const ASK: Consent = {
  aiTraining: "constrained",
  aiGenerativeTraining: "constrained",
  aiInference: "constrained",
  dataMining: "constrained",
};

const CONDITIONS = "Ask first: open an issue at https://github.com/ramakrishnanhulk20/Moolam/issues";

function entry(consent: Consent, constraintInfo = ""): ConsentEntry {
  return { at: BigInt(WRITTEN), writer: WRITER, consent, constraintInfo };
}

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node));
}

function section(reading: ConsentReading, history: ConsentEntry[]): string {
  return render(
    createElement(ConsentSection, {
      id: PASSPORT,
      owner: OWNER,
      registeredAt: REGISTERED,
      record: { reading, history, standard: "cawg.training-mining/1.1", minInterval: 600, now: NOW },
    }),
  );
}

const copy = en.passport.consent;

describe("the statement a passport page draws", () => {
  it("opens on what stands today, with the four rows and the history under it", () => {
    const stated = entry(CLOSED);
    const markup = section({ stated: true, entry: stated }, [stated]);

    expect(markup).toContain(copy.heading);
    expect(markup).toContain(copy.summary.closed);
    expect(markup).toContain(copy.line.closed);
    expect(markup).toContain("cawg.training-mining/1.1");

    // The four uses, each with its own word, and the standing statement's writer.
    for (const use of Object.values(copy.uses)) {
      expect(markup).toContain(use);
    }
    expect(markup).toContain(copy.state.notAllowed);
    expect(markup).toContain(copy.statedBy);
    expect(markup).toContain(`/address/${WRITER}`);
    expect(markup).toContain("One statement");
    expect(markup).toContain(copy.standsToday);
  });

  it("prints the conditions and what they apply to, in the holder's own words", () => {
    const stated = entry(ASK, CONDITIONS);
    const markup = section({ stated: true, entry: stated }, [stated]);

    expect(markup).toContain(copy.summary.ask);
    // The label carries an apostrophe, which React escapes on its way into the markup.
    expect(markup).toContain("Conditions, in the holder");
    expect(markup).toContain("Ask first: open an issue at");
    expect(markup).toContain("Applies to AI training");
  });

  it("gives silence a designed answer rather than an empty space", () => {
    const markup = section({ stated: false, entry: null }, []);

    expect(markup).toContain(copy.summary.none);
    expect(markup).toContain(copy.empty.body);
    expect(markup).toContain(copy.empty.holder);
    expect(markup).toContain(copy.historyEmpty);
    // The rows are still four, and every one of them says nothing was stated.
    expect(markup.split(copy.state.unspecified).length - 1).toBeGreaterThanOrEqual(4);
    expect(markup).not.toContain(copy.statedBy);
  });

  it("says so out loud when the register could not be read", () => {
    const markup = render(
      createElement(ConsentSection, { id: PASSPORT, owner: OWNER, registeredAt: REGISTERED, record: null }),
    );

    expect(markup).toContain(copy.unavailable);
    expect(markup).not.toContain(copy.summary.none);
  });

  it("draws no holder's control for a reader whose wallet is not mounted", () => {
    const stated = entry(CLOSED);
    expect(section({ stated: true, entry: stated }, [stated])).not.toContain(copy.control.submit);
  });
});

describe("the stamp under a verify match", () => {
  const stamp = (consent?: MatchConsent) => render(createElement(ConsentStamp, { consent }));
  const words = en.verify.consent;

  it("prints what the holder said, and the day they said it", () => {
    const markup = stamp({
      source: "chain",
      stated: true,
      standard: "cawg.training-mining/1.1",
      ...CLOSED,
      at: WRITTEN,
      writer: WRITER,
    });

    expect(markup).toContain("The holder");
    expect(markup).toContain(words.tail.closed);
    expect(markup).toContain(words.source);
    // The day the register says it was written, in the reader's own locale.
    expect(markup).toContain("Sep 18, 2026");
  });

  it("prints the conditions instead of the source line when there are conditions", () => {
    const markup = stamp({
      source: "chain",
      stated: true,
      standard: "cawg.training-mining/1.1",
      ...ASK,
      constraintInfo: CONDITIONS,
      at: WRITTEN,
      writer: WRITER,
    });

    expect(markup).toContain(words.tail.ask);
    expect(markup).toContain("Ask first: open an issue at");
    expect(markup).not.toContain(words.source);
  });

  it("reports silence as silence", () => {
    const markup = stamp({ source: "chain", stated: false });

    expect(markup).toContain(words.nothing);
    expect(markup).toContain(words.silence);
    expect(markup).toContain(words.never);
  });

  it("keeps a failed read apart from a holder who said nothing", () => {
    const markup = stamp({ source: "unavailable" });

    expect(markup).toContain(words.unavailable);
    expect(markup).toContain(words.unavailableNote);
    expect(markup).not.toContain(words.silence);
    expect(markup).not.toContain(words.nothing);
  });

  it("draws nothing at all for an answer from a service that predates the register", () => {
    expect(stamp(undefined)).toBe("");
  });
});
