/**
 * The few words the wide studio's lab page adds, in English only while it is on
 * the lab page. The wide layout itself adds none: its Load more borrows the
 * Explore grid's words, as /mine does.
 *
 * TRANSLATE AT ROLL-IN: anything here that reaches the real studio moves into
 * messages/*.json, in all ten languages, in the one word order that follows
 * Ram's yes. Nothing on a real route reads this object.
 */
export const WIDE_WORDS = {
  bench: "Studio wide bench",
  fixtureNote: "Fixture: stubbed studio state. No wallet, nothing is sent.",
  upload: "upload",
  generate: "generate",
  done: "done",
  live: "live",
  today: "today",
} as const;
