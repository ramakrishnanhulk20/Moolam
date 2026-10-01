import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { Art } from "@/components/passport/art";
import type { Attestation, Passport } from "@/lib/chain/registry";
import type { ReportDelivery } from "@/lib/chain/reports";
import type { RecheckState } from "@/lib/recheck/state";
import type { RecheckControl } from "@/lib/recheck/useRecheck";
import type { SealedCopyLookup } from "@/lib/verifier/client";

/**
 * Every sentence on a passport page is true for that passport's state.
 *
 * A sealed document's description is the one sentence Moolam wrote at
 * registration and pinned for ever. It said "kept no copy" on a passport whose
 * creator asked for the private copy, and "never published" on one its holder
 * published later (judge audit 4, B4). The page now says the sentence for the
 * state today and leaves the pinned one in the metadata link.
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

const stub = vi.hoisted(() => ({ state: { kind: "none" } as RecheckState }));
vi.mock("@/lib/recheck/useRecheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recheck/useRecheck")>()),
  useRecheckRequest: (): RecheckControl => ({
    state: stub.state,
    spent: false,
    checking: false,
    actions: { request: () => undefined, check: () => undefined },
  }),
}));

const { Facts } = await import("@/components/passport/Facts");
const { aboutLine } = await import("@/components/passport/about");
const { Attestations } = await import("@/components/passport/Attestations");
const { addresses } = await import("@/lib/chain/client");

const ID = `0x${"7c".repeat(32)}` as Hex;
const CREATOR = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;

/** The fixed sentence the verify service pins on every sealed upload (packages/verifier/src/metadata.ts). */
const PINNED =
  "A picture registered with Moolam from a file its creator uploaded and chose to keep sealed, so the picture itself was never published and Moolam kept no copy of it. The passport id is the sha256 of the signed file, so this record commits to the exact bytes without showing them. The creator signed this fingerprint with a passkey before the registry would write the record.";

const passport: Passport = {
  id: ID,
  exactHash: ID,
  parentId: `0x${"00".repeat(32)}` as Hex,
  creator: CREATOR,
  generatorAgentId: 0n,
  phash: 0x6ccf137087789a25n,
  blockhash256: "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0" as Hex,
  manifestHash: `0x${"22".repeat(32)}` as Hex,
  kind: 1,
  fingerprintVersion: 1,
  registeredAt: 1_788_876_082n,
  disputed: false,
  metadataURI: "ipfs://bafkreisealedmetadata",
};

const sealedArt: Art = {
  title: "Monsoon nets, Kovalam",
  description: PINNED,
  sealed: true,
  commitment: { algorithm: "sha-256", value: ID },
  missing: false,
};

const privateArt: Art = { ...sealedArt, privateRecheck: true };

const publishedArt: Art = {
  title: "Monsoon nets, Kovalam",
  description: PINNED,
  imageUrl: "https://gateway.example/full.jpg",
  thumbnailUrl: "https://gateway.example/small.jpg",
  unsealed: {
    at: "2026-09-22T10:15:00.000Z",
    by: CREATOR,
    record: { cid: "bafkreiunsealrecord", uri: "ipfs://bafkreiunsealrecord" },
  },
  missing: false,
};

const publicArt: Art = {
  title: "Kadal at dawn",
  description: "Fishing boats at dawn on the Kovalam shore, shot on a phone.",
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
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node));
}

/** React escapes an apostrophe in the rendered markup, the message file does not. */
function asRendered(line: string): string {
  return line.replace(/'/g, "&#x27;");
}

async function facts(art: Art, privateCopy?: SealedCopyLookup["state"]): Promise<string> {
  return render(
    await Facts({ passport, art, owner: CREATOR, hasPasskey: true, standing: "unverified", txHash: null, privateCopy }),
  );
}

/** The ABOUT line alone, so a sentence elsewhere in the record cannot pass for it. */
function aboutOf(markup: string): string {
  const found = /<dd data-about="[^"]*"[^>]*>([\s\S]*?)<\/dd>/.exec(markup);
  expect(found, "the page has an ABOUT line").not.toBeNull();
  return found?.[1] ?? "";
}

const about = en.passport.sealed.about;

describe("the ABOUT line on a sealed passport", () => {
  it("sealed with nothing kept: says so, and never prints the pinned sentence", async () => {
    const markup = await facts(sealedArt);

    expect(aboutOf(markup)).toBe(about.noCopy);
    expect(markup).not.toContain(PINNED);
    expect(markup).toContain('data-about="noCopy"');
  });

  it("sealed with the private copy kept: says Moolam keeps it, never that it kept no copy", async () => {
    const markup = await facts(privateArt, "kept");

    expect(aboutOf(markup)).toBe(asRendered(about.kept));
    expect(markup).not.toContain(PINNED);
    expect(aboutOf(markup)).not.toContain("kept no copy");
  });

  it("sealed and the private copy since deleted: says it was kept and then deleted", async () => {
    const markup = await facts(privateArt, "gone");

    expect(aboutOf(markup)).toBe(about.deleted);
    expect(markup).not.toContain(PINNED);
    expect(aboutOf(markup)).not.toContain("kept no copy");
  });

  it("sealed and published later by its holder: names the day, never says never published", async () => {
    const markup = await facts(publishedArt);

    expect(aboutOf(markup)).toBe(about.published.replace("{date}", "22 Sept 2026"));
    expect(markup).not.toContain(PINNED);
    expect(aboutOf(markup)).not.toContain("never published");
  });

  it("a private copy nobody could read says only what is true either way", async () => {
    const markup = await facts(privateArt, "unknown");

    expect(aboutOf(markup)).toBe(about.asked);
    expect(aboutOf(markup)).not.toContain("kept no copy");
    expect(aboutOf(markup)).not.toContain("deleted");
    // Undefined is the page not having asked, which reads the same way.
    expect(aboutOf(await facts(privateArt))).toBe(about.asked);
  });

  it("keeps the pinned text one tap away, in the metadata link", async () => {
    const markup = await facts(privateArt, "kept");

    expect(markup).toContain('href="https://');
    expect(markup).toContain("bafkreisealedmetadata");
  });
});

describe("the ABOUT line on a public passport", () => {
  it("shows the creator's description exactly as written", async () => {
    const markup = await facts(publicArt);

    expect(aboutOf(markup)).toBe(publicArt.description);
    expect(markup).toContain('data-about="pinned"');
  });

  it("draws no ABOUT line when a public document has none", async () => {
    const markup = await facts({ ...publicArt, description: undefined });

    expect(markup).not.toContain("data-about");
  });

  it("is chosen by state alone, whatever the copy lookup says", () => {
    expect(aboutLine(publicArt, "gone")).toEqual({ kind: "pinned", text: publicArt.description });
    expect(aboutLine(sealedArt, "kept")).toEqual({ kind: "sealed", key: "noCopy" });
    expect(aboutLine({ ...sealedArt, description: undefined })).toEqual({ kind: "sealed", key: "noCopy" });
  });
});

const SEALED_RECEIVER = "0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A" as Hex;
const TX = `0x${"91".repeat(32)}` as Hex;

const privateRow: Attestation = {
  receiver: SEALED_RECEIVER,
  matched: true,
  distance: 0,
  recomputed: `0x${"0".repeat(48)}6ccf137087789a25` as Hex,
  at: 1_789_368_639n,
};

const publicRow: Attestation = { ...privateRow, receiver: addresses.receiver };

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
      phash: passport.phash,
      locale: "en",
      sealed: options.sealed ?? true,
      privateCopy: options.privateCopy,
    }),
  );
}

/** One row's markup, so the section around it cannot answer for it. */
function rowOf(markup: string): string {
  const found = /<li class="bg-bg[^"]*">([\s\S]*?)<\/li>/.exec(markup);
  expect(found, "the card has a row").not.toBeNull();
  return found?.[1] ?? "";
}

const words = en.passport.attestations;

describe("a re-check row written by the sealed receiver", () => {
  it("says the workflow opened the private copy, never that it fetched the picture", async () => {
    stub.state = { kind: "none" };
    const row = rowOf(await card({ rows: [privateRow], privateCopy: "kept" }));

    expect(row).not.toMatch(/fetch/i);
    expect(row).toContain("opened the small private copy Moolam kept of this picture and compared its fingerprint");
    expect(row).toContain(words.private.gridNote.replace(/'/g, "&#x27;"));
  });

  it("the whole sealed section, intro and control included, never says fetched", async () => {
    stub.state = { kind: "running" };
    const markup = await card({ rows: [privateRow], privateCopy: "kept" });

    expect(markup).not.toMatch(/fetch/i);
    expect(markup).toContain(words.sealedBody.replace(/'/g, "&#x27;"));
    expect(markup).toContain(en.recheck.notePrivate.replace(/'/g, "&#x27;"));
    expect(markup).toContain(en.recheck.runningPrivate);
    stub.state = { kind: "none" };
  });

  it("a plain sealed passport's intro never says fetched either", async () => {
    expect(await card({})).not.toMatch(/fetch/i);
  });
});

describe("a public re-check row", () => {
  it("keeps today's words", async () => {
    const markup = await card({ rows: [publicRow], sealed: false });

    expect(markup).toContain(words.body.replace(/'/g, "&#x27;"));
    expect(markup).toContain("A Chainlink CRE workflow re-fetched this picture and recomputed its fingerprint");
    expect(markup).toContain(words.gridNote);
    // A passport that already carries a verdict has no button, so no note for it.
    expect(markup).not.toContain(en.recheck.note.replace(/'/g, "&#x27;"));
    expect(markup).toContain("Checked on");
    expect(markup).not.toContain(words.private.gridNote.replace(/'/g, "&#x27;"));
    expect(markup).not.toContain(words.sealedBody.replace(/'/g, "&#x27;"));
  });
});

describe("the private re-check line", () => {
  const lead = words.private.lead;
  const limit = words.private.limit.replace(/'/g, "&#x27;");

  it("leads with what happened and puts the limit second", async () => {
    delivery.current = "simulation";
    const row = rowOf(await card({ rows: [privateRow], privateCopy: "kept" }));

    expect(lead).toBe("Checked privately by a Chainlink confidential workflow, from the small copy Moolam keeps.");
    expect(words.private.limit).toBe("It ran in Chainlink's simulator on one machine, not inside Chainlink's secure hardware.");
    expect(row.indexOf(lead)).toBeGreaterThan(-1);
    expect(row.indexOf(limit)).toBeGreaterThan(row.indexOf(lead));
  });

  it("names the simulator once, in the limit's plainer words, and drops the forwarder line", async () => {
    delivery.current = "simulation";
    const row = rowOf(await card({ rows: [privateRow], privateCopy: "kept" }));

    expect(row.split(limit).length - 1).toBe(1);
    expect(row.split("simulator").length - 1).toBe(1);
    expect(row).not.toContain(words.delivery.simulation.replace(/'/g, "&#x27;"));
  });

  it("never says Moolam keeps a copy that has since been deleted", async () => {
    const row = rowOf(await card({ rows: [privateRow], privateCopy: "gone" }));

    expect(row).toContain(words.private.leadEarlier);
    expect(row).not.toContain(lead);
  });

  it("does not claim the simulator for a report the network forwarder delivered", async () => {
    delivery.current = "network";
    const row = rowOf(await card({ rows: [privateRow], privateCopy: "kept" }));

    expect(row).toContain(lead);
    expect(row).not.toContain(limit);
    expect(row).toContain(words.delivery.network);
    delivery.current = "simulation";
  });
});

describe("the re-check control's place once a request has finished", () => {
  const DONE: RecheckState = { kind: "done", finishedAt: 1_790_000_300_000, reportTx: TX, matched: true, distance: 0 };
  const BUTTON = en.recheck.button;
  const STAMP_DONE = `>${en.recheck.stamp.done}<`;

  it("a passport that carries a re-check says Re-checked on the newest row's date, never DONE", async () => {
    stub.state = DONE;
    const older: Attestation = { ...publicRow, at: 1_788_900_000n };
    const markup = await card({ rows: [older, publicRow], sealed: false });

    // 1_789_368_639 is 14 Sept 2026 in UTC; the older row is 9 Sept.
    expect(markup).toContain("Checked on 14 Sept 2026");
    expect(markup).not.toContain("Checked on 9 Sept 2026");
    expect(markup).not.toContain(STAMP_DONE);
    expect(markup).not.toContain("Done: checked");
    expect(markup).toContain('data-recheck-state="rechecked"');
    stub.state = { kind: "none" };
  });

  it("a finished request on a page drawn before its verdict says the chain's own date", async () => {
    stub.state = DONE;
    const markup = await card({ sealed: false });

    // 1_790_000_300 is 21 September 2026, the date the chain confirmed, in the
    // client formatter's own English style.
    expect(markup).toContain("Checked on Sep 21, 2026");
    expect(markup).not.toContain(STAMP_DONE);
    expect(markup).not.toContain(BUTTON);
    expect(markup).toContain('data-recheck-state="rechecked"');
    stub.state = { kind: "none" };
  });

  it("a finished request with no date from the chain or the page says nothing and offers the control again", async () => {
    stub.state = { kind: "done" };
    const markup = await card({ sealed: false });

    expect(markup).not.toContain(STAMP_DONE);
    expect(markup).not.toContain("Done: checked");
    expect(markup).not.toContain("Checked on");
    expect(markup).toContain(BUTTON);
    expect(markup).toContain('data-recheck-state="none"');
    stub.state = { kind: "none" };
  });

  it("a request still moving keeps its own words, rows or not", async () => {
    stub.state = { kind: "running" };
    const markup = await card({ rows: [publicRow], sealed: false });

    expect(markup).toContain(en.recheck.running);
    expect(markup).not.toContain("Checked on");
    stub.state = { kind: "none" };
  });

  it("a screen that does not read the rows keeps the queue's own Done", async () => {
    const { seatOf } = await import("@/components/passport/RecheckRequest");

    expect(seatOf(DONE, undefined)).toEqual({ state: DONE });
    expect(seatOf(DONE, null)).toEqual({ state: { kind: "none" } });
    expect(seatOf(DONE, "14 Sept 2026")).toEqual({ state: { kind: "none" }, rechecked: "14 Sept 2026" });
    expect(seatOf(DONE, null, () => "21 Sept 2026")).toEqual({ state: { kind: "none" }, rechecked: "21 Sept 2026" });
    // Nobody has asked in this tab and the page holds a verdict: its date, and no button.
    expect(seatOf({ kind: "none" }, "14 Sept 2026")).toEqual({ state: { kind: "none" }, rechecked: "14 Sept 2026" });
    expect(seatOf({ kind: "none" }, null)).toEqual({ state: { kind: "none" } });
    // A failed request the queue still remembers gives way to the verdict on chain.
    expect(seatOf({ kind: "failed", reason: "x" }, "14 Sept 2026")).toEqual({ state: { kind: "none" }, rechecked: "14 Sept 2026" });
    expect(seatOf({ kind: "failed", reason: "x" }, null)).toEqual({ state: { kind: "failed", reason: "x" } });
    expect(seatOf({ kind: "failed", reason: "x" }, undefined)).toEqual({ state: { kind: "failed", reason: "x" } });
  });
});
