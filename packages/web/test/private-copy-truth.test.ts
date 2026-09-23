// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import { RegisterPanel } from "@/components/studio/RegisterPanel";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { Receipt } from "@/components/studio/Receipt";
import { initialRegisterState, type RegisterState } from "@/lib/studio/flow";
import type { PrepareResponse } from "@/lib/verifier/client";
import type { Studio } from "@/lib/studio/useStudio";

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; className?: string; children?: unknown }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));

/**
 * Threat model ruling D1 on the studio: with a private copy kept, no sentence
 * on the hand-back card, the done band, the plate or the stub may still say
 * Moolam kept nothing. Without one, every one of them reads exactly as before.
 */

const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
  locale: string;
  messages: unknown;
  timeZone: string;
  children?: unknown;
}>;

function render(node: ReactElement): string {
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node));
}

/** The markup escapes an apostrophe, so a sentence with one is looked for the way it is written there. */
function escaped(text: string): string {
  return text.replaceAll("'", "&#x27;");
}

const words = en.studio.sealed;
const NOOP = () => undefined;
const PASSPORT = `0x${"ab".repeat(32)}`;

const SEALED = {
  passport: {
    exactHash: PASSPORT,
    parentId: `0x${"00".repeat(32)}`,
    creator: "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c",
    generatorAgentId: "7",
    phash: "7840506850305415717",
    blockhash256: `0x${"5a".repeat(32)}`,
    manifestHash: `0x${"22".repeat(32)}`,
    kind: 1,
    fingerprintVersion: 1,
    metadataURI: "ipfs://metadata",
    deadline: "1788876542",
  },
  metadata: { cid: "bafkreimeta", uri: "ipfs://bafkreimeta" },
  manifest: { embedded: true },
  preparedBy: "did:privy:someone",
  model: "flux-schnell",
  agent: { id: "7", wallet: "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" },
  generatorSig: `0x${"33".repeat(65)}`,
  sealed: true,
  signedFile: { name: "a.jpg", type: "image/jpeg", bytes: "//2Q==", sha256: PASSPORT },
} as unknown as PrepareResponse;

const FILE = {
  name: "monsoon-nets.jpg",
  type: "image/jpeg",
  blob: new Blob([new Uint8Array([0xff, 0xd8])], { type: "image/jpeg" }),
  sha256: PASSPORT as `0x${string}`,
  size: 2,
};

/** A sealed run on either path, the file held, stopped at the passkey or finished. */
function stateWith(options: { kept: boolean; asked: boolean; done: boolean; path: "upload" | "generate" }): RegisterState {
  const answer = (options.kept ? { ...SEALED, privateRecheck: true } : SEALED) as PrepareResponse;
  return {
    ...initialRegisterState,
    mode: options.path,
    title: "Monsoon nets",
    prepared: answer,
    generated: options.path === "generate" ? (answer as unknown as RegisterState["generated"]) : null,
    sealed: { on: true, includePrompt: false, privateRecheck: options.asked, file: FILE, saved: false },
    steps: {
      ...initialRegisterState.steps,
      prepare: "done",
      draw: "done",
      pin: "done",
      agentSign: "done",
      sign: options.done ? "done" : "running",
      send: options.done ? "done" : "waiting",
    },
    registeredAt: options.done ? 1_788_876_542_000 : null,
  };
}

function panel(state: RegisterState): string {
  return state.mode === "upload"
    ? render(
        createElement(RegisterPanel, {
          state,
          onChoose: NOOP,
          onTitle: NOOP,
          onConsent: NOOP,
          onSealed: NOOP,
          onSaved: NOOP,
          onRegister: NOOP,
          onReset: NOOP,
          onUnsponsored: NOOP,
          onBind: NOOP,
        }),
      )
    : render(
        createElement(GeneratePanel, {
          state,
          onPrompt: NOOP,
          onTitle: NOOP,
          onConsent: NOOP,
          onSealed: NOOP,
          onIncludePrompt: NOOP,
          onSaved: NOOP,
          onGenerate: NOOP,
          onReset: NOOP,
          onUnsponsored: NOOP,
          onBind: NOOP,
        }),
      );
}

function receipt(state: RegisterState): string {
  const studio = {
    authenticated: true,
    account: { kind: "email", value: "ram@example.com" },
    wallet: "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c",
    binding: { status: "none", passkey: null },
    bind: { txHash: null },
    register: state,
    actions: { saveSealed: NOOP, stateAgain: NOOP },
  } as unknown as Studio;
  return render(createElement(Receipt, { studio }));
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the sealed lines with and without a private copy", () => {
  for (const path of ["upload", "generate"] as const) {
    it(`the hand-back card and its plate on the ${path} path`, () => {
      const kept = panel(stateWith({ kept: true, asked: true, done: false, path }));
      expect(kept).toContain(words.handback.bodyPrivate);
      expect(kept).toContain(words.plate.linePrivate);
      expect(kept).not.toContain(words.handback.body);
      expect(kept).not.toContain(words.plate.line);

      const none = panel(stateWith({ kept: false, asked: false, done: false, path }));
      expect(none).toContain(words.handback.body);
      expect(none).toContain(words.plate.line);
      expect(none).not.toContain(words.handback.bodyPrivate);
      expect(none).not.toContain(words.plate.linePrivate);
    });

    it(`the done band on the ${path} path`, () => {
      const kept = panel(stateWith({ kept: true, asked: true, done: true, path }));
      expect(kept).toContain(words.done.bodyPrivate);
      expect(kept).not.toContain(words.done.body);

      const none = panel(stateWith({ kept: false, asked: false, done: true, path }));
      expect(none).toContain(words.done.body);
      expect(none).not.toContain(words.done.bodyPrivate);
    });
  }

  it("the stub's sealed row", () => {
    const kept = receipt(stateWith({ kept: true, asked: true, done: false, path: "upload" }));
    expect(kept).toContain(words.receipt.detailPrivate);
    expect(kept).not.toContain(words.receipt.detail);

    const none = receipt(stateWith({ kept: false, asked: false, done: false, path: "upload" }));
    expect(none).toContain(words.receipt.detail);
    expect(none).not.toContain(words.receipt.detailPrivate);
    expect(none).not.toContain(escaped(words.receipt.privateLabel));
  });

  it("never says Moolam kept nothing anywhere on the kept run", () => {
    const state = stateWith({ kept: true, asked: true, done: true, path: "upload" });
    const everything = panel(state) + receipt(state);
    for (const untrue of [words.handback.body, words.done.body, words.receipt.detail, words.plate.line]) {
      expect(everything).not.toContain(untrue);
    }
  });
});

// Relative to packages/web, where the suite runs, because a browser stand-in has no file URL.
const MESSAGES = "messages/";
const LOCALES = readdirSync(MESSAGES)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(".json", ""));
const FILES = new Map(
  LOCALES.map((locale) => [locale, JSON.parse(readFileSync(`${MESSAGES}${locale}.json`, "utf8")) as unknown]),
);

/** The character the house rule bans, built rather than typed. */
const LONG_DASH = String.fromCharCode(0x2014);

function at(locale: string, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], FILES.get(locale));
}

const NEW_KEYS = [
  "studio.sealed.plate.linePrivate",
  "studio.sealed.handback.bodyPrivate",
  "studio.sealed.done.bodyPrivate",
  "studio.sealed.receipt.detailPrivate",
  "studio.sealed.receipt.noPrivateLabel",
  "studio.sealed.receipt.noPrivateDetail",
];

describe("a private copy asked for and not kept", () => {
  it("gets one row on the stub saying so, and the sealed row still says nothing was kept", () => {
    const markup = receipt(stateWith({ kept: false, asked: true, done: false, path: "upload" }));
    expect(markup.split(words.receipt.noPrivateLabel).length - 1).toBe(1);
    expect(markup).toContain(words.receipt.noPrivateDetail);
    expect(markup).toContain(words.receipt.detail);
    expect(markup).not.toContain(words.receipt.privateLabel);
    expect(markup).not.toContain(words.receipt.detailPrivate);
  });

  it("stays off the stub when nobody asked, and when the copy was kept", () => {
    const plain = receipt(stateWith({ kept: false, asked: false, done: false, path: "upload" }));
    expect(plain).not.toContain(words.receipt.noPrivateLabel);

    const kept = receipt(stateWith({ kept: true, asked: true, done: false, path: "upload" }));
    expect(kept).not.toContain(words.receipt.noPrivateLabel);
    expect(kept).not.toContain(words.receipt.noPrivateDetail);
  });

  it("does not stop the registration: the panel runs on to the passkey as it would have", () => {
    const run = panel(stateWith({ kept: false, asked: true, done: false, path: "upload" }));
    expect(run).toContain("data-sealed-file");
    expect(run).toContain(words.handback.body);
  });
});

describe("the kept copy's row on the stub", () => {
  it("links its last sentence to the passport page, where the copy can be deleted", () => {
    const markup = receipt(stateWith({ kept: true, asked: true, done: false, path: "upload" }));
    const [first, rest] = words.receipt.privateDetail.split("<page>");
    const linked = rest.replace("</page>", "");
    expect(markup).toContain(escaped(first));
    const opens = markup.indexOf(`<a href="/passport/${PASSPORT}"`);
    expect(opens).toBeGreaterThan(-1);
    const body = markup.slice(markup.indexOf(">", opens) + 1, markup.indexOf("</a>", opens));
    expect(body).toBe(escaped(linked));
    expect(markup).not.toContain("&lt;page&gt;");
  });

  it("keeps its tag around the last sentence in every language, and nowhere else", () => {
    for (const locale of LOCALES) {
      const line = String(at(locale, "studio.sealed.receipt.privateDetail"));
      expect(line.split("<page>").length, locale).toBe(2);
      expect(line.endsWith("</page>"), locale).toBe(true);
      expect(line.indexOf("<page>"), locale).toBeGreaterThan(0);
    }
  });
});

describe("the words, in ten languages", () => {
  it("has ten language files", () => {
    expect(LOCALES).toHaveLength(10);
  });

  it("says every new line in every language, differently from the line it stands beside", () => {
    for (const locale of LOCALES) {
      for (const path of NEW_KEYS) {
        const said = at(locale, path);
        expect(typeof said === "string" && said.trim().length > 0, `${locale} ${path}`).toBe(true);
        expect(String(said), `${locale} ${path}`).not.toContain(LONG_DASH);
        if (path.endsWith("Private")) {
          expect(said, `${locale} ${path}`).not.toBe(at(locale, path.replace(/Private$/, "")));
        }
      }
    }
    for (const path of NEW_KEYS) {
      expect(new Set(LOCALES.map((locale) => at(locale, path))).size, path).toBe(10);
    }
  });

  it("leaves the lines without a private copy as they were", () => {
    expect(words.handback.body).toBe("Moolam pinned nothing of the picture and kept nothing. Save it before you close this page.");
    expect(words.done.body).toBe("The picture is not published. Moolam keeps no copy.");
    expect(words.receipt.detail).toBe("The picture is not published. Moolam keeps no copy.");
    expect(words.plate.line).toBe("The picture is not published. You hold the only copy.");
  });

  it("measures the private copy on its longest side, not its width, in every language", () => {
    const longest: Record<string, string> = {
      en: "512 pixels on its longest side",
      de: "512 Pixel an der längsten Seite",
      es: "512 píxeles en su lado más largo",
      fr: "512 pixels sur son plus grand côté",
      hi: "सबसे लंबी तरफ़ 512 पिक्सेल",
      ja: "長辺 512 ピクセル",
      ko: "긴 변 512픽셀",
      pt: "512 pixels no lado maior",
      ta: "நீளமான பக்கத்தில் 512 பிக்சல்",
      zh: "长边 512 像素",
    };
    const wide = ["pixels wide", "Pixel breit", "de ancho", "de large", "चौड़ी", "幅 512", "너비", "de largura", "அகலமுள்ள", "宽 512"];
    expect(Object.keys(longest).sort()).toEqual([...LOCALES].sort());
    for (const locale of LOCALES) {
      const note = String(at(locale, "studio.sealed.switch.privateNote"));
      expect(note, locale).toContain(longest[locale]);
      for (const old of wide) {
        expect(note, locale).not.toContain(old);
      }
    }
  });
});
