// Covers the Envio-backed passport source: paging, typed records, the re-check fields the query
// asks for, and every way a bad answer is rejected. The rows come from src/source/fixtures, which
// is a recorded response holding the two passports Moolam registered on Monad mainnet, read back
// from the registry with cast. That recording predates the re-check fields, so it is also this
// file's case for a row that does not carry them; the row that does is recorded from the hosted
// index, quoted in the test that uses it.
// Does NOT cover the live Envio Cloud endpoint, and does not cover Hasura's own query planning:
// the mock applies the cursor and the limit itself, so it proves our paging, not theirs. What the
// re-check fields turn into on a verify answer is test/recheck.test.ts.

import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../src/env.js";
import { EnvioSource } from "../src/source/EnvioSource.js";

interface FixtureRow {
  id: string;
  phash: string;
  blockhash: string;
  creator: { id: string };
  parent: { id: string } | null;
  registeredAt: string;
  metadataURI: string;
}

const fixture = JSON.parse(
  readFileSync(path.join(PACKAGE_ROOT, "src", "source", "fixtures", "envio-passports.json"), "utf8"),
) as { data: { Passport: FixtureRow[] } };

let running: Server | undefined;

/** Serves one JSON answer per request, replayed in order, and hands back its URL. */
async function serve(
  handler: (body: { query: string; variables: { limit: number; after: string } }) => unknown,
): Promise<string> {
  const server = createServer((request, reply) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        query: string;
        variables: { limit: number; after: string };
      };
      const answer = handler(body);
      const payload = JSON.stringify(answer);
      reply.writeHead(200, { "content-type": "application/json" }).end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running = server;
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the mock server did not bind a port");
  }
  return `http://127.0.0.1:${address.port}/v1/graphql`;
}

/** The mock index: applies the cursor and the limit the way Hasura would. */
function pageOf(variables: { limit: number; after: string }): unknown {
  const rows = fixture.data.Passport.filter((row) => row.id > variables.after)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .slice(0, variables.limit);
  return { data: { Passport: rows } };
}

afterEach(async () => {
  if (running !== undefined) {
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = undefined;
  }
});

describe("EnvioSource", () => {
  it("loads the recorded passports as typed records", async () => {
    const url = await serve(({ variables }) => pageOf(variables));
    const records = await new EnvioSource({ url }).load();

    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      id: "0x0da1a9806d60cedcd3773474cba419c8fa03721a67d348a38c4d32dbaa35530a",
      phash: 13_213_741_746_338_316_348n,
      blockhash: "0xfc04fc0eb80e07eec7e4c7c0c7e187e0ffe0ffc0f800f003fb07f807f007f007",
      creator: "0x559f357ada3a96d11aea679ec0d622e4af15f67c",
      parentId: null,
      registeredAt: 1_788_855_152,
      metadataURI: "ipfs://bafkreihcqcy7esv4kx4t7yei2sdkxu5o4tqctc6sgztti7i5oinf3wyxai",
    });
    expect(records[1]?.phash).toBe(8_422_098_126_035_829_067n);
  });

  it("pages with the id cursor until a short page", async () => {
    const seen: string[] = [];
    const url = await serve(({ variables }) => {
      seen.push(variables.after);
      return pageOf(variables);
    });

    const records = await new EnvioSource({ url, pageSize: 1 }).load();

    expect(records.map((record) => record.id)).toEqual(fixture.data.Passport.map((row) => row.id));
    expect(seen).toEqual([
      "",
      "0x0da1a9806d60cedcd3773474cba419c8fa03721a67d348a38c4d32dbaa35530a",
      "0x59bdee9f4478fcb4bab722ca2224bac05350ed3d1d0397a81c998a2b0ad24440",
    ]);
  });

  it("refuses a page that does not move the cursor forward", async () => {
    const url = await serve(() => ({ data: { Passport: [fixture.data.Passport[0]] } }));
    await expect(new EnvioSource({ url, pageSize: 1 }).load()).rejects.toThrow(/did not advance past/);
  });

  it("reports GraphQL errors instead of indexing nothing", async () => {
    const url = await serve(() => ({ errors: [{ message: "field \"Passport\" not found" }] }));
    await expect(new EnvioSource({ url }).load()).rejects.toThrow(/GraphQL errors: field "Passport" not found/);
  });

  it("rejects a pHash that arrived as a rounded JSON number", async () => {
    const url = await serve(() => ({
      data: { Passport: [{ ...fixture.data.Passport[0], phash: 13_213_741_746_338_316_348 }] },
    }));
    await expect(new EnvioSource({ url }).load()).rejects.toThrow(/too large to be exact/);
  });

  it("rejects a blockhash that is not 32 bytes", async () => {
    const url = await serve(() => ({
      data: { Passport: [{ ...fixture.data.Passport[0], blockhash: "0xdeadbeef" }] },
    }));
    await expect(new EnvioSource({ url }).load()).rejects.toThrow(/blockhash/);
  });

  it("refuses a page size below one", () => {
    expect(() => new EnvioSource({ url: "http://127.0.0.1:1/v1/graphql", pageSize: 0 })).toThrow(/pageSize/);
  });

  it("asks each passport for its re-check counts and its newest verdict, one nested row", async () => {
    let asked = "";
    const url = await serve((body) => {
      asked = body.query;
      return pageOf(body.variables);
    });

    await new EnvioSource({ url }).load();

    const compact = asked.replace(/\s+/g, " ");
    expect(compact).toContain("attestationCount matchedCount mismatchedCount");
    expect(compact).toContain("attestations(order_by: { at: desc }, limit: 1) { receiver matched distance at }");
  });

  it("carries the re-check fields onto the record", async () => {
    // The hosted index's own answer for passport 0xcdb25d37...d771638, read with curl on
    // 21 September 2026: an Int arrives as a JSON number and a BigInt as a decimal string.
    const row = {
      ...fixture.data.Passport[0],
      attestationCount: 1,
      matchedCount: 1,
      mismatchedCount: 0,
      attestations: [
        { receiver: "0x0d69055c43eacb3b1ca687ca2263a049bc7eff04", matched: true, distance: 0, at: "1789368639" },
      ],
    };
    const url = await serve(() => ({ data: { Passport: [row] } }));

    const records = await new EnvioSource({ url }).load();

    expect(records[0]?.rechecks).toEqual({
      attestations: 1,
      matched: 1,
      mismatched: 0,
      latest: {
        receiver: "0x0d69055c43eacb3b1ca687ca2263a049bc7eff04",
        matched: true,
        distance: 0,
        at: 1_789_368_639,
      },
    });
  });

  it("leaves the re-check data off a row that does not carry the fields", async () => {
    const url = await serve(({ variables }) => pageOf(variables));

    const records = await new EnvioSource({ url }).load();

    expect(records).toHaveLength(2);
    expect(records[0]?.rechecks).toBeUndefined();
  });

  it("still loads the passport when a re-check field is malformed", async () => {
    // A picture nobody can match is a far worse answer than a picture with no second opinion, so
    // this is the one kind of bad field in the answer that does not throw.
    const url = await serve(() => ({
      data: {
        Passport: [
          { ...fixture.data.Passport[0], attestationCount: "one", matchedCount: 1, mismatchedCount: 0, attestations: [] },
        ],
      },
    }));

    const records = await new EnvioSource({ url }).load();

    expect(records).toHaveLength(1);
    expect(records[0]?.rechecks).toBeUndefined();
  });
});
