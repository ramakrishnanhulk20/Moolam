import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import { DoneActions } from "@/components/studio/DoneActions";
import { RegisterPanel } from "@/components/studio/RegisterPanel";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { hasStarted, scrollTarget } from "@/components/studio/press";
import {
  initialRegisterState,
  registerReducer,
  type RegisterAction,
  type RegisterState,
} from "@/lib/studio/flow";
import type { SealedHandback } from "@/lib/sealed/handback";
import type { GenerateResponse, PrepareResponse } from "@/lib/verifier/client";
import { STUDIO_KEYS, countsBySaying } from "./studio-keys.mjs";

/**
 * The studio as one box: a press folds the form into a band, the run grows under
 * it, and the receipt and the two buttons end it.
 *
 * Every state here is built by running the real reducer through the real
 * actions, in the order useStudio dispatches them, because a hand-written state
 * can hold a pose the flow can never be in. Nothing in this file talks to Monad
 * or to the verify service: the two answers those give back are fixtures, and a
 * signed-in run cannot be driven on a dev server without Ram's own passkey.
 */

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

function render(node: ReactElement, locale: "en" | "ta" = "en"): string {
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
const PASSPORT = `0x${"ab".repeat(32)}` as Hex;
const DIGEST = `0x${"cd".repeat(32)}` as Hex;
const TX = `0x${"ef".repeat(32)}` as Hex;

const PREPARED: PrepareResponse = {
  passport: {
    exactHash: PASSPORT,
    parentId: `0x${"00".repeat(32)}` as Hex,
    generatorAgentId: "0",
    phash: "7840506850305415717",
    blockhash256: `0x${"6b1f0e".repeat(10)}92` as Hex,
    manifestHash: `0x${"22".repeat(32)}` as Hex,
    kind: 1,
    fingerprintVersion: 1,
    metadataURI: "ipfs://bafkreimeta",
  },
  image: {
    cid: "bafybeigimage",
    uri: "ipfs://bafybeigimage",
    gatewayUrl: "https://gateway.test/bafybeigimage",
    bytes: 2_140_992,
    width: 1600,
    height: 1200,
  },
  thumbnail: { cid: "bafybeigthumb", uri: "ipfs://bafybeigthumb", gatewayUrl: "https://gateway.test/thumb" },
  metadata: { cid: "bafkreimeta", uri: "ipfs://bafkreimeta" },
  manifest: { embedded: true },
  preparedBy: "did:privy:test",
};

const DRAWN: GenerateResponse = {
  passport: { ...PREPARED.passport, kind: 0, generatorAgentId: "10249", deadline: "1790000000" },
  generatorSig: `0x${"cd".repeat(65)}` as Hex,
  image: PREPARED.image,
  thumbnail: PREPARED.thumbnail,
  metadata: PREPARED.metadata,
  manifest: { embedded: true },
  model: "gpt-image-1",
  agent: { id: "10249", wallet: "0xa37418c4047Fb6A42150D6E9Ddab77580Ddb9AFb" as Hex },
  quota: { used: 1, limit: 3, resetsAt: 1_788_961_533 },
  preparedBy: "did:privy:test",
};

const HELD: SealedHandback = {
  name: "a-morning-abababab.jpg",
  type: "image/jpeg",
  blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff]) as BlobPart], { type: "image/jpeg" }),
  sha256: PASSPORT,
  size: 2_400_000,
};

/** The reducer, run through the actions useStudio dispatches, in that order. */
function walk(from: RegisterState, actions: RegisterAction[]): RegisterState {
  return actions.reduce(registerReducer, from);
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

function upload(actions: RegisterAction[]): RegisterState {
  return walk(initialRegisterState, [
    { type: "choose", file: new File(["x"], "a-morning.jpg", { type: "image/jpeg" }) },
    { type: "title", title: "A morning" },
    ...actions,
  ]);
}

function agent(actions: RegisterAction[]): RegisterState {
  return walk(initialRegisterState, [
    { type: "mode", mode: "generate" },
    { type: "title", title: "A harbour" },
    { type: "prompt", prompt: "a harbour at first light" },
    ...actions,
  ]);
}

const STARTED: RegisterAction[] = [
  { type: "start", step: "prepare" },
  { type: "prepared", prepared: PREPARED },
  { type: "start", step: "sign" },
  { type: "signed", digest: DIGEST },
  { type: "start", step: "send" },
  { type: "sent", txHash: TX },
  { type: "watching" },
];

const REGISTERED: RegisterAction[] = [...STARTED, { type: "confirmed", block: 103_059_393n, at: Date.now() }];

describe("where the page goes after a press", () => {
  const BAR = 102;
  const TALL = 900;

  it("leaves the page alone when the box is already under the bar", () => {
    expect(scrollTarget(BAR, BAR, TALL)).toBeNull();
    expect(scrollTarget(200, BAR, TALL)).toBeNull();
    expect(scrollTarget(TALL / 3, BAR, TALL)).toBeNull();
  });

  it("lifts a box whose top is below the fold to sixteen px under the bar", () => {
    expect(scrollTarget(820, BAR, TALL)).toBe(820 - BAR - 16);
  });

  it("brings a box that has gone above the bar back down", () => {
    expect(scrollTarget(-420, BAR, TALL)).toBe(-420 - BAR - 16);
  });
});

describe("what folds the form away", () => {
  it("waits for the run itself, not for a file or a title", () => {
    expect(hasStarted(initialRegisterState)).toBe(false);
    expect(hasStarted(upload([]))).toBe(false);
    expect(hasStarted(upload([{ type: "start", step: "prepare" }]))).toBe(true);
    expect(hasStarted(upload(REGISTERED))).toBe(true);
  });

  it("reads the agent path by its own steps", () => {
    expect(hasStarted(agent([]))).toBe(false);
    expect(hasStarted(agent([{ type: "start", step: "draw" }]))).toBe(true);
  });
});

describe("the one box", () => {
  it("holds the form, the stub under it and no second column", () => {
    const markup = render(
      createElement(RegisterPanel, {
        state: upload([]),
        receipt: createElement("p", null, "the stub"),
        ...uploadHandlers,
      }),
    );
    expect(markup).toContain('data-studio-panel="upload"');
    expect(markup).toContain('data-face="form"');
    expect(markup).toContain("the stub");
    expect(markup).not.toContain("data-studio-band");
  });

  it("keeps the stub in the same box once the run is out, and once it has landed", () => {
    for (const actions of [STARTED, REGISTERED]) {
      const markup = render(
        createElement(RegisterPanel, {
          state: upload(actions),
          receipt: createElement("p", null, "the stub"),
          ...uploadHandlers,
        }),
      );
      expect(markup).toContain("data-studio-band");
      expect(markup).toContain("the stub");
      expect(markup).not.toContain(en.studio.register.submit);
    }
  });

  it("ends a landed run with the passport and Make another, after the stub", () => {
    const markup = render(
      createElement(RegisterPanel, {
        state: upload(REGISTERED),
        receipt: createElement("p", null, "the stub"),
        ...uploadHandlers,
      }),
    );
    expect(markup).toContain(en.studio.register.doneHeading);
    expect(markup).toContain(en.studio.register.openPassport);
    expect(markup).toContain(en.studio.register.another);
    expect(markup.indexOf("the stub")).toBeLessThan(markup.indexOf("data-done-actions"));
  });
});

describe("the band, at every state the flow can hold", () => {
  const steps = en.studio.register.steps;

  const poses: { name: string; actions: RegisterAction[]; word: string }[] = [
    { name: "preparing", actions: [{ type: "start", step: "prepare" }], word: steps.prepare.running },
    {
      name: "signing",
      actions: [{ type: "start", step: "prepare" }, { type: "prepared", prepared: PREPARED }, { type: "start", step: "sign" }],
      word: steps.sign.running,
    },
    { name: "watching", actions: STARTED, word: steps.send.watching },
    { name: "written", actions: REGISTERED, word: steps.send.done },
    {
      name: "prepare failed",
      actions: [{ type: "start", step: "prepare" }, { type: "failed", failure: { key: "serviceOffline" } }],
      word: steps.prepare.failed,
    },
    {
      name: "send unconfirmed",
      actions: [...STARTED, { type: "failed", failure: { key: "confirmPending", next: "recheck" } }],
      word: steps.send.pending,
    },
  ];

  for (const pose of poses) {
    it(`says ${pose.name} in the studio's own words`, () => {
      const markup = render(createElement(RegisterPanel, { state: upload(pose.actions), ...uploadHandlers }));
      expect(markup).toContain("data-studio-band");
      expect(markup).toContain(pose.word);
      // The name and what it was made from ride along with it.
      expect(markup).toContain("A morning");
    });
  }

  it("carries the agent's five steps the same way, and names the model once it is known", () => {
    const drawing = agent([{ type: "start", step: "draw" }]);
    expect(render(createElement(GeneratePanel, { state: drawing, ...agentHandlers }))).toContain(
      en.studio.generate.steps.draw.running,
    );

    const signed = agent([
      { type: "start", step: "draw" },
      { type: "drawn", response: DRAWN },
      { type: "start", step: "sign" },
    ]);
    const markup = render(createElement(GeneratePanel, { state: signed, ...agentHandlers }));
    expect(markup).toContain("data-studio-band");
    expect(markup).toContain(en.studio.generate.steps.sign.running);
    expect(markup).toContain("gpt-image-1");

    const watching = walk(signed, [
      { type: "signed", digest: DIGEST },
      { type: "start", step: "send" },
      { type: "watching" },
    ]);
    expect(render(createElement(GeneratePanel, { state: watching, ...agentHandlers }))).toContain(
      en.studio.generate.steps.send.watching,
    );
  });

  it("still reads written while the statement about AI use is out behind it", () => {
    const stating = walk(upload(REGISTERED), [{ type: "stating" }]);
    const markup = render(createElement(RegisterPanel, { state: stating, ...uploadHandlers }));
    expect(markup).toContain(steps.send.done);
    expect(markup).toContain(en.studio.register.doneHeading);
  });

  it("keeps every failure's own next step on the screen under the band", () => {
    const offline = upload([{ type: "start", step: "prepare" }, { type: "failed", failure: { key: "serviceOffline" } }]);
    expect(render(createElement(RegisterPanel, { state: offline, ...uploadHandlers }))).toContain(
      en.studio.actions.again,
    );

    const pending = upload([...STARTED, { type: "failed", failure: { key: "confirmPending", next: "recheck" } }]);
    expect(
      render(createElement(RegisterPanel, { state: pending, ...uploadHandlers, onRecheck: NOOP })),
    ).toContain(en.studio.actions.recheck);

    const unsponsored = upload([
      ...STARTED.slice(0, 5),
      { type: "failed", failure: { key: "sponsorshipSpent", next: "unsponsored" } },
    ]);
    expect(render(createElement(RegisterPanel, { state: unsponsored, ...uploadHandlers }))).toContain(
      en.studio.actions.unsponsored,
    );
  });
});

describe("the chip on the band", () => {
  it("says both of its faces in ten languages", () => {
    for (const { path, count } of countsBySaying()) {
      expect(count, path).toBe(10);
    }
    expect(STUDIO_KEYS).toContain("studio.sealed.plate.public");
  });

  it("reads the word rather than carrying an English one, in English and in Tamil", () => {
    const kept = walk(upload(STARTED), [{ type: "sealed", on: true }]);
    expect(render(createElement(RegisterPanel, { state: kept, ...uploadHandlers }))).toContain(
      en.studio.sealed.plate.sealed,
    );
    expect(render(createElement(RegisterPanel, { state: kept, ...uploadHandlers }), "ta")).toContain(
      ta.studio.sealed.plate.sealed,
    );

    const open = upload(STARTED);
    expect(render(createElement(RegisterPanel, { state: open, ...uploadHandlers }))).toContain(
      en.studio.sealed.plate.public,
    );
    expect(render(createElement(RegisterPanel, { state: open, ...uploadHandlers }), "ta")).toContain(
      ta.studio.sealed.plate.public,
    );
  });
});

describe("make another", () => {
  it("refuses while the only copy of a sealed picture has not been saved", () => {
    const held = walk(upload(REGISTERED), [{ type: "sealed", on: true }, { type: "sealedFile", file: HELD }]);
    const markup = render(createElement(DoneActions, { state: held, onReset: NOOP }));
    expect(markup).toContain(en.studio.sealed.handback.only);
    expect(after(markup, "data-again")).toContain('disabled=""');

    const saved = walk(held, [{ type: "sealedSaved" }]);
    const open = render(createElement(DoneActions, { state: saved, onReset: NOOP }));
    expect(open).not.toContain(en.studio.sealed.handback.only);
    expect(after(open, "data-again")).not.toContain('disabled=""');
  });

  it("refuses while a statement is still out from the same wallet", () => {
    const stating = walk(upload(REGISTERED), [{ type: "stating" }]);
    expect(after(render(createElement(DoneActions, { state: stating, onReset: NOOP })), "data-again")).toContain(
      'disabled=""',
    );
  });

  it("is named for the path it will open again", () => {
    expect(render(createElement(DoneActions, { state: upload(REGISTERED), onReset: NOOP }))).toContain(
      en.studio.register.another,
    );
    const drawn = agent([
      { type: "start", step: "draw" },
      { type: "drawn", response: DRAWN },
      { type: "start", step: "sign" },
      { type: "signed", digest: DIGEST },
      { type: "start", step: "send" },
      { type: "confirmed", block: 1n, at: Date.now() },
    ]);
    expect(render(createElement(DoneActions, { state: drawn, onReset: NOOP }))).toContain(en.studio.generate.another);
  });
});

/** The whole of the tag that carries this mark, which is where its disabled flag sits. */
function after(markup: string, mark: string): string {
  const at = markup.indexOf(mark);
  expect(at, mark).toBeGreaterThan(-1);
  return markup.slice(markup.lastIndexOf("<", at), markup.indexOf(">", at));
}
