/**
 * The numbers the trust mark and its lines are drawn with.
 *
 * MARK_PHASH_LIMIT is the shared look-alike rule's LOOKALIKE_PHASH_BITS
 * (packages/verifier/src/lookalike-rule.ts and the workflow's copy). The site
 * keeps its own copy rather than bundling the verify service's source, and
 * test/marks.test.ts reads that file and fails if the two ever differ.
 */
export const MARK_PHASH_LIMIT = 10;

/** How long a holder has to answer a challenge, by the verify service's own rule (L26). */
export const ANSWER_DAYS = 14;

/** How long a self-registered picture's claim is said to be open to challenge. */
export const CLAIM_WINDOW_DAYS = 30;

export const DAY_SECONDS = 86_400;
