import { createHash } from "node:crypto";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { Passport } from "@/lib/chain/registry";

/**
 * P1, P6 and P12 on the co-sign page: what is shown is what is signed, a
 * picture somebody already registered offers nothing to sign, and a deadline
 * is read against the chain's clock. The chain and the gateway are stood in
 * for, so what is held is the page's own checks.
 */

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
const { CosignSheet } = await import("@/components/cosign/CosignSheet");
type CosignRecord = import("@/lib/cosign/record").CosignRecord;
type CosignModel = import("@/lib/cosign/flow").CosignModel;

const WALLET = "0xc3714B31A5F300D7A79f72C7AEC61240D2f384E7" as Hex;
const OTHER = "0x5a1100000000000000000000000000000000A11e" as Hex;
const AGENT = "4242";
const DEADLINE = 1_790_001_800;

function sha(bytes: Uint8Array): Hex {
  return `0x${createHash("sha256").update(bytes).digest("hex")}` as Hex;
}

const picture = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const exactHash = sha(picture);
const imageUri = `ipfs://${gate.rawContentId(exactHash)}`;
const TERMS = {
  aiTraining: "notAllowed",
  aiGenerativeTraining: "notAllowed",
  aiInference: "constrained",
  dataMining: "allowed",
  constraintInfo: "Ask first at studio.example",
  standard: "cawg.training-mining/1.1",
};

function metadataBytes(overrides: Record<string, unknown> = {}): Uint8Array {
  const doc = {
    name: "Harbour at first light",
    image: imageUri,
    generator: { agentId: AGENT, registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" },
    training: TERMS,
    ...overrides,
  };
  return new TextEncoder().encode(`${JSON.stringify(doc, null, 2)}\n`);
}

function recordWith(meta: Uint8Array, overrides: Partial<CosignRecord> = {}): CosignRecord {
  const metadataURI = `ipfs://${gate.rawContentId(sha(meta))}`;
  const passport = {
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
  };
  const base: CosignRecord = {
    state: "signed",
    agentId: AGENT,
    platform: { name: "Acme Studio", agentId: AGENT },
    exactHash,
    passport,
    files: {
      image: { cid: gate.rawContentId(exactHash), uri: imageUri, gatewayUrl: "https://gateway.example/ipfs/image", bytes: picture.length },
      thumbnail: { cid: "bafkreithumb00000000000000000", uri: "ipfs://bafkreithumb00000000000000000", gatewayUrl: "https://gateway.example/ipfs/thumb", bytes: 10 },
      manifest: { cid: "bafkreimanifest0000000000000", uri: "ipfs://bafkreimanifest0000000000000", gatewayUrl: "https://gateway.example/ipfs/manifest", bytes: 10 },
      metadata: { cid: metadataURI.slice(7), uri: metadataURI, gatewayUrl: "https://gateway.example/ipfs/metadata", bytes: meta.length },
    },
    openBy: DEADLINE - 1800,
    agentSignature: `0x${"11".repeat(65)}` as Hex,
  };
  const record = { ...base, ...overrides };
  const digest = localPassportDigest(gate.passportInputOf(record, WALLET));
  return { ...record, digest: overrides.digest ?? digest };
}

function reads(files: { picture?: Uint8Array; metadata: Uint8Array }) {
  return {
    fetchBytes: vi.fn(async (url: string) => {
      if (url.endsWith("/image")) return files.picture ?? picture;
      if (url.endsWith("/metadata")) return files.metadata;
      throw new Error(`no stand-in for ${url}`);
    }),
    sha256: async (bytes: Uint8Array) => sha(bytes),
  };
}

function chain(overrides: Partial<import("@/lib/cosign/gate").ChainReads> = {}) {
  return {
    passport: vi.fn(async () => null as Passport | null),
    holder: vi.fn(async () => OTHER as Hex | null),
    now: vi.fn(async () => BigInt(DEADLINE - 60)),
    hashPassport: vi.fn(async (input: Parameters<typeof localPassportDigest>[0]) => localPassportDigest(input)),
    ...overrides,
  };
}

/** A signed-in model standing on a signed record, bound on this device, before the gate has run. */
function readyModel(record: CosignRecord): CosignModel {
  let model = flow.initialCosign;
  for (const action of [
    { type: "handle", valid: true },
    { type: "auth", signedIn: true },
    { type: "answer", outcome: { kind: "record", record } },
    { type: "binding", status: "bound" },
  ] as const) {
    model = flow.cosignReducer(model, action);
  }
  return model;
}

function render(model: CosignModel): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; timeZone: string }>;
  return renderToStaticMarkup(
    createElement(
      Provider,
      { locale: "en", messages: en, timeZone: "UTC" },
      createElement(CosignSheet, { model, agent: null, wallet: WALLET, onPress: () => undefined }),
    ),
  );
}

/** The passkey button's own opening tag, so its attributes are read apart from its class list. */
function signButton(markup: string): string {
  const tag = /<button[^>]*data-press="sign"[^>]*>/.exec(markup)?.[0];
  expect(tag).toBeDefined();
  return tag ?? "";
}

describe("P1: the passkey button opens only when all three digests and the picture agree", () => {
  it("passes a record whose picture, metadata, stored digest and registry digest all agree", async () => {
    const meta = metadataBytes();
    const record = recordWith(meta);
    const pinned = await gate.drawPinned(record, reads({ metadata: meta }));
    expect(pinned).toMatchObject({ ok: true, title: "Harbour at first light" });
    expect(pinned.ok && pinned.terms).toEqual({
      consent: { aiTraining: "notAllowed", aiGenerativeTraining: "notAllowed", aiInference: "constrained", dataMining: "allowed" },
      constraintInfo: "Ask first at studio.example",
    });

    const result = await gate.checkDigests(record, WALLET, chain());
    expect(result.at).toBe("passed");

    const model = flow.cosignReducer(readyModel(record), { type: "gate", gate: result });
    expect(model.view).toBe("ready");
    expect(flow.canSign(model)).toBe(true);
    expect(signButton(render(model))).not.toContain('disabled=""');
  });

  it("keeps the button off while the checks run", () => {
    const model = flow.cosignReducer(readyModel(recordWith(metadataBytes())), { type: "gate", gate: { at: "checking" } });
    expect(model.view).toBe("ready");
    expect(flow.canSign(model)).toBe(false);
    const markup = render(model);
    expect(markup).toContain(en.cosign.states.checking.headline);
    expect(signButton(markup)).toContain('disabled=""');
  });

  it("stops on a record whose stored digest differs from the one built from the drawn fields and this wallet", async () => {
    const record = recordWith(metadataBytes(), { digest: `0x${"99".repeat(32)}` as Hex });
    const result = await gate.checkDigests(record, WALLET, chain());
    expect(result).toMatchObject({ at: "failed", what: "record" });

    const model = flow.cosignReducer(readyModel(record), { type: "gate", gate: result });
    expect(model.view).toBe("failed");
    expect(flow.failReason(model)).toBe("mismatch");
    expect(flow.canSign(model)).toBe(false);
    expect(render(model)).not.toContain('data-press="sign"');
  });

  it("stops when the record was built for another wallet than the one signed in", async () => {
    const record = recordWith(metadataBytes());
    const result = await gate.checkDigests(record, OTHER, chain());
    expect(result).toMatchObject({ at: "failed", what: "record" });
  });

  it("stops when the registry's hashPassport answers something else", async () => {
    const record = recordWith(metadataBytes());
    const result = await gate.checkDigests(record, WALLET, chain({ hashPassport: vi.fn(async () => `0x${"42".repeat(32)}` as Hex) }));
    expect(result).toMatchObject({ at: "failed", what: "registry", other: `0x${"42".repeat(32)}` });
    expect(flow.canSign(flow.cosignReducer(readyModel(record), { type: "gate", gate: result }))).toBe(false);
  });

  it("draws nothing when the picture the gateway hands over does not hash to the passport id", async () => {
    const meta = metadataBytes();
    const record = recordWith(meta);
    const swapped = new Uint8Array([...picture, 0]);
    const pinned = await gate.drawPinned(record, reads({ picture: swapped, metadata: meta }));
    expect(pinned).toEqual({ ok: false, what: "picture" });

    const model = flow.cosignReducer(readyModel(record), { type: "gate", gate: { at: "failed", what: "picture" } });
    expect(model.view).toBe("failed");
    expect(flow.canSign(model)).toBe(false);
    const markup = render(model);
    expect(markup).not.toContain("<img");
    expect(markup).toContain(en.cosign.print.withheld);
  });

  it("draws nothing when the metadata's bytes are not the ones its content id names", async () => {
    const record = recordWith(metadataBytes());
    const forged = metadataBytes({ training: { ...TERMS, aiTraining: "allowed" } });
    expect(await gate.drawPinned(record, reads({ metadata: forged }))).toEqual({ ok: false, what: "metadata" });
  });

  it("draws nothing when the metadata names another picture or another agent", async () => {
    const other = metadataBytes({ generator: { agentId: "7" } });
    expect(await gate.drawPinned(recordWith(other), reads({ metadata: other }))).toEqual({ ok: false, what: "metadata" });
    const elsewhere = metadataBytes({ image: "ipfs://bafkreisomethingelse00000000000" });
    expect(await gate.drawPinned(recordWith(elsewhere), reads({ metadata: elsewhere }))).toEqual({ ok: false, what: "metadata" });
  });

  it("computes the raw content id the verify service computes for a small file", () => {
    // The id the verify service's own contentIdOf gives the two bytes "{}", run once and written down here.
    expect(gate.rawContentId(sha(new TextEncoder().encode("{}")))).toBe(
      "bafkreicecnx2gvntm6fbcrvnc336qze6st5u7qq7457igegamd3bzkx7ri",
    );
  });

  it("shows an empty frame and a waiting line before the picture is pinned, never a stand-in", () => {
    let model = readyModel(recordWith(metadataBytes(), { state: "creator-set", agentSignature: undefined }));
    model = flow.cosignReducer(model, { type: "binding", status: "bound" });
    expect(model.view).toBe("waitingAgent");
    const markup = render(model);
    expect(markup).not.toContain("<img");
    expect(markup).toContain("data-print-waiting");
    expect(markup).toContain(en.cosign.print.waiting);
  });
});

describe("P6: a picture the registry already holds offers nothing to sign", () => {
  const taken: Passport = {
    id: exactHash,
    exactHash,
    parentId: `0x${"00".repeat(32)}` as Hex,
    creator: OTHER,
    generatorAgentId: 7n,
    phash: 1n,
    blockhash256: `0x${"00".repeat(32)}` as Hex,
    manifestHash: `0x${"00".repeat(32)}` as Hex,
    kind: 1,
    fingerprintVersion: 1,
    registeredAt: 1_790_000_000n,
    disputed: false,
    metadataURI: "ipfs://bafkreisquatter0000000000000",
  };

  it("reads exactHash on chain first and names who holds it", async () => {
    const record = recordWith(metadataBytes());
    const reads = chain({ passport: vi.fn(async () => taken) });
    expect(await gate.firstLook(record, WALLET, reads)).toEqual({ kind: "taken", holder: OTHER });
    expect(reads.now).not.toHaveBeenCalled();

    const model = flow.cosignReducer(readyModel(record), { type: "taken", holder: OTHER });
    expect(model.view).toBe("failed");
    expect(flow.failReason(model)).toBe("taken");
    expect(flow.canSign(model)).toBe(false);
    expect(flow.automatic(model).gate).toBe(false);
    const markup = render(model);
    expect(markup).not.toContain('data-press="sign"');
    expect(markup).toContain("0x5a11…A11e");
    expect(markup).toContain(`href="/passport/${exactHash}"`);
  });

  it("reads this very passport as this person's own, never as taken", async () => {
    const record = recordWith(metadataBytes());
    const ours = { ...taken, creator: WALLET, generatorAgentId: 4242n, metadataURI: record.passport.metadataURI, manifestHash: record.passport.manifestHash, kind: 0 };
    expect(await gate.firstLook(record, WALLET, chain({ passport: vi.fn(async () => ours) }))).toEqual({ kind: "ours" });
  });
});

describe("P12: the deadline is read against the chain's clock", () => {
  it("calls a record expired from the head block's time, whatever this machine's clock says", async () => {
    const record = recordWith(metadataBytes());
    vi.useFakeTimers();
    vi.setSystemTime(new Date((DEADLINE - 3600) * 1000));
    try {
      expect(await gate.firstLook(record, WALLET, chain({ now: vi.fn(async () => BigInt(DEADLINE + 1)) }))).toEqual({ kind: "expired" });
    } finally {
      vi.useRealTimers();
    }
    expect(gate.pastDeadline(record, BigInt(DEADLINE))).toBe(false);
    expect(gate.pastDeadline(record, BigInt(DEADLINE + 1))).toBe(true);
  });

  it("sends nothing past it: no sign button, no gate, no clock left running", () => {
    let model = readyModel(recordWith(metadataBytes()));
    model = flow.cosignReducer(model, { type: "gate", gate: { at: "passed", digest: `0x${"01".repeat(32)}` as Hex } });
    expect(flow.canSign(model)).toBe(true);
    model = flow.cosignReducer(model, { type: "expired" });
    expect(model.view).toBe("expired");
    expect(flow.canSign(model)).toBe(false);
    expect(flow.pressFor(model, "primary")).toBeNull();
    const auto = flow.automatic(model);
    expect([auto.gate, auto.clock, auto.poll]).toEqual([false, false, false]);
    expect(render(model)).not.toContain("data-press=");
  });
});
