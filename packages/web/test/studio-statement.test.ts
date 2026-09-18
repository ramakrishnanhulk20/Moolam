// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { decodeFunctionData, type Abi, type Hex } from "viem";
import consentAbiJson from "../../contracts/abi/MoolamConsent.json";
import type { ConsentDraft } from "@/lib/consent/call";
import type { Studio } from "@/lib/studio/useStudio";

/**
 * The studio's second send, driven from a bare component with the wallet
 * mocked.
 *
 * Privy only runs in a browser, so its hooks and the passkey ceremony are stood
 * in for. What this file is after is the part that is really the studio's: the
 * statement goes out only after the registration is confirmed, it carries the
 * words the verify service echoed rather than the ones on the plates, and
 * whatever happens to it the passport stays registered.
 */

const WALLET = "0x85a88Ca81Ff5F681D96AB86fA60ccB8452a139a6" as Hex;
const PASSPORT = `0x${"ab".repeat(32)}` as Hex;
const REGISTER_HASH = `0x${"ef".repeat(32)}` as Hex;
const STATEMENT_HASH = `0x${"3f".repeat(32)}` as Hex;
const DIGEST = `0x${"cd".repeat(32)}` as Hex;

const CLOSED: ConsentDraft = {
  consent: {
    aiTraining: "notAllowed",
    aiGenerativeTraining: "notAllowed",
    aiInference: "notAllowed",
    dataMining: "notAllowed",
  },
  constraintInfo: "",
};

/** What the service echoes: the same four words, and the conditions it trimmed. */
const ECHOED = {
  aiTraining: "notAllowed",
  aiGenerativeTraining: "notAllowed",
  aiInference: "notAllowed",
  dataMining: "notAllowed",
  standard: "cawg.training-mining/1.1",
} as const;

const PREPARED = {
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
  image: { cid: "cid", uri: "ipfs://image", gatewayUrl: "https://gateway/image", bytes: 10, width: 4, height: 3 },
  thumbnail: { cid: "thumb", uri: "ipfs://thumb", gatewayUrl: "https://gateway/thumb" },
  metadata: { cid: "meta", uri: "ipfs://metadata" },
  manifest: { embedded: true },
  preparedBy: "did:privy:someone",
};

const privy = vi.hoisted(() => ({ sendTransaction: vi.fn(), wallets: [] as unknown[] }));
const chainCalls = vi.hoisted(() => ({ call: vi.fn(), getBalance: vi.fn(), getTransactionReceipt: vi.fn() }));
const service = vi.hoisted(() => ({ prepare: vi.fn() }));
const waits = vi.hoisted(() => ({ confirmRegister: vi.fn(), confirmSetConsent: vi.fn() }));

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
  signDigest: async () => ({ auth: {}, credentialId: new Uint8Array([1, 2, 3]) }),
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
const { ConfirmTimeout } = await import("@/lib/studio/confirm");
const { addresses } = await import("@/lib/chain/client");

const consentAbi = consentAbiJson as Abi;

/** Mounts the hook and hands back a live view of what it last returned. */
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

  return {
    read: () => {
      if (seen.current === null) {
        throw new Error("the probe never rendered");
      }
      return seen.current;
    },
  };
}

/** One whole upload run, with the statement the creator picked on the panel. */
async function run(studio: { read: () => Studio }, draft: ConsentDraft | null): Promise<void> {
  await act(async () => {
    studio.read().actions.choose(new File(["x"], "p.jpg", { type: "image/jpeg" }));
    studio.read().actions.setTitle("A morning");
    if (draft !== null) {
      studio.read().actions.setConsent(draft);
    }
  });
  await act(async () => {
    await studio.read().actions.registerImage();
  });
}

/** What the second send actually carries, decoded through the register's own ABI. */
function statementSent(): { id: Hex; consent: Record<string, number>; constraintInfo: string } {
  const call = privy.sendTransaction.mock.calls.at(-1) as unknown as [{ to: Hex; data: Hex }, unknown];
  const decoded = decodeFunctionData({ abi: consentAbi, data: call[0].data });
  const [id, consent, constraintInfo] = decoded.args as [Hex, Record<string, number>, string];
  return { id, consent, constraintInfo };
}

beforeEach(() => {
  privy.wallets = [{ address: WALLET, walletClientType: "privy" }];
  privy.sendTransaction.mockResolvedValue({ hash: REGISTER_HASH });
  chainCalls.call.mockResolvedValue({ data: "0x" });
  chainCalls.getBalance.mockResolvedValue(1_000n);
  chainCalls.getTransactionReceipt.mockResolvedValue({ gasUsed: 657_778n, effectiveGasPrice: 102_000_000_000n });
  service.prepare.mockResolvedValue({ ...PREPARED, training: ECHOED });
  waits.confirmRegister.mockResolvedValue({
    landed: true,
    hash: REGISTER_HASH,
    blockNumber: 103_059_393n,
    registeredAt: 1_788_876_542_000,
  });
  waits.confirmSetConsent.mockResolvedValue({ hash: STATEMENT_HASH, at: 1_789_719_047 });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("the statement the studio writes after the passport", () => {
  it("sends the picture's statement to the service and the service's own answer to the register", async () => {
    const studio = await mount();
    privy.sendTransaction
      .mockResolvedValueOnce({ hash: REGISTER_HASH })
      .mockResolvedValueOnce({ hash: STATEMENT_HASH });

    await run(studio, CLOSED);

    expect(service.prepare.mock.calls[0][0].training).toEqual({
      aiTraining: "notAllowed",
      aiGenerativeTraining: "notAllowed",
      aiInference: "notAllowed",
      dataMining: "notAllowed",
    });

    // Two sends and no more: the registration, then the statement.
    expect(privy.sendTransaction).toHaveBeenCalledTimes(2);
    const sent = statementSent();
    expect(sent.id).toBe(PASSPORT);
    expect(sent.consent).toEqual({ aiTraining: 2, aiGenerativeTraining: 2, aiInference: 2, dataMining: 2 });
    expect(sent.constraintInfo).toBe("");
    expect(privy.sendTransaction.mock.calls[1][1]).toMatchObject({ sponsor: true, address: WALLET });

    const state = studio.read().register;
    expect(state.statement.state).toBe("stated");
    expect(state.statement.at).toBe(1_789_719_047);
    expect(state.statement.sent).toEqual(CLOSED);
    expect(state.statement.waitedMs).toBeGreaterThanOrEqual(0);
    expect(state.statement.sponsored).toBe(true);
    expect(state.steps.send).toBe("done");
  });

  it("writes the words the service trimmed, never the ones typed on the plate", async () => {
    const studio = await mount();
    service.prepare.mockResolvedValue({
      ...PREPARED,
      training: {
        aiTraining: "constrained",
        aiGenerativeTraining: "constrained",
        aiInference: "constrained",
        dataMining: "constrained",
        constraintInfo: "ask hello@moolam.app",
        standard: "cawg.training-mining/1.1",
      },
    });

    await run(studio, {
      consent: {
        aiTraining: "constrained",
        aiGenerativeTraining: "constrained",
        aiInference: "constrained",
        dataMining: "constrained",
      },
      constraintInfo: "   ask hello@moolam.app   ",
    });

    expect(statementSent().constraintInfo).toBe("ask hello@moolam.app");
  });

  it("waits for the registration before it goes out, and never sends inside it", async () => {
    const studio = await mount();
    const order: string[] = [];
    waits.confirmRegister.mockImplementation(async () => {
      order.push("passport shown by the registry");
      return { landed: true, hash: REGISTER_HASH, blockNumber: 1n, registeredAt: 1_788_876_542_000 };
    });
    privy.sendTransaction.mockImplementation(async (request: { to: Hex }) => {
      order.push(request.to.toLowerCase() === addresses.consent.toLowerCase() ? "the statement" : "the passport");
      return { hash: REGISTER_HASH };
    });

    await run(studio, CLOSED);

    expect(order).toEqual(["the passport", "passport shown by the registry", "the statement"]);
  });

  it("sends nothing at all when the creator stated nothing", async () => {
    const studio = await mount();
    service.prepare.mockResolvedValue(PREPARED);

    await run(studio, null);

    expect(service.prepare.mock.calls[0][0].training).toBeUndefined();
    expect(privy.sendTransaction).toHaveBeenCalledTimes(1);
    expect(waits.confirmSetConsent).not.toHaveBeenCalled();
    expect(studio.read().register.statement.state).toBe("idle");
    expect(studio.read().register.steps.send).toBe("done");
  });
});

describe("a statement that does not land, over a passport that did", () => {
  /** Everything the registration established, which a statement may never touch. */
  function registration(studio: { read: () => Studio }) {
    const state = studio.read().register;
    return { steps: state.steps, txHash: state.txHash, block: state.block, registeredAt: state.registeredAt };
  }

  it("reads a closed wallet prompt as a choice, and leaves the passport registered", async () => {
    const studio = await mount();
    privy.sendTransaction
      .mockResolvedValueOnce({ hash: REGISTER_HASH })
      .mockRejectedValueOnce(Object.assign(new Error("User rejected request"), { code: 4001 }));

    await run(studio, CLOSED);

    expect(studio.read().register.statement.failure).toEqual({ key: "declined", next: "again" });
    expect(studio.read().register.statement.state).toBe("failed");
    expect(registration(studio)).toMatchObject({ txHash: REGISTER_HASH, block: 103_059_393n });
    expect(studio.read().register.steps.send).toBe("done");
    expect(studio.read().register.failure).toBeNull();
  });

  it("offers the statement again after a failure, and writes it on the second attempt", async () => {
    const studio = await mount();
    waits.confirmSetConsent.mockRejectedValueOnce(new Error("the endpoint refused"));

    await run(studio, CLOSED);
    expect(studio.read().register.statement.state).toBe("failed");
    expect(studio.read().register.statement.failure).toMatchObject({ key: "unknown", next: "again" });
    const after = registration(studio);

    await act(async () => {
      await studio.read().actions.stateAgain();
    });

    expect(privy.sendTransaction).toHaveBeenCalledTimes(3);
    expect(statementSent().id).toBe(PASSPORT);
    expect(studio.read().register.statement.state).toBe("stated");
    expect(registration(studio)).toEqual(after);
  });

  it("never sends a second time while the first is out: it only asks Monad again", async () => {
    const studio = await mount();
    waits.confirmSetConsent.mockRejectedValue(new ConfirmTimeout(WALLET, STATEMENT_HASH));

    await run(studio, CLOSED);
    expect(studio.read().register.statement.state).toBe("unconfirmed");
    expect(studio.read().register.statement.failure?.key).toBe("confirmPending");

    await act(async () => {
      await studio.read().actions.stateAgain();
      await studio.read().actions.stateAgain();
    });

    expect(privy.sendTransaction).toHaveBeenCalledTimes(2);
    expect(waits.confirmSetConsent).toHaveBeenCalledTimes(3);
    expect(studio.read().register.statement.state).toBe("unconfirmed");

    // The run is held while it is out, so nothing starts a fresh picture over it.
    await act(async () => {
      studio.read().actions.reset();
    });
    expect(studio.read().register.steps.send).toBe("done");
  });
});
