import { z } from "zod";

/**
 * What a creator says about one kind of AI use, in the standard's own three words.
 *
 * `constrained` means permission is not unconditionally given: a consumer with no way to reach the
 * creator has to read it as `notAllowed`. This service only writes the statement down, it never
 * answers allowed or not allowed on the creator's behalf.
 */
export type Use = "allowed" | "notAllowed" | "constrained";

/** A creator's statement as the request carries it. A field left out is not stated at all. */
export interface TrainingConsent {
  aiTraining?: Use;
  aiGenerativeTraining?: Use;
  aiInference?: Use;
  dataMining?: Use;
  constraintInfo?: string;
}

/** The assertion label from CAWG Training and Data Mining 1.1. Never the retired c2pa. one. */
export const TRAINING_ASSERTION_LABEL = "cawg.training-mining";

/** What the pinned metadata names as the standard the statement is written in. */
export const TRAINING_STANDARD = "cawg.training-mining/1.1";

/**
 * The cap the consent contract enforces on its text, in bytes.
 *
 * It is the same number here on purpose: a statement this service accepts can be written on chain
 * unchanged later, so the creator never sees the two halves disagree about their own words.
 */
export const CONSTRAINT_INFO_MAX_BYTES = 256;

/**
 * The four kinds of use the standard defines, each against the entry key it must be written under.
 *
 * This is the standard's own closed vocabulary, not a list this service maintains: CAWG 1.1 names
 * exactly these four and reserves the `cawg.` prefix for itself, so there is no rule that could
 * derive them and nothing to fall out of date.
 */
const ENTRY_KEYS = {
  aiTraining: "cawg.ai_training",
  aiGenerativeTraining: "cawg.ai_generative_training",
  aiInference: "cawg.ai_inference",
  dataMining: "cawg.data_mining",
} as const;

type UseField = keyof typeof ENTRY_KEYS;

const USE_FIELDS = Object.keys(ENTRY_KEYS) as UseField[];

/**
 * One predicate for the whole string rather than a list of characters to refuse: everything from
 * a space to a tilde is allowed and nothing else is, so a newline, a tab, a control byte, a null
 * and every multi-byte character are all out without anyone having to think of them. It does not
 * judge what the text says: a creator may write any printable sentence, including a URL.
 */
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;

const useSchema = z.enum(["allowed", "notAllowed", "constrained"]);

const constraintInfoSchema = z
  .string()
  .trim()
  .min(1, "constraintInfo must say something")
  .refine(
    (text) => PRINTABLE_ASCII.test(text),
    "constraintInfo must be printable ASCII between 0x20 and 0x7E, with no line breaks",
  )
  .refine(
    (text) => Buffer.byteLength(text, "utf8") <= CONSTRAINT_INFO_MAX_BYTES,
    `constraintInfo must be at most ${CONSTRAINT_INFO_MAX_BYTES} bytes`,
  );

/**
 * The boundary schema for the optional `training` field on /prepare and /generate.
 *
 * Unknown keys are refused rather than dropped, so a misspelled choice is an answer the creator
 * can act on instead of a picture that silently says nothing. A statement with no choice in it
 * parses to undefined, which is how "the creator said nothing" and "the creator sent an empty
 * object" become the same thing everywhere downstream.
 */
export const trainingSchema = z
  .strictObject({
    aiTraining: useSchema.optional(),
    aiGenerativeTraining: useSchema.optional(),
    aiInference: useSchema.optional(),
    dataMining: useSchema.optional(),
    constraintInfo: constraintInfoSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const constrained = USE_FIELDS.some((field) => value[field] === "constrained");
    if (constrained && value.constraintInfo === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["constraintInfo"],
        message: 'constraintInfo is required when a choice is "constrained": say how to ask',
      });
    }
    if (!constrained && value.constraintInfo !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["constraintInfo"],
        message: 'constraintInfo belongs to a "constrained" choice, and no choice here is constrained',
      });
    }
  })
  .transform((value): TrainingConsent | undefined => {
    const stated = USE_FIELDS.filter((field) => value[field] !== undefined);
    if (stated.length === 0) {
      return undefined;
    }
    const consent: TrainingConsent = {};
    for (const field of stated) {
      consent[field] = value[field];
    }
    if (value.constraintInfo !== undefined) {
      consent.constraintInfo = value.constraintInfo;
    }
    return consent;
  });

/** One entry of the assertion: the choice, and the note when the choice is "constrained". */
interface AssertionEntry {
  use: Use;
  constraint_info?: string;
}

/** The body of the cawg.training-mining assertion, in the shape the CAWG 1.1 schema gives. */
export interface TrainingAssertion {
  entries: Record<string, AssertionEntry>;
}

/** The statement as the pinned metadata document carries it, next to the standard it follows. */
export interface TrainingStatement extends TrainingConsent {
  standard: typeof TRAINING_STANDARD;
}

/**
 * Builds the assertion for a statement, or undefined when nothing was stated.
 *
 * Only the choices the creator actually made are written: an entry the standard defines but the
 * creator left out carries no claim at all, which is not the same as allowing it.
 *
 * Throws when the statement would not have passed the boundary schema, so a caller inside this
 * service cannot write a manifest a request could never have asked for.
 */
export function trainingAssertion(consent: TrainingConsent | undefined): TrainingAssertion | undefined {
  const stated = checked(consent);
  if (stated === undefined) {
    return undefined;
  }

  const entries: Record<string, AssertionEntry> = {};
  for (const field of USE_FIELDS) {
    const use = stated[field];
    if (use === undefined) {
      continue;
    }
    entries[ENTRY_KEYS[field]] =
      use === "constrained" ? { use, constraint_info: stated.constraintInfo as string } : { use };
  }
  return { entries };
}

/**
 * The same statement in the pinned metadata document, or undefined when nothing was stated.
 *
 * It keeps the request's own field names rather than the assertion's keys, because this is the
 * document the studio and any wallet read, and it names the standard so a reader knows which
 * vocabulary the three words come from.
 *
 * Throws on the same statements trainingAssertion throws on, and for the same reason.
 */
export function trainingStatement(consent: TrainingConsent | undefined): TrainingStatement | undefined {
  const stated = checked(consent);
  return stated === undefined ? undefined : { ...stated, standard: TRAINING_STANDARD };
}

/**
 * Runs a statement through the boundary schema again on its way out.
 *
 * The manifest and the pinned document are both read by other people's software, so what this
 * service writes is checked exactly as hard as what it accepts, by the same schema, and a
 * statement that fails stops the picture rather than travelling with it.
 */
function checked(consent: TrainingConsent | undefined): TrainingConsent | undefined {
  if (consent === undefined) {
    return undefined;
  }
  const parsed = trainingSchema.safeParse(consent);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`this training statement is not one this service may write: ${detail}`);
  }
  return parsed.data;
}
