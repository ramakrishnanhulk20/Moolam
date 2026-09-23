import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Hex } from "viem";
import { SKETCH_BITS, SKETCH_SIDE, sketchBits } from "@/components/sealed/bits";
import { SEALED_DOCUMENT_KEYS, SEALED_PUBLIC_FIELDS, sealedFieldsFor } from "@/components/sealed/fields";
import { SealSwitch } from "@/components/sealed/SealSwitch";
import { SealedPlate } from "@/components/sealed/SealedPlate";
import { SealedShareCard } from "@/components/sealed/SealedShareCard";
import { repoRoot } from "@/lib/docs/paths";

/**
 * The pieces a sealed passport is drawn with, before they touch a real screen.
 *
 * Two things are being pinned down. A sealed plate must read as a designed
 * record rather than as a picture that failed to load, which is invariant 7 of
 * the sealed threat model. And the list the studio shows before the passkey
 * prompt must be the whole of what the verify service pins, which is invariant
 * 8: that list is held against the service's own schema below, key for key, so
 * a field added there and not here cannot ship.
 */

/** A real block hash from mainnet: the Monsoon passport this bench draws. */
const BLOCKHASH = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

const MONSOON = "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638" as Hex;

const WORDS = {
  sealed: "Sealed",
  line: "Registered 14 Sep 2026. The picture is not published.",
  untitled: "Untitled",
};

const SWITCH_WORDS = {
  label: "Keep this picture sealed",
  note: "Moolam publishes the passport, not the picture. Save the file we hand back: it is the only copy that can unseal this passport.",
  panelHeading: "What becomes public",
  panelLine: "Everything below goes out the moment you sign.",
  sketchCaption: "The whole of the picture that becomes public.",
  inFile: "Pinned file",
  onChain: "On Monad",
  leftOut: "Left out",
  promptLabel: "Include the prompt",
  promptNote: "The prompt stays private unless you include it.",
};

function render(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("the sketch a sealed passport shows", () => {
  it("reads a block hash as 256 bits, highest first", () => {
    const bits = sketchBits(MONSOON);
    expect(bits).toHaveLength(SKETCH_BITS);
    expect(SKETCH_SIDE * SKETCH_SIDE).toBe(SKETCH_BITS);
    // 0xc is 1100, so the first four bits of this hash are lit, lit, dark, dark.
    expect(bits.slice(0, 4)).toEqual([true, true, false, false]);
    // The last hex character is 8, which is 1000.
    expect(bits.slice(-4)).toEqual([true, false, false, false]);
  });

  it("keeps the leading zeros a number would swallow", () => {
    expect(sketchBits(BLOCKHASH).every((bit) => bit === false)).toBe(true);
  });

  it("refuses anything that is not a whole 32 byte word, rather than drawing a different picture", () => {
    expect(() => sketchBits("0xcdb2")).toThrow(/whole 32 byte/);
    expect(() => sketchBits(`0x${"z".repeat(64)}`)).toThrow(/whole 32 byte/);
    expect(() => sketchBits(`0x${"a".repeat(66)}`)).toThrow(/whole 32 byte/);
  });
});

describe("the sealed plate", () => {
  const bits = sketchBits(MONSOON);

  it("draws the poster from the fingerprint, with the word sealed, the title and the date line", () => {
    const html = render(
      createElement(SealedPlate, {
        bits,
        title: "Monsoon Fishing Nets Drying",
        words: WORDS,
        size: "poster" as const,
        shortId: "0xcdb25d37...d771638",
      }),
    );

    expect(html).toContain("Sealed");
    expect(html).toContain("Monsoon Fishing Nets Drying");
    expect(html).toContain("Registered 14 Sep 2026. The picture is not published.");
    expect(html).toContain("0xcdb25d37...d771638");
    // 256 cells, and not one of them an image that could fail to load.
    expect(html.split("bg-text").length - 1).toBeGreaterThan(100);
    expect(html).not.toContain("<img");
  });

  it("draws the four by five plate Explore lays out, with the same words", () => {
    const html = render(createElement(SealedPlate, { bits, title: "Monsoon Fishing Nets Drying", words: WORDS }));

    expect(html).toContain("aspect-[4/5]");
    expect(html).toContain("Sealed");
    expect(html).toContain("Registered 14 Sep 2026. The picture is not published.");
    expect(html).not.toContain("<img");
  });

  it("names a passport that pinned no title rather than leaving a gap", () => {
    const html = render(createElement(SealedPlate, { bits, title: "   ", words: WORDS }));
    expect(html).toContain("Untitled");
  });

  it("draws the link preview at the size a crawler asks for", () => {
    const html = render(
      createElement(SealedShareCard, {
        bits,
        title: "Monsoon Fishing Nets Drying",
        shortId: "0xcdb25d37...d771638",
        words: { sealed: "Sealed", untitled: "Untitled", line: "Sealed on Monad, 14 Sep 2026." },
      }),
    );

    expect(html).toContain("width:1200px");
    expect(html).toContain("height:630px");
    expect(html).toContain("Sealed on Monad, 14 Sep 2026.");
    expect(html).not.toContain("<img");
  });
});

/**
 * The top level keys of the document the verify service pins for a sealed
 * registration, read out of its schema.
 *
 * The file is read rather than imported because the web app does not depend on
 * the verify service, and a copy of the key list kept here would be the very
 * thing this test exists to catch.
 */
function schemaKeys(): string[] {
  const source = readFileSync(path.join(repoRoot, "packages", "verifier", "src", "sealed.ts"), "utf8");
  const opened = source.indexOf("export const sealedMetadataSchema = z.strictObject({");
  expect(opened).toBeGreaterThan(-1);
  const body = source.slice(opened, source.indexOf("\n});", opened));
  return [...body.matchAll(/^ {2}([a-zA-Z]+):/gm)].map((hit) => hit[1]);
}

describe("what the studio says becomes public", () => {
  it("lists every key of the sealed document the verify service pins, and no others", () => {
    const keys = schemaKeys();
    expect(keys).toHaveLength(11);
    expect([...SEALED_DOCUMENT_KEYS].sort()).toEqual([...keys].sort());
  });

  it("names the wallet too, which goes on Monad rather than into the pinned file", () => {
    const chain = SEALED_PUBLIC_FIELDS.filter((field) => field.source === "chain");
    expect(chain.map((field) => field.key)).toEqual(["creator"]);
  });

  it("leaves the agent, the model and the prompt off a picture nobody drew", () => {
    expect(sealedFieldsFor({ generated: false }).map((field) => field.key)).not.toContain("prompt");
    expect(sealedFieldsFor({ generated: false }).map((field) => field.key)).not.toContain("generator");
    expect(sealedFieldsFor({ generated: true }).map((field) => field.key)).toContain("prompt");
  });

  it("lists the private re-check's one word only while it is asked for", () => {
    expect(sealedFieldsFor({ generated: false }).map((field) => field.key)).not.toContain("privateRecheck");
    expect(sealedFieldsFor({ generated: true }).map((field) => field.key)).not.toContain("privateRecheck");
    expect(sealedFieldsFor({ generated: false, privateRecheck: true }).map((field) => field.key)).toContain(
      "privateRecheck",
    );
  });

  it("draws the panel with every key, the sketch and the note about the file, once the switch is on", () => {
    const html = render(
      createElement(SealSwitch, {
        on: true,
        onChange: () => undefined,
        bits: sketchBits(MONSOON),
        generated: true,
        includePrompt: false,
        onIncludePrompt: () => undefined,
        words: SWITCH_WORDS,
      }),
    );

    for (const field of sealedFieldsFor({ generated: true })) {
      expect(html, field.key).toContain(field.key);
      expect(html, field.label).toContain(field.label);
    }
    expect(html).toContain("What becomes public");
    expect(html).toContain("it is the only copy that can unseal this passport");
    expect(html).toContain("Include the prompt");
    expect(html).toContain("Left out");
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
  });

  it("says nothing about what is public until the switch is on", () => {
    const html = render(
      createElement(SealSwitch, {
        on: false,
        onChange: () => undefined,
        bits: sketchBits(MONSOON),
        words: SWITCH_WORDS,
      }),
    );

    expect(html).toContain("Keep this picture sealed");
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain("What becomes public");
  });
});

describe("who can reach the bench", () => {
  it("is a 404 anywhere the lab flag is not set, which is everywhere but this machine", async () => {
    const page = await import("@/app/[locale]/lab/sealed/page");
    delete process.env.NEXT_PUBLIC_LAB_PAGES;

    const thrown = await page.default({ params: Promise.resolve({ locale: "en" }) }).catch((error: unknown) => error);
    expect((thrown as { digest?: string }).digest).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});

describe("what the bench pulls into the browser", () => {
  /** The packages only a screen that signs has any use for. */
  const WALLET = ["@privy-io/react-auth", "@privy-io/wagmi", "wagmi", "@tanstack/react-query"];

  const FILES = [
    "components/sealed/bits.ts",
    "components/sealed/fields.ts",
    "components/sealed/Sketch.tsx",
    "components/sealed/SealedPlate.tsx",
    "components/sealed/SealedShareCard.tsx",
    "components/sealed/SealSwitch.tsx",
    "components/lab/sealed/CardFrame.tsx",
    "components/lab/sealed/SealedBench.tsx",
    "app/[locale]/lab/sealed/page.tsx",
  ];

  it("imports no wallet package in any file this bench added", () => {
    // One level, not the whole walk: the route test does the transitive one for
    // the pages a visitor can reach, and nothing here reaches beyond the app.
    for (const file of FILES) {
      const source = readFileSync(path.join(repoRoot, "packages", "web", file), "utf8");
      for (const packageName of WALLET) {
        expect(source, `${file} imports ${packageName}`).not.toContain(packageName);
      }
    }
  });
});
