import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type FunctionComponent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import type { StoryData } from "@/components/story/data";

/**
 * The light film as rich as the dark one (WO-292). Every light behaviour that
 * changed is a field on the room palette: LIGHT keeps today's values until Ram
 * approves the lab, INKED is the room the lab route plays, and DARK's new
 * fields spell out what the dark film already did, so it draws as before.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; className?: string; children?: ReactNode }) =>
    createElement("a", { href: props.href, className: props.className }, props.children),
}));

const source = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const { DARK, INKED, LIGHT, roomPalette } = await import("@/components/story/palette");
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
  it("keeps today's light room as the home page's default", () => {
    expect(roomPalette("light")).toBe(LIGHT);
    expect(LIGHT.haze).toBe(LIGHT.ground);
    expect(LIGHT.fogDensity).toBe(0.05);
    expect(LIGHT.grain.strength).toBe(0);
    expect(LIGHT.paperFloor).toBe(0.4);
    expect(LIGHT.motes).toEqual({ color: "#14130f", opacity: 0.75, size: 0.016, soft: false });
    expect(LIGHT.closeShowsScene).toBe(false);
  });

  it("spells the dark film out exactly as it always drew itself", () => {
    expect(roomPalette("dark")).toBe(DARK);
    expect(DARK.haze).toBe(DARK.ground);
    expect(DARK.fogDensity).toBe(0.052);
    expect(DARK.grain).toEqual({ strength: 1, ink: "#ffffff" });
    expect(DARK.motes).toEqual({ color: "#FFB7C5", opacity: 0.9, size: 0.022, soft: false });
    expect(DARK.closeShowsScene).toBe(true);
  });

  it("plays the inked room only where it is handed over, and never in dark", () => {
    expect(roomPalette("light", INKED)).toBe(INKED);
    expect(roomPalette("dark", INKED)).toBe(DARK);
    expect(INKED.room).toBe("light");
    expect(INKED.ground).toBe(LIGHT.ground);
    expect(INKED.accent).toBe(LIGHT.accent);
    expect(INKED.grain.strength).toBeGreaterThan(0);
    expect(INKED.paperFloor).toBe(0);
    expect(INKED.motes.soft).toBe(true);
    expect(INKED.motes.color).toBe(LIGHT.accent);
    expect(INKED.fogDensity).toBeLessThan(LIGHT.fogDensity);
    expect(INKED.closeShowsScene).toBe(true);
  });

  it("draws the static at the room's strength over the beat's", () => {
    expect(staticOpacity(DARK, 0.6)).toBeCloseTo(0.6, 9);
    expect(staticOpacity(LIGHT, 0.6)).toBe(0);
    expect(staticOpacity(INKED, 0.6)).toBeCloseTo(0.6 * INKED.grain.strength, 9);
  });
});

describe("the close", () => {
  it("stands on the page's ground only when the room says so, and the card says which", () => {
    expect(FILM_STYLE).toContain('html:not(.dark) .film-close[data-close-ground="paper"]');
    expect(FILM_STYLE).not.toMatch(/html:not\(\.dark\) \.film-close \{/);
    expect(render(createElement(CloseCard, { data }))).toContain('data-close-ground="paper"');
    expect(render(createElement(CloseCard, { data, scene: true }))).toContain('data-close-ground="scene"');
    expect(render(createElement(CloseCard, { data, pinned: false }))).not.toContain("data-close-ground");
  });

  it("gives the small lines a paper halo and nothing a panel when the scene shows through, in light only", () => {
    const from = FILM_STYLE.indexOf('[data-close-ground="scene"]');
    const scene = FILM_STYLE.slice(from, FILM_STYLE.indexOf("}", from) + 1);
    expect(scene).toMatch(/text-shadow:\s*0 0 1px var\(--bg\)/);
    expect(scene).not.toContain("background");
    expect(scene).not.toContain("::before");
    expect(FILM_STYLE.match(/data-close-ground="scene"/g)).toHaveLength(1);
    // The halo is a laptop rule: a phone keeps the ground every caption rises from.
    expect(FILM_STYLE.indexOf("@media (min-width: 640px)")).toBeLessThan(FILM_STYLE.indexOf('[data-close-ground="scene"]'));
    expect(FILM_STYLE).toMatch(/html:not\(\.dark\)\s+\.film-close\[data-close-ground="scene"\]/);
    expect(FILM_STYLE).not.toMatch(/html\.dark[^{]*data-close-ground/);
  });
});

describe("the wiring", () => {
  it("hands the inked room to the lab route alone, so the home page keeps today's light", () => {
    expect(source("app/[locale]/lab/film/page.tsx")).toContain("light={INKED}");
    expect(source("app/[locale]/lab/film/page.tsx")).toContain('process.env.NEXT_PUBLIC_LAB_PAGES !== "1"');
    expect(source("app/[locale]/page.tsx")).not.toContain("light=");
    expect(source("components/story/StoryStage.tsx")).toContain("light={light}");
    expect(source("components/story/LandingStory.tsx")).toContain("scene={palette.closeShowsScene}");
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
