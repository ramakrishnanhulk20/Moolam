import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import type { ExplorePlate } from "@/components/explore/sort";
import type { Consent } from "@/lib/chain/consent";

/**
 * The Explore plates in light.
 *
 * Both scrims are cream in light, and over the whole still they read as a
 * pale haze. Light draws neither: the foot carries its own ground behind the
 * title, and the kind, the letters and the AI-use marks each stand on a small
 * tag. Dark keeps what it had, and a sealed plate has no picture to haze.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": "true" }),
}));

const { Plate } = await import("@/components/explore/Plate");

const CLOSED: Consent = {
  aiTraining: "notAllowed",
  aiGenerativeTraining: "notAllowed",
  aiInference: "notAllowed",
  dataMining: "notAllowed",
};

const picture: ExplorePlate = {
  id: `0x${"1a".repeat(32)}`,
  kind: 0,
  registeredAt: 1_788_876_082,
  title: "Black Basalt Lighthouse at Night",
  thumbnailUrl: "ipfs://picture-1",
  manifest: true,
  rechecked: true,
  chainlink: false,
  disputed: false,
  agentId: "10248",
  consent: { summary: "closed", at: 1_789_717_128, uses: CLOSED },
};

const sealed: ExplorePlate = {
  ...picture,
  thumbnailUrl: null,
  manifest: false,
  rechecked: false,
  consent: null,
  sealed: true,
  blockhash: "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0",
};

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node));
}

/** The class list of the first element carrying the given attribute, with the markup's escaped ampersands read back. */
function classOf(markup: string, attribute: string): string {
  const at = markup.indexOf(attribute);
  expect(at, attribute).toBeGreaterThan(-1);
  const open = markup.lastIndexOf("<", at);
  const tag = markup.slice(open, markup.indexOf(">", at));
  return (/class="([^"]*)"/.exec(tag)?.[1] ?? "").replaceAll("&amp;", "&");
}

describe("an Explore plate in light", () => {
  const markup = render(createElement(Plate, { plate: picture }));

  it("draws no scrim across the picture, only the dark theme's, hidden in light", () => {
    const full = classOf(markup, 'data-scrim="dark"');

    expect(full).toContain("scrim");
    expect(full).toContain("[.light_&]:hidden");
    expect(classOf(markup, "data-plate-top-scrim")).toContain("[.light_&]:hidden");
  });

  it("gives the foot its own ground in light, starting below its empty top padding", () => {
    const foot = classOf(markup, "data-plate-foot");

    expect(foot).toContain("[.light_&]:pt-8");
    expect(foot).toContain("[.light_&]:bg-[linear-gradient(to_bottom,var(--scrim-to)_0,");
  });

  it("puts the kind, the letters and the AI-use marks on a tag of solid ground in light", () => {
    const said = /<span class="([^"]*)"><span role="img" aria-label="Not for AI training/.exec(markup)?.[1].replaceAll("&amp;", "&");

    for (const tag of [classOf(markup, "data-plate-kind"), classOf(markup, "data-plate-marks"), said]) {
      expect(tag).toContain("[.light_&]:bg-bg-raised");
      expect(tag).toContain("[.light_&]:w-fit");
    }
  });

  it("leaves a sealed plate exactly as it was", () => {
    const drawn = render(createElement(Plate, { plate: sealed }));

    expect(drawn).not.toContain("[.light_&amp;]");
    expect(drawn).not.toContain("data-plate-top-scrim");
    expect(drawn).not.toContain('data-scrim="dark"');
  });
});
