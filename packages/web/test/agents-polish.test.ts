import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createFormatter, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { OpenDispute } from "@/lib/disputes/queue";

/**
 * The agent page, the Agents board's neighbour and the resolver desk after the
 * UI polish audit: real pictures lead, a failed read never says "nothing is
 * waiting", ids keep their case under capitalised labels, and the light theme
 * does not lay a cream haze over pictures nobody wrote on.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: en, namespace }),
  getFormatter: async () => createFormatter({ locale: "en", timeZone: "Asia/Kolkata" }),
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
}));

vi.mock("next/image", () => ({
  default: (props: { src: string; alt?: string }) => createElement("img", { src: String(props.src), alt: props.alt ?? "" }),
}));

vi.mock("@/lib/images", () => ({
  pictureSources: (url: string) => [url],
  isOptimizable: () => true,
  nextSource: () => null,
}));

const reads = vi.hoisted(() => ({
  listings: [] as { id: string; kind: number; registeredAt: bigint; registeredBlock: bigint; metadataURI: string }[],
  art: {} as Record<string, { title?: string; thumbnailUrl?: string }>,
}));

vi.mock("@/lib/data/passports", () => ({
  heldPassportsByGenerator: async () => reads.listings,
  heldArt: async (uri: string) => reads.art[uri] ?? {},
}));

const desk = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/disputes/useResolveDisputes", () => ({ useResolveDisputes: () => desk.current }));

const { realPicturesFirst, signedWorks } = await import("@/components/agent/signed");
const { Works } = await import("@/components/agent/Works");
const { Standing } = await import("@/components/agent/Standing");
const { AgentPoster } = await import("@/components/agent/AgentPoster");
const { ResolveConsole } = await import("@/components/resolve/ResolveConsole");

const OWNER = "0xA37418c0d1b2e3f4a5b6c7d8e9f0a1b2c3d49AFB" as Hex;
const RESOLVER = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;
const CHALLENGER = "0x85a88Ca81Ff5F681D96AB86fA60ccB8452a139a6" as Hex;
const HEX_SPAN = /<span data-hex="true" class="normal-case">0x[0-9a-fA-F]+/;

function id(byte: string): Hex {
  return `0x${byte.repeat(32)}` as Hex;
}

function listing(byte: string, at: number) {
  return { id: id(byte), kind: 0, registeredAt: BigInt(at), registeredBlock: BigInt(at), metadataURI: `ipfs://${byte}` };
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

/** Every class list in the markup that draws a scrim, dark or light. */
function scrimClasses(html: string): string[] {
  return [...html.matchAll(/<(?:div|span)[^>]*data-scrim="(dark|light)"[^>]*class="([^"]*)"/g)].map(
    (match) => `${match[1]} ${match[2].replaceAll("&amp;", "&")}`,
  );
}

describe("an agent's works lead with its real pictures", () => {
  it("puts the real pictures ahead of the test cards and keeps newest first inside each group", () => {
    const works = [
      { id: id("01"), title: "Moolam prove-it 2026-09-09T09:17:19.321Z" },
      { id: id("02"), title: "Monsoon fishing nets drying" },
      { id: id("03"), title: "Moolam seed 3" },
      { id: id("04"), title: undefined },
      { id: id("05"), title: "Temple steps at dawn" },
    ];

    expect(realPicturesFirst(works).map((work) => work.id)).toEqual([id("02"), id("05"), id("01"), id("03"), id("04")]);
  });

  it("drops nothing, and the page's own read comes back in that order", async () => {
    reads.listings = [listing("0a", 300), listing("0b", 200), listing("0c", 100)];
    reads.art = {
      "ipfs://0a": { title: "Moolam seed 3", thumbnailUrl: "https://gw/0a" },
      "ipfs://0b": { title: "Moolam prove-it 2026-09-08T14:08:34.384Z", thumbnailUrl: "https://gw/0b" },
      "ipfs://0c": { title: "Harbour lights", thumbnailUrl: "https://gw/0c" },
    };

    const works = await signedWorks(10248n);
    expect(works.map((work) => work.title)).toEqual([
      "Harbour lights",
      "Moolam seed 3",
      "Moolam prove-it 2026-09-08T14:08:34.384Z",
    ]);
  });
});

describe("the resolver desk when the list of open disputes cannot be read", () => {
  const empty: OpenDispute[] = [];

  it("says the read failed, offers the retry, and never says nothing is waiting", () => {
    const html = inEnglish(
      createElement(ResolveConsole, { resolver: RESOLVER, disputes: empty, listError: "the Envio endpoint answered 502" }),
    );

    expect(html).toContain("The list of open disputes comes from the index, and the index did not answer");
    expect(html).toContain(en.retry.now);
    expect(html).not.toContain(en.resolve.empty);
  });

  it("says nothing is waiting only when the read answered with nothing", () => {
    const html = inEnglish(createElement(ResolveConsole, { resolver: RESOLVER, disputes: empty, listError: null }));

    expect(html).toContain(en.resolve.empty);
    expect(html).not.toContain(en.retry.now);
    expect(html).not.toContain("the index did not answer");
  });
});

describe("the agent page offers one way back when the index does not answer", () => {
  it("puts the retry under the counts", async () => {
    const html = inEnglish(
      await Standing({
        reputation: null,
        reputationError: null,
        record: null,
        recordError: "the Envio endpoint answered 502",
        locale: "en",
      }),
    );

    expect(html).toContain("The index could not be read");
    expect(html).toContain(en.retry.now);
  });

  it("puts it under the pictures when the counts read fine, and holds it back when they already carry one", async () => {
    const own = inEnglish(await Works({ works: [], error: "the Envio endpoint answered 502", locale: "en" }));
    expect(own).toContain("The index could not be read");
    expect(own).toContain(en.retry.now);

    const shared = inEnglish(
      await Works({ works: [], error: "the Envio endpoint answered 502", locale: "en", retry: false }),
    );
    expect(shared).toContain("The index could not be read");
    expect(shared).not.toContain(en.retry.now);
  });
});

describe("ids keep their case", () => {
  const work = { ...listing("7e", 100), id: id("7e"), title: "Harbour lights", thumbnailUrl: "https://gw/7e" };

  it("sets the owner inside a normal-case span in the capitalised row", async () => {
    const html = renderToStaticMarkup(await AgentPoster({ agentId: 10248n, owner: OWNER, card: null, works: [work] }));
    expect(html).toMatch(/<span data-hex="true" class="normal-case">0xA37418/);
  });

  it("sets the reputation registry and every passport id inside normal-case spans", async () => {
    const standing = renderToStaticMarkup(
      await Standing({ reputation: null, reputationError: null, record: null, recordError: null, locale: "en" }),
    );
    expect(standing).toMatch(/Registry <span data-hex="true" class="normal-case">0x/);

    const works = renderToStaticMarkup(await Works({ works: [work], error: null, locale: "en" }));
    expect(works).toMatch(HEX_SPAN);
  });

  it("sets the resolver, the passport and the challenger inside normal-case spans on the desk", () => {
    const dispute: OpenDispute = {
      passportId: id("5c"),
      challenger: CHALLENGER,
      bond: "1000000000000000000",
      openedAt: 1788876082,
      evidenceURI: null,
      reason: null,
      verified: false,
      title: null,
      thumbnailUrl: null,
    };

    const html = inEnglish(createElement(ResolveConsole, { resolver: RESOLVER, disputes: [dispute] }));
    // Mono cuts a value into groups of eight with a break point between them.
    expect(html).toMatch(/class="font-mono break-all text-base normal-case">0x559F35<wbr\/>7a/);
    expect(html).toMatch(/class="font-mono break-all text-sm normal-case">0x5c5c5c<wbr\/>5c/);
    expect(html).toMatch(/<span data-hex="true" class="normal-case">0x85a88C/);
  });
});

describe("in the light class the agent's pictures carry no cream scrim", () => {
  const work = { ...listing("7e", 100), id: id("7e"), title: "Harbour lights", thumbnailUrl: "https://gw/7e" };

  it("hides every scrim on the picture tiles in light", async () => {
    const html = renderToStaticMarkup(await Works({ works: [work], error: null, locale: "en" }));
    const scrims = scrimClasses(html);

    expect(scrims.length).toBeGreaterThan(0);
    for (const scrim of scrims) {
      expect(scrim).toContain("[.light_&]:hidden");
    }
  });

  it("keeps the wall's light ground under the words only, from lg up", async () => {
    const html = renderToStaticMarkup(await AgentPoster({ agentId: 10248n, owner: OWNER, card: null, works: [work] }));
    const scrims = scrimClasses(html);

    const dark = scrims.filter((scrim) => scrim.startsWith("dark "));
    const light = scrims.filter((scrim) => scrim.startsWith("light "));
    expect(dark.length).toBe(2);
    for (const scrim of dark) {
      expect(scrim).toContain("lg:[.light_&]:hidden");
    }
    expect(light).toHaveLength(1);
    expect(light[0]).toContain("hidden lg:[.light_&]:block");
  });

  it("hides the scrim on the resolver's thumbnails in light", () => {
    const dispute: OpenDispute = {
      passportId: id("5c"),
      challenger: CHALLENGER,
      bond: "1000000000000000000",
      openedAt: 1788876082,
      evidenceURI: null,
      reason: null,
      verified: false,
      title: null,
      thumbnailUrl: "https://gw/5c",
    };

    const html = inEnglish(createElement(ResolveConsole, { resolver: RESOLVER, disputes: [dispute] }));
    const scrims = scrimClasses(html);
    expect(scrims).toHaveLength(1);
    expect(scrims[0]).toContain("[.light_&]:hidden");
  });
});
