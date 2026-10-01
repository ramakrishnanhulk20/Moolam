import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";

/**
 * The three letters on a plate, and the line under the chips that says what
 * they mean.
 *
 * A judge browsing on a phone on 2026-09-21 met M, R and D with nothing to tell
 * him what they were: a title never fires under a thumb. So two things are held
 * here. Every lit mark carries its meaning as a label a screen reader reads out,
 * and the legend's words match what each mark is actually read from in the
 * index, not what the letter looks like it might stand for.
 */

const link = vi.hoisted(() => ({ pending: false }));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
  useLinkStatus: () => link,
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": "true" }),
}));

vi.mock("@/lib/images", () => ({ pictureSources: () => ({ src: "https://gateway.example/one.png" }) }));

const { Filters } = await import("@/components/explore/Filters");
const { Plate } = await import("@/components/explore/Plate");

/** The long dash this repo never writes, built from its code point so this file does not carry one. */
const LONG_DASH = String.fromCodePoint(0x2014);

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node));
}

/** One plate with every mark lit, which is the only state that carries a meaning. */
const marked = {
  id: `0x${"1a".repeat(32)}`,
  kind: 0,
  registeredAt: 1_788_876_082,
  title: "Monsoon fishing nets drying",
  thumbnailUrl: "ipfs://picture-1",
  manifest: true,
  rechecked: true,
  chainlink: false,
  disputed: true,
  agentId: "10248",
  consent: null,
};

const bare = { ...marked, manifest: false, rechecked: false, disputed: false };

const sheet = () =>
  render(createElement(Filters, { search: { view: "pictures" as const, search: "", agent: null, ai: null } }));

describe("the letters on a plate", () => {
  it("says what each lit mark means, in the words of the thing it was read from", () => {
    const markup = render(createElement(Plate, { plate: marked }));

    expect(markup).toContain(`aria-label="${en.explore.marks.manifest}"`);
    expect(markup).toContain(`aria-label="${en.explore.marks.rechecked}"`);
    expect(markup).toContain(`aria-label="${en.explore.marks.disputed}"`);
  });

  it("calls a Chainlink verdict a check only when the index says the network wrote it", () => {
    const unconfirmed = render(createElement(Plate, { plate: { ...marked, chainlink: true } }));
    // React writes an apostrophe as &#x27; in the markup.
    const shown = (line: string) => line.replace(/'/g, "&#x27;");
    expect(unconfirmed).toContain(`aria-label="${shown(en.explore.marks.unconfirmed)}"`);
    expect(unconfirmed).not.toContain(`aria-label="${shown(en.explore.marks.chainlink)}"`);

    const testRun = render(createElement(Plate, { plate: { ...marked, chainlink: true, network: false } }));
    expect(testRun).toContain(`aria-label="${shown(en.explore.marks.testRun)}"`);

    const checked = render(createElement(Plate, { plate: { ...marked, chainlink: true, network: true } }));
    expect(checked).toContain(`aria-label="${shown(en.explore.marks.chainlink)}"`);
    expect(checked).not.toContain(`aria-label="${shown(en.explore.marks.rechecked)}"`);
  });

  it("leaves an unlit mark out of the reading rather than announcing three absences per plate", () => {
    const markup = render(createElement(Plate, { plate: bare }));

    expect(markup).not.toContain("aria-label");
    expect(markup.match(/aria-hidden="true"/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe("the legend under the chips", () => {
  it("reads each letter against what the index actually holds for it", () => {
    const markup = sheet();

    // M is the manifest hash on the passport, R is a re-check written on chain,
    // D is a dispute reaching this picture or the one it was edited from.
    expect(markup).toContain(`<span class="text-accent">M</span> ${en.explore.legend.manifest}`);
    expect(markup).toContain(`<span class="text-verified">R</span> ${en.explore.legend.rechecked.replace(/'/g, "&#x27;")}`);
    expect(markup).toContain(`<span class="text-disputed">D</span> ${en.explore.legend.disputed}`);
  });

  it("separates the three with a middle dot and no kind of dash", () => {
    const markup = sheet();
    const legend = markup.slice(markup.indexOf(en.explore.legend.manifest), markup.indexOf(en.explore.legend.disputed));

    expect(legend.match(/·/g)).toHaveLength(2);
    expect(legend).not.toContain(LONG_DASH);
    expect(legend).not.toContain("–");
  });

  it("carries the mark that says the sheet is being read, held at nothing until it is", () => {
    expect(sheet()).toContain('opacity-0"');
    expect(sheet()).toContain(en.explore.reading);
  });
});

describe("a chip that has been pressed", () => {
  it("dims its own label and marks itself while the sheet it asked for is read", () => {
    link.pending = false;
    expect(sheet()).not.toContain("opacity-40");

    link.pending = true;
    const pressed = sheet();
    link.pending = false;

    expect(pressed).toContain("opacity-40");
    expect(pressed).toContain("animate-pulse");
    // The label fades and the mark is pinned over the corner: a chip pressed at
    // 375 px must not push the eight chips beside it along the row.
    expect(pressed).toContain("absolute end-1 top-1");
  });
});
