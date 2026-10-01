import { z } from "zod";
import { CONSTRAINT_INFO_MAX_BYTES } from "../consent.js";

/** The consent register's own four words, in the order of its Use enum. */
export const USE_WORDS = ["unspecified", "allowed", "notAllowed", "constrained"] as const;

export type UseWord = (typeof USE_WORDS)[number];

/** What a person chose for AI use when they accepted, exactly as setConsentBatch will carry it. */
export interface ClaimTerms {
  aiTraining: UseWord;
  aiGenerativeTraining: UseWord;
  aiInference: UseWord;
  dataMining: UseWord;
  constraintInfo: string;
}

const useWord = z.enum(USE_WORDS);

/**
 * MoolamConsent._checkConstraintInfo, line for line (P37): with no use constrained the text must be
 * empty; with one constrained it must be 1 to 256 bytes, every byte from 0x20 to 0x7E. A JavaScript
 * string whose every code unit is in that range is that many bytes in UTF-8, so the code unit check
 * is the byte check. Nothing is trimmed, because the contract trims nothing: a value is accepted
 * exactly when the contract would accept it, and stored as it came.
 */
export function termsProblem(terms: ClaimTerms): string | null {
  const constrained = [terms.aiTraining, terms.aiGenerativeTraining, terms.aiInference, terms.dataMining].includes("constrained");
  const text = terms.constraintInfo;
  if (!constrained) {
    return text.length === 0 ? null : "constraintInfo belongs to a constrained use";
  }
  if (text.length === 0) return "constraintInfo is required when a use is constrained";
  if (text.length > CONSTRAINT_INFO_MAX_BYTES) return "constraintInfo is longer than the contract takes";
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x20 || unit > 0x7e) return "constraintInfo is not printable ASCII";
  }
  return null;
}

/** The five fields, every one required, nothing else, and the contract's rule over them. */
export const termsSchema = z
  .strictObject({
    aiTraining: useWord,
    aiGenerativeTraining: useWord,
    aiInference: useWord,
    dataMining: useWord,
    constraintInfo: z.string().max(4 * CONSTRAINT_INFO_MAX_BYTES),
  })
  .refine((terms) => termsProblem(terms) === null, "terms the consent contract would refuse");
