import type { Art } from "./art";

/**
 * True when no gateway handed over a readable document, as opposed to one that
 * was read and has no name in it. A read document always carries the title
 * field, even when its value is missing; the bare answer for "nothing could be
 * read" is `{ missing: true }` and has no such field. The poster says "not read
 * yet" for the first and "Untitled" only for the second.
 */
export function recordUnread(art: Art): boolean {
  return art.missing && art.sealed !== true && !Object.hasOwn(art, "title");
}
