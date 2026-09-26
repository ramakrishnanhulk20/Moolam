import type { Hex } from "viem";
import {
  VerifierError,
  type Match,
  type MatchConsent,
  type MatchDispute,
  type MatchRecheck,
  type VerifyResponse,
} from "@/lib/verifier/client";
import { checkImage, MAX_UPLOAD_BYTES, type RefusalCode } from "@/lib/upload/checkImage";

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
      /**
       * Set only when the C2PA library found fault with the manifest: "invalid" when it fails
       * validation, "unreadable" when it could not be parsed. Either way the card must not call it
       * a signed record still inside the file.
       */
      manifestCheck?: "invalid" | "unreadable";
      /** An earlier registration inside the thresholds, set only when it is not the passport shown. */
      firstRegisteredId?: Hex;
      /** How many later registrations carry exactly this passport's fingerprint, set only when above zero. */
      laterSameFingerprint?: number;
      /** What the holder said about AI use. Absent from an older service, which draws no stamp. */
      consent?: MatchConsent;
      /** Whether a challenge stands against the record. Absent from an older service, which draws no line. */
      dispute?: MatchDispute;
      /** What re-checked the picture since. Absent from an older service, which draws no line. */
      recheck?: MatchRecheck;
      queried: VerifyResponse["result"]["queried"];
    }
  | { kind: "miss"; manifest: boolean; queried: VerifyResponse["result"]["queried"] };

/** An exact hit reports zero distance on both hashes, which is what the service sends back. */
const IDENTICAL = { phashDistance: 0, blockhashDistance: 0, variant: "identity" as const };

export function readAnswer(response: VerifyResponse): Answer {
  const { exact, best, matches, confidence, queried, firstRegisteredId, laterSameFingerprint } = response.result;
  const manifest = response.manifest.present;
  const { validation } = response.manifest;
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
    ...(validation === "invalid" || validation === "unreadable" ? { manifestCheck: validation } : {}),
    ...(firstRegisteredId !== undefined && firstRegisteredId.toLowerCase() !== id.toLowerCase() ? { firstRegisteredId } : {}),
    ...(laterSameFingerprint !== undefined && laterSameFingerprint > 0 ? { laterSameFingerprint } : {}),
    // The service hangs the statement on the best match and on the same
    // passport inside the list, so an exact hit that came back without a best
    // block still finds its own holder's word rather than dropping it.
    consent: best?.consent ?? matches.find((match) => match.id === id)?.consent,
    // The challenge and the second opinion travel on the same match rows, so
    // they are found the same way and never borrowed from another passport in
    // the list. The statement is only worth as much as the record under it, so
    // the two are read together and shown together.
    dispute: best?.dispute ?? matches.find((match) => match.id === id)?.dispute,
    recheck: best?.recheck ?? matches.find((match) => match.id === id)?.recheck,
    queried,
  };
}

/**
 * Which agent the answer card may offer a link to, or null for no chip at all.
 *
 * Agent id 0 is not an agent. It is what a passport carries when nobody signed
 * it, and the ERC-8004 identity registry is shared, so token 0 there belongs to
 * another team's project. A chip for it would take a reader one click off the
 * demo path into a stranger's record drawn inside Moolam's own frame.
 */
export function agentChipId(passport: { generatorAgentId: string } | null): string | null {
  if (passport === null) {
    return null;
  }
  const id = passport.generatorAgentId.trim();
  return id === "" || /^0+$/.test(id) ? null : id;
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

/**
 * The sentences for the refusals this page catches itself.
 *
 * The empty file is the one the service cannot say better: it answers 400 in
 * English after the whole upload, and only this table is in the reader's
 * language. Naming every code the shared check can raise means the compiler
 * asks for a sentence when a new one appears.
 */
const CHOSEN: Record<RefusalCode, string> = {
  "too-large": "problem.tooLarge",
  "not-an-image": "problem.notAnImage",
  empty: "problem.empty",
};

/**
 * What is wrong with a file the reader just chose, or null when it is worth
 * uploading. The size and type test is the shared one in lib/upload, so this
 * page refuses exactly what the service would have refused, and says it without
 * sending the file anywhere.
 */
export function chosenProblem(file: File): Problem | null {
  const refusal = checkImage(file);
  return refusal === null ? null : { key: CHOSEN[refusal.code] };
}
