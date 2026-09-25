/**
 * The words only the bench still carries, English only. Everything the home
 * page's first screen says is in the ten message files under home.first.
 */
export const WORDS = {
  openPassport: "Open the passport",
  filmFollows: "The film follows here",
} as const;

/**
 * The product's own name for each of the five statements, word for word as the
 * passport page and the verify card print them in English. A test holds these
 * to messages/en.json, so the poster's credit block cannot drift from the
 * screens it borrows from.
 */
export const SUMMARIES = {
  open: "Open to AI use",
  closed: "Not for AI training",
  ask: "Ask the holder first",
  mixed: "Stated use by use",
  none: "Nothing stated yet",
} as const;
