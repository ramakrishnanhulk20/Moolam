/**
 * A picture's title goes into its public metadata for good, so the visitor may choose it, and a
 * title that would hide or reorder text is refused rather than cleaned.
 */

/** The kit's limit, counted the way the kit counts it: UTF-16 units after trimming. */
export const TITLE_MAX = 120;

/**
 * Every character that is not printable text: controls, format characters such as the zero-width
 * and bidirectional marks, surrogates, private-use and unassigned code points (the whole Unicode
 * "Other" category), and the line and paragraph separators. One category test rather than a list,
 * so a mark nobody thought of is still caught. It does not catch lookalike letters from other
 * scripts, which are printable.
 */
const NOT_PRINTABLE = /[\p{C}\p{Zl}\p{Zp}]/u;

/** The visitor's title, trimmed, or null when it is not 1 to 120 characters of printable text. */
export function chosenTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.trim();
  if (title.length < 1 || title.length > TITLE_MAX || NOT_PRINTABLE.test(title)) return null;
  return title;
}

/**
 * The title used when the visitor gives none: the prompt on one line with anything unprintable
 * turned into a space, cut to 120 on a whole character.
 */
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

/**
 * The title for a request body: the visitor's when present, the prompt's when the field is left out,
 * and null when a title was given and fails the rule.
 */
export function titleFor(body: Record<string, unknown> | null, prompt: string): string | null {
  if (body === null || body.title === undefined) return defaultTitle(prompt);
  return chosenTitle(body.title);
}
