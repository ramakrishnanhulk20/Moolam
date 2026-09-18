import { USE_FIELDS, NOTHING_STATED, type Use } from "@/lib/chain/consent";
import type { ConsentDraft } from "@/lib/consent/call";
import type { StatedUse, TrainingRequest, TrainingStatement } from "@/lib/verifier/client";

/**
 * The creator's statement on its way through the studio: from the plates they
 * pressed, into the file the verify service signs, and back out of that answer
 * into the words the consent register is given.
 *
 * The round trip matters. The service trims the conditions text and writes only
 * the choices it accepts, so what it echoes is what is really inside the
 * picture. Writing the plates straight to the chain instead would let the file
 * and the register drift apart by a space.
 */

/** A statement with nothing in it: the opening state of both panels, and a valid answer to send. */
export const NOTHING_TO_STATE: ConsentDraft = { consent: NOTHING_STATED, constraintInfo: "" };

/** True when the creator has said something about at least one use. */
export function saysSomething(draft: ConsentDraft): boolean {
  return USE_FIELDS.some((field) => draft.consent[field] !== "unspecified");
}

/**
 * The statement as the verify service takes it, or undefined when nothing was
 * stated.
 *
 * A use left on "not stated" is left out of the object rather than sent as a
 * word, because the service has no value for it and silence is the thing being
 * said. The conditions text goes only with a conditional choice, which is the
 * rule the route and the contract both enforce.
 */
export function trainingFrom(draft: ConsentDraft): TrainingRequest | undefined {
  if (!saysSomething(draft)) {
    return undefined;
  }

  const request: TrainingRequest = {};
  for (const field of USE_FIELDS) {
    const use = draft.consent[field];
    if (use !== "unspecified") {
      request[field] = use as StatedUse;
    }
  }

  const conditions = draft.constraintInfo.trim();
  if (USE_FIELDS.some((field) => draft.consent[field] === "constrained") && conditions.length > 0) {
    request.constraintInfo = conditions;
  }
  return request;
}

/**
 * The service's own answer turned into the statement the register is given, or
 * null when the answer carries none.
 *
 * A use the service did not write comes back absent, and absent is exactly what
 * the contract's fourth value means, so the two vocabularies meet without
 * anybody inventing a word.
 */
export function statedFrom(statement: TrainingStatement | undefined): ConsentDraft | null {
  if (statement === undefined) {
    return null;
  }

  const consent = { ...NOTHING_STATED };
  let stated = false;
  for (const field of USE_FIELDS) {
    const use = statement[field];
    if (use !== undefined) {
      consent[field] = use as Use;
      stated = true;
    }
  }

  return stated ? { consent, constraintInfo: statement.constraintInfo ?? "" } : null;
}
