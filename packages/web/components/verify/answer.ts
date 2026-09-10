import type { Hex } from "viem";
import { VerifierError, type Match, type VerifyResponse } from "@/lib/verifier/client";
import { checkImage, MAX_UPLOAD_BYTES } from "@/lib/upload/checkImage";

/** The limit lives in lib/upload with the check; the passport page reads it from here. */
export { MAX_UPLOAD_BYTES };

/**
 * What the verify service said, in the shape the screen draws.
 *
 * The service answers with two nullable fields and a list. A screen needs one
 * of three things instead: identical bytes, a perceptual match, or nothing at
 * all. Deciding that here keeps the branch out of the markup and lets a test
 * pin it down without a browser.
 */
export type Answer =
  | {
      kind: "exact" | "close";
      id: Hex;
      confidence: number;
      phashDistance: number;
      blockhashDistance: number;
      variant: Match["variant"];
      others: number;
      manifest: boolean;
      queried: VerifyResponse["result"]["queried"];
    }
  | { kind: "miss"; manifest: boolean; queried: VerifyResponse["result"]["queried"] };

/** An exact hit reports zero distance on both hashes, which is what the service sends back. */
const IDENTICAL = { phashDistance: 0, blockhashDistance: 0, variant: "identity" as const };

export function readAnswer(response: VerifyResponse): Answer {
  const { exact, best, matches, confidence, queried } = response.result;
  const manifest = response.manifest.present;
  const id = exact ?? best?.id ?? null;

  if (id === null) {
    return { kind: "miss", manifest, queried };
  }

  const measured = exact !== null ? { ...IDENTICAL, ...(best ?? IDENTICAL) } : (best as Match);

  return {
    kind: exact === null ? "close" : "exact",
    id,
    confidence,
    phashDistance: measured.phashDistance,
    blockhashDistance: measured.blockhashDistance,
    variant: measured.variant,
    others: Math.max(matches.length - 1, 0),
    manifest,
    queried,
  };
}

/** Confidence as a whole percent, which is the only place the number is rounded. */
export function percent(confidence: number): number {
  return Math.round(confidence * 100);
}

/**
 * Which sentence a failed check gets, and the service's own words under it.
 *
 * Every code the client can raise is named here rather than falling through to
 * one catch-all, so a reader is told the difference between a file this service
 * refused and a service that never answered.
 */
const PROBLEMS: Record<string, string> = {
  offline: "offline",
  "too-large": "problem.tooLarge",
  "not-an-image": "problem.notAnImage",
  "rate-limited": "problem.rateLimited",
  "bad-request": "problem.badRequest",
  "bad-response": "problem.badResponse",
  "pin-failed": "problem.serviceFailed",
  unauthorized: "problem.refused",
};

export interface Problem {
  /** A key inside the "verify" namespace in both message files. */
  key: string;
  /** The service's or the browser's own words, printed under the sentence. */
  reason?: string;
}

export function verifyProblem(error: unknown): Problem {
  if (error instanceof VerifierError) {
    const key = PROBLEMS[error.code] ?? "problem.badResponse";
    // The offline line already names the service and the port, so repeating the
    // fetch failure under it would say the same thing twice.
    return key === "offline" ? { key } : { key, reason: error.message };
  }
  return { key: "problem.badResponse", reason: error instanceof Error ? error.message : String(error) };
}

/** Whether this file is over the limit, checked before anything is uploaded. */
export function tooLarge(file: File): boolean {
  return file.size > MAX_UPLOAD_BYTES;
}

/**
 * What is wrong with a file the reader just chose, or null when it is worth
 * uploading. The size and type test is the shared one in lib/upload, so this
 * page refuses exactly what the service would have refused, and says it without
 * sending the file anywhere.
 */
export function chosenProblem(file: File): Problem | null {
  const refusal = checkImage(file);
  return refusal === null ? null : { key: PROBLEMS[refusal.code] };
}
