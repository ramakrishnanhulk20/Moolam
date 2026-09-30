// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import en from "@/messages/en.json";

/**
 * WO-246c on the running page, with its real hook and every read and write
 * stood in for:
 * - P16: clause 03 names no listing, and no absence of one, until the record
 *   and the list have answered.
 * - P9, P13, P24 after a reload: a passport this wallet already registered is
 *   checked against the consent register. With nothing there, the file's terms
 *   are offered on a press and written unchanged; with terms there, their
 *   writer is named and nothing is sent.
 * - A fee Privy will not pay gets the studio's way on: the same signed bytes,
 *   sent again with the account paying, and no second passkey prompt.
 */

const HANDLE = "0123456789abcdef0123456789abcdef";
const WALLET = "0xc3714B31A5F300D7A79f72C7AEC61240D2f384E7" as Hex;
const OTHER = "0x5a1100000000000000000000000000000000A11e" as Hex;
const AGENT = "4242";
const DEADLINE = 1_790_001_800;
const TX = `0x${"5e".repeat(32)}` as Hex;
const TERMS_TX = `0x${"6f".repeat(32)}` as Hex;

const spies = vi.hoisted(() => ({
  sendTransaction: vi.fn(),
  open: vi.fn(),
  passport: vi.fn(),
  consent: vi.fn(),
  signDigest: vi.fn(),
  confirmRegister: vi.fn(),
  confirmSetConsent: vi.fn(),
  balance: vi.fn(),
}));

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({
    ready: true,
    authenticated: true,
    user: null,
    login: vi.fn(),
    logout: vi.fn(),
    getAccessToken: async () => "privy-token",
  }),
  useWallets: () => ({ wallets: [{ walletClientType: "privy", address: WALLET, chainId: "eip155:143" }], ready: true }),
  useSendTransaction: () => ({ sendTransaction: spies.sendTransaction }),
}));
vi.mock("@/lib/studio/usePasskeyBinding", () => ({
  usePasskeyBinding: () => ({
    status: "bound",
    passkey: { qx: `0x${"01".repeat(32)}`, qy: `0x${"02".repeat(32)}` },
    credentialId: undefined,
    error: null,
    refresh: () => undefined,
    remember: () => undefined,
  }),
}));
vi.mock("@/lib/cosign/agent", () => ({ cosignAgentFacts: async () => null }));
vi.mock("@/lib/chain/time", () => ({ headTimestamp: async () => BigInt(DEADLINE - 600) }));
vi.mock("@/lib/cosign/record", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/cosign/record")>();
  return { ...real, openRecord: spies.open, recordStatus: spies.open };
});
vi.mock("@/lib/chain/registry", async () => {
  const { localPassportDigest } = await import("@/lib/chain/digest");
  return {
    getPassport: spies.passport,
    getOwner: async () => OTHER,
    hashPassport: async (input: Parameters<typeof localPassportDigest>[0]) => localPassportDigest(input),
    bindNonce: async () => 0n,
    hashBind: async () => `0x${"00".repeat(32)}`,
  };
});
vi.mock("@/lib/chain/consent", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/chain/consent")>();
  return { ...real, getConsent: spies.consent };
});
vi.mock("@/lib/chain/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/chain/client")>();
  return { ...real, chain: { call: async () => ({}), getBalance: spies.balance } };
});
vi.mock("@/lib/cosign/landed", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/cosign/landed")>();
  return { ...real, confirmedRegistration: async () => TX, confirmedConsent: async () => TERMS_TX };
});
vi.mock("@/lib/consent/confirm", () => ({ confirmSetConsent: spies.confirmSetConsent }));
vi.mock("@/lib/studio/confirm", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/studio/confirm")>();
  return { ...real, confirmRegister: spies.confirmRegister, confirmBind: vi.fn() };
});
vi.mock("@/lib/studio/wallet", () => ({ ensureMonad: async () => undefined }));
vi.mock("@/lib/passkey/browser", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/passkey/browser")>();
  return { ...real, signDigest: spies.signDigest, rememberCredential: () => undefined };
});
vi.mock("@/lib/passkey/verify", () => ({ checkAuth: async () => ({ ok: true }) }));
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));
vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": true }),
}));

const { localPassportDigest } = await import("@/lib/chain/digest");
const gate = await import("@/lib/cosign/gate");
const flow = await import("@/lib/cosign/flow");
const { setConsentRequest } = await import("@/lib/consent/call");
const { addresses } = await import("@/lib/chain/client");
const { CosignLive } = await import("@/components/cosign/CosignLive");
const { CosignSheet } = await import("@/components/cosign/CosignSheet");
type CosignRecord = import("@/lib/cosign/record").CosignRecord;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function sha(bytes: Uint8Array): Hex {
  return `0x${createHash("sha256").update(bytes).digest("hex")}` as Hex;
}

const picture = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6, 5, 4, 3, 2]);
const exactHash = sha(picture);
const imageUri = `ipfs://${gate.rawContentId(exactHash)}`;
const FILE_TERMS = {
  consent: { aiTraining: "notAllowed", aiGenerativeTraining: "notAllowed", aiInference: "constrained", dataMining: "allowed" },
  constraintInfo: "Ask first at studio.example",
} as const;
const metadata = new TextEncoder().encode(
  `${JSON.stringify(
    {
      name: "Harbour at first light",
      image: imageUri,
      generator: { agentId: AGENT },
      training: { ...FILE_TERMS.consent, constraintInfo: FILE_TERMS.constraintInfo, standard: "cawg.training-mining/1.1" },
    },
    null,
    2,
  )}\n`,
);
const metadataURI = `ipfs://${gate.rawContentId(sha(metadata))}`;

function recordOf(): CosignRecord {
  const base: CosignRecord = {
    state: "signed",
    agentId: AGENT,
    platform: { name: "Acme Studio", agentId: AGENT },
    exactHash,
    passport: {
      exactHash,
      parentId: `0x${"00".repeat(32)}` as Hex,
      creator: WALLET,
      generatorAgentId: AGENT,
      phash: "12345678901234567",
      blockhash256: `0x${"ab".repeat(32)}` as Hex,
      manifestHash: `0x${"cd".repeat(32)}` as Hex,
      kind: 0,
      fingerprintVersion: 1,
      metadataURI,
      deadline: String(DEADLINE),
    },
    files: {
      image: { cid: gate.rawContentId(exactHash), uri: imageUri, gatewayUrl: "https://gateway.example/ipfs/image", bytes: picture.length },
      thumbnail: { cid: "bafkreithumb00000000000000000", uri: "ipfs://bafkreithumb00000000000000000", gatewayUrl: "https://gateway.example/ipfs/thumb", bytes: 10 },
      manifest: { cid: "bafkreimanifest0000000000000", uri: "ipfs://bafkreimanifest0000000000000", gatewayUrl: "https://gateway.example/ipfs/manifest", bytes: 10 },
      metadata: { cid: metadataURI.slice(7), uri: metadataURI, gatewayUrl: "https://gateway.example/ipfs/metadata", bytes: metadata.length },
    },
    openBy: DEADLINE - 1800,
    agentSignature: `0x${"11".repeat(65)}` as Hex,
  };
  return { ...base, digest: localPassportDigest(gate.passportInputOf(base, WALLET)) };
}

const RECORD = recordOf();
const OURS = {
  id: exactHash,
  exactHash,
  parentId: RECORD.passport.parentId,
  creator: WALLET,
  generatorAgentId: 4242n,
  phash: 12345678901234567n,
  blockhash256: RECORD.passport.blockhash256,
  manifestHash: RECORD.passport.manifestHash,
  kind: 0,
  fingerprintVersion: 1,
  registeredAt: BigInt(DEADLINE - 900),
  disputed: false,
  metadataURI,
};
const AUTH = {
  r: `0x${"0a".repeat(32)}` as Hex,
  s: `0x${"0b".repeat(32)}` as Hex,
  challengeIndex: 23n,
  typeIndex: 1n,
  authenticatorData: `0x${"00".repeat(37)}` as Hex,
  clientDataJSON: "{}",
};

const roots: Root[] = [];

beforeEach(() => {
  window.location.hash = HANDLE;
  spies.open.mockResolvedValue({ kind: "record", record: RECORD });
  spies.passport.mockResolvedValue(null);
  spies.consent.mockResolvedValue({ stated: false, entry: null });
  spies.signDigest.mockResolvedValue({ auth: AUTH, credentialId: new Uint8Array([1, 2, 3]) });
  spies.confirmRegister.mockResolvedValue({ landed: true, answeredAt: 0 });
  spies.confirmSetConsent.mockResolvedValue({ at: DEADLINE });
  spies.balance.mockResolvedValue(500_000_000_000_000_000n);
  spies.sendTransaction.mockResolvedValue({ hash: TX });
  // Reduced motion, so each state's words swap in at once and the text read is the state's own.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduce"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
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
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = String(input);
    const body = url.endsWith("/image") ? picture : url.endsWith("/metadata") ? metadata : null;
    return body === null ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
  });
  URL.createObjectURL = () => "blob:picture";
  URL.revokeObjectURL = () => undefined;
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  for (const spy of Object.values(spies)) spy.mockReset();
});

async function rest(ms = 900): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mount(): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; timeZone: string; children?: unknown }>;
  await act(async () => root.render(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, createElement(CosignLive))));
  // The words swap once per state on the way in, each waiting for the last to leave.
  await rest(1500);
  return host;
}

function text(host: HTMLElement): string {
  return host.textContent ?? "";
}

async function press(host: HTMLElement, name: string): Promise<void> {
  const button = host.querySelector<HTMLButtonElement>(`[data-press="${name}"]`);
  expect(button, name).not.toBeNull();
  expect(button?.disabled, name).toBe(false);
  await act(async () => button?.click());
  await rest(1500);
}

function state(host: HTMLElement): string | null {
  return host.querySelector("article")?.getAttribute("data-cosign-state") ?? null;
}

describe("P16: clause 03 says listed or not listed only once the record and the list have answered", () => {
  function render(model: import("@/lib/cosign/flow").CosignModel, agent: import("@/lib/cosign/listing").AgentFacts | null): string {
    const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; timeZone: string }>;
    return renderToStaticMarkup(
      createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, createElement(CosignSheet, { model, agent, wallet: null, onPress: () => undefined })),
    ).replace(/&#x27;/g, "'");
  }
  const clause = (markup: string) => /data-clause="platform"[\s\S]*?<\/li>/.exec(markup)?.[0] ?? "";

  it.each([
    ["signed out", [{ type: "handle", valid: true }, { type: "auth", signedIn: false }]],
    ["loading", [{ type: "handle", valid: true }]],
    ["record read, list not yet", [{ type: "handle", valid: true }, { type: "auth", signedIn: true }, { type: "answer", outcome: { kind: "record", record: RECORD } }]],
  ] as const)("uses the neutral label while %s", (_name, actions) => {
    let model = flow.initialCosign;
    for (const action of actions) model = flow.cosignReducer(model, action as import("@/lib/cosign/flow").CosignAction);
    const platform = clause(render(model, null));
    expect(platform).toContain(en.cosign.clauses.platform.label);
    expect(platform).not.toContain(en.cosign.clauses.platform.unlisted);
    expect(platform).not.toContain(en.cosign.clauses.platform.listed);
    expect(platform).not.toContain(en.cosign.platform.unlistedName);
  });

  it("names no listing and no absence of one on a link that leads nowhere", () => {
    const markup = render(flow.cosignReducer(flow.initialCosign, { type: "handle", valid: false }), null);
    expect(markup).not.toContain(en.cosign.clauses.platform.unlisted);
    expect(markup).not.toContain(en.cosign.platform.unlistedName);
  });

  it("says not listed once the list has answered with no entry for the agent", () => {
    let model = flow.initialCosign;
    for (const action of [{ type: "handle", valid: true }, { type: "auth", signedIn: true }, { type: "answer", outcome: { kind: "record", record: RECORD } }] as const) {
      model = flow.cosignReducer(model, action as import("@/lib/cosign/flow").CosignAction);
    }
    const platform = clause(render(model, { agentId: AGENT, name: null, owner: WALLET, listing: null, field: [] }));
    expect(platform).toContain(en.cosign.clauses.platform.unlisted);
    expect(platform).toContain(en.cosign.platform.unlistedName);
  });
});

vi.setConfig({ testTimeout: 20_000 });

describe("terms after a reload (P9, P13, P24)", () => {
  it("offers the file's terms on a press when the register holds none, and writes them unchanged", async () => {
    spies.passport.mockResolvedValue(OURS);
    const host = await mount();
    expect(state(host)).toBe("registered");
    expect(spies.consent).toHaveBeenCalledWith(exactHash);
    expect(text(host)).toContain(en.cosign.termsLine.offered);
    expect(spies.sendTransaction).not.toHaveBeenCalled();

    await press(host, "writeTerms");
    const request = setConsentRequest(exactHash, FILE_TERMS as never);
    expect(spies.sendTransaction).toHaveBeenCalledTimes(1);
    expect(spies.sendTransaction.mock.calls[0][0]).toEqual({ to: addresses.consent, data: request.data, chainId: 143 });
    expect(spies.sendTransaction.mock.calls[0][1]).toEqual({ sponsor: true, address: WALLET });
    expect(spies.confirmSetConsent).toHaveBeenCalledWith(expect.objectContaining({ passportId: exactHash, wallet: WALLET, sent: FILE_TERMS }));
    expect(text(host)).toContain(en.cosign.termsLine.written);
    expect(host.querySelector('[data-press="writeTerms"]')).toBeNull();
  });

  it("names the writer of terms already on chain and sends nothing", async () => {
    spies.passport.mockResolvedValue(OURS);
    spies.consent.mockResolvedValue({
      stated: true,
      entry: { at: BigInt(DEADLINE), writer: OTHER, consent: FILE_TERMS.consent, constraintInfo: "" },
    });
    const host = await mount();
    expect(state(host)).toBe("registered");
    expect(text(host)).toContain("AI-use terms for this passport are already on chain, written by 0x5a11…A11e.");
    expect(host.querySelector('[data-press="writeTerms"]')).toBeNull();
    await rest();
    expect(spies.sendTransaction).not.toHaveBeenCalled();
  });
});

describe("a fee Privy will not pay", () => {
  it("shows the studio's pay-the-fee-myself offer with the balance, and sends the same bytes with no second prompt", async () => {
    spies.sendTransaction.mockRejectedValueOnce(new Error("Gas sponsorship policy rejected this transaction"));
    const host = await mount();
    expect(state(host)).toBe("ready");

    await press(host, "sign");
    expect(spies.signDigest).toHaveBeenCalledTimes(1);
    expect(state(host)).toBe("ready");
    expect(text(host)).toContain(en.studio.failure.sponsorship);
    const offer = host.querySelector('[data-press="unsponsored"]');
    expect(offer?.textContent).toBe(en.studio.actions.unsponsored);
    expect(text(host)).toContain("Your account holds 0.5000 MON.");

    await press(host, "unsponsored");
    expect(spies.signDigest).toHaveBeenCalledTimes(1);
    const [first, second, terms] = spies.sendTransaction.mock.calls;
    expect(first[0].to).toBe(addresses.registry);
    expect(second[0]).toEqual(first[0]);
    expect(first[1]).toEqual({ sponsor: true, address: WALLET });
    expect(second[1]).toEqual({ sponsor: false, address: WALLET });
    expect(state(host)).toBe("registered");
    // Then the record's terms go out on their own, after the register's receipt, as on any co-sign.
    expect(terms[0].to).toBe(addresses.consent);
    expect(spies.sendTransaction).toHaveBeenCalledTimes(3);
  });

  it("says the account is empty instead of offering a send it would refuse", async () => {
    spies.sendTransaction.mockRejectedValueOnce(new Error("Gas sponsorship policy rejected this transaction"));
    spies.balance.mockResolvedValue(0n);
    const host = await mount();
    await press(host, "sign");
    expect(host.querySelector('[data-press="unsponsored"]')).toBeNull();
    expect(text(host)).toContain(en.studio.register.balanceEmpty);
  });
});
