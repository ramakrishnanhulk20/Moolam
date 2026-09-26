import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import type { MatchedPassport } from "@/components/verify/lookup";
import type { Stage } from "@/components/verify/AnswerCard";
import type { RecheckControl } from "@/lib/recheck/useRecheck";
import { readAnswer } from "@/components/verify/answer";
import { verifyResponseSchema } from "@/lib/verifier/client";

/**
 * The three lines the verify card adds from the service's newer fields: an earlier registration
 * that is not the passport on the card, how many later registrations share its fingerprint, and a
 * manifest that fails validation or cannot be read. Drawn in English and Tamil. Also the first
 * registration's AI-use statement, drawn beside the copy's only when the two say different things
 * (verifier review pass 4, V18).
 *
 * Does NOT cover the other eight languages beyond the key parity the message files already share,
 * nor how the service decides which passport was registered first (the verifier's own suite).
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

vi.mock("next/navigation", () => ({ useParams: () => ({ locale: "en" }) }));

vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": "true" }),
}));

vi.mock("@/lib/recheck/useRecheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recheck/useRecheck")>()),
  useRecheckRequest: (): RecheckControl => ({
    state: { kind: "none" },
    spent: false,
    checking: false,
    actions: { request: () => undefined, check: () => undefined },
  }),
}));

const { AnswerCard } = await import("@/components/verify/AnswerCard");

const HEADLINE = `0x${"7c".repeat(32)}` as Hex;
const FIRST = `0x${"0a".repeat(32)}` as Hex;
const BLOCKHASH = "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0" as Hex;

const passport: MatchedPassport = {
  id: HEADLINE,
  kind: 1,
  registeredAt: "1788876082",
  creator: "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a",
  generatorAgentId: "0",
  disputed: false,
  title: "Monsoon nets, Kovalam",
  thumbnailUrl: "https://gateway.example/ipfs/bafkreithumb",
  sealed: false,
  blockhash256: BLOCKHASH,
};

const LOCALES = { en, ta } as const;

interface Extra {
  firstRegisteredId?: Hex;
  laterSameFingerprint?: number;
  manifest?: { present: boolean; validation?: string };
  /** What each holder stated, as the service hangs it on the match rows. */
  consent?: { best?: unknown; first?: unknown };
}

/** A holder's statement as the service sends it, one word for all four uses. */
function stated(word: "allowed" | "notAllowed", at = 1_788_876_100) {
  return {
    source: "chain",
    stated: true,
    standard: "cawg.training-mining/1.1",
    aiTraining: word,
    aiGenerativeTraining: word,
    aiInference: word,
    dataMining: word,
    at,
    writer: "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a",
  };
}

function body(extra: Extra = {}) {
  const best = {
    id: HEADLINE,
    phashDistance: 1,
    blockhashDistance: 12,
    variant: "identity",
    score: 0.9,
    ...(extra.consent?.best === undefined ? {} : { consent: extra.consent.best }),
  };
  const first = {
    id: FIRST,
    phashDistance: 3,
    blockhashDistance: 12,
    variant: "identity",
    score: 0.8,
    firstRegistered: true,
    ...(extra.consent?.first === undefined ? {} : { consent: extra.consent.first }),
  };
  return verifyResponseSchema.parse({
    result: {
      exact: null,
      best,
      matches: extra.firstRegisteredId === undefined ? [best] : [best, first],
      confidence: 0.88,
      queried: { sha256: `0x${"3c".repeat(32)}`, phash: "7840506850305415717", blockhash: BLOCKHASH, width: 1536, height: 1024, format: "jpeg" },
      ...(extra.firstRegisteredId === undefined ? {} : { firstRegisteredId: extra.firstRegisteredId }),
      ...(extra.laterSameFingerprint === undefined ? {} : { laterSameFingerprint: extra.laterSameFingerprint }),
    },
    manifest: extra.manifest ?? { present: true, validation: "valid" },
  });
}

function card(locale: keyof typeof LOCALES, extra: Extra = {}): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; timeZone: string }>;
  const stage: Stage = { kind: "answer", answer: readAnswer(body(extra)), passport };
  return renderToStaticMarkup(
    createElement(Provider, { locale, messages: LOCALES[locale], timeZone: "Asia/Kolkata" }, createElement(AnswerCard, { stage })),
  );
}

function words(locale: keyof typeof LOCALES) {
  return createTranslator({ locale, messages: LOCALES[locale], namespace: "verify" });
}

/** The sentence before the link, which is the part a reader sees as plain text. */
function lead(locale: keyof typeof LOCALES): string {
  return (LOCALES[locale].verify.firstRegistered.split("<link>")[0] as string).trim();
}

describe("what the service's newer fields turn into", () => {
  it("keeps an earlier registration only when it is not the passport shown", () => {
    expect(readAnswer(body({ firstRegisteredId: FIRST }))).toMatchObject({ id: HEADLINE, firstRegisteredId: FIRST });
    expect(readAnswer(body({ firstRegisteredId: HEADLINE }))).not.toHaveProperty("firstRegisteredId");
    expect(readAnswer(body({ laterSameFingerprint: 0 }))).not.toHaveProperty("laterSameFingerprint");
    expect(readAnswer(body({ manifest: { present: true, validation: "valid" } }))).not.toHaveProperty("manifestCheck");
  });

  it("refuses a validation word the service does not send", () => {
    expect(() => body({ manifest: { present: true, validation: "trusted" } })).toThrow();
  });

  it("keeps the first registration's statement only when it says something other than the copy's", () => {
    const differing = readAnswer(
      body({ firstRegisteredId: FIRST, consent: { best: stated("allowed"), first: stated("notAllowed") } }),
    );
    expect(differing).toMatchObject({ consent: { aiTraining: "allowed" }, firstRegisteredConsent: { aiTraining: "notAllowed" } });

    // The same words written on another day are the same statement.
    const same = readAnswer(
      body({ firstRegisteredId: FIRST, consent: { best: stated("allowed"), first: stated("allowed", 1_788_000_000) } }),
    );
    expect(same).not.toHaveProperty("firstRegisteredConsent");
    expect(readAnswer(body({ consent: { best: stated("allowed"), first: stated("notAllowed") } }))).not.toHaveProperty(
      "firstRegisteredConsent",
    );
  });
});

for (const locale of ["en", "ta"] as const) {
  describe(`the verify card in ${locale}`, () => {
    it("says an earlier registration matches, and links it, when the headline is not the first", () => {
      const markup = card(locale, { firstRegisteredId: FIRST });

      expect(markup).toContain("data-first-registered");
      expect(markup).toContain(lead(locale));
      expect(markup).toContain(`href="/passport/${FIRST}"`);
    });

    it("draws the first registration's AI-use statement beside the copy's when the two differ", () => {
      const differing = card(locale, {
        firstRegisteredId: FIRST,
        consent: { best: stated("allowed"), first: stated("notAllowed") },
      });
      const stamps = createTranslator({ locale, messages: LOCALES[locale], namespace: "verify.consent" });

      expect(differing).toContain("data-first-registered-consent");
      expect(differing).toContain(stamps("tail.open"));
      expect(differing).toContain(stamps("tail.closed"));

      const same = card(locale, { firstRegisteredId: FIRST, consent: { best: stated("allowed"), first: stated("allowed") } });
      expect(same).not.toContain("data-first-registered-consent");
    });

    it("draws no such line when the headline is the first registration", () => {
      const markup = card(locale);

      expect(markup).not.toContain("data-first-registered");
      expect(markup).not.toContain(lead(locale));
    });

    it("counts later registrations sharing the fingerprint, and stays quiet at zero", () => {
      expect(card(locale, { laterSameFingerprint: 3 })).toContain(words(locale)("laterSameFingerprint", { count: 3 }));
      expect(card(locale, { laterSameFingerprint: 1 })).toContain(words(locale)("laterSameFingerprint", { count: 1 }));
      expect(card(locale, { laterSameFingerprint: 0 })).not.toContain("data-later-copies");
    });

    it("says the Content Credentials fail validation, never that a signed record is still inside", () => {
      const markup = card(locale, { manifest: { present: true, validation: "invalid" } });

      expect(markup).toContain(words(locale)("manifestInvalid"));
      expect(markup).not.toContain(words(locale)("manifestPresent"));
    });

    it("gives an unreadable manifest its own line, not the stripped one", () => {
      const markup = card(locale, { manifest: { present: false, validation: "unreadable" } });

      expect(markup).toContain(words(locale)("manifestUnreadable"));
      expect(markup).not.toContain(words(locale)("manifestMissing"));
      expect(markup).not.toContain(words(locale)("manifestPresent"));
    });

    it("keeps the old lines for a valid manifest and for none at all", () => {
      expect(card(locale)).toContain(words(locale)("manifestPresent"));
      expect(card(locale, { manifest: { present: false } })).toContain(words(locale)("manifestMissing"));
    });
  });
}
