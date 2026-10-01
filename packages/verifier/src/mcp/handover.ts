import { getAddress, type Address } from "viem";
import { z } from "zod";
import { confirmedAtFor } from "../platforms/platforms.js";
import { hex } from "../source/hex.js";
import type { Hex } from "../types.js";
import { heldReads } from "./memory.js";

/** Who a platform first handed a passport to, and when that wallet confirmed it, as creditFor reads them. */
export interface Handover {
  /** The first wallet the creator transferred the passport to, or null when it has never left the creator. */
  firstRecipient: Address | null;
  /** Unix seconds of the earliest consent entry the first recipient wrote, or null when there is none. */
  confirmedAt: bigint | null;
}

/** The index's word on one passport's first handover. Throws whenever the index cannot give it. */
export type HandoverReader = (id: Hex) => Promise<Handover>;

/**
 * How long one passport's answer is held for every caller together. The index allows about a
 * hundred queries a minute for the site, this service and every build, and only a listed platform's
 * passport is ever asked about, so half a minute keeps the cost small while a fresh confirmation
 * still shows within it (M5).
 */
export const HANDOVER_HOLD_MS = 30_000;

/**
 * How many of a passport's consent entries one read takes, oldest first. Real passports carry one
 * to three. A first recipient whose first entry sits beyond this many, in a history longer than it,
 * makes the read fail rather than say they never confirmed.
 */
export const HANDOVER_ENTRIES_MAX = 64;

const HANDOVER_TIMEOUT_MS = 5_000;

const HANDOVER_QUERY = `query MoolamHandover($id: String!, $limit: Int!) {
  Passport(where: { id: { _eq: $id } }, limit: 1) {
    firstTransferTo
    firstTransferAt
    consentCount
  }
  ConsentEntry(where: { passport_id: { _eq: $id } }, order_by: [{ index: asc }], limit: $limit) {
    writer
    at
  }
}`;

const seconds = z
  .union([z.string().regex(/^[0-9]{1,15}$/), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)])
  .transform((value) => BigInt(value));

// Every field is required, null included: an index deployed before the handover fields existed
// answers with a GraphQL error or without the field, and both must fail here, never read as null.
const responseSchema = z.object({
  errors: z.array(z.unknown()).optional(),
  data: z
    .object({
      Passport: z
        .array(
          z.object({
            firstTransferTo: hex(20).nullable(),
            firstTransferAt: seconds.nullable(),
            consentCount: z.number().int().min(0),
          }),
        )
        .max(1),
      ConsentEntry: z.array(z.object({ writer: hex(20), at: seconds })).max(HANDOVER_ENTRIES_MAX),
    })
    .optional(),
});

/**
 * Turns one index answer into a Handover, or throws. Fails closed on a passport the index does not
 * hold, a recipient with no time or a time with no recipient, a confirmation dated before the
 * handover (the chain only lets a holder write, so that row is damaged), and a history longer than
 * the read when the first recipient's entry was not in the part read. The confirmation is
 * confirmedAtFor's, the one predicate the site uses too.
 */
export function handoverFromIndex(body: unknown): Handover {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success || parsed.data.data === undefined || (parsed.data.errors?.length ?? 0) > 0) {
    throw new Error("the index answered in a shape this reader does not know");
  }
  const [passport] = parsed.data.data.Passport;
  if (passport === undefined) {
    throw new Error("the index does not hold this passport yet");
  }
  const { firstTransferTo, firstTransferAt } = passport;
  if (firstTransferTo === null || firstTransferAt === null) {
    if (firstTransferTo !== firstTransferAt) {
      throw new Error("the index holds half a handover");
    }
    return { firstRecipient: null, confirmedAt: null };
  }
  const entries = parsed.data.data.ConsentEntry;
  const confirmedAt = confirmedAtFor(entries, firstTransferTo);
  if (confirmedAt === null && passport.consentCount > entries.length) {
    throw new Error("the passport's consent history is longer than one read");
  }
  if (confirmedAt !== null && confirmedAt < firstTransferAt) {
    throw new Error("the index dates a confirmation before the handover");
  }
  return { firstRecipient: getAddress(firstTransferTo), confirmedAt };
}

/**
 * Reads one passport's first handover from the Envio index at `url`, held for HANDOVER_HOLD_MS per
 * passport. A status other than 200, a timeout and every refusal in handoverFromIndex throw, and
 * nothing that threw is held, so the answer is either the index's word or the caller's "unknown".
 */
export function envioHandoverReader(url: string, fetchImpl: typeof fetch = fetch): HandoverReader {
  const held = heldReads<Handover>({ ttlMs: HANDOVER_HOLD_MS, maxEntries: 2_000 });
  const load = async (id: Hex): Promise<Handover> => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: HANDOVER_QUERY, variables: { id, limit: HANDOVER_ENTRIES_MAX } }),
      signal: AbortSignal.timeout(HANDOVER_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      throw new Error(`the index answered ${response.status}`);
    }
    return handoverFromIndex(await response.json());
  };
  return async (id) => {
    const key = id.toLowerCase() as Hex;
    return await held.read(key, async () => await load(key));
  };
}

/** A reader for a host with no index to ask, which is every host under a test runner. */
export function unavailableHandoverReader(): HandoverReader {
  return async () => {
    throw new Error("this host has no passport index to read a handover from");
  };
}
