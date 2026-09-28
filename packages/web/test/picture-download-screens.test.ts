import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import type { Art } from "@/components/passport/art";
import type { Passport } from "@/lib/chain/registry";
import type { Studio } from "@/lib/studio/useStudio";
import { initialRegisterState, type RegisterState } from "@/lib/studio/flow";

/**
 * Where the download is offered, and where it is not. The studio's stub gets
 * it once a public registration or a drawn picture is on Monad; the passport
 * poster gets it for a public or an unsealed picture. A sealed passport gets
 * neither: its creator already holds the only copy, and nobody else may have it.
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
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": "true" }),
}));

const { Receipt } = await import("@/components/studio/Receipt");
const { Poster } = await import("@/components/passport/Poster");

const ID = `0x${"ab".repeat(32)}` as Hex;
const ROUTE = `/api/passports/${ID}/picture`;

function render(node: ReactElement, locale: "en" | "ta" = "en"): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(
    createElement(Provider, { locale, messages: locale === "en" ? en : ta, timeZone: "Asia/Kolkata" }, node),
  );
}

const PASSPORT_FIELDS = {
  exactHash: ID,
  parentId: `0x${"00".repeat(32)}`,
  generatorAgentId: "0",
  phash: "7840506850305415717",
  blockhash256: `0x${"11".repeat(32)}`,
  manifestHash: `0x${"22".repeat(32)}`,
  kind: 1,
  fingerprintVersion: 1,
  metadataURI: "ipfs://bafkreimetadata",
};

const PUBLISHED = {
  passport: PASSPORT_FIELDS,
  image: { cid: "bafkreiimage", uri: "ipfs://bafkreiimage", gatewayUrl: "https://gateway/image", bytes: 10, width: 1600, height: 1200 },
  thumbnail: { cid: "bafkreithumb", uri: "ipfs://bafkreithumb", gatewayUrl: "https://gateway/thumb" },
  metadata: { cid: "bafkreimetadata", uri: "ipfs://bafkreimetadata" },
  manifest: { embedded: true },
  preparedBy: "did:privy:someone",
};

const DRAWN = {
  ...PUBLISHED,
  passport: { ...PASSPORT_FIELDS, kind: 0, generatorAgentId: "10249", deadline: "1788878733" },
  generatorSig: `0x${"cd".repeat(65)}`,
  model: "gpt-image-1",
  agent: { id: "10249", wallet: "0xa37418c4047Fb6A42150D6E9Ddab77580Ddb9AFb" },
  quota: { used: 1, limit: 3, resetsAt: 1788961533 },
};

const SEALED = {
  passport: PASSPORT_FIELDS,
  metadata: { cid: "bafkreimetadata", uri: "ipfs://bafkreimetadata" },
  manifest: { embedded: true },
  preparedBy: "did:privy:someone",
  sealed: true,
};

function studio(register: Partial<RegisterState>): Studio {
  return {
    authenticated: true,
    account: { kind: "email", value: "ram@example.com" },
    wallet: "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c",
    binding: { status: "bound", passkey: { qx: `0x${"aa".repeat(32)}`, qy: `0x${"bb".repeat(32)}` } },
    bind: { txHash: `0x${"11".repeat(32)}` },
    actions: { saveSealed: () => undefined, stateAgain: async () => undefined },
    register: { ...initialRegisterState, ...register },
  } as unknown as Studio;
}

const LANDED = {
  digest: `0x${"cd".repeat(32)}` as Hex,
  txHash: `0x${"ef".repeat(32)}` as Hex,
  block: 103_059_393n,
  registeredAt: 1_788_876_542_000,
};

function downloads(markup: string): number {
  return markup.split("data-download-picture").length - 1;
}

describe("the studio stub", () => {
  it("offers the picture once a public registration is on Monad, with its one line of help", () => {
    const markup = render(createElement(Receipt, { studio: studio({ prepared: PUBLISHED as never, ...LANDED }) }));
    expect(downloads(markup)).toBe(1);
    expect(markup).toContain(`href="${ROUTE}"`);
    expect(markup).toMatch(/<a href="[^"]+\/picture" download=""/);
    expect(markup).toContain(en.studio.receipt.download);
    expect(markup).toContain("Download your picture");
    expect(markup).toContain(
      "The signed file, with its Content Credentials: a copy of it still verifies against this passport.",
    );
  });

  it("offers it after the agent draws a picture too", () => {
    const markup = render(
      createElement(Receipt, {
        studio: studio({ mode: "generate", prepared: DRAWN as never, generated: DRAWN as never, ...LANDED }),
      }),
    );
    expect(downloads(markup)).toBe(1);
    expect(markup).toContain(`href="${ROUTE}"`);
  });

  it("waits for Monad: a picture that is pinned but not yet registered has nothing to download from", () => {
    const markup = render(createElement(Receipt, { studio: studio({ prepared: PUBLISHED as never }) }));
    expect(markup).toContain(en.studio.receipt.pinned);
    expect(downloads(markup)).toBe(0);
  });

  it("never offers it after a sealed registration, which keeps its own Save the signed file", () => {
    const markup = render(createElement(Receipt, { studio: studio({ prepared: SEALED as never, ...LANDED }) }));
    expect(markup).toContain(en.studio.sealed.receipt.label);
    expect(downloads(markup)).toBe(0);
    expect(markup).not.toContain(ROUTE);
    expect(markup).not.toContain(en.studio.receipt.download);
  });

  it("says it in Tamil", () => {
    const markup = render(createElement(Receipt, { studio: studio({ prepared: PUBLISHED as never, ...LANDED }) }), "ta");
    expect(markup).toContain(ta.studio.receipt.download);
    expect(markup).toContain(ta.studio.receipt.downloadHelp);
  });
});

const passport: Passport = {
  id: ID,
  exactHash: ID,
  parentId: `0x${"00".repeat(32)}` as Hex,
  creator: "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a",
  generatorAgentId: 0n,
  phash: 0x6ccf137087789a25n,
  blockhash256: `0x${"11".repeat(32)}` as Hex,
  manifestHash: `0x${"22".repeat(32)}` as Hex,
  kind: 1,
  fingerprintVersion: 1,
  registeredAt: 1_788_876_082n,
  disputed: false,
  metadataURI: "ipfs://bafkreimetadata",
};

const publicArt: Art = {
  title: "Harbour at first light",
  imageUrl: "https://gateway.example/ipfs/bafkreiimage",
  thumbnailUrl: "https://gateway.example/ipfs/bafkreithumb",
  // The route can serve it: both the document and the image are bare content ids.
  original: true,
  missing: false,
};

const unsealedArt: Art = {
  ...publicArt,
  original: undefined,
  unsealed: {
    at: "2026-09-20T06:12:44.000Z",
    by: passport.creator,
    record: { cid: "bafkreirecord", uri: "ipfs://bafkreirecord" },
  },
};

const sealedArt: Art = {
  title: "Kept back",
  sealed: true,
  commitment: { algorithm: "sha-256", value: ID },
  missing: false,
};

async function poster(art: Art, locale: "en" | "ta" = "en"): Promise<string> {
  language.current = locale;
  return render(await Poster({ passport, art, locale }), locale);
}

function originals(markup: string): number {
  return markup.split("data-download-original").length - 1;
}

describe("the passport poster", () => {
  it("links the original of a public passport, as a download through the app's own route", async () => {
    const markup = await poster(publicArt);
    expect(originals(markup)).toBe(1);
    expect(markup).toContain(`href="${ROUTE}"`);
    expect(markup).toContain(en.passport.download);
  });

  it("links it for a passport its holder unsealed", async () => {
    const markup = await poster(unsealedArt);
    expect(originals(markup)).toBe(1);
    expect(markup).toContain(`href="${ROUTE}"`);
  });

  it("shows nothing to download on a sealed passport", async () => {
    const markup = await poster(sealedArt);
    expect(originals(markup)).toBe(0);
    expect(markup).not.toContain(ROUTE);
  });

  it("promises nothing when the gateway would not hand over the document", async () => {
    expect(originals(await poster({ missing: true }))).toBe(0);
  });

  it("says it in Tamil", async () => {
    expect(await poster(publicArt, "ta")).toContain(ta.passport.download);
  });
});
