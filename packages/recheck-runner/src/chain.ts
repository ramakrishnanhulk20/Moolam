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
    throw new RegistrationError(`the registration transaction ${txHash} did not succeed`);
  }
  const logs = Array.isArray(receipt.logs) ? (receipt.logs as ReceiptLog[]) : [];

  const at = logs.findIndex((log) => matches(log, passportId, registry));
  if (at === -1) {
    throw new RegistrationError(`transaction ${txHash} carries no PassportRegistered log for this passport`);
  }
  return at;
}

/**
 * A registration receipt the node did serve and that can never trigger a run: the transaction
 * reverted, or it holds no registration of this passport. Every other failure of eventIndex, a
 * timeout, a refused call, a receipt not served yet, is passing and is tried again.
 */
export class RegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrationError";
  }
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
  return logs.some((log) => isAttestation(log, passportId, registry));
}

/** The registry's VerificationAttested log for this passport, one predicate for every place that asks. */
function isAttestation(log: ReceiptLog, passportId: string, registry: string): boolean {
  return (
    typeof log === "object" &&
    log !== null &&
    typeof log.address === "string" &&
    log.address.toLowerCase() === registry.toLowerCase() &&
    Array.isArray(log.topics) &&
    String(log.topics[0] ?? "").toLowerCase() === VERIFICATION_ATTESTED_TOPIC &&
    String(log.topics[1] ?? "").toLowerCase() === passportId.toLowerCase()
  );
}

/**
 * The selector of the registry's `attestationCount(bytes32)`: keccak256 of that signature, first four
 * bytes. Checked against packages/contracts/out/MoolamRegistry.sol/MoolamRegistry.json.
 */
export const ATTESTATION_COUNT_SELECTOR = "0xd65ddd52";

const WORD = /^0x[0-9a-f]{64}$/i;

/**
 * How many verdicts the registry holds for this passport, read from the registry itself in one
 * eth_call rather than from the index, which can be hours behind. Throws on a passport id that is not
 * 32 bytes and on any answer that is not one 32-byte word, so a bad read is never taken as zero.
 */
export async function attestationCount(call: RpcCall, registry: string, passportId: string): Promise<bigint> {
  if (!WORD.test(passportId)) {
    throw new Error("the passport id is not 0x and 64 hex digits");
  }
  const result = await call("eth_call", [
    { to: registry.toLowerCase(), data: `${ATTESTATION_COUNT_SELECTOR}${passportId.slice(2).toLowerCase()}` },
    "latest",
  ]);
  if (typeof result !== "string" || !WORD.test(result)) {
    throw new Error("the registry gave no attestation count back");
  }
  return BigInt(result);
}

/** The latest block number, as a whole number. Throws on anything the node gives back that is not one. */
export async function blockNumber(call: RpcCall): Promise<number> {
  const result = await call("eth_blockNumber", []);
  if (typeof result !== "string" || !/^0x[0-9a-f]{1,13}$/i.test(result)) {
    throw new Error("the RPC gave no block number back");
  }
  return Number(BigInt(result));
}

/**
 * How far before the head noted at the start of a run the search begins, because the node the runner
 * reads and the one the CLI sends through need not agree on the latest block to the block.
 */
export const LOOKBACK_BLOCKS = 10;

/**
 * The widest block range asked for in one eth_getLogs call. Monad's public endpoints refuse wider
 * ranges than their providers allow, and a hundred is inside every limit they publish.
 */
export const LOG_CHUNK_BLOCKS = 100;

/**
 * The widest window searched, about an hour of Monad blocks at 0.4 seconds each, which is several
 * times the longest run the timeout allows. A wider window is not searched in part: the answer
 * would be a guess, so it throws and the caller reads that as cannot tell.
 */
export const MOST_BLOCKS_SEARCHED = 10_000;

/**
 * The most attestation logs for one passport looked at in one search. Past it the search throws
 * rather than stop early with an answer it has not finished checking.
 */
export const MOST_LOGS_CHECKED = 20;

export interface ReportSearch {
  passportId: string;
  registry: string;
  /** The CRE wallet, the one account that signs this runner's report transactions. */
  sender: string;
  /** The mock forwarder every report transaction is sent to. */
  forwarder: string;
  /** The chain head noted just before the run started. */
  head: number;
}

const TX_HASH = /^0x[0-9a-f]{64}$/;

/**
 * The report transaction a broadcast run sent for this passport, found on the chain rather than in
 * the CLI's output, or null when there is none.
 *
 * The CRE CLI v1.35.0 sends the report and can print no hash for it (seen on 2026-09-27, report
 * 0x37717b0c...). So the registry's VerificationAttested logs with topic1 equal to the passport id
 * are read from a few blocks before the noted head to the latest block, newest first, in chunks, and
 * a log counts only when its transaction's receipt has status 1, was sent from `sender` to
 * `forwarder`, and carries that same attestation. A log from anyone else, a copy of this workflow
 * sent by another wallet included, is not taken.
 *
 * Every read that fails, a refused call, a malformed answer, a receipt the node does not serve, a
 * window or a log count past its cap, throws: "not found" is said only after every log in the whole
 * window was checked.
 */
export async function findLandedReport(call: RpcCall, search: ReportSearch): Promise<string | null> {
  if (!Number.isSafeInteger(search.head) || search.head < 0) {
    throw new Error("the chain head noted before the run is not a block number");
  }
  const passportId = search.passportId.toLowerCase();
  const registry = search.registry.toLowerCase();
  const sender = search.sender.toLowerCase();
  const forwarder = search.forwarder.toLowerCase();

  const latest = await blockNumber(call);
  const from = Math.max(0, search.head - LOOKBACK_BLOCKS);
  if (latest < from) {
    throw new Error(`the node's latest block ${latest} is behind the block ${from} the run started near`);
  }
  if (latest - from + 1 > MOST_BLOCKS_SEARCHED) {
    throw new Error(`the run spans ${latest - from + 1} blocks, more than the ${MOST_BLOCKS_SEARCHED} searched`);
  }

  let checked = 0;
  for (let to = latest; to >= from; to -= LOG_CHUNK_BLOCKS) {
    const start = Math.max(from, to - LOG_CHUNK_BLOCKS + 1);
    const result = await call("eth_getLogs", [
      {
        address: registry,
        topics: [VERIFICATION_ATTESTED_TOPIC, passportId],
        fromBlock: `0x${start.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
      },
    ]);
    if (!Array.isArray(result)) {
      throw new Error("the RPC gave no log list back");
    }
    for (const entry of result.reverse() as unknown[]) {
      const log = entry as ReceiptLog & { transactionHash?: unknown; removed?: unknown };
      if (log === null || typeof log !== "object" || log.removed === true || !isAttestation(log, passportId, registry)) {
        continue;
      }
      checked += 1;
      if (checked > MOST_LOGS_CHECKED) {
        throw new Error(`more than ${MOST_LOGS_CHECKED} attestation logs for this passport in the window`);
      }
      const tx = typeof log.transactionHash === "string" ? log.transactionHash.toLowerCase() : "";
      if (!TX_HASH.test(tx)) {
        throw new Error("an attestation log came back with no transaction hash");
      }
      if (await sentByRunner(call, tx, passportId, registry, sender, forwarder)) {
        return tx;
      }
    }
  }
  return null;
}

/** Whether this transaction is one of the runner's own reports that landed for this passport. */
async function sentByRunner(
  call: RpcCall,
  tx: string,
  passportId: string,
  registry: string,
  sender: string,
  forwarder: string,
): Promise<boolean> {
  const result = await call("eth_getTransactionReceipt", [tx]);
  if (result === null || typeof result !== "object") {
    throw new Error(`the node has no receipt for ${tx}, which carries an attestation log`);
  }
  const receipt = result as { status?: unknown; from?: unknown; to?: unknown; logs?: unknown };
  const logs = Array.isArray(receipt.logs) ? (receipt.logs as ReceiptLog[]) : [];
  return (
    typeof receipt.status === "string" &&
    /^0x[0-9a-f]+$/i.test(receipt.status) &&
    BigInt(receipt.status) === 1n &&
    typeof receipt.from === "string" &&
    receipt.from.toLowerCase() === sender &&
    typeof receipt.to === "string" &&
    receipt.to.toLowerCase() === forwarder &&
    logs.some((log) => isAttestation(log, passportId, registry))
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
