import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import { AI_VIEWS } from "@/components/explore/query";
import type { Consent, Statement } from "@/lib/chain/consent";

/**
 * What a reader browsing the registry can see about AI use.
 *
 * A judge on 2026-09-21 said the holder's statement is the spine of the product
 * and that nobody browsing could find the pictures that carry one. So three
 * things are held here: a plate says what its holder stated and when, a plate
 * nobody has spoken for says nothing at all, and the two sets an outsider
 * actually wants are named in words above the sheet.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
  useLinkStatus: () => ({ pending: false }),
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": "true" }),
}));

vi.mock("@/lib/images", () => ({ pictureSources: () => ({ src: "https://gateway.example/one.png" }) }));

/** The real English words, reached the way a server component reaches them. */
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) =>
    namespace
      .split(".")
      .concat(key.split("."))
      .reduce<unknown>((held, step) => (held as Record<string, unknown>)[step], en) as string,
}));

const { Plate } = await import("@/components/explore/Plate");
const { Masthead } = await import("@/components/explore/Masthead");
const { StatedLine } = await import("@/components/explore/Stated");

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node));
}

/** The second the live register recorded the seed statements in, which reads 18 Sep 2026 in Chennai. */
const WRITTEN = 1_789_717_128;

const CLOSED: Consent = {
  aiTraining: "notAllowed",
  aiGenerativeTraining: "notAllowed",
  aiInference: "notAllowed",
  dataMining: "notAllowed",
};

const plate = (consent: { summary: Statement; at: number; uses: Consent } | null) => ({
  id: `0x${"1a".repeat(32)}`,
  kind: 0,
  registeredAt: 1_788_876_082,
  title: "Monsoon fishing nets drying",
  thumbnailUrl: "ipfs://picture-1",
  manifest: false,
  rechecked: false,
  chainlink: false,
  disputed: false,
  agentId: "10248",
  consent,
});

describe("the statement on a plate", () => {
  it("reads out the summary and the day it was written", () => {
    const markup = render(createElement(Plate, { plate: plate({ summary: "closed", at: WRITTEN, uses: CLOSED }) }));

    expect(markup).toContain('aria-label="Not for AI training, stated Sep 18, 2026"');
    expect(en.explore.ai.mark).toBe("{statement}, stated {when}");
  });

  it("names every summary the index can write in the passport page's own words", () => {
    for (const summary of ["open", "closed", "ask", "mixed", "none"] as Statement[]) {
      const markup = render(createElement(Plate, { plate: plate({ summary, at: WRITTEN, uses: CLOSED }) }));
      expect(markup, summary).toContain(`aria-label="${en.passport.consent.summary[summary]}, stated Sep 18, 2026"`);
    }
  });

  it("draws silence as silence on a picture nobody has spoken for", () => {
    const markup = render(createElement(Plate, { plate: plate(null) }));

    expect(markup).not.toContain("stated");
    expect(markup).not.toContain(en.passport.consent.summary.none);
    // Nothing is drawn for it at all, so the four marks are not in the markup either.
    expect(markup).not.toContain("viewBox=\"0 0 12 12\"");
  });

  it("keeps the statement out of the corner the three letters are in", () => {
    const markup = render(createElement(Plate, { plate: plate({ summary: "open", at: WRITTEN, uses: CLOSED }) }));
    const marks = markup.indexOf(en.explore.marks.manifest);
    const statement = markup.indexOf("stated Sep 18, 2026");

    // The statement sits under the kind, which is drawn before the three letters.
    expect(statement).toBeLessThan(marks === -1 ? markup.length : marks);
  });
});

describe("the figure in the masthead", () => {
  const counts = { total: 36, generated: 30, rechecked: 4, stated: 13, capped: false };

  it("says how many pictures carry a statement, counted by the index itself", async () => {
    const markup = render(
      (await Masthead({ locale: "en", counts, countsError: null, split: null, view: "pictures" })) as ReactElement,
    );

    expect(markup).toContain(">13</dd>");
    expect(markup).toContain(en.explore.counts.stated);
  });

  it("leaves the figure out rather than printing a zero when the index did not answer it", async () => {
    const markup = render(
      (await Masthead({
        locale: "en",
        counts: { ...counts, stated: null },
        countsError: null,
        split: null,
        view: "pictures",
      })) as ReactElement,
    );

    expect(markup).not.toContain(en.explore.counts.stated);
    expect(markup).toContain(en.explore.counts.total);
  });
});

describe("the line over the two sets an outsider asks for", () => {
  it("says what the open set is, and hands over the query behind it", async () => {
    const markup = render((await StatedLine({ ai: "open" })) as ReactElement);

    expect(markup).toContain(en.explore.ai.openLine);
    expect(markup).toContain(en.explore.ai.openQuery);
    expect(markup).toContain('href="/docs/api/graphql#example-pictures-open-to-ai-use"');
  });

  it("says what the refused set is, with the date on the record", async () => {
    const markup = render((await StatedLine({ ai: "closed" })) as ReactElement);

    expect(markup).toContain(en.explore.ai.closedLine);
    expect(markup).not.toContain(en.explore.ai.openQuery);
  });

  it("stays quiet on the sheets that need no explaining", async () => {
    expect(await StatedLine({ ai: "ask" })).toBeNull();
    expect(await StatedLine({ ai: "none" })).toBeNull();
    expect(await StatedLine({ ai: null })).toBeNull();
  });
});

describe("the words the AI-use chips need", () => {
  const MESSAGES = fileURLToPath(new URL("../messages/", import.meta.url));

  it("says all of them in every language the site serves", () => {
    const files = readdirSync(MESSAGES).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(10);

    for (const file of files) {
      const words = JSON.parse(readFileSync(`${MESSAGES}${file}`, "utf8")) as {
        explore: {
          ai: Record<string, string>;
          counts: Record<string, string>;
          legend: Record<string, string>;
        };
        passport: { consent: { summary: Record<string, string> } };
      };

      for (const key of ["label", "chipsLabel", "any", "ask", "none", "openLine", "openQuery", "closedLine"]) {
        expect(words.explore.ai[key]?.length ?? 0, `${file} ai.${key}`).toBeGreaterThan(0);
      }
      expect(words.explore.ai.mark, file).toContain("{statement}");
      expect(words.explore.ai.mark, file).toContain("{when}");
      expect(words.explore.counts.stated?.length ?? 0, `${file} counts.stated`).toBeGreaterThan(0);
      expect(words.explore.legend.consent?.length ?? 0, `${file} legend.consent`).toBeGreaterThan(0);

      // The two chips that carry a summary word take it from the passport page,
      // so no language can name the same statement two ways.
      for (const summary of ["open", "closed"]) {
        expect(words.passport.consent.summary[summary]?.length ?? 0, `${file} summary.${summary}`).toBeGreaterThan(0);
      }
    }
  });

  it("has a chip for every value the address may carry", () => {
    expect([...AI_VIEWS]).toEqual(["open", "closed", "ask", "none"]);
  });
});
