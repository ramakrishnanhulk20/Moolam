// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { RecheckControl } from "@/lib/recheck/useRecheck";
import { readAnswer } from "@/components/verify/answer";
import { isMeasured, verifyResponseSchema } from "@/lib/verifier/client";

/**
 * The verify service's exact answer for a file whose pixels it cannot read: a passport registered
 * straight on chain from a GIF, a HEIC or a picture over the pixel limit, answered by its own bytes
 * (verifier review pass 11, V115). The shape is matchImage's bytes-only branch in
 * packages/verifier/src/match.ts as renderResult in routes/shared.ts sends it: no distances, no
 * score, `queried` as the sha256 alone, and a note.
 *
 * The schema takes it, the reader keeps its distances out rather than filling in zeros, and the
 * verify card, the passport page's check and the try panel each print one quiet line where the
 * distances would be.
 *
 * Does NOT cover how the service decides the pixels cannot be read (the verifier's own tests), the
 * other nine languages' wording beyond the key being there, or the layout at 375px in a browser.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom never finishes a framer-motion exit, so the passport check's "checking" face would hold the
// answer back. Motion elements render as their plain tags; what is under test is the words.
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

// The chain read for the matched passport's name: answers nothing, so nothing leaves the process.
vi.mock("@/components/verify/lookup", () => ({ matchedPassport: async () => null }));

const { AnswerCard } = await import("@/components/verify/AnswerCard");

const PASSPORT = `0x${"5e".repeat(32)}` as Hex;
const SHA = `0x${"a1".repeat(32)}` as Hex;
const BLOCKHASH = "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0" as Hex;
const NOTE =
  "this file is byte for byte the one this passport registered, but its pixels could not be read here, so no distances were measured";
const LINE = "This is the registered file byte for byte. Its pixels could not be read, so no look or layout comparison was made.";

function bytesOnly(overrides: Record<string, unknown> = {}) {
  const row = { id: PASSPORT, variant: "identity" };
  return {
    result: {
      exact: PASSPORT,
      best: row,
      matches: [row],
      confidence: 1,
      queried: { sha256: SHA },
      note: NOTE,
      laterSameFingerprint: 0,
      ...overrides,
    },
    manifest: { present: false },
  };
}

/** A measured exact answer, the shape every decodable file gets. */
function measured() {
  const best = { id: PASSPORT, phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1 };
  return {
    result: {
      exact: PASSPORT,
      best,
      matches: [best],
      confidence: 1,
      queried: { sha256: SHA, phash: "7840506850305415717", blockhash: BLOCKHASH, width: 512, height: 384, format: "jpeg" },
    },
    manifest: { present: false },
  };
}

function answering(body: unknown) {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/verify")) {
      return { ok: true, status: 200, json: async () => body } as Response;
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

/** Mounts a screen, hands it a file through its input, and waits until the file's name shows. */
async function mounted(screen: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(inEnglish(screen));
  });
  await act(async () => {
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [picture()], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    for (let waited = 0; waited < 2_000 && host.querySelector('a[href^="/passport/"]') === null && !host.textContent?.includes("copy.jpg"); waited += 25) {
      await new Promise((settle) => setTimeout(settle, 25));
    }
    // The name lands with the answer; one more turn lets the rest of the face settle.
    await new Promise((settle) => setTimeout(settle, 25));
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

describe("the bytes-only exact answer at the schema", () => {
  it("is accepted, with its note read", () => {
    const parsed = verifyResponseSchema.safeParse(bytesOnly());
    expect(parsed.success).toBe(true);
    expect(parsed.data?.result.exact).toBe(PASSPORT);
    expect(parsed.data?.result.note).toBe(NOTE);
    expect(parsed.data?.result.queried.sha256).toBe(SHA);
    expect(isMeasured(parsed.data!.result)).toBe(false);
    expect(isMeasured(verifyResponseSchema.parse(measured()).result)).toBe(true);
  });

  it("is refused when it names no exact passport, since only a byte match may skip the measuring", () => {
    expect(verifyResponseSchema.safeParse(bytesOnly({ exact: null })).success).toBe(false);
  });

  it("does not let a measured row with a broken distance slip through as an unmeasured one", () => {
    const broken = { id: PASSPORT, phashDistance: -1, blockhashDistance: 0, variant: "identity", score: 1 };
    const body = measured();
    expect(verifyResponseSchema.safeParse({ ...body, result: { ...body.result, best: broken, matches: [broken] } }).success).toBe(false);
    expect(verifyResponseSchema.safeParse(bytesOnly({ queried: { sha256: SHA, phash: "12" } })).success).toBe(false);
  });
});

describe("the reader", () => {
  it("keeps the distances out rather than drawing zeros for a comparison never made", () => {
    const answer = readAnswer(verifyResponseSchema.parse(bytesOnly()));
    expect(answer).toMatchObject({ kind: "exact", id: PASSPORT, confidence: 1, pixelsUnread: true, variant: "identity" });
    expect(answer.kind === "miss" ? "miss" : answer.phashDistance).toBeUndefined();
    expect(answer.kind === "miss" ? "miss" : answer.blockhashDistance).toBeUndefined();
  });

  it("reads a measured exact answer exactly as before", () => {
    const answer = readAnswer(verifyResponseSchema.parse(measured()));
    expect(answer).toMatchObject({ kind: "exact", phashDistance: 0, blockhashDistance: 0 });
    expect("pixelsUnread" in answer).toBe(false);
  });
});

describe("the verify card", () => {
  it("prints the quiet line in place of the distance rows, and only the sha256 under what was measured", () => {
    const answer = readAnswer(verifyResponseSchema.parse(bytesOnly()));
    const markup = renderToStaticMarkup(inEnglish(createElement(AnswerCard, { stage: { kind: "answer", answer, passport: null } })));
    expect(markup).toContain("data-pixels-unread");
    expect(markup).toContain(LINE);
    expect(markup).not.toContain(en.verify.phashDistance);
    expect(markup).not.toContain(en.verify.blockhashDistance);
    expect(markup).not.toContain(en.verify.queriedPhash);
    expect(markup).toContain(en.verify.queriedSha);
    expect(markup).not.toContain("undefined");
  });

  it("keeps the distance rows and no such line on a measured exact answer", () => {
    const answer = readAnswer(verifyResponseSchema.parse(measured()));
    const markup = renderToStaticMarkup(inEnglish(createElement(AnswerCard, { stage: { kind: "answer", answer, passport: null } })));
    expect(markup).not.toContain("data-pixels-unread");
    expect(markup).toContain(en.verify.phashDistance);
    expect(markup).toContain(en.verify.queriedPhash);
  });
});

describe("the passport page's check of a copy", () => {
  it("prints the same line and no distances", async () => {
    const { CheckCopy } = await import("@/components/passport/CheckCopy");
    answering(bytesOnly());
    const { host, unmount } = await mounted(createElement(CheckCopy, { passportId: PASSPORT }));
    expect(host.querySelector("[data-pixels-unread]")?.textContent).toBe(LINE);
    expect(host.textContent).toContain(en.passport.check.sameExact);
    expect(host.textContent).not.toContain(en.verify.phashDistance);
    expect(host.textContent).not.toContain("undefined");
    await unmount();
  }, 30_000);
});

describe("the landing film's try panel", () => {
  it("prints the same line beside the byte match", async () => {
    const { TryPanel } = await import("@/components/story/TryPanel");
    URL.createObjectURL = () => "blob:copy";
    URL.revokeObjectURL = () => undefined;
    answering(bytesOnly());
    const { host, unmount } = await mounted(createElement(TryPanel, { onPreview: () => undefined, pinned: false }));
    expect(host.querySelector('a[href^="/passport/"]')).not.toBeNull();
    expect(host.querySelector("[data-pixels-unread]")?.textContent).toBe(LINE);
    await unmount();
  }, 30_000);
});
