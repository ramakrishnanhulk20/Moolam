import { describe, expect, it } from "vitest";
import { networkCanFetch } from "@/components/mark/networkFetch";
import { pinnedUri } from "@/components/passport/art";
import { PICTURE_HOSTS } from "@/lib/images";
import { pinnedContentId } from "../../workflow/moolam-verifier/pinned";

/**
 * "Waiting for Chainlink" may only be said of a passport the network will
 * really fetch. The workflow's own function decides that, so the site's
 * predicate is held to it here on the shapes a registrant can write.
 */

const CID = "bafkreiabc123";

const REFERENCES = [
  `ipfs://${CID}`,
  `ipfs://${CID}/x.json`,
  `ipfs://${CID}/`,
  `https://${PICTURE_HOSTS[0]}/ipfs/${CID}`,
  "https://evil.example/ipfs/bafkreiabc123",
  "ipfs://",
  "",
  `IPFS://${CID}`,
  `ipfs://${CID}?download=1`,
  `ipfs://${CID}#top`,
  `ipfs://${CID} `,
  `ipfs://${CID}\n`,
  `ipfs://${CID}:80`,
  `ipfs://user@${CID}`,
  `ipfs://${CID}/../../etc`,
  CID,
  "data:application/json,{}",
  "data:image/png;base64,AAAA",
  "javascript:alert(1)",
  "the re-encoded copy",
];

describe("the picture the network can fetch", () => {
  it("answers as the workflow's pinnedContentId does on every shape a registrant can write", () => {
    for (const reference of REFERENCES) {
      expect(networkCanFetch(reference), JSON.stringify(reference)).toBe(pinnedContentId(reference) !== null);
    }
  });

  it("is true only for a bare ipfs address, which is the one case that table holds", () => {
    expect(REFERENCES.filter(networkCanFetch)).toEqual([`ipfs://${CID}`]);
  });

  it("is narrower than what this site can draw, which is the gap the mark must not paper over", () => {
    expect(pinnedUri(`ipfs://${CID}/x.json`)).toBeDefined();
    expect(networkCanFetch(`ipfs://${CID}/x.json`)).toBe(false);
    expect(pinnedUri(`https://${PICTURE_HOSTS[0]}/ipfs/${CID}`)).toBeDefined();
    expect(networkCanFetch(`https://${PICTURE_HOSTS[0]}/ipfs/${CID}`)).toBe(false);
  });
});
