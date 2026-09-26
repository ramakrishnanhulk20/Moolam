import { type Transport } from "viem";
import { env } from "./env.js";
import { isPassportId, withMatchFacts, type ConsentAnswer, type ConsentReader } from "./consentRead.js";
import { recheckFor, type RecheckAnswer } from "./recheck.js";
import { FACT_ENDPOINT_TIMEOUT_MS, monadTransport, readClient } from "./reputation/registry.js";
import type { Hex, PassportRecord } from "./types.js";
import type { PictureAnswer, PictureReader } from "./unseal.js";

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

/**
 * How long an upheld dispute is held before the chain is asked again. Upheld is the ruling's last
 * word, so this memory can only lag a later change the registry does not make.
 */
export const DISPUTE_TTL_MS = 60_000;

/**
 * How long any other answer is held: none, open and rejected can all change with the next block, and
 * a "none" kept for a minute went out as the chain's word over a flag mined seconds later (review
 * pass 6, V46).
 */
export const DISPUTE_CHANGEABLE_TTL_MS = 10_000;

/**
 * How many passports are remembered at once, on the same reasoning as the consent memory: far more
 * than one busy minute of verifications, and the oldest leaves when a new one arrives, so a flood
 * of unknown passports cannot grow this process's memory without limit.
 */
export const DISPUTE_CACHE_MAX = 2_000;

/**
 * How long one read may take. A verification is the answer the caller came for, so a slow or
 * unreachable RPC costs five seconds at most and then the dispute is reported as unavailable.
 * Each endpoint gets FACT_ENDPOINT_TIMEOUT_MS of it, so the fallback can answer for a stalled first.
 */
export const DISPUTE_READ_TIMEOUT_MS = 5_000;

/**
 * Two answers, and never a third. "chain" is the registry's own word about this passport, where
 * "none" means nobody has challenged it, with `readAt`, the unix seconds of the read it came from,
 * because an answer can come out of the memory below. "unavailable" is this service saying it could
 * not find out, which is not the same thing and must never be read as a clean record.
 */
export type DisputeAnswer = { source: "chain"; status: DisputeStatus; readAt: number } | { source: "unavailable" };

const UNAVAILABLE: DisputeAnswer = { source: "unavailable" };

/**
 * Whether a challenge against a passport above this one in the edit chain was upheld. The registry
 * marks only the passport a challenge named, and appendEdit does not refuse a disputed parent, so
 * an edit of a picture proven wrong reads "none" in its own dispute fact. This is the fact beside it
 * that says so, with the nearest ancestor whose challenge was upheld.
 *
 * "none" means every ancestor was read on chain and none was upheld. An open or rejected challenge
 * above does not carry down, the same rule the index uses for inheritedDisputed. `readAt` is the
 * read the answer rests on: the upheld ancestor's, or the oldest of the reads behind a "none".
 */
export type InheritedDisputeAnswer =
  | { source: "chain"; status: "upheld"; ancestor: Hex; readAt: number }
  | { source: "chain"; status: "none"; readAt: number }
  | { source: "unavailable" };

const INHERITED_UNAVAILABLE: InheritedDisputeAnswer = { source: "unavailable" };

/**
 * How many passports above a match are read. Each one is a getDispute read behind the same memory
 * and five second timeout, started together, so a verify answer naming three passports costs at
 * most three times this many reads more. An edit chain deeper than this still has its first eight
 * read and answers upheld when one of them is, and "unavailable" rather than a "none" nobody
 * checked when none of them is (review pass 6, V47).
 */
export const INHERITED_DISPUTE_MAX_DEPTH = 8;

/**
 * What the other three facts say when their own reader could not answer.
 *
 * They live here rather than being imported because each of those modules keeps its own word for
 * this and none of them exports it; what matters is that all four say the same thing, which is that
 * this service could not find out, and never that there is nothing to find.
 */
const CONSENT_UNAVAILABLE: ConsentAnswer = { source: "unavailable" };
const RECHECK_UNAVAILABLE: RecheckAnswer = { source: "unavailable" };
const PICTURE_UNAVAILABLE: PictureAnswer = { source: "unavailable" };

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
 * nearest word: this value is input to somebody else's parser. `readAt` is the unix seconds the
 * read was made at.
 */
export function answerFromChain(raw: Awaited<ReturnType<DisputeCall>>, readAt: number): DisputeAnswer {
  const status = raw.status;
  if (!Number.isInteger(status) || status < 0 || status >= STATUS_WORDS.length) {
    return UNAVAILABLE;
  }
  return { source: "chain", status: STATUS_WORDS[status] as DisputeStatus, readAt };
}

/**
 * Reads whether a passport is under dispute, with a short memory in front of it.
 *
 * An upheld answer is kept for `ttlMs`, because the ruling does not change; every other answer for
 * at most `changeableTtlMs`, ten seconds, because a flag can be mined at any moment (review pass 6,
 * V46). Either way the answer says when it was read. A failed read is never kept, since pinning
 * "unavailable" would hide a dispute that is there and the chain reachable again.
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
    changeableTtlMs?: number;
    maxEntries?: number;
    timeoutMs?: number;
  } = {},
): DisputeReader {
  const ttlMs = options.ttlMs ?? DISPUTE_TTL_MS;
  const changeableTtlMs = Math.min(options.changeableTtlMs ?? DISPUTE_CHANGEABLE_TTL_MS, ttlMs);
  const maxEntries = options.maxEntries ?? DISPUTE_CACHE_MAX;
  const timeoutMs = options.timeoutMs ?? DISPUTE_READ_TIMEOUT_MS;
  const call = options.call ?? chainCall(options);
  const cache = new Map<Hex, { answer: DisputeAnswer; expiresAt: number }>();

  const remember = (key: Hex, answer: DisputeAnswer, heldFor: number): void => {
    // Deleting first keeps the map in write order, which is what makes the first key the oldest.
    cache.delete(key);
    while (cache.size >= maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done === true) {
        break;
      }
      cache.delete(oldest.value);
    }
    cache.set(key, { answer, expiresAt: Date.now() + heldFor });
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

      try {
        // Reading the status sits inside the same try as the call that produced it. A call that
        // resolves to something with no status on it, undefined among them, has to come out as
        // "unavailable" here rather than as a thrown error at the walker, where it would cost this
        // passport its consent statement and its re-check count as well.
        const readAt = Math.floor(Date.now() / 1000);
        const answer = answerFromChain(await withTimeout(call(key), timeoutMs), readAt);
        if (answer.source === "chain") {
          remember(key, answer, answer.status === "upheld" ? ttlMs : changeableTtlMs);
        }
        return answer;
      } catch {
        return UNAVAILABLE;
      }
    },
  };
}

/** A reader that answers "unavailable" for everything without opening a connection. */
export function offlineDisputeReader(): DisputeReader {
  return { answerFor: async () => UNAVAILABLE };
}

/**
 * Attaches the facts a verify answer carries, for the exact match, the best match and the
 * first registration when the answer names one (review pass 4, V18): the
 * holder's statement on AI use, the dispute status that says how much weight that statement should
 * carry, and beside it whether a picture this one was edited from was proven wrong (review pass 5),
 * what has re-checked the picture since it was registered, and whether the picture itself
 * is public, sealed, or sealed and published later by its holder. Both verify routes call this
 * one function rather than one walk per fact, so for each passport the two chain reads start at the
 * same moment and are awaited together. Each reader keeps its own memory and its own five second
 * timeout exactly as it does on its own, so the worst case for the whole attachment is one timeout,
 * not two waited through in turn. Every consent, dispute and picture fact that was read says when,
 * in `readAt`, and none that can change is more than ten seconds old (review pass 6, V46).
 *
 * The re-check fact costs nothing to add: `recordFor` is this service's own passport index, keyed
 * by the passport id, which is the sha256 of the registered bytes. It is a map hit on records the
 * match itself just ran against, so the fact is as fresh as the last index refresh and no slower
 * than answering without it.
 *
 * The picture fact reads the passport's metadata document and, for a sealed one, the record its
 * holder pins on unsealing. It starts at the same moment as the two chain reads and is bounded by
 * the same five seconds, so it adds no wait of its own. It is what tells an API or x402 caller
 * that a match is sealed, which the answer never said before: nothing in it names where the
 * picture lives either way.
 *
 * The four are read behind their own guards, so one reader that throws where it promised not to
 * costs its own field and nothing else. Losing the consent statement is bad; losing the dispute
 * status, the second opinion and the picture state along with it, because of one bad answer from
 * one source, is the failure this shape is here to make impossible.
 */
export async function withPassportFacts<T extends { result: unknown }>(
  payload: T,
  consent: ConsentReader,
  dispute: DisputeReader,
  recordFor: (passportId: Hex) => PassportRecord | undefined,
  picture: PictureReader,
): Promise<T> {
  return await withMatchFacts(payload, async (id) => {
    // One index lookup feeds both facts that need the record, so they describe the same copy of it.
    const record = await orUnavailable(async () => recordFor(id), undefined);
    const [consentAnswer, disputeAnswer, inheritedAnswer, recheckAnswer, pictureAnswer] = await Promise.all([
      orUnavailable(async () => await consent.answerFor(id), CONSENT_UNAVAILABLE),
      orUnavailable(async () => await dispute.answerFor(id), UNAVAILABLE),
      orUnavailable(async () => await inheritedDispute(record, dispute, recordFor), INHERITED_UNAVAILABLE),
      orUnavailable(async () => recheckFor(record), RECHECK_UNAVAILABLE),
      orUnavailable(async () => await picture.answerFor(record), PICTURE_UNAVAILABLE),
    ]);
    return {
      consent: consentAnswer,
      dispute: disputeAnswer,
      inheritedDispute: inheritedAnswer,
      recheck: recheckAnswer,
      picture: pictureAnswer,
    };
  });
}

/**
 * Walks the parent links up from a passport and reads each ancestor's dispute on chain.
 *
 * The links come from this service's own index, because a passport's parent is written once at
 * registration and never changes, so an index row cannot be stale about it. The dispute status can
 * change at any moment, so that is read from the chain, through the same reader and memory as the
 * direct fact. The first INHERITED_DISPUTE_MAX_DEPTH ancestors are read whatever lies beyond them,
 * and an upheld one among them is the answer (review pass 6, V47). Only when none is upheld does a
 * link the index cannot follow, a loop, a chain past the cap, or one read that failed make the
 * answer "unavailable": "none" is said only when every ancestor was read.
 */
async function inheritedDispute(
  record: PassportRecord | undefined,
  dispute: DisputeReader,
  recordFor: (passportId: Hex) => PassportRecord | undefined,
): Promise<InheritedDisputeAnswer> {
  if (record === undefined) {
    return INHERITED_UNAVAILABLE;
  }

  const ancestors: Hex[] = [];
  const seen = new Set<string>([record.id.toLowerCase()]);
  let whole = true;
  let parentId = record.parentId;
  while (parentId !== null) {
    const key = parentId.toLowerCase();
    if (ancestors.length >= INHERITED_DISPUTE_MAX_DEPTH || seen.has(key)) {
      whole = false;
      break;
    }
    seen.add(key);
    ancestors.push(key as Hex);
    // A parent the index does not hold still has a dispute to read; only the walk above it stops.
    const parent = recordFor(parentId);
    if (parent === undefined) {
      whole = false;
      break;
    }
    parentId = parent.parentId;
  }

  const answers = await Promise.all(ancestors.map(async (id) => await dispute.answerFor(id)));
  // Nearest first, so the ancestor named is the closest picture proven wrong.
  const upheld = answers.findIndex((answer) => answer.source === "chain" && answer.status === "upheld");
  const ruling = answers[upheld];
  if (ruling !== undefined && ruling.source === "chain") {
    return { source: "chain", status: "upheld", ancestor: ancestors[upheld] as Hex, readAt: ruling.readAt };
  }
  const reads: number[] = [];
  for (const answer of answers) {
    if (answer.source !== "chain") {
      return INHERITED_UNAVAILABLE;
    }
    reads.push(answer.readAt);
  }
  if (!whole) {
    return INHERITED_UNAVAILABLE;
  }
  // An original has no ancestor to read, so its "none" is as old as this answer.
  return { source: "chain", status: "none", readAt: reads.length === 0 ? Math.floor(Date.now() / 1000) : Math.min(...reads) };
}

/**
 * One fact's reader, with its failure kept off the other two.
 *
 * Every reader here promises never to reject, and each one keeps that promise inside itself. This
 * is the belt for the day one of them stops keeping it: a verify answer that lost one fact is
 * worth far more to a reader than one that lost all four.
 */
async function orUnavailable<T>(read: () => Promise<T>, unavailable: T): Promise<T> {
  try {
    return await read();
  } catch {
    return unavailable;
  }
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

/**
 * The live read: the service's own Monad client, pointed at the registry, with each endpoint held
 * to FACT_ENDPOINT_TIMEOUT_MS inside the read's own five seconds.
 */
function chainCall(options: { address?: Hex; rpcUrl?: string; transport?: Transport }): DisputeCall {
  const address = options.address ?? (env.MOOLAM_REGISTRY_ADDRESS as Hex);
  const client = readClient({
    transport: options.transport ?? monadTransport({ rpcUrl: options.rpcUrl, timeout: FACT_ENDPOINT_TIMEOUT_MS }),
  });
  return async (passportId: Hex) =>
    await client.readContract({ address, abi: disputeAbi, functionName: "getDispute", args: [passportId] });
}
