import { bareContentId } from "@/lib/passport/original";

/**
 * Whether Chainlink's workflow would fetch this address.
 *
 * The workflow takes only `ipfs://<cid>` with nothing after the id
 * (pinnedContentId in packages/workflow/moolam-verifier/pinned.ts). This site
 * reads more than that: a file under the id, and Moolam's own gateway link, both
 * draw fine. So "the site can show it" and "the network can check it" are two
 * answers, and a mark that says "waiting" may only be given for the second.
 * test/network-fetch.test.ts holds this to the workflow's own function.
 */
export function networkCanFetch(reference: string): boolean {
  return bareContentId(reference) !== null;
}
