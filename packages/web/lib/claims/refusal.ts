/**
 * Every word the claim routes refuse with, as a sentence and the one thing
 * worth doing next.
 *
 * The words are the service's fixed list (packages/verifier/src/routes/claims.ts):
 * none of them carries an email or anything about one (P29), so nothing here
 * needs to be hidden from the person. A word this list does not know falls
 * back on the status, so a new refusal still says something true.
 */

/** A string under "claims.refusal" in the message files. */
export type RefusalKey =
  | "unavailable"
  | "signIn"
  | "limit"
  | "globalLimit"
  | "privy"
  | "noWallet"
  | "destination"
  | "notFound"
  | "notOpen"
  | "full"
  | "recordRefused"
  | "badRequest"
  | "offline"
  | "badResponse";

/** The single button offered under the sentence, or none when pressing again would fail the same way. */
export type RefusalNext = "again" | "signIn" | "reload";

export interface ClaimRefusal {
  key: RefusalKey;
  next?: RefusalNext;
  /** The service's own word, kept for a test and a support question, never printed as the sentence. */
  word?: string;
}

const WORDS: Record<string, Omit<ClaimRefusal, "word">> = {
  "claims-unavailable": { key: "unavailable", next: "again" },
  unauthorized: { key: "signIn", next: "signIn" },
  limit: { key: "limit" },
  "global-limit": { key: "globalLimit" },
  "privy-unavailable": { key: "privy", next: "again" },
  "no-wallet": { key: "noWallet", next: "signIn" },
  destination: { key: "destination" },
  "not-found": { key: "notFound", next: "reload" },
  "not-open": { key: "notOpen", next: "reload" },
  full: { key: "full" },
  "record-refused": { key: "recordRefused", next: "again" },
  // A 400 names the field it failed on. The page built that field, so reading the list again is the way on.
  ticketIds: { key: "badRequest", next: "reload" },
  terms: { key: "badRequest", next: "reload" },
  sendFuture: { key: "badRequest", next: "reload" },
  platformKeyHash: { key: "badRequest", next: "reload" },
  body: { key: "badRequest", next: "reload" },
};

/**
 * What My pictures draws when the list could not be read and there is no
 * earlier list to keep showing.
 *
 * A service with its claim routes closed says so in its own word: that is the
 * operator's choice and nothing the person can mend, so nothing is drawn. A
 * sign-in that ran out keeps its own words and the sign-in button. Anything
 * else is one quiet line with a way to read again, because a person sent here
 * by a platform's "your passport is waiting" must never meet a blank.
 */
export function unreadLine(refusal: ClaimRefusal): "none" | "signIn" | "readFailed" {
  if (refusal.word === "claims-unavailable") return "none";
  if (refusal.key === "signIn") return "signIn";
  return "readFailed";
}

/**
 * The refusal for one answer. Status 0 is a request that never got an answer,
 * and -1 an answer in a shape this page does not know.
 */
export function refusalFor(status: number, body: unknown): ClaimRefusal {
  const word = (body as { error?: unknown } | null)?.error;
  if (typeof word === "string" && Object.hasOwn(WORDS, word)) {
    return { ...WORDS[word], word };
  }
  if (status === 0) return { key: "offline", next: "again" };
  if (status === 401) return { key: "signIn", next: "signIn" };
  // The rate limiter in front of every route answers 429 in its own words.
  if (status === 429) return { key: "limit" };
  if (status === 400) return { key: "badRequest", next: "reload" };
  if (status === 404) return { key: "notFound", next: "reload" };
  if (status === 409) return { key: "notOpen", next: "reload" };
  if (status === 503 || status === 502) return { key: "unavailable", next: "again" };
  return { key: "badResponse", next: "again" };
}
