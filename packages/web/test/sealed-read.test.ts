import { afterEach, describe, expect, it, vi } from "vitest";
import { readArt } from "@/components/passport/art";
import { heldArt } from "@/lib/data/passports";

/**
 * What the app reads out of a sealed passport's pinned document.
 *
 * Two answers have to be told apart for the rest of invariant 7 to hold. A
 * sealed record has no picture because its creator chose that, and a record
 * whose gateway is having a bad minute has no picture because nobody could
 * fetch it. The first must never be drawn with the words meant for the second,
 * and neither must ever be handed a URL that answers 404.
 */

const URI = "ipfs://bafkreisealedmetadata";
const PASSPORT = `0x${"7c".repeat(32)}`;
const BLOCKHASH = "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0";

/** The document packages/verifier/src/sealed.ts pins, with nothing added. */
const SEALED = {
  name: "Monsoon nets, Kovalam",
  description: "Registered on Moolam. The picture is not published.",
  sealed: true,
  commitment: { algorithm: "sha-256", value: PASSPORT },
  fingerprint: { phash: "0x6ccf137087789a25", blockhash: BLOCKHASH, version: 1 },
  createdAt: "2026-09-22T04:11:09.000Z",
};

function answering(document: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(document), { headers: { "content-type": "application/json" } }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a sealed document", () => {
  it("is read as sealed, with the commitment and the block hash and no picture at all", async () => {
    vi.stubGlobal("fetch", answering(SEALED));

    const art = await readArt(URI);

    expect(art.sealed).toBe(true);
    expect(art.commitment).toEqual({ algorithm: "sha-256", value: PASSPORT });
    expect(art.blockhash).toBe(BLOCKHASH);
    expect(art.imageUrl).toBeUndefined();
    expect(art.thumbnailUrl).toBeUndefined();
    // The one flag every screen branches on for a broken gateway.
    expect(art.missing).toBe(false);
  });

  it("comes back sealed through the held read the grid and the page both use", async () => {
    vi.stubGlobal("fetch", answering(SEALED));

    const art = await heldArt(URI);

    expect(art.sealed).toBe(true);
    expect(art.title).toBe("Monsoon nets, Kovalam");
    expect(art.missing).toBe(false);
  });

  it("keeps the title and the words a sealed record is allowed to publish", async () => {
    vi.stubGlobal("fetch", answering({ ...SEALED, prompt: "a fishing boat at first light" }));

    const art = await readArt(URI);

    expect(art.title).toBe("Monsoon nets, Kovalam");
    expect(art.prompt).toBe("a fishing boat at first light");
  });

  it("leaves out a block hash that is not a whole 32 byte word, rather than drawing a cut one", async () => {
    vi.stubGlobal("fetch", answering({ ...SEALED, fingerprint: { blockhash: "0x00ff" } }));

    expect((await readArt(URI)).blockhash).toBeUndefined();
  });
});

describe("a document that claims sealed and still names a picture", () => {
  const CONTRADICTED = { ...SEALED, image: "ipfs://bafkreipicture", thumbnail: "ipfs://bafkreithumbnail" };

  it("is read as published, because the picture is pinned and already public", async () => {
    vi.stubGlobal("fetch", answering(CONTRADICTED));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const art = await readArt(URI);

    expect(art.sealed).toBeUndefined();
    expect(art.commitment).toBeUndefined();
    expect(art.thumbnailUrl).toContain("bafkreithumbnail");
    expect(art.missing).toBe(false);
  });

  it("is written down once, however many times the same document is read", async () => {
    vi.stubGlobal("fetch", answering(CONTRADICTED));
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // Its own address: the line above is written per document, and the test
    // before this one has already used the other one up.
    const second = "ipfs://bafkreiotherdocument";

    await readArt(second);
    await readArt(second);
    await readArt(second);

    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0][0])).toContain("sealed");
  });
});

describe("a public document", () => {
  it("is unchanged by any of this: no seal, no commitment, the same picture", async () => {
    vi.stubGlobal(
      "fetch",
      answering({ name: "Kadal at dawn", image: "ipfs://bafkreifull", thumbnail: "ipfs://bafkreismall" }),
    );

    const art = await readArt(URI);

    expect(art.sealed).toBeUndefined();
    expect(art.commitment).toBeUndefined();
    expect(art.blockhash).toBeUndefined();
    expect(art.imageUrl).toContain("bafkreifull");
    expect(art.thumbnailUrl).toContain("bafkreismall");
    expect(art.missing).toBe(false);
  });

  it("with no picture at all is still counted as missing, which is the gateway's state and not a seal", async () => {
    vi.stubGlobal("fetch", answering({ name: "A record with no picture" }));

    const art = await readArt(URI);

    expect(art.sealed).toBeUndefined();
    expect(art.missing).toBe(true);
  });
});
