import { MoolamPlatformError } from "./errors.js";

/** One answer about one kind of AI use, in the CAWG Training and Data Mining 1.1 words. */
export type AiUse = "allowed" | "notAllowed" | "constrained";

/**
 * A platform's AI-use terms for a picture. A use left out is not stated. constraintInfo says how to
 * ask, and is required exactly when an answer is "constrained".
 */
export interface AiUseTerms {
  aiTraining?: AiUse;
  aiGenerativeTraining?: AiUse;
  aiInference?: AiUse;
  dataMining?: AiUse;
  constraintInfo?: string;
}

/** The four uses the standard names, and the MoolamConsent struct fields they are written to. */
const USES = ["aiTraining", "aiGenerativeTraining", "aiInference", "dataMining"] as const;

/** MoolamConsent's Use enum: 0 Unspecified, 1 Allowed, 2 NotAllowed, 3 Constrained. */
const USE_NUMBER: Record<AiUse, number> = { allowed: 1, notAllowed: 2, constrained: 3 };

const MAX_INFO_BYTES = 256;

/** The contract's own byte rule, as one predicate: every byte from a space to a tilde, nothing else. */
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;

/**
 * Why these terms would be refused by the verify service or by MoolamConsent, or null when both
 * take them unchanged (P9, P24). The rule is the contract's: the condition is present exactly when a
 * use is constrained, is 1 to 256 bytes of printable ASCII, and, as the service insists, has no
 * space at either end, so the text stated is the text written. Unknown fields and an object that
 * states no use are refused rather than dropped.
 */
export function termsProblem(terms: AiUseTerms): string | null {
  if (terms === null || typeof terms !== "object" || Array.isArray(terms)) {
    return "terms must be an object";
  }
  for (const key of Object.keys(terms)) {
    if (!(USES as readonly string[]).includes(key) && key !== "constraintInfo") {
      return `"${key}" is not an AI-use field`;
    }
  }
  let stated = 0;
  let constrained = false;
  for (const use of USES) {
    const answer = terms[use];
    if (answer === undefined) continue;
    if (answer !== "allowed" && answer !== "notAllowed" && answer !== "constrained") {
      return `${use} must be "allowed", "notAllowed" or "constrained"`;
    }
    stated += 1;
    constrained ||= answer === "constrained";
  }
  if (stated === 0) {
    return "terms must state at least one use; leave terms out to state nothing";
  }
  const info = terms.constraintInfo;
  if (!constrained) {
    return info === undefined ? null : "constraintInfo belongs to a constrained use, and no use here is constrained";
  }
  if (typeof info !== "string" || info.trim().length === 0) {
    return "constraintInfo is required when a use is constrained: say how to ask";
  }
  if (info !== info.trim()) {
    return "constraintInfo must not start or end with a space";
  }
  if (!PRINTABLE_ASCII.test(info)) {
    return "constraintInfo must be printable ASCII, with no line breaks";
  }
  if (Buffer.byteLength(info, "utf8") > MAX_INFO_BYTES) {
    return `constraintInfo must be at most ${MAX_INFO_BYTES} bytes`;
  }
  return null;
}

/** Throws MoolamPlatformError "invalid-terms" naming what termsProblem found. */
export function assertTerms(terms: AiUseTerms): void {
  const problem = termsProblem(terms);
  if (problem !== null) {
    throw new MoolamPlatformError("invalid-terms", problem);
  }
}

/** The terms as MoolamConsent's Consent struct and its constraint text, unchanged. */
export function consentCall(terms: AiUseTerms): {
  consent: { aiTraining: number; aiGenerativeTraining: number; aiInference: number; dataMining: number };
  constraintInfo: string;
} {
  const number = (use: AiUse | undefined): number => (use === undefined ? 0 : USE_NUMBER[use]);
  return {
    consent: {
      aiTraining: number(terms.aiTraining),
      aiGenerativeTraining: number(terms.aiGenerativeTraining),
      aiInference: number(terms.aiInference),
      dataMining: number(terms.dataMining),
    },
    constraintInfo: terms.constraintInfo ?? "",
  };
}

/**
 * Whether the statement the service says it wrote into the manifest and metadata is exactly these
 * terms: the same answers for all four uses and the same condition text, byte for byte.
 */
export function sameTerms(terms: AiUseTerms | undefined, answered: AiUseTerms | undefined): boolean {
  if (terms === undefined || answered === undefined) {
    return terms === undefined && answered === undefined;
  }
  return USES.every((use) => terms[use] === answered[use]) && terms.constraintInfo === answered.constraintInfo;
}
