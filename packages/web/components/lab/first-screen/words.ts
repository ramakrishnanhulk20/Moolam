/**
 * The bench's words. English only: they move into the ten message files once
 * Ram has picked a drawing, and not before.
 *
 * The line under the headline says strip, shrink and screenshot, and not crop.
 * The verifier's own degrade ladder finds a stripped, a halved and a
 * screenshotted copy at 0 bits and misses a 10 percent crop outright, so a
 * crop is a promise the product only keeps for a sliver of one.
 */
export const WORDS = {
  kicker: "Moolam",
  headline: "Prove where an AI image came from,",
  headlineTail: "from any copy.",
  line: "A passport on Monad says who made a picture, which agent drew it, how AI may use it. Strip it, shrink it, screenshot it: the passport still finds it.",
  drop: "Drop any copy of any image",
  choose: "Choose an image",
  hint: "JPEG, PNG or WebP. No picture to hand? Press one of these real passports.",
  dropping: "Let go to check it",
  samples: "Real passports on Monad",
  again: "Check another",
  make: "Make one",
  makeNote: "Register your own picture. Free, with a passkey.",
  openPassport: "Open the passport",
  filmFollows: "The film follows here",
} as const;

/** The four sponsors, once each, in the order the product meets them. */
export const BILLING = ["On Monad mainnet", "Passkeys by Privy", "Re-checked by Chainlink", "Indexed by Envio"] as const;

/**
 * The product's own name for each of the five statements, word for word as the
 * passport page and the verify card print them in English. A test holds these
 * to messages/en.json, so the bench cannot drift from the screens it borrows from.
 */
export const SUMMARIES = {
  open: "Open to AI use",
  closed: "Not for AI training",
  ask: "Ask the holder first",
  mixed: "Stated use by use",
  none: "Nothing stated yet",
} as const;
