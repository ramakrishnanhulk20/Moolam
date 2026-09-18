import { type Transport } from "viem";
import { env } from "./env.js";
import { isPassportId, withMatchFact } from "./consentRead.js";
import { monadTransport, readClient } from "./reputation/registry.js";
import type { Hex } from "./types.js";

/**
 * The one function this service calls on MoolamRegistry. `getDispute` answers for any id, so a
 * passport nobody has ever challenged comes back as a zeroed record with status None, which is the
 * answer a reader wants rather than a revert to handle.
 *
 * Written out here because the container ships only this package's source and cannot read the
 * Foundry build output. The shape is packages/contracts/abi/MoolamRegistry.json, field for field.
 */
export const disputeAbi = [
  {
    type: "function",
    name: "getDispute",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "challenger", type: "address" },
          { name: "bond", type: "uint256" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "status", type: "uint8" },
          { name: "openedAt", type: "uint64" },
        ],
      },
    ],
  },
] as const;

/**
 * The contract's DisputeStatus enum in its own order, 0 to 3. The chain stores a number and this is
 * the only place it becomes a word; a number outside this list is not guessed at, it makes the read
 * unavailable.
 */
const STATUS_WORDS = ["none", "open", "upheld", "rejected"] as const;

export type DisputeStatus = (typeof STATUS_WORDS)[number];

/** How long one passport's answer is held before the chain is asked again. */
export const DISPUTE_TTL_MS = 60_000;

/**
 * How many passports are remembered at once, on the same reasoning as the consent memory: far more
 * than one busy minute of verifications, and the oldest leaves when a new one arrives, so a flood
 * of unknown passports cannot grow this process's memory without limit.
 */
export const DISPUTE_CACHE_MAX = 2_000;

/**
 * How long one read may take. A verification is the answer the caller came for, so a slow or
 * unreachable RPC costs five seconds at most and then the dispute is reported as unavailable.
 */
export const DISPUTE_READ_TIMEOUT_MS = 5_000;

/**
 * Two answers, and never a third. "chain" is the registry's own word about this passport, where
 * "none" means nobody has challenged it. "unavailable" is this service saying it could not find
 * out, which is not the same thing and must never be read as a clean record.
 */
export type DisputeAnswer = { source: "chain"; status: DisputeStatus } | { source: "unavailable" };

const UNAVAILABLE: DisputeAnswer = { source: "unavailable" };

/** The decoded shape of one `getDispute` call. */
export type DisputeCall = (passportId: Hex) => Promise<{
  challenger: string;
  bond: bigint;
  evidenceHash: string;
  status: number;
  openedAt: bigint;
}>;

export interface DisputeReader {
  /** Never rejects. A read that fails, times out or comes back malformed answers "unavailable". */
  answerFor: (passportId: string) => Promise<DisputeAnswer>;
}

/**
 * Turns one decoded `getDispute` answer into the shape this service publishes.
 *
 * Only the status is published. The challenger, the bond and the evidence hash belong to whoever is
 * settling the dispute, and a verify answer is read by strangers, so the one fact that changes how
 * a statement should be read is the one fact that goes out.
 *
 * A status the enum has no room for makes the whole answer unavailable rather than a guess at the
 * nearest word: this value is input to somebody else's parser.
 */
export function answerFromChain(raw: Awaited<ReturnType<DisputeCall>>): DisputeAnswer {
  const status = raw.status;
  if (!Number.isInteger(status) || status < 0 || status >= STATUS_WORDS.length) {
    return UNAVAILABLE;
  }
  return { source: "chain", status: STATUS_WORDS[status] as DisputeStatus };
}

/**
 * Reads whether a passport is under dispute, with a short memory in front of it.
 *
 * The same pattern as the consent read next door: an answer from the chain is kept for `ttlMs`
 * because the same picture is often verified twice in a row, and a failed read is never kept, since
 * pinning "unavailable" for a minute would hide a dispute that is there and the chain reachable
 * again.
 *
 * The chain is read rather than the passport index, because the index is rebuilt on a timer and a
 * dispute opened since the last rebuild is exactly the case a reader must not miss.
 *
 * Tests pass their own `call` or `transport`; nothing here touches the network on its own.
 */
export function disputeReader(
  options: {
    call?: DisputeCall;
    address?: Hex;
    rpcUrl?: string;
    transport?: Transport;
    ttlMs?: number;
    maxEntries?: number;
    timeoutMs?: number;
  } = {},
): DisputeReader {
  const ttlMs = options.ttlMs ?? DISPUTE_TTL_MS;
  const maxEntries = options.maxEntries ?? DISPUTE_CACHE_MAX;
  const timeoutMs = options.timeoutMs ?? DISPUTE_READ_TIMEOUT_MS;
  const call = options.call ?? chainCall(options);
  const cache = new Map<Hex, { answer: DisputeAnswer; expiresAt: number }>();

  const remember = (key: Hex, answer: DisputeAnswer): void => {
    // Deleting first keeps the map in write order, which is what makes the first key the oldest.
    cache.delete(key);
    while (cache.size >= maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done === true) {
        break;
      }
      cache.delete(oldest.value);
    }
    cache.set(key, { answer, expiresAt: Date.now() + ttlMs });
  };

  return {
    answerFor: async (passportId: string): Promise<DisputeAnswer> => {
      if (!isPassportId(passportId)) {
        return UNAVAILABLE;
      }
      const key = passportId.toLowerCase() as Hex;

      const held = cache.get(key);
      if (held !== undefined) {
        if (held.expiresAt > Date.now()) {
          return held.answer;
        }
        cache.delete(key);
      }

      let raw: Awaited<ReturnType<DisputeCall>>;
      try {
        raw = await withTimeout(call(key), timeoutMs);
      } catch {
        return UNAVAILABLE;
      }

      const answer = answerFromChain(raw);
      if (answer.source === "chain") {
        remember(key, answer);
      }
      return answer;
    },
  };
}

/** A reader that answers "unavailable" for everything without opening a connection. */
export function offlineDisputeReader(): DisputeReader {
  return { answerFor: async () => UNAVAILABLE };
}

/**
 * Attaches the dispute fact to the answer the verify routes already built, through the same walker
 * the consent statement goes through, so both speak for exactly the same passports.
 */
export async function withDispute<T extends { result: unknown }>(payload: T, reader: DisputeReader): Promise<T> {
  return await withMatchFact(payload, "dispute", async (id) => await reader.answerFor(id));
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`the dispute read took longer than ${ms} ms`)), ms);
  });
  return Promise.race([work, limit]).finally(() => {
    clearTimeout(timer);
  });
}

/** The live read: the service's own Monad client, pointed at the registry. */
function chainCall(options: { address?: Hex; rpcUrl?: string; transport?: Transport }): DisputeCall {
  const address = options.address ?? (env.MOOLAM_REGISTRY_ADDRESS as Hex);
  const client = readClient({
    transport: options.transport ?? monadTransport({ rpcUrl: options.rpcUrl, timeout: DISPUTE_READ_TIMEOUT_MS }),
  });
  return async (passportId: Hex) =>
    await client.readContract({ address, abi: disputeAbi, functionName: "getDispute", args: [passportId] });
}
