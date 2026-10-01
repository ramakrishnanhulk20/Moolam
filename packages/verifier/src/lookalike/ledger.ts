import { isAddressEqual, parseAbiItem } from "viem";
import type { Hex } from "../types.js";
import type { LookalikeRecordView } from "./backlog.js";

/** The event MoolamLookalikes writes for every record it stores (WO-273's interface). */
export const LOOKALIKE_CHECKED_EVENT = parseAbiItem(
  "event LookalikeChecked(bytes32 indexed passportId, bytes32 indexed earlierId, uint16 phashDistance, uint16 blockhashDistance, bool earlierSealed, uint64 executedAt)",
);

/** Blocks per eth_getLogs call: Monad's public RPC refuses a wide range, and 100 is the window this service already walks. */
export const LEDGER_CHUNK_BLOCKS = 100n;

/**
 * Chunks one refresh reads at most, 5,000 blocks or about half an hour of Monad. A refresh a minute
 * keeps up with the chain at two chunks; a fresh boot catches up over its first refreshes and says
 * "not ready" until it has.
 */
export const LEDGER_CHUNKS_PER_REFRESH = 50;

/** How far back from the head the first step of the search for the activation block goes. */
const FIRST_STEP_BLOCKS = 1_000n;

/** One log as the scan reads it, every field checked before it is believed. */
export interface LedgerLog {
  address?: unknown;
  removed?: unknown;
  args?: { passportId?: unknown; executedAt?: unknown };
}

/** The three reads the scan makes. A viem public client has all three. */
export interface LedgerChain {
  getBlockNumber: () => Promise<bigint>;
  getBlock: (args: { blockNumber: bigint }) => Promise<{ timestamp: bigint }>;
  getLogs: (args: {
    address: Hex;
    event: typeof LOOKALIKE_CHECKED_EVENT;
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<readonly LedgerLog[]>;
}

const PASSPORT_ID = /^0x[0-9a-fA-F]{64}$/;
const MAX_UINT64 = (1n << 64n) - 1n;

/**
 * The look-alike records MoolamLookalikes has written since activation, read from its
 * LookalikeChecked events by the background refresh and never while a request waits. It is the
 * bridge until the index carries these records itself.
 *
 * It keeps the newest executedAt per passport, counting only records at or after activation (L14),
 * and says it is ready only once a scan has reached the chain head it read when it began.
 */
export class LookalikeLedger {
  private next: bigint | undefined;
  private readonly newest = new Map<Hex, number>();
  private caughtUp = false;

  constructor(
    private readonly chain: LedgerChain,
    private readonly receiver: Hex,
    private readonly activation: number,
  ) {}

  view(): LookalikeRecordView {
    return {
      ready: this.caughtUp,
      newestAt: (passportId) => this.newest.get(passportId.toLowerCase() as Hex),
    };
  }

  /**
   * Reads on from where the last scan stopped, at most LEDGER_CHUNKS_PER_REFRESH chunks. Never
   * throws: a read that fails keeps everything read before it, marks the ledger not caught up, and
   * the next refresh carries on from the same block.
   */
  async advance(): Promise<void> {
    const found = new Map<Hex, number>();
    let caughtUp = false;
    try {
      const head = await this.chain.getBlockNumber();
      let from = this.next ?? (await this.firstBlockFrom(head));
      this.next = from;
      for (let chunk = 0; chunk < LEDGER_CHUNKS_PER_REFRESH && from <= head; chunk += 1) {
        const to: bigint = from + LEDGER_CHUNK_BLOCKS - 1n < head ? from + LEDGER_CHUNK_BLOCKS - 1n : head;
        const logs = await this.chain.getLogs({
          address: this.receiver,
          event: LOOKALIKE_CHECKED_EVENT,
          fromBlock: from,
          toBlock: to,
        });
        for (const log of logs) {
          const read = this.readLog(log);
          if (read !== undefined && (found.get(read.id) ?? -1) < read.executedAt) {
            found.set(read.id, read.executedAt);
          }
        }
        from = to + 1n;
        this.next = from;
      }
      caughtUp = from > head;
    } catch {
      caughtUp = false;
    } finally {
      for (const [id, at] of found) {
        if ((this.newest.get(id) ?? -1) < at) this.newest.set(id, at);
      }
      this.caughtUp = caughtUp;
    }
  }

  /** A log read like an input: this receiver, not removed, a passport id, and a record at or after activation. */
  private readLog(log: LedgerLog): { id: Hex; executedAt: number } | undefined {
    if (log.removed === true) return undefined;
    if (typeof log.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(log.address)) return undefined;
    if (!isAddressEqual(log.address as Hex, this.receiver)) return undefined;
    const id = log.args?.passportId;
    const executedAt = log.args?.executedAt;
    if (typeof id !== "string" || !PASSPORT_ID.test(id)) return undefined;
    if (typeof executedAt !== "bigint" || executedAt < 0n || executedAt > MAX_UINT64) return undefined;
    if (executedAt < BigInt(this.activation) || executedAt > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    return { id: id.toLowerCase() as Hex, executedAt: Number(executedAt) };
  }

  /**
   * The first block at or after the activation time: steps back from the head, doubling, until a
   * block before activation, then halves the gap. About 2 log2(blocks back) block reads, once per
   * process. A head still before activation answers the block after it, so the scan starts there.
   */
  private async firstBlockFrom(head: bigint): Promise<bigint> {
    const at = async (block: bigint): Promise<bigint> => (await this.chain.getBlock({ blockNumber: block })).timestamp;
    const activation = BigInt(this.activation);
    if ((await at(head)) < activation) return head + 1n;
    let high = head;
    let step = FIRST_STEP_BLOCKS;
    let low = head > step ? head - step : 0n;
    while ((await at(low)) >= activation) {
      if (low === 0n) return 0n;
      high = low;
      step *= 2n;
      low = head > step ? head - step : 0n;
    }
    while (high - low > 1n) {
      const middle = (low + high) / 2n;
      if ((await at(middle)) >= activation) high = middle;
      else low = middle;
    }
    return high;
  }
}
