import type { Hex } from "viem";
import type { Statement } from "@/lib/chain/consent";
import { bitsApart } from "@/lib/chain/fingerprint";

/**
 * The shapes the home page's first screen draws, and the few rules it reads them by.
 *
 * Nothing here talks to a network, so the tests can hold every rule without a
 * chain, an index or the verify service. The reads themselves are in read.ts.
 */

/** The film's own passport. Its page, its re-check and its statement are what the first screen quotes. */
export const FINDING_ID = "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638" as Hex;

/**
 * How the server mangles the registered thumbnail before it asks the verify
 * service about it. Measured on 25 September against the live service with
 * this passport's thumbnail: this recipe came back matched at 5 of 64 bits. A
 * 5 percent trim with the same colour change came back unmatched, which is why
 * the trim is small and why the words on the screen never promise a crop.
 */
export const COPY_RECIPE = {
  /** Taken off the top and the right, as a share of each side. */
  trim: 0.02,
  brightness: 1.05,
  saturation: 1.6,
  /** Degrees round the colour wheel. */
  hue: 28,
  width: 360,
  quality: 16,
} as const;

/** The passport the first screen is about, as the registry, the index and the register answered. */
export interface Finding {
  id: Hex;
  title: string | null;
  /** The registered picture at full size, as a gateway address, for the poster. */
  picture: string | null;
  /** The pinned 512 pixel copy, which is what the server mangles. */
  thumbnail: string | null;
  /** Whole seconds. */
  registeredAt: number;
  /** The fingerprint the registry stored, as a decimal string so it survives the cache. */
  phash: string;
  /** The newest re-check written through a Chainlink receiver, or null when there is none. */
  recheck: FindingRecheck | null;
  /** The statement on AI use in force, or null when the holder has said nothing. */
  statement: { summary: Statement; at: number } | null;
  /** The register's own words when it could not be read, which is not the same as silence. */
  statementError: string | null;
}

export interface FindingRecheck {
  matched: boolean;
  distance: number;
  /** Whole seconds, from the attestation itself. */
  at: number;
}

/**
 * What can still be shown about the passport when its registry record could
 * not be read: the picture and its name, through the index's copy of the
 * document address and the gateway, and the holder's statement, which lives in
 * a separate register. Any of the three can be missing on its own.
 */
export interface LooseFinding {
  id: Hex;
  title: string | null;
  thumbnail: string | null;
  statement: Finding["statement"];
}

/** The mangled copy and what the verify service said about it. */
export interface CopyReading {
  /** The copy's own bytes as a data address, so the picture on screen is the file that was measured. */
  image: string;
  width: number;
  height: number;
  bytes: number;
  /** The copy's fingerprint as the verify service computed it, decimal. */
  phash: string;
  /** True only when the service named this very passport as the match. */
  found: boolean;
  /** Bits apart, counted on this page from the two fingerprints. */
  distance: number;
  confidence: number;
  /** Milliseconds since the epoch: when the service answered. */
  measuredAt: number;
}

/** Either a reading, or the one line saying why there is none this minute. */
export type Read<T> = { read: T } | { failed: string };

export function isRead<T>(value: Read<T>): value is { read: T } {
  return "read" in value;
}

/** One attestation as the registry returns it, with the fields the first screen reads. */
export interface AttestationRow {
  receiver: Hex;
  matched: boolean;
  distance: number;
  at: bigint;
}

/**
 * The newest re-check a Chainlink workflow wrote.
 *
 * Any receiver the policy allows can write an attestation, so the list is not
 * all Chainlink. Only a row written through one of the two receivers the CRE
 * workflows report into may carry that name on the screen.
 */
export function chainlinkRecheck(rows: readonly AttestationRow[], receivers: readonly Hex[]): FindingRecheck | null {
  const allowed = new Set(receivers.map((receiver) => receiver.toLowerCase()));
  let newest: AttestationRow | null = null;
  for (const row of rows) {
    if (!allowed.has(row.receiver.toLowerCase())) {
      continue;
    }
    if (newest === null || row.at >= newest.at) {
      newest = row;
    }
  }
  return newest === null ? null : { matched: newest.matched, distance: newest.distance, at: Number(newest.at) };
}

/** What the verify service said about the copy, with the fields the first screen reads. */
export interface CopyAnswer {
  exact: string | null;
  best: { id: string; phashDistance: number } | null;
  confidence: number;
  queried: { phash: string };
}

/**
 * The verdict on the copy, from the service's answer and the registry's own
 * fingerprint.
 *
 * "Found" means the service named this passport and nothing else. The distance
 * is counted here from the two fingerprints rather than copied from the
 * service, so the grid and the sentence under it can never disagree.
 */
export function copyVerdict(
  answer: CopyAnswer,
  passportId: string,
  registeredPhash: string,
): { phash: string; found: boolean; distance: number; confidence: number } {
  const named = answer.exact ?? answer.best?.id ?? null;
  const found = named !== null && named.toLowerCase() === passportId.toLowerCase();
  return {
    phash: answer.queried.phash,
    found,
    distance: bitsApart(BigInt(registeredPhash), BigInt(answer.queried.phash)),
    confidence: found ? answer.confidence : 0,
  };
}
