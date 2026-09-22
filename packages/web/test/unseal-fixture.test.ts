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
import { initialUnsealState, type PassportUnseal, type UnsealState } from "@/lib/passport/unseal";
import { verifyResponseSchema } from "@/lib/verifier/client";

/**
 * Everything this order draws, rendered to markup a browser can be pointed at.
 *
 * No sealed passport has been published on mainnet, so none of these screens
 * can be reached by opening a URL. What can be done instead is to put their
 * real markup, with the real stylesheet and the real fonts, in front of a real
 * browser and measure it: the width it takes at 375 px, both grounds, and
 * whether anything moves on the way in.
 *
 * Run with UNSEAL_FIXTURE=1 to write the fragment to kitchen/reports.
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
  Picture: () => createElement("span", { "data-picture": "true", className: "absolute inset-0 block bg-bg-sunken" }),
}));

vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));

const stub = vi.hoisted(() => ({ current: null as unknown as PassportUnseal }));

vi.mock("@/lib/passport/unseal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/passport/unseal")>()),
  useUnsealPassport: () => stub.current,
}));

const chunks = vi.hoisted(() => ({ pending: [] as Promise<unknown>[] }));

vi.mock("next/dynamic", () => ({
  default: (load: () => Promise<FunctionComponent<never>>) => {
    let Panel: FunctionComponent<never> | null = null;
    chunks.pending.push(
      load().then((component) => {
        Panel = component;
      }),
    );
    return (props: never) => (Panel === null ? null : createElement(Panel, props));
  },
}));

const { Poster } = await import("@/components/passport/Poster");
const { Facts } = await import("@/components/passport/Facts");
const { Plate } = await import("@/components/explore/Plate");
const { AnswerCard } = await import("@/components/verify/AnswerCard");
const { WalletMounted } = await import("@/components/providers/WalletProvider");
const { UnsealPanel } = await import("@/components/passport/UnsealPanel");

await Promise.all(chunks.pending);

const ID = `0x${"7c".repeat(32)}` as Hex;
const BLOCKHASH = "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0" as Hex;
const CREATOR = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;
const UNSEALED_AT = "2026-09-20T06:12:44.000Z";

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

const unsealedArt: Art = {
  title: "Monsoon nets, Kovalam",
  description: "Registered sealed, published by its holder two days later.",
  imageUrl: "https://gateway.example/ipfs/bafkreiimage",
  thumbnailUrl: "https://gateway.example/ipfs/bafkreithumb",
  unsealed: { at: UNSEALED_AT, by: CREATOR, record: { cid: "bafkreirecordofthisunseal", uri: "ipfs://bafkreirecordofthisunseal" } },
  missing: false,
};

const plate: ExplorePlate = {
  id: ID,
  kind: 1,
  registeredAt: 1_788_876_082,
  title: "Monsoon nets, Kovalam",
  thumbnailUrl: "https://gateway.example/ipfs/bafkreithumb",
  manifest: true,
  rechecked: false,
  chainlink: false,
  disputed: false,
  agentId: null,
  consent: null,
  sealed: false,
};

const matched: MatchedPassport = {
  id: ID,
  kind: 1,
  registeredAt: "1788876082",
  creator: CREATOR,
  generatorAgentId: "0",
  disputed: false,
  title: "Monsoon nets, Kovalam",
  thumbnailUrl: "https://gateway.example/ipfs/bafkreithumb",
  sealed: false,
  blockhash256: BLOCKHASH,
  unsealedAt: UNSEALED_AT,
};

const answer = verifyResponseSchema.parse({
  result: {
    exact: ID,
    best: { id: ID, phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1 },
    matches: [{ id: ID, phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1 }],
    confidence: 1,
    queried: { sha256: ID, phash: "7840506850305415717", blockhash: BLOCKHASH, width: 1536, height: 1024, format: "jpeg" },
  },
  manifest: { present: true },
});

const RESULT = {
  passportId: ID,
  image: { cid: "bafkreiimage", uri: "ipfs://bafkreiimage", gatewayUrl: "https://gateway.example/ipfs/bafkreiimage" },
  thumbnail: { cid: "bafkreithumb", uri: "ipfs://bafkreithumb", gatewayUrl: "https://gateway.example/ipfs/bafkreithumb" },
  manifest: { cid: "bafkreic2pa", uri: "ipfs://bafkreic2pa", gatewayUrl: "https://gateway.example/ipfs/bafkreic2pa" },
  record: { cid: "bafkreirecordofthisunseal", uri: "ipfs://bafkreirecordofthisunseal", gatewayUrl: "https://gateway.example/ipfs/bafkreirecordofthisunseal" },
  unsealedBy: CREATOR,
  unsealedAt: UNSEALED_AT,
};

const kept = {
  file: new File([new Uint8Array([1])], "kadal.jpg", { type: "image/jpeg" }),
  name: "moolam-monsoon-nets-kovalam-signed.jpg",
  size: 3_140_000,
};

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node));
}

function panel(state: Partial<UnsealState>): string {
  stub.current = {
    ready: true,
    isHolder: true,
    state: { ...initialUnsealState, ...state },
    actions: { choose: async () => undefined, publish: async () => undefined, signIn: () => undefined, reset: () => undefined },
  };
  return render(
    createElement(
      WalletMounted.Provider,
      { value: true },
      createElement(UnsealPanel, { passportId: ID, owner: CREATOR, sealed: true }),
    ),
  );
}

describe("the publish control and the published screens as a browser lays them out", () => {
  it("renders the panel in its three states, the poster, the record, the sheet and the verify card", async () => {
    const { readAnswer } = await import("@/components/verify/answer");
    const stage: Stage = { kind: "answer", answer: readAnswer(answer), passport: matched };

    const scenes: Array<[string, string]> = [
      ["The holder's panel on a sealed passport, before a file is chosen", panel({})],
      ["The same panel once the file has been proved on this machine", panel({ kept })],
      ["The receipt, with the four addresses the picture now lives at", panel({ kept, result: RESULT })],
      ["The poster once the picture is published", render(await Poster({ passport, art: unsealedArt, locale: "en" }))],
      [
        "The record, with the line that says it was sealed at first",
        render(
          await Facts({ passport, art: unsealedArt, owner: CREATOR, hasPasskey: true, standing: "unverified", txHash: null }),
        ),
      ],
      [
        "The Explore sheet: the published picture on an ordinary plate",
        render(
          createElement(
            "div",
            { className: "mt-6 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-3 xl:grid-cols-4" },
            createElement(Plate, { plate, key: "unsealed" }),
          ),
        ),
      ],
      ["The verify answer on a copy of a published picture", render(createElement(AnswerCard, { stage }))],
    ];

    for (const [caption, markup] of scenes) {
      expect(markup.length, caption).toBeGreaterThan(400);
    }

    if (process.env.UNSEAL_FIXTURE === "1") {
      const body = scenes
        .map(
          ([caption, markup]) =>
            `<section class="fixture-scene"><p class="fixture-caption">${caption}</p>${markup}</section>`,
        )
        .join("\n");
      writeFileSync(fileURLToPath(new URL("../../../kitchen/reports/WO-120-fixture.html", import.meta.url)), body, "utf8");
    }
  });
});
