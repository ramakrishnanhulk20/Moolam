import { z } from "zod";
import { NOTHING_STATED, USE_FIELDS, type Consent, type ConsentEntry } from "@/lib/chain/consent";

/**
 * The AI-use terms written into a picture's own file at generation, read from
 * the pinned metadata document that carries the same statement as the signed
 * C2PA manifest (packages/verifier/src/metadata.ts writes both from one value).
 *
 * The chain's statement is the one in force in every reader (P24). These are
 * shown beside it only so a disagreement between the two is seen, never to
 * settle it.
 */
export interface FileTerms {
  consent: Consent;
  /** Empty when no use is constrained. */
  constraintInfo: string;
}

const statedUse = z.enum(["allowed", "notAllowed", "constrained"]);

const trainingSchema = z.object({
  aiTraining: statedUse.optional(),
  aiGenerativeTraining: statedUse.optional(),
  aiInference: statedUse.optional(),
  dataMining: statedUse.optional(),
  constraintInfo: z.string().optional(),
});

/**
 * The file's terms, or null when the document states none. A use written in a
 * word outside the standard's three makes the whole statement unread rather
 * than half read, because a half read statement could show a difference that
 * is not there.
 */
export function fileTermsOf(training: unknown): FileTerms | null {
  const parsed = trainingSchema.safeParse(training);
  if (!parsed.success) {
    return null;
  }
  const consent: Consent = { ...NOTHING_STATED };
  let stated = false;
  for (const field of USE_FIELDS) {
    const use = parsed.data[field];
    if (use !== undefined) {
      consent[field] = use;
      stated = true;
    }
  }
  return stated ? { consent, constraintInfo: parsed.data.constraintInfo ?? "" } : null;
}

/** True when the file says something the chain's statement in force does not, use by use and word for word. */
export function termsDiffer(file: FileTerms, chain: Pick<ConsentEntry, "consent" | "constraintInfo"> | null): boolean {
  const onChain = chain?.consent ?? NOTHING_STATED;
  const chainInfo = chain?.constraintInfo ?? "";
  return USE_FIELDS.some((field) => file.consent[field] !== onChain[field]) || file.constraintInfo !== chainInfo;
}
