import { type Transport } from "viem";
import { CONSTRAINT_INFO_MAX_BYTES, TRAINING_STANDARD } from "./consent.js";
import { env } from "./env.js";
import { monadTransport, readClient } from "./reputation/registry.js";
import type { Hex } from "./types.js";

/**
 * The one function this service calls on MoolamConsent. Only `consentOf` is here: a verify answer
 * quotes the statement that stands today, and reading history or a past date is a different
 * question nobody asks on this path.
 */
export const consentAbi = [
  {
    type: "function",
    name: "consentOf",
    stateMutability: "view",
    inputs: [{ name: "passportId", type: "bytes32" }],
    outputs: [
      { name: "stated", type: "bool" },
      {
        name: "latest",
        type: "tuple",
        components: [
          { name: "at", type: "uint64" },
          { name: "writer", type: "address" },
          {
            name: "consent",
            type: "tuple",
            components: [
              { name: "aiTraining", type: "uint8" },
              { name: "aiGenerativeTraining", type: "uint8" },
              { name: "aiInference", type: "uint8" },
              { name: "dataMining", type: "uint8" },
            ],
          },
          { name: "constraintInfo", type: "string" },
        ],
      },
    ],
  },
] as const;

/**
 * The contract's Use enum in its own order, 0 to 3. The chain stores a number and this is the only
 * place it becomes a word; a number outside this list is not guessed at, it makes the read fail.
 */
const USE_WORDS = ["unspecified", "allowed", "notAllowed", "constrained"] as const;

export type Use = (typeof USE_WORDS)[number];

/** How long one passport's answer is held before the chain is asked again. */
export const CONSENT_TTL_MS = 60_000;

/**
 * How many passports are remembered at once. Two thousand answers is a few hundred kilobytes and
 * far more than one busy minute of verifications, and the oldest leaves when a new one arrives, so
 * a flood of unknown passports cannot grow this process's memory without limit.
 */
export const CONSENT_CACHE_MAX = 2_000;

/**
 * How long one read may take. A verification is the answer the caller came for, so a slow or
 * unreachable RPC costs five seconds at most and then the statement is reported as unavailable.
 */
export const CONSENT_READ_TIMEOUT_MS = 5_000;

/** What the holder stated, as the chain holds it today. */
export interface StatedConsent {
  source: "chain";
  stated: true;
  standard: typeof TRAINING_STANDARD;
  aiTraining: Use;
  aiGenerativeTraining: Use;
  aiInference: Use;
  dataMining: Use;
  constraintInfo?: string;
  /** Unix seconds: the block timestamp the statement was written at. */
  at: number;
  /** The address that held the passport when it was written. */
  writer: Hex;
}

/**
 * One of three answers, and never a fourth. "chain" with stated false is the contract saying the
 * holder has never spoken; "unavailable" is this service saying it could not find out, which is
 * not the same thing and must never be read as permission.
 */
export type ConsentAnswer = StatedConsent | { source: "chain"; stated: false } | { source: "unavailable" };

const UNAVAILABLE: ConsentAnswer = { source: "unavailable" };

/** The decoded shape of one `consentOf` call. */
export type ConsentCall = (passportId: Hex) => Promise<
  readonly [
    boolean,
    {
      at: bigint;
      writer: string;
      consent: { aiTraining: number; aiGenerativeTraining: number; aiInference: number; dataMining: number };
      constraintInfo: string;
    },
  ]
>;

export interface ConsentReader {
  /** Never rejects. A read that fails, times out or comes back malformed answers "unavailable". */
  answerFor: (passportId: string) => Promise<ConsentAnswer>;
}

/**
 * The same predicate for a passport id everywhere: 32 bytes of hex, in either case.
 *
 * The ids this service reads come out of its own index, but they reach the reader through a
 * rendered JSON answer, so they are checked once here and both the cache key and the eth_call use
 * what this function accepted rather than a second reading of the same string.
 */
export function isPassportId(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Printable ASCII and nothing else, the same rule the contract enforces on the way in. One
 * predicate over the bytes rather than a list of characters to refuse, so a newline, a tab, a
 * control byte and every multi-byte character are all out without anyone having to think of them.
 */
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;

function useWordFor(value: number): Use | undefined {
  return Number.isInteger(value) && value >= 0 && value < USE_WORDS.length ? USE_WORDS[value] : undefined;
}

/**
 * Turns one decoded `consentOf` answer into the shape this service publishes.
 *
 * Everything here is input to somebody else's parser, so it is checked as hard as a request body:
 * a field outside the contract's enum, a timestamp too large for a JSON number and a writer that
 * is not an address all make the whole answer unavailable rather than half true, and constraint
 * text that is not what the contract promised is dropped while the rest of the statement stands.
 */
export function answerFromChain(raw: Awaited<ReturnType<ConsentCall>>): ConsentAnswer {
  const [stated, entry] = raw;
  if (!stated) {
    return { source: "chain", stated: false };
  }

  const aiTraining = useWordFor(entry.consent.aiTraining);
  const aiGenerativeTraining = useWordFor(entry.consent.aiGenerativeTraining);
  const aiInference = useWordFor(entry.consent.aiInference);
  const dataMining = useWordFor(entry.consent.dataMining);
  if (
    aiTraining === undefined ||
    aiGenerativeTraining === undefined ||
    aiInference === undefined ||
    dataMining === undefined
  ) {
    return UNAVAILABLE;
  }

  if (entry.at < 0n || entry.at > BigInt(Number.MAX_SAFE_INTEGER)) {
    return UNAVAILABLE;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(entry.writer)) {
    return UNAVAILABLE;
  }

  const answer: StatedConsent = {
    source: "chain",
    stated: true,
    standard: TRAINING_STANDARD,
    aiTraining,
    aiGenerativeTraining,
    aiInference,
    dataMining,
    at: Number(entry.at),
    writer: entry.writer as Hex,
  };

  const info = entry.constraintInfo;
  if (info.length > 0 && PRINTABLE_ASCII.test(info) && Buffer.byteLength(info, "utf8") <= CONSTRAINT_INFO_MAX_BYTES) {
    answer.constraintInfo = info;
  }
  return answer;
}

/**
 * Reads what a passport's holder has stated about AI use, with a short memory in front of it.
 *
 * A stated or not-stated answer is kept for `ttlMs`, because a statement changes at most once
 * every ten minutes on chain and the same picture is often verified twice in a row. A failed read
 * is never kept: pinning "unavailable" for a minute would hide a statement that is there and the
 * chain is reachable again, and the route's own rate limit is what bounds the retries.
 *
 * Tests pass their own `call` or `transport`; nothing here touches the network on its own.
 */
export function consentReader(
  options: {
    call?: ConsentCall;
    address?: Hex;
    rpcUrl?: string;
    transport?: Transport;
    ttlMs?: number;
    maxEntries?: number;
    timeoutMs?: number;
  } = {},
): ConsentReader {
  const ttlMs = options.ttlMs ?? CONSENT_TTL_MS;
  const maxEntries = options.maxEntries ?? CONSENT_CACHE_MAX;
  const timeoutMs = options.timeoutMs ?? CONSENT_READ_TIMEOUT_MS;
  const call = options.call ?? chainCall(options);
  const cache = new Map<Hex, { answer: ConsentAnswer; expiresAt: number }>();

  const remember = (key: Hex, answer: ConsentAnswer): void => {
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
    answerFor: async (passportId: string): Promise<ConsentAnswer> => {
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
        // Reading the answer sits inside the same try as the call that produced it. A call that
        // resolves to something this reader cannot destructure, undefined among them, has to come
        // out as "unavailable" here rather than as a thrown error at the walker, where it would
        // cost this passport its dispute status and its re-check count as well.
        const answer = answerFromChain(await withTimeout(call(key), timeoutMs));
        if (answer.source === "chain") {
          remember(key, answer);
        }
        return answer;
      } catch {
        return UNAVAILABLE;
      }
    },
  };
}

/** A reader that answers "unavailable" for everything without opening a connection. */
export function offlineConsentReader(): ConsentReader {
  return { answerFor: async () => UNAVAILABLE };
}

/**
 * Attaches however many facts `answerFor` resolves for one passport to the exact match, the best
 * match and the first registration, and to no others.
 *
 * At most three passports are read: the exact match, the best match, and the passport named by
 * `firstRegisteredId`, each once however many of those slots it fills. The first registration is
 * read because a later near copy can be the closest match, and its holder's statement must not be
 * the only one in the answer when the original's holder said something else (review pass 4, V18).
 * The other candidates in `matches` are near misses on a fingerprint, not pictures the caller
 * asked about, and reading twenty statements to answer one verification would put twenty chain
 * calls behind every upload.
 *
 * `answerFor` gets one passport id and returns every field to merge onto that passport's match at
 * once, so a caller reading more than one fact per passport (the consent statement and the dispute
 * status) starts every read for that passport at the same moment rather than waiting through one
 * before starting the next. The two can never disagree about which passports a verification speaks
 * for, because they are attached through this one walker.
 *
 * Never throws. A verification that came back is what the caller came for, so anything unexpected
 * here leaves the answer exactly as it was.
 */
export async function withMatchFacts<T extends { result: unknown }>(
  payload: T,
  answerFor: (passportId: Hex) => Promise<Record<string, unknown>>,
): Promise<T> {
  try {
    const result = payload.result;
    if (!isRecord(result)) {
      return payload;
    }

    const best = isRecord(result.best) ? result.best : undefined;
    const wanted: Hex[] = [];
    for (const id of [result.exact, best?.id, result.firstRegisteredId]) {
      if (isPassportId(id)) {
        const key = id.toLowerCase() as Hex;
        if (!wanted.includes(key)) {
          wanted.push(key);
        }
      }
    }
    if (wanted.length === 0) {
      return payload;
    }

    const answers = new Map<Hex, Record<string, unknown>>(
      await Promise.all(wanted.map(async (id): Promise<[Hex, Record<string, unknown>]> => [id, await answerFor(id)])),
    );

    const withId = (match: Record<string, unknown>): Record<string, unknown> => {
      const extra = isPassportId(match.id) ? answers.get(match.id.toLowerCase() as Hex) : undefined;
      return extra === undefined ? match : { ...match, ...extra };
    };

    const matches = Array.isArray(result.matches)
      ? result.matches.map((match) => (isRecord(match) ? withId(match) : match))
      : result.matches;

    return {
      ...payload,
      result: { ...result, matches, ...(best === undefined ? {} : { best: withId(best) }) },
    };
  } catch {
    return payload;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`the consent read took longer than ${ms} ms`)), ms);
  });
  return Promise.race([work, limit]).finally(() => {
    clearTimeout(timer);
  });
}

/** The live read: the service's own Monad client, pointed at the consent contract. */
function chainCall(options: { address?: Hex; rpcUrl?: string; transport?: Transport }): ConsentCall {
  const address = options.address ?? (env.CONSENT_ADDRESS as Hex);
  const client = readClient({
    transport:
      options.transport ?? monadTransport({ rpcUrl: options.rpcUrl, timeout: CONSENT_READ_TIMEOUT_MS }),
  });
  return async (passportId: Hex) =>
    await client.readContract({ address, abi: consentAbi, functionName: "consentOf", args: [passportId] });
}
