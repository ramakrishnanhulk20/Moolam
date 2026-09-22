import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";

/**
 * The link preview for a sealed passport, drawn by the real route.
 *
 * A card is the one part of this product that travels without the app around
 * it, so it is the easiest place for a sealed record to be mistaken for a
 * broken one. What is checked here is that the route still answers with a
 * 1200 by 630 JPEG when there is no picture to draw, and that it asks no
 * gateway for one.
 */

const ID = `0x${"7c".repeat(32)}` as Hex;
const BLOCKHASH = "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0" as Hex;

const art = vi.hoisted(() => ({
  current: {
    title: "Monsoon nets, Kovalam",
    sealed: true as const,
    commitment: { algorithm: "sha-256", value: `0x${"7c".repeat(32)}` },
    blockhash: "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0",
    missing: false,
  } as Record<string, unknown>,
}));

const gateway = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("@/components/passport/art", async () => {
  const real = await vi.importActual<typeof import("@/components/passport/art")>("@/components/passport/art");
  return { ...real, readArt: async () => art.current };
});

vi.mock("@/lib/chain/registry", () => ({
  getPassport: async () => ({
    id: ID,
    exactHash: ID,
    parentId: `0x${"00".repeat(32)}`,
    creator: `0x${"11".repeat(20)}`,
    generatorAgentId: 0n,
    phash: 0x6ccf137087789a25n,
    blockhash256: BLOCKHASH,
    manifestHash: `0x${"22".repeat(32)}`,
    kind: 1,
    fingerprintVersion: 1,
    registeredAt: 1_788_876_082n,
    disputed: false,
    metadataURI: "ipfs://bafkreisealedmetadata",
  }),
}));

vi.mock("@/lib/data/passports", () => ({ passportRegistration: async () => null }));

// The faces and any picture are fetched over the network. Nothing here is
// allowed out: the card falls back to the renderer's own face, and a request
// for a picture would be the bug this test is looking for.
vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
  gateway.calls.push(String(input));
  throw new Error("no network in this test");
});

const { default: PassportCard } = await import("@/app/[locale]/passport/[id]/opengraph-image");

/** The width and height a JPEG writes in its start-of-frame marker. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  for (let at = 2; at + 9 < bytes.length; ) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1];
    const length = (bytes[at + 2] << 8) + bytes[at + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[at + 5] << 8) + bytes[at + 6], width: (bytes[at + 7] << 8) + bytes[at + 8] };
    }
    at += 2 + length;
  }
  return null;
}

describe("the share card for a sealed passport", () => {
  it("is a 1200 by 630 JPEG, drawn with no picture and no gateway read", async () => {
    gateway.calls.length = 0;

    const answer = await PassportCard({ params: Promise.resolve({ locale: "en", id: ID }) });
    const bytes = new Uint8Array(await answer.arrayBuffer());

    expect(answer.headers.get("content-type")).toBe("image/jpeg");
    expect(bytes.byteLength).toBeGreaterThan(5_000);
    expect(jpegSize(bytes)).toEqual({ width: 1200, height: 630 });
    // Small enough that every chat app fetches it: a card over about 300 KB
    // arrives as a bare link in several of them.
    expect(bytes.byteLength).toBeLessThan(300_000);

    // The renderer loads its own wasm through a data URL, and the two font
    // requests are the card's own. Anything else would be a read of a picture
    // that was never published.
    const gatewayReads = gateway.calls.filter(
      (url) => !url.includes("fonts.googleapis.com") && !url.startsWith("data:"),
    );
    expect(gatewayReads).toEqual([]);

    // Run with SEALED_CARD=1 to put the drawn card where a person can look at it.
    if (process.env.SEALED_CARD === "1") {
      writeFileSync(fileURLToPath(new URL("../../../kitchen/reports/WO-117-card.jpg", import.meta.url)), bytes);
    }
  }, 60_000);
});
