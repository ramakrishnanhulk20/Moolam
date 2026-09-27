import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PASSPORT_REGISTERED_TOPIC,
  VERIFICATION_ATTESTED_TOPIC,
  LOG_CHUNK_BLOCKS,
  attestationLanded,
  balanceWei,
  eventIndex,
  findLandedReport,
  type ReceiptLog,
  type RpcCall,
} from "../src/chain.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = "0xa19188801e5dc93cd925884d73e4dafc2bcb80c0";

function receipt(name: string): unknown {
  const body = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", name), "utf8")) as { result: unknown };
  return body.result;
}

/** A plain register from the demo creator: PassportRegistered is the first log of its transaction. */
const PLAIN = receipt("receipt-40ae6d62.json");
/** A studio register through the ERC-4337 entry point: the entry point's own log comes first. */
const STUDIO = receipt("receipt-c432d323.json");

function rpc(result: unknown): RpcCall {
  return async () => result;
}

/** A public workflow report on mainnet: the registry's attestation, then the forwarder's ReportProcessed true. */
const LANDED_PUBLIC = receipt("receipt-085d8500.json");
const PUBLIC_PASSPORT = "0x0c45b008db6a6b74b203e63e7659fc86c60c2598d762e0280c4ae12fc57e0e2e";
/** A private workflow report on mainnet, through the second receiver. */
const LANDED_SEALED = receipt("receipt-dc1834ea.json");
const SEALED_PASSPORT = "0x864c33c6806185d4dc7acd65f465fc4c3cb6b8faaa157c32880cbef9dd93fc09";
/**
 * The public receipt as the mock forwarder leaves a refused report: status 1, the registry's log
 * gone, and ReportProcessed carrying result false. Made from the real one above, not captured.
 */
const REFUSED = receipt("receipt-085d8500-refused.json");

describe("whether a report's verdict landed", () => {
  const noWait = async (): Promise<void> => {};

  it("is true when the registry logged the attestation, through either receiver", async () => {
    expect(await attestationLanded(rpc(LANDED_PUBLIC), `0x${"1".repeat(64)}`, PUBLIC_PASSPORT, REGISTRY)).toBe(true);
    expect(await attestationLanded(rpc(LANDED_SEALED), `0x${"1".repeat(64)}`, SEALED_PASSPORT.toUpperCase().replace("0X", "0x"), REGISTRY)).toBe(true);
  });

  it("is false for a transaction that succeeded while the forwarder refused the report", async () => {
    expect((REFUSED as { status: string }).status).toBe("0x1");
    expect(await attestationLanded(rpc(REFUSED), `0x${"1".repeat(64)}`, PUBLIC_PASSPORT, REGISTRY)).toBe(false);
  });

  it("is false for another passport's attestation and for a log from another contract", async () => {
    expect(await attestationLanded(rpc(LANDED_PUBLIC), `0x${"1".repeat(64)}`, SEALED_PASSPORT, REGISTRY)).toBe(false);
    expect(await attestationLanded(rpc(LANDED_PUBLIC), `0x${"1".repeat(64)}`, PUBLIC_PASSPORT, `0x${"9".repeat(40)}`)).toBe(false);
  });

  it("is false for a reverted transaction", async () => {
    const reverted = { ...(LANDED_PUBLIC as object), status: "0x0" };
    expect(await attestationLanded(rpc(reverted), `0x${"1".repeat(64)}`, PUBLIC_PASSPORT, REGISTRY)).toBe(false);
  });

  it("waits for a receipt the node has not served yet, then gives up loudly", async () => {
    let asked = 0;
    const late: RpcCall = async () => (++asked < 3 ? null : LANDED_PUBLIC);
    expect(await attestationLanded(late, `0x${"1".repeat(64)}`, PUBLIC_PASSPORT, REGISTRY, noWait)).toBe(true);
    expect(asked).toBe(3);

    await expect(attestationLanded(rpc(null), `0x${"1".repeat(64)}`, PUBLIC_PASSPORT, REGISTRY, noWait)).rejects.toThrow(
      "no receipt",
    );
  });

  it("holds the same topic hash the registry actually emitted", () => {
    const logs = (LANDED_SEALED as { logs: ReceiptLog[] }).logs;
    expect(logs[0]?.topics[0]).toBe(VERIFICATION_ATTESTED_TOPIC);
  });
});

describe("finding the event index the CRE CLI wants", () => {
  it("is 0 for a plain registration, which is what the 2026-09-17 run used", async () => {
    const at = await eventIndex(
      rpc(PLAIN),
      "0x40ae6d620c35eeb6e36b68d188d9960294bb210abadca86fd58c71209b7b05e3",
      "0x0c45b008db6a6b74b203e63e7659fc86c60c2598d762e0280c4ae12fc57e0e2e",
      REGISTRY,
    );
    expect(at).toBe(0);
  });

  it("is 1 for a studio registration, which is what recheck-run-3.sh used", async () => {
    const at = await eventIndex(
      rpc(STUDIO),
      "0xc432d323a2b71ab2855da8cc6f133d40299c85602dd53477c9fa0c68eab66b72",
      "0x3dae5ee9d854d6af49857150873cefbe2df2a585e35ea86d34f0f47cb3b6403d",
      REGISTRY,
    );
    expect(at).toBe(1);
  });

  it("counts every log of the transaction, not only the ones the trigger would match", () => {
    const logs = (STUDIO as { logs: { topics: string[] }[] }).logs;
    expect(logs).toHaveLength(4);
    expect(logs[0]?.topics[0]).not.toBe(PASSPORT_REGISTERED_TOPIC);
    expect(logs[1]?.topics[0]).toBe(PASSPORT_REGISTERED_TOPIC);
  });

  it("holds the same topic hash the registry actually emitted", () => {
    const logs = (PLAIN as { logs: { topics: string[] }[] }).logs;
    expect(logs[0]?.topics[0]).toBe(PASSPORT_REGISTERED_TOPIC);
  });

  it("refuses a transaction that carries no registration for this passport", async () => {
    await expect(
      eventIndex(
        rpc(PLAIN),
        "0x40ae6d620c35eeb6e36b68d188d9960294bb210abadca86fd58c71209b7b05e3",
        `0x${"1".repeat(64)}`,
        REGISTRY,
      ),
    ).rejects.toThrowError(/carries no PassportRegistered log/);
  });

  it("refuses a log from some other contract that happens to carry the same topic", async () => {
    const forged = {
      status: "0x1",
      logs: [{ address: `0x${"9".repeat(40)}`, topics: [PASSPORT_REGISTERED_TOPIC, `0x${"2".repeat(64)}`] }],
    };
    await expect(eventIndex(rpc(forged), "0xabc", `0x${"2".repeat(64)}`, REGISTRY)).rejects.toThrowError(
      /carries no PassportRegistered log/,
    );
  });

  it("refuses a registration transaction that reverted", async () => {
    await expect(eventIndex(rpc({ status: "0x0", logs: [] }), "0xabc", "0xdef", REGISTRY)).rejects.toThrowError(
      /did not succeed/,
    );
  });

  it("says so plainly when the node has no receipt at all", async () => {
    await expect(eventIndex(rpc(null), "0xabc", "0xdef", REGISTRY)).rejects.toThrowError(/has no receipt/);
  });
});

describe("the wallet floor", () => {
  it("reads a balance as wei", async () => {
    const wei = await balanceWei(rpc("0x18845013d85310000"), "0xc79620af233a4434b03f6b57239f8a9e71b3c178");
    expect(wei).toBe(28_266_000_000_000_000_000n);
  });

  it("says so rather than reading zero when the node gives nothing back", async () => {
    await expect(balanceWei(rpc(undefined), "0xabc")).rejects.toThrowError(/no balance/);
  });
});

describe("finding a report the CLI printed no hash for (WO-190)", () => {
  // The facts of the 2026-09-27 run on the VM: the CLI v1.35.0 sent this report and printed no hash.
  const PASSPORT = "0xfd09a7710088e9bdcdd630904668c29e54a4042eafdab74f25749d397eef6c98";
  const TX = "0x37717b0c067afcc65bf79d036de55c2bcc1b22b08143b3ac28c3320bd3abe24b";
  const BLOCK = 108_499_297;
  const CRE_WALLET = "0xc79620af233a4434b03f6b57239f8a9e71b3c178";
  const FORWARDER = "0x9ef6468c5f37b976e57d52054c693269479a784d";
  const STRANGER = `0x${"5".repeat(40)}`;
  const OTHER_PASSPORT = `0x${"2".repeat(64)}`;

  function attestation(passportId: string, tx: string, block: number): Record<string, unknown> {
    return {
      address: REGISTRY,
      topics: [VERIFICATION_ATTESTED_TOPIC, passportId, `0x${"0".repeat(24)}4ad66c77f961884e9e866eeec3eaff1edb5baa95`],
      transactionHash: tx,
      blockNumber: `0x${block.toString(16)}`,
      removed: false,
    };
  }

  /** A node holding the given logs and receipts, recording every range it was asked for. */
  function chain(input: {
    latest: number;
    logs: Record<string, unknown>[];
    receipts: Record<string, Record<string, unknown>>;
    refuseLogs?: boolean;
  }): { call: RpcCall; ranges: [number, number][] } {
    const ranges: [number, number][] = [];
    const call: RpcCall = async (method, params) => {
      if (method === "eth_blockNumber") {
        return `0x${input.latest.toString(16)}`;
      }
      if (method === "eth_getLogs") {
        if (input.refuseLogs === true) {
          throw new Error("eth_getLogs was refused: block range too large");
        }
        const filter = params[0] as { fromBlock: string; toBlock: string };
        const from = Number(filter.fromBlock);
        const to = Number(filter.toBlock);
        ranges.push([from, to]);
        return input.logs.filter((log) => {
          const at = Number(log.blockNumber);
          return at >= from && at <= to;
        });
      }
      if (method === "eth_getTransactionReceipt") {
        return input.receipts[String(params[0])] ?? null;
      }
      throw new Error(`unexpected ${method}`);
    };
    return { call, ranges };
  }

  function receiptOf(tx: string, passportId: string, from: string, to: string, status = "0x1"): Record<string, unknown> {
    return { transactionHash: tx, status, from, to, logs: [attestation(passportId, tx, BLOCK)] };
  }

  const search = { passportId: PASSPORT, registry: REGISTRY, sender: CRE_WALLET, forwarder: FORWARDER, head: BLOCK - 40 };

  it("finds the observed report: status 1, from the CRE wallet to the forwarder, the passport's attestation", async () => {
    const node = chain({
      latest: BLOCK + 3,
      logs: [attestation(PASSPORT, TX, BLOCK)],
      receipts: { [TX]: receiptOf(TX, PASSPORT, CRE_WALLET.toUpperCase().replace("0X", "0x"), FORWARDER) },
    });
    expect(await findLandedReport(node.call, { ...search, passportId: PASSPORT.toUpperCase().replace("0X", "0x") })).toBe(TX);
  });

  it("does not take a log whose transaction another wallet sent, or sent somewhere else, or that reverted", async () => {
    for (const [name, receipt] of [
      ["another sender", receiptOf(TX, PASSPORT, STRANGER, FORWARDER)],
      ["another destination", receiptOf(TX, PASSPORT, CRE_WALLET, STRANGER)],
      ["a reverted transaction", receiptOf(TX, PASSPORT, CRE_WALLET, FORWARDER, "0x0")],
    ] as const) {
      const node = chain({ latest: BLOCK + 3, logs: [attestation(PASSPORT, TX, BLOCK)], receipts: { [TX]: receipt } });
      expect(await findLandedReport(node.call, search), name).toBeNull();
    }
  });

  it("does not take another passport's attestation, even from a node that serves it for this filter", async () => {
    const node = chain({
      latest: BLOCK + 3,
      logs: [attestation(OTHER_PASSPORT, TX, BLOCK)],
      receipts: { [TX]: receiptOf(TX, OTHER_PASSPORT, CRE_WALLET, FORWARDER) },
    });
    expect(await findLandedReport(node.call, search)).toBeNull();
  });

  it("searches from a few blocks before the head to the latest block, newest first, in chunks the RPC accepts", async () => {
    const node = chain({ latest: BLOCK + 3, logs: [], receipts: {} });
    expect(await findLandedReport(node.call, search)).toBeNull();
    expect(node.ranges[0]?.[1]).toBe(BLOCK + 3);
    expect(node.ranges.at(-1)?.[0]).toBeLessThan(search.head);
    for (const [from, to] of node.ranges) {
      expect(to - from + 1).toBeLessThanOrEqual(LOG_CHUNK_BLOCKS);
    }
    for (let at = 1; at < node.ranges.length; at += 1) {
      expect(node.ranges[at]?.[1]).toBe((node.ranges[at - 1]?.[0] ?? 0) - 1);
    }
  });

  it("throws rather than answer when the logs cannot be read, a receipt is missing, or the window is too wide", async () => {
    const refused = chain({ latest: BLOCK + 3, logs: [], receipts: {}, refuseLogs: true });
    await expect(findLandedReport(refused.call, search)).rejects.toThrow("refused");

    const missing = chain({ latest: BLOCK + 3, logs: [attestation(PASSPORT, TX, BLOCK)], receipts: {} });
    await expect(findLandedReport(missing.call, search)).rejects.toThrow("no receipt");

    const wide = chain({ latest: BLOCK + 50_000, logs: [], receipts: {} });
    await expect(findLandedReport(wide.call, search)).rejects.toThrow("more than");
  });
});
