// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Hex } from "viem";
import type { ConsentDraft } from "@/lib/consent/call";
import type { Studio } from "@/lib/studio/useStudio";
import { FINDINGS, pauses, preparedWith, type Finding } from "./studio-signing-fixtures";

/**
 * The pause before signing, driven through the real studio hook with the
 * wallet, the passkey and the verify service stood in for (WO-284b).
 *
 * An earlier passport or pages on the web stop the run after prepare, and the
 * passkey opens only on the creator's next press, over the same pinned fields
 * with no second prepare. "None" and "could not check" are drawn first and
 * the passkey follows without a press. Nothing here reaches a real service.
 */

const WALLET = "0x85a88Ca81Ff5F681D96AB86fA60ccB8452a139a6" as Hex;
const REGISTER_HASH = `0x${"ef".repeat(32)}` as Hex;
const DIGEST = vi.hoisted(() => `0x${"cd".repeat(32)}` as Hex);

const CLOSED: ConsentDraft = {
  consent: {
    aiTraining: "notAllowed",
    aiGenerativeTraining: "notAllowed",
    aiInference: "notAllowed",
    dataMining: "notAllowed",
  },
  constraintInfo: "",
};

const privy = vi.hoisted(() => ({ sendTransaction: vi.fn(), wallets: [] as unknown[] }));
const chainCalls = vi.hoisted(() => ({ call: vi.fn(), getBalance: vi.fn(), getTransactionReceipt: vi.fn() }));
const service = vi.hoisted(() => ({ prepare: vi.fn() }));
const waits = vi.hoisted(() => ({ confirmRegister: vi.fn(), confirmSetConsent: vi.fn() }));
const passkey = vi.hoisted(() => ({ signDigest: vi.fn() }));

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({
    ready: true,
    authenticated: true,
    user: { email: { address: "ram@example.com" } },
    login: () => undefined,
    logout: () => undefined,
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

vi.mock("@/lib/chain/digest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chain/digest")>()),
  localPassportDigest: () => DIGEST,
  assertDigestMatches: () => undefined,
}));

vi.mock("@/lib/chain/time", () => ({ deadlineFromChain: async () => 1_788_878_733n }));

vi.mock("@/lib/chain/calldata", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chain/calldata")>()),
  registerCalldata: () => "0xfeed" as Hex,
}));

vi.mock("@/lib/passkey/browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/passkey/browser")>()),
  signDigest: passkey.signDigest,
  rememberCredential: () => undefined,
}));

vi.mock("@/lib/passkey/verify", () => ({ checkAuth: async () => ({ ok: true }) }));

vi.mock("@/lib/verifier/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/verifier/client")>()),
  prepare: service.prepare,
}));

vi.mock("@/lib/studio/confirm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/studio/confirm")>()),
  confirmRegister: waits.confirmRegister,
}));

vi.mock("@/lib/consent/confirm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/consent/confirm")>()),
  confirmSetConsent: waits.confirmSetConsent,
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
    seen.current = useStudio();
    return null;
  }

  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(createElement(Probe));
  });

  const read = () => {
    if (seen.current === null) {
      throw new Error("the probe never rendered");
    }
    return seen.current;
  };
  return { read };
}

async function press(studio: { read: () => Studio }, first = true): Promise<void> {
  if (first) {
    await act(async () => {
      studio.read().actions.choose(new File(["x"], "p.jpg", { type: "image/jpeg" }));
      studio.read().actions.setTitle("A morning");
      studio.read().actions.setConsent(CLOSED);
    });
  }
  await act(async () => {
    await studio.read().actions.registerImage();
  });
}

beforeEach(() => {
  privy.wallets = [{ address: WALLET, walletClientType: "privy" }];
  privy.sendTransaction.mockResolvedValue({ hash: REGISTER_HASH });
  chainCalls.call.mockResolvedValue({ data: "0x" });
  chainCalls.getBalance.mockResolvedValue(1_000n);
  chainCalls.getTransactionReceipt.mockResolvedValue({ gasUsed: 657_778n, effectiveGasPrice: 102_000_000_000n });
  waits.confirmRegister.mockResolvedValue({
    landed: true,
    hash: REGISTER_HASH,
    blockNumber: 103_059_393n,
    registeredAt: 1_788_876_542_000,
  });
  waits.confirmSetConsent.mockResolvedValue({ hash: REGISTER_HASH, at: 1_789_719_047 });
  passkey.signDigest.mockResolvedValue({ auth: {}, credentialId: new Uint8Array([1, 2, 3]) });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("the line is drawn before the passkey opens", () => {
  /**
   * A passkey prompt is a window over the page, and act() holds every render
   * until it ends, so the order is read from the hook itself: the answer is
   * dispatched, the pause is decided, a frame is waited for, and only then
   * does the signing start.
   */
  it("waits a painted frame between the prepare answer and the passkey", () => {
    const hook = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "studio", "useStudio.ts"), "utf8");
    const from = hook.indexOf("const registerImage = useCallback");
    const body = hook.slice(from, hook.indexOf("}, [", from));
    const prepared = body.indexOf('dispatchRegister({ type: "prepared", prepared })');
    const pause = body.indexOf("needsGoAhead(");
    const frame = body.indexOf("await painted();", pause);
    const sign = body.lastIndexOf("await signAndSend(prepared);");
    expect(prepared).toBeGreaterThan(-1);
    expect(prepared).toBeLessThan(pause);
    expect(pause).toBeLessThan(frame);
    expect(frame).toBeLessThan(sign);
  });
});

describe("the run after prepare, for each thing the search and the web check can say", () => {
  it.each(FINDINGS)("%s", async (finding: Finding) => {
    service.prepare.mockResolvedValue(preparedWith(finding));
    const studio = await mount();
    await press(studio);

    const state = studio.read().register;
    if (pauses(finding)) {
      // Stopped, with the answer on screen, and nobody asked to sign.
      expect(state.review).toBe(true);
      expect(state.steps).toMatchObject({ prepare: "done", sign: "waiting", send: "waiting" });
      expect(passkey.signDigest).not.toHaveBeenCalled();
      expect(privy.sendTransaction).not.toHaveBeenCalled();

      await press(studio, false);
      expect(service.prepare).toHaveBeenCalledOnce();
    }

    // The passkey opened once, and on a paused run only after the second press.
    expect(passkey.signDigest).toHaveBeenCalledOnce();
    expect(studio.read().register.steps.send).toBe("done");
    expect(studio.read().register.review).toBe(false);
  });

  it("leaves the paused picture for another, and the next press prepares the new one", async () => {
    service.prepare.mockResolvedValue(preparedWith("found"));
    const studio = await mount();
    await press(studio);
    expect(studio.read().register.review).toBe(true);

    await act(async () => {
      studio.read().actions.reset();
    });
    expect(studio.read().register.review).toBe(false);
    expect(studio.read().register.prepared).toBeNull();

    service.prepare.mockResolvedValue(preparedWith("none"));
    await press(studio);
    expect(service.prepare).toHaveBeenCalledTimes(2);
    expect(passkey.signDigest).toHaveBeenCalledOnce();
    expect(studio.read().register.steps.send).toBe("done");
  });

  it("asks for a fresh prepare after a refused passkey, and pauses on it again", async () => {
    service.prepare.mockResolvedValue(preparedWith("found"));
    const studio = await mount();
    await press(studio);
    passkey.signDigest.mockRejectedValueOnce(Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" }));
    await press(studio, false);
    expect(studio.read().register.steps.sign).toBe("failed");
    expect(privy.sendTransaction).not.toHaveBeenCalled();

    await press(studio, false);
    expect(service.prepare).toHaveBeenCalledTimes(2);
    expect(studio.read().register.review).toBe(true);
  });
});
