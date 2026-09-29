// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, type FunctionComponent, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { StoryData } from "@/components/story/data";
import type { Passport } from "@/lib/chain/registry";

/**
 * The small follow-ups the polish cooks reported, one case per step of WO-226
 * steps 1 to 8: the address beside a refused copy, the sealed poster's Copy
 * link, the colour of a slow wait, the still page's ladder in bits apart, the
 * close card's dead attribute, the bar's comment, an unnamed agent's title, and
 * the leftover reason on Your pictures.
 *
 * What this does not cover: a real clipboard, how any of it looks at 375 px,
 * or the film's own scene. The clipboard is stubbed, the rest is read as the
 * markup a browser would be handed.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/motion/useIsReducedMotion", () => ({ useIsReducedMotion: () => false }));

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: en, namespace }),
  getFormatter: async () => ({
    dateTime: (date: Date) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(date),
  }),
  setRequestLocale: () => undefined,
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: Record<string, unknown> & { href: unknown; children?: unknown }) => {
    delete rest.prefetch;
    return createElement("a", { href: typeof href === "string" ? href : "/", ...rest }, children as never);
  },
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  usePathname: () => "/",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
  useParams: () => ({ locale: "en" }),
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: (props: { sources: string[] }) => createElement("span", { "data-picture": props.sources[0] ?? "" }),
}));

vi.mock("@/components/passport/RecheckRequest", () => ({ RecheckRequest: () => null }));

const { pageAddress, ShareLink } = await import("@/components/passport/ShareLink");
const { SealedPlate } = await import("@/components/sealed/SealedPlate");
const { Poster } = await import("@/components/passport/Poster");
const { AnswerCard, SLOW_AFTER_SECONDS } = await import("@/components/verify/AnswerCard");
const { LandingStory } = await import("@/components/story/LandingStory");
const { bitsApart, degradeSteps } = await import("@/components/story/measurements");
const { useCopyWords } = await import("@/components/story/StillStory");
const { Row } = await import("@/components/agents/Row");
const { YourPassports } = await import("@/components/studio/YourPassports");

const web = join(__dirname, "..");
const source = (file: string) => readFileSync(join(web, file), "utf8");

function words(node: ReactElement): ReactElement {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    children: ReactElement;
  }>;
  return createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node);
}

function render(node: ReactElement): string {
  return renderToStaticMarkup(words(node));
}

const SHARE = { copy: en.passport.share.copy, copied: en.passport.share.copied, copyFailed: en.common.copyFailed };
const ID = `0x${"7c".repeat(32)}` as Hex;

let host: HTMLDivElement | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  host?.remove();
  host = null;
});

async function mount(node: ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(words(node));
  });
  return { host, root };
}

describe("step 1: a refused copy on the poster", () => {
  it.each([
    ["refuses the write", { clipboard: { writeText: () => Promise.reject(new Error("denied")) } }],
    ["has no clipboard at all", { clipboard: undefined }],
  ])("shows the passport's address as selectable text beside the sentence when the browser %s", async (_, stub) => {
    vi.stubGlobal("navigator", { ...navigator, ...stub });
    window.history.replaceState(null, "", `/en/passport/${ID}#ai-use`);
    const { host: box, root } = await mount(createElement(ShareLink, { words: SHARE }));

    expect(box.querySelector("[data-copy-failed]")).toBeNull();
    await act(async () => {
      box.querySelector<HTMLButtonElement>("[data-copy-link]")?.click();
    });

    const failed = box.querySelector("[data-copy-failed]");
    expect(failed?.textContent).toContain(en.common.copyFailed);
    const address = box.querySelector("[data-copy-address]");
    expect(address?.textContent).toBe(pageAddress(window.location.href));
    expect(address?.textContent).toBe(`${window.location.origin}/en/passport/${ID}`);
    expect(address?.className).toContain("select-all");
    await act(async () => root.unmount());
  });
});

describe("step 2: the sealed poster's Copy link", () => {
  const bits = Array.from({ length: 256 }, (_, index) => index % 3 === 0);
  const plateWords = { sealed: "Sealed", line: "Registered 14 Sep 2026.", untitled: "Untitled" };

  it("draws the same Copy link as the public poster, on the poster only", () => {
    const poster = render(
      createElement(SealedPlate, { bits, title: "Kanchipuram", words: plateWords, size: "poster" as const, share: SHARE }),
    );
    expect(poster).toContain("data-sealed-share");
    expect(poster).toContain("data-copy-link");
    expect(poster).toContain(`>${en.passport.share.copy}</span>`);
    // The Explore tile is a link of its own, and never carries a second press.
    const plate = render(createElement(SealedPlate, { bits, title: "Kanchipuram", words: plateWords, share: SHARE }));
    expect(plate).not.toContain("data-copy-link");
  });

  it("is handed its words by the passport page's sealed poster", async () => {
    const passport: Passport = {
      id: ID,
      exactHash: ID,
      parentId: `0x${"00".repeat(32)}` as Hex,
      creator: "0x85a88C5b1b7D1b1a3F3b8c0cF4d7a0F1E4b239a6" as Hex,
      generatorAgentId: 0n,
      phash: 0x6ccf137087789a25n,
      blockhash256: `0x${"11".repeat(32)}` as Hex,
      manifestHash: `0x${"22".repeat(32)}` as Hex,
      kind: 0,
      fingerprintVersion: 1,
      registeredAt: 1_788_881_666n,
      disputed: false,
      metadataURI: "ipfs://bafkreimetadata",
    };
    const sealed = render(await Poster({ passport, art: { sealed: true, title: "Kanchipuram" } as never, locale: "en" }));
    expect(sealed).toContain("data-sealed-share");
    expect(sealed).toContain(`>${en.passport.share.copy}</span>`);
    expect(sealed).toContain(`>${en.passport.share.copied}</span>`);
  });
});

describe("step 3: a slow wait", () => {
  it("draws the slow line in the pending colour family, not the accent", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { host: box, root } = await mount(
      createElement(AnswerCard, { stage: { kind: "checking" as const, name: "harbour.jpg" } }),
    );
    expect(box.querySelector("[data-wait-slow]")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(SLOW_AFTER_SECONDS * 1000);
    });
    const slow = box.querySelector("[data-wait-slow]");
    expect(slow?.textContent).toBe(en.verify.wait.slow);
    expect(slow?.className).toMatch(/\bborder-pending\//);
    expect(slow?.className).not.toContain("accent");
    await act(async () => root.unmount());
  });
});

describe("step 4: the still page's ladder", () => {
  const data: StoryData = {
    source: "envio",
    plates: [],
    focal: {
      id: `0x${"f0".repeat(32)}` as Hex,
      picture: "https://example.test/picture.jpg",
      creator: "0x85a88Ca81ff5f681D96AB86fa60ccB8452A139a6" as Hex,
      agentId: "7",
      registeredAt: 1_789_648_000,
      block: "12345678",
      kind: 0,
      manifest: true,
      attestations: 1,
      why: "full",
      measured: false,
    },
    attestation: null,
    agent: null,
    statement: null,
    statementError: null,
    passportCount: 41,
    attestationCount: 20,
    error: null,
  };

  const said = (value: string, result: string) =>
    en.story.verified.similarity.replace("{value}", value).replace("{result}", result);

  it("prints every rung in bits apart, the film's own figure, and never a confidence", () => {
    // No WebGL here, which is exactly the reader the still page is drawn for.
    const probe = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const markup = render(createElement(LandingStory, { data, variant: "chapter" as const }));
    const at = markup.indexOf("data-still-ladder");
    expect(at).toBeGreaterThan(-1);
    const ladder = markup.slice(at, markup.indexOf("</ul>", at));
    for (const step of degradeSteps()) {
      expect(ladder, step.transform).toContain(`>${said(bitsApart(step), en.story.verified.match)}</span>`);
    }
    expect(ladder).not.toMatch(/0\.\d/);
    probe.mockRestore();
  });

  // WO-229 step 5 changed this on purpose: a copy nobody measured is refused,
  // never printed as the whole width apart, and the ladder's loader refuses
  // such a step before any page can ask for its words.
  it("prints a measured copy's distance, and refuses a copy nobody measured rather than printing 64", () => {
    let spoken = "";
    function Probe({ distance }: { distance: number | null }) {
      spoken = useCopyWords().distance({ phashDistance: distance });
      return null;
    }
    render(createElement(Probe, { distance: 2 }));
    expect(spoken).toBe(said("2", en.story.verified.match));
    expect(() => render(createElement(Probe, { distance: null }))).toThrow(/no measured distance/);
    expect(source("components/story/StillStory.tsx")).toContain("value: bitsApart(step)");
  });
});

describe("step 5: the close card", () => {
  it("no longer writes data-chapter-close, which nothing in the app reads", () => {
    expect(source("components/story/CloseCard.tsx")).not.toContain("chapter-close");
    const readers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (/\.(tsx?|css)$/.test(name) && readFileSync(path, "utf8").includes("chapter-close")) {
          readers.push(path);
        }
      }
    };
    for (const dir of ["app", "components", "lib", "styles"]) {
      walk(join(web, dir));
    }
    expect(readers).toEqual([]);
  });
});

describe("step 6: the comment over the phone's bar", () => {
  it("says the bar stays through the film rather than hiding during it", () => {
    const layout = source("app/[locale]/layout.tsx");
    const bar = layout.indexOf("<BottomBar");
    const comment = layout.slice(layout.lastIndexOf("{/*", bar), bar);
    expect(comment).toContain("through the whole film");
    expect(comment).not.toMatch(/out of the way|arrives with the closing card/);
  });
});

describe("step 7: an unnamed agent on the Agents board", () => {
  const agent = {
    id: "10248",
    name: null as string | null,
    passportCount: 12,
    matchedCount: 9,
    mismatchedCount: 1,
    disputesUpheld: 0,
    trustScore: 82,
    firstSeenAt: 1_789_648_000,
  };

  it("titles the line with agents.unnamedTitle and keeps agents.unnamed as the smaller line under it", () => {
    const html = render(createElement(Row, { agent, place: 0 }));
    const title = html.slice(html.indexOf("<h2"), html.indexOf("</h2>"));
    expect(title).toContain(`>${en.agents.unnamedTitle}</a>`);
    expect(title).not.toContain("carries no name");
    const small = html.slice(html.indexOf("data-agent-unnamed"));
    expect(small).toContain(en.agents.unnamed.replace(/'/g, "&#x27;"));
    expect(html.indexOf("data-agent-unnamed")).toBeGreaterThan(html.indexOf("</h2>"));
  });

  it("draws a named agent as before, with no unnamed line", () => {
    const html = render(createElement(Row, { agent: { ...agent, name: "Moolam generator" }, place: 1 }));
    expect(html).toContain(">Moolam generator</a>");
    expect(html).not.toContain("data-agent-unnamed");
  });
});

describe("step 8: Your pictures after a failed read", () => {
  it("says its sentence without a reason the message no longer takes", () => {
    expect(en.studio.passports.unreadable).not.toContain("{reason}");
    expect(source("components/studio/YourPassports.tsx")).not.toContain('reason: ""');
    const html = render(
      createElement(YourPassports, {
        passports: {
          status: "unreadable",
          passports: [],
          error: "fetch failed",
          refresh: () => undefined,
          hasMore: false,
          loadingMore: false,
          moreError: null,
          more: () => undefined,
        } as never,
      }),
    );
    expect(html).toContain(`>${en.studio.passports.unreadable}</span>`);
  });
});
