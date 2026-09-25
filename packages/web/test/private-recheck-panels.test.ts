// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState, type FunctionComponent, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import { RegisterPanel } from "@/components/studio/RegisterPanel";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { Receipt } from "@/components/studio/Receipt";
import { initialRegisterState, registerReducer, type RegisterState } from "@/lib/studio/flow";
import type { PrepareResponse } from "@/lib/verifier/client";
import type { Studio } from "@/lib/studio/useStudio";

// The failure note and the done screen's actions reach the panels through
// next/dynamic, which hands a component back only once its chunk has arrived.
// Every loader is started here and awaited once below, so the cases render the
// note itself and not its empty loading state.
const chunks = vi.hoisted(() => ({ pending: [] as Promise<unknown>[] }));

vi.mock("next/dynamic", async () => {
  const { createElement: make } = await import("react");
  return {
    default: (load: () => Promise<FunctionComponent<never>>, options?: { loading?: FunctionComponent }) => {
      let Loaded: FunctionComponent<never> | null = null;
      chunks.pending.push(
        load().then((component) => {
          Loaded = component;
        }),
      );
      return (props: never) =>
        Loaded === null ? (options?.loading === undefined ? null : make(options.loading)) : make(Loaded, props);
    },
  };
});

for (let seen = -1; seen !== chunks.pending.length; ) {
  seen = chunks.pending.length;
  await Promise.all(chunks.pending);
}

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
}));

/**
 * The private re-check on the two studio panels and on the stub.
 *
 * The panels are pressed for real in a browser stand-in, because the one thing
 * the order asks of the press is that it lands where the thumb was: the choice
 * turns on in place, sealed off takes it away, and neither sends the creator
 * anywhere else on the page.
 */

type Locale = "en" | "ta";

const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
  locale: string;
  messages: unknown;
  timeZone: string;
  children?: unknown;
}>;

function wrap(locale: Locale, node: ReactElement): ReactElement {
  return createElement(Provider, { locale, messages: locale === "en" ? en : ta, timeZone: "Asia/Kolkata" }, node);
}

function render(locale: Locale, node: ReactElement): string {
  return renderToStaticMarkup(wrap(locale, node));
}

const NOOP = () => undefined;

const uploadHandlers = {
  onChoose: NOOP,
  onTitle: NOOP,
  onConsent: NOOP,
  onSaved: NOOP,
  onRegister: NOOP,
  onReset: NOOP,
  onUnsponsored: NOOP,
  onBind: NOOP,
};

const agentHandlers = {
  onPrompt: NOOP,
  onTitle: NOOP,
  onConsent: NOOP,
  onIncludePrompt: NOOP,
  onSaved: NOOP,
  onGenerate: NOOP,
  onReset: NOOP,
  onUnsponsored: NOOP,
  onBind: NOOP,
};

const words = en.studio.sealed.switch;

/** A panel that holds its own state through the real reducer, the way the studio does. */
function Live({ path }: { path: "upload" | "generate" }) {
  const [state, setState] = useState<RegisterState>(initialRegisterState);
  const onSealed = (on: boolean, privateRecheck?: boolean) =>
    setState((now) => registerReducer(now, { type: "sealed", on, privateRecheck }));
  return path === "upload"
    ? createElement(RegisterPanel, { state, onSealed, ...uploadHandlers })
    : createElement(GeneratePanel, { state, onSealed, ...agentHandlers });
}

async function mount(path: "upload" | "generate"): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(wrap("en", createElement(Live, { path })));
  });
  return host;
}

function switchNamed(host: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((button) =>
      button.textContent?.includes(label),
    ) ?? null
  );
}

async function press(button: HTMLButtonElement | null): Promise<void> {
  if (button === null) {
    throw new Error("the switch is not on screen");
  }
  await act(async () => {
    button.click();
  });
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  // The consent plates reveal on scroll, which a browser stand-in has no viewport for.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/** Long enough for the panel's closing animation to finish and take its contents away. */
async function settled(): Promise<void> {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 900));
  });
}

/** The markup escapes an apostrophe, so a sentence with one is looked for the way it is written there. */
function escaped(text: string): string {
  return text.replaceAll("'", "&#x27;");
}

describe("the choice on both panels", () => {
  for (const path of ["upload", "generate"] as const) {
    it(`is hidden until sealed is on, then off, on the ${path} path`, async () => {
      const host = await mount(path);
      expect(switchNamed(host, words.privateLabel)).toBeNull();

      await press(switchNamed(host, words.label));
      const choice = switchNamed(host, words.privateLabel);
      expect(choice?.getAttribute("aria-checked")).toBe("false");
      expect(host.textContent).toContain(words.privateWho);
      expect(host.textContent).not.toContain(en.studio.sealed.fields.privateRecheck.label);
    });

    it(`turns on in place, adds its row, and goes away with sealed on the ${path} path`, async () => {
      const host = await mount(path);
      await press(switchNamed(host, words.label));

      const before = switchNamed(host, words.privateLabel);
      await press(before);
      const after = switchNamed(host, words.privateLabel);
      // The same button, still there, now saying on: nothing was swapped out under the thumb.
      expect(after).toBe(before);
      expect(after?.getAttribute("aria-checked")).toBe("true");
      expect(host.textContent).toContain(en.studio.sealed.fields.privateRecheck.label);

      await press(switchNamed(host, words.label));
      await settled();
      expect(switchNamed(host, words.privateLabel)).toBeNull();

      // Sealed back on: the private re-check has to be asked for again.
      await press(switchNamed(host, words.label));
      expect(switchNamed(host, words.privateLabel)?.getAttribute("aria-checked")).toBe("false");
    });
  }

  it("says who can open the copy in Tamil too", () => {
    const state = { ...initialRegisterState, sealed: { ...initialRegisterState.sealed, on: true } };
    const tamil = render("ta", createElement(RegisterPanel, { state, onSealed: NOOP, ...uploadHandlers }));
    expect(tamil).toContain(ta.studio.sealed.switch.privateLabel);
    expect(tamil).toContain(escaped(ta.studio.sealed.switch.privateWho));
  });
});

describe("the stub", () => {
  const PASSPORT = `0x${"ab".repeat(32)}`;
  const SEALED = {
    passport: {
      exactHash: PASSPORT,
      parentId: `0x${"00".repeat(32)}`,
      generatorAgentId: "0",
      phash: "7840506850305415717",
      blockhash256: `0x${"11".repeat(32)}`,
      manifestHash: `0x${"22".repeat(32)}`,
      kind: 1,
      fingerprintVersion: 1,
      metadataURI: "ipfs://metadata",
    },
    metadata: { cid: "bafkreimeta", uri: "ipfs://bafkreimeta" },
    manifest: { embedded: true },
    preparedBy: "did:privy:someone",
    sealed: true,
    signedFile: { name: "a.jpg", type: "image/jpeg", bytes: "//2Q==", sha256: PASSPORT },
  } as unknown as PrepareResponse;

  function studioWith(prepared: PrepareResponse, asked: boolean): Studio {
    return {
      authenticated: true,
      account: { kind: "email", value: "ram@example.com" },
      wallet: "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c",
      binding: { status: "none", passkey: null },
      bind: { txHash: null },
      register: {
        ...initialRegisterState,
        prepared,
        sealed: { on: true, includePrompt: false, privateRecheck: asked, file: null, saved: false },
      },
      actions: { saveSealed: NOOP, stateAgain: NOOP },
    } as unknown as Studio;
  }

  it("stamps the private copy when the answer says one was kept", () => {
    const markup = render("en", createElement(Receipt, { studio: studioWith({ ...SEALED, privateRecheck: true }, true) }));
    expect(markup).toContain(en.studio.sealed.receipt.privateLabel);
    // The last sentence is a link to the passport page, so the line is read without its two tags.
    expect(markup).toContain(escaped(en.studio.sealed.receipt.privateDetail.split("<page>")[0]));
  });

  it("stamps nothing about a copy the answer did not report, whatever the switch said", () => {
    const asked = render("en", createElement(Receipt, { studio: studioWith(SEALED, true) }));
    expect(asked).toContain(en.studio.sealed.receipt.label);
    expect(asked).not.toContain(en.studio.sealed.receipt.privateLabel);

    const plain = render("en", createElement(Receipt, { studio: studioWith(SEALED, false) }));
    expect(plain).not.toContain(en.studio.sealed.receipt.privateLabel);
  });
});

describe("the four refusals on the panel", () => {
  for (const key of [
    "privateRecheckNeedsSealed",
    "privateCopyNotPrivate",
    "privateChainUnreachable",
    "privateThumbnailTooLarge",
  ] as const) {
    it(`prints the ${key} sentence in English and Tamil`, () => {
      const state = { ...initialRegisterState, failure: { key } };
      expect(render("en", createElement(RegisterPanel, { state, onSealed: NOOP, ...uploadHandlers }))).toContain(
        en.studio.failure[key],
      );
      expect(render("ta", createElement(RegisterPanel, { state, onSealed: NOOP, ...uploadHandlers }))).toContain(
        ta.studio.failure[key],
      );
    });
  }
});
