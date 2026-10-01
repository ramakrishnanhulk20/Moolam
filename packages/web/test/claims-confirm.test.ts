import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, pad, type Hex } from "viem";
import { addresses, consentAbi } from "@/lib/chain/client";
import type { WaitingClaim } from "@/lib/claims/client";
import {
  consentBatchRequest,
  heldBatch,
  receiptConfirms,
  runConfirm,
  type ConfirmDeps,
  type ConfirmEvent,
  type HolderReads,
} from "@/lib/claims/confirm";
import { CONSENT_SET_TOPIC, type ReceiptLike } from "@/lib/cosign/landed";

/**
 * The confirm step (WO-264, P26, P37, P13): the batch holds only passports the
 * signed-in wallet holds now and has not already confirmed, never more than 32,
 * the press sends nothing when what it would sign differs from what was shown,
 * and "confirmed" is said only from a successful receipt carrying this wallet's
 * ConsentSet for every passport in the batch.
 */

const WALLET = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;
const PLATFORM_WALLET = "0x85a88Ca81Ff5F681D96AB86fA60ccB8452a139a6" as Hex;
const HASH = `0x${"77".repeat(32)}` as Hex;

const TERMS = {
  aiTraining: "notAllowed",
  aiGenerativeTraining: "notAllowed",
  aiInference: "allowed",
  dataMining: "notAllowed",
  constraintInfo: "",
} as const;

function passport(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}` as Hex;
}

function delivered(n: number): WaitingClaim {
  return {
    ticketId: n.toString(16).padStart(32, "0"),
    passportId: passport(n),
    platform: { name: "Dreamloom", keyHash: `0x${"a1".repeat(32)}` as Hex },
    state: "delivered",
    destination: WALLET,
    terms: TERMS,
  };
}

/** A chain where each passport has a holder and, maybe, a latest consent writer. */
function chainOf(holders: Record<string, Hex | null>, writers: Record<string, Hex> = {}): HolderReads {
  return {
    ownerOf: async (id) => holders[id] ?? null,
    latestEntry: async (id) => (writers[id] === undefined ? null : { writer: writers[id], at: 1_790_000_000 }),
  };
}

function consentLog(id: Hex, writer: Hex, register: Hex = addresses.consent) {
  return { address: register, topics: [CONSENT_SET_TOPIC, id, pad(writer.toLowerCase() as Hex, { size: 32 })] };
}

function receipt(logs: ReceiptLike["logs"], status: ReceiptLike["status"] = "success"): ReceiptLike {
  return { status, transactionHash: HASH, logs };
}

describe("the batch a press confirms", () => {
  it("drops the passports this wallet does not hold, reading the holder in any case", async () => {
    const entries = [1, 2, 3, 4].map(delivered);
    const reads = chainOf({
      [passport(1)]: WALLET.toLowerCase() as Hex,
      [passport(2)]: PLATFORM_WALLET,
      [passport(3)]: null,
      [passport(4)]: WALLET,
    });
    const batch = await heldBatch(entries, WALLET, reads);
    expect(batch.ids).toEqual([passport(1), passport(4)]);
  });

  it("drops a passport this wallet already wrote terms on, and keeps one the platform wrote on", async () => {
    const entries = [1, 2].map(delivered);
    const reads = chainOf({ [passport(1)]: WALLET, [passport(2)]: WALLET }, { [passport(1)]: WALLET, [passport(2)]: PLATFORM_WALLET });
    const batch = await heldBatch(entries, WALLET, reads);
    expect(batch.ids).toEqual([passport(2)]);
    expect(batch.since[passport(2)]).toBe(1_790_000_000);
  });

  it("never holds more than 32, and reads each passport once however many tickets name it", async () => {
    const entries = [...Array.from({ length: 40 }, (_, n) => delivered(n + 1)), delivered(1), delivered(2)];
    const holders = Object.fromEntries(Array.from({ length: 40 }, (_, n) => [passport(n + 1), WALLET]));
    const ownerOf = vi.fn(async (id: Hex) => holders[id] ?? null);
    const batch = await heldBatch(entries, WALLET, { ownerOf, latestEntry: async () => null });
    expect(batch.ids).toHaveLength(32);
    expect(new Set(batch.ids).size).toBe(32);
    expect(ownerOf).toHaveBeenCalledTimes(40);
  });

  it("throws when the chain does not answer, rather than reading silence as nothing held", async () => {
    const reads: HolderReads = { ownerOf: async () => Promise.reject(new Error("rpc down")), latestEntry: async () => null };
    await expect(heldBatch([delivered(1)], WALLET, reads)).rejects.toThrow("rpc down");
  });

  it("is written as setConsentBatch over exactly those ids, and refuses 0 or 33", () => {
    const ids = [passport(1), passport(2)];
    const request = consentBatchRequest(ids, TERMS);
    expect(request.to).toBe(addresses.consent);
    const decoded = decodeFunctionData({ abi: consentAbi, data: request.data });
    expect(decoded.functionName).toBe("setConsentBatch");
    expect(decoded.args?.[0]).toEqual(ids);
    expect(() => consentBatchRequest([], TERMS)).toThrow(RangeError);
    expect(() => consentBatchRequest(Array.from({ length: 33 }, (_, n) => passport(n + 1)), TERMS)).toThrow(RangeError);
  });
});

describe("a confirm press", () => {
  const ids = [passport(1), passport(2)];
  const entries = ids.map((_, n) => delivered(n + 1));

  function deps(found: ReceiptLike | null, overrides: Partial<ConfirmDeps> = {}) {
    const send = vi.fn(async () => HASH as Hex | undefined);
    const all: ConfirmDeps = {
      ...chainOf({ [passport(1)]: WALLET, [passport(2)]: WALLET }),
      simulate: async () => undefined,
      send,
      waitLanded: async () => undefined,
      receipt: async () => (found === null ? null : { hash: HASH, receipt: found }),
      ...overrides,
    };
    return { all, send: (overrides.send as typeof send | undefined) ?? send };
  }

  async function press(found: ReceiptLike | null, overrides: Partial<ConfirmDeps> = {}) {
    const events: ConfirmEvent[] = [];
    const { all, send } = deps(found, overrides);
    await runConfirm({ shown: ids, entries, terms: TERMS, wallet: WALLET }, all, (event) => events.push(event));
    return { events, send };
  }

  it("is confirmed after a successful receipt with this wallet's ConsentSet for every passport", async () => {
    const { events } = await press(receipt(ids.map((id) => consentLog(id, WALLET))));
    expect(events.map((event) => event.at)).toEqual(["checking", "sending", "confirming", "done"]);
    expect(events.at(-1)).toEqual({ at: "done", txHash: HASH });
  });

  it("is never confirmed from a receipt without ConsentSet, with it for only some ids, from another writer or register, or reverted", async () => {
    const cases: [string, ReceiptLike | null][] = [
      ["no receipt found", null],
      ["no logs", receipt([])],
      ["one id only", receipt([consentLog(ids[0], WALLET)])],
      ["another writer", receipt(ids.map((id) => consentLog(id, PLATFORM_WALLET)))],
      ["another contract", receipt(ids.map((id) => consentLog(id, WALLET, addresses.registry)))],
      ["reverted", receipt(ids.map((id) => consentLog(id, WALLET)), "reverted")],
    ];
    for (const [name, found] of cases) {
      const { events } = await press(found);
      expect(events.some((event) => event.at === "done"), name).toBe(false);
      expect(events.at(-1), name).toEqual({ at: "unconfirmed", hash: HASH });
    }
    expect(receiptConfirms(receipt([]), [], WALLET)).toBe(false);
  });

  it("sends nothing when the wallet no longer holds what was shown, and says the list changed", async () => {
    const { events, send } = await press(null, chainOf({ [passport(1)]: WALLET, [passport(2)]: PLATFORM_WALLET }));
    expect(events.map((event) => event.at)).toEqual(["checking", "changed"]);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends exactly the shown ids, from the signed-in wallet, once", async () => {
    const send = vi.fn<(request: { ids: Hex[]; data: Hex }, from: Hex) => Promise<Hex | undefined>>(async () => HASH);
    await press(receipt(ids.map((id) => consentLog(id, WALLET))), { send });
    expect(send).toHaveBeenCalledTimes(1);
    const [request, from] = send.mock.calls[0];
    expect(from).toBe(WALLET);
    expect(decodeFunctionData({ abi: consentAbi, data: request.data }).args?.[0]).toEqual(ids);
  });

  it("lets a refused simulation through as an error before anything is sent", async () => {
    const send = vi.fn(async () => HASH as Hex | undefined);
    const events: ConfirmEvent[] = [];
    const { all } = deps(null, { send, simulate: async () => Promise.reject(new Error("NotPassportHolder")) });
    await expect(runConfirm({ shown: ids, entries, terms: TERMS, wallet: WALLET }, all, (event) => events.push(event))).rejects.toThrow(
      "NotPassportHolder",
    );
    expect(send).not.toHaveBeenCalled();
    expect(events.map((event) => event.at)).toEqual(["checking"]);
  });
});
