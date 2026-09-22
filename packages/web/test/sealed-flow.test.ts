// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createHash } from "node:crypto";
import { decodeFunctionData, type Abi, type Hex } from "viem";
import consentAbiJson from "../../contracts/abi/MoolamConsent.json";
import type { ConsentDraft } from "@/lib/consent/call";
import type { Studio } from "@/lib/studio/useStudio";

/**
 * A whole sealed registration, driven from a bare component with the wallet and
 * the passkey stood in for.
 *
 * The one thing this file is really watching is the order: the browser has the
 * file and has proved its hash before anything asks for a signature. A passkey
 * ceremony cannot run in a test, so the real check and the stand-in for the
 * prompt both write a line in one list, and the list is what gets asserted.
 */

const WALLET = "0x85a88Ca81Ff5F681D96AB86fA60ccB8452a139a6" as Hex;
const REGISTER_HASH = `0x${"ef".repeat(32)}` as Hex;
const STATEMENT_HASH = `0x${"3f".repeat(32)}` as Hex;
const DIGEST = `0x${"cd".repeat(32)}` as Hex;

/** A short picture, and the id the chain would commit to for it. */
const PICTURE = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, ...Array.from({ length: 512 }, (_, at) => (at * 31) % 249)]);
const PASSPORT = `0x${createHash("sha256").update(PICTURE).digest("hex")}` as Hex;

const CLOSED: ConsentDraft = {
  consent: {
    aiTraining: "notAllowed",
    aiGenerativeTraining: "notAllowed",
    aiInference: "notAllowed",
    dataMining: "notAllowed",
  },
  constraintInfo: "",
};

const ECHOED = {
  aiTraining: "notAllowed",
  aiGenerativeTraining: "notAllowed",
  aiInference: "notAllowed",
  dataMining: "notAllowed",
  standard: "cawg.training-mining/1.1",
} as const;

/** What /prepare answers for a picture the creator is keeping: a file, and no pin of it anywhere. */
function sealedAnswer(bytes: Uint8Array = PICTURE) {
  return {
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
    metadata: { cid: "meta", uri: "ipfs://metadata" },
    manifest: { embedded: true },
    training: ECHOED,
    preparedBy: "did:privy:someone",
    sealed: true,
    signedFile: {
      name: "a-morning-abababab.jpg",
      type: "image/jpeg",
      bytes: Buffer.from(bytes).toString("base64"),
      sha256: PASSPORT,
    },
  };
}

const privy = vi.hoisted(() => ({ sendTransaction: vi.fn(), wallets: [] as unknown[] }));
const chainCalls = vi.hoisted(() => ({ call: vi.fn(), getBalance: vi.fn(), getTransactionReceipt: vi.fn() }));
const service = vi.hoisted(() => ({ prepare: vi.fn() }));
const waits = vi.hoisted(() => ({ confirmRegister: vi.fn(), confirmSetConsent: vi.fn() }));
const passkey = vi.hoisted(() => ({ signDigest: vi.fn() }));
/** What happened in what order: the gate's answer, then anything that asks for a signature. */
const order = vi.hoisted(() => ({ steps: [] as string[] }));

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

// The real gate, with a note taken of what it answered and when. Wrapping it
// rather than replacing it means the check itself is the one that ships.
vi.mock("@/lib/sealed/handback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sealed/handback")>();
  return {
    ...actual,
    decideSealed: async (...args: Parameters<typeof actual.decideSealed>) => {
      const decision = await actual.decideSealed(...args);
      order.steps.push(`gate:${decision.next}`);
      return decision;
    },
  };
});

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
const { VerifierError } = await import("@/lib/verifier/client");
const { holdsUnsavedFile } = await import("@/lib/studio/flow");

const consentAbi = consentAbiJson as Abi;

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

/** One upload run with the switch on. */
async function run(studio: { read: () => Studio }, sealed = true): Promise<void> {
  await act(async () => {
    studio.read().actions.choose(new File(["x"], "p.jpg", { type: "image/jpeg" }));
    studio.read().actions.setTitle("A morning");
    studio.read().actions.setConsent(CLOSED);
    studio.read().actions.setSealed(sealed);
  });
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
  service.prepare.mockResolvedValue(sealedAnswer());
  order.steps = [];
  passkey.signDigest.mockImplementation(async () => {
    order.steps.push("passkey");
    return { auth: {}, credentialId: new Uint8Array([1, 2, 3]) };
  });
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

describe("a registration the creator keeps", () => {
  it("asks the service to seal it, and holds the checked file before the unlock is asked for", async () => {
    const studio = await mount();

    await run(studio);

    expect(service.prepare.mock.calls[0]?.[0]).toMatchObject({ sealed: true });
    // The one question this whole file exists to ask: the check answered, and
    // only then was anybody asked to sign.
    expect(order.steps).toEqual(["gate:sign", "passkey"]);

    const state = studio.read().register;
    expect(state.steps).toMatchObject({ prepare: "done", sign: "done", send: "done" });
    expect(state.sealed.file?.name).toBe("a-morning-abababab.jpg");
    expect(state.sealed.file?.size).toBe(PICTURE.length);
  });

  it("stops on a tampered byte without ever opening the passkey prompt", async () => {
    const tampered = Uint8Array.from(PICTURE);
    tampered[9] ^= 0x40;
    service.prepare.mockResolvedValue(sealedAnswer(tampered));

    const studio = await mount();
    await run(studio);

    expect(order.steps).toEqual(["gate:stop"]);
    expect(passkey.signDigest).not.toHaveBeenCalled();
    expect(privy.sendTransaction).not.toHaveBeenCalled();
    const state = studio.read().register;
    expect(state.failure?.key).toBe("sealedMismatch");
    expect(state.sealed.file).toBeNull();
    expect(state.steps.sign).toBe("waiting");
  });

  it("stops when the answer comes back published after a sealed request", async () => {
    service.prepare.mockResolvedValue({
      ...sealedAnswer(),
      sealed: undefined,
      signedFile: undefined,
      image: { cid: "c", uri: "ipfs://c", gatewayUrl: "https://g/c", bytes: 10, width: 4, height: 3 },
    });

    const studio = await mount();
    await run(studio);

    expect(passkey.signDigest).not.toHaveBeenCalled();
    expect(studio.read().register.failure?.key).toBe("sealedNotHeld");
  });

  it("warns before the page is left until the file is saved, and stops warning after", async () => {
    const studio = await mount();
    await run(studio);

    expect(holdsUnsavedFile(studio.read().register)).toBe(true);
    await act(async () => {
      studio.read().actions.saveSealed();
    });
    expect(studio.read().register.sealed.saved).toBe(true);
    expect(holdsUnsavedFile(studio.read().register)).toBe(false);
  });

  it("writes the AI use statement to the register afterwards, exactly as a published one does", async () => {
    const studio = await mount();
    privy.sendTransaction
      .mockResolvedValueOnce({ hash: REGISTER_HASH })
      .mockResolvedValueOnce({ hash: STATEMENT_HASH });

    await run(studio);

    const [sent] = privy.sendTransaction.mock.calls.at(-1) as unknown as [{ to: Hex; data: Hex }];
    const decoded = decodeFunctionData({ abi: consentAbi, data: sent.data });
    const [id, consent] = decoded.args as [Hex, Record<string, number>];
    expect(id).toBe(PASSPORT);
    expect(consent).toMatchObject({ aiTraining: 2, aiGenerativeTraining: 2, aiInference: 2, dataMining: 2 });
    expect(studio.read().register.statement.state).toBe("stated");
  });

  it("names the service's own two refusals, and keeps nothing from them", async () => {
    for (const [code, key] of [
      ["sealed-metadata-refused", "sealedRecordRefused"],
      ["sealed-file-refused", "sealedFileRefused"],
    ] as const) {
      service.prepare.mockRejectedValue(
        new VerifierError(code, 500, "nothing was pinned and nothing was registered. Please try again."),
      );

      const studio = await mount();
      await run(studio);

      const state = studio.read().register;
      expect(state.failure?.key, code).toBe(key);
      // The service's English sentence is not printed under the translated one.
      expect(state.failure?.reason, code).toBeUndefined();
      expect(state.sealed.file, code).toBeNull();
      expect(passkey.signDigest).not.toHaveBeenCalled();
      document.body.innerHTML = "";
    }
  });

  it("leaves a published registration exactly as it was", async () => {
    service.prepare.mockResolvedValue({
      ...sealedAnswer(),
      sealed: undefined,
      signedFile: undefined,
      image: { cid: "cid", uri: "ipfs://image", gatewayUrl: "https://gateway/image", bytes: 10, width: 4, height: 3 },
      thumbnail: { cid: "thumb", uri: "ipfs://thumb", gatewayUrl: "https://gateway/thumb" },
    });

    const studio = await mount();
    await run(studio, false);

    expect(service.prepare.mock.calls[0]?.[0]).toMatchObject({ sealed: false });
    expect(passkey.signDigest).toHaveBeenCalledOnce();
    expect(studio.read().register.steps.send).toBe("done");
    expect(studio.read().register.sealed.file).toBeNull();
  });
});
