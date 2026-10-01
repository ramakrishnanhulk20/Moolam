import type { ExploreMarkFacts } from "@/lib/data/passports";
import { issueMark, type MarkPicture, type MarkState } from "./mark";
import { MARK_PHASH_LIMIT } from "./rule";

/**
 * The mark one Explore plate wears, by the same function the passport page and
 * the MCP server use, from the index's side of the facts and the plate's own
 * document. Null when the index does not serve the mark's fields, or when a
 * fact the mark needs could not be read: a plate then draws no word, rather
 * than a word nobody can stand behind.
 *
 * The index keeps only each passport's newest look-alike record and says
 * whether it is the network's, valid and names an earlier passport
 * (earlierFound), so that one flag is the whole record the mark needs.
 */
export function plateMarkState(facts: ExploreMarkFacts | undefined, picture: MarkPicture | null): MarkState | null {
  if (facts === undefined) {
    return null;
  }
  const mark = issueMark({
    dispute: facts.dispute,
    verdicts:
      facts.verdict === null
        ? []
        : [{ network: true, matched: facts.verdict.matched, phashBits: facts.verdict.distance, at: facts.verdict.at }],
    lookalike: {
      read: true,
      record: facts.earlierFound ? { network: true, valid: true, earlier: "indexed", executedAt: 0 } : null,
    },
    picture,
    phashLimit: MARK_PHASH_LIMIT,
  });
  return mark.state === "unread" ? null : mark.state;
}
