import { z } from "zod";
import { getAddress, recoverTypedDataAddress, sha256, stringToBytes, type Hex } from "viem";
import { CHAIN_ID, addresses } from "@/lib/chain/client";

/**
 * The holder's answer to a challenge, as the verify service takes it and as a
 * page draws it (L26, L27).
 *
 * Everything that is signed here is the service's own rule, mirrored field for
 * field from packages/verifier/src/challenges/answer.ts, so the holder's wallet
 * signs the very bytes the service recovers. A test holds the two together.
 */

/** How long the holder has, from the dispute's openedAt, by chain time. */
export const ANSWER_WINDOW_SECONDS = 14 * 24 * 60 * 60;

/** The most an answer may weigh in UTF-8 bytes. */
export const MAX_ANSWER_BYTES = 4_000;

/** How long a signature stays good after the wallet makes it, counted from the chain's head. */
export const ANSWER_SIGNATURE_SECONDS = 10 * 60;

export const ANSWER_DOCUMENT_KIND = "moolam-challenge-answer";

/** Field order is load bearing: it is the type string every holder's wallet hashes. */
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
  challenger: Hex;
  answerHash: Hex;
  deadline: bigint;
}

const ANSWER_DOMAIN = { name: "Moolam", version: "1", chainId: CHAIN_ID, verifyingContract: addresses.registry };

/** The typed data the holder signs, in Moolam's registry domain, which is what binds it to this chain and this registry. */
export function answerTypedData(message: ChallengeAnswerMessage) {
  return {
    domain: ANSWER_DOMAIN,
    types: CHALLENGE_ANSWER_TYPES,
    primaryType: "ChallengeAnswer" as const,
    message,
  };
}

/**
 * The same typed data in the shape the embedded wallet's prompt takes. The
 * prompt carries the message as JSON, which has no bigint, so the two times
 * travel as decimal strings; EIP-712 hashes a uint64 the same from either.
 */
export function walletTypedData(message: ChallengeAnswerMessage) {
  return {
    domain: ANSWER_DOMAIN,
    types: { ChallengeAnswer: CHALLENGE_ANSWER_TYPES.ChallengeAnswer.map((field) => ({ ...field })) },
    primaryType: "ChallengeAnswer",
    message: {
      passportId: message.passportId,
      openedAt: message.openedAt.toString(),
      challenger: message.challenger,
      answerHash: message.answerHash,
      deadline: message.deadline.toString(),
    } as Record<string, unknown>,
  };
}

/** The sha256 of the text's UTF-8 bytes, exactly as sent. */
export function answerHashOf(text: string): Hex {
  return sha256(stringToBytes(text));
}

/** The text as it is signed and sent: a Windows line break becomes one \n, and nothing else changes. */
export function answerText(raw: string): string {
  return raw.replace(/\r\n/g, "\n");
}

export function answerBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

// The service's own predicate: letters, marks, digits, punctuation, symbols,
// the plain space and the line break, and nothing else.
const PRINTABLE_TEXT = /^[\p{L}\p{M}\p{N}\p{P}\p{S} \n]+$/u;

/** Why the typed text cannot be sent, as a key under challenge.answer.refusals, or null. */
export type AnswerTextProblem = "empty" | "tooLong" | "notPrintable";

/**
 * The service's text rule, checked before the wallet is asked, so a refusal
 * never costs the holder a signature. One stricter step than the service: text
 * that is only spaces and line breaks reads as empty, because it says nothing.
 */
export function answerTextProblem(raw: string): AnswerTextProblem | null {
  const text = answerText(raw);
  if (text.trim().length === 0) {
    return "empty";
  }
  if (answerBytes(text) > MAX_ANSWER_BYTES) {
    return "tooLong";
  }
  return PRINTABLE_TEXT.test(text) ? null : "notPrintable";
}

/** Every refusal the answer screen can print, each a key under challenge.answer.refusals. */
export type AnswerRefusal =
  | AnswerTextProblem
  | "noOpenDispute"
  | "windowClosed"
  | "expired"
  | "noHolder"
  | "notHolder"
  | "signatureUsed"
  | "alreadyAnswered"
  | "answering"
  | "unavailable"
  | "chainUnreachable"
  | "pinFailed"
  | "busy"
  | "declined"
  | "unknown";

/** The service's error words, each to the one line that says what happened. */
const REFUSAL_OF_ERROR: Record<string, AnswerRefusal> = {
  "no-open-dispute": "noOpenDispute",
  "answer-window-closed": "windowClosed",
  "answer-expired": "expired",
  "no-holder": "noHolder",
  "not-the-holder": "notHolder",
  "signature-used": "signatureUsed",
  "already-answered": "alreadyAnswered",
  answering: "answering",
  "answers-unavailable": "unavailable",
  "chain-unreachable": "chainUnreachable",
  "pin-failed": "pinFailed",
  "route-limit": "busy",
};

/**
 * One refusal from the answer route, in the screen's words. The route's 400s
 * carry a sentence rather than a word, so those are read by what they say; a
 * route the host never mounted answers 404 and means answers are not taken here.
 */
export function refusalOf(status: number, error: unknown): AnswerRefusal {
  const word = typeof error === "string" ? error : "";
  const named = REFUSAL_OF_ERROR[word];
  if (named !== undefined) {
    return named;
  }
  if (status === 429) {
    return "busy";
  }
  if (status === 400) {
    if (/empty/.test(word)) return "empty";
    if (/bytes/.test(word)) return "tooLong";
    if (/printable/.test(word)) return "notPrintable";
    return "unknown";
  }
  if (status === 404 || status === 503) {
    return "unavailable";
  }
  return "unknown";
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The pinned answer document, as the service hands it back beside its address. */
export const answerDocumentSchema = z.object({
  kind: z.literal(ANSWER_DOCUMENT_KIND),
  version: z.literal(1),
  chainId: z.number().int(),
  registry: z.string().regex(ADDRESS),
  passportId: z.string().regex(HEX32),
  openedAt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  challenger: z.string().regex(ADDRESS),
  holder: z.string().regex(ADDRESS),
  text: z.string().max(MAX_ANSWER_BYTES * 4),
  answerHash: z.string().regex(HEX32),
  deadline: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});

export const answerReadSchema = z.object({
  answerURI: z.string().regex(/^ipfs:\/\/[A-Za-z0-9]+$/),
  answer: answerDocumentSchema,
});

export type AnswerDocument = z.infer<typeof answerDocumentSchema>;

/** The dispute an answer is drawn beside, as getDispute holds it. */
export interface AnswerDispute {
  challenger: Hex;
  openedAt: number;
}

/** An answer a page may draw: the holder's words, who signed them, and where they are pinned. */
export interface HolderWords {
  text: string;
  holder: Hex;
  answerURI: string;
}

/**
 * The holder's words, only when the document answers this very dispute and the
 * holder's own signature covers this very text (L27).
 *
 * The service already checks all of it before it pins, and this checks it
 * again on the page, so a wrong or swapped answer from the service is shown
 * nowhere: same registry and chain, same passport, same openedAt, same
 * challenger, the text's hash is the hash that was signed, the text passes the
 * service's rule, and the signature recovers to the holder the document names.
 */
export async function holderWords(
  read: { answerURI: string; answer: AnswerDocument },
  passportId: Hex,
  dispute: AnswerDispute,
): Promise<HolderWords | null> {
  const document = read.answer;
  try {
    if (
      document.chainId !== CHAIN_ID ||
      getAddress(document.registry) !== getAddress(addresses.registry) ||
      document.passportId.toLowerCase() !== passportId.toLowerCase() ||
      document.openedAt !== dispute.openedAt ||
      getAddress(document.challenger) !== getAddress(dispute.challenger) ||
      document.answerHash.toLowerCase() !== answerHashOf(document.text) ||
      answerBytes(document.text) > MAX_ANSWER_BYTES ||
      !PRINTABLE_TEXT.test(answerText(document.text))
    ) {
      return null;
    }
    const signer = await recoverTypedDataAddress({
      ...answerTypedData({
        passportId: document.passportId.toLowerCase() as Hex,
        openedAt: BigInt(document.openedAt),
        challenger: getAddress(document.challenger),
        answerHash: document.answerHash.toLowerCase() as Hex,
        deadline: BigInt(document.deadline),
      }),
      signature: document.signature as Hex,
    });
    if (signer !== getAddress(document.holder)) {
      return null;
    }
    return { text: answerText(document.text), holder: signer, answerURI: read.answerURI };
  } catch {
    return null;
  }
}

/** The last unix second the holder may answer a dispute opened at this time. */
export function answerBy(openedAt: number): number {
  return openedAt + ANSWER_WINDOW_SECONDS;
}
