import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import type { Art } from "@/components/passport/art";
import type { Attestation, Passport } from "@/lib/chain/registry";
import type { ExplorePlate } from "@/components/explore/sort";
import type { MatchedPassport } from "@/components/verify/lookup";
import { readAnswer } from "@/components/verify/answer";
import { verifyResponseSchema } from "@/lib/verifier/client";

/**
 * Every screen for a passport that was registered sealed and published later.
 *
 * The rule being tested is the quiet one: once the picture is out, this is an
 * ordinary passport everywhere, with the picture on it and no seal language
 * left. The single thing that stays is the sentence saying it was held back at
 * first, because that is a fact about the record nobody could work out from the
 * document, which still says sealed and always will.
 */

const language = { current: "en" as "en" | "ta" };

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: language.current, messages: language.current === "en" ? en : ta, namespace }),
  getFormatter: async () => ({
    dateTime: (date: Date) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(date),
  }),
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ push: vi.fn(), refresh: () => undefined }),
}));

const link = vi.hoisted(() => ({ pending: false }));

vi.mock("next/link", () => ({
  default: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
  useLinkStatus: () => link,
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": "true" }),
}));

const { Poster } = await import("@/components/passport/Poster");
const { Facts } = await import("@/components/passport/Facts");
const { Attestations } = await import("@/components/passport/Attestations");
const { Plate } = await import("@/components/explore/Plate");
const { AnswerCard } = await import("@/components/verify/AnswerCard");

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

/** What withUnseal hands the screens once the record is found. */
const unsealedArt: Art = {
  title: "Monsoon nets, Kovalam",
  description: "Registered on Moolam.",
  imageUrl: "https://gateway.example/ipfs/bafkreiimage",
  thumbnailUrl: "https://gateway.example/ipfs/bafkreithumb",
  unsealed: { at: UNSEALED_AT, by: CREATOR, record: { cid: "bafkreirecord", uri: "ipfs://bafkreirecord" } },
  missing: false,
};

const sealedArt: Art = {
  title: "Monsoon nets, Kovalam",
  sealed: true,
  commitment: { algorithm: "sha-256", value: ID },
  blockhash: BLOCKHASH,
  missing: false,
};

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(
    createElement(
      Provider,
      { locale: language.current, messages: language.current === "en" ? en : ta, timeZone: "Asia/Kolkata" },
      node,
    ),
  );
}

async function poster(art: Art, locale: "en" | "ta" = "en"): Promise<string> {
  language.current = locale;
  return render(await Poster({ passport, art, locale }));
}

async function facts(art: Art): Promise<string> {
  language.current = "en";
  return render(await Facts({ passport, art, owner: CREATOR, hasPasskey: true, standing: "unverified", txHash: null }));
}

async function attestations(art: Art, rows: Attestation[] = []): Promise<string> {
  language.current = "en";
  return render(
    await Attestations({
      attestations: rows,
      indexed: [],
      phash: passport.phash,
      locale: "en",
      sealed: art.sealed === true,
    }),
  );
}

describe("the poster once the picture is published", () => {
  it("draws the picture and drops every sealed word", async () => {
    const markup = await poster(unsealedArt);

    expect(markup).toContain('data-picture="true"');
    expect(markup).not.toContain(en.passport.sealed.label);
    expect(markup).not.toContain(en.passport.noPicture);
    expect(markup).toContain("Monsoon nets, Kovalam");
  });

  it("says when it was published, where the sealed line stood", async () => {
    const markup = await poster(unsealedArt);

    expect(markup).toContain("Published 20 Sept 2026");
    expect(markup).toContain(en.passport.registered);
  });

  it("says it in the reader's own language", async () => {
    const markup = await poster(unsealedArt, "ta");

    expect(markup).toContain(ta.passport.unsealed.poster.split("{date}")[1].trim());
    expect(markup).not.toContain("Published 20 Sept 2026");
  });

  it("leaves a still sealed passport exactly as it was", async () => {
    const markup = await poster(sealedArt);

    expect(markup).toContain(en.passport.sealed.label);
    expect(markup).not.toContain("Published");
  });
});

describe("the record once the picture is published", () => {
  it("offers the picture's address and tells the story in one line", async () => {
    const markup = await facts(unsealedArt);

    expect(markup).toContain(en.passport.openImage);
    expect(markup).toContain(en.passport.unsealed.label);
    expect(markup).toContain("published by its holder on 20 Sept 2026");
    expect(markup).toContain("bafkreirecord");
  });

  it("puts the commitment away, because there is a picture at the other end now", async () => {
    const markup = await facts(unsealedArt);

    expect(markup).not.toContain(en.passport.sealed.commitmentLabel);
    expect(markup).not.toContain(en.passport.sealed.standing);
    expect(markup).toContain(en.passport.standing.unverified);
  });
});

describe("the second opinion once the picture is published", () => {
  it("reads like any other passport nobody has re-checked yet", async () => {
    const markup = await attestations(unsealedArt);

    expect(markup).toContain(en.passport.attestations.empty.replaceAll("'", "&#x27;"));
    expect(markup).not.toContain(en.passport.sealed.recheck);
  });
});

describe("the Explore plate once the picture is published", () => {
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

  it("draws the picture with no sealed mark and no sealed word", () => {
    language.current = "en";
    const markup = render(createElement(Plate, { plate, index: 0 }));

    expect(markup).toContain('data-picture="true"');
    expect(markup).not.toContain(en.explore.sealed.word);
    expect(markup).toContain("Monsoon nets, Kovalam");
  });
});

describe("the verify answer once the picture is published", () => {
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

  it("shows the matched picture and says it was sealed at first", () => {
    language.current = "en";
    const markup = render(createElement(AnswerCard, { stage: { kind: "answer", answer, passport: matched } }));

    expect(markup).toContain('data-picture="true"');
    // The card formats in the browser through next-intl, which writes an en
    // date the American way; the server components above use the mock.
    expect(markup).toContain("published the picture on Sep 20, 2026");
    expect(markup).not.toContain(en.verify.sealed.matched);
    expect(markup).not.toContain(en.verify.sealed.recheck);
  });

  it("says nothing of the kind for a passport that was public all along", () => {
    language.current = "en";
    const plain = { ...matched, unsealedAt: undefined };
    const markup = render(createElement(AnswerCard, { stage: { kind: "answer", answer, passport: plain } }));

    expect(markup).not.toContain("published the picture on");
  });
});
