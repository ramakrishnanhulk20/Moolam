import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";

/**
 * The home page's first screen with Monad's endpoint dead.
 *
 * The registry and the consent register are read for real, through the app's
 * own chain client, pointed at a port nothing listens on. What the screen may
 * say is then held to the rule: no status mark stands for a read that failed,
 * and the failed read is said in words on the same screen.
 *
 * The index, the gateway and the verify service are stood in for, so the test
 * spends nothing of the shared index allowance and needs no network at all.
 */

const stub = vi.hoisted(() => ({
  art: vi.fn(),
  index: vi.fn(),
}));

vi.mock("next/cache", () => ({ unstable_cache: (read: (...args: unknown[]) => unknown) => read }));
vi.mock("@/lib/data/passports", () => ({ heldArt: stub.art, askIndex: stub.index }));
vi.mock("@/lib/data/offeredSamples", () => ({ offeredSamples: async () => ({ samples: [], error: null }) }));
vi.mock("@/lib/verifier/client", () => ({
  verify: async () => {
    throw new Error("the verify service is not part of this test");
  },
}));
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) => createElement("a", { href: props.href }, props.children as never),
}));
vi.mock("@/components/passport/Picture", () => ({
  Picture: (props: { alt?: string }) => createElement("span", { "data-picture": props.alt ?? "" }),
}));
vi.mock("@/components/verify/AnswerCard", () => ({ AnswerCard: () => null }));

const TITLE = "Monsoon Fishing Nets Drying";
const THUMB = "https://gateway.example/ipfs/thumb";
const LIVE = en.home.first.live;
const UNREAD = en.home.first.unread;

type Modules = {
  read: typeof import("@/components/home/read");
  board: typeof import("@/components/home/Board");
};
let modules: Modules;

beforeAll(async () => {
  // Read once, when the chain client is built, so they are set before any import of it.
  vi.stubEnv("MONAD_RPC_URL", "");
  vi.stubEnv("NEXT_PUBLIC_MONAD_RPC_URL", "http://127.0.0.1:9");
  // Monad's other public endpoints are the browser's backups, so every one of them is dead here too.
  const passThrough = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (/^https:\/\/rpc\d?\.monad\.xyz/.test(url)) throw new TypeError("fetch failed");
    return await passThrough(input, init);
  });
  modules = {
    read: await import("@/components/home/read"),
    board: await import("@/components/home/Board"),
  };
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function draw(data: Awaited<ReturnType<Modules["read"]["firstScreenData"]>>): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    children: ReactNode;
  }>;
  return renderToString(
    createElement(
      Provider,
      { locale: "en", messages: en, timeZone: "UTC" },
      createElement(modules.board.Board, { finding: data.finding, copy: data.copy, samples: data.samples, loose: data.loose }),
    ),
  );
}

describe("the first screen when Monad's endpoint does not answer", () => {
  it("says in words that the passport could not be read, and shows no live mark over what is left", async () => {
    stub.index.mockResolvedValue({ Passport: [{ metadataURI: "ipfs://doc" }] });
    stub.art.mockResolvedValue({ title: TITLE, thumbnailUrl: THUMB, missing: false });

    const data = await modules.read.firstScreenData();
    expect("failed" in data.finding).toBe(true);
    expect(data.loose).toMatchObject({ title: TITLE, thumbnail: THUMB, statement: null });

    const html = draw(data);
    expect(html).toContain("data-first-unread");
    expect(html).toContain(UNREAD);
    expect(html).not.toContain(LIVE);
    expect(html).not.toContain("animate-ping");
    // The picture that is left still shows, under the line that says why the rest does not.
    expect(html.indexOf("data-first-unread")).toBeLessThan(html.indexOf(`data-picture="${TITLE}"`));
    // The failed read's own reason travels with the line rather than being dropped.
    expect(html).toMatch(/data-reason="[^"]+"/);
  }, 60_000);

  it("still says so when not even the picture is left", async () => {
    stub.index.mockRejectedValue(new Error("the index is down too"));

    const data = await modules.read.firstScreenData();
    expect(data.loose).toBeNull();

    const html = draw(data);
    expect(html).toContain(UNREAD);
    expect(html).not.toContain(LIVE);
    expect(html).not.toContain("Exhibit");
    expect(html).toContain("data-first-billing");
  }, 60_000);
});

describe("the live mark over a finding that was read", () => {
  const finding = {
    id: `0x${"cd".repeat(32)}` as const,
    title: TITLE,
    picture: THUMB,
    thumbnail: THUMB,
    registeredAt: 1_788_881_666,
    phash: "7840506850305415717",
    recheck: null,
    statement: null,
    statementError: null,
  };

  it("stands only when the copy it names was read in the same render", () => {
    const without = draw({ finding: { read: finding }, copy: { failed: "not made" }, samples: [], loose: null });
    expect(without).not.toContain(LIVE);
    expect(without).not.toContain(UNREAD);

    const copy = {
      image: "data:image/jpeg;base64,AAAA",
      width: 360,
      height: 353,
      bytes: 4080,
      phash: "7840506850305415700",
      found: true,
      distance: 2,
      confidence: 0.6,
      measuredAt: 1_790_380_000_000,
    };
    const whole = draw({ finding: { read: finding }, copy: { read: copy }, samples: [], loose: null });
    expect(whole).toContain(LIVE);
  });
});
