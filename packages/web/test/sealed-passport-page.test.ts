import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import type { Art } from "@/components/passport/art";
import type { Attestation, Passport } from "@/lib/chain/registry";
import { initialEditState } from "@/lib/passport/edit";

/**
 * The passport page for a picture nobody else will ever see.
 *
 * Invariant 7 of the sealed threat model is the whole subject: the page says
 * sealed, and it never says broken, never says "not re-checked yet" as if that
 * were a fault the holder could fix, and never offers a link to a picture that
 * is not there.
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
  useRouter: () => ({ refresh: () => undefined }),
}));

const wallet = vi.hoisted(() => ({ mounted: true, owner: true, configured: true }));

vi.mock("@/components/providers/WalletProvider", () => ({ useWalletMounted: () => wallet.mounted }));

vi.mock("@/lib/passport/useEditPassport", () => ({
  useEditPassport: () => ({
    ready: true,
    isOwner: wallet.owner,
    configured: wallet.configured,
    granted: true,
    granting: false,
    grantFailure: null,
    state: initialEditState,
    actions: { grant: () => undefined, choose: () => undefined, setTitle: () => undefined, setNote: () => undefined, submit: () => undefined },
  }),
}));

const { Poster } = await import("@/components/passport/Poster");
const { Attestations } = await import("@/components/passport/Attestations");
const { Facts } = await import("@/components/passport/Facts");
const { Editor } = await import("@/components/passport/Editor");

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

const sealedArt: Art = {
  title: "Monsoon nets, Kovalam",
  description: "Registered on Moolam. The picture is not published.",
  sealed: true,
  commitment: { algorithm: "sha-256", value: ID },
  blockhash: BLOCKHASH,
  missing: false,
};

const publicArt: Art = {
  title: "Kadal at dawn",
  imageUrl: "https://gateway.example/full.jpg",
  thumbnailUrl: "https://gateway.example/small.jpg",
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
  return render(
    await Facts({ passport, art, owner: CREATOR, hasPasskey: true, standing: "unverified", txHash: null }),
  );
}

async function attestations(sealed: boolean, rows: Attestation[] = []): Promise<string> {
  language.current = "en";
  return render(await Attestations({ attestations: rows, indexed: [], phash: passport.phash, locale: "en", sealed }));
}

describe("the poster on a sealed passport", () => {
  it("says sealed, names the day and says the picture is not published", async () => {
    const markup = await poster(sealedArt);

    expect(markup).toContain(en.passport.sealed.label);
    expect(markup).toContain("Monsoon nets, Kovalam");
    expect(markup).toContain("The picture is not published. Moolam keeps no copy.");
    expect(markup).toContain("8 Sept 2026");
  });

  it("draws the block hash rather than an image, so there is no picture to fail", async () => {
    const markup = await poster(sealedArt);

    expect(markup).not.toContain("<img");
    expect(markup).not.toContain(en.passport.noPicture);
    // 256 cells: the sketch is the fingerprint the chain holds, drawn.
    expect(markup.match(/<span class="bg-text/g)?.length).toBeGreaterThan(30);
  });

  it("says it in the reader's own language", async () => {
    const markup = await poster(sealedArt, "ta");

    expect(markup).toContain(ta.passport.sealed.label);
    expect(markup).not.toContain(en.passport.sealed.posterLine.split("{date}")[1]);
  });

  it("leaves a published passport's poster exactly as it was", async () => {
    const markup = await poster(publicArt);

    expect(markup).toContain(en.passport.registered);
    expect(markup).not.toContain(en.passport.sealed.label);
  });
});

describe("the second opinion block on a sealed passport", () => {
  it("says there is no public copy to re-check, not that nobody has got round to it", async () => {
    const markup = await attestations(true);

    expect(markup).toContain(en.passport.sealed.recheck);
    expect(markup).not.toContain(en.passport.attestations.empty.replaceAll("'", "&#x27;"));
    expect(markup).not.toContain(en.passport.attestations.whatIsRecheck);
  });

  it("keeps the ordinary empty state for a published passport nobody has re-checked", async () => {
    const markup = await attestations(false);

    expect(markup).toContain(en.passport.attestations.empty.replaceAll("'", "&#x27;"));
    expect(markup).not.toContain(en.passport.sealed.recheck);
  });
});

describe("the record on a sealed passport", () => {
  it("prints the commitment where the picture's address would be", async () => {
    const markup = await facts(sealedArt);

    expect(markup).toContain(en.passport.sealed.commitmentLabel);
    expect(markup).toContain(en.passport.sealed.commitmentAlgorithm.replace("{algorithm}", "sha-256"));
    expect(markup).toContain(en.passport.sealed.commitmentLine);
    expect(markup).not.toContain(en.passport.openImage);
  });

  it("does not call a sealed record not re-checked yet", async () => {
    const markup = await facts(sealedArt);

    expect(markup).toContain(en.passport.sealed.standing);
    expect(markup).not.toContain(en.passport.standing.unverified);
  });

  it("leaves a published passport's record alone", async () => {
    const markup = await facts(publicArt);

    expect(markup).toContain(en.passport.standing.unverified);
    expect(markup).toContain(en.passport.openImage);
    expect(markup).not.toContain(en.passport.sealed.commitmentLabel);
  });
});

describe("the edit panel on a sealed passport", () => {
  it("tells the holder why it cannot be edited and draws no drop zone", () => {
    language.current = "en";
    const markup = render(createElement(Editor, { parentId: ID, owner: CREATOR, sealed: true }));

    expect(markup).toContain(en.passport.sealed.edit);
    expect(markup).not.toContain(en.passport.edit.form.drop);
    expect(markup).not.toContain(en.passport.edit.form.choose);
  });

  it("still offers the drop zone on a published passport", () => {
    language.current = "en";
    const markup = render(createElement(Editor, { parentId: ID, owner: CREATOR, sealed: false }));

    expect(markup).toContain(en.passport.edit.form.drop);
    expect(markup).not.toContain(en.passport.sealed.edit);
  });
});
