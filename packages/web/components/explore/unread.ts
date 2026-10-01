import { pinnedUri, type Art } from "@/components/passport/art";
import { recordUnread } from "@/components/passport/unread";

/**
 * The unread flag a plate hands to the test-image rule (isTestCard in ./sort).
 *
 * A record no gateway handed over keeps its place among the pictures, because on
 * 28 September a slow gateway turned real pictures into test cards. That only
 * holds where a gateway could still answer: a document at a pinned address. A
 * document written straight into the chain as a data: address, or no address at
 * all, has nothing to wait for. Its plate is untitled with no picture on the
 * gateway, and it is a test image: three of the 8 September live proofs ended
 * the Pictures sheet that way.
 *
 * Kept apart from ./sort because that file also runs in the browser.
 */
export function plateUnread(metadataURI: string, art: Pick<Art, "missing" | "sealed" | "title"> | null): boolean {
  return recordUnread(art) && metadataURI !== "" && pinnedUri(metadataURI) !== undefined;
}
