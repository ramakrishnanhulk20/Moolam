import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

/**
 * The download route, driven the way a browser drives it: one GET with a
 * passport id in the path. The registry and the unseal lookup are stubbed, and
 * every fetch lands on a stub that answers only for the gateway, so these tests
 * never leave the machine and every address the route asked for is on record.
 */

const reads = vi.hoisted(() => ({ getPassport: vi.fn(), heldUnseal: vi.fn() }));

vi.mock("@/lib/chain/registry", () => ({ getPassport: reads.getPassport }));
vi.mock("@/lib/data/unseal", () => ({ heldUnseal: reads.heldUnseal }));

const { GET } = await import("@/app/api/passports/[id]/picture/route");
const { forgetCallers } = await import("@/lib/api/limit");
const { downloadName, pinnedAddress } = await import("@/lib/passport/original");

const GATEWAY = new URL(pinnedAddress("bafkreianything"));

/** A small JPEG-shaped file: the three bytes every JPEG opens with, then noise. */
const PICTURE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 4_000 }, (_, at) => (at * 31) % 251)]);
const ID = `0x${createHash("sha256").update(PICTURE).digest("hex")}` as Hex;
const SHORT = ID.slice(2, 10);

const DOCUMENT_CID = "bafkreidocument";
const PICTURE_CID = "bafkreipicture";
const UNSEALED_CID = "bafkreiunsealed";

/** Every address the route asked for, across the whole file. */
const asked: string[] = [];
/** What the gateway holds, by content id. */
let pinned: Record<string, { body: Uint8Array | string; length?: number }> = {};

function passport(metadataURI = `ipfs://${DOCUMENT_CID}`) {
  return { id: ID, metadataURI, registeredAt: 1_788_876_082n };
}

function hold(document: unknown) {
  pinned[DOCUMENT_CID] = { body: JSON.stringify(document) };
}

beforeEach(() => {
  forgetCallers();
  pinned = { [PICTURE_CID]: { body: PICTURE }, [UNSEALED_CID]: { body: PICTURE } };
  reads.getPassport.mockReset().mockResolvedValue(passport());
  reads.heldUnseal.mockReset().mockResolvedValue({ state: "sealed" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const address = new URL(input instanceof Request ? input.url : String(input));
      asked.push(address.href);
      if (address.origin !== GATEWAY.origin) {
        throw new Error(`the route asked a host that is not the gateway: ${address.origin}`);
      }
      const cid = address.pathname.split("/").pop() ?? "";
      const file = pinned[cid];
      if (file === undefined) {
        return new Response("not pinned", { status: 404 });
      }
      const body = typeof file.body === "string" ? new TextEncoder().encode(file.body) : file.body;
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(file.length ?? body.byteLength), "content-type": "application/octet-stream" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function download(id: string = ID): Promise<Response> {
  return await GET(new Request(`http://localhost/api/passports/${id}/picture`), { params: Promise.resolve({ id }) });
}

async function sha256(response: Response): Promise<string> {
  return `0x${createHash("sha256")
    .update(new Uint8Array(await response.arrayBuffer()))
    .digest("hex")}`;
}

describe("the download of a public passport", () => {
  it("serves the exact bytes as an attachment, named after the title", async () => {
    hold({ name: "Harbour at first light", image: `ipfs://${PICTURE_CID}`, thumbnail: "ipfs://bafkreithumb" });

    const response = await download();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="harbour-at-first-light-${SHORT}.jpg"`,
    );
    expect(response.headers.get("content-length")).toBe(String(PICTURE.byteLength));
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    // The file a creator saves hashes to the passport id, byte for byte.
    expect(await sha256(response)).toBe(ID);
  });

  it("reads the passport from the registry, not the index, so a picture from seconds ago works", async () => {
    hold({ name: "Just now", image: `ipfs://${PICTURE_CID}` });
    await (await download()).arrayBuffer();
    expect(reads.getPassport).toHaveBeenCalledWith(ID);
  });

  it("names a file with no title after Moolam and the id, and keeps any title to plain safe letters", async () => {
    hold({ image: `ipfs://${PICTURE_CID}` });
    const untitled = await download();
    expect(untitled.headers.get("content-disposition")).toBe(`attachment; filename="moolam-${SHORT}.jpg"`);
    await untitled.arrayBuffer();

    hold({ name: 'Été "à" ../../etc/passwd\r\nx', image: `ipfs://${PICTURE_CID}` });
    const hostile = await download();
    expect(hostile.headers.get("content-disposition")).toBe(`attachment; filename="ete-a-etc-passwd-x-${SHORT}.jpg"`);
    await hostile.arrayBuffer();

    expect(downloadName("கடல் அலை", ID, "png")).toBe(`moolam-${SHORT}.png`);
    expect(downloadName("x".repeat(200), ID, "webp")).toBe(`${"x".repeat(60)}-${SHORT}.webp`);
  });

  it("takes the extension from the file's own first bytes, not the gateway's word", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
    pinned[PICTURE_CID] = { body: png };
    hold({ name: "Chart", image: `ipfs://${PICTURE_CID}` });

    const response = await download();
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="chart-${SHORT}.png"`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  });

  it("serves an unsealed passport's picture from the holder's record", async () => {
    hold({ name: "Monsoon nets", sealed: true, commitment: { algorithm: "sha-256", value: ID } });
    reads.heldUnseal.mockResolvedValue({
      state: "unsealed",
      record: { image: { cid: UNSEALED_CID, uri: `ipfs://${UNSEALED_CID}`, gatewayUrl: "https://elsewhere.example/x" } },
    });

    const response = await download();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="monsoon-nets-${SHORT}.jpg"`);
    expect(await sha256(response)).toBe(ID);
    expect(asked.at(-1)).toBe(pinnedAddress(UNSEALED_CID));
  });
});

describe("what the route refuses", () => {
  it("answers 404 for a sealed passport and never asks the gateway for a picture", async () => {
    hold({ name: "Kept back", sealed: true });
    const before = asked.length;

    const response = await download();
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("This passport is sealed");
    expect(asked.slice(before)).toEqual([pinnedAddress(DOCUMENT_CID)]);
  });

  it("answers 503 rather than a verdict when it cannot tell whether a sealed passport was published", async () => {
    hold({ sealed: true });
    reads.heldUnseal.mockResolvedValue({ state: "unknown", reason: "the verify service did not answer" });
    expect((await download()).status).toBe(503);
  });

  it("answers 404 for an id the registry has never seen, and asks the gateway nothing", async () => {
    reads.getPassport.mockResolvedValue(null);
    const before = asked.length;

    const response = await download();
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("No passport has this id");
    expect(asked.length).toBe(before);
  });

  it("answers 404 for an address that is not a passport id, before reading anything", async () => {
    const response = await download("0x1234");
    expect(response.status).toBe(404);
    expect(reads.getPassport).not.toHaveBeenCalled();
  });

  it("answers 404 when the picture is not a bare content id, and never fetches what the document named", async () => {
    const before = asked.length;
    for (const image of [
      "https://evil.example/picture.jpg",
      `https://${GATEWAY.hostname}/ipfs/${PICTURE_CID}`,
      `ipfs://${PICTURE_CID}/picture.jpg`,
      `ipfs://${PICTURE_CID}?x=1`,
      "a sentence where a picture belongs",
    ]) {
      hold({ name: "Pointed elsewhere", image });
      const response = await download();
      expect(response.status, image).toBe(404);
      expect(await response.text()).toContain("not a pinned IPFS content id");
    }
    // Only the document was ever read, once per try.
    expect(new Set(asked.slice(before))).toEqual(new Set([pinnedAddress(DOCUMENT_CID)]));
  });

  it("answers 404 when an unseal record names a picture that is not a bare content id", async () => {
    hold({ sealed: true });
    reads.heldUnseal.mockResolvedValue({
      state: "unsealed",
      record: { image: { cid: "x", uri: "https://evil.example/x.jpg", gatewayUrl: "https://evil.example/x.jpg" } },
    });
    expect((await download()).status).toBe(404);
  });

  it("does not read a metadata document the chain names by an ordinary web address", async () => {
    reads.getPassport.mockResolvedValue(passport("https://evil.example/document.json"));
    const before = asked.length;
    expect((await download()).status).toBe(404);
    expect(asked.length).toBe(before);
  });

  it("answers 404 for a document that names no picture at all", async () => {
    hold({ name: "Words only" });
    expect((await download()).status).toBe(404);
  });

  it("refuses a metadata document over the cap without parsing it", async () => {
    pinned[DOCUMENT_CID] = { body: JSON.stringify({ image: `ipfs://${PICTURE_CID}`, pad: "x".repeat(70_000) }) };
    expect((await download()).status).toBe(502);
  });

  it("refuses a picture the gateway declares larger than any upload", async () => {
    hold({ image: `ipfs://${PICTURE_CID}` });
    pinned[PICTURE_CID] = { body: PICTURE, length: 21 * 1024 * 1024 };
    expect((await download()).status).toBe(502);
  });

  it("refuses a pinned file that is not a JPEG, PNG or WebP", async () => {
    hold({ image: `ipfs://${PICTURE_CID}` });
    pinned[PICTURE_CID] = { body: "<html><script>alert(1)</script></html>" };
    const response = await download();
    expect(response.status).toBe(502);
    expect(response.headers.get("content-disposition")).toBeNull();
  });
});

describe("where the route reaches", () => {
  it("never asked any host but the configured gateway, in every test above", () => {
    expect(asked.length).toBeGreaterThan(0);
    for (const address of asked) {
      expect(new URL(address).origin).toBe(GATEWAY.origin);
    }
  });

  it("takes no content id from the caller: a query naming one is ignored", async () => {
    hold({ name: "Harbour", image: `ipfs://${PICTURE_CID}` });
    const before = asked.length;
    const response = await GET(new Request(`http://localhost/api/passports/${ID}/picture?cid=bafkreiother&url=https://evil.example`), {
      params: Promise.resolve({ id: ID }),
    });
    expect(await sha256(response)).toBe(ID);
    expect(asked.slice(before)).toEqual([pinnedAddress(DOCUMENT_CID), pinnedAddress(PICTURE_CID)]);
  });
});
