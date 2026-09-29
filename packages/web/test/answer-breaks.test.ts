// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import { AnswerCard, type Stage } from "@/components/verify/AnswerCard";
import type { Answer } from "@/components/verify/answer";

/**
 * The answer card never breaks a word in the middle.
 *
 * The judge audit of 2026-09-25 caught "0 of 64 bits a / part", "The same way
 * u / p" and "1024 x 1024 jp / eg" on a phone: every readout on the card was set
 * as a hash, and a hash may break anywhere. Only hex values may; words wrap at
 * their spaces.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) => createElement("a", { href: props.href }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const ID = `0x${"2b".repeat(32)}` as `0x${string}`;

const answer: Answer = {
  kind: "close",
  id: ID,
  confidence: 0.88,
  phashDistance: 0,
  blockhashDistance: 0,
  variant: "identity",
  others: 0,
  manifest: false,
  queried: {
    sha256: `0x${"7e".repeat(32)}` as `0x${string}`,
    phash: "6620159428093749285",
    blockhash: `0x${"1f".repeat(32)}` as `0x${string}`,
    width: 1024,
    height: 1024,
    format: "jpeg",
  },
};

function card(stage: Stage, messages: unknown = en, locale = "en"): Document {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  const html = renderToStaticMarkup(
    createElement(Provider, { locale, messages, timeZone: "Asia/Kolkata" }, createElement(AnswerCard, { stage })),
  );
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
}

/** Hex, a decimal fingerprint, or a shortened hash with its ellipsis. Nothing a reader would call a word. */
const HEXISH = /^(0x)?[0-9a-f]+(\u2026[0-9a-f]+)?$/i;

function breakAnywhere(doc: Document): string[] {
  return [...doc.querySelectorAll(".break-all, [class*='wrap-anywhere'], [class*='overflow-wrap:anywhere']")].map(
    (node) => node.textContent ?? "",
  );
}

describe("the answer card's word breaks", () => {
  const stages: [string, Stage][] = [
    ["a match", { kind: "answer", answer, passport: null }],
    ["a miss", { kind: "answer", answer: { ...answer, kind: "miss" }, passport: null }],
    ["the wait", { kind: "checking", name: "my holiday photo from the beach.jpg" }],
  ];

  for (const [name, stage] of stages) {
    for (const [locale, messages] of [
      ["en", en],
      ["ta", ta],
    ] as const) {
      it(`lets only hex values break anywhere, on ${name} in ${locale}`, () => {
        const values = breakAnywhere(card(stage, messages, locale));
        for (const value of values) {
          expect(value, `"${value}" may break mid-word`).toMatch(HEXISH);
        }
      });
    }
  }

  it("sets the distances, the orientation and the size as words that wrap at spaces", () => {
    const doc = card({ kind: "answer", answer, passport: null });
    const words = [...doc.querySelectorAll("[data-readout-words]")];
    const said = words.map((node) => node.textContent);

    expect(said).toContain("0 of 64 bits apart");
    expect(said).toContain("0 of 256 bits apart");
    expect(said).toContain("The same way up");
    expect(said).toContain("1024 x 1024 jpeg");
    for (const node of words) {
      expect(node.className).not.toMatch(/break-all|anywhere/);
      expect(node.className).toContain("break-words");
    }
  });

  it("still lets the long hashes break, so they never push the card wider than its column", () => {
    const values = breakAnywhere(card({ kind: "answer", answer, passport: null }));
    expect(values).toContain("6620159428093749285");
    expect(values.some((value) => value.startsWith("0x7e7e7e7e") && value.includes("…"))).toBe(true);
    expect(values).toContain(ID);
  });
});

describe("the verify page's own captions", () => {
  it("keeps the service's host whole in the privacy line, with its brackets, breaking inside it only at its dots", async () => {
    const { Privacy } = await import("@/components/verify/VerifyScreen");
    const line = en.verify.privacy.replace("{host}", "\u0000host\u0000");
    const doc = new DOMParser().parseFromString(
      `<body>${renderToStaticMarkup(createElement(Privacy, { line, host: "verifier-production-d76f.up.railway.app" }))}</body>`,
      "text/html",
    );
    const host = doc.querySelector("[data-privacy-host]");
    expect(host?.textContent).toBe("(verifier-production-d76f.up.railway.app).");
    expect(host?.className).toContain("inline-block");
    expect(host?.className).not.toContain("break-all");
    expect(host?.querySelectorAll("wbr").length).toBe(3);
    expect(doc.body.textContent).toBe(en.verify.privacy.replace("{host}", "verifier-production-d76f.up.railway.app"));
  });

  it("sets the chosen file's name to wrap like words, never break-all", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("components/verify/VerifyScreen.tsx", "utf8");
    expect(source).not.toContain("break-all");
    expect(source).toMatch(/<p className="[^"]*\[overflow-wrap:anywhere\][^"]*">\s*\{file\?\.name\}/);
  });
});
