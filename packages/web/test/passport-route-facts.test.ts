import { describe, expect, it, vi } from "vitest";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { Art } from "@/components/passport/art";
import type { ConsentReading } from "@/lib/chain/consent";
import type { Attestation, Passport, PassportRecordBundle } from "@/lib/chain/registry";

/**
 * The real passport route opens with the facts strip, drawn from the reads the
 * page already makes. Everything below the poster is stubbed: this holds the
 * poster, the strip and the anchor the strip's AI use link lands on.
 */

const reads = vi.hoisted(() => ({
  record: undefined as unknown,
  art: undefined as unknown,
  consent: undefined as unknown,
}));

vi.mock("next/server", async (real) => ({
  ...(await real<typeof import("next/server")>()),
  connection: vi.fn(),
}));
vi.mock("next/cache", () => ({ unstable_cache: <T,>(read: T) => read }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: en, namespace }),
  getFormatter: async () => ({
    dateTime: (date: Date) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(date),
  }),
  setRequestLocale: () => undefined,
}));
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: ReactNode; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children),
}));

vi.mock("@/lib/chain/registry", async (real) => ({
  ...(await real<typeof import("@/lib/chain/registry")>()),
  heldPassportRecord: async () => reads.record,
  // The agent's card will not answer, so the strip keeps the agent's number.
  heldAgent: async () => {
    throw new Error("card gateway down");
  },
}));
vi.mock("@/lib/chain/consent", async (real) => ({
  ...(await real<typeof import("@/lib/chain/consent")>()),
  heldConsent: async () => reads.consent,
  heldConsentHistory: async () => [],
  heldStandard: async () => ({ name: "cawg.training-mining", version: "1.1" }),
  heldMinInterval: async () => 0n,
}));
vi.mock("@/lib/chain/time", () => ({ headTimestamp: async () => 1_790_000_000n }));
vi.mock("@/lib/data/source", () => ({ activeSource: () => "rpc" }));
vi.mock("@/lib/data/lineage", () => ({ inheritedDisputed: vi.fn() }));
vi.mock("@/lib/data/passports", () => ({ heldRegistration: vi.fn() }));
vi.mock("@/lib/data/prerender", () => ({ realPictureIds: async () => [] }));
vi.mock("@/lib/data/unseal", () => ({ withUnseal: async (art: unknown) => art }));
vi.mock("@/lib/verifier/client", () => ({ sealedStatus: async () => ({ state: "kept" }) }));
vi.mock("@/components/passport/art", () => ({ readArt: async () => reads.art }));
vi.mock("@/components/passport/indexed", () => ({ heldIndexedAttestations: async () => [], heldIndexedVerdictRows: async () => [] }));
// The poster's trust mark has its own suite (test/marks.test.ts); here it is a fixed waiting mark.
vi.mock("@/components/mark/read", async () => (await import("./mark-fixtures")).markReadMock);
vi.mock("@/components/passport/Picture", () => ({ Picture: () => createElement("span", { "data-picture": "true" }) }));
vi.mock("@/components/passport/Attestations", () => ({ Attestations: () => null }));
vi.mock("@/components/passport/CheckCopy", () => ({ CheckCopy: () => null }));
vi.mock("@/components/passport/DisputeNote", () => ({ DisputeNote: () => null }));
vi.mock("@/components/passport/DisputePanel", () => ({ DisputePanel: () => null }));
vi.mock("@/components/passport/EditPanel", () => ({ EditPanel: () => null }));
vi.mock("@/components/passport/Facts", () => ({ Facts: () => null }));
vi.mock("@/components/passport/Lineage", () => ({ Lineage: () => null }));
vi.mock("@/components/passport/PrivateCopyPanel", () => ({ PrivateCopyPanel: () => null }));
vi.mock("@/components/passport/UnsealPanel", () => ({ UnsealPanel: () => null }));
vi.mock("@/components/consent/ConsentSection", () => ({
  ConsentSection: () => createElement("section", { "data-consent": "true" }),
}));
vi.mock("@/components/providers/WalletProvider", () => ({
  WalletProvider: (props: { children?: ReactNode }) => props.children,
}));
vi.mock("@/app/[locale]/passport/[id]/opengraph-image", () => ({ passportShareMetadata: () => ({}) }));

const { default: PassportPage } = await import("@/app/[locale]/passport/[id]/page");
const { addresses } = await import("@/lib/chain/client");

const ID = `0x${"cd".repeat(32)}` as Hex;
const CREATOR = "0x85a88C5b1b7D1b1a3F3b8c0cF4d7a0F1E4b239a6" as Hex;
const PHASH = 0x6ccf137087789a25n;

const passport: Passport = {
  id: ID,
  exactHash: ID,
  parentId: `0x${"00".repeat(32)}` as Hex,
  creator: CREATOR,
  generatorAgentId: 10249n,
  phash: PHASH,
  blockhash256: `0x${"11".repeat(32)}` as Hex,
  manifestHash: `0x${"22".repeat(32)}` as Hex,
  kind: 0,
  fingerprintVersion: 1,
  registeredAt: 1_788_881_666n,
  disputed: false,
  metadataURI: "ipfs://bafkreimetadata",
};

const recheck: Attestation = {
  receiver: addresses.receiver,
  matched: true,
  distance: 0,
  recomputed: `0x${PHASH.toString(16).padStart(64, "0")}` as Hex,
  at: 1_789_380_000n,
};

const closed: ConsentReading = {
  stated: true,
  entry: {
    at: 1_789_000_000n,
    writer: CREATOR,
    consent: { aiTraining: "notAllowed", aiGenerativeTraining: "notAllowed", aiInference: "notAllowed", dataMining: "notAllowed" },
    constraintInfo: "",
  },
};

function bundle(attestations: Attestation[]): PassportRecordBundle {
  return { passport, attestations, edits: [], owner: CREATOR, dispute: null, hasPasskey: false } as PassportRecordBundle;
}

/** Awaits every async server component in the tree, so the markup can be drawn in one pass. */
async function settle(node: unknown): Promise<ReactNode> {
  if (Array.isArray(node)) {
    return (await Promise.all(node.map(settle))) as ReactNode;
  }
  if (!isValidElement(node)) {
    return node as ReactNode;
  }
  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === "function" && element.type.constructor.name === "AsyncFunction") {
    return await settle(await (element.type as (props: unknown) => Promise<unknown>)(element.props));
  }
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(element.props)) {
    props[key] = key === "children" || isValidElement(value) ? await settle(value) : value;
  }
  return cloneElement(element, props);
}

async function open(): Promise<string> {
  const page = await PassportPage({ params: Promise.resolve({ locale: "en", id: ID }) });
  return renderToStaticMarkup(createElement("div", null, await settle(page)));
}

function factValues(markup: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of markup.matchAll(/data-fact="([a-zA-Z]+)"[\s\S]*?data-fact-value[^>]*>([^<]*)</g)) {
    values[match[1]] = match[2].replace(/&#x27;/g, "'");
  }
  return values;
}

describe("the real passport route", () => {
  it("opens with the four facts under a picture's title, each read off the page's own reads", async () => {
    reads.record = bundle([recheck]);
    reads.art = { title: "Monsoon Fishing Nets Drying", imageUrl: "https://gateway.example/ipfs/full", missing: false } satisfies Art;
    reads.consent = closed;

    const markup = await open();
    expect(markup).toContain("data-top-facts");
    expect([...markup.matchAll(/data-fact="([a-zA-Z]+)"/g)].map((match) => match[1])).toEqual([
      "madeBy",
      "drawnBy",
      "aiUse",
      "rechecked",
    ]);
    expect(factValues(markup)).toEqual({
      madeBy: "0x85a88C…39a6",
      drawnBy: "Agent 10249",
      aiUse: en.passport.consent.summary.closed,
      rechecked: "Chainlink, Sep 14, 2026, 0 of 64 bits apart",
    });
    // The strip sits inside the poster, after the title.
    expect(markup.indexOf("<h1")).toBeLessThan(markup.indexOf("data-top-facts"));
    expect(markup.indexOf("data-top-facts")).toBeLessThan(markup.indexOf("</header>"));
    // And the AI use fact has somewhere to land.
    expect(markup).toMatch(/id="ai-use"[^>]*>\s*<section data-consent="true"/);
  });

  it("hangs the four facts under the sealed plate, and says what it could not read", async () => {
    reads.record = bundle([]);
    reads.art = {
      title: "Kanchipuram Silk Loom at First Light",
      sealed: true,
      privateRecheck: true,
      missing: false,
    } satisfies Art;
    reads.consent = { stated: false, entry: null } satisfies ConsentReading;

    const markup = await open();
    expect(markup).toContain("data-strip-under-plate");
    expect(factValues(markup)).toEqual({
      madeBy: "0x85a88C…39a6",
      drawnBy: "Agent 10249",
      aiUse: en.passport.facts.nothingStated,
      rechecked: en.passport.facts.notYet,
    });
  });
});
