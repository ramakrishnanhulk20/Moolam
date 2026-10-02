import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type FunctionComponent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import type { StoryData } from "@/components/story/data";

/**
 * The light film as rich as the dark one (WO-292, rolled in by WO-299). Every
 * light behaviour is a field on the room palette: LIGHT is the inked Linen room
 * Ram approved on the film lab, and DARK's fields spell out what the dark film
 * always did, so it draws as before.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; className?: string; children?: ReactNode }) =>
    createElement("a", { href: props.href, className: props.className }, props.children),
}));

const source = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const { DARK, LIGHT, roomPalette } = await import("@/components/story/palette");
const { FILM_STYLE } = await import("@/components/story/room");
const { CloseCard } = await import("@/components/story/CloseCard");
const { staticOpacity } = await import("@/components/story/scene/field");

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    children?: ReactNode;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

const data: StoryData = {
  source: "envio",
  plates: [],
  focal: null,
  attestation: null,
  agent: null,
  statement: null,
  statementError: null,
  passportCount: 54,
  attestationCount: 33,
  error: null,
};

describe("the room palette carries every light behaviour", () => {
  it("plays the inked room by default in light: grain pressed into paper, soft crimson motes, a thin haze", () => {
    expect(roomPalette("light")).toBe(LIGHT);
    expect(LIGHT.room).toBe("light");
    expect(LIGHT.haze).toBe(LIGHT.ground);
    expect(LIGHT.ground).toBe("#e4ddd0");
    expect(LIGHT.accent).toBe("#a52946");
    expect(LIGHT.fogDensity).toBe(0.036);
    expect(LIGHT.paper).toBe("#f6f2ea");
    expect(LIGHT.paperFloor).toBe(0);
    expect(LIGHT.grain).toEqual({ strength: 1, ink: "#2b2622" });
    expect(LIGHT.motes).toEqual({ color: LIGHT.accent, opacity: 0.85, size: 0.024, soft: true });
    expect(LIGHT.glows).toBe(false);
  });

  it("spells the dark film out exactly as it always drew itself", () => {
    expect(roomPalette("dark")).toBe(DARK);
    expect(DARK.haze).toBe(DARK.ground);
    expect(DARK.fogDensity).toBe(0.052);
    expect(DARK.grain).toEqual({ strength: 1, ink: "#ffffff" });
    expect(DARK.motes).toEqual({ color: "#FFB7C5", opacity: 0.9, size: 0.022, soft: false });
    expect(DARK.glows).toBe(true);
  });

  it("has one light room and one dark room, with nothing to hand in", () => {
    expect(roomPalette.length).toBe(1);
    expect(source("components/story/palette.ts")).not.toContain("INKED");
    expect(source("components/story/palette.ts")).not.toContain("closeShowsScene");
  });

  it("draws the static at the room's strength over the beat's", () => {
    expect(staticOpacity(DARK, 0.6)).toBeCloseTo(0.6, 9);
    expect(staticOpacity(LIGHT, 0.6)).toBeCloseTo(0.6 * LIGHT.grain.strength, 9);
    expect(staticOpacity(LIGHT, 0)).toBe(0);
  });
});

describe("the close", () => {
  it("lets the scene show through in both rooms: no panel, no ground of its own, no marker to switch on", () => {
    expect(FILM_STYLE).not.toContain("data-close-ground");
    expect(FILM_STYLE).not.toMatch(/\.film-close\s*\{[^}]*background/);
    expect(render(createElement(CloseCard, { data }))).not.toContain("data-close-ground");
    expect(render(createElement(CloseCard, { data, pinned: false }))).not.toContain("data-close-ground");
    expect(source("components/story/CloseCard.tsx")).not.toContain("scene?:");
  });

  it("gives the small lines a paper halo, in light only", () => {
    const from = FILM_STYLE.indexOf("html:not(.dark)\n    .film-close");
    expect(from).toBeGreaterThan(-1);
    const rule = FILM_STYLE.slice(from, FILM_STYLE.indexOf("}", from) + 1);
    expect(rule).toMatch(/text-shadow:\s*0 0 1px var\(--bg\)/);
    expect(rule).not.toContain("background");
    expect(rule).not.toContain("::before");
    expect(FILM_STYLE.match(/html:not\(\.dark\)\s+\.film-close/g)).toHaveLength(1);
    // The halo is a laptop rule: a phone keeps the ground every caption rises from.
    expect(FILM_STYLE.indexOf("@media (min-width: 640px)")).toBeLessThan(from);
    expect(FILM_STYLE).not.toMatch(/html\.dark[^{]*\.film-close/);
  });
});

describe("the wiring", () => {
  it("plays the one light room on the home page and the film, with no room handed in", () => {
    expect(source("app/[locale]/page.tsx")).not.toContain("light=");
    expect(source("components/story/StoryStage.tsx")).not.toContain("light");
    expect(source("components/story/LandingStory.tsx")).toContain("roomPalette(mounted ? roomOf(resolvedTheme) : \"light\")");
    expect(source("components/story/LandingStory.tsx")).toContain("<CloseCard data={data} />");
  });

  it("reads the static, the motes and the haze off the room rather than off the glows flag", () => {
    const field = source("components/story/scene/field.tsx");
    expect(field).not.toContain("room.glows ? inks.grain");
    expect(field).not.toContain("room.glows ? 0.022 : 0.016");
    expect(field).toContain("staticOpacity(room, inks.grain * (1 - away))");
    expect(field).toContain("motes.size * (1 - eased * 0.55)");
    expect(field).toContain("room.paperFloor * (1 - away)");
    expect(source("components/story/LandingStory.tsx")).toContain("haze.set(room.haze)");
  });
});
