import type { Consent, Use } from "@/lib/chain/consent";
import { USE_FIELDS, asUseNumber } from "@/lib/chain/consent";

/**
 * The statement a creator is putting together, before it is anybody's
 * transaction.
 *
 * Three plain choices cover what almost everyone wants to say, and the fourth
 * state is what you get by answering the four uses one at a time. The limits
 * here are the contract's own, so a creator never writes something the register
 * would refuse at the last step.
 */

export type Choice = "open" | "closed" | "ask" | "custom";

export interface ConsentDraft {
  consent: Consent;
  constraintInfo: string;
}

/** The contract's cap on the conditions text, in bytes. */
export const MAX_INFO_BYTES = 256;

/** The three plain choices, in the order a creator reads them. */
export const CHOICES: { key: Exclude<Choice, "custom">; title: string; line: string }[] = [
  { key: "open", title: "Open to AI use", line: "Anyone may train on this picture, generate from it and mine it." },
  { key: "closed", title: "Not for AI training", line: "No AI use at all. The one most creators pick, and the one the web has no way to say today." },
  { key: "ask", title: "Ask me first", line: "Allowed on your conditions, written below. Anyone who cannot reach you has to read it as no." },
];

const ALL: Record<Exclude<Choice, "custom">, Use> = { open: "allowed", closed: "notAllowed", ask: "constrained" };

/** The four fields one plain choice sets. */
export function consentForChoice(choice: Exclude<Choice, "custom">): Consent {
  const use = ALL[choice];
  return { aiTraining: use, aiGenerativeTraining: use, aiInference: use, dataMining: use };
}

/** Which of the three plain choices a set of four fields is, or "custom" when it is none of them. */
export function choiceOf(consent: Consent): Choice {
  for (const key of ["open", "closed", "ask"] as const) {
    if (USE_FIELDS.every((field) => consent[field] === ALL[key])) {
      return key;
    }
  }
  return "custom";
}

/** True when the conditions text is required, which is what the contract checks too. */
export function needsConditions(consent: Consent): boolean {
  return USE_FIELDS.some((field) => consent[field] === "constrained");
}

/** The contract counts bytes, not characters, so the counter in front of a creator counts bytes. */
export function infoBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Where the first character the contract would refuse sits, or null when the
 * text is all printable ASCII. A line break and an accented letter both land
 * here, which is why the control says so while the creator types rather than
 * after they have paid for a failed transaction.
 */
export function unprintableAt(text: string): number | null {
  for (const [at, character] of [...text].entries()) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) {
      return at;
    }
  }
  return null;
}

/**
 * The exact call this statement would make, written out.
 *
 * The four numbers are the contract's enum, in the order the struct holds them,
 * so what a creator sees here is what an explorer will show afterwards.
 */
export function callText(passportId: string, draft: ConsentDraft): string {
  const values = USE_FIELDS.map((field) => asUseNumber(draft.consent[field])).join(", ");
  return `setConsent(\n  ${passportId},\n  (${values}),\n  ${JSON.stringify(draft.constraintInfo)}\n)`;
}
