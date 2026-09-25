import { postJson, type Fetcher } from "./net.js";

/** One JSON-RPC method call. Injected everywhere so a test never needs a network. */
export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

/**
 * keccak256("PassportRegistered(bytes32,address,uint256,bytes32,uint64,bytes32,bytes32,uint8,uint8,string)").
 * Checked against the real registration log in test/fixtures/receipt-40ae6d62.json, which is the
 * transaction the 2026-09-17 run was triggered from.
 */
export const PASSPORT_REGISTERED_TOPIC =
  "0xb70b26ce4fba5ba06bd6a36a2ddd778d24f45e3e993a1092efbdc89e5a9d966a";

export function rpcCall(url: string, fetcher: Fetcher = fetch): RpcCall {
  return async (method, params) => {
    const body = await postJson<{ result?: unknown; error?: { message?: string } }>(
      fetcher,
      url,
      { jsonrpc: "2.0", id: 1, method, params },
      `the RPC call ${method}`,
    );
    if (body.error !== undefined) {
      throw new Error(`${method} was refused: ${body.error.message ?? "no reason given"}`);
    }
    return body.result;
  };
}

export async function balanceWei(call: RpcCall, address: string): Promise<bigint> {
  const result = await call("eth_getBalance", [address, "latest"]);
  if (typeof result !== "string") {
    throw new Error("the RPC gave no balance back");
  }
  return BigInt(result);
}

/** One transaction's logs, as the node serves them. */
export interface ReceiptLog {
  address: string;
  topics: string[];
}

/**
 * Where `PassportRegistered` sits among the logs of its own transaction.
 *
 * This is what `--evm-event-index` counts: the position inside the transaction, not inside the
 * block. A plain register puts it at 0; a registration sent through the ERC-4337 entry point puts
 * the entry point's own log first and this one at 1, which is why the 2026-09-17 studio run was
 * pointed at index 1. Both cases are held in test/fixtures as real receipts.
 */
export async function eventIndex(
  call: RpcCall,
  txHash: string,
  passportId: string,
  registry: string,
): Promise<number> {
  const result = await call("eth_getTransactionReceipt", [txHash]);
  if (result === null || typeof result !== "object") {
    throw new Error(`the node has no receipt for ${txHash}`);
  }
  const receipt = result as { status?: string; logs?: unknown };
  if (receipt.status !== undefined && BigInt(receipt.status) !== 1n) {
    throw new Error(`the registration transaction ${txHash} did not succeed`);
  }
  const logs = Array.isArray(receipt.logs) ? (receipt.logs as ReceiptLog[]) : [];

  const at = logs.findIndex((log) => matches(log, passportId, registry));
  if (at === -1) {
    throw new Error(`transaction ${txHash} carries no PassportRegistered log for this passport`);
  }
  return at;
}

/**
 * keccak256("VerificationAttested(bytes32,address,bool,uint16,bytes32)"), the registry's own event
 * for a verdict it stored. Checked against the real report receipts in test/fixtures,
 * receipt-085d8500.json (the public receiver) and receipt-dc1834ea.json (the private one).
 */
export const VERIFICATION_ATTESTED_TOPIC =
  "0x6e190a7c871dff7b9619ca66f174bed2406fc12d04890052b2c4bb1e4f61fd5e";

/** How often a report receipt the node has not served yet is asked for, and the wait between. */
const RECEIPT_TRIES = 5;
const RECEIPT_WAIT_MS = 3_000;

/**
 * Whether a report transaction put a verdict about this passport into the registry.
 *
 * Transaction status is not enough: Chainlink's MockKeystoneForwarder never reverts on a report its
 * receiver refused, so that transaction succeeds and only its ReportProcessed log says false. The
 * one thing true exactly when the verdict landed, whichever receiver and whichever forwarder
 * carried it, is the registry's VerificationAttested log for this passport in that same receipt.
 * A reverted transaction is false. A receipt the node never serves throws, and the caller treats
 * that as not landed.
 */
export async function attestationLanded(
  call: RpcCall,
  txHash: string,
  passportId: string,
  registry: string,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  let result: unknown = null;
  for (let attempt = 1; attempt <= RECEIPT_TRIES; attempt++) {
    result = await call("eth_getTransactionReceipt", [txHash]);
    if (result !== null && typeof result === "object") {
      break;
    }
    if (attempt < RECEIPT_TRIES) {
      await wait(RECEIPT_WAIT_MS);
    }
  }
  if (result === null || typeof result !== "object") {
    throw new Error(`the node has no receipt for the report transaction ${txHash}`);
  }

  const receipt = result as { status?: string; logs?: unknown };
  if (receipt.status === undefined || BigInt(receipt.status) !== 1n) {
    return false;
  }
  const logs = Array.isArray(receipt.logs) ? (receipt.logs as ReceiptLog[]) : [];
  return logs.some(
    (log) =>
      typeof log.address === "string" &&
      log.address.toLowerCase() === registry.toLowerCase() &&
      Array.isArray(log.topics) &&
      (log.topics[0] ?? "").toLowerCase() === VERIFICATION_ATTESTED_TOPIC &&
      (log.topics[1] ?? "").toLowerCase() === passportId.toLowerCase(),
  );
}

function matches(log: ReceiptLog, passportId: string, registry: string): boolean {
  return (
    typeof log.address === "string" &&
    log.address.toLowerCase() === registry.toLowerCase() &&
    Array.isArray(log.topics) &&
    (log.topics[0] ?? "").toLowerCase() === PASSPORT_REGISTERED_TOPIC &&
    (log.topics[1] ?? "").toLowerCase() === passportId.toLowerCase()
  );
}
