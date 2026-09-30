import { termsProblem, type AiUseTerms } from "@moolam/platform";

/** The three choices a visitor has for what AI may do with their picture. */
export const TERMS_PRESETS = ["noAi", "open", "askFirst"] as const;
export type TermsPreset = (typeof TERMS_PRESETS)[number];

const ASK_FIRST = "Ask Dreamloom about AI use of this picture.";

const PRESETS: Record<TermsPreset, AiUseTerms> = {
  noAi: { aiTraining: "notAllowed", aiGenerativeTraining: "notAllowed", aiInference: "notAllowed", dataMining: "notAllowed" },
  open: { aiTraining: "allowed", aiGenerativeTraining: "allowed", aiInference: "allowed", dataMining: "allowed" },
  askFirst: {
    aiTraining: "constrained",
    aiGenerativeTraining: "constrained",
    aiInference: "constrained",
    dataMining: "constrained",
    constraintInfo: ASK_FIRST,
  },
};

export function isTermsPreset(value: unknown): value is TermsPreset {
  return typeof value === "string" && (TERMS_PRESETS as readonly string[]).includes(value);
}

/**
 * The terms a preset stands for, checked by the kit's own predicate (P9) so Dreamloom never sends a
 * statement the verify service or the consent contract would refuse. A copy is returned, so no
 * caller can change a preset for the next one.
 *
 * Throws when a preset fails the predicate, which only an edit to this file could cause.
 */
export function termsFor(preset: TermsPreset): AiUseTerms {
  const terms = { ...PRESETS[preset] };
  const problem = termsProblem(terms);
  if (problem !== null) {
    throw new Error(`the ${preset} terms are refused by the kit: ${problem}`);
  }
  return terms;
}
