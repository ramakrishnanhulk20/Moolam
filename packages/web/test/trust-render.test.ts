import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import { AnswerCard, type Stage } from "@/components/verify/AnswerCard";
import { CheckCopy } from "@/components/passport/CheckCopy";
import type { Answer } from "@/components/verify/answer";
import type { MatchedPassport } from "@/components/verify/lookup";

// next-intl's navigation helpers reach for next/navigation, which only resolves
// inside the bundler. The link is the one thing these cards use from it.
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const ID = `0x${"1a".repeat(32)}` as `0x${string}`;

const queried = {
  sha256: `0x${"3c".repeat(32)}` as `0x${string}`,
  phash: "7840159428093749285",
  blockhash: `0x${"4d".repeat(32)}` as `0x${string}`,
  width: 1536,
  height: 1024,
  format: "jpeg",
};

const match: Answer = {
  kind: "close",
  id: ID,
  confidence: 0.82,
  phashDistance: 3,
  blockhashDistance: 24,
  variant: "mirror-rot90",
  others: 1,
  manifest: false,
  queried,
};

const miss: Answer = { kind: "miss", manifest: false, queried };

const passport: MatchedPassport = {
  id: ID,
  kind: 0,
  registeredAt: "1788876082",
  creator: "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c",
  generatorAgentId: "10249",
  disputed: false,
  title: "Monsoon fishing nets drying",
  thumbnailUrl: "https://gateway.example/ipfs/bafkreithumb",
};

function render(locale: "en" | "ta", node: ReactElement): string {
  // The provider's own props type demands children, which createElement passes
  // as an argument rather than a prop.
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;

  return renderToStaticMarkup(
    createElement(Provider, { locale, messages: locale === "en" ? en : ta, timeZone: "Asia/Kolkata" }, node),
  );
}

describe("the verify answer card, in every state it can be in", () => {
  const stages: Stage[] = [
    { kind: "idle" },
    { kind: "checking", name: "monsoon.jpg" },
    { kind: "answer", answer: match, passport },
    { kind: "answer", answer: miss, passport: null },
    { kind: "problem", problem: { key: "problem.rateLimited", reason: "Too Many Requests" } },
  ];

  for (const locale of ["en", "ta"] as const) {
    it(`renders every stage in ${locale} with no missing message`, () => {
      for (const stage of stages) {
        const markup = render(locale, createElement(AnswerCard, { stage }));
        expect(markup).not.toContain("verify.");
        expect(markup.length).toBeGreaterThan(200);
      }
    });
  }

  it("shows the confidence, the orientation and the matched passport in English", () => {
    const markup = render("en", createElement(AnswerCard, { stage: { kind: "answer", answer: match, passport } }));
    expect(markup).toContain("82");
    expect(markup).toContain("Mirrored, quarter turn");
    expect(markup).toContain("3 of 64 bits");
    expect(markup).toContain("Monsoon fishing nets drying");
    expect(markup).toContain(`/passport/${ID}`);
    expect(markup).toContain("/agent/10249");
  });

  it("offers the studio when nothing matched, and never a passport link", () => {
    const markup = render("en", createElement(AnswerCard, { stage: { kind: "answer", answer: miss, passport: null } }));
    expect(markup).toContain("No passport matches this image.");
    expect(markup).toContain("/studio");
    expect(markup).not.toContain("/passport/0x");
  });

  it("prints the service's own words under a refusal", () => {
    const stage: Stage = { kind: "problem", problem: { key: "problem.tooLarge", reason: "big.jpg 24.0 MB" } };
    const markup = render("en", createElement(AnswerCard, { stage }));
    expect(markup).toContain("big.jpg 24.0 MB");
    expect(markup).toContain("20 MB");
  });
});

describe("the check a copy panel on a passport", () => {
  for (const locale of ["en", "ta"] as const) {
    it(`renders in ${locale} with no missing message`, () => {
      const markup = render(locale, createElement(CheckCopy, { passportId: ID }));
      expect(markup).not.toContain("passport.check");
      expect(markup).toContain("<button");
    });
  }
});
