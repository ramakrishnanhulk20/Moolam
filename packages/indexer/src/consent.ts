/// The vocabulary of MoolamConsent, in the index's own words.
///
/// The contract stores four numbers per statement and the app turns them into
/// words in packages/web/lib/chain/consent.ts. This file is that same mapping for
/// the index, so a caller who filters on `consentSummary` and a screen that reads
/// the contract directly can never disagree about what a picture allows. A number
/// outside the enum is null here rather than a guess: the handler drops the event
/// instead of writing a permission the chain did not give.

/// The contract's Use enum in its own order, 0 to 3.
const USE_WORDS = ["unspecified", "allowed", "notAllowed", "constrained"] as const;

export type Use = (typeof USE_WORDS)[number];

/// The five plain summaries. "mixed" is a statement that says different things
/// about different uses, which is a real choice and not a fallback.
export type Summary = "open" | "closed" | "ask" | "mixed" | "none";

/// The word for one enum value, or null when the value is outside the enum.
export function useWord(value: number): Use | null {
  return Number.isInteger(value) && value >= 0 && value < USE_WORDS.length
    ? USE_WORDS[value]!
    : null;
}

/// Reduces the four uses of one statement to a single summary, matching
/// plainStatement in packages/web/lib/chain/consent.ts field for field, including
/// its order: all unspecified is "none", not "mixed". Null when any of the four
/// numbers is outside the enum, which is the handler's signal to write nothing.
export function summaryOf(
  aiTraining: number,
  aiGenerativeTraining: number,
  aiInference: number,
  dataMining: number,
): Summary | null {
  const words = [aiTraining, aiGenerativeTraining, aiInference, dataMining].map(useWord);
  if (words.some((word) => word === null)) {
    return null;
  }
  if (words.every((word) => word === "unspecified")) {
    return "none";
  }
  if (words.every((word) => word === "allowed")) {
    return "open";
  }
  if (words.every((word) => word === "notAllowed")) {
    return "closed";
  }
  if (words.every((word) => word === "constrained")) {
    return "ask";
  }
  return "mixed";
}
