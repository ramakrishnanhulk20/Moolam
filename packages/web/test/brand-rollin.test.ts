import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The brand roll-in Ram picked on 30 September 2026: Linen as the light ground,
 * and the kolam knot as the one mark, in every kicker through the .motif rule,
 * in the logo's o, on the tab and on the social cards.
 */

const web = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(web, path), "utf8");
const CSS = read("styles/globals.css");

const LIGHT_SELECTOR = ":root,\n.light {";

function lightTokens(): Record<string, string> {
  const from = CSS.indexOf(LIGHT_SELECTOR);
  expect(from).toBeGreaterThan(-1);
  const body = CSS.slice(from + LIGHT_SELECTOR.length, CSS.indexOf("\n}", from)).replace(/\/\*[\s\S]*?\*\//g, "");
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((found) => [found[1], found[2].trim()]),
  );
}

const LINEN = {
  "--bg": "#e4ddd0",
  "--bg-raised": "#ede7dc",
  "--bg-sunken": "#d8d0c1",
  "--line": "#c9c0b0",
  "--line-strong": "#aba08b",
  "--text": "#14130f",
  "--text-muted": "#56534b",
  "--text-faint": "#5c5954",
  "--accent": "#a52946",
  "--accent-ink": "#fff5f7",
  "--status-verified": "#146458",
  "--status-pending": "#2c55ac",
  "--status-disputed": "#6d3f96",
  "--status-failed": "#a92912",
  "--scrim-from": "rgb(228 221 208 / 0.94)",
  "--scrim-to": "rgb(228 221 208 / 0)",
};

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const unit = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(one: string, two: string): number {
  const [light, dark] = [luminance(one), luminance(two)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** The kolam's line as the lab drew it, read from the brand file so every copy is held to one drawing. */
const KOLAM_LINE = /stroke-linejoin="round" d="([^"]+)"/.exec(read("public/brand/kolam/mark.svg"))?.[1] ?? "";

describe("Linen", () => {
  it("is the light theme's ground and inks, exactly as the lab showed them", () => {
    const tokens = lightTokens();
    for (const [token, value] of Object.entries(LINEN)) {
      expect(tokens[token], token).toBe(value);
    }
  });

  it("holds every ink to 4.5:1 on all three grounds, the sunken code blocks and wells included", () => {
    const tokens = lightTokens();
    for (const ink of ["--text", "--text-muted", "--text-faint", "--accent", "--status-verified", "--status-pending", "--status-disputed", "--status-failed"]) {
      for (const ground of ["--bg", "--bg-raised", "--bg-sunken"]) {
        expect(contrast(tokens[ink], tokens[ground]), `${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(tokens["--accent-ink"], tokens["--accent"]), "--accent-ink on --accent").toBeGreaterThanOrEqual(4.5);
  });

  it("leaves no lab tone block behind", () => {
    expect(CSS).not.toContain("LAB TONES");
    expect(CSS).not.toContain("data-lab-tone");
  });

  it("paints the phone bar, the sign-in window and the diagrams on Linen", () => {
    expect(read("app/[locale]/layout.tsx")).toContain('themeColor: "#e4ddd0"');
    expect(read("components/shell/ThemeColor.tsx")).toContain('light: "#e4ddd0"');
    expect(read("components/providers/PrivyProvider.tsx")).toContain('ground: "#ede7dc"');
    expect(read("components/docs/Mermaid.tsx")).toContain('background: "#e4ddd0"');
    for (const file of ["components/agent/AgentPoster.tsx", "components/passport/Poster.tsx"]) {
      expect(read(file), file).toContain("color-mix(in srgb, var(--bg)");
      expect(read(file), file).not.toContain("rgb(242 239 233");
    }
  });
});

describe("the mark", () => {
  const motif = CSS.slice(CSS.indexOf("\n.motif {"), CSS.indexOf("\n}", CSS.indexOf("\n.motif {")));

  it("is the kolam knot, masked in one rule, with the old seal rule gone", () => {
    expect(KOLAM_LINE.length).toBeGreaterThan(100);
    expect(motif).toContain(`mask: url("data:image/svg+xml,`);
    expect(motif).toContain(KOLAM_LINE);
    expect(CSS).not.toMatch(/\[data-motif="seal"\]/);
    expect(CSS).not.toMatch(/\.motif::after/);
  });

  it("thickens its line at 20 px and again at 12 px, the lab's three weights", () => {
    expect(motif).toContain("path{stroke-width:1.7}");
    expect(motif).toContain("@media (max-width:20px){path{stroke-width:1.95}}");
    expect(motif).toContain("@media (max-width:12px){path{stroke-width:2.3}");
  });

  it("takes its ink from a layer, so a status colour class can name another", () => {
    expect(motif).not.toMatch(/background/);
    expect(CSS).toMatch(/@layer components \{\n {2}\.motif \{\n {4}background-color: var\(--accent\);/);
  });

  it("holds a pulsing mark still for a reader who asked for less motion", () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\n {2}\.motif\.animate-pulse \{\n {4}animation: none;/);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(join(web, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(web, path)).isDirectory()) {
      return path.replace(/\\/g, "/").startsWith("components/lab") ? [] : sourceFiles(path);
    }
    return /\.(tsx?|css|mdx?|json)$/.test(name) ? [path] : [];
  });
}

describe("the logo", () => {
  it("has a kolam file for every seal-o file", () => {
    const old = readdirSync(join(web, "public/brand/seal-o")).sort();
    expect(readdirSync(join(web, "public/brand/kolam")).sort()).toEqual(old);
  });

  it("draws the kolam in every file and no square", () => {
    for (const name of readdirSync(join(web, "public/brand/kolam"))) {
      const svg = read(`public/brand/kolam/${name}`);
      expect(svg, name).toContain(KOLAM_LINE);
      expect(svg, name).not.toMatch(/fill-rule="evenodd"/);
      expect(svg, name).toContain(name.includes("light") ? "#A92A48" : "#FFB7C5");
    }
  });

  it("keeps the wordmark's letters exactly as they were", () => {
    for (const name of ["lockup-horizontal-dark.svg", "lockup-horizontal-light.svg", "lockup-stacked-dark.svg", "lockup-stacked-light.svg"]) {
      const letters = (path: string) => /<g transform="translate\(462 [\s\S]*?<\/g>/.exec(read(path))?.[0];
      expect(letters(`public/brand/kolam/${name}`), name).toBe(letters(`public/brand/seal-o/${name}`));
    }
  });

  it("is referenced by no page under brand/seal-o any more", () => {
    const pointing = ["app", "components", "lib", "styles"]
      .flatMap(sourceFiles)
      .filter((path) => readFileSync(join(web, path), "utf8").includes("brand/seal-o"));
    expect(pointing).toEqual([]);
  });
});

describe("the tab icon", () => {
  it("is the kolam in the pink, at the lab's 16 px weight", () => {
    const icon = read("app/icon.svg");
    expect(icon).toContain(KOLAM_LINE);
    expect(icon).toContain('stroke="#FFB7C5" stroke-width="1.95"');
    expect(icon).not.toContain("M0 0L16 0L16 16L0 16Z");
  });
});
