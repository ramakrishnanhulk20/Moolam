import { dihedralFingerprints } from "./dihedral.js";
import {
  BLOCKHASH_MATCH_THRESHOLD,
  PHASH_MATCH_THRESHOLD,
  fingerprint,
  hamming64,
  hammingHex,
  type Fingerprint,
} from "./fingerprint.js";
import {
  HammingIndex,
  compareMatches,
  compareRegistrations,
  score,
  type IndexedRecord,
  type RankedMatch,
} from "./index.js";
import type { DihedralName, Hex, Match, PassportRecord } from "./types.js";

/** A match as the answer names it. */
export interface AnswerMatch extends Match {
  /**
   * True on the passport registered first among everything inside the match thresholds. Only set
   * when the answer names more than one passport, so a one-passport answer keeps its old shape.
   */
  firstRegistered?: true;
}

export interface MatchResult {
  exact: Hex | null;
  best: AnswerMatch | null;
  matches: AnswerMatch[];
  confidence: number;
  queried: Fingerprint;
  /** How many passports registered after `best` carry exactly its fingerprint. Absent when nothing matched. */
  laterSameFingerprint?: number;
  /** The first registration inside the thresholds, present only when it is not `best`. */
  firstRegisteredId?: Hex;
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
 * That hit keeps confidence 1 and reports the two distances and the score
 * measured between this file's fingerprint and the one the passport stored.
 * Otherwise all eight rotated and mirrored copies of the query are fingerprinted
 * and each is run through the index, so a quarter-turned or mirrored re-upload
 * is caught even though its raw pHash is 30 of 64 bits away from the original.
 *
 * The returned `queried` fingerprint is always the identity one, which is what
 * a caller would register or display.
 *
 * The closest match leads, but the passport registered first inside the thresholds is always in
 * the answer, whatever the cap, because near-copies a bit or two closer to the query are cheap to
 * register and must not be able to push the original out. On the exact path that search uses the
 * identity fingerprint only, so an exact hit still costs one decode; an earlier registration that
 * only matches a rotated or mirrored copy is not surfaced there.
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
    // The byte match is what makes this exact and worth confidence 1. The distances are still
    // measured against the fingerprint the passport stored, because the registry cannot check that
    // a fingerprint belongs to its bytes, and a passport carrying another picture's fingerprint must
    // not be reported as 0 bits from it (review pass 7, V63).
    const phashDistance = hamming64(queried.phash, exactRecord.phash);
    const blockhashDistance = hammingHex(queried.blockhash, exactRecord.blockhash);
    const exactMatch: Match = {
      id: exactRecord.id,
      phashDistance,
      blockhashDistance,
      variant: "identity",
      // Past either threshold the formula goes below zero; 0 already says nothing alike.
      score: Math.max(0, score(phashDistance, blockhashDistance, MATCH_LIMITS)),
    };
    const first = index.earliest(queried.phash, queried.blockhash, MATCH_LIMITS);
    // Registered strictly before the exact passport, so a stored fingerprint that drifted from these
    // bytes can never surface a later registration as the first.
    const earlier = first !== null && compareRegistrations(first, exactRecord as IndexedRecord) < 0 ? first : null;
    return {
      exact: exactRecord.id,
      best: exactMatch,
      matches: earlier === null ? [exactMatch] : [exactMatch, { ...toMatch(earlier), firstRegistered: true }],
      confidence: 1,
      queried,
      laterSameFingerprint: index.laterSameFingerprint(exactRecord.id),
      ...(earlier === null ? {} : { firstRegisteredId: earlier.id }),
    };
  }

  const rotated = await dihedralFingerprints(bytes);
  const variants: Record<DihedralName, Fingerprint> = { ...rotated, identity: queried };

  // The index has already folded copies of one fingerprint into their first registration, so every
  // cap below counts distinct fingerprints and a pile of copies cannot crowd the first one out.
  const bestByRecord = new Map<Hex, RankedMatch>();
  const keep = (hit: RankedMatch): void => {
    const current = bestByRecord.get(hit.id);
    if (current === undefined || compareMatches(hit, current) < 0) {
      bestByRecord.set(hit.id, hit);
    }
  };
  let first: RankedMatch | null = null;
  for (const name of Object.keys(variants) as DihedralName[]) {
    const print = variants[name] as Fingerprint;
    for (const hit of index.query(print.phash, print.blockhash, MATCH_LIMITS, MAX_MATCHES)) {
      keep({ ...hit, variant: name });
    }
    // Distinct near-copies each hold their own row, so enough of them could fill the cap above.
    const earliest = index.earliest(print.phash, print.blockhash, MATCH_LIMITS);
    if (earliest !== null) {
      const labelled: RankedMatch = { ...earliest, variant: name };
      keep(labelled);
      if (first === null || compareRegistrations(labelled, first) < 0) {
        first = labelled;
      }
    }
  }

  const ranked = [...bestByRecord.values()].sort(compareMatches);
  const kept = ranked.slice(0, MAX_MATCHES);
  const firstId = first?.id;
  if (firstId !== undefined && !kept.some((match) => match.id === firstId)) {
    kept[kept.length - 1] = bestByRecord.get(firstId) as RankedMatch;
  }
  const matches: AnswerMatch[] = kept.map((match) =>
    kept.length > 1 && match.id === firstId ? { ...toMatch(match), firstRegistered: true } : toMatch(match),
  );
  const best = matches[0] ?? null;

  return {
    exact: null,
    best,
    matches,
    confidence: best === null ? 0 : confidenceOf(best),
    queried,
    ...(best === null ? {} : { laterSameFingerprint: index.laterSameFingerprint(best.id) }),
    ...(best !== null && firstId !== undefined && firstId !== best.id ? { firstRegisteredId: firstId } : {}),
  };
}

/** Drops the registration order, which only settled ties, so the answer keeps its published shape. */
function toMatch(ranked: RankedMatch): Match {
  return {
    id: ranked.id,
    phashDistance: ranked.phashDistance,
    blockhashDistance: ranked.blockhashDistance,
    variant: ranked.variant,
    score: ranked.score,
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
