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

function matches(log: ReceiptLog, passportId: string, registry: string): boolean {
  return (
    typeof log.address === "string" &&
    log.address.toLowerCase() === registry.toLowerCase() &&
    Array.isArray(log.topics) &&
    (log.topics[0] ?? "").toLowerCase() === PASSPORT_REGISTERED_TOPIC &&
    (log.topics[1] ?? "").toLowerCase() === passportId.toLowerCase()
  );
}
