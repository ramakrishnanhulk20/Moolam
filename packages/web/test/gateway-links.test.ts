// Does not cover: whether a gateway actually serves the file, or the image optimizer's host list.
import { describe, expect, it } from "vitest";
import { pinnedUri } from "@/components/passport/art";
import { moolamGatewayPath, pictureSources } from "@/lib/images";
import { publicEnv } from "@/lib/env";

const CID = "bafkreigmtpettnq5ljkxrxbxcxwqnrz3ycgmybxdmkhpxt2dbrz6gukdye";
const GATEWAY = publicEnv.ipfsGateway.endsWith("/") ? publicEnv.ipfsGateway : `${publicEnv.ipfsGateway}/`;
const PINATA = `https://lavender-personal-grasshopper-978.mypinata.cloud/ipfs/${CID}`;

describe("links on Moolam's earlier Pinata gateway", () => {
  it("are read through the gateway this deploy is set to", () => {
    expect(pictureSources(PINATA)).toEqual([`${GATEWAY}${CID}`]);
    expect(pictureSources(`ipfs://${CID}`)).toEqual([`${GATEWAY}${CID}`]);
  });

  it("still count as pinned, as ipfs://<cid>", () => {
    expect(pinnedUri(PINATA)).toBe(`ipfs://${CID}`);
  });

  it("leave any other host, a query or plain http alone", () => {
    const other = `https://example.com/ipfs/${CID}`;
    expect(moolamGatewayPath(other)).toBeNull();
    expect(pictureSources(other)).toEqual([other]);
    expect(moolamGatewayPath(`${PINATA}?filename=a.jpg`)).toBeNull();
    expect(moolamGatewayPath(PINATA.replace("https:", "http:"))).toBeNull();
    expect(pinnedUri(other)).toBeUndefined();
  });
});
