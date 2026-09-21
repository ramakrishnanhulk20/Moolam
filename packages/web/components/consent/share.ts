import type { ConsentReading, Statement } from "@/lib/chain/consent";
import { plainStatement } from "@/lib/chain/consent";

/**
 * What a passport link says about AI use before anybody opens it.
 *
 * A link pasted into a chat is seen by more people than the page is, and every
 * one of them was being handed the same sentence about the app. The one fact
 * that belongs to this picture and to no other is what its holder allows, so it
 * leads, and the picture's own words follow it.
 *
 * A register that could not be read and a holder who has said nothing both
 * leave the description exactly as it was. A description is no place to guess a
 * permission, and silence written into a head would be read as an answer.
 */
export function shareDescription(
  reading: ConsentReading | null,
  described: string | undefined,
  fallback: string,
  lead: (statement: Exclude<Statement, "none">, at: number) => string,
): string | undefined {
  const entry = reading?.entry;
  if (reading === null || !reading.stated || entry === null || entry === undefined) {
    return described;
  }

  // A statement can name all four uses and still say nothing about any of them,
  // which is not a sentence worth leading a link with.
  const summary = plainStatement(entry.consent);
  if (summary === "none") {
    return described;
  }

  const said = described?.trim();
  return `${lead(summary, Number(entry.at))} ${said === undefined || said.length === 0 ? fallback : said}`;
}
