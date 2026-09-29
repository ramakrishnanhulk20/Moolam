import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createFormatter, useFormatter } from "next-intl";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import { timeFormats } from "@/lib/i18n/timeFormats";
import { IntlProvider } from "@/components/providers/IntlProvider";
import { PhoneHeader } from "@/components/shell/PhoneHeader";

/**
 * Every time of day names its clock, and the phone's theme control never loses
 * its words to a narrow row.
 *
 * The server renders in UTC. A reader in India who sees a bare "3:45 PM" reads
 * it as their own afternoon, five and a half hours off. And "Theme: dark" in
 * Tamil was cut on every page at 375 px, so on a phone the theme is a mark
 * whose name is still the whole sentence.
 */

// The header's link and language chip come from next-intl's navigation, which
// needs a request to exist. Neither is what these tests are about.
vi.mock("@/lib/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: Record<string, unknown> & { href: string; children?: ReactNode }) =>
    createElement("a", { href, className: rest.className }, children),
}));
vi.mock("@/components/LocaleSwitch", () => ({
  LocaleSwitch: () => createElement("button", { type: "button" }, "English"),
}));
vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => createElement("img", { alt }),
}));

// 2026-09-27 15:45 UTC, which is 21:15 in India.
const INSTANT = new Date(Date.UTC(2026, 8, 27, 15, 45));

function formatter(locale: string) {
  return createFormatter({ locale, timeZone: "UTC", formats: timeFormats });
}

describe("a time of day says which clock it is in", () => {
  it("names UTC in English, with the date for a moment and alone for a time", () => {
    const moment = formatter("en").dateTime(INSTANT, "moment");
    expect(moment).toContain("Sep 27, 2026");
    expect(moment).toMatch(/3:45\sPM UTC$/);
    expect(formatter("en").dateTime(INSTANT, "time")).toMatch(/^3:45\sPM UTC$/);
  });

  it("names UTC in Tamil too", () => {
    expect(formatter("ta").dateTime(INSTANT, "moment")).toContain("UTC");
    expect(formatter("ta").dateTime(INSTANT, "time")).toContain("UTC");
  });

  it("reaches client components through the provider, not only the server", () => {
    function Stamp() {
      return createElement("span", null, useFormatter().dateTime(INSTANT, "moment"));
    }
    const html = renderToStaticMarkup(
      createElement(IntlProvider, { locale: "ta", timeZone: "UTC", messages: ta }, createElement(Stamp)),
    );
    expect(html).toContain("UTC");
    expect(html).toContain("2026");
  });

  it("names the zone of a reader who is not in UTC", () => {
    const local = createFormatter({ locale: "en", timeZone: "Asia/Kolkata", formats: timeFormats });
    expect(local.dateTime(INSTANT, "time")).toMatch(/^9:15\sPM GMT\+5:30$/);
  });
});

function renderHeader(locale: string, messages: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      { locale, timeZone: "UTC", messages },
      createElement(PhoneHeader, { brand: "Moolam" }),
    ),
  );
}

/** Each theme button's opening tag, what it holds, and that with every tag stripped. */
function themeButtons(html: string): { tag: string; inner: string; text: string }[] {
  const found = [...html.matchAll(/<button([^>]*aria-label="[^"]*"[^>]*)>([\s\S]*?)<\/button>/g)];
  return found.map((match) => ({ tag: match[1], inner: match[2], text: match[2].replace(/<[^>]*>/g, "").trim() }));
}

describe("the phone's theme control", () => {
  for (const [locale, messages] of [
    ["en", en],
    ["ta", ta],
  ] as const) {
    it(`is a mark named by the whole label in ${locale}, with no words drawn`, () => {
      const html = renderHeader(locale, messages);
      const buttons = themeButtons(html);
      expect(buttons).toHaveLength(2);

      const [dark, light] = buttons;
      expect(dark.tag).toContain(`aria-label="${messages.header.themeDarkAction}"`);
      expect(dark.tag).toContain(`title="${messages.header.themeDarkAction}"`);
      expect(light.tag).toContain(`aria-label="${messages.header.themeLightAction}"`);
      expect(light.tag).toContain(`title="${messages.header.themeLightAction}"`);

      for (const button of buttons) {
        expect(button.text).toBe("");
        expect(button.inner).toContain("<svg");
      }
      expect(html).not.toContain(`>${messages.header.themeDark}<`);
      expect(html).not.toContain(`>${messages.header.themeLight}<`);
    });
  }

  it("draws a moon under the dark theme and a sun under the light one", () => {
    const [dark, light] = themeButtons(renderHeader("en", en));
    expect(dark.tag).toContain("hidden dark:grid");
    expect(dark.inner).toContain("<path");
    expect(light.tag).toContain("grid dark:hidden");
    expect(light.inner).toContain("<rect");
  });

  it("gives the 30 px square a 44 px pad", () => {
    const [dark] = themeButtons(renderHeader("en", en));
    expect(dark.tag).toContain("h-[30px] w-[30px]");
    expect(dark.tag).toContain("after:-inset-[7px]");
  });

  it("keeps the language chip's visible name", () => {
    expect(renderHeader("ta", ta)).toContain(">English</button>");
  });
});
