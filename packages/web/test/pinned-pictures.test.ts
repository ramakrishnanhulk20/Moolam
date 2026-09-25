import { afterEach, describe, expect, it, vi } from "vitest";
import { pinnedUri, readArt } from "@/components/passport/art";
import { gatewayUrl } from "@/lib/chain/client";
import { PICTURE_HOSTS } from "@/lib/images";

/**
 * A passport's picture is only ever an IPFS file read through Moolam's gateway.
 *
 * The registry takes any string as the document address, and the document can
 * name any picture address. Drawn as it stood, an https picture sent every
 * visitor's browser to a host the registrant chose, which could log them and
 * change the picture after registration. Anything that is not pinned now gets
 * the seal plate, as the film already did.
 */

const DOCUMENT = "ipfs://bafkreidocument";
const GATEWAY_HOST = PICTURE_HOSTS[0];

function answering(document: unknown) {
  return vi.fn<(input: string | URL) => Promise<Response>>(
    async () => new Response(JSON.stringify(document), { headers: { "content-type": "application/json" } }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the addresses a picture may have", () => {
  it("takes ipfs://<cid>, with or without a file inside it", () => {
    expect(pinnedUri("ipfs://bafkreiabc123")).toBe("ipfs://bafkreiabc123");
    expect(pinnedUri("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/image.png")).toBe(
      "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/image.png",
    );
  });

  it("takes the gateway form Moolam writes, and hands it back as ipfs://<cid>", () => {
    expect(pinnedUri(`https://${GATEWAY_HOST}/ipfs/bafkreiabc123`)).toBe("ipfs://bafkreiabc123");
  });

  it("refuses every other host, scheme and shape", () => {
    for (const address of [
      "https://evil.example/ipfs/bafkreiabc123",
      "https://evil.example/picture.png",
      "http://" + GATEWAY_HOST + "/ipfs/bafkreiabc123",
      `https://${GATEWAY_HOST}/ipfs/bafkreiabc123?track=1`,
      `https://${GATEWAY_HOST}/not-ipfs/bafkreiabc123`,
      `https://${GATEWAY_HOST}.evil.example/ipfs/bafkreiabc123`,
      "ipfs://bafkrei/../../etc",
      "ipfs://",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "the re-encoded copy",
    ]) {
      expect(pinnedUri(address), address).toBeUndefined();
    }
  });
});

describe("a document read by readArt", () => {
  it("draws a pinned picture through Moolam's gateway", async () => {
    vi.stubGlobal("fetch", answering({ name: "Nets", image: "ipfs://bafkreifull", thumbnail: "ipfs://bafkreismall" }));
    const art = await readArt(DOCUMENT);
    expect(art.imageUrl).toBe(gatewayUrl("ipfs://bafkreifull"));
    expect(art.thumbnailUrl).toBe(gatewayUrl("ipfs://bafkreismall"));
    expect(art.missing).toBe(false);
  });

  it("gives the seal plate to a picture on a host the registrant chose", async () => {
    vi.stubGlobal(
      "fetch",
      answering({ name: "Nets", image: "https://evil.example/full.png", thumbnail: "https://evil.example/small.png" }),
    );
    const art = await readArt(DOCUMENT);
    expect(art.imageUrl).toBeUndefined();
    expect(art.thumbnailUrl).toBeUndefined();
    expect(art.missing).toBe(true);
    expect(art.title).toBe("Nets");
  });

  it("rewrites a picture named on Moolam's gateway to this deploy's gateway", async () => {
    vi.stubGlobal("fetch", answering({ image: `https://${GATEWAY_HOST}/ipfs/bafkreifull` }));
    const art = await readArt(DOCUMENT);
    expect(art.imageUrl).toBe(gatewayUrl("ipfs://bafkreifull"));
  });

  it("never fetches a document whose address is not pinned", async () => {
    const fetch = answering({ image: "ipfs://bafkreifull" });
    vi.stubGlobal("fetch", fetch);
    expect(await readArt("https://evil.example/document.json")).toEqual({ missing: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads the document itself through Moolam's gateway", async () => {
    const fetch = answering({ image: "ipfs://bafkreifull" });
    vi.stubGlobal("fetch", fetch);
    await readArt(DOCUMENT);
    expect(String(fetch.mock.calls[0][0])).toBe(gatewayUrl(DOCUMENT));
  });
});
