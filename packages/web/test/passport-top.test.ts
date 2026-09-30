import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { Art } from "@/components/passport/art";
import type { ConsentReading } from "@/lib/chain/consent";
import type { Attestation, Passport } from "@/lib/chain/registry";
import type { RecheckControl } from "@/lib/recheck/useRecheck";

/**
 * The top of a passport page: the credit line under the title, the band that
 * used to sit empty above "Stated on chain", the two fingerprint grids on a
 * phone, the facts strip along the poster's foot, and the seal a poster
 * draws when its picture is missing.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: en, namespace }),
  getFormatter: async () => ({
    dateTime: (date: Date) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(date),
  }),
  setRequestLocale: () => undefined,
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ locale: "en", id: `0x${"7c".repeat(32)}` }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));
vi.mock("@/lib/chain/reports", () => ({ heldReportDelivery: async () => "simulation" }));
const picture = vi.hoisted(() => ({ fallback: undefined as unknown }));
vi.mock("@/components/passport/Picture", () => ({
  Picture: (props: { fallback?: unknown }) => {
    picture.fallback = props.fallback;
    return createElement("span", { "data-picture": "true" });
  },
}));

const agent = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/chain/agents", () => ({ heldAgent: agent.read }));

vi.mock("@/lib/recheck/useRecheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recheck/useRecheck")>()),
  useRecheckRequest: (): RecheckControl => ({
    state: { kind: "none" },
    spent: false,
    checking: false,
    actions: { request: () => undefined, check: () => undefined },
  }),
}));

const { Poster } = await import("@/components/passport/Poster");
const { Attestations } = await import("@/components/passport/Attestations");
const { Facts } = await import("@/components/passport/Facts");
const { TUCKED_ROOM } = await import("@/components/passport/RecheckRequest");
const { TopFacts, FactStrip } = await import("@/components/passport/TopFacts");
const { topFacts, FACT_ANCHORS } = await import("@/components/passport/top-facts");
const { addresses } = await import("@/lib/chain/client");

const ID = `0x${"7c".repeat(32)}` as Hex;
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

const art: Art = { title: "Monsoon Fishing Nets Drying", imageUrl: "https://gateway.example/ipfs/full", missing: false };

/** The same fingerprint written back as the receiver writes it: a 32 byte word. */
const SAME = `0x${PHASH.toString(16).padStart(64, "0")}` as Hex;
/** Three bits flipped. */
const OFF = `0x${(PHASH ^ 0b111n).toString(16).padStart(64, "0")}` as Hex;

const chainlink = (at: bigint, recomputed: Hex = SAME, matched = true): Attestation => ({
  receiver: addresses.receiver,
  matched,
  distance: matched ? 0 : 3,
  recomputed,
  at,
});

const closed: ConsentReading = {
  stated: true,
  entry: {
    at: 1_789_000_000n,
    writer: CREATOR,
    consent: { aiTraining: "notAllowed", aiGenerativeTraining: "notAllowed", aiInference: "notAllowed", dataMining: "notAllowed" },
    constraintInfo: "",
  },
};

const say = {
  kind: (kind: number) => en.kind[String(kind) as "0" | "1" | "2"],
  agentNumber: (id: string) => `Agent ${id}`,
  cardNamed: (agent: string) => en.passport.facts.cardNamed.replace("{agent}", agent),
  statement: (statement: string) => en.passport.consent.summary[statement as "closed"],
  bits: (count: number) => `${count} of 64 bits`,
  privateRecheck: en.passport.attestations.private.badge,
  sealed: en.passport.sealed.label,
  date: (seconds: bigint) =>
    new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(Number(seconds) * 1000)),
  words: en.passport.facts,
};

const input = {
  creator: CREATOR,
  agentId: 10249n,
  agentName: "Moolam generator on a Privy server wallet",
  kind: 0,
  consent: closed,
  attestations: [chainlink(1_789_380_000n)],
  phash: PHASH,
  sealed: false,
  privateRecheck: false,
};

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
}

/** The class list of the first element carrying this attribute. */
function classOf(markup: string, attribute: string): string {
  const match = new RegExp(`<[a-z]+[^>]*${attribute}[^>]*class="([^"]*)"|<[a-z]+[^>]*class="([^"]*)"[^>]*${attribute}`).exec(markup);
  expect(match, attribute).not.toBeNull();
  return unescape((match?.[1] ?? match?.[2]) as string);
}

/** Class lists come back HTML escaped, and Tailwind's variants are full of & and >. */
function unescape(value: string): string {
  return value.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

const LONG_DASH = String.fromCharCode(0x2014);

afterEach(() => {
  vi.unstubAllEnvs();
  agent.read.mockReset();
  picture.fallback = undefined;
});

describe("the credit line under the title", () => {
  it("never leaves a rule at the start or end of a row, wherever it wraps", async () => {
    const markup = render(await Poster({ passport, art, locale: "en" }));
    const box = classOf(markup, "data-meta-line");
    expect(box).toMatch(/(^|\s)overflow-hidden(\s|$)/);

    const row = unescape(/data-meta-line[^>]*>\s*<p class="([^"]*)"/.exec(markup)?.[1] ?? "");
    // The row is pulled back by exactly the padding each part carries its rule in.
    const pull = /-ms-\[(\d+)px\]/.exec(row)?.[1];
    const pad = /\[&>span\]:ps-\[(\d+)px\]/.exec(row)?.[1];
    expect(pull).toBeDefined();
    expect(pull).toBe(pad);
    // The rule sits inside that padding, so the one in front of a row's first
    // part is always outside the clipping box.
    expect(row).toContain("[&>span]:before:start-4");
    expect(16).toBeLessThan(Number(pad));

    // No rule is a part of its own any more, so none can be left at a row's end.
    const line = markup.slice(markup.indexOf("data-meta-line"));
    expect(line).not.toMatch(/<span aria-hidden="true" class="h-\[10px\] w-px/);
    expect(line).toContain(en.kind["0"]);
    // The method moved to the record's fingerprints (R53), so the credit line no longer carries it.
    expect(line).not.toContain(en.passport.fingerprintVersion.replace("{version}", "1"));
  });
});

describe("the band above Stated on chain", () => {
  it("is gone: the room kept for the re-check sentence lies inside the section's own padding", async () => {
    const markup = render(
      await Attestations({ attestations: [chainlink(1_789_380_000n)], indexed: [], phash: PHASH, locale: "en" }),
    );
    expect(markup).toContain('data-recheck-room="tucked"');
    const room = classOf(markup, 'data-recheck-room="tucked"');
    expect(room).toContain(TUCKED_ROOM);

    // The pull hands the room back in full from 640 px up, and on a phone it
    // hands back all the section's padding can take.
    expect(room).toContain("sm:min-h-[3.25rem]");
    expect(TUCKED_ROOM).toContain("sm:-mb-[3.25rem]");
    expect(room).toContain("min-h-[4.875rem]");
    expect(TUCKED_ROOM).toContain("-mb-[3.5rem]");
    expect(source("components/passport/Attestations.tsx")).toContain("py-14 sm:px-8 sm:py-20");
  });

  it("is tucked on a passport with no re-check yet too, and a sealed one with no control has no room at all", async () => {
    const none = render(await Attestations({ attestations: [], indexed: [], phash: PHASH, locale: "en" }));
    expect(none).toContain('data-recheck-room="tucked"');

    const sealed = render(await Attestations({ attestations: [], indexed: [], phash: PHASH, locale: "en", sealed: true }));
    expect(sealed).not.toContain("data-recheck-room");

    const privateKept = render(
      await Attestations({ attestations: [], indexed: [], phash: PHASH, locale: "en", sealed: true, privateCopy: "kept" }),
    );
    expect(privateKept).toContain('data-recheck-room="tucked"');
  });

  it("keeps the room in front of anything else that draws the control, like the verify card", () => {
    expect(source("components/passport/RecheckRequest.tsx")).toContain("tuck = false");
  });
});

describe("the two fingerprint grids on a phone", () => {
  it("sit side by side below the laptop width, with their feet lined up", async () => {
    const markup = render(
      await Attestations({ attestations: [chainlink(1_789_380_000n)], indexed: [], phash: PHASH, locale: "en" }),
    );
    const pair = classOf(markup, "data-grid-pair");
    expect(pair).toMatch(/(^|\s)grid-cols-2(\s|$)/);
    expect(pair).not.toMatch(/(^|\s)sm:grid-cols-2(\s|$)/);
    expect(pair).toMatch(/(^|\s)items-end(\s|$)/);
    // The laptop gap stays as it was.
    expect(pair).toContain("sm:gap-x-10");
  });
});

describe("the light theme's poster", () => {
  it("keeps the full scrim and the top band in dark only, and a foot scrim in light", async () => {
    const markup = render(await Poster({ passport, art, locale: "en" }));
    const dark = [...markup.matchAll(/data-scrim="dark"[^>]*class="([^"]*)"|class="([^"]*)"[^>]*data-scrim="dark"/g)];
    expect(dark.length).toBe(2);
    for (const found of dark) {
      expect(unescape(found[1] ?? found[2])).toContain("[.light_&]:hidden");
    }
    const light = classOf(markup, 'data-scrim="light"');
    expect(light).toMatch(/(^|\s)hidden(\s|$)/);
    expect(light).toContain("[.light_&]:block");
    expect(light).toContain("bottom-0");
  });
});

describe("the facts strip", () => {
  it("reads each fact off the page's own reads", () => {
    const facts = topFacts(input, say);
    expect(facts.map((fact) => fact.label)).toEqual([
      en.passport.facts.madeBy,
      en.passport.facts.drawnBy,
      en.passport.facts.aiUse,
      en.passport.facts.rechecked,
    ]);
    const [made, drawn, use, checked] = facts;
    expect(made.value).toBe("0x85a88C…39a6");
    expect(drawn.value).toBe("Moolam generator on a Privy server wallet");
    // The card's name is the card's word, and the line under it says so (P14).
    expect(drawn.detail).toBe("Agent 10249, named by its own card");
    expect(use.value).toBe(en.passport.consent.summary.closed);
    expect(use.tone).toBe("pending");
    expect(checked.value).toBe("Chainlink, Sep 14, 2026, 0 of 64 bits");
    expect(checked.tone).toBe("verified");
  });

  it("counts the bits off the chain's two fingerprints and names the newest re-check", () => {
    const [, , , checked] = topFacts(
      { ...input, attestations: [chainlink(1_789_380_000n), chainlink(1_789_500_000n, OFF, false)] },
      say,
    );
    expect(checked.value).toBe("Chainlink, Sep 15, 2026, 3 of 64 bits");
    expect(checked.tone).toBe("failed");

    const [, , , privately] = topFacts(
      {
        ...input,
        sealed: true,
        privateRecheck: true,
        attestations: [{ ...chainlink(1_789_500_000n), receiver: addresses.sealedReceiver }],
      },
      say,
    );
    expect(privately.value).toBe(`${en.passport.attestations.private.badge}, Sep 15, 2026, 0 of 64 bits`);
  });

  it("says plainly what it could not read, and what was never stated or checked", () => {
    const [, drawn, use, checked] = topFacts(
      { ...input, agentName: null, consent: null, attestations: [] },
      say,
    );
    expect(drawn.value).toBe("Agent 10249");
    expect(drawn.detail).toBeUndefined();
    expect(use.value).toBe(en.passport.facts.unread);
    expect(use.unread).toBe(true);
    expect(checked.value).toBe(en.passport.facts.notYet);

    const [, captured, unstated] = topFacts(
      { ...input, agentId: 0n, agentName: null, kind: 1, consent: { stated: false, entry: null } },
      say,
    );
    expect(captured.value).toBe(en.kind["1"]);
    expect(captured.href).toBe(`#${FACT_ANCHORS.drawnBy}`);
    expect(unstated.value).toBe(en.passport.facts.nothingStated);

    const [, , , plainSealed] = topFacts({ ...input, sealed: true, attestations: [] }, say);
    expect(plainSealed.value).toBe(en.passport.sealed.label);
  });

  it("links each fact to its own section, and every one of those sections carries the id", async () => {
    const hrefs = topFacts(input, say).map((fact) => fact.href);
    expect(hrefs).toEqual(["#made-by", "/agent/10249", "#ai-use", "#second-opinion"]);

    const strip = render(FactStrip({ facts: topFacts(input, say) }));
    for (const href of hrefs) {
      expect(strip).toContain(`href="${href}"`);
    }

    const record = render(
      await Facts({ passport, art, owner: CREATOR, hasPasskey: false, standing: "verified", txHash: null }),
    );
    expect(record).toContain(`id="${FACT_ANCHORS.madeBy}"`);
    expect(record).toContain(`id="${FACT_ANCHORS.drawnBy}"`);
    const opinion = render(await Attestations({ attestations: [], indexed: [], phash: PHASH, locale: "en" }));
    expect(opinion).toContain(`id="${FACT_ANCHORS.rechecked}"`);
    expect(source("app/[locale]/passport/[id]/page.tsx")).toContain("<div id={FACT_ANCHORS.aiUse} style={ANCHOR_MARGIN}>");
  });

  it("lays out two by two on a phone and four across on a laptop", () => {
    const strip = render(FactStrip({ facts: topFacts(input, say) }));
    const grid = classOf(strip, "data-top-facts");
    expect(grid).toMatch(/(^|\s)grid-cols-2(\s|$)/);
    expect(grid).toContain("lg:grid-cols-4");
  });

  it("falls back to the agent's number when its card cannot be read", async () => {
    agent.read.mockRejectedValueOnce(new Error("gateway down"));
    const markup = render(
      await TopFacts({ passport, art, consent: null, attestations: [], locale: "en" }),
    );
    expect(markup).toContain("Agent 10249");
    expect(markup).toContain(en.passport.facts.unread);

    agent.read.mockResolvedValueOnce({ owner: CREATOR, uri: "data:,", card: { name: "Moolam generator" } });
    const named = render(await TopFacts({ passport, art, consent: null, attestations: [], locale: "en" }));
    expect(named).toContain("Moolam generator");
  });

  it("is on every passport page: the route hands it to the poster, and the sealed plate carries it under", async () => {
    const route = source("app/[locale]/passport/[id]/page.tsx");
    expect(route).toContain("strip={<TopFacts");
    expect(route).not.toContain("variant");
    expect(route).not.toContain('import("@/components/passport/TopFacts")');

    const withStrip = render(
      await Poster({ passport, art, locale: "en", strip: FactStrip({ facts: topFacts(input, say) }) }),
    );
    expect(withStrip).toContain("data-top-facts");

    const sealedArt: Art = { title: "Kanchipuram Silk Loom at First Light", sealed: true, missing: false };
    const sealed = render(
      await Poster({ passport, art: sealedArt, locale: "en", strip: FactStrip({ facts: topFacts(input, say) }) }),
    );
    expect(sealed).toContain("data-strip-under-plate");
    expect(sealed).toContain("data-top-facts");
  });

  it("reads its words from the message files and writes no long dash", () => {
    const logic = source("components/passport/top-facts.ts");
    for (const [key, words] of Object.entries(en.passport.facts)) {
      if (key !== "chainlink") {
        expect(logic, key).not.toContain(`: "${words}"`);
      }
    }
    expect(source("components/passport/TopFacts.tsx")).toContain("t(`facts.${key}`)");
    for (const path of [
      "components/passport/top-facts.ts",
      "components/passport/TopFacts.tsx",
      "components/passport/Poster.tsx",
      "components/sealed/SealedPlate.tsx",
      "app/[locale]/passport/[id]/page.tsx",
    ]) {
      expect(source(path), path).not.toContain(LONG_DASH);
    }
  });
});

describe("the preview route", () => {
  it("is gone now the strip is on the real route", () => {
    expect(existsSync(fileURLToPath(new URL("../app/[locale]/lab/passport-top/page.tsx", import.meta.url)))).toBe(false);
  });
});

describe("the seal on a poster whose picture is missing", () => {
  const long: Art = {
    title: "Moolam prove-it forgery attempt 2026-09-24, the second pass over the same frame",
    missing: false,
  };

  it("sits in the room above the title block, never laid over it", async () => {
    const markup = render(await Poster({ passport, art: long, locale: "en" }));
    expect(markup).toContain("data-no-picture");
    expect(unescape(/<header class="([^"]*)"/.exec(markup)?.[1] ?? "")).toContain("group/poster");

    const seal = classOf(markup, "data-missing-seal").split(/\s+/);
    // In the same column as the title, taking only the room left over.
    expect(seal).not.toContain("absolute");
    expect(seal).toContain("flex-1");
    expect(seal).toContain("min-h-0");
    // Too little room wraps the seal into a clipped second column, so it hides
    // rather than spilling onto the title.
    expect(seal).toContain("flex-wrap");
    expect(seal).toContain("overflow-hidden");
    // Shown only beside the mark a missing picture leaves.
    expect(seal).toContain("hidden");
    expect(seal).toContain("group-has-[[data-no-picture]]/poster:flex");
    expect(markup.indexOf("data-missing-seal")).toBeLessThan(markup.indexOf("<h1"));
    expect(markup).toContain(en.passport.noPicture.replace(/'/g, "&#x27;"));
  });

  it("is handed to the picture too, for the day every gateway refuses it", async () => {
    render(await Poster({ passport, art, locale: "en" }));
    expect(render(picture.fallback as ReactElement)).toContain("data-no-picture");
  });
});
