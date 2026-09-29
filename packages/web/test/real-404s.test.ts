import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { NextRequest } from "next/server";
import en from "@/messages/en.json";

/**
 * A mistyped address and a malformed passport or agent id answer 404, which a
 * loading screen over every page under a language had turned into a 200 with a
 * noindex tag, while every press that waits on its page still shows one.
 */

vi.mock("@/lib/i18n/routing", () => ({
  routing: { locales: ["en", "ta"], defaultLocale: "en" },
  localeLabels: { en: "English", ta: "தமிழ்" },
  usePathname: () => "/",
  useRouter: () => ({ replace: () => undefined }),
  Link: (props: { href: string; children?: ReactNode }) => createElement("a", { href: props.href }, props.children),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ locale: "en" }) }));

const { default: proxy, idPageTarget, config } = await import("@/proxy");

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    children?: ReactNode;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

describe("no loading screen over the language as a whole", () => {
  it("has no app/[locale]/loading.tsx, so the catch-all's not-found still sets the status", () => {
    expect(existsSync(fileURLToPath(new URL("../app/[locale]/loading.tsx", import.meta.url)))).toBe(false);
    expect(existsSync(fileURLToPath(new URL("../components/shell/Opening.tsx", import.meta.url)))).toBe(true);
  });

  it("gives each of the seven pages that wait on a press the shared screen, in that page's shape", async () => {
    const loaders: Array<[string, string, () => Promise<{ default: FunctionComponent }>]> = [
      ["passport", "poster", () => import("@/app/[locale]/passport/[id]/loading")],
      ["agent", "agent", () => import("@/app/[locale]/agent/[id]/loading")],
      ["studio", "page", () => import("@/app/[locale]/studio/loading")],
      ["mine", "page", () => import("@/app/[locale]/mine/loading")],
      ["explore view", "explore", () => import("@/app/[locale]/explore/view/loading")],
      ["agents", "page", () => import("@/app/[locale]/agents/loading")],
      ["resolve", "page", () => import("@/app/[locale]/resolve/loading")],
    ];
    const { default: Opening } = (await import("@/components/shell/Opening")) as {
      default: FunctionComponent<{ frame?: string }>;
    };
    for (const [route, frame, load] of loaders) {
      const { default: Loading } = await load();
      const markup = render(createElement(Loading));
      expect(markup, route).toBe(render(createElement(Opening, { frame })));
      expect(markup, route).toContain(`data-opening="${frame}"`);
      expect(markup, route).toContain(en.common.openingPage);
    }
  });
});

describe("the door in front of the passport and agent pages", () => {
  const passport = `0x${"ab12".repeat(16)}`;

  it("turns a malformed id aside to an unclaimed address under the same language", () => {
    for (const id of ["banana", "0x123", "12ab", "1".repeat(21)]) {
      expect(idPageTarget(`/en/passport/${id}`), id).toBe("/en/no-such-passport");
    }
    for (const id of ["banana", "0x123", "12ab", "1".repeat(21), passport]) {
      expect(idPageTarget(`/ta/agent/${id}`), id).toBe("/ta/no-such-agent");
    }
    expect(idPageTarget("/en/passport/10249")).toBe("/en/no-such-passport");
  });

  it("hands a well-formed id back untouched, in any case the page itself accepts", () => {
    expect(idPageTarget(`/en/passport/${passport}`)).toBe(`/en/passport/${passport}`);
    const shouted = `0x${"AB12".repeat(16)}`;
    expect(idPageTarget(`/en/passport/${shouted}`)).toBe(`/en/passport/${shouted}`);
    expect(idPageTarget("/en/agent/10249")).toBe("/en/agent/10249");
    expect(idPageTarget(`/en/agent/${"9".repeat(20)}`)).toBe(`/en/agent/${"9".repeat(20)}`);
  });

  it("claims no other address, so Explore keeps its own rule", () => {
    expect(idPageTarget("/en/explore")).toBeNull();
    expect(idPageTarget("/en/explore/view")).toBeNull();
    expect(idPageTarget("/en/agents")).toBeNull();
    expect(idPageTarget(`/en/passport/${passport}/opengraph-image`)).toBeNull();
  });

  it("rewrites a malformed id to the 404 and lets a well-formed one through, uncounted and unchanged", () => {
    const rewrite = (path: string) =>
      proxy(new NextRequest(new URL(path, "https://moolam.xyz"))).headers.get("x-middleware-rewrite");
    expect(rewrite("/en/passport/banana")).toBe("https://moolam.xyz/en/no-such-passport");
    expect(rewrite("/en/agent/12ab")).toBe("https://moolam.xyz/en/no-such-agent");
    expect(rewrite(`/en/passport/${passport}`)).toBeNull();
    expect(rewrite("/en/agent/10249")).toBeNull();
    // A query on a passport address is not an Explore query, so it never reaches the Explore view.
    expect(rewrite(`/en/passport/${passport}?q=x&view=test`)).toBeNull();
  });

  it("still watches both Explore addresses", () => {
    expect(config.matcher).toEqual(
      expect.arrayContaining(["/:locale/explore", "/:locale/explore/view", "/:locale/passport/:id", "/:locale/agent/:id"]),
    );
  });
});
