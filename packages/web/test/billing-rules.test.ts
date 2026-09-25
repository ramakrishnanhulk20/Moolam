import { describe, expect, it } from "vitest";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import fr from "@/messages/fr.json";
import { Billing } from "@/components/home/Billing";

/**
 * The sponsor line never opens a row with a stray rule.
 *
 * In French at 1440 the fourth name wraps, and it used to take its rule with
 * it to the start of the new row. Each rule now rides in front of its own name
 * and the row is pulled left, into a clipped edge, by exactly one rule and its
 * gap: 1 px and gap-3, so -13 px. Measured in the browser on 2026-09-25, the
 * rule was hidden at the start of every row and shown everywhere else in en,
 * fr, pt and ta at 1440 and 375.
 */
describe("the sponsor line's rules", () => {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    children: ReactNode;
  }>;
  const html = renderToStaticMarkup(
    createElement(Provider, { locale: "fr", messages: fr, timeZone: "Asia/Kolkata" }, createElement(Billing)),
  );

  it("gives every name its own rule, in front of it", () => {
    const credits = html.match(/<span data-credit="true"[^>]*><span aria-hidden="true" class="h-2\.5 w-px/g);
    expect(credits).toHaveLength(4);
  });

  it("clips the line and pulls the row left by one rule and its gap", () => {
    expect(html).toMatch(/<p data-first-billing="true" class="overflow-hidden /);
    expect(html).toMatch(/<span class="-ms-\[13px\] flex flex-wrap items-center gap-x-3 /);
  });
});
