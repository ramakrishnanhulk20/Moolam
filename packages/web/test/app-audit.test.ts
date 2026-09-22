import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import { AnswerCard, type Stage } from "@/components/verify/AnswerCard";
import { agentChipId, type Answer } from "@/components/verify/answer";
import { cardText } from "@/components/agent/card";
import { indexKnowsAgent } from "@/components/agent/known";
import { groups } from "@/components/passport/Mono";
import type { MatchedPassport } from "@/components/verify/lookup";

// next-intl's navigation helpers reach for next/navigation, which only resolves
// inside the bundler. The link is the one thing this card uses from it.
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const ID = `0x${"2b".repeat(32)}` as `0x${string}`;

const queried = {
  sha256: `0x${"7e".repeat(32)}` as `0x${string}`,
  phash: "6620159428093749285",
  blockhash: `0x${"1f".repeat(32)}` as `0x${string}`,
  width: 462,
  height: 533,
  format: "png",
};

const match: Answer = {
  kind: "close",
  id: ID,
  confidence: 0.88,
  phashDistance: 2,
  blockhashDistance: 0,
  variant: "identity",
  others: 0,
  manifest: false,
  queried,
};

function passportSignedBy(agentId: string): MatchedPassport {
  return {
    id: ID,
    kind: 0,
    registeredAt: "1788876082",
    creator: "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c",
    generatorAgentId: agentId,
    disputed: false,
    title: "A registered picture",
  };
}

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node));
}

describe("which agent the verify answer may link to", () => {
  it("offers no chip for agent 0, whatever shape the zero arrives in", () => {
    expect(agentChipId(passportSignedBy("0"))).toBeNull();
    expect(agentChipId(passportSignedBy("0000"))).toBeNull();
    expect(agentChipId(passportSignedBy(" "))).toBeNull();
    expect(agentChipId(null)).toBeNull();
  });

  it("offers the chip for a real agent", () => {
    expect(agentChipId(passportSignedBy("10248"))).toBe("10248");
  });

  it("draws no agent link on the card for a passport no agent signed", () => {
    const stage: Stage = { kind: "answer", answer: match, passport: passportSignedBy("0") };
    const markup = render(createElement(AnswerCard, { stage }));

    expect(markup).toContain(`/passport/${ID}`);
    expect(markup).not.toContain("/agent/");
  });

  it("still draws the link when an agent did sign it", () => {
    const stage: Stage = { kind: "answer", answer: match, passport: passportSignedBy("10248") };
    expect(render(createElement(AnswerCard, { stage }))).toContain("/agent/10248");
  });
});

describe("which agents get a page inside Moolam", () => {
  const signed = {
    passportCount: 12,
    matchedCount: 4,
    mismatchedCount: 0,
    disputesUpheld: 0,
    trustScore: 67,
    firstSeenAt: 1788876082n,
  };

  it("turns away an agent the index has never seen sign a passport", () => {
    expect(indexKnowsAgent(null, null)).toBe(false);
  });

  it("keeps an agent that has signed one", () => {
    expect(indexKnowsAgent(signed, null)).toBe(true);
  });

  it("does not turn anyone away because the index is unreachable", () => {
    expect(indexKnowsAgent(null, "the Envio endpoint answered 502")).toBe(true);
  });
});

describe("wrapping a long value at points somebody chose", () => {
  const address = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c";

  it("keeps every character, in order", () => {
    expect(groups(address).join("")).toBe(address);
    expect(groups(ID).join("")).toBe(ID);
  });

  it("cuts into eights", () => {
    expect(groups(address)).toEqual(["0x559F35", "7aDa3A96", "d11AEa67", "9eC0D622", "E4AF15F6", "7c"]);
  });

  it("leaves a value that already has words alone", () => {
    expect(groups("Mirrored, quarter turn")).toEqual(["Mirrored, quarter turn"]);
    expect(groups("2 of 64 bits")).toEqual(["2 of 64 bits"]);
  });
});

describe("the agent card shown as a document", () => {
  it("prints the card a reader can check", () => {
    expect(cardText({ name: "Moolam demo generator", active: true })).toBe(
      '{\n  "name": "Moolam demo generator",\n  "active": true\n}',
    );
  });

  it("offers nothing when there is no card", () => {
    expect(cardText(null)).toBeNull();
    expect(cardText(undefined)).toBeNull();
  });
});
