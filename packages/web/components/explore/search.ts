/**
 * What the search box on Explore reads a term as.
 *
 * The index holds ids and never a title: a title lives in the pinned document on
 * IPFS. A term that starts like an id goes to the index exactly as it always
 * has. Anything else is matched against the titles the sheet already reads for
 * every plate, and against the ids too, so a bare run of hex copied from a plate
 * still finds it.
 */

/** Whether a term is a passport id, or the front of one, and so searched by the index itself. */
export function isIdTerm(term: string): boolean {
  return /^0x[0-9a-f]*$/i.test(term.trim());
}

/** Whether the sheet has to read titles to answer this term. */
export function searchesTitles(term: string): boolean {
  return term.trim() !== "" && !isIdTerm(term);
}

/** Whether one passport answers a term that is not an id: its title holds it, or its id does. Case never matters. */
export function answersTerm(term: string, id: string, title: string | null): boolean {
  const clean = term.trim().toLowerCase();
  if (clean === "") {
    return true;
  }
  return (title ?? "").toLowerCase().includes(clean) || id.toLowerCase().includes(clean);
}
