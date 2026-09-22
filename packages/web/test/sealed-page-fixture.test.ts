import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { Art } from "@/components/passport/art";
import type { ExplorePlate } from "@/components/explore/sort";
import type { MatchedPassport } from "@/components/verify/lookup";
import type { Stage } from "@/components/verify/AnswerCard";
import type { Passport } from "@/lib/chain/registry";
import { verifyResponseSchema } from "@/lib/verifier/client";

/**
 * The four sealed screens, rendered to markup a browser can be pointed at.
 *
 * No sealed passport exists on mainnet yet, so none of these screens can be
 * reached by opening a URL. What can be done instead is to put their real
 * markup, with the real stylesheet and the real fonts, in front of a real
 * browser and measure it: the width it takes at 375 px, what it draws in both
 * themes, and whether anything moves on the way in.
 *
 * Run with SEALED_FIXTURE=1 to write the fragment to kitchen/reports.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: en, namespace }),
  getFormatter: async () => ({
    dateTime: (date: Date) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(date),
  }),
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

vi.mock("next/link", () => ({
  default: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
  useLinkStatus: () => ({ pending: false }),
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": "true" }),
}));

const { Poster } = await import("@/components/passport/Poster");
const { Attestations } = await import("@/components/passport/Attestations");
const { Facts } = await import("@/components/passport/Facts");
const { Plate } = await import("@/components/explore/Plate");
const { AnswerCard } = await import("@/components/verify/AnswerCard");

const ID = `0x${"7c".repeat(32)}` as Hex;
const BLOCKHASH = "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0" as Hex;
const CREATOR = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;

const passport: Passport = {
  id: ID,
  exactHash: ID,
  parentId: `0x${"00".repeat(32)}` as Hex,
  creator: CREATOR,
  generatorAgentId: 0n,
  phash: 0x6ccf137087789a25n,
  blockhash256: BLOCKHASH,
  manifestHash: `0x${"22".repeat(32)}` as Hex,
  kind: 1,
  fingerprintVersion: 1,
  registeredAt: 1_788_876_082n,
  disputed: false,
  metadataURI: "ipfs://bafkreisealedmetadata",
};

const art: Art = {
  title: "Monsoon nets, Kovalam",
  description: "A sealed registration: the record is public, the picture is not.",
  sealed: true,
  commitment: { algorithm: "sha-256", value: ID },
  blockhash: BLOCKHASH,
  missing: false,
};

const sealedPlate: ExplorePlate = {
  id: ID,
  kind: 1,
  registeredAt: 1_788_876_082,
  title: "Monsoon nets, Kovalam",
  thumbnailUrl: null,
  manifest: false,
  rechecked: false,
  chainlink: false,
  disputed: false,
  agentId: null,
  consent: null,
  sealed: true,
  blockhash: BLOCKHASH,
};

const quietGateway: ExplorePlate = {
  ...sealedPlate,
  id: `0x${"1a".repeat(32)}`,
  title: "A published picture the gateway will not serve",
  sealed: false,
  blockhash: undefined,
};

const matched: MatchedPassport = {
  id: ID,
  kind: 1,
  registeredAt: "1788876082",
  creator: CREATOR,
  generatorAgentId: "0",
  disputed: false,
  title: "Monsoon nets, Kovalam",
  sealed: true,
  blockhash256: BLOCKHASH,
};

const answer = verifyResponseSchema.parse({
  result: {
    exact: ID,
    best: { id: ID, phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1 },
    matches: [{ id: ID, phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1 }],
    confidence: 1,
    queried: {
      sha256: ID,
      phash: "7840506850305415717",
      blockhash: BLOCKHASH,
      width: 1536,
      height: 1024,
      format: "jpeg",
    },
  },
  manifest: { present: true },
});

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node));
}

describe("the sealed screens as a browser will lay them out", () => {
  it("renders the poster, the second opinion, the record, the sheet and the verify card", async () => {
    const { readAnswer } = await import("@/components/verify/answer");
    const stage: Stage = { kind: "answer", answer: readAnswer(answer), passport: matched };

    const scenes: Array<[string, string]> = [
      ["The passport page opens on the sealed plate", render(await Poster({ passport, art, locale: "en" }))],
      [
        "The second opinion, and the record with the commitment in it",
        render(
          await Attestations({ attestations: [], indexed: [], phash: passport.phash, locale: "en", sealed: true }),
        ) +
          render(await Facts({ passport, art, owner: CREATOR, hasPasskey: true, standing: "unverified", txHash: null })),
      ],
      [
        "The Explore sheet: a sealed plate beside one whose gateway is quiet",
        render(
          createElement(
            "div",
            { className: "mt-6 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-3 xl:grid-cols-4" },
            createElement(Plate, { plate: sealedPlate, key: "sealed" }),
            createElement(Plate, { plate: quietGateway, key: "quiet" }),
          ),
        ),
      ],
      ["The verify answer on a sealed match", render(createElement(AnswerCard, { stage }))],
    ];

    for (const [, markup] of scenes) {
      expect(markup.length).toBeGreaterThan(500);
    }

    if (process.env.SEALED_FIXTURE === "1") {
      const body = scenes
        .map(
          ([caption, markup]) =>
            `<section class="fixture-scene"><p class="fixture-caption">${caption}</p>${markup}</section>`,
        )
        .join("\n");
      writeFileSync(
        fileURLToPath(new URL("../../../kitchen/reports/WO-117-fixture.html", import.meta.url)),
        body,
        "utf8",
      );
    }
  });
});
