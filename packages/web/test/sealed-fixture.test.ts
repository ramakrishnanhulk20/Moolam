import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import { RegisterPanel } from "@/components/studio/RegisterPanel";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { initialRegisterState, type RegisterState } from "@/lib/studio/flow";
import type { SealedHandback } from "@/lib/sealed/handback";
import type { GenerateResponse, PrepareResponse } from "@/lib/verifier/client";

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
}));

/**
 * The three sealed states of the two panels, rendered to markup a browser can
 * be pointed at.
 *
 * The studio itself is behind a sign in, so these screens cannot be reached on
 * the dev server without a creator's own passkey. What can be done instead is to put the
 * real markup, with the real stylesheet, in front of a real browser and measure
 * it: the width it takes at 375 px and what the panels do in both themes.
 *
 * Run with SEALED_FIXTURE=1 to write the fragment to the file named below.
 */
function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;

  return renderToStaticMarkup(
    createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node),
  );
}

const NOOP = () => undefined;
const PASSPORT = `0x${"ab".repeat(32)}` as const;
const BLOCKHASH = "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0" as const;

const HELD: SealedHandback = {
  name: "a-morning-abababab.jpg",
  type: "image/jpeg",
  blob: new Blob([new Uint8Array([1, 2, 3]) as BlobPart], { type: "image/jpeg" }),
  sha256: PASSPORT,
  size: 2_431_004,
};

const PREPARED = {
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

const DRAWN = {
  ...PREPARED,
  passport: { ...PREPARED.passport, creator: `0x${"11".repeat(20)}`, deadline: "1788878733", kind: 0 },
  generatorSig: `0x${"cd".repeat(65)}`,
  model: "gpt-image-1",
  agent: { id: "10249", wallet: `0x${"a3".repeat(20)}` },
  quota: { used: 1, limit: 3, resetsAt: 1788961533 },
} as unknown as GenerateResponse;

function state(over: Partial<RegisterState> = {}): RegisterState {
  return {
    ...initialRegisterState,
    title: "Monsoon nets, Kovalam",
    prompt: "a fishing boat at first light off the Coromandel coast",
    ...over,
    sealed: { on: true, includePrompt: false, file: null, saved: false, ...(over.sealed ?? {}) },
  };
}

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

describe("the sealed panels as a browser will lay them out", () => {
  it("renders the switch open, the file in hand and the done screen", () => {
    const scenes: Array<[string, string]> = [
      [
        "The switch on, before anything is sent",
        render(createElement(RegisterPanel, { state: state(), ...uploadHandlers })),
      ],
      [
        "The file handed back, before the unlock",
        render(
          createElement(RegisterPanel, {
            state: state({
              prepared: PREPARED,
              steps: { ...initialRegisterState.steps, prepare: "done" },
              sealed: { on: true, includePrompt: false, file: HELD, saved: false },
            }),
            ...uploadHandlers,
          }),
        ),
      ],
      [
        "Registered, sealed",
        render(
          createElement(RegisterPanel, {
            state: state({
              prepared: PREPARED,
              steps: { ...initialRegisterState.steps, prepare: "done", sign: "done", send: "done" },
              block: 103_059_393n,
              registeredAt: 1_788_876_542_000,
              txHash: `0x${"ef".repeat(32)}`,
              sealed: { on: true, includePrompt: false, file: HELD, saved: false },
            }),
            ...uploadHandlers,
          }),
        ),
      ],
      [
        "The agent path, switch on, prompt left out",
        render(
          createElement(GeneratePanel, {
            state: state({ prepared: DRAWN, generated: DRAWN, quota: DRAWN.quota }),
            ...agentHandlers,
          }),
        ),
      ],
    ];

    for (const [, markup] of scenes) {
      expect(markup.length).toBeGreaterThan(500);
    }

    if (process.env.SEALED_FIXTURE === "1") {
      const body = scenes
        .map(
          ([caption, markup]) =>
            `<section class="fixture-scene"><p class="fixture-caption">${caption}</p>${markup}</section>`,
        )
        .join("\n");
      writeFileSync(
        fileURLToPath(new URL("../../../kitchen/reports/WO-116-fixture.html", import.meta.url)),
        body,
        "utf8",
      );
    }
  });
});
