import { isRead, type CopyReading, type Finding, type Read } from "./finding";

/** One sentence of the finding: the lead in quiet ink and the fact in bright. */
export interface Line {
  lead: string;
  fact: string;
  /** How the fact is inked: the accent for the proof, plain for the rest, the cold status colour for a miss. */
  tone: "proof" | "plain" | "miss";
}

/** The words the finding needs that are not read: the product's own name for each summary. */
export interface Summaries {
  open: string;
  closed: string;
  ask: string;
  mixed: string;
  none: string;
}

const DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

/** A chain second as a date a stranger reads at a glance. */
export function day(seconds: number): string {
  return DATE.format(new Date(seconds * 1000));
}

function bits(count: number): string {
  return `${count} of 64 bits apart`;
}

/** The copy the server made, in one line. Only a match the service itself named is called found. */
export function copyLine(copy: Read<CopyReading>): Line {
  const lead = "A copy trimmed, recoloured and re-encoded on this server:";
  if (!isRead(copy)) {
    return { lead, fact: "the verify service did not answer this minute", tone: "plain" };
  }
  return copy.read.found
    ? { lead, fact: `found, ${bits(copy.read.distance)}`, tone: "proof" }
    : { lead, fact: `not found, ${bits(copy.read.distance)}`, tone: "miss" };
}

/** The Chainlink re-check, in one line, or the plain fact that there is none yet. */
export function recheckLine(finding: Finding): Line {
  const { recheck } = finding;
  if (recheck === null) {
    return { lead: "Chainlink:", fact: "no re-check written for this passport yet", tone: "plain" };
  }
  return recheck.matched
    ? { lead: `Re-checked by Chainlink on ${day(recheck.at)}:`, fact: bits(recheck.distance), tone: "proof" }
    : { lead: `Re-checked by Chainlink on ${day(recheck.at)}:`, fact: `did not match, ${bits(recheck.distance)}`, tone: "miss" };
}

/** What the holder said about AI use, in the product's own words for it. */
export function statementLine(finding: Finding, words: Summaries): Line {
  if (finding.statementError !== null) {
    return { lead: "AI use:", fact: "the consent register did not answer this minute", tone: "plain" };
  }
  if (finding.statement === null) {
    return { lead: "AI use:", fact: words.none, tone: "plain" };
  }
  return {
    lead: `Its holder's word on AI use, ${day(finding.statement.at)}:`,
    fact: words[finding.statement.summary],
    tone: "plain",
  };
}
