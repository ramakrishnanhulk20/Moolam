import type { GeneratorRecord } from "@/lib/data/passports";

/**
 * Whether this agent gets a page inside Moolam.
 *
 * The ERC-8004 identity registry is shared by everyone on Monad, so most ids on
 * it belong to other teams' projects, token 0 included. An agent earns a page
 * here by having signed a Moolam passport, which is exactly what a Generator
 * row in the index means.
 *
 * An index that will not answer is not evidence that an agent is a stranger, so
 * the page still renders in that case and says the counts could not be read.
 */
export function indexKnowsAgent(record: GeneratorRecord | null, indexError: string | null): boolean {
  return indexError !== null || record !== null;
}
