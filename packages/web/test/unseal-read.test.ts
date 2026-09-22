import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { heldArt } from "@/lib/data/passports";
import { heldUnseal, withUnseal } from "@/lib/data/unseal";
import type { Art } from "@/components/passport/art";

/**
 * What every screen reads for a passport that was registered sealed.
 *
 * The chain points at the sealed document for ever, so the document alone can
 * never say that the picture is out. The record pinned beside it can, and the
 * three answers it may give have to stay three: a record, no record, and a
 * service that could not find out. The third is the one worth a test, because
 * reading it as the second would hide a picture its holder has published.
 */

const URI = "ipfs://bafkreisealedmetadata";
const PASSPORT = `0x${"7c".repeat(32)}` as Hex;
const HOLDER = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a";
const BLOCKHASH = "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0";

/** The document packages/verifier/src/sealed.ts pins, which never changes after an unseal. */
const SEALED = {
  name: "Monsoon nets, Kovalam",
  description: "Registered on Moolam. The picture is not published.",
  sealed: true,
  commitment: { algorithm: "sha-256", value: PASSPORT },
  fingerprint: { phash: "0x6ccf137087789a25", blockhash: BLOCKHASH, version: 1 },
};

const RECORD = {
  passportId: PASSPORT,
  image: { cid: "bafkreiimage", uri: "ipfs://bafkreiimage", gatewayUrl: "https://service.example/ipfs/bafkreiimage" },
  thumbnail: { cid: "bafkreithumb", uri: "ipfs://bafkreithumb", gatewayUrl: "https://service.example/ipfs/bafkreithumb" },
  record: { cid: "bafkreirecord", uri: "ipfs://bafkreirecord", gatewayUrl: "https://service.example/ipfs/bafkreirecord" },
  unsealedBy: HOLDER,
  unsealedAt: "2026-09-22T06:12:44.000Z",
};

/** The gateway answers with the document; the verify service answers about the record. */
function serving(unseal: { status: number; body: unknown } | "silent") {
  const calls: string[] = [];
  const stub = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes("/unseal/")) {
      if (unseal === "silent") {
        throw new TypeError("fetch failed");
      }
      return new Response(JSON.stringify(unseal.body), {
        status: unseal.status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(SEALED), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", stub);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the held lookup", () => {
  it("hands back the record the service found", async () => {
    serving({ status: 200, body: RECORD });

    const lookup = await heldUnseal(PASSPORT);
    expect(lookup.state).toBe("unsealed");
    expect(lookup.state === "unsealed" ? lookup.record.image.cid : "").toBe("bafkreiimage");
  });

  it("says sealed when the service says there is no record", async () => {
    serving({ status: 404, body: { error: "not-unsealed", passportId: PASSPORT } });
    expect((await heldUnseal(PASSPORT)).state).toBe("sealed");
  });

  it("says it cannot tell when the service could not find out, and never throws", async () => {
    serving({ status: 503, body: { error: "lookup-unavailable" } });
    const lookup = await heldUnseal(PASSPORT);

    expect(lookup.state).toBe("unknown");
    expect(lookup.state === "unknown" ? lookup.reason : "").toContain("lookup-unavailable");
  });

  it("asks nobody about an id that is not a passport id", async () => {
    const calls = serving({ status: 200, body: RECORD });
    expect((await heldUnseal("0x12" as Hex)).state).toBe("unknown");
    expect(calls).toEqual([]);
  });
});

describe("what the screens read", () => {
  it("gives a sealed document the published picture once a record exists", async () => {
    serving({ status: 200, body: RECORD });

    const art = await heldArt(URI, PASSPORT);

    expect(art.sealed).toBeUndefined();
    expect(art.imageUrl).toContain("bafkreiimage");
    expect(art.thumbnailUrl).toContain("bafkreithumb");
    expect(art.missing).toBe(false);
    // The words the creator wrote at registration are still theirs.
    expect(art.title).toBe("Monsoon nets, Kovalam");
    expect(art.unsealed?.at).toBe("2026-09-22T06:12:44.000Z");
    expect(art.unsealed?.record.cid).toBe("bafkreirecord");
  });

  it("keeps the seal when there is no record", async () => {
    serving({ status: 404, body: { error: "not-unsealed", passportId: PASSPORT } });

    const art = await heldArt(URI, PASSPORT);
    expect(art.sealed).toBe(true);
    expect(art.imageUrl).toBeUndefined();
    expect(art.unsealed).toBeUndefined();
    expect(art.missing).toBe(false);
  });

  it("keeps the seal when the lookup could not answer, rather than guessing either way", async () => {
    serving("silent");

    const art = await heldArt(URI, PASSPORT);
    expect(art.sealed).toBe(true);
    expect(art.unsealed).toBeUndefined();
    // Not a broken gateway either: the document was read perfectly well.
    expect(art.missing).toBe(false);
  });

  it("finds the passport in the document's own commitment when the caller has no id", async () => {
    serving({ status: 200, body: RECORD });

    const art = await heldArt(URI);
    expect(art.imageUrl).toContain("bafkreiimage");
  });

  it("spends no lookup on a published passport", async () => {
    const calls = serving({ status: 200, body: RECORD });
    const published: Art = { title: "Kadal at dawn", imageUrl: "https://gateway.example/full.jpg", missing: false };

    expect(await withUnseal(published, PASSPORT)).toBe(published);
    expect(calls).toEqual([]);
  });

  it("refuses a record filed under another passport, so no picture is borrowed", async () => {
    serving({ status: 200, body: { ...RECORD, passportId: `0x${"11".repeat(32)}` } });

    const art = await heldArt(URI, PASSPORT);
    expect(art.sealed).toBe(true);
  });
});
