import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createFormatter, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import { timeFormats } from "@/lib/i18n/timeFormats";
import type { Art } from "@/components/passport/art";
import type { Passport } from "@/lib/chain/registry";
import type { UnsealResponse } from "@/lib/verifier/client";

/**
 * The loose ends the review fixes left (WO-233): one helper for cutting
 * a reason out of a sentence, tested in all ten languages; every stored address
 * held to the pinned-file rule before a page draws it or links to it; the agent
 * card fetch refusing addresses that point back into Moolam's own network; the
 * resolver desk's failure line with its mark and folded details; the sealed
 * file's unsaved warning with its mark; and a document that was read with no
 * fields called read, through the cache as well as without it.
 *
 * What this does not cover: a real gateway, a real browser, or a card host
 * whose name resolves to a private address, which the fetch does not check.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: en, namespace }),
  getFormatter: async () => createFormatter({ locale: "en", timeZone: "UTC", formats: timeFormats }),
  setRequestLocale: () => undefined,
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  useParams: () => ({ locale: "en" }),
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: (props: { sources: string[] }) => createElement("span", { "data-picture": props.sources[0] }),
}));

vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));
vi.mock("@/components/mark/read", async () => (await import("./mark-fixtures")).markReadMock);

// The cache keeps its answer as JSON, so the stand-in does too: a key whose
// value is undefined is dropped on the way through, as it is in Next.
vi.mock("next/cache", async (original) => ({
  ...(await original<typeof import("next/cache")>()),
  unstable_cache:
    <A extends unknown[], R>(read: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> =>
      JSON.parse(JSON.stringify(await read(...args))) as R,
}));

const docs = vi.hoisted(() => ({ byUri: {} as Record<string, Art> }));
vi.mock("@/components/passport/art", async (original) => ({
  ...(await original<typeof import("@/components/passport/art")>()),
  readArt: async (uri: string) => docs.byUri[uri] ?? { missing: true },
}));

const unseal = vi.hoisted(() => ({ result: null as unknown }));
vi.mock("@/lib/passport/unseal", () => ({
  useUnsealPassport: () => ({
    ready: true,
    isHolder: true,
    state: { result: unseal.result, kept: null, checking: false, sending: false, quota: null, failure: null },
    actions: { choose: async () => undefined, publish: async () => undefined, signIn: () => undefined, reset: () => undefined },
  }),
  isUnsealBusy: () => false,
  isUnsealDone: () => true,
}));

vi.mock("@/lib/disputes/useResolveDisputes", () => ({ useResolveDisputes: () => null }));

const { withoutReason } = await import("@/lib/i18n/reason");
const { Unsealer } = await import("@/components/passport/Unsealer");
const { Facts } = await import("@/components/passport/Facts");
const { Signing } = await import("@/components/agent/Signing");
const { cardUrl, readAgentCard, CARD_MAX_BYTES } = await import("@/lib/chain/agents");
const { ResolveConsole } = await import("@/components/resolve/ResolveConsole");
const { SealedFileCard } = await import("@/components/studio/SealedFile");
const { heldArt } = await import("@/lib/data/passports");
const { recordUnread } = await import("@/components/passport/unread");

const TRACKER = "https://tracker.example/x";
const LOCALES = ["en", "ta", "hi", "zh", "ja", "ko", "es", "fr", "de", "pt"] as const;
const REASON_KEYS = [
  "explore.countsError",
  "explore.error",
  "agents.error",
  "verify.error",
  "agent.reputation.error",
  "agent.index.error",
  "studio.passkey.unreadable",
  "recheck.failed",
] as const;
/** The first shape of the warning mark's octagon, which only WarningMark draws. */
const MARK = 'points="4.6,1 9.4,1 13,4.6 13,9.4 9.4,13 4.6,13 1,9.4 1,4.6"';

function messagesOf(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")) as Record<string, unknown>;
}

function raw(messages: Record<string, unknown>, key: string): string {
  const value = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages);
  return value as string;
}

function inEnglish(node: ReactNode): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    formats: unknown;
  }>;
  return renderToStaticMarkup(
    createElement(Provider, { locale: "en", messages: en, timeZone: "UTC", formats: timeFormats }, node as never),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  docs.byUri = {};
  unseal.result = null;
});

describe("step 3: the reason cut in every language", () => {
  for (const locale of LOCALES) {
    it(`leaves a whole sentence in ${locale} for every message that carries a reason`, () => {
      const messages = messagesOf(locale);
      const t = createTranslator({ locale, messages });
      for (const key of REASON_KEYS) {
        const source = raw(messages, key);
        const label = `${locale} ${key}`;
        // The reason closes a clause after a colon, so cutting it with its colon
        // leaves a sentence. A translation that moves it anywhere else fails here.
        expect(source, label).toMatch(/[:：]\s?\{reason\}(?:[.。।]|$)/u);

        const cut = withoutReason((reason) => t(key as never, { reason }));
        expect(cut, label).not.toContain("");
        expect(cut, label).not.toMatch(/[{}]/);
        expect(cut, label).not.toMatch(/\(\s*\)|（\s*）|\[\s*\]|「\s*」/u);
        expect(cut, label).not.toMatch(/[.,:;。।：，]\s*[.,:;。।：，]/u);
        expect(cut, label).not.toMatch(/\s[.,。।]/u);
        expect(cut, label).not.toMatch(/[:,;：，]\s*$/u);
        expect(cut.trim(), label).toBe(cut);
        expect(cut, label).toBe(source.replace(/\s*[:：]\s?\{reason\}/u, ""));
      }
    });
  }
});

describe("step 4: a stored address that is not a pinned file draws and links nothing", () => {
  function pinned(uri: string, cid: string) {
    return { cid, uri, gatewayUrl: uri };
  }
  function receipt(image: string, record: string): UnsealResponse {
    return {
      passportId: `0x${"be".repeat(32)}` as Hex,
      image: pinned(image, "bafkreiimage"),
      thumbnail: pinned(image, "bafkreithumb"),
      record: pinned(record, "bafkreirecord"),
      unsealedBy: `0x${"a7".repeat(20)}` as Hex,
      unsealedAt: "2026-09-28T10:00:00.000Z",
    } as unknown as UnsealResponse;
  }
  const drawUnsealer = () =>
    inEnglish(createElement(Unsealer, { passportId: `0x${"be".repeat(32)}` as Hex, owner: `0x${"a7".repeat(20)}` as Hex }));

  it("Unsealer: the picture and the address links", () => {
    unseal.result = receipt(TRACKER, TRACKER);
    const refused = drawUnsealer();
    expect(refused).toContain("data-unseal-receipt");
    expect(refused).not.toContain("data-picture");
    expect(refused).not.toContain("tracker.example");

    unseal.result = receipt("ipfs://bafkreiimage", "ipfs://bafkreirecord");
    const kept = drawUnsealer();
    expect(kept).toMatch(/data-picture="[^"]*bafkreiimage"/);
    expect(kept).toMatch(/href="[^"]*bafkreirecord"/);
  });

  const passport = (metadataURI: string): Passport => ({
    id: `0x${"c4".repeat(32)}` as Hex,
    exactHash: `0x${"c5".repeat(32)}` as Hex,
    parentId: `0x${"00".repeat(32)}` as Hex,
    creator: `0x${"a1".repeat(20)}` as Hex,
    generatorAgentId: 0n,
    phash: 0x1234n,
    blockhash256: `0x${"c6".repeat(32)}` as Hex,
    manifestHash: `0x${"00".repeat(32)}` as Hex,
    kind: 0,
    fingerprintVersion: 1,
    registeredAt: 1_790_000_000n,
    disputed: false,
    metadataURI,
  });
  const unsealedArt = (recordUri: string): Art => ({
    title: "Harbour",
    missing: false,
    unsealed: { at: "2026-09-28T10:00:00.000Z", by: `0x${"a7".repeat(20)}`, record: { cid: "bafkreirecord", uri: recordUri } },
  });
  const drawFacts = async (metadataURI: string, recordUri: string) =>
    inEnglish(
      await Facts({
        passport: passport(metadataURI),
        art: unsealedArt(recordUri),
        owner: null,
        hasPasskey: false,
        standing: "unverified",
        txHash: null,
      }),
    );

  it("Facts: the metadata link and the publish record link", async () => {
    const refused = await drawFacts(TRACKER, TRACKER);
    expect(refused).not.toMatch(/href="https:\/\/tracker\.example/);
    // The chain's own words are still shown, as text.
    expect(refused.replaceAll("<wbr/>", "")).toContain(TRACKER);

    const kept = await drawFacts("ipfs://bafkreimeta", "ipfs://bafkreirecord");
    expect(kept).toMatch(/href="[^"]*bafkreimeta"/);
    expect(kept).toMatch(/href="[^"]*bafkreirecord"/);
  });

  it("Signing: the agent card link", async () => {
    const draw = async (uri: string) =>
      renderToStaticMarkup(await Signing({ agentId: 7n, card: null, document: null, uri }));
    const refused = await draw(TRACKER);
    expect(refused).not.toMatch(/href="https:\/\/tracker\.example/);
    expect(refused.replaceAll("<wbr/>", "")).toContain(TRACKER);
    expect(await draw("ipfs://bafkreicard")).toMatch(/href="[^"]*bafkreicard"/);
  });
});

describe("step 5: the agent card fetch", () => {
  it("accepts ipfs through the gateway and https to a named host, and nothing else", () => {
    expect(cardUrl("ipfs://bafkreicard")?.protocol).toBe("https:");
    expect(cardUrl("ipfs://bafkreicard")?.href).toContain("bafkreicard");
    expect(cardUrl("https://agents.example/card.json")?.href).toBe("https://agents.example/card.json");

    for (const refused of [
      "http://agents.example/card.json",
      "https://127.0.0.1/card.json",
      "https://10.0.0.8/card.json",
      "https://2130706433/card.json",
      "https://0x7f.1/card.json",
      "https://[::1]/card.json",
      "https://localhost/card.json",
      "https://localhost./card.json",
      "https://api.localhost/card.json",
      "https://user:secret@agents.example/card.json",
      "ftp://agents.example/card.json",
      "file:///etc/passwd",
      "not an address",
    ]) {
      expect(cardUrl(refused), refused).toBeNull();
    }
  });

  it("never fetches a refused address, and reads an https card and a data card", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: URL | string) => {
      fetched.push(String(url));
      return new Response(JSON.stringify({ name: "Kural" }), { status: 200 });
    });

    for (const refused of ["http://agents.example/card.json", "https://127.0.0.1/card.json", "https://localhost/card.json"]) {
      expect(await readAgentCard(refused), refused).toBeNull();
    }
    expect(fetched).toEqual([]);

    expect(await readAgentCard("https://agents.example/card.json")).toEqual({ name: "Kural" });
    expect(fetched).toEqual(["https://agents.example/card.json"]);

    const inline = `data:application/json;base64,${Buffer.from(JSON.stringify({ name: "Inline" })).toString("base64")}`;
    expect(await readAgentCard(inline)).toEqual({ name: "Inline" });
  });

  it("holds every redirect to the same rule, and refuses a card past the size cap", async () => {
    const fetched: string[] = [];
    const answers: Record<string, () => Response> = {
      "https://agents.example/inward": () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/card" } }),
      "https://agents.example/moved": () => new Response(null, { status: 301, headers: { location: "https://cards.example/k" } }),
      "https://cards.example/k": () => new Response(JSON.stringify({ name: "Moved" }), { status: 200 }),
      "https://agents.example/huge": () =>
        new Response(JSON.stringify({ name: "x".repeat(CARD_MAX_BYTES + 10) }), { status: 200 }),
      "https://agents.example/declared": () =>
        new Response("{}", { status: 200, headers: { "content-length": String(CARD_MAX_BYTES + 1) } }),
    };
    vi.stubGlobal("fetch", async (url: URL | string, init?: RequestInit) => {
      fetched.push(String(url));
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return answers[String(url)]();
    });

    expect(await readAgentCard("https://agents.example/inward")).toBeNull();
    expect(fetched).toEqual(["https://agents.example/inward"]);

    expect(await readAgentCard("https://agents.example/moved")).toEqual({ name: "Moved" });
    expect(await readAgentCard("https://agents.example/huge")).toBeNull();
    expect(await readAgentCard("https://agents.example/declared")).toBeNull();
  });
});

describe("steps 6 and 7: failure lines carry the mark", () => {
  it("the resolver desk says the list is unavailable, with the raw error only folded and cleaned", () => {
    const listError = "HTTP request failed.\n\nURL: https://indexer.example/v1/graphql\nRequest body: {}";
    const html = inEnglish(
      createElement(ResolveConsole, { resolver: `0x${"55".repeat(20)}` as Hex, disputes: [], listError }),
    );
    const unread = html.slice(html.indexOf("data-queue-unread"));
    const sentence = unread.slice(0, unread.indexOf("<details"));
    expect(sentence).toContain(MARK);
    expect(sentence).toContain(en.resolve.unavailable);
    expect(sentence).not.toContain("HTTP request failed");

    const details = unread.slice(unread.indexOf("<details"), unread.indexOf("</details>"));
    expect(details).toContain("data-failure-details");
    expect(details).toContain("HTTP request failed.");
    expect(html).not.toContain("indexer.example");
  });

  it("the sealed file's unsaved warning carries the mark, and a saved one does not", () => {
    const file = {
      name: "harbour.png",
      type: "image/png",
      blob: new Blob([]),
      sha256: `0x${"ab".repeat(32)}` as Hex,
      size: 1_200_000,
    };
    const draw = (saved: boolean) => {
      const html = inEnglish(createElement(SealedFileCard, { file, bits: null, title: "Harbour", saved, onSaved: () => undefined }));
      const at = html.indexOf("data-only-copy");
      return html.slice(at, html.indexOf("</p>", at));
    };
    expect(draw(false)).toContain(MARK);
    expect(draw(false)).toContain("text-failed");
    expect(draw(true)).not.toContain(MARK);
  });
});

describe("step 8: the still story", () => {
  it("keeps no branch for a copy nobody measured", () => {
    const source = readFileSync("components/story/StillStory.tsx", "utf8");
    expect(source).not.toContain("notMatched");
    expect(source).not.toContain("whole width apart");
  });
});

describe("step 10: a document that was read and holds no fields", () => {
  it("is a read record with no picture, through the cache", async () => {
    docs.byUri["ipfs://bafkreiempty"] = {
      title: undefined,
      description: undefined,
      prompt: undefined,
      imageUrl: undefined,
      thumbnailUrl: undefined,
      missing: true,
    };
    const art = await heldArt("ipfs://bafkreiempty");
    expect(art.thumbnailUrl).toBeUndefined();
    expect(art.imageUrl).toBeUndefined();
    expect(recordUnread(art)).toBe(false);
  });

  it("is still unread when no gateway handed a document over", async () => {
    const art = await heldArt("ipfs://bafkreisilent");
    expect(art).toEqual({ missing: true });
    expect(recordUnread(art)).toBe(true);
  });
});
