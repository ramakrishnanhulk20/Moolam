import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WarningMark } from "@/components/WarningMark";

/**
 * The failure red Ram picked on the lab's second bench, drawing A, and the mark
 * every failure line carries.
 *
 * The old red sat one degree of hue from the crimson accent, so in the light
 * theme a failure read as decoration. These pin the new values to every block
 * that sets them and hold each one to 4.5:1 on the grounds a failure lands on,
 * so a later palette change cannot quietly drop a failure under the bar.
 */

const CSS = readFileSync(fileURLToPath(new URL("../styles/globals.css", import.meta.url)), "utf8").replace(/\r\n/g, "\n");

/** The custom properties set directly inside the block that opens with `selector`. */
function block(selector: string): Record<string, string> {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `no block for ${selector}`).toBeGreaterThanOrEqual(0);
  const body = CSS.slice(at, CSS.indexOf("}", at));
  const tokens: Record<string, string> = {};
  for (const match of body.matchAll(/(--[a-z-]+):\s*([^;]+);/g)) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

function channels(hex: string): number[] {
  expect(hex).toMatch(/^#[0-9a-fA-F]{6}$/);
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(one: string, two: string): number {
  const [light, dark] = [luminance(one), luminance(two)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** A failure note tints its ground with the red at 5 per cent, which is the ground its words really sit on. */
function tint(ground: string, red: string, share = 0.05): string {
  const under = channels(ground);
  const over = channels(red);
  return `#${under.map((value, at) => Math.round(value * (1 - share) + over[at] * share).toString(16).padStart(2, "0")).join("")}`;
}

const THEMES = [
  { name: "dark", selector: ".dark", red: "#ff5f4d" },
  {
    name: "light",
    selector: '.light,\n.light .story-close,\n.light [data-story="still"] > div > section:last-child',
    red: "#a92912",
  },
  { name: "story", selector: ".story", red: "#ff5f4d" },
] as const;

describe("the failure red", () => {
  for (const theme of THEMES) {
    describe(`in the ${theme.name} block`, () => {
      const tokens = block(theme.selector);

      it(`is ${theme.red}`, () => {
        expect(tokens["--status-failed"]).toBe(theme.red);
      });

      it("reaches 4.5:1 on the page, on a card, and on a failure note over either", () => {
        const { "--bg": page, "--bg-raised": card } = tokens;
        for (const ground of [page, card, tint(page, theme.red), tint(card, theme.red)]) {
          expect(contrast(theme.red, ground), `${theme.red} on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
      });
    });
  }

  it("leaves no trace of the old reds in the stylesheet", () => {
    expect(CSS.toLowerCase()).not.toContain("#c2586f");
    expect(CSS.toLowerCase()).not.toContain("#9c2f47");
  });
});

describe("the warning mark", () => {
  const html = renderToStaticMarkup(createElement(WarningMark, { className: "mt-[3px]" }));

  it("is hidden from screen readers and says nothing of its own", () => {
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toMatch(/<title|<text/);
    expect(html.replace(/<[^>]+>/g, "")).toBe("");
  });

  it("draws in the colour of the line it stands in, at 14 px", () => {
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('width="14"');
    expect(html).toContain('height="14"');
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });

  it("keeps the class it is given alongside its own", () => {
    expect(html).toContain('class="inline-block shrink-0 mt-[3px]"');
    expect(renderToStaticMarkup(createElement(WarningMark))).toContain('class="inline-block shrink-0"');
  });
});
