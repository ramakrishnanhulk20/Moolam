import { dihedralFingerprints } from "./dihedral.js";
import {
  BLOCKHASH_MATCH_THRESHOLD,
  PHASH_MATCH_THRESHOLD,
  fingerprint,
  type Fingerprint,
} from "./fingerprint.js";
import { HammingIndex, compareMatches } from "./index.js";
import type { DihedralName, Hex, Match, PassportRecord } from "./types.js";

export interface MatchResult {
  exact: Hex | null;
  best: Match | null;
  matches: Match[];
  confidence: number;
  queried: Fingerprint;
}

/** The thresholds a query is run at, taken from the spike's measurements. */
export const MATCH_LIMITS = {
  phashMax: PHASH_MATCH_THRESHOLD,
  blockhashMax: BLOCKHASH_MATCH_THRESHOLD,
} as const;

const MAX_MATCHES = 20;

/**
 * Matches an image against the registry.
 *
 * The exact-bytes sha256 of the image is tried first: a hit there means the
 * file is byte for byte a registered passport and nothing else needs deciding,
 * so the eight rotated copies are never built and the work stops at one decode.
 * Otherwise all eight rotated and mirrored copies of the query are fingerprinted
 * and each is run through the index, so a quarter-turned or mirrored re-upload
 * is caught even though its raw pHash is 30 of 64 bits away from the original.
 *
 * The returned `queried` fingerprint is always the identity one, which is what
 * a caller would register or display.
 *
 * Throws when the buffer is empty or is not an image sharp can decode.
 */
export async function matchImage(
  bytes: Buffer,
  index: HammingIndex,
  exactLookup: (sha256: Hex) => PassportRecord | undefined,
): Promise<MatchResult> {
  // The identity variant is a PNG re-encode, so its sha256 is the hash of that
  // PNG and not of the file the caller sent. The exact lookup has to use the
  // fingerprint of the original bytes, which is also what a caller wants back.
  const queried = await fingerprint(bytes);

  const exactRecord = exactLookup(queried.sha256);
  if (exactRecord !== undefined) {
    const exactMatch: Match = {
      id: exactRecord.id,
      phashDistance: 0,
      blockhashDistance: 0,
      variant: "identity",
      score: 1,
    };
    return { exact: exactRecord.id, best: exactMatch, matches: [exactMatch], confidence: 1, queried };
  }

  const rotated = await dihedralFingerprints(bytes);
  const variants: Record<DihedralName, Fingerprint> = { ...rotated, identity: queried };

  const bestByRecord = new Map<Hex, Match>();
  for (const name of Object.keys(variants) as DihedralName[]) {
    const print = variants[name] as Fingerprint;
    for (const hit of index.query(print.phash, print.blockhash, MATCH_LIMITS, MAX_MATCHES)) {
      const labelled: Match = { ...hit, variant: name };
      const current = bestByRecord.get(labelled.id);
      if (current === undefined || compareMatches(labelled, current) < 0) {
        bestByRecord.set(labelled.id, labelled);
      }
    }
  }

  const matches = [...bestByRecord.values()].sort(compareMatches).slice(0, MAX_MATCHES);
  const best = matches[0] ?? null;

  return {
    exact: null,
    best,
    matches,
    confidence: best === null ? 0 : confidenceOf(best),
    queried,
  };
}

/**
 * Turns the best match's two bit distances into a number a person can read.
 *
 * An exact sha256 hit is 1. Everything else is capped just below 1 so a
 * perceptual match can never claim to be as certain as identical bytes:
 *
 *   confidence = 0.99 * (0.6 * (1 - dp / (Tp + 1)) + 0.4 * (1 - db / (Tb + 1)))
 *
 * where dp and db are the pHash and blockhash distances and Tp and Tb are the
 * thresholds (10 of 64 and 40 of 256). Each distance is divided by its own
 * threshold so the 64-bit and 256-bit hashes land on the same scale, and the
 * pHash gets the larger weight because the spike measured it as the more stable
 * of the two under honest re-encoding. A match sitting exactly on both
 * thresholds still scores about 0.09, and anything past either threshold never
 * reaches this function at all, which is the 0 case.
 */
function confidenceOf(best: Match): number {
  const phashPart = 1 - best.phashDistance / (MATCH_LIMITS.phashMax + 1);
  const blockhashPart = 1 - best.blockhashDistance / (MATCH_LIMITS.blockhashMax + 1);
  return 0.99 * (0.6 * phashPart + 0.4 * blockhashPart);
}
