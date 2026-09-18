import type { Hex } from "viem";

/**
 * The words a plan may use for one kind of AI use, in the order of the contract's Use enum, so the
 * position in this list is the number stored on chain: unspecified 0, allowed 1, notAllowed 2,
 * constrained 3.
 */
export const USE_WORDS = ["unspecified", "allowed", "notAllowed", "constrained"] as const;

export type UseWord = (typeof USE_WORDS)[number];

/** The four uses one statement covers, named exactly as MoolamConsent.Consent names them. */
export const USE_FIELDS = ["aiTraining", "aiGenerativeTraining", "aiInference", "dataMining"] as const;

export type UseField = (typeof USE_FIELDS)[number];

export type ConsentWords = Record<UseField, UseWord>;

export type ConsentValues = Record<UseField, number>;

/** One named statement from the plan. constraintInfo is empty unless a use is constrained. */
export interface Statement {
  name: string;
  consent: ConsentWords;
  constraintInfo: string;
}

/** What consentOf hands back for a passport that has been spoken for. */
export interface OnChainEntry {
  at: bigint;
  writer: Hex;
  consent: ConsentValues;
  constraintInfo: string;
}

/** MoolamConsent.MAX_BATCH: the most passports one setConsentBatch call may carry. */
export const MAX_BATCH = 32;

/** MoolamConsent.MAX_INFO_BYTES: the longest the constraint text may be. */
export const MAX_INFO_BYTES = 256;

export function useValue(word: UseWord): number {
  return USE_WORDS.indexOf(word);
}

export function isUseWord(value: string): value is UseWord {
  return (USE_WORDS as readonly string[]).includes(value);
}

/** True when any of the four uses is constrained, which is what makes the text required. */
export function isConstrained(consent: ConsentWords): boolean {
  return USE_FIELDS.some((field) => consent[field] === "constrained");
}

/** The four words as the four numbers the contract stores. */
export function consentValues(consent: ConsentWords): ConsentValues {
  return {
    aiTraining: useValue(consent.aiTraining),
    aiGenerativeTraining: useValue(consent.aiGenerativeTraining),
    aiInference: useValue(consent.aiInference),
    dataMining: useValue(consent.dataMining),
  };
}

/**
 * The position of the first byte the contract would refuse, or -1 when every byte is printable.
 *
 * The same predicate _checkConstraintInfo applies, over the same UTF-8 bytes rather than over
 * JavaScript characters, so a text this accepts is a text the chain accepts. Anything outside
 * 0x20 to 0x7E is refused, which covers control characters, newlines and every non-ASCII letter.
 */
export function firstUnprintableByte(text: string): number {
  const bytes = Buffer.from(text, "utf8");
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte < 0x20 || byte > 0x7e) return i;
  }
  return -1;
}

/** How long the contract will measure this text, which is its UTF-8 length and not its character count. */
export function infoByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Whether a passport's newest entry already says exactly what the plan says.
 *
 * Only the statement is compared, never who wrote it or when, because that is what decides whether
 * a second run has anything left to send.
 */
export function matchesStatement(entry: OnChainEntry, statement: Statement): boolean {
  const wanted = consentValues(statement.consent);
  const sameUses = USE_FIELDS.every((field) => entry.consent[field] === wanted[field]);
  return sameUses && entry.constraintInfo === statement.constraintInfo;
}
