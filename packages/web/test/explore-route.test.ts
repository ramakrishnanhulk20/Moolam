import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  AI_VIEWS,
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
vi.mock("@/components/explore/Stated", () => ({ StatedLine: () => null }));

const { default: proxy } = await import("@/proxy");
const { ExploreSheet } = await import("@/components/explore/Sheet");
const { PER_MINUTE, forgetCallers } = await import("@/lib/api/limit");

// The counters behind the rule are this process's memory, so one test's flood
// would otherwise be the next test's refusal.
beforeEach(() => {
  forgetCallers();
});

/** One request through the rule, from a named caller. */
function through(address: string, from?: string) {
  const request = new NextRequest(new URL(address, "https://moolam.xyz"));
  if (from !== undefined) {
    request.headers.set("x-vercel-forwarded-for", from);
  }
  return proxy(request);
}

/** Where one address is drawn, given the rule in front of the route. */
function landsOn(address: string): string {
  const rewritten = through(address).headers.get("x-middleware-rewrite");
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
    expect(landsOn("/en/explore?ai=open")).toBe("/en/explore/view");
    expect(landsOn("/ta/explore?ai=none&view=test")).toBe("/ta/explore/view");
  });

  it("sends an AI-use address to the narrowed route with its answer still on it", () => {
    const answer = proxy(new NextRequest(new URL("https://moolam.xyz/en/explore?ai=closed")));
    expect(answer.headers.get("x-middleware-rewrite")).toBe("https://moolam.xyz/en/explore/view?ai=closed");
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
    expect([...EXPLORE_KEYS].sort()).toEqual(["agent", "ai", "q", "view"]);
  });

  it("drops the keys the page cannot read, so a campaign tag is not a sheet of its own", () => {
    const answer = through("/en/explore?view=test&utm_source=x&fbclid=1&ref=post");

    expect(answer.headers.get("x-middleware-rewrite")).toBe("https://moolam.xyz/en/explore/view?view=test");
  });

  it("keeps every key the page does read, in the order the link carried them", () => {
    const answer = through("/ja/explore?view=edits&q=0x1a&agent=10248&ai=open&gclid=9");

    expect(answer.headers.get("x-middleware-rewrite")).toBe(
      "https://moolam.xyz/ja/explore/view?view=edits&q=0x1a&agent=10248&ai=open",
    );
  });
});

describe("what one caller may ask the narrowed route for", () => {
  it("draws sixty narrowed sheets a minute and refuses the sixty first in words a reader can read", () => {
    for (let at = 0; at < PER_MINUTE; at += 1) {
      expect(through("/en/explore?q=0x1a", "203.0.113.7").headers.get("x-middleware-rewrite"), `ask ${at + 1}`).toBe(
        "https://moolam.xyz/en/explore/view?q=0x1a",
      );
    }

    const refused = through("/en/explore?q=0x1a", "203.0.113.7");

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(refused.headers.get("content-type")).toContain("text/html");
    expect(refused.headers.get("x-middleware-rewrite")).toBe(null);
  });

  it("never counts the bare page, which the build made and nobody pays for twice", () => {
    for (let at = 0; at < PER_MINUTE * 2; at += 1) {
      expect(through("/en/explore", "203.0.113.7").headers.get("x-middleware-rewrite"), `ask ${at + 1}`).toBe(null);
    }

    expect(through("/en/explore?q=0x1a", "203.0.113.7").headers.get("x-middleware-rewrite")).toBe(
      "https://moolam.xyz/en/explore/view?q=0x1a",
    );
  });

  it("keeps one caller's flood off another caller", () => {
    for (let at = 0; at < PER_MINUTE + 5; at += 1) {
      through("/en/explore?q=0x1a", "203.0.113.7");
    }

    expect(through("/en/explore?q=0x1a", "198.51.100.42").headers.get("x-middleware-rewrite")).toBe(
      "https://moolam.xyz/en/explore/view?q=0x1a",
    );
  });
});

describe("the links the chips and the search box write", () => {
  it("lands every chip on a route that can draw what it asks for", () => {
    for (const view of EXPLORE_VIEWS) {
      const href = exploreHref({ view, search: "", agent: null, ai: null });
      const narrowed = href !== "/explore";
      expect(landsOn(`/en${href}`), href).toBe(narrowed ? "/en/explore/view" : "/en/explore");
    }
  });

  it("lands every AI-use chip on the route that draws it on the request", () => {
    for (const ai of AI_VIEWS) {
      const href = exploreHref({ view: "all", search: "", agent: null, ai });
      expect(landsOn(`/en${href}`), href).toBe("/en/explore/view");
    }
  });

  it("lands a search and an agent link on the request route", () => {
    expect(landsOn(`/en${exploreHref({ view: "all", search: "0x1a", agent: null, ai: null })}`)).toBe("/en/explore/view");
    expect(landsOn(`/en${exploreHref({ view: "all", search: "", agent: "10248", ai: null })}`)).toBe("/en/explore/view");
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

    await ExploreSheet({ locale: "en", search: { view: "test", search: "", agent: null, ai: null }, stored: false });

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

    const narrowed = { view: "edits" as const, search: "0x1a", agent: "10248", ai: null };
    await ExploreSheet({ locale: "ta", search: narrowed, stored: false });
    expect(holds.sheetPage).toHaveBeenLastCalledWith(narrowed);
  });
});
