// Covers pictureStateOf, the one reader of whether a passport's picture is public, sealed, or sealed
// and later published by its holder, and unsealRecordFor, the live finder it is handed in
// production. The document reader and the finder are plain stubs, and the live finder is fed a
// fake Pinata listing and a fake gateway, so nothing leaves the process.
// Does NOT cover the caching and the timeout the verify answer puts around this reader, which are
// test/passportFacts.test.ts, nor the re-check route that refuses on it, which is
// test/recheck-routes.test.ts, nor a real Pinata or gateway.

import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

vi.hoisted(() => {
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
});

const { pictureStateOf, unsealRecord, unsealRecordFor, unsealRecordName } = await import("../src/unseal.js");

const PASSPORT = `0x${"5c".repeat(32)}` as Hex;
const OTHER = `0x${"6d".repeat(32)}` as Hex;
const HOLDER = "0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6" as Hex;
const UNSEALED_AT = new Date("2026-09-22T12:27:28.000Z");
const passport = { id: PASSPORT, metadataURI: "ipfs://bafydocument" };

const record = unsealRecord({
  passportId: PASSPORT,
  image: "ipfs://bafyimage",
  thumbnail: "ipfs://bafythumb",
  unsealedBy: HOLDER,
  unsealedAt: UNSEALED_AT,
});

const sealedDocument = async (): Promise<unknown> => ({ name: "a sealed picture", sealed: true });
const publicDocument = async (): Promise<unknown> => ({ name: "a picture", image: "ipfs://bafyimage" });
const noRecord = async (): Promise<undefined> => undefined;

describe("pictureStateOf", () => {
  it("answers public for a public document without asking for a record", async () => {
    const finder = vi.fn(noRecord);
    expect(await pictureStateOf(passport, publicDocument, finder)).toEqual({ state: "public" });
    expect(finder).not.toHaveBeenCalled();
  });

  it("answers sealed for a sealed document with no record behind it", async () => {
    expect(await pictureStateOf(passport, sealedDocument, noRecord)).toEqual({ state: "sealed" });
  });

  it("answers unsealed, with the record's own time, when the holder published the picture later", async () => {
    const finder = vi.fn(async () => record);
    expect(await pictureStateOf(passport, sealedDocument, finder)).toEqual({
      state: "unsealed",
      at: "2026-09-22T12:27:28.000Z",
    });
    expect(finder).toHaveBeenCalledWith(PASSPORT);
  });

  it("answers unreadable, never sealed or public, when the document cannot be read or says neither", async () => {
    const down = async (): Promise<unknown> => {
      throw new Error("the gateway answered 504");
    };
    expect(await pictureStateOf(passport, down, noRecord)).toEqual({ state: "unreadable" });
    expect(await pictureStateOf(passport, async () => ({ sealed: "yes" }), noRecord)).toEqual({ state: "unreadable" });
    expect(await pictureStateOf(passport, async () => null, noRecord)).toEqual({ state: "unreadable" });
  });

  it("answers unreadable when the record lookup errors, rather than calling the picture sealed", async () => {
    const lookupDown = async (): Promise<undefined> => {
      throw new Error("Pinata answered 500 to the record lookup");
    };
    expect(await pictureStateOf(passport, sealedDocument, lookupDown)).toEqual({ state: "unreadable" });
  });

  it("believes a record only when it fits the published shape and names this passport", async () => {
    const aboutAnother = { ...record, passportId: OTHER };
    const malformed = { ...record, unsealedAt: "yesterday" };
    const padded = { ...record, creatorEmail: "someone@example.com" };
    for (const [label, wrong] of [
      ["another passport", aboutAnother],
      ["a time that is not a time", malformed],
      ["an extra field", padded],
    ] as const) {
      const answer = await pictureStateOf(passport, sealedDocument, async () => wrong as typeof record);
      expect(answer, label).toEqual({ state: "unreadable" });
    }
  });
});

describe("unsealRecordFor, the live finder", () => {
  const name = unsealRecordName(PASSPORT);

  function listing(files: unknown[]): typeof fetch {
    return (async () =>
      new Response(JSON.stringify({ data: { files } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  }

  /** safeFetch with the name resolution and the socket replaced, so no packet leaves the box. */
  const gateway = {
    resolve: async () => ["93.184.216.34"],
    transport: (async () =>
      new Response(JSON.stringify(record), { status: 200, headers: { "content-type": "application/json" } })) as never,
  };

  it("hands back undefined when nothing is pinned under the passport's record name", async () => {
    expect(await unsealRecordFor(PASSPORT, { lookup: { fetchImpl: listing([]) } })).toBeUndefined();
  });

  it("reads the record back when one is listed", async () => {
    const found = await unsealRecordFor(PASSPORT, {
      lookup: { fetchImpl: listing([{ cid: "bafyrecord", name, created_at: "2026-09-22T12:27:30Z" }]) },
      read: gateway,
    });
    expect(found).toEqual(record);
  });

  it("throws when the lookup cannot answer, so the caller reads it as unreadable", async () => {
    const refused = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await expect(unsealRecordFor(PASSPORT, { lookup: { fetchImpl: refused } })).rejects.toThrow(/could not answer/);
  });
});
