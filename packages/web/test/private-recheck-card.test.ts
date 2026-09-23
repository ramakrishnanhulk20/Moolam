import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { Art } from "@/components/passport/art";
import type { Attestation, Passport } from "@/lib/chain/registry";
import type { ReportDelivery } from "@/lib/chain/reports";
import type { RecheckControl } from "@/lib/recheck/useRecheck";
import type { SealedCopyLookup } from "@/lib/verifier/client";

/**
 * The second opinion card on a sealed passport whose creator asked for the
 * private re-check.
 *
 * A verdict from the sealed receiver is named for what it is, including where
 * the workflow really ran. The card offers a re-check only while Moolam still
 * keeps the copy it runs on, and says in plain words when it does not or when
 * nobody can tell. A plain sealed passport reads exactly as it did.
 *
 * No row from the sealed receiver exists on chain yet: its listing in the
 * policy completes on 2026-09-24. These rows are fixtures.
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

vi.mock("next/navigation", () => ({ useParams: () => ({ locale: "en", id: `0x${"7c".repeat(32)}` }) }));
vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));

const delivery = vi.hoisted(() => ({ current: "simulation" as ReportDelivery }));
vi.mock("@/lib/chain/reports", () => ({ heldReportDelivery: async () => delivery.current }));

vi.mock("@/lib/recheck/useRecheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recheck/useRecheck")>()),
  useRecheckRequest: (): RecheckControl => ({
    state: { kind: "none" },
    spent: false,
    checking: false,
    actions: { request: () => undefined, check: () => undefined },
  }),
}));

const { Attestations } = await import("@/components/passport/Attestations");
const { Poster } = await import("@/components/passport/Poster");
const { addresses } = await import("@/lib/chain/client");

const SEALED_RECEIVER = "0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A" as Hex;
const TX = `0x${"91".repeat(32)}` as Hex;
const PHASH = 0x6ccf137087789a25n;

const privateRow: Attestation = {
  receiver: SEALED_RECEIVER,
  matched: true,
  distance: 0,
  recomputed: `0x${"0".repeat(48)}6ccf137087789a25` as Hex,
  at: 1_789_368_639n,
};

const publicRow: Attestation = { ...privateRow, receiver: addresses.receiver };

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node));
}

async function card(options: {
  rows?: Attestation[];
  sealed?: boolean;
  privateCopy?: SealedCopyLookup["state"];
}): Promise<string> {
  const rows = options.rows ?? [];
  return render(
    await Attestations({
      attestations: rows,
      indexed: rows.map((row) => ({ txHash: TX, receiver: row.receiver, at: row.at, distance: row.distance })) as never,
      phash: PHASH,
      locale: "en",
      sealed: options.sealed ?? true,
      privateCopy: options.privateCopy,
    }),
  );
}

/** React escapes an apostrophe in the rendered markup, the message file does not. */
function asRendered(line: string): string {
  return line.replace(/'/g, "&#x27;");
}

const words = en.passport.attestations;
const sealedWords = en.passport.sealed;
const BUTTON = en.recheck.button;

describe("a verdict written by the sealed receiver", () => {
  it("wears the private re-check badge and says where the workflow really ran", async () => {
    const markup = await card({ rows: [privateRow], privateCopy: "kept" });

    expect(markup).toContain(words.private.badge);
    expect(markup).toContain(asRendered(words.private.line));
    expect(markup).not.toContain(words.byReceiver);
  });

  it("keeps the delivery line read off the forwarder", async () => {
    delivery.current = "simulation";
    expect(await card({ rows: [privateRow], privateCopy: "kept" })).toContain(asRendered(words.delivery.simulation));

    delivery.current = "network";
    expect(await card({ rows: [privateRow], privateCopy: "kept" })).toContain(asRendered(words.delivery.network));
    delivery.current = "simulation";
  });

  it("leaves a public Chainlink verdict exactly as it was", async () => {
    const markup = await card({ rows: [publicRow], sealed: false });

    expect(markup).toContain(words.byChainlink);
    expect(markup).not.toContain(words.private.badge);
    expect(markup).not.toContain(asRendered(words.private.line));
  });

  it("names the sealed receiver on the chain client", () => {
    expect(addresses.sealedReceiver).toBe(SEALED_RECEIVER);
  });
});

describe("a sealed passport that asked for the private re-check, before any verdict", () => {
  it("offers the re-check while the copy is kept", async () => {
    const markup = await card({ privateCopy: "kept" });

    expect(markup).toContain(sealedWords.privateCopy.kept);
    expect(markup).toContain(BUTTON);
    expect(markup).not.toContain(sealedWords.recheck);
  });

  it("says the copy was deleted and offers nothing once it is gone", async () => {
    const markup = await card({ privateCopy: "gone" });

    expect(markup).toContain(asRendered(sealedWords.privateCopy.gone));
    expect(markup).not.toContain(BUTTON);
  });

  it("says it could not tell and offers nothing when the state is unknown", async () => {
    const markup = await card({ privateCopy: "unknown" });

    expect(markup).toContain(asRendered(sealedWords.privateCopy.unknown));
    expect(markup).not.toContain(BUTTON);
    expect(markup).not.toContain(asRendered(sealedWords.privateCopy.gone));
  });
});

describe("the same passport once a verdict is on chain", () => {
  it("still offers another re-check while the copy is kept", async () => {
    expect(await card({ rows: [privateRow], privateCopy: "kept" })).toContain(BUTTON);
  });

  it("says why there is no button in the button's place once the copy is gone", async () => {
    const markup = await card({ rows: [privateRow], privateCopy: "gone" });

    expect(markup).not.toContain(BUTTON);
    expect(markup).toContain(asRendered(sealedWords.privateCopy.gone));
  });
});

describe("a plain sealed passport", () => {
  it("keeps today's no public copy sentence and no button", async () => {
    const markup = await card({});

    expect(markup).toContain(sealedWords.recheck);
    expect(markup).not.toContain(BUTTON);
    expect(markup).not.toContain(sealedWords.privateCopy.kept);
  });
});

describe("a published passport", () => {
  it("keeps the button whatever it is handed", async () => {
    expect(await card({ sealed: false })).toContain(BUTTON);
  });
});

describe("the poster line", () => {
  const passport: Passport = {
    id: `0x${"7c".repeat(32)}` as Hex,
    exactHash: `0x${"7c".repeat(32)}` as Hex,
    parentId: `0x${"00".repeat(32)}` as Hex,
    creator: "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a",
    generatorAgentId: 0n,
    phash: PHASH,
    blockhash256: "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0",
    manifestHash: `0x${"22".repeat(32)}` as Hex,
    kind: 1,
    fingerprintVersion: 1,
    registeredAt: 1_788_876_082n,
    disputed: false,
    metadataURI: "ipfs://bafkreisealedmetadata",
  };
  const sealedArt: Art = { title: "Monsoon nets, Kovalam", sealed: true, missing: false };

  it("says Moolam keeps only the small private copy when the creator asked for one", async () => {
    const markup = render(await Poster({ passport, art: { ...sealedArt, privateRecheck: true }, locale: "en" }));

    expect(markup).toContain(
      "The picture is not published. Moolam keeps only a small private copy, for the private re-check.",
    );
    expect(markup).not.toContain("Moolam keeps no copy");
  });

  it("keeps the no copy line for a plain sealed passport", async () => {
    const markup = render(await Poster({ passport, art: sealedArt, locale: "en" }));

    expect(markup).toContain("The picture is not published. Moolam keeps no copy.");
    expect(markup).not.toContain("private copy");
  });
});
