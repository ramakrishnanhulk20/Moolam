import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createFormatter, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { OpenDispute } from "@/lib/disputes/queue";

/**
 * The Agents board with a strip of each agent's newest real pictures, and the
 * agent page with its test images folded away, after work order 216. The index
 * and the gateway are fixtures here: what is proven is what the page does with
 * their answers, and that the whole board asks the index once.
 */

vi.mock("next/cache", async (original) => ({
  ...(await original<typeof import("next/cache")>()),
  unstable_cache: <T>(read: T) => read,
}));

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: en, namespace }),
  getFormatter: async () => createFormatter({ locale: "en", timeZone: "Asia/Kolkata" }),
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string; "aria-label"?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

vi.mock("next/link", () => ({
  default: (props: { href: string; children?: unknown }) => createElement("a", { href: props.href }, props.children as never),
  useLinkStatus: () => ({ pending: false }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
}));

vi.mock("next/image", () => ({
  default: (props: { src: string; alt?: string }) => createElement("img", { src: String(props.src), alt: props.alt ?? "" }),
}));

/** A gateway address the list of sources comes back empty for, which is what a gateway miss ends in. */
const BROKEN = "https://gw/broken";

vi.mock("@/lib/images", async (original) => ({
  ...(await original<typeof import("@/lib/images")>()),
  pictureSources: (url: string) => (url === BROKEN ? [] : [url]),
  isOptimizable: () => true,
  nextSource: () => null,
}));

const index = vi.hoisted(() => ({
  ask: vi.fn(),
  art: {} as Record<string, { title?: string; thumbnailUrl?: string; sealed?: boolean; missing?: boolean }>,
}));

vi.mock("@/lib/data/passports", async (original) => ({
  ...(await original<typeof import("@/lib/data/passports")>()),
  askIndex: index.ask,
  heldArt: async (uri: string) => index.art[uri] ?? { missing: true },
}));

vi.mock("@/lib/disputes/useResolveDisputes", () => ({ useResolveDisputes: () => null }));

const { boardStrips, STRIP_QUERY } = await import("@/components/agents/strip");
const { Row } = await import("@/components/agents/Row");
const { Board } = await import("@/components/agents/Board");
const { PictureStrip } = await import("@/components/agents/PictureStrip");
const { Works } = await import("@/components/agent/Works");
const { AgentPoster } = await import("@/components/agent/AgentPoster");
const { Standing } = await import("@/components/agent/Standing");
const { Signing } = await import("@/components/agent/Signing");
const { agentSheetHref } = await import("@/components/agent/signed");
const { readExploreSearch } = await import("@/components/explore/query");
const { Plate } = await import("@/components/explore/Plate");
const { ResolveConsole } = await import("@/components/resolve/ResolveConsole");

const OWNER = "0xA37418c0d1b2e3f4a5b6c7d8e9f0a1b2c3d49AFB" as Hex;
const RESOLVER = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;
const NO_MANIFEST = `0x${"0".repeat(64)}`;

function id(byte: string): Hex {
  return `0x${byte.repeat(32)}` as Hex;
}

function inEnglish(node: ReactNode): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(
    createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node as never),
  );
}

/** One passport under a generator, as the strip query returns it. */
function row(byte: string, extra: Record<string, unknown> = {}) {
  return {
    id: id(byte),
    metadataURI: `ipfs://${byte}`,
    manifestHash: NO_MANIFEST,
    disputed: false,
    attestationCount: 0,
    attestations: [],
    parent: null,
    ...extra,
  };
}

/** One passport as the Explore sheet hands it to the agent page. */
function plate(byte: string, title: string | null, extra: Record<string, unknown> = {}) {
  return {
    id: id(byte),
    kind: 0,
    registeredAt: 1_788_876_082,
    title,
    thumbnailUrl: `https://gw/${byte}`,
    manifest: false,
    rechecked: false,
    chainlink: false,
    disputed: false,
    agentId: "10248",
    consent: null,
    ...extra,
  };
}

const agent = {
  id: "10249",
  name: "Moolam generator on a Privy server wallet",
  passportCount: 26,
  matchedCount: 20,
  mismatchedCount: 0,
  disputesUpheld: 0,
  trustScore: 95,
  firstSeenAt: 1_788_876_082,
};

/** Every lit mark's words in a piece of markup, in the order drawn. */
function litMarks(markup: string): string[] {
  return [...markup.matchAll(/role="img" aria-label="([^"]+)"[^>]*>[MRDS]</g)].map((match) => match[1]);
}

describe("work order 216", () => {
  it("step 2: the board reads every agent's newest pictures in one query and draws five real ones, or one line", async () => {
    index.ask.mockReset().mockResolvedValue({
      Generator: [
        {
          id: "10249",
          passportCount: 26,
          passports: [
            row("01"),
            row("02", { manifestHash: `0x${"ab".repeat(32)}` }),
            row("03", { attestationCount: 1, attestations: [{ receiver: `0x${"99".repeat(20)}` }] }),
            row("04"),
            row("05", { parent: { disputed: true, parent: null } }),
            row("06"),
            row("07"),
            row("08"),
          ],
        },
        { id: "10248", passportCount: 2, passports: [row("21"), row("22")] },
        { id: "10250", passportCount: 30, passports: Array.from({ length: 12 }, (_, at) => row((40 + at).toString(16))) },
      ],
    });
    index.art = {
      "ipfs://01": { title: "Moolam seed 1", thumbnailUrl: "https://gw/01" },
      "ipfs://02": { title: "Harbour lights", thumbnailUrl: "https://gw/02" },
      "ipfs://03": { title: "Temple steps at dawn", thumbnailUrl: "https://gw/03" },
      "ipfs://04": { title: "A sealed night", sealed: true },
      "ipfs://05": { title: "Monsoon nets", thumbnailUrl: "https://gw/05" },
      "ipfs://06": { title: "Kolam", thumbnailUrl: "https://gw/06" },
      "ipfs://07": { title: "Fishing boats", thumbnailUrl: "https://gw/07" },
      "ipfs://08": { title: "The old fort", thumbnailUrl: "https://gw/08" },
      "ipfs://21": { title: "Moolam seed 2", thumbnailUrl: "https://gw/21" },
      "ipfs://22": { title: "Moolam prove-it 2026-09-09T09:17:19.321Z", thumbnailUrl: "https://gw/22" },
      ...Object.fromEntries(
        Array.from({ length: 12 }, (_, at) => [`ipfs://${(40 + at).toString(16)}`, { title: `Moolam seed ${at}` }]),
      ),
    };

    const strips = await boardStrips();

    // One question to the index for the whole board, with each agent's passports nested under it.
    expect(index.ask).toHaveBeenCalledTimes(1);
    expect(STRIP_QUERY).toMatch(/Generator\([^)]*\)\s*\{[\s\S]*passports\(/);

    // Test images and the sealed picture left out, newest first, five at most.
    const pictured = strips["10249"];
    expect(pictured.tiles.map((tile) => tile.id)).toEqual([id("02"), id("03"), id("05"), id("06"), id("07")]);
    expect(pictured.tiles[0].manifest).toBe(true);
    expect(pictured.tiles[1].rechecked).toBe(true);
    expect(pictured.tiles[2].disputed).toBe(true);
    expect(pictured.onlyTest).toBe(false);

    // Every passport read and every one a test image: the line. A window cut
    // short says nothing, because it has not seen the older passports.
    expect(strips["10248"]).toEqual({ tiles: [], onlyTest: true });
    expect(strips["10250"]).toEqual({ tiles: [], onlyTest: false });

    const drawn = inEnglish(createElement(Row, { agent: agent as never, place: 0, strip: pictured }));
    expect(drawn).toContain(`aria-label="${en.agents.strip.label}"`);
    for (const tile of pictured.tiles) {
      expect(drawn).toContain(`href="/passport/${tile.id}"`);
    }
    expect(drawn).toContain('href="/agent/10249"');
    expect(drawn.match(/href="\/passport\//g)).toHaveLength(5);

    const plain = inEnglish(createElement(Row, { agent: agent as never, place: 1, strip: strips["10248"] }));
    expect(plain).toContain(en.agent.works.onlyTest);
    expect(plain).not.toContain('href="/passport/');
  });

  it("step 3: the agent page leads with real pictures, folds the test images with their count, and links to Explore", async () => {
    const mixed = inEnglish(
      await Works({
        agentId: 10248n,
        works: [plate("0a", "Moolam seed 3"), plate("0b", "Harbour lights"), plate("0c", "Moolam seed 4"), plate("0d", "Kolam")] as never,
        error: null,
        locale: "en",
      }),
    );
    const folded = mixed.indexOf("data-agent-tests");
    expect(mixed.indexOf("Harbour lights")).toBeLessThan(mixed.indexOf("Kolam"));
    expect(mixed.indexOf("Kolam")).toBeLessThan(folded);
    expect(mixed.indexOf("Moolam seed 3")).toBeGreaterThan(folded);
    expect(mixed).toContain("Show 2 test images");
    expect(mixed).toContain(en.agent.works.hideTest);
    expect(mixed).not.toContain(en.agent.works.onlyTest);
    expect(mixed).toContain(`href="/explore/view?agent=10248"`);
    expect(mixed).toContain(en.agent.works.seeAll);
    // The link opens the very sheet the page read, so the two share one held read.
    expect(readExploreSearch({ agent: new URLSearchParams(agentSheetHref(10248n).split("?")[1]).get("agent") ?? "" })).toEqual(
      readExploreSearch({ agent: "10248" }),
    );

    const onlyTests = [plate("0a", "Moolam seed 3"), plate("0c", "Moolam seed 4")] as never;
    const allRead = inEnglish(await Works({ agentId: 10248n, works: onlyTests, error: null, locale: "en" }));
    expect(allRead).toContain(en.agent.works.onlyTest);
    expect(allRead).toContain("Show 2 test images");

    const cutShort = inEnglish(await Works({ agentId: 10248n, works: onlyTests, complete: false, error: null, locale: "en" }));
    expect(cutShort).not.toContain(en.agent.works.onlyTest);
    expect(cutShort).toContain("Show 2 test images");
  });

  it("step 4: an agent with no name on its card gets a title, not a sentence", async () => {
    for (const card of [null, { privy: null }, { name: "   ", privy: null }]) {
      const html = renderToStaticMarkup(await AgentPoster({ agentId: 10248n, owner: OWNER, card, works: [] }));
      const title = html.slice(html.indexOf("<h1"), html.indexOf("</h1>"));
      expect(title).toContain(en.agent.unnamedTitle);
      expect(title).not.toContain("carries no name");
    }
  });

  it("step 5: the same passport has the same marks and the same missing-picture words on Explore, the agent page and the strip", async () => {
    const lit = plate("5a", "Harbour lights", { manifest: true, rechecked: true, chainlink: true });
    const explore = inEnglish(createElement(Plate, { plate: lit as never }));
    const page = inEnglish(await Works({ agentId: 10248n, works: [lit] as never, error: null, locale: "en" }));
    const strip = inEnglish(createElement(PictureStrip, { strip: { tiles: [lit as never], onlyTest: false } }));

    expect(litMarks(explore)).toEqual([en.explore.marks.manifest, en.explore.marks.chainlink]);
    expect(litMarks(page)).toEqual(litMarks(explore));
    expect(litMarks(strip)).toEqual(litMarks(explore));
    expect(page).toContain("aspect-[4/5]");
    expect(explore).toContain("aspect-[4/5]");
    expect(strip).toContain("aspect-square");

    const bare = plate("5b", "Harbour lights", { thumbnailUrl: null });
    const words = en.explore.noPicture;
    expect(inEnglish(createElement(Plate, { plate: bare as never }))).toContain(words);
    expect(inEnglish(await Works({ agentId: 10248n, works: [bare] as never, error: null, locale: "en" }))).toContain(words);
    expect(inEnglish(createElement(PictureStrip, { strip: { tiles: [bare as never], onlyTest: false } }))).toContain(words);
    expect(page).not.toContain(en.agent.works.noThumbnail);
  });

  it("step 6: the score formula on the agent page prints in normal case", async () => {
    const html = renderToStaticMarkup(
      await Standing({
        reputation: null,
        reputationError: null,
        record: { passportCount: 12, matchedCount: 1, mismatchedCount: 0, disputesUpheld: 0, trustScore: 67, firstSeenAt: 1788875220n },
        recordError: null,
        locale: "en",
      }),
    );
    const code = html.slice(html.lastIndexOf("<code", html.indexOf(en.agent.index.formula)), html.indexOf("</code>"));
    expect(code).toContain(en.agent.index.formula);
    expect(code).not.toContain("uppercase");
  });

  it("step 7: every address under a capitalised label on the signing block keeps its case", async () => {
    const html = renderToStaticMarkup(
      await Signing({
        agentId: 10248n,
        card: { privy: { walletId: "cmfwallet01", policyIds: ["policy01"] } },
        document: null,
        uri: "ipfs://bafkreicard",
      }),
    );
    expect(html).toMatch(/Registry <span data-hex="true" class="normal-case">0x/);
    expect(html).toMatch(/Identity <span data-hex="true" class="normal-case">0x/);
    expect(html).not.toMatch(/>(Registry|Identity) 0x/);
  });

  it("step 8: every failure line opens with the warning mark, and the resolver's thumbnails fall back to the seal", async () => {
    const failed = "the Envio endpoint answered 502";
    const opensWithMark = (markup: string, words: string) =>
      expect(markup).toMatch(new RegExp(`<svg aria-hidden="true"[^>]*>[\\s\\S]*?</svg><span class="min-w-0">${words}`));

    opensWithMark(inEnglish(await Board({ agents: [], error: failed, locale: "en" })), "The index could not be read");
    opensWithMark(inEnglish(await Works({ agentId: 10248n, works: [], error: failed, locale: "en" })), "The index could not be read");
    const standing = inEnglish(
      await Standing({ reputation: null, reputationError: failed, record: null, recordError: failed, locale: "en" }),
    );
    opensWithMark(standing, "The index could not be read");
    opensWithMark(standing, "The reputation registry could not be read");
    opensWithMark(
      inEnglish(createElement(ResolveConsole, { resolver: RESOLVER, disputes: [], listError: failed })),
      "The list of open disputes",
    );

    const dispute: OpenDispute = {
      passportId: id("5c"),
      challenger: `0x${"85".repeat(20)}` as Hex,
      bond: "1000000000000000000",
      openedAt: 1788876082,
      evidenceURI: null,
      reason: null,
      verified: false,
      title: null,
      thumbnailUrl: BROKEN,
    };
    const missed = inEnglish(createElement(ResolveConsole, { resolver: RESOLVER, disputes: [dispute] }));
    expect(missed).not.toContain("<img");
    expect(missed).toContain('class="motif h-6 w-6 opacity-70"');
    expect(missed).toContain(en.resolve.noPicture);

    const served = inEnglish(
      createElement(ResolveConsole, { resolver: RESOLVER, disputes: [{ ...dispute, thumbnailUrl: "https://gw/5c" }] }),
    );
    expect(served).toContain('src="https://gw/5c"');
  });
});
