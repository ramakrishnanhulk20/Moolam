import type { Art } from "./art";

/**
 * True when no gateway handed over a readable document, as opposed to one that
 * was read and has no name in it. A read document always carries the title
 * field, even when its value is missing; the bare answer for "nothing could be
 * read" is `{ missing: true }` and has no such field. Null is a passport with
 * no document address at all, which has nothing to read either.
 *
 * This is the one rule for the question. The poster says "not read yet" for
 * the first and "Untitled" only for the second; Explore, the agents strip and
 * the lineage ask it here too, so no screen calls a read record unread.
 */
export function recordUnread(art: Pick<Art, "missing" | "sealed" | "title"> | null): boolean {
  return art === null || (art.missing && art.sealed !== true && !Object.hasOwn(art, "title"));
}
