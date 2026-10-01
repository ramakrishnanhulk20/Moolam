import { createHash } from "node:crypto";
import { getAddress, hashTypedData, type Address, type Hex } from "viem";
import { z } from "zod";
import { domain } from "../generate/eip712.js";
import { MONAD_CHAIN_ID } from "../reputation/registry.js";

/** How long the holder of a challenged passport has to answer, from the dispute's openedAt, by chain time. */
export const ANSWER_WINDOW_SECONDS = 14n * 24n * 60n * 60n;

/** The most an answer may weigh in UTF-8 bytes (L27). */
export const MAX_ANSWER_BYTES = 4_000;

export const ANSWER_DOCUMENT_KIND = "moolam-challenge-answer";

export const ANSWER_DOCUMENT_VERSION = 1;

/** Field order is load bearing: it produces the type string every holder's wallet hashes. */
export const CHALLENGE_ANSWER_TYPES = {
  ChallengeAnswer: [
    { name: "passportId", type: "bytes32" },
    { name: "openedAt", type: "uint64" },
    { name: "challenger", type: "address" },
    { name: "answerHash", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export interface ChallengeAnswerMessage {
  passportId: Hex;
  openedAt: bigint;
  challenger: Address;
  answerHash: Hex;
  deadline: bigint;
}

/**
 * The typed data a holder signs: Moolam's own domain, the registry's (L26), so a signature made for
 * one registry or one chain means nothing to another, and the dispute's identity is the very tuple
 * getDispute answers, so an answer cannot be carried to the next challenge on the same passport.
 */
export function answerTypedData(message: ChallengeAnswerMessage, registry: Hex) {
  return {
    domain: domain(registry, MONAD_CHAIN_ID),
    types: CHALLENGE_ANSWER_TYPES,
    primaryType: "ChallengeAnswer" as const,
    message,
  };
}

/** The 32 bytes a holder's signature covers. */
export function answerDigest(message: ChallengeAnswerMessage, registry: Hex): Hex {
  return hashTypedData(answerTypedData(message, registry));
}

/** The sha256 of the answer's UTF-8 bytes, exactly as sent. */
export function answerHashOf(text: string): Hex {
  return `0x${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

// Letters, marks, digits, punctuation, symbols, the plain space and the line break. One predicate
// over the whole text rather than a list of characters to refuse, so a tab, a NUL, a lone carriage
// return, a direction override and a lone surrogate half are all out without anyone naming them.
const PRINTABLE_TEXT = /^[\p{L}\p{M}\p{N}\p{P}\p{S} \n]+$/u;

/**
 * Whether a non-empty text is printable Unicode whose only control character is the line break, a
 * Windows \r\n read as one \n. Shared by the holder's answer and the resolver's reasons.
 */
export function isPrintableWithLineBreaks(text: string): boolean {
  return PRINTABLE_TEXT.test(text.replace(/\r\n/g, "\n"));
}

/**
 * Why an answer's text is refused, or null when it may be pinned (L27): at least one character, at
 * most MAX_ANSWER_BYTES in UTF-8, printable Unicode whose only control character is the line break,
 * so an answer can have paragraphs. A Windows line break (\r\n) is read as one \n for this check,
 * and a carriage return on its own is refused. The text is never rewritten, because its hash is
 * what the holder signed.
 */
export function answerTextProblem(text: string): string | null {
  if (text.length === 0) return "the answer is empty";
  if (Buffer.byteLength(text, "utf8") > MAX_ANSWER_BYTES) return `the answer is over ${MAX_ANSWER_BYTES} bytes`;
  if (!isPrintableWithLineBreaks(text)) {
    return "the answer must be printable text, with line breaks as its only control characters and no direction characters";
  }
  return null;
}

const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The only document an answer is pinned as. It names the passport, the dispute it answers by
 * openedAt and challenger, the holder who signed, the text, its hash, the deadline and the
 * signature, so anyone can check it against the chain and the holder's key without this service.
 */
export const answerDocumentSchema = z.strictObject({
  kind: z.literal(ANSWER_DOCUMENT_KIND),
  version: z.literal(ANSWER_DOCUMENT_VERSION),
  chainId: z.literal(MONAD_CHAIN_ID),
  registry: z.string().regex(ADDRESS),
  passportId: z.string().regex(HEX32),
  openedAt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  challenger: z.string().regex(ADDRESS),
  holder: z.string().regex(ADDRESS),
  text: z.string().refine((text) => answerTextProblem(text) === null, "the text must pass the answer rule"),
  answerHash: z.string().regex(HEX32),
  deadline: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  signature: z.string().regex(/^0x[0-9a-f]{130}$/),
  note: z.string().min(1),
});

export type AnswerDocument = z.infer<typeof answerDocumentSchema>;

export const ANSWER_DOCUMENT_NOTE =
  "The holder of this passport signed this answer with their wallet as EIP-712 ChallengeAnswer typed data in the Moolam domain of the registry above. It is the holder's own words; Moolam checked only who signed it, which dispute it names, its size and that it is plain text.";

/**
 * Builds the answer document and hands back the schema's own output. The text's hash is computed
 * again here, so a document whose text and hash disagree is never built.
 *
 * Throws when any field is outside its shape.
 */
export function answerDocument(input: {
  registry: Hex;
  passportId: Hex;
  openedAt: bigint;
  challenger: Address;
  holder: Address;
  text: string;
  deadline: bigint;
  signature: Hex;
}): AnswerDocument {
  return answerDocumentSchema.parse({
    kind: ANSWER_DOCUMENT_KIND,
    version: ANSWER_DOCUMENT_VERSION,
    chainId: MONAD_CHAIN_ID,
    registry: getAddress(input.registry),
    passportId: input.passportId.toLowerCase(),
    openedAt: Number(input.openedAt),
    challenger: getAddress(input.challenger),
    holder: getAddress(input.holder),
    text: input.text,
    answerHash: answerHashOf(input.text),
    deadline: Number(input.deadline),
    signature: input.signature.toLowerCase(),
    note: ANSWER_DOCUMENT_NOTE,
  });
}
