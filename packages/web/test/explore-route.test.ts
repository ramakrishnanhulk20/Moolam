import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  DEFAULT_SEARCH,
  EXPLORE_KEYS,
  EXPLORE_VIEWS,
  exploreHref,
  narrowsExplore,
  readExploreSearch,
} from "@/components/explore/query";

/**
 * Which of the two Explore routes an address lands on.
 *
 * The view a bare address opens on is a page the build makes and the host keeps
 * for a minute. Everything narrower is drawn on the request by a sibling route,
 * and the rule in proxy.ts is the only thing that sends an address there. So
 * these hold three joins: the keys the rule watches are the keys the page reads,
 * every link the chips write still lands on a route that can draw it, and a read
 * that failed is never left in the page the host keeps.
 */

const holds = vi.hoisted(() => ({
  sheetPage: vi.fn(),
  counts: vi.fn(),
  split: vi.fn(),
  connection: vi.fn(),
}));

vi.mock("next/server", async (real) => ({
  ...(await real<typeof import("next/server")>()),
  connection: holds.connection,
}));

vi.mock("@/components/explore/plates", () => ({
  sheetPage: holds.sheetPage,
  heldPictureSplit: holds.split,
}));

vi.mock("@/lib/data/passports", () => ({ heldRegistryCounts: holds.counts }));

vi.mock("@/lib/chain/client", () => ({
  reason: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/components/explore/Filters", () => ({ Filters: () => null }));
vi.mock("@/components/explore/Grid", () => ({ Grid: () => null }));
vi.mock("@/components/explore/Masthead", () => ({ Masthead: () => null }));

const { default: proxy } = await import("@/proxy");
const { ExploreSheet } = await import("@/components/explore/Sheet");

/** Where one address is drawn, given the rule in front of the route. */
function landsOn(address: string): string {
  const answer = proxy(new NextRequest(new URL(address, "https://moolam.xyz")));
  const rewritten = answer.headers.get("x-middleware-rewrite");
  return rewritten === null ? new URL(address, "https://moolam.xyz").pathname : new URL(rewritten).pathname;
}

describe("which route an Explore address lands on", () => {
  it("leaves a bare address on the page the build made", () => {
    expect(landsOn("/en/explore")).toBe("/en/explore");
    expect(landsOn("/ta/explore")).toBe("/ta/explore");
  });

  it("sends every key the page reads to the route that draws it on the request", () => {
    expect(landsOn("/en/explore?view=test")).toBe("/en/explore/view");
    expect(landsOn("/en/explore?q=0xab")).toBe("/en/explore/view");
    expect(landsOn("/en/explore?agent=10248")).toBe("/en/explore/view");
    expect(landsOn("/ja/explore?view=edits&q=0x1a&agent=10248")).toBe("/ja/explore/view");
  });

  it("sends a chip this build no longer has to the request route too, which answers with the view it implies", () => {
    expect(landsOn("/en/explore?view=cards")).toBe("/en/explore/view");
    expect(readExploreSearch({ view: "cards" })).toEqual(DEFAULT_SEARCH);
  });

  it("leaves an address whose keys the page never reads on the built page", () => {
    expect(landsOn("/en/explore?utm_source=x&ref=post")).toBe("/en/explore");
    expect(narrowsExplore(new URLSearchParams("fbclid=1"))).toBe(false);
  });

  it("keeps the address the reader can see, so a shared link is the one they copied", () => {
    const answer = proxy(new NextRequest(new URL("https://moolam.xyz/en/explore?view=test")));
    expect(answer.headers.get("x-middleware-rewrite")).toBe("https://moolam.xyz/en/explore/view?view=test");
    expect(answer.status).toBe(200);
  });

  it("watches exactly the keys the reader reads out of the address, and no others", () => {
    for (const key of EXPLORE_KEYS) {
      expect(narrowsExplore(new URLSearchParams(`${key}=x`)), key).toBe(true);
    }
    expect([...EXPLORE_KEYS].sort()).toEqual(["agent", "q", "view"]);
  });
});

describe("the links the chips and the search box write", () => {
  it("lands every chip on a route that can draw what it asks for", () => {
    for (const view of EXPLORE_VIEWS) {
      const href = exploreHref({ view, search: "", agent: null });
      const narrowed = href !== "/explore";
      expect(landsOn(`/en${href}`), href).toBe(narrowed ? "/en/explore/view" : "/en/explore");
    }
  });

  it("lands a search and an agent link on the request route", () => {
    expect(landsOn(`/en${exploreHref({ view: "all", search: "0x1a", agent: null })}`)).toBe("/en/explore/view");
    expect(landsOn(`/en${exploreHref({ view: "all", search: "", agent: "10248" })}`)).toBe("/en/explore/view");
  });

  it("sends the chip the page opens on back to the built page", () => {
    expect(exploreHref(DEFAULT_SEARCH)).toBe("/explore");
    expect(landsOn("/en/explore")).toBe("/en/explore");
  });
});

describe("a sheet that could not be read", () => {
  beforeEach(() => {
    holds.connection.mockReset().mockResolvedValue(undefined);
    holds.sheetPage.mockReset().mockResolvedValue({ plates: [], cursor: null });
    holds.counts.mockReset().mockResolvedValue({ total: 36, generated: 30, rechecked: 4, capped: false });
    holds.split.mockReset().mockResolvedValue({ real: 14, test: 22, scanned: 36, capped: false });
  });

  it("is never left in the page the host keeps", async () => {
    holds.sheetPage.mockRejectedValue(new Error("the Envio endpoint answered 502"));

    await ExploreSheet({ locale: "en", search: DEFAULT_SEARCH, stored: true });

    expect(holds.connection).toHaveBeenCalledTimes(1);
  });

  it("costs the request route nothing, because nothing it draws is kept", async () => {
    holds.sheetPage.mockRejectedValue(new Error("the Envio endpoint answered 502"));

    await ExploreSheet({ locale: "en", search: { view: "test", search: "", agent: null }, stored: false });

    expect(holds.connection).not.toHaveBeenCalled();
  });

  it("is never kept with its counts unread either, since the page would print a failure for a minute", async () => {
    holds.counts.mockRejectedValue(new Error("the Envio endpoint answered 502"));

    await ExploreSheet({ locale: "en", search: DEFAULT_SEARCH, stored: true });

    expect(holds.connection).toHaveBeenCalledTimes(1);
  });

  it("keeps a page that is only missing the split line, which says nothing wrong by being absent", async () => {
    holds.split.mockRejectedValue(new Error("the Envio endpoint answered 502"));

    await ExploreSheet({ locale: "en", search: DEFAULT_SEARCH, stored: true });

    expect(holds.connection).not.toHaveBeenCalled();
  });

  it("keeps a page whose every read came back", async () => {
    await ExploreSheet({ locale: "en", search: DEFAULT_SEARCH, stored: true });

    expect(holds.connection).not.toHaveBeenCalled();
  });

  it("asks the index for the view it was handed, on either route", async () => {
    await ExploreSheet({ locale: "en", search: DEFAULT_SEARCH, stored: true });
    expect(holds.sheetPage).toHaveBeenCalledWith(DEFAULT_SEARCH);

    const narrowed = { view: "edits" as const, search: "0x1a", agent: "10248" };
    await ExploreSheet({ locale: "ta", search: narrowed, stored: false });
    expect(holds.sheetPage).toHaveBeenLastCalledWith(narrowed);
  });
});
