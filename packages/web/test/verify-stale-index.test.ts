import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import de from "@/messages/de.json";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import fr from "@/messages/fr.json";
import hi from "@/messages/hi.json";
import ja from "@/messages/ja.json";
import ko from "@/messages/ko.json";
import pt from "@/messages/pt.json";
import ta from "@/messages/ta.json";
import zh from "@/messages/zh.json";
import type { Stage } from "@/components/verify/AnswerCard";
import type { RecheckControl } from "@/lib/recheck/useRecheck";
import { readAnswer } from "@/components/verify/answer";
import { verifyResponseSchema } from "@/lib/verifier/client";

/**
 * The line the verify card adds when the service says its copy of the register is stale (verifier
 * review pass 9, V82): a "no match" from a copy that stopped refreshing is not the same answer as
 * one from a current copy. Drawn on a miss and on a match, in every language, with the minutes
 * counted from the service's loadedAt; drawn nowhere when the service calls the copy current or
 * predates the field.
 *
 * Does NOT cover how the service decides the copy is stale (the verifier's stale-index test), nor
 * the other screens that read the same answer (the home drop, the passport page's check), which
 * draw no such line yet.
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

const LOCALES = { de, en, es, fr, hi, ja, ko, pt, ta, zh } as const;
const PASSPORT = `0x${"7c".repeat(32)}` as Hex;
const BLOCKHASH = "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0" as Hex;
const NOW = Date.parse("2026-09-26T12:00:00Z");
/** Loaded 12 minutes and 40 seconds before NOW. */
const LOADED_AT = NOW / 1000 - 12 * 60 - 40;

function body(options: { matched: boolean; index?: { loadedAt: number; stale: boolean } }) {
  const best = { id: PASSPORT, phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1 };
  return verifyResponseSchema.parse({
    result: {
      exact: options.matched ? PASSPORT : null,
      best: options.matched ? best : null,
      matches: options.matched ? [best] : [],
      confidence: options.matched ? 1 : 0,
      queried: { sha256: PASSPORT, phash: "7840506850305415717", blockhash: BLOCKHASH, width: 1536, height: 1024, format: "jpeg" },
    },
    manifest: { present: false },
    ...(options.index === undefined ? {} : { index: options.index }),
  });
}

function card(locale: keyof typeof LOCALES, options: Parameters<typeof body>[0]): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; timeZone: string }>;
  const stage: Stage = { kind: "answer", answer: readAnswer(body(options), NOW), passport: null };
  return renderToStaticMarkup(
    createElement(Provider, { locale, messages: LOCALES[locale], timeZone: "Asia/Kolkata" }, createElement(AnswerCard, { stage })),
  );
}

describe("what a stale copy of the register turns into", () => {
  it("counts whole minutes from loadedAt, only when the service called the copy stale", () => {
    expect(readAnswer(body({ matched: false, index: { loadedAt: LOADED_AT, stale: true } }), NOW)).toMatchObject({
      kind: "miss",
      staleMinutes: 12,
    });
    expect(readAnswer(body({ matched: true, index: { loadedAt: LOADED_AT, stale: true } }), NOW)).toMatchObject({
      kind: "exact",
      staleMinutes: 12,
    });
    expect(readAnswer(body({ matched: false, index: { loadedAt: LOADED_AT, stale: false } }), NOW)).not.toHaveProperty(
      "staleMinutes",
    );
    expect(readAnswer(body({ matched: false }), NOW)).not.toHaveProperty("staleMinutes");
  });

  it("refuses an index field of the wrong shape", () => {
    expect(() => body({ matched: false, index: { loadedAt: -1, stale: true } })).toThrow();
  });
});

for (const locale of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
  describe(`the verify card in ${locale}`, () => {
    const line = createTranslator({ locale, messages: LOCALES[locale], namespace: "verify" })("staleIndex", { minutes: 12 });

    it("says the copy is 12 minutes old beside a no-match and beside a match", () => {
      for (const matched of [false, true]) {
        const markup = card(locale, { matched, index: { loadedAt: LOADED_AT, stale: true } });
        expect(markup).toContain("data-stale-index");
        expect(markup).toContain(line.replace(/'/g, "&#x27;"));
      }
    });

    it("draws no such line from a current copy or from a service that predates the field", () => {
      expect(card(locale, { matched: false, index: { loadedAt: LOADED_AT, stale: false } })).not.toContain("data-stale-index");
      expect(card(locale, { matched: true })).not.toContain("data-stale-index");
    });
  });
}

it("the English line is the one the order asked for", () => {
  expect(createTranslator({ locale: "en", messages: en, namespace: "verify" })("staleIndex", { minutes: 12 })).toBe(
    "Moolam's copy of the register is 12 minutes old, so a picture registered since then may not show yet.",
  );
});
