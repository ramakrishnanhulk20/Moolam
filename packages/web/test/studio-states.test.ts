import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import { StatusBand } from "@/components/studio/StatusBand";
import { WALLET_GRACE_MS, walletState } from "@/lib/studio/binding";
import { confirmRegister } from "@/lib/studio/confirm";
import {
  accountChanged,
  initialRegisterState,
  isBusy,
  isRegistered,
  measure,
  registerReducer,
  type RegisterAction,
  type RegisterState,
} from "@/lib/studio/flow";
import { INDEX_CATCH_UP_MS, nextLook } from "@/lib/studio/useCreatorPassports";
import type { GenerateResponse, PrepareResponse } from "@/lib/verifier/client";

/**
 * The Studio's in-between states: the account opening after a sign in, the
 * receipt's confirmation time, a run that stops between two steps, and a second
 * account on the same tab. None of these can be photographed without a
 * creator's own passkey, so each is proved here on the code that decides it.
 */

const reads = vi.hoisted(() => ({
  getPassport: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  passportRegistration: vi.fn(),
  activeSource: vi.fn(() => "envio"),
}));

vi.mock("@/lib/chain/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chain/client")>()),
  chain: { waitForTransactionReceipt: reads.waitForTransactionReceipt },
}));

vi.mock("@/lib/chain/registry", () => ({
  bindNonce: vi.fn(),
  getPasskey: vi.fn(),
  getPassport: reads.getPassport,
}));

vi.mock("@/lib/data/passports", () => ({
  passportRegistration: reads.passportRegistration,
  passportsByCreator: vi.fn(),
}));

vi.mock("@/lib/data/source", () => ({ activeSource: reads.activeSource }));

const ID = `0x${"ab".repeat(32)}` as Hex;
const TX = `0x${"ef".repeat(32)}` as Hex;
const DIGEST = `0x${"cd".repeat(32)}` as Hex;
const FIRST = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;
const SECOND = "0x1111111111111111111111111111111111111111" as Hex;

const PREPARED: PrepareResponse = {
  passport: {
    exactHash: ID,
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

function walk(from: RegisterState, actions: RegisterAction[]): RegisterState {
  return actions.reduce(registerReducer, from);
}

function band(state: RegisterState): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    children?: ReactElement;
  }>;
  return renderToStaticMarkup(
    createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, createElement(StatusBand, { state })),
  );
}

describe("the account after a sign in", () => {
  it("reads as opening while Privy's wallet list is not ready, with or without a wallet in it", () => {
    expect(walletState({ walletsReady: false, embedded: false, graceOver: false })).toBe("opening");
    expect(walletState({ walletsReady: false, embedded: false, graceOver: true })).toBe("opening");
    expect(walletState({ walletsReady: false, embedded: true, graceOver: false })).toBe("opening");
  });

  it("is ready once the list holds the wallet Privy made", () => {
    expect(walletState({ walletsReady: true, embedded: true, graceOver: false })).toBe("ready");
    expect(walletState({ walletsReady: true, embedded: true, graceOver: true })).toBe("ready");
  });

  it("is still opening while a first sign in makes the wallet, and missing only past the grace period", () => {
    expect(walletState({ walletsReady: true, embedded: false, graceOver: false })).toBe("opening");
    expect(walletState({ walletsReady: true, embedded: false, graceOver: true })).toBe("missing");
    expect(WALLET_GRACE_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe("the receipt's confirmation time", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    reads.activeSource.mockReturnValue("envio");
  });

  it("is stamped when Monad shows the passport, not after the index is asked for the transaction", async () => {
    // Monad holds the passport on the first read. The wallet gave no hash, so
    // the index is asked for one, and it takes five more seconds to have it.
    reads.getPassport.mockResolvedValue({ id: ID, registeredAt: 1_788_876_542n });
    reads.passportRegistration
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ registeredBlock: 7n, txHash: TX });

    const handedAt = performance.now();
    const confirming = confirmRegister({ exactHash: ID, hash: "" });
    await vi.advanceTimersByTimeAsync(10_000);
    const landed = await confirming;
    const resolvedAt = performance.now();

    expect(landed.hash).toBe(TX);
    expect(resolvedAt - handedAt).toBeGreaterThanOrEqual(5_000);
    expect(landed.answeredAt - handedAt).toBeLessThan(1_000);

    const timing = measure({ handedAt, answeredAt: landed.answeredAt, tappedAt: Date.now(), sealedAt: undefined });
    expect(timing.waitedMs).toBeLessThan(1_000);
  });
});

describe("a run that stops between two steps", () => {
  const file = new File(["x"], "a-morning.jpg", { type: "image/jpeg" });

  it("ends the upload run failed when the sealed file does not come back right", () => {
    const state = walk(initialRegisterState, [
      { type: "choose", file },
      { type: "title", title: "A morning" },
      { type: "start", step: "prepare" },
      { type: "prepared", prepared: PREPARED },
      { type: "failed", failure: { key: "sealedMismatch", next: "again" }, stage: "prepare", step: "prepare" },
    ]);

    expect(state.steps.prepare).toBe("failed");
    expect(isBusy(state)).toBe(false);

    const markup = band(state);
    expect(markup).toContain('data-tone="failed"');
    expect(markup).not.toContain("animate-pulse");
    expect(markup).toContain(en.studio.register.steps.prepare.failed);
  });

  it("ends the agent run failed when the agent signed for another account", () => {
    const state = walk(initialRegisterState, [
      { type: "mode", mode: "generate" },
      { type: "title", title: "A harbour" },
      { type: "prompt", prompt: "a harbour at first light" },
      { type: "start", step: "draw" },
      { type: "drawn", response: DRAWN },
      { type: "failed", failure: { key: "creatorMismatch", next: "signOut" }, stage: "prepare", step: "agentSign" },
    ]);

    expect(state.steps.agentSign).toBe("failed");
    expect(isBusy(state)).toBe(false);

    const markup = band(state);
    expect(markup).toContain('data-tone="failed"');
    expect(markup).not.toContain("animate-pulse");
    expect(markup).toContain(en.studio.generate.steps.agentSign.failed);
  });

  it("ends the agent run failed when its sealed file does not come back right", () => {
    const state = walk(initialRegisterState, [
      { type: "mode", mode: "generate" },
      { type: "start", step: "draw" },
      { type: "drawn", response: DRAWN },
      { type: "failed", failure: { key: "sealedNotHeld", next: "again" }, stage: "prepare", step: "pin" },
    ]);

    expect(state.steps.pin).toBe("failed");
    expect(band(state)).toContain('data-tone="failed"');
  });

  it("marks the running row and not the named one when a row is running", () => {
    const state = walk(initialRegisterState, [
      { type: "start", step: "prepare" },
      { type: "prepared", prepared: PREPARED },
      { type: "start", step: "sign" },
      { type: "failed", failure: { key: "passkeyCancelled" }, stage: "sign", step: "prepare" },
    ]);

    expect(state.steps).toMatchObject({ prepare: "done", sign: "failed", send: "waiting" });
  });

  it("clears the red row when the creator tries again, so the retry runs under a live band", () => {
    const failed = walk(initialRegisterState, [
      { type: "mode", mode: "generate" },
      { type: "start", step: "draw" },
      { type: "drawn", response: DRAWN },
      { type: "failed", failure: { key: "sealedMismatch", next: "again" }, stage: "prepare", step: "pin" },
    ]);
    const again = registerReducer(failed, { type: "start", step: "draw" });

    expect(again.steps).toMatchObject({ draw: "running", pin: "waiting" });
    expect(band(again)).toContain('data-tone="running"');
  });
});

describe("another account on the same tab", () => {
  const file = new File(["x"], "a-morning.jpg", { type: "image/jpeg" });

  it("counts a different account as a change, and a sign out on its own as none", () => {
    expect(accountChanged(FIRST, SECOND)).toBe(true);
    expect(accountChanged(FIRST, undefined)).toBe(false);
    expect(accountChanged(undefined, SECOND)).toBe(false);
    expect(accountChanged(FIRST, FIRST.toLowerCase() as Hex)).toBe(false);
  });

  it("clears the finished run and keeps only which panel was open", () => {
    const finished = walk(initialRegisterState, [
      { type: "mode", mode: "generate" },
      { type: "choose", file },
      { type: "title", title: "A morning" },
      { type: "start", step: "draw" },
      { type: "drawn", response: DRAWN },
      { type: "start", step: "sign" },
      { type: "signed", digest: DIGEST },
      { type: "start", step: "send" },
      { type: "sent", txHash: TX },
      { type: "watching" },
      { type: "confirmed", block: 103_059_393n, at: 1_788_876_542_000 },
    ]);
    expect(isRegistered(finished)).toBe(true);

    const cleared = registerReducer(finished, { type: "account" });

    expect(isRegistered(cleared)).toBe(false);
    expect(cleared).toEqual({ ...initialRegisterState, mode: "generate" });
    expect(cleared.txHash).toBeNull();
    expect(cleared.quota).toBeNull();
    expect(cleared.title).toBe("");
  });
});

describe("the grid waiting on the index", () => {
  it("looks again at 1, 2, 4, 8 and then every 16 seconds, and stops once the minute is up", () => {
    expect([0, 1, 2, 3, 4, 5].map((attempt) => nextLook(attempt, 0))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 16_000,
    ]);
    expect(nextLook(5, INDEX_CATCH_UP_MS - 20_000)).toBe(16_000);
    expect(nextLook(5, INDEX_CATCH_UP_MS - 10_000)).toBeNull();
    expect(INDEX_CATCH_UP_MS).toBe(60_000);
  });
});
