import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import en from "@/messages/en.json";

/**
 * The first screen's copy on the live site, after the build.
 *
 * The home page is rebuilt in the background a minute at a time. If the host's
 * data cache does not carry the build's copy into the running site, the hold
 * is empty there, and the rebuild used to refuse to make it: the live page lost
 * its copy and its verdict a minute after deploy. Now the rebuild makes it,
 * once, and every rebuild after reads it.
 *
 * The hold is stood in for by a real one kept in memory under the same names
 * and arguments unstable_cache keys by, so what is tested is the decision the
 * page makes against an empty hold and then a full one.
 */

const stub = vi.hoisted(() => ({
  held: new Map<string, unknown>(),
  record: vi.fn(),
  consent: vi.fn(),
  art: vi.fn(),
  index: vi.fn(),
  offered: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("next/cache", () => ({
  unstable_cache:
    (read: (...args: unknown[]) => Promise<unknown>, names: string[] = []) =>
    async (...args: unknown[]) => {
      const key = JSON.stringify([names, args]);
      if (stub.held.has(key)) {
        return stub.held.get(key);
      }
      // A throw inside is not kept, as with the real hold.
      const value = await read(...args);
      stub.held.set(key, value);
      return value;
    },
}));
vi.mock("@/lib/chain/registry", () => ({ heldPassportRecord: stub.record }));
vi.mock("@/lib/chain/consent", () => ({ heldConsent: stub.consent, plainStatement: () => "closed" }));
vi.mock("@/lib/data/passports", () => ({ heldArt: stub.art, askIndex: stub.index }));
vi.mock("@/lib/data/offeredSamples", () => ({ offeredSamples: stub.offered }));
vi.mock("@/lib/verifier/client", async (importOriginal) => ({
  isMeasured: (await importOriginal<typeof import("@/lib/verifier/client")>()).isMeasured,
  verify: stub.verify,
}));
vi.mock("sharp", () => {
  const chain = {
    metadata: async () => ({ width: 512, height: 512 }),
    extract: () => chain,
    modulate: () => chain,
    resize: () => chain,
    jpeg: () => chain,
    toBuffer: async () => ({ data: Buffer.from([1, 2, 3, 4]), info: { width: 360, height: 353 } }),
  };
  return { default: () => chain };
});
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) => createElement("a", { href: props.href }, props.children as never),
}));
vi.mock("@/components/passport/Picture", () => ({
  Picture: (props: { alt?: string }) => createElement("span", { "data-picture": props.alt ?? "" }),
}));
vi.mock("@/components/verify/AnswerCard", () => ({ AnswerCard: () => null }));

const { addresses } = await import("@/lib/chain/client");
const { FINDING_ID } = await import("@/components/home/finding");
const { firstScreenData } = await import("@/components/home/read");
const { Board } = await import("@/components/home/Board");

const PHASH = 7840506850305415717n;
const COPY_PHASH = PHASH ^ 0b11111n;

let gatewayAsked = 0;

beforeEach(() => {
  stub.held.clear();
  gatewayAsked = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      gatewayAsked += 1;
      return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
    }),
  );
  stub.record.mockReset().mockResolvedValue({
    passport: { id: FINDING_ID, metadataURI: "ipfs://doc", registeredAt: 1_788_881_666n, phash: PHASH },
    attestations: [{ receiver: addresses.receiver as Hex, matched: true, distance: 0, at: 1_789_380_000n }],
  });
  stub.consent.mockReset().mockResolvedValue({ stated: false, entry: null });
  stub.art.mockReset().mockResolvedValue({ title: "Nets", thumbnailUrl: "https://gateway.example/ipfs/thumb" });
  stub.index.mockReset();
  stub.offered.mockReset().mockResolvedValue({ samples: [], error: null });
  stub.verify.mockReset().mockResolvedValue({
    result: { exact: null, best: { id: FINDING_ID, phashDistance: 5 }, confidence: 0.6, queried: { phash: COPY_PHASH.toString() } },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** One background rebuild of a home page on the running site: no build phase, production mode. */
async function rebuild() {
  vi.stubEnv("NEXT_PHASE", "");
  vi.stubEnv("NODE_ENV", "production");
  try {
    return await firstScreenData();
  } finally {
    vi.unstubAllEnvs();
  }
}

function draw(data: Awaited<ReturnType<typeof firstScreenData>>): string {
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
      createElement(Board, { finding: data.finding, copy: data.copy, samples: data.samples, loose: data.loose }),
    ),
  );
}

describe("a rebuild after launch that finds the copy's hold empty", () => {
  it("makes the copy once, then every later rebuild reads it from the hold", async () => {
    const first = await rebuild();
    expect(stub.verify).toHaveBeenCalledTimes(1);
    expect(gatewayAsked).toBe(1);
    expect(first.copy).toMatchObject({ read: { found: true, distance: 5 } });

    const second = await rebuild();
    const third = await rebuild();
    expect(stub.verify).toHaveBeenCalledTimes(1);
    expect(gatewayAsked).toBe(1);
    // The very same measurement, stamp and all, so it came out of the hold.
    expect(second.copy).toEqual(first.copy);
    expect(third.copy).toEqual(first.copy);

    const words = draw(second);
    expect(words).toContain("Exhibit B");
    expect(words).toContain("data-first-verdict");
  });

  it("shows the honest reduced finding when the making fails, keeps nothing, and makes it on a later rebuild", async () => {
    // A thumbnail of its own, so the making shared inside this process by the
    // test above is not what answers.
    stub.art.mockResolvedValue({ title: "Nets", thumbnailUrl: "https://gateway.example/ipfs/other-thumb" });
    stub.verify.mockRejectedValueOnce(new Error("the verify service answered 502"));

    const failed = await rebuild();
    expect(failed.copy).toEqual({ failed: "the verify service answered 502" });
    const reduced = draw(failed);
    expect(reduced).toContain("Exhibit A");
    expect(reduced).not.toContain("Exhibit B");
    expect(reduced).not.toContain("data-first-verdict");
    expect(reduced).not.toContain(en.home.first.live);

    const later = await rebuild();
    expect(later.copy).toMatchObject({ read: { distance: 5 } });
    await rebuild();
    expect(stub.verify).toHaveBeenCalledTimes(2);
  });

  it("never makes the copy in a browser", async () => {
    vi.stubGlobal("window", {});
    const data = await firstScreenData();
    expect(stub.verify).not.toHaveBeenCalled();
    expect(gatewayAsked).toBe(0);
    expect(data.copy).toEqual({ failed: "the copy is only made on the server" });
  });
});

describe("who can reach the copy's making", () => {
  const web = fileURLToPath(new URL("..", import.meta.url));

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        return sources(path);
      }
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  it("is only the home page itself, so no route handler a visitor calls can start it", () => {
    const importers = ["app", "components", "lib"]
      .flatMap((dir) => sources(join(web, dir)))
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        const home = relative(web, file).replace(/\\/g, "/").startsWith("components/home/");
        return /["']@\/components\/home\/read["']/.test(text) || (home && /from\s+["']\.\/read["']/.test(text));
      })
      .map((file) => relative(web, file).replace(/\\/g, "/"));

    expect(importers).toEqual(["app/[locale]/page.tsx"]);
  });
});
