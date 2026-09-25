import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PASSPORT_REGISTERED_TOPIC,
  VERIFICATION_ATTESTED_TOPIC,
  attestationLanded,
  balanceWei,
  eventIndex,
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
