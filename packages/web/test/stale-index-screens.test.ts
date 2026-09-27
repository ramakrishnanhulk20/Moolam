// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { RecheckControl } from "@/lib/recheck/useRecheck";

/**
 * The three screens outside the verify page that show a verify answer: the home page's drop, the
 * passport page's check of a copy, and the landing film's try panel. Each says, in the verify
 * card's own words (verify.staleIndex), that the service matched against a copy of the register it
 * called stale, beside a miss and beside a match, and says nothing when the copy is current. The
 * answers come from the real verify client and its schema with only fetch stubbed.
 *
 * Does NOT cover how the service decides the copy is stale (the verifier's stale-index and
 * index-freshness tests), the verify page's card itself (verify-stale-index.test.ts, which also
 * checks every language), or the layout at 375px in a browser.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom never finishes a framer-motion exit, so the passport check's "checking" face would hold the
// answer back for good. Motion elements render as their plain tags and presence swaps at once: what
// is under test is the words each face prints, not how it moves.
vi.mock("framer-motion", async (importOriginal) => {
  const real = await importOriginal<typeof import("framer-motion")>();
  const tags = new Map<string, unknown>();
  const plain = (tag: string) => {
    if (!tags.has(tag)) {
      tags.set(tag, ({ children, initial: _i, animate: _a, exit: _e, transition: _t, ...rest }: Record<string, unknown>) =>
        createElement(tag, rest, children as never),
      );
    }
    return tags.get(tag);
  };
  return {
    ...real,
    AnimatePresence: ({ children }: { children?: unknown }) => children,
    motion: new Proxy({}, { get: (_target, tag) => plain(String(tag)) }),
  };
});

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

vi.mock("next/navigation", () => ({ useParams: () => ({ locale: "en" }) }));

vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": "true" }),
}));

vi.mock("@/lib/recheck/useRecheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recheck/useRecheck")>()),
  useRecheckRequest: (): RecheckControl => ({
    state: { kind: "none" },
    spent: false,
    checking: false,
    actions: { request: () => undefined, check: () => undefined },
  }),
}));

// The chain read for the matched passport's name and picture: a screen that cannot reach it still
// shows the answer, so it answers nothing here and nothing leaves the process.
vi.mock("@/components/verify/lookup", () => ({ matchedPassport: async () => null }));

const PASSPORT = `0x${"7c".repeat(32)}` as Hex;
const BLOCKHASH = "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0" as Hex;
const LINE = createTranslator({ locale: "en", messages: en, namespace: "verify" })("staleIndex", { minutes: 12 });

/** What the service answers, loaded 12 minutes and 40 seconds ago, and called stale or not. */
function served(options: { matched: boolean; stale: boolean }) {
  const best = { id: PASSPORT, phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1 };
  return {
    result: {
      exact: options.matched ? PASSPORT : null,
      best: options.matched ? best : null,
      matches: options.matched ? [best] : [],
      confidence: options.matched ? 1 : 0,
      queried: { sha256: PASSPORT, phash: "7840506850305415717", blockhash: BLOCKHASH, width: 512, height: 384, format: "jpeg" },
    },
    manifest: { present: true },
    index: { loadedAt: Math.floor(Date.now() / 1000) - 12 * 60 - 40, stale: options.stale },
  };
}

function answering(body: unknown) {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/verify")) {
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    if (url.includes("bafkreisample")) {
      return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }) } as Response;
    }
    throw new Error("no network in this test");
  });
}

function picture(): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], "copy.jpg", { type: "image/jpeg" });
}

function inEnglish(child: ReturnType<typeof createElement>) {
  return createElement(NextIntlClientProvider as never, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, child);
}

/** Mounts a screen, runs `press` inside act, and waits until `done` holds or two seconds pass. */
async function mounted(screen: ReturnType<typeof createElement>, press: (host: HTMLElement) => void, done: (host: HTMLElement) => boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(inEnglish(screen));
  });
  await act(async () => {
    press(host);
    for (let waited = 0; waited < 2_000 && !done(host); waited += 25) {
      await new Promise((settle) => setTimeout(settle, 25));
    }
  });
  const unmount = async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  };
  return { host, unmount };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the home page's drop", () => {
  it("hands its card an answer that carries the stale minutes, and the card prints the line beside a miss and a match", async () => {
    const { answerFor, AnswerCard } = await import("@/components/home/check");
    for (const matched of [false, true]) {
      answering(served({ matched, stale: true }));
      const stage = await answerFor(picture());
      expect(stage.kind, String(matched)).toBe("answer");
      const markup = renderToStaticMarkup(inEnglish(createElement(AnswerCard, { stage })));
      expect(markup, String(matched)).toContain("data-stale-index");
      expect(markup, String(matched)).toContain(LINE.replace(/'/g, "&#x27;"));
    }

    answering(served({ matched: false, stale: false }));
    const current = await answerFor(picture());
    expect(renderToStaticMarkup(inEnglish(createElement(AnswerCard, { stage: current })))).not.toContain("data-stale-index");
  }, 30_000);
});

describe("the passport page's check of a copy", () => {
  async function checked(body: unknown) {
    const { CheckCopy } = await import("@/components/passport/CheckCopy");
    answering(body);
    return await mounted(
      createElement(CheckCopy, { passportId: PASSPORT }),
      (host) => {
        const input = host.querySelector('input[type="file"]') as HTMLInputElement;
        Object.defineProperty(input, "files", { value: [picture()], configurable: true });
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      (host) => host.textContent?.includes("copy.jpg") === true,
    );
  }

  it("prints the verify card's stale line beside a miss and beside a match", async () => {
    for (const matched of [false, true]) {
      const { host, unmount } = await checked(served({ matched, stale: true }));
      expect(host.querySelector("[data-stale-index]")?.textContent, String(matched)).toBe(LINE);
      await unmount();
    }
  }, 30_000);

  it("prints no such line when the service called its copy current", async () => {
    const { host, unmount } = await checked(served({ matched: true, stale: false }));
    expect(host.textContent).toContain("copy.jpg");
    expect(host.querySelector("[data-stale-index]")).toBeNull();
    await unmount();
  }, 30_000);
});

describe("the landing film's try panel", () => {
  async function tried(body: unknown) {
    const { TryPanel } = await import("@/components/story/TryPanel");
    URL.createObjectURL = () => "blob:sample";
    URL.revokeObjectURL = () => undefined;
    answering(body);
    return await mounted(
      createElement(TryPanel, {
        onPreview: () => undefined,
        pinned: false,
        samples: [{ id: PASSPORT, url: "ipfs://bafkreisample", title: "A church in a storm" }],
      }),
      (host) => (host.querySelector("li button") as HTMLButtonElement).click(),
      (host) => host.querySelector('a[href^="/passport/"]') !== null || host.textContent?.includes(en.story.tryIt.noMatch) === true,
    );
  }

  it("prints the verify card's stale line beside a miss and beside a match", async () => {
    for (const matched of [false, true]) {
      const { host, unmount } = await tried(served({ matched, stale: true }));
      expect(host.querySelector("[data-stale-index]")?.textContent, String(matched)).toBe(LINE);
      await unmount();
    }
  }, 30_000);

  it("prints no such line when the service called its copy current", async () => {
    const { host, unmount } = await tried(served({ matched: true, stale: false }));
    expect(host.textContent).toContain("Open its passport");
    expect(host.querySelector("[data-stale-index]")).toBeNull();
    await unmount();
  }, 30_000);
});
