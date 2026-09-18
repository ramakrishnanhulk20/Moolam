import type { Consent, Use } from "@/lib/chain/consent";
import { USE_FIELDS } from "@/lib/chain/consent";
import type { ConsentDraft } from "@/lib/consent/call";

/**
 * The statement a holder is putting together, before it is anybody's
 * transaction.
 *
 * Three plain choices cover what almost everyone wants to say, and the fourth
 * state is what you get by answering the four uses one at a time. The limits
 * here are the contract's own, so a holder never writes something the register
 * would refuse at the last step.
 *
 * The words for the three choices live in the message files: this file holds
 * only what each one means to the contract.
 */

export type { ConsentDraft };

export type Choice = "open" | "closed" | "ask" | "custom";

/** The contract's cap on the conditions text, in bytes. */
export const MAX_INFO_BYTES = 256;

/** The three plain choices, in the order a holder reads them. */
export const CHOICES: Exclude<Choice, "custom">[] = ["open", "closed", "ask"];

const ALL: Record<Exclude<Choice, "custom">, Use> = { open: "allowed", closed: "notAllowed", ask: "constrained" };

/** The four fields one plain choice sets. */
export function consentForChoice(choice: Exclude<Choice, "custom">): Consent {
  const use = ALL[choice];
  return { aiTraining: use, aiGenerativeTraining: use, aiInference: use, dataMining: use };
}

/** Which of the three plain choices a set of four fields is, or "custom" when it is none of them. */
export function choiceOf(consent: Consent): Choice {
  for (const key of CHOICES) {
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

/** The contract counts bytes, not characters, so the counter in front of a holder counts bytes. */
export function infoBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Where the first character the contract would refuse sits, or null when the
 * text is all printable ASCII. A line break and an accented letter both land
 * here, which is why the control says so while the holder types rather than
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

/** Whether this statement is already what the register holds, word for word. */
export function sameAsStanding(draft: ConsentDraft, standing: ConsentDraft | null): boolean {
  if (standing === null) {
    return false;
  }
  return (
    USE_FIELDS.every((field) => draft.consent[field] === standing.consent[field]) &&
    draft.constraintInfo === standing.constraintInfo
  );
}

/** Whether the register would take this statement at all, checked before it costs anybody a send. */
export function draftProblem(draft: ConsentDraft): "conditionsRequired" | "conditionsTooLong" | "notPrintable" | null {
  const wanted = needsConditions(draft.consent);
  if (wanted && draft.constraintInfo.trim().length === 0) {
    return "conditionsRequired";
  }
  if (!wanted) {
    return null;
  }
  if (infoBytes(draft.constraintInfo) > MAX_INFO_BYTES) {
    return "conditionsTooLong";
  }
  return unprintableAt(draft.constraintInfo) === null ? null : "notPrintable";
}
