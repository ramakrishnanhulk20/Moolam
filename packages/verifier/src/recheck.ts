import { getAddress } from "viem";
import { z } from "zod";
import type { Hex, PassportRecord, PassportRechecks, Recheck } from "./types.js";

/** The newest verdict as a verify answer prints it. */
export interface LatestRecheck {
  matched: boolean;
  distance: number;
  /** Unix seconds. */
  at: number;
  receiver: Hex;
}

/**
 * Two sources, and never a third. "index" is the index's own count of what has re-checked this
 * picture, where zero means nothing has. "unavailable" is this service saying it cannot tell,
 * which must never be read as "nothing has re-checked it".
 */
export type RecheckAnswer =
  | { source: "index"; attestations: number; matched: number; mismatched: number; latest: LatestRecheck }
  | { source: "index"; attestations: 0 }
  | { source: "unavailable" };

const UNAVAILABLE: RecheckAnswer = { source: "unavailable" };

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * Envio serves a GraphQL BigInt as a decimal string and an Int as a JSON number, so a timestamp
 * arrives either way. Fifteen digits keeps a string inside the range a JSON number holds exactly,
 * which is where this value is going.
 */
const unixSeconds = z
  .union([z.string().regex(/^[0-9]{1,15}$/), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)])
  .transform((value) => Number(value));

/**
 * The re-check fields of one `Passport` row, as the index serves them. Extra keys on the row are
 * ignored, so the whole passport row can be handed straight to it.
 */
const rowSchema = z.object({
  attestationCount: count,
  matchedCount: count,
  mismatchedCount: count,
  attestations: z.array(
    z.object({
      receiver: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "receiver must be a 20 byte address"),
      matched: z.boolean(),
      distance: z.number().int().min(0),
      at: unixSeconds,
    }),
  ),
});

/**
 * Reads the re-check fields off one index row.
 *
 * Undefined when the row does not carry them or carries one badly. Both cases end as the same
 * "unavailable" answer on purpose: this service cannot tell a field the index stopped serving from
 * a field it served wrong, and guessing at either would put a made-up second opinion in front of a
 * reader. Nothing here throws, because a passport that cannot be matched at all is a far worse
 * answer than a passport with no second opinion attached.
 */
export function rechecksFrom(row: unknown): PassportRechecks | undefined {
  const parsed = rowSchema.safeParse(row);
  if (!parsed.success) {
    return undefined;
  }

  // The query asks for one attestation, newest first, so the first row is the newest verdict.
  const newest = parsed.data.attestations[0];
  return {
    attestations: parsed.data.attestationCount,
    matched: parsed.data.matchedCount,
    mismatched: parsed.data.mismatchedCount,
    latest:
      newest === undefined
        ? null
        : {
            receiver: newest.receiver.toLowerCase() as Hex,
            matched: newest.matched,
            distance: newest.distance,
            at: newest.at,
          },
  };
}

/**
 * Turns one passport record into the re-check fact a verify answer publishes.
 *
 * The record is one the service already holds in memory from its last index refresh, so this costs
 * no network call and no chain read: the fact is exactly as fresh as the match that produced it.
 *
 * A count and a verdict that disagree are not reconciled. One of the three numbers is wrong and
 * there is no way to tell which, so the whole fact goes out unavailable rather than half true.
 * Four shapes disagree: a newest verdict under a count of zero, a count above zero with no verdict
 * to show, matched and mismatched that do not add up to the total, and a newest verdict whose own
 * kind was never counted. The last two are the ones that would otherwise publish a confident
 * number: "3 re-checks, 2 matched" under a total the index never agreed with is worse than silence.
 */
export function recheckFor(record: PassportRecord | undefined): RecheckAnswer {
  const rechecks = record?.rechecks;
  if (rechecks === undefined) {
    return UNAVAILABLE;
  }
  if (rechecks.attestations === 0) {
    return rechecks.latest === null ? { source: "index", attestations: 0 } : UNAVAILABLE;
  }
  if (rechecks.latest === null) {
    return UNAVAILABLE;
  }
  if (rechecks.matched + rechecks.mismatched !== rechecks.attestations) {
    return UNAVAILABLE;
  }
  if (rechecks.latest.matched ? rechecks.matched === 0 : rechecks.mismatched === 0) {
    return UNAVAILABLE;
  }

  return {
    source: "index",
    attestations: rechecks.attestations,
    matched: rechecks.matched,
    mismatched: rechecks.mismatched,
    latest: latestOut(rechecks.latest),
  };
}

/**
 * The receiver goes out checksummed, the way the consent statement's writer already does in this
 * same answer. The record holds it lower-cased because that is how ids are compared inside this
 * service; nothing outside it should have to know that.
 */
function latestOut(latest: Recheck): LatestRecheck {
  return {
    matched: latest.matched,
    distance: latest.distance,
    at: latest.at,
    receiver: getAddress(latest.receiver) as Hex,
  };
}
