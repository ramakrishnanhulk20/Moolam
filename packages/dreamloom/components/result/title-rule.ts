/**
 * A copy of the server's title rule (lib/server/title.ts) for instant feedback while the visitor
 * types. The server stays the judge: it checks the same rule again and refuses with "title".
 * test/result-title.test.ts holds the two to the same answers.
 */

/** The kit's limit, counted the way the kit counts it: UTF-16 units after trimming. */
export const TITLE_MAX = 120;

const NOT_PRINTABLE = /[\p{C}\p{Zl}\p{Zp}]/u;

export type TitleProblem = "empty" | "long" | "hidden";

export const TITLE_WORDS: Record<TitleProblem, string> = {
  empty: "Give it a title of at least one character.",
  long: `Keep the title to ${TITLE_MAX} characters.`,
  hidden: "The title has a hidden or control character in it. Retype it as plain text.",
};

/** Why the server would refuse this title, or null when it would take it. */
export function titleProblem(value: string): TitleProblem | null {
  const title = value.trim();
  if (title.length < 1) return "empty";
  if (NOT_PRINTABLE.test(title)) return "hidden";
  if (title.length > TITLE_MAX) return "long";
  return null;
}

/** The title the server uses when none is given: the prompt on one line, cut to 120 on a whole character. */
export function defaultTitle(prompt: string): string {
  const flat = prompt.replace(/[\s\p{C}\p{Zl}\p{Zp}]+/gu, " ").trim();
  let title = "";
  for (const character of flat) {
    if (title.length + character.length > TITLE_MAX) break;
    title += character;
  }
  title = title.trim();
  return title.length > 0 ? title : "Untitled";
}
