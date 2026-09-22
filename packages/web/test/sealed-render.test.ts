import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import { RegisterPanel } from "@/components/studio/RegisterPanel";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { Receipt } from "@/components/studio/Receipt";
import { initialRegisterState, type RegisterState } from "@/lib/studio/flow";
import type { SealedHandback } from "@/lib/sealed/handback";
import type { GenerateResponse, PrepareResponse } from "@/lib/verifier/client";
import type { Studio } from "@/lib/studio/useStudio";

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
}));

/**
 * The studio screens for a picture nobody else will see: the switch and its
 * list, the file handed back before the unlock, the done screen with a plate
 * where a picture would be, and the stub beside them.
 *
 * Rendered in English and in Tamil, because a screen that only exists in
 * English is a screen nine readers out of ten cannot use.
 */
function render(locale: "en" | "ta", node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;

  return renderToStaticMarkup(
    createElement(Provider, { locale, messages: locale === "en" ? en : ta, timeZone: "Asia/Kolkata" }, node),
  );
}

const NOOP = () => undefined;

const PASSPORT = `0x${"ab".repeat(32)}` as const;
const BLOCKHASH = "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0" as const;

const PICTURE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const HELD: SealedHandback = {
  name: "a-morning-abababab.jpg",
  type: "image/jpeg",
  blob: new Blob([PICTURE as BlobPart], { type: "image/jpeg" }),
  sha256: PASSPORT,
  size: 2_400_000,
};

const SEALED_PREPARED = {
  passport: {
    exactHash: PASSPORT,
    parentId: `0x${"00".repeat(32)}`,
    generatorAgentId: "0",
    phash: "7840506850305415717",
    blockhash256: BLOCKHASH,
    manifestHash: `0x${"22".repeat(32)}`,
    kind: 1,
    fingerprintVersion: 1,
    metadataURI: "ipfs://metadata",
  },
  metadata: { cid: "bafkreimeta", uri: "ipfs://bafkreimeta" },
  manifest: { embedded: true },
  preparedBy: "did:privy:someone",
  sealed: true,
  signedFile: { name: HELD.name, type: HELD.type, bytes: "//2Q==", sha256: PASSPORT },
} as unknown as PrepareResponse;

const SEALED_DRAWN = {
  ...SEALED_PREPARED,
  passport: { ...SEALED_PREPARED.passport, creator: `0x${"11".repeat(20)}`, deadline: "1788878733", kind: 0 },
  generatorSig: `0x${"cd".repeat(65)}`,
  model: "gpt-image-1",
  agent: { id: "10249", wallet: `0x${"a3".repeat(20)}` },
  quota: { used: 1, limit: 3, resetsAt: 1788961533 },
} as unknown as GenerateResponse;

const uploadHandlers = {
  onChoose: NOOP,
  onTitle: NOOP,
  onConsent: NOOP,
  onSealed: NOOP,
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
  onSealed: NOOP,
  onIncludePrompt: NOOP,
  onSaved: NOOP,
  onGenerate: NOOP,
  onReset: NOOP,
  onUnsponsored: NOOP,
  onBind: NOOP,
};

function sealedState(over: Partial<RegisterState> = {}): RegisterState {
  return {
    ...initialRegisterState,
    title: "A morning",
    ...over,
    sealed: { on: true, includePrompt: false, file: null, saved: false, ...(over.sealed ?? {}) },
  };
}

describe("the switch on the two panels", () => {
  it("offers to keep the picture, off, on both paths", () => {
    const upload = render("en", createElement(RegisterPanel, { state: initialRegisterState, ...uploadHandlers }));
    expect(upload).toContain(en.studio.sealed.switch.label);
    expect(upload).toContain("the only copy that can unseal this passport");
    expect(upload).toContain('aria-checked="false"');
    // Nothing is promised about what becomes public until the switch is on.
    expect(upload).not.toContain(en.studio.sealed.switch.panelHeading);

    const agent = render("en", createElement(GeneratePanel, { state: initialRegisterState, ...agentHandlers }));
    expect(agent).toContain(en.studio.sealed.switch.label);
  });

  it("lists what becomes public, every row in the reader's own words", () => {
    const markup = render("en", createElement(RegisterPanel, { state: sealedState(), ...uploadHandlers }));

    expect(markup).toContain(en.studio.sealed.switch.panelHeading);
    for (const key of ["commitment", "fingerprint", "name", "description", "creator", "createdAt", "training", "sealed"] as const) {
      expect(markup, key).toContain(en.studio.sealed.fields[key].label);
      expect(markup, key).toContain(en.studio.sealed.fields[key].line);
    }
    // An upload has no agent, no model and no prompt, so none of the three is promised.
    expect(markup).not.toContain(en.studio.sealed.fields.prompt.label);
    expect(markup).not.toContain(en.studio.sealed.fields.model.label);

    const tamil = render("ta", createElement(RegisterPanel, { state: sealedState(), ...uploadHandlers }));
    expect(tamil).toContain(ta.studio.sealed.switch.panelHeading);
    expect(tamil).toContain(ta.studio.sealed.fields.commitment.label);
    expect(tamil).not.toContain(en.studio.sealed.fields.commitment.label);
  });

  it("asks about the prompt only on the agent path, and says it is left out until it is asked for", () => {
    const markup = render("en", createElement(GeneratePanel, { state: sealedState(), ...agentHandlers }));
    expect(markup).toContain(en.studio.sealed.switch.promptLabel);
    expect(markup).toContain(en.studio.sealed.fields.prompt.label);
    expect(markup).toContain(en.studio.sealed.switch.leftOut);

    const included = render(
      "en",
      createElement(GeneratePanel, {
        state: sealedState({ sealed: { on: true, includePrompt: true, file: null, saved: false } }),
        ...agentHandlers,
      }),
    );
    expect(included).not.toContain(en.studio.sealed.switch.leftOut);
  });
});

describe("the file handed back before the unlock", () => {
  it("shows the plate, the file and the one warning that matters", () => {
    const markup = render(
      "en",
      createElement(RegisterPanel, {
        state: sealedState({
          prepared: SEALED_PREPARED,
          sealed: { on: true, includePrompt: false, file: HELD, saved: false },
        }),
        ...uploadHandlers,
      }),
    );

    expect(markup).toContain(en.studio.sealed.handback.heading);
    expect(markup).toContain(en.studio.sealed.handback.save);
    expect(markup).toContain(en.studio.sealed.handback.only);
    expect(markup).toContain("a-morning-abababab.jpg");
    expect(markup).toContain("2.4 MB");
    expect(markup).toContain('data-sealed-file="held"');
    // The plate is drawn from the fingerprint in the same answer.
    expect(markup).toContain(en.studio.sealed.plate.sealed);
    expect(markup).toContain(en.studio.sealed.plate.line);
    expect(markup).not.toContain(en.studio.sealed.handback.saved);
  });

  it("says so once it has been saved, and keeps the control", () => {
    const markup = render(
      "en",
      createElement(RegisterPanel, {
        state: sealedState({
          prepared: SEALED_PREPARED,
          sealed: { on: true, includePrompt: false, file: HELD, saved: true },
        }),
        ...uploadHandlers,
      }),
    );
    expect(markup).toContain('data-sealed-file="saved"');
    expect(markup).toContain(en.studio.sealed.handback.saved);
    expect(markup).toContain(en.studio.sealed.handback.save);
  });

  it("draws the agent's plate from the fingerprint instead of an empty frame", () => {
    const markup = render(
      "en",
      createElement(GeneratePanel, {
        state: sealedState({
          prepared: SEALED_DRAWN,
          generated: SEALED_DRAWN,
          quota: SEALED_DRAWN.quota,
          steps: { ...initialRegisterState.steps, draw: "done", pin: "done", agentSign: "done" },
          sealed: { on: true, includePrompt: false, file: HELD, saved: false },
        }),
        ...agentHandlers,
      }),
    );
    expect(markup).toContain("gpt-image-1");
    expect(markup).not.toContain("<img");
  });
});

describe("the done screen for a sealed passport", () => {
  const registered = (over: Partial<RegisterState> = {}) =>
    sealedState({
      prepared: SEALED_PREPARED,
      steps: { ...initialRegisterState.steps, prepare: "done", sign: "done", send: "done" },
      block: 103_059_393n,
      registeredAt: 1_788_876_542_000,
      txHash: `0x${"ef".repeat(32)}`,
      sealed: { on: true, includePrompt: false, file: HELD, saved: false },
      ...over,
    });

  it("reads sealed where the picture would be, and offers the file again", () => {
    const markup = render("en", createElement(RegisterPanel, { state: registered(), ...uploadHandlers }));

    expect(markup).toContain(en.studio.sealed.done.label);
    expect(markup).toContain(en.studio.sealed.done.body);
    expect(markup).toContain(en.studio.sealed.handback.save);
    expect(markup).toContain(en.studio.sealed.handback.only);
    // The passport id and the block are on it, as on any other done screen.
    expect(markup).toContain(PASSPORT);
    expect(markup).toContain("103059393");
    // Registered on the plate, with the date rather than the waiting line.
    expect(markup).toContain("Registered Sep 8, 2026. The picture is not published.");
    // Nothing points at a picture: there is none, and no broken image either.
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain(en.studio.register.openImage);
  });

  it("says it in Tamil too", () => {
    const markup = render("ta", createElement(RegisterPanel, { state: registered(), ...uploadHandlers }));
    expect(markup).toContain(ta.studio.sealed.done.label);
    expect(markup).toContain(ta.studio.sealed.handback.save);
  });

  it("holds no file after a reload, and still reads as sealed rather than as broken", () => {
    const markup = render(
      "en",
      createElement(RegisterPanel, {
        state: registered({ sealed: { on: true, includePrompt: false, file: null, saved: true } }),
        ...uploadHandlers,
      }),
    );
    expect(markup).toContain(en.studio.sealed.done.label);
    expect(markup).not.toContain(en.studio.sealed.handback.save);
  });

  it("leaves the prompt off a sealed drawing unless the creator published it", () => {
    const kept = render(
      "en",
      createElement(GeneratePanel, {
        state: registered({
          prepared: SEALED_DRAWN,
          generated: SEALED_DRAWN,
          prompt: "a fishing boat at first light",
        }),
        ...agentHandlers,
      }),
    );
    expect(kept).not.toContain("a fishing boat at first light");

    const published = render(
      "en",
      createElement(GeneratePanel, {
        state: registered({
          prepared: SEALED_DRAWN,
          generated: SEALED_DRAWN,
          prompt: "a fishing boat at first light",
          sealed: { on: true, includePrompt: true, file: HELD, saved: true },
        }),
        ...agentHandlers,
      }),
    );
    expect(published).toContain("a fishing boat at first light");
  });
});

describe("the stub beside a sealed run", () => {
  function studioWith(state: Partial<RegisterState>): Studio {
    return {
      authenticated: true,
      account: { kind: "email", value: "ram@example.com" },
      wallet: "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c",
      binding: { status: "bound", passkey: { qx: `0x${"aa".repeat(32)}`, qy: `0x${"bb".repeat(32)}` } },
      bind: { txHash: `0x${"11".repeat(32)}` },
      register: { ...sealedState(state) },
      actions: { saveSealed: NOOP, stateAgain: NOOP },
    } as unknown as Studio;
  }

  it("stamps the seal instead of the pin, with no pixel count to quote", () => {
    const markup = render(
      "en",
      createElement(Receipt, {
        studio: studioWith({
          prepared: SEALED_PREPARED,
          sealed: { on: true, includePrompt: false, file: HELD, saved: false },
        }),
      }),
    );

    expect(markup).toContain(en.studio.sealed.receipt.label);
    expect(markup).toContain(en.studio.sealed.receipt.detail);
    expect(markup).toContain("bafkreimeta");
    expect(markup).toContain(en.studio.sealed.handback.save);
    expect(markup).toContain(en.studio.sealed.handback.only);
    expect(markup).not.toContain(en.studio.receipt.pinned);
    expect(markup).not.toContain("pixels");
  });

  it("offers nothing to save once the browser no longer holds the file", () => {
    const markup = render(
      "en",
      createElement(Receipt, { studio: studioWith({ prepared: SEALED_PREPARED }) }),
    );
    expect(markup).toContain(en.studio.sealed.receipt.label);
    expect(markup).not.toContain(en.studio.sealed.handback.save);
  });
});

describe("what a refused sealed registration says", () => {
  for (const key of ["sealedMismatch", "sealedNotHeld", "sealedRecordRefused", "sealedFileRefused"] as const) {
    it(`prints the ${key} sentence with one thing to do next`, () => {
      const markup = render(
        "en",
        createElement(RegisterPanel, {
          state: sealedState({ failure: { key, next: "again" } }),
          ...uploadHandlers,
        }),
      );
      expect(markup).toContain(en.studio.failure[key]);
      expect(markup).toContain(en.studio.actions.again);

      const tamil = render(
        "ta",
        createElement(RegisterPanel, {
          state: sealedState({ failure: { key, next: "again" } }),
          ...uploadHandlers,
        }),
      );
      expect(tamil).toContain(ta.studio.failure[key]);
    });
  }
});
