// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Hex } from "viem";
import { hasStarted } from "@/components/studio/press";
import { isBusy } from "@/lib/studio/flow";
import type { Studio } from "@/lib/studio/useStudio";
import { verifierUrl } from "@/lib/verifier/client";

/**
 * The press on the agent path, driven through the real studio hook, when the
 * verify service has no /generate (WO-300).
 *
 * The wallet, the passkey and the chain are stood in for and the service is a
 * stubbed fetch, so the hook's own call to /generate is the real one. What is
 * held: a 404 or a closed route ends the run on the one line with nothing
 * signed and nothing sent, and every other refusal keeps the sentence it had.
 * The failures with no retry (the agent off, the day's quota, a refused prompt)
 * each hand back a way on that needs no reload (WO-311).
 */

const WALLET = "0x85a88Ca81Ff5F681D96AB86fA60ccB8452a139a6" as Hex;
const DIGEST = vi.hoisted(() => `0x${"cd".repeat(32)}` as Hex);

const privy = vi.hoisted(() => ({ sendTransaction: vi.fn(), logout: vi.fn(), wallets: [] as unknown[] }));
const chainCalls = vi.hoisted(() => ({ call: vi.fn(), getBalance: vi.fn(), getTransactionReceipt: vi.fn() }));
const passkey = vi.hoisted(() => ({ signDigest: vi.fn() }));

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({
    ready: true,
    authenticated: true,
    user: { email: { address: "ram@example.com" } },
    login: () => undefined,
    logout: privy.logout,
    getAccessToken: async () => "token-123",
  }),
  useWallets: () => ({ wallets: privy.wallets }),
  useSendTransaction: () => ({ sendTransaction: privy.sendTransaction }),
}));

vi.mock("next/cache", () => ({ unstable_cache: (fn: (...args: unknown[]) => Promise<unknown>) => fn }));

vi.mock("@/lib/chain/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chain/client")>()),
  chain: chainCalls,
}));

vi.mock("@/lib/chain/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chain/registry")>()),
  getPassport: vi.fn().mockResolvedValue(null),
  hashPassport: vi.fn().mockResolvedValue(DIGEST),
}));

vi.mock("@/lib/chain/time", () => ({ deadlineFromChain: async () => 1_788_878_733n }));

vi.mock("@/lib/passkey/browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/passkey/browser")>()),
  signDigest: passkey.signDigest,
  rememberCredential: () => undefined,
}));

vi.mock("@/lib/studio/wallet", () => ({ ensureMonad: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/lib/studio/usePasskeyBinding", () => ({
  usePasskeyBinding: () => ({
    status: "bound",
    passkey: { qx: `0x${"aa".repeat(32)}`, qy: `0x${"bb".repeat(32)}` },
    credentialId: new Uint8Array([1, 2, 3]),
    error: null,
    refresh: () => undefined,
    remember: () => undefined,
  }),
}));

vi.mock("@/lib/studio/useCreatorPassports", () => ({
  useCreatorPassports: () => ({ status: "ready", passports: [], error: null, refresh: () => undefined }),
}));

const { useStudio } = await import("@/lib/studio/useStudio");

async function mount(): Promise<{ read: () => Studio }> {
  const seen: { current: Studio | null } = { current: null };

  function Probe() {
    seen.current = useStudio("generate");
    return null;
  }

  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(createElement(Probe));
  });

  return {
    read: () => {
      if (seen.current === null) {
        throw new Error("the probe never rendered");
      }
      return seen.current;
    },
  };
}

/** The service answering a POST to /generate with this status and body. */
function serviceAnswers(status: number, body: unknown) {
  const stub = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>(async () => ({ ok: status < 400, status, json: async () => body }));
  vi.stubGlobal("fetch", stub);
  return stub;
}

async function pressGenerate(studio: { read: () => Studio }): Promise<void> {
  await act(async () => {
    studio.read().actions.setTitle("His Dream");
    studio.read().actions.setPrompt("a fishing boat leaving a harbour at first light");
  });
  await act(async () => {
    await studio.read().actions.generateImage();
  });
}

beforeEach(() => {
  privy.wallets = [{ address: WALLET, walletClientType: "privy" }];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("pressing the agent when the service has no /generate", () => {
  it("ends on the one line for a 404, with nothing signed and nothing sent", async () => {
    const service = serviceAnswers(404, { error: "no route for POST /generate" });
    const studio = await mount();
    expect(studio.read().register.mode).toBe("generate");
    await pressGenerate(studio);

    const [url, init] = service.mock.calls[0];
    expect(url).toBe(verifierUrl("/generate"));
    expect(init?.method).toBe("POST");
    expect(studio.read().register.failure).toEqual({ key: "agentOff", next: "openUpload" });
    expect(studio.read().register.steps.draw).toBe("failed");
    expect(passkey.signDigest).not.toHaveBeenCalled();
    expect(privy.sendTransaction).not.toHaveBeenCalled();
  });

  it("ends on the same line for a host whose registry check has not passed", async () => {
    serviceAnswers(503, { error: "generator-unchecked", reason: "the registry on chain has not been read yet" });
    const studio = await mount();
    await pressGenerate(studio);
    expect(studio.read().register.failure).toEqual({ key: "agentOff", next: "openUpload" });
  });

  it("keeps the quota sentence, and the count that came with it, for a spent day", async () => {
    serviceAnswers(429, { error: "quota", quota: { used: 3, limit: 3, resetsAt: 1_788_961_533 } });
    const studio = await mount();
    await pressGenerate(studio);
    expect(studio.read().register.failure).toEqual({ key: "quotaReached", next: "openUpload" });
    expect(studio.read().register.quota).toEqual({ used: 3, limit: 3, resetsAt: 1_788_961_533 });
  });

  it("keeps the retry for a model that failed, named for the drawing it would spend", async () => {
    serviceAnswers(502, { error: "model-failed" });
    const studio = await mount();
    await pressGenerate(studio);
    expect(studio.read().register.failure).toMatchObject({ key: "modelFailed", next: "generateAgain" });
  });

  it("keeps the offline sentence when the service does not answer at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const studio = await mount();
    await pressGenerate(studio);
    expect(studio.read().register.failure).toMatchObject({ key: "serviceOffline", next: "generateAgain" });
  });
});

const PROMPT = "a fishing boat leaving a harbour at first light";

/** Nothing running and nothing done: the form is open and the switch is free. */
function formIsOpen(studio: { read: () => Studio }): void {
  const { register } = studio.read();
  expect(register.failure).toBeNull();
  expect(Object.values(register.steps)).toEqual(Array(6).fill("waiting"));
  expect(hasStarted(register)).toBe(false);
  expect(isBusy(register)).toBe(false);
}

/** Still the same signed in creator, and not one passkey prompt or one send behind the press. */
function noOneWasAsked(studio: { read: () => Studio }): void {
  expect(studio.read().authenticated).toBe(true);
  expect(studio.read().wallet).toBe(WALLET);
  expect(privy.logout).not.toHaveBeenCalled();
  expect(passkey.signDigest).not.toHaveBeenCalled();
  expect(privy.sendTransaction).not.toHaveBeenCalled();
}

describe("the way on from a failed agent run, with no reload", () => {
  it("opens the upload form after the agent is off, still signed in and with nothing signed or sent", async () => {
    const service = serviceAnswers(404, { error: "no route for POST /generate" });
    const studio = await mount();
    await pressGenerate(studio);
    expect(studio.read().register.failure?.next).toBe("openUpload");
    expect(hasStarted(studio.read().register)).toBe(true);

    await act(async () => {
      studio.read().actions.openUpload();
    });

    formIsOpen(studio);
    expect(studio.read().register.mode).toBe("upload");
    // What was typed is still there for the upload form to use.
    expect(studio.read().register.title).toBe("His Dream");
    expect(studio.read().register.prompt).toBe(PROMPT);
    noOneWasAsked(studio);
    expect(service).toHaveBeenCalledTimes(1);
  });

  it("opens the upload form after a spent day, and keeps the count the service gave", async () => {
    serviceAnswers(429, { error: "quota", quota: { used: 3, limit: 3, resetsAt: 1_788_961_533 } });
    const studio = await mount();
    await pressGenerate(studio);
    expect(studio.read().register.failure).toEqual({ key: "quotaReached", next: "openUpload" });

    await act(async () => {
      studio.read().actions.openUpload();
    });

    formIsOpen(studio);
    expect(studio.read().register.mode).toBe("upload");
    expect(studio.read().register.quota).toEqual({ used: 3, limit: 3, resetsAt: 1_788_961_533 });
    noOneWasAsked(studio);
  });

  it("brings the agent form back after a refused prompt, with the prompt, the title and the switches as they were", async () => {
    const service = serviceAnswers(400, { error: "prompt-refused", reason: "the safety system said no" });
    const studio = await mount();
    await act(async () => {
      studio.read().actions.setSealed(true, true);
    });
    await pressGenerate(studio);
    expect(studio.read().register.failure).toEqual({
      key: "promptRefused",
      reason: "the safety system said no",
      next: "editPrompt",
    });

    await act(async () => {
      studio.read().actions.editPrompt();
    });

    formIsOpen(studio);
    const { register } = studio.read();
    expect(register.mode).toBe("generate");
    expect(register.prompt).toBe(PROMPT);
    expect(register.title).toBe("His Dream");
    expect(register.sealed).toMatchObject({ on: true, privateRecheck: true, file: null });
    noOneWasAsked(studio);
    expect(service).toHaveBeenCalledTimes(1);
  });

  it("lets the reopened form be pressed again, so nothing is left held from the refused run", async () => {
    serviceAnswers(400, { error: "prompt-refused", reason: "the safety system said no" });
    const studio = await mount();
    await pressGenerate(studio);
    await act(async () => {
      studio.read().actions.editPrompt();
      studio.read().actions.setPrompt("a fishing boat at first light, no people in it");
    });

    const again = serviceAnswers(502, { error: "model-failed" });
    await act(async () => {
      await studio.read().actions.generateImage();
    });
    expect(again).toHaveBeenCalledTimes(1);
    expect(studio.read().register.failure).toMatchObject({ key: "modelFailed", next: "generateAgain" });
  });

  it("leaves every failure that already had a retry on the retry it had", async () => {
    for (const [status, body, key] of [
      [502, { error: "model-failed" }, "modelFailed"],
      [503, { error: "busy" }, "agentBusy"],
      [401, { error: "unauthorized" }, "signedOut"],
    ] as const) {
      serviceAnswers(status, body);
      const studio = await mount();
      await pressGenerate(studio);
      const failure = studio.read().register.failure;
      expect(failure?.key, key).toBe(key);
      expect(["generateAgain", "signIn"], key).toContain(failure?.next);
      document.body.innerHTML = "";
    }
  });
});
