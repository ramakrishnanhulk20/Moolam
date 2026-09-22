import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import { AnswerCard, type Stage } from "@/components/verify/AnswerCard";
import { readAnswer } from "@/components/verify/answer";
import type { MatchedPassport } from "@/components/verify/lookup";
import { verifyResponseSchema } from "@/lib/verifier/client";

/**
 * The verify answer when the picture somebody dropped in matches a passport
 * whose own picture was never published.
 *
 * The match is as real as any other: the fingerprints are on chain. What is
 * different is that there is nothing to show beside the verdict, and the card
 * has to say that rather than leave an empty frame for a reader to read as a
 * failure.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": "true" }),
}));

const ID = `0x${"5e".repeat(32)}` as Hex;
const BLOCKHASH = "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0" as Hex;

const queried = {
  sha256: `0x${"3c".repeat(32)}`,
  phash: "7840159428093749285",
  blockhash: `0x${"4d".repeat(32)}`,
  width: 1536,
  height: 1024,
  format: "jpeg",
};

const answer = readAnswer(
  verifyResponseSchema.parse({
    result: {
      exact: ID,
      best: { id: ID, phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1 },
      matches: [{ id: ID, phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1 }],
      confidence: 1,
      queried,
    },
    manifest: { present: true },
  }),
);

const published: MatchedPassport = {
  id: ID,
  kind: 0,
  registeredAt: "1788876082",
  creator: `0x${"11".repeat(20)}`,
  generatorAgentId: "0",
  disputed: false,
  title: "Kadal at dawn",
  thumbnailUrl: "https://gateway.example/small.jpg",
  sealed: false,
  blockhash256: BLOCKHASH,
};

const sealed: MatchedPassport = {
  ...published,
  title: "Monsoon nets, Kovalam",
  thumbnailUrl: undefined,
  sealed: true,
};

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node));
}

function card(passport: MatchedPassport): string {
  const stage: Stage = { kind: "answer", answer, passport };
  return render(createElement(AnswerCard, { stage }));
}

describe("a verify answer that matched a sealed passport", () => {
  it("says the match and says the picture is not published", () => {
    const markup = card(sealed);

    expect(markup).toContain(en.verify.sealed.matched);
    expect(markup).toContain(en.verify.exact);
    expect(markup).toContain("Monsoon nets, Kovalam");
  });

  it("draws the block hash where the matched picture would be, never the gateway's words", () => {
    const markup = card(sealed);

    expect(markup).not.toContain("data-picture");
    expect(markup).not.toContain(en.verify.noPicture);
    expect(markup.match(/<span class="bg-text"/g)?.length).toBeGreaterThan(30);
  });

  it("answers the second opinion with the truth rather than with not yet", () => {
    const markup = card(sealed);

    expect(markup).toContain(en.verify.sealed.recheck);
    expect(markup).not.toContain(en.verify.recheck.none);
  });

  it("leaves a published match exactly as it was", () => {
    const markup = card(published);

    expect(markup).toContain("data-picture");
    expect(markup).not.toContain(en.verify.sealed.matched);
    expect(markup).not.toContain(en.verify.sealed.recheck);
  });
});
