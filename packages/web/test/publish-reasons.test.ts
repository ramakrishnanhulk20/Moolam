import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  hashTypedData,
  parseEther,
  recoverTypedDataAddress,
  toFunctionSelector,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import en from "@/messages/en.json";
import type { Dispute } from "@/lib/chain/registry";
import type { ResolveDisputes } from "@/lib/disputes/useResolveDisputes";
import type { OpenDispute } from "@/lib/disputes/queue";
import type { PublishDesk, PublishState } from "@/lib/disputes/usePublishReasons";

// Covers the resolver console's publish step (WO-284c step 6, L28) from fixtures: the typed data
// the resolver's wallet signs is the verify service's DecisionReasons field for field; every
// refusal the reasons route sends has its own line; the transaction is MoolamDecisions.publish;
// the step is done only from the DecisionPublished event MoolamDecisions wrote into the receipt,
// for this very dispute; a publish that has not shown is never offered a second send; the button
// says it is one more transaction and why; and a settled dispute's note never says its bond is
// still held.
// Does NOT cover a real Privy prompt, the live verify service, or a real transaction: none is sent.

const chainStub = vi.hoisted(() => ({
  receipts: new Map<string, unknown>(),
  logs: [] as { transactionHash: Hex }[],
}));
vi.mock("@/lib/chain/client", async (load) => {
  const actual = await load<typeof import("@/lib/chain/client")>();
  return {
    ...actual,
    chain: {
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const receipt = chainStub.receipts.get(hash);
        if (receipt === undefined) throw new Error("TransactionReceiptNotFoundError");
        return receipt;
      },
      getLogs: async () => chainStub.logs,
    },
  };
});
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; className?: string; children?: unknown }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined }),
}));

const { addresses } = await import("@/lib/chain/client");
const {
  DECISION_REASONS_TYPES,
  publishCalldata,
  publishedInReceipt,
  reasonsHashOf,
  reasonsRefusalOf,
  reasonsTextProblem,
  reasonsTypedData,
  walletReasonsTypedData,
  decisionsAbi,
} = await import("@/lib/disputes/reasons");
const { DECISIONS_ADDRESS, decisionPublishedEvent } = await import("@/lib/disputes/decisionsContract");
const { PublishNotShown, PublishPending, confirmPublish } = await import("@/lib/disputes/publishReasons");
const { PublishStep } = await import("@/components/resolve/PublishStep");
const { Desk } = await import("@/components/resolve/ResolveConsole");
const { ChallengeRecord } = await import("@/components/challenge/ChallengeRecord");

const PASSPORT = `0x${"5c".repeat(32)}` as Hex;
const OPENED_AT = 1_790_000_000n;
const CID = `bafkreid${"r".repeat(52)}`;
const URI = `ipfs://${CID}`;
const resolverKey = privateKeyToAccount(`0x${"61".repeat(32)}`);
const RESOLVER = resolverKey.address;
const STRANGER = getAddress("0x85a88Ca81Ff5F681D96AB86fA60ccB8452a139a6");
const HASH = `0x${"9a".repeat(32)}` as Hex;
const NOOP = () => undefined;
const ASYNC_NOOP = async () => undefined;

const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; timeZone: string; formats?: unknown }>;
function render(node: ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      Provider,
      { locale: "en", messages: en, timeZone: "UTC", formats: { dateTime: { moment: { dateStyle: "medium", timeStyle: "short" } } } },
      node,
    ),
  );
}

/** One DecisionPublished log as MoolamDecisions (or an impostor) would write it. */
function publishedLog(over: { address?: Hex; openedAt?: bigint; reasonsURI?: string; passportId?: Hex } = {}) {
  return {
    address: over.address ?? DECISIONS_ADDRESS,
    topics: encodeEventTopics({
      abi: [decisionPublishedEvent],
      eventName: "DecisionPublished",
      args: { passportId: over.passportId ?? PASSPORT, openedAt: over.openedAt ?? OPENED_AT },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: "bool" }, { type: "string" }, { type: "address" }],
      [true, over.reasonsURI ?? URI, RESOLVER],
    ),
  };
}

const EXPECTED = { passportId: PASSPORT, openedAt: OPENED_AT, reasonsURI: URI };

describe("L28: the resolver signs the very typed data the reasons route recovers", () => {
  it("names the same five fields in the same order as the service's DecisionReasons, in the answer's domain", () => {
    const source = readFileSync(fileURLToPath(new URL("../../verifier/src/challenges/reasons.ts", import.meta.url)), "utf8");
    const block = /DecisionReasons: \[([\s\S]*?)\],/.exec(source)?.[1] ?? "";
    const fields = [...block.matchAll(/name: "(\w+)", type: "(\w+)"/g)].map((match) => ({ name: match[1], type: match[2] }));
    expect(fields).toEqual(DECISION_REASONS_TYPES.DecisionReasons.map((field) => ({ ...field })));
    expect(source).toContain("domain(registry, MONAD_CHAIN_ID)");
    const typed = reasonsTypedData({ passportId: PASSPORT, openedAt: 1n, upheld: true, reasonsHash: reasonsHashOf("x"), deadline: 2n });
    expect(typed.domain).toEqual({ name: "Moolam", version: "1", chainId: 143, verifyingContract: addresses.registry });
  });

  it("hands the wallet a JSON-safe copy with the same digest, and the signature recovers to the resolver", async () => {
    const message = { passportId: PASSPORT, openedAt: OPENED_AT, upheld: false, reasonsHash: reasonsHashOf("Why.\n\nBecause."), deadline: OPENED_AT + 600n };
    const wallet = walletReasonsTypedData(message);
    expect(JSON.parse(JSON.stringify(wallet))).toEqual(wallet);
    expect(hashTypedData(wallet as never)).toBe(hashTypedData(reasonsTypedData(message)));
    const signature = await resolverKey.signTypedData(reasonsTypedData(message));
    expect(await recoverTypedDataAddress({ ...reasonsTypedData(message), signature })).toBe(RESOLVER);
  });

  it("holds the reasons to 8,000 bytes of printable text with line breaks", () => {
    expect(reasonsTextProblem("The evidence showed one thing.\r\n\r\nThe rule says another.")).toBeNull();
    expect(reasonsTextProblem("é".repeat(4_000))).toBeNull();
    expect(reasonsTextProblem(`${"é".repeat(4_000)}x`)).toBe("tooLong");
    expect(reasonsTextProblem(" \n ")).toBe("empty");
    expect(reasonsTextProblem("lone\rreturn")).toBe("notPrintable");
  });

  it("maps every refusal word the route sends to its own line", () => {
    const words: [number, string, string][] = [
      [403, "reasons-expired", "expired"],
      [403, "not-the-resolver", "notResolver"],
      [409, "dispute-not-settled", "notSettled"],
      [409, "dispute-mismatch", "mismatch"],
      [409, "already-published", "alreadyPublished"],
      [409, "pinning", "pinning"],
      [429, "global-limit", "busy"],
      [429, "", "busy"],
      [502, "pin-failed", "pinFailed"],
      [502, "address-unfit", "pinFailed"],
      [503, "chain-unreachable", "chainUnreachable"],
      [503, "reasons-unavailable", "unavailable"],
      [400, "the reasons are empty", "empty"],
      [400, "the reasons are over 8000 bytes", "tooLong"],
      [400, "the reasons must be printable text, with line breaks as their only control characters and no direction characters", "notPrintable"],
      [404, "not-found", "unavailable"],
      [500, "boom", "unknown"],
    ];
    for (const [status, word, key] of words) {
      expect(reasonsRefusalOf(status, word), word).toBe(key);
      expect(en.challenge.publish.refusals).toHaveProperty(key);
    }
  });

  it("sends exactly MoolamDecisions.publish(passportId, reasonsURI)", () => {
    const data = publishCalldata(PASSPORT, URI);
    expect(data.slice(0, 10)).toBe(toFunctionSelector("publish(bytes32,string)"));
    expect(decodeFunctionData({ abi: decisionsAbi, data }).args).toEqual([PASSPORT, URI]);
    expect(DECISIONS_ADDRESS).toBe("0x30AbA7747342fA3ac9d990Ec2Cf407cC968c497F");
  });
});

describe("L28: the publish is done only from MoolamDecisions' DecisionPublished event in its receipt", () => {
  it("reads the event for this dispute from a successful receipt", () => {
    expect(publishedInReceipt({ status: "success", logs: [publishedLog()] }, EXPECTED)).toEqual({
      passportId: PASSPORT,
      openedAt: OPENED_AT,
      upheld: true,
      reasonsURI: URI,
      resolver: RESOLVER,
    });
  });

  it("finds nothing in a reverted receipt, an impostor's log, or an event for another dispute or address", () => {
    expect(publishedInReceipt({ status: "reverted", logs: [publishedLog()] }, EXPECTED)).toBeNull();
    expect(publishedInReceipt({ status: "success", logs: [publishedLog({ address: STRANGER })] }, EXPECTED)).toBeNull();
    expect(publishedInReceipt({ status: "success", logs: [publishedLog({ openedAt: OPENED_AT + 1n })] }, EXPECTED)).toBeNull();
    expect(publishedInReceipt({ status: "success", logs: [publishedLog({ reasonsURI: `ipfs://${"z".repeat(46)}` })] }, EXPECTED)).toBeNull();
    expect(publishedInReceipt({ status: "success", logs: [publishedLog({ passportId: `0x${"6d".repeat(32)}` })] }, EXPECTED)).toBeNull();
    expect(publishedInReceipt({ status: "success", logs: [] }, EXPECTED)).toBeNull();
  });

  it("confirms from the hash's receipt, and from the event's own transaction when the wallet gave no hash", async () => {
    chainStub.receipts.set(HASH, { status: "success", logs: [publishedLog()] });
    expect((await confirmPublish({ ...EXPECTED, hash: HASH, fromBlock: 1n, windowMs: 50, pollMs: 5 })).hash).toBe(HASH);
    chainStub.logs = [{ transactionHash: HASH }];
    expect((await confirmPublish({ ...EXPECTED, fromBlock: 1n, windowMs: 50, pollMs: 5 })).published.reasonsURI).toBe(URI);
    chainStub.logs = [];
  });

  it("throws not-shown for a receipt without the event, and pending, never failed, when no receipt comes", async () => {
    const other = `0x${"8b".repeat(32)}` as Hex;
    chainStub.receipts.set(other, { status: "success", logs: [publishedLog({ address: STRANGER })] });
    await expect(confirmPublish({ ...EXPECTED, hash: other, fromBlock: 1n, windowMs: 50, pollMs: 5 })).rejects.toBeInstanceOf(PublishNotShown);
    await expect(
      confirmPublish({ ...EXPECTED, hash: `0x${"00".repeat(32)}`, fromBlock: 1n, windowMs: 20, pollMs: 5 }),
    ).rejects.toBeInstanceOf(PublishPending);
  });
});

describe("the publish step on the console", () => {
  const step = (over: Partial<PublishState> = {}): PublishState => ({ text: "", phase: "idle", refusal: null, ...over });
  const drawn = (over: Partial<PublishState> = {}) =>
    render(createElement(PublishStep, { passportId: PASSPORT, step: step(over), onText: NOOP, onPublish: NOOP, onRecheck: NOOP }));

  it("says on the button that it is one more transaction, and beside it why", () => {
    const markup = drawn();
    expect(markup).toContain("Sign and publish, one more transaction");
    expect(markup).toContain(en.challenge.publish.why.replace(/'/g, "&#x27;"));
    expect(markup).toContain("8,000 left");
  });

  it("names each stage in words, and locks the button while one runs", () => {
    for (const phase of ["signing", "pinning", "sending", "confirming"] as const) {
      const markup = drawn({ phase, text: "Why." });
      expect(markup).toContain(en.challenge.publish.states[phase].replace(/'/g, "&#x27;"));
      expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Sign and publish/);
    }
  });

  it("offers only another look for a publish that went out and has not shown", () => {
    const markup = drawn({ phase: "pending", hash: HASH, reasonsURI: URI });
    expect(markup).toContain("it must not be sent again");
    expect(markup).toContain("Ask Monad again");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Sign and publish/);
  });

  it("links the pinned reasons and the transaction once the receipt showed the event", () => {
    const markup = drawn({ phase: "done", hash: HASH, reasonsURI: URI });
    expect(markup).toContain("Published. Monad&#x27;s receipt carries");
    expect(markup).toContain(`href="https://gateway.pinata.cloud/ipfs/${CID}"`);
    expect(markup).toContain(`/tx/${HASH}`);
  });

  it("prints every refusal in its own words", () => {
    for (const [key, line] of Object.entries(en.challenge.publish.refusals)) {
      const markup = drawn({ refusal: key as never });
      expect(markup).toContain(`data-publish-refusal="${key}"`);
      expect(markup).toContain(line.replace(/'/g, "&#x27;"));
    }
  });

  function desk(over: Partial<ResolveDisputes> = {}): ResolveDisputes {
    return {
      ready: true,
      authenticated: true,
      wallet: RESOLVER,
      isResolver: true,
      credit: 0n,
      busy: null,
      confirming: false,
      settled: { [PASSPORT.toLowerCase()]: "upheld" },
      failure: null,
      withdrawing: false,
      withdrawn: false,
      ...over,
      actions: { settle: ASYNC_NOOP, withdraw: ASYNC_NOOP, recheck: ASYNC_NOOP, signIn: NOOP },
    };
  }
  const publish: PublishDesk = { steps: {}, setText: NOOP, publish: ASYNC_NOOP, recheck: ASYNC_NOOP };
  const row: OpenDispute = {
    passportId: PASSPORT,
    challenger: STRANGER,
    bond: parseEther("1").toString(),
    openedAt: Number(OPENED_AT),
    reason: "The same file is on a stock library from 2019.",
    evidenceURI: "data:text/plain;charset=utf-8,x",
    verified: true,
    title: "A registered picture",
    thumbnailUrl: null,
  };

  it("follows a settle with the publish step, for the resolver only", () => {
    const resolver = render(createElement(Desk, { desk: desk(), publish, waiting: [], resolver: RESOLVER, disputes: [row], listError: null }));
    expect(resolver).toContain("Upheld. The bond is credited back to the challenger");
    expect(resolver).toContain("Sign and publish, one more transaction");
    const stranger = render(
      createElement(Desk, { desk: desk({ isResolver: false, wallet: STRANGER }), publish, waiting: [], resolver: RESOLVER, disputes: [row], listError: null }),
    );
    expect(stranger).not.toContain("Sign and publish");
  });

  it("lists the settled decisions still owed their reasons, each with its step", () => {
    const other = `0x${"7e".repeat(32)}` as Hex;
    const markup = render(
      createElement(Desk, {
        desk: desk({ settled: {} }),
        publish,
        waiting: [{ passportId: other, upheld: false, openedAt: Number(OPENED_AT), resolvedAt: Number(OPENED_AT) + 86_400 }],
        resolver: RESOLVER,
        disputes: [],
        listError: null,
      }),
    );
    expect(markup).toContain("Decisions waiting for their reasons");
    expect(markup).toContain("Rejected on Sep 22, 2026");
    expect(markup).toContain(`/passport/${other}#decision`);
    expect(markup).toContain(`data-passport="${other}"`);
  });
});

describe("a settled dispute's note", () => {
  const dispute = (status: number): Dispute => ({
    challenger: STRANGER,
    bond: parseEther("1"),
    evidenceHash: `0x${"ab".repeat(32)}`,
    status,
    openedAt: OPENED_AT,
  });

  it("never says the bond is still held once the dispute is settled", () => {
    for (const status of [2, 3]) {
      const markup = render(createElement(ChallengeRecord, { passportId: PASSPORT, dispute: dispute(status), evidence: null, answer: { kind: "none" } }));
      expect(markup).not.toContain("held by the registry until");
      expect(markup).toContain("has settled it");
    }
    expect(render(createElement(ChallengeRecord, { passportId: PASSPORT, dispute: dispute(1), evidence: null, answer: { kind: "none" } }))).toContain(
      "held by the registry until the dispute is settled",
    );
  });
});
