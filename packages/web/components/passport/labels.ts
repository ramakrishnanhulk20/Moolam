import { addresses } from "@/lib/chain/client";

/** Who wrote a re-check back to the registry. */
export type AttestationSource = "chainlink" | "other";

/**
 * Names the writer of an attestation.
 *
 * Moolam's two receivers are the only addresses its Chainlink CRE workflows
 * write through: the public workflow's, and the one the confidential workflow
 * uses for a sealed picture's private re-check. An attestation from either is a
 * Chainlink re-check and is labelled as one. Any other allowed receiver is shown
 * by its address instead of being given a name this app cannot prove.
 */
export function attestationSource(
  receiver: string,
  chainlinkReceivers: readonly string[] = [addresses.receiver, addresses.sealedReceiver],
): AttestationSource {
  const writer = receiver.toLowerCase();
  return chainlinkReceivers.some((known) => known.toLowerCase() === writer) ? "chainlink" : "other";
}

/** Where a passport stands, in the cold status family: never the brand accent. */
export type Standing = "verified" | "mismatched" | "disputed" | "unverified";

/**
 * The one word this passport gets.
 *
 * A dispute outranks everything: it is the only state with money behind it. A
 * re-check that did not match is next, because a passport nobody has checked
 * and a passport that failed a check must never read the same. Everything else
 * is simply unverified, which is the honest word for "registered, not yet
 * re-checked".
 *
 * `inherited` is the same verdict reached one picture higher up. The registry
 * marks only the passport a challenge named, so an edit of a picture proven
 * fake carries no mark of its own and has to be told apart from a clean record
 * by its lineage. A caller that cannot read the lineage leaves it out, and the
 * word then says only what the chain said.
 */
export function standingOf(passport: {
  disputed: boolean;
  inherited?: boolean;
  attestations: readonly { matched: boolean }[];
}): Standing {
  if (passport.disputed || passport.inherited === true) {
    return "disputed";
  }
  if (passport.attestations.some((attestation) => !attestation.matched)) {
    return "mismatched";
  }
  return passport.attestations.length > 0 ? "verified" : "unverified";
}

/** The text colour each standing wears. Teal for a pass, one red for trouble, grey for silence. */
export function standingClass(standing: Standing): string {
  if (standing === "verified") {
    return "text-verified";
  }
  return standing === "unverified" ? "text-text-faint" : "text-failed";
}
