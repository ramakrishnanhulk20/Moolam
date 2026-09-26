// Covers who the verify answer names when several passports carry one fingerprint: the earliest
// registration ranks first on a tie, copies of one fingerprint are folded into one row before any
// cap, and the answer counts the later copies. Also pins what a real registered picture answered
// before this ordering existed, and that the Envio source carries the block each passport landed in.
// Also covers near-copies a bit or two closer to the query than the original: the first registration
// stays in the answer whatever the cap, on the perceptual path and on the exact path.
// Does NOT cover two registrations in one block, which fall back to the passport id because the
// index carries no log index, nor an earlier registration that only matches a rotated copy of an
// exact hit, which the exact path does not look for.

import { createServer, type Server } from "node:http";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprint } from "../src/fingerprint.js";
import { HammingIndex } from "../src/index.js";
import { matchImage } from "../src/match.js";
import { renderResult } from "../src/routes/shared.js";
import { buildServer } from "../src/server.js";
import { EnvioSource } from "../src/source/EnvioSource.js";
import type { Hex, PassportRecord } from "../src/types.js";
import { blockhashWithBits, idFrom, makeImage, multipartBody, recordFor } from "./helpers.js";

const LIMITS = { phashMax: 10, blockhashMax: 40 };

type Ordered = PassportRecord & { registeredBlock?: number };

function copyOf(original: PassportRecord, byte: number, extra: Partial<Ordered> = {}): Ordered {
  return { ...original, id: idFrom(byte), creator: "0x3333333333333333333333333333333333333333", ...extra };
}

function lookupOf(records: PassportRecord[]): (sha256: Hex) => PassportRecord | undefined {
  const byId = new Map(records.map((record) => [record.id, record]));
  return (sha256) => byId.get(sha256);
}

describe("first registration wins", () => {
  it("keeps the first passport at the top when twenty later ones copy its fingerprint", async () => {
    const picture = await makeImage(22);
    // The victim's id sorts last on purpose: the old tie order was the index's id order.
    const victim: Ordered = { ...recordFor(await fingerprint(picture)), id: idFrom(0xfe), registeredAt: 100, registeredBlock: 10 };
    const copies = Array.from({ length: 20 }, (_, i) => copyOf(victim, i + 1, { registeredAt: 200 + i, registeredBlock: 20 + i }));
    // Envio hands the rows back in id order, so the copies arrive ahead of the victim.
    const records = [...copies, victim];
    const reencoded = await sharp(picture).resize(320).jpeg({ quality: 60 }).toBuffer();

    const result = await matchImage(reencoded, new HammingIndex(records), lookupOf(records));

    expect(result.best?.id).toBe(victim.id);
    expect(result.matches.map((match) => match.id)).toEqual([victim.id]);
    expect(result.laterSameFingerprint).toBe(20);
  });

  it("ranks the earlier block first on a tie even when its timestamp and id say otherwise", () => {
    const first: Ordered = {
      id: idFrom(0xee),
      phash: 0n,
      blockhash: blockhashWithBits(0),
      creator: "0x2222222222222222222222222222222222222222",
      parentId: null,
      registeredAt: 500,
      registeredBlock: 7,
      metadataURI: "ipfs://x",
    };
    const later: Ordered = { ...first, id: idFrom(0x01), registeredBlock: 8 };
    const index = new HammingIndex([later, first]);

    const hits = index.query(0n, blockhashWithBits(0), LIMITS);

    expect(hits.map((hit) => hit.id)).toEqual([first.id]);
    expect(index.laterSameFingerprint(first.id)).toBe(1);
    expect(index.laterSameFingerprint(later.id)).toBe(0);
    expect(index.size).toBe(2);
  });

  it("gives the same order whatever order the records were loaded in", () => {
    const base = (byte: number, phash: bigint, at: number): Ordered => ({
      id: idFrom(byte),
      phash,
      blockhash: blockhashWithBits(0),
      creator: "0x2222222222222222222222222222222222222222",
      parentId: null,
      registeredAt: at,
      metadataURI: "ipfs://x",
    });
    // Two at one distance registered at different times, two at another distance in one second.
    const records = [base(9, 0b1n, 300), base(4, 0b10n, 100), base(7, 0b11n, 50), base(2, 0b101n, 50)];
    const expected = [idFrom(4), idFrom(9), idFrom(2), idFrom(7)];

    for (const order of [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1]]) {
      const index = new HammingIndex(order.map((i) => records[i] as Ordered));
      expect(index.query(0n, blockhashWithBits(0), LIMITS).map((hit) => hit.id)).toEqual(expected);
    }
  });

  it("promotes the next copy when the first is removed, and forgets a copy that is replaced", () => {
    const shared = { phash: 0n, blockhash: blockhashWithBits(0), creator: "0x2222222222222222222222222222222222222222" as Hex, parentId: null, metadataURI: "ipfs://x" };
    const a: Ordered = { ...shared, id: idFrom(1), registeredAt: 10 };
    const b: Ordered = { ...shared, id: idFrom(2), registeredAt: 20 };
    const c: Ordered = { ...shared, id: idFrom(3), registeredAt: 30 };
    const index = new HammingIndex([c, a, b]);

    index.remove(a.id);
    expect(index.query(0n, blockhashWithBits(0), LIMITS).map((hit) => hit.id)).toEqual([b.id]);
    expect(index.laterSameFingerprint(b.id)).toBe(1);

    index.add({ ...b, phash: 0b1n });
    expect(index.query(0n, blockhashWithBits(0), LIMITS).map((hit) => hit.id)).toEqual([c.id, b.id]);
    expect(index.laterSameFingerprint(c.id)).toBe(0);
    expect(index.size).toBe(2);
  });
});

describe("the first registration against closer near-copies", () => {
  it("keeps the original in the answer when thirty later near-copies sit a bit or two closer", async () => {
    const picture = await makeImage(22);
    const print = await fingerprint(picture);
    // Three bits from the query, registered first.
    const original: Ordered = { ...recordFor(print), id: idFrom(0xfe), phash: print.phash ^ 0b111n, registeredAt: 100, registeredBlock: 10 };
    // One or two bits from the query, every one a distinct fingerprint, all registered later.
    const copies = Array.from({ length: 30 }, (_, i) => {
      const flip = i % 2 === 0 ? 1n << BigInt(8 + i) : (1n << BigInt(8 + i)) | (1n << 50n);
      return copyOf(original, i + 1, { phash: print.phash ^ flip, registeredAt: 200 + i, registeredBlock: 20 + i });
    });
    const records = [...copies, original];

    const result = await matchImage(picture, new HammingIndex(records), lookupOf(records));

    expect(result.exact).toBeNull();
    expect(result.best?.phashDistance).toBe(1);
    expect(result.matches).toHaveLength(20);
    expect(result.matches.filter((match) => match.firstRegistered === true).map((match) => match.id)).toEqual([original.id]);
    expect(result.firstRegisteredId).toBe(original.id);
    expect((renderResult(result) as { firstRegisteredId?: Hex }).firstRegisteredId).toBe(original.id);
  });

  it("surfaces an earlier registration on the exact path", async () => {
    const picture = await makeImage(22);
    const print = await fingerprint(picture);
    const exact: Ordered = { ...recordFor(print), registeredAt: 300, registeredBlock: 30 };
    const earlier: Ordered = { ...recordFor(print), id: idFrom(0xab), phash: print.phash ^ 0b11n, registeredAt: 100, registeredBlock: 10 };
    const records = [exact, earlier];

    const result = await matchImage(picture, new HammingIndex(records), lookupOf(records));

    expect(result.exact).toBe(exact.id);
    expect(result.best?.id).toBe(exact.id);
    expect(result.confidence).toBe(1);
    expect(result.matches.map((match) => [match.id, match.firstRegistered])).toEqual([
      [exact.id, undefined],
      [earlier.id, true],
    ]);
    expect(result.firstRegisteredId).toBe(earlier.id);
  });

  it("leaves an answer that names one passport exactly as it was", async () => {
    const picture = await makeImage(22);
    const record = recordFor(await fingerprint(picture));
    const index = new HammingIndex([record]);
    const lookup = lookupOf([record]);
    const reencoded = await sharp(picture).resize(320).jpeg({ quality: 60 }).toBuffer();

    for (const bytes of [picture, reencoded]) {
      const result = await matchImage(bytes, index, lookup);
      expect(Object.keys(result).sort()).toEqual(["best", "confidence", "exact", "laterSameFingerprint", "matches", "queried"]);
      expect(result.matches).toHaveLength(1);
      expect(Object.keys(result.matches[0] as object).sort()).toEqual(["blockhashDistance", "id", "phashDistance", "score", "variant"]);
      expect(result.best).toEqual(result.matches[0]);
    }
  });
});

describe("the verify answer", () => {
  it("still names the same passport at the same distance for a re-encoded registered picture", async () => {
    // Measured on the code before this change: seed 22, resized to 320 wide at JPEG quality 60,
    // lands 1 bit away in pHash and 26 bits away in blockhash from its own passport.
    const pictures = await Promise.all([61, 21, 22].map((seed) => makeImage(seed)));
    const records = await Promise.all(pictures.map(async (bytes) => recordFor(await fingerprint(bytes))));
    const app = await buildServer({ source: { load: async () => records }, logger: false });
    try {
      const copy = await sharp(pictures[2] as Buffer).resize(320).jpeg({ quality: 60 }).toBuffer();
      const { payload, headers } = multipartBody("file", "copy.jpg", "image/jpeg", copy);
      const response = await app.inject({ method: "POST", url: "/verify", payload, headers });

      expect(response.statusCode).toBe(200);
      const result = response.json().result;
      expect(result.best.id).toBe(records[2]?.id);
      expect(result.best.phashDistance).toBe(1);
      expect(result.best.blockhashDistance).toBe(26);
      expect(result.matches).toHaveLength(1);
      expect(result.laterSameFingerprint).toBe(0);
    } finally {
      await app.close();
    }
  });
});

describe("EnvioSource registration order", () => {
  let running: Server | undefined;

  afterEach(async () => {
    if (running !== undefined) {
      await new Promise<void>((resolve) => running?.close(() => resolve()));
      running = undefined;
    }
  });

  it("asks for the block each passport landed in and carries it onto the record", async () => {
    let asked = "";
    const row = {
      id: "0x0da1a9806d60cedcd3773474cba419c8fa03721a67d348a38c4d32dbaa35530a",
      phash: "13213741746338316348",
      blockhash: "0xfc04fc0eb80e07eec7e4c7c0c7e187e0ffe0ffc0f800f003fb07f807f007f007",
      creator: { id: "0x559f357ada3a96d11aea679ec0d622e4af15f67c" },
      parent: null,
      registeredAt: "1788855152",
      registeredBlock: "103060001",
      metadataURI: "ipfs://x",
    };
    const server = createServer((request, reply) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        asked = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { query: string }).query;
        reply.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { Passport: [row] } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    running = server;
    const address = server.address() as { port: number };

    const records = await new EnvioSource({ url: `http://127.0.0.1:${address.port}/v1/graphql` }).load();

    expect(asked.replace(/\s+/g, " ")).toContain("registeredAt registeredBlock");
    expect((records[0] as Ordered).registeredBlock).toBe(103_060_001);
  });
});
