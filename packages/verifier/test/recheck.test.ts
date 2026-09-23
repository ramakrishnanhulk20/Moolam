// Covers the re-check fact a verify answer carries: what the index served turned into the fact,
// every way a missing or bad value makes it unavailable, and both verify routes carrying it after
// the dispute status. The numbers in the "real row" case are the hosted index's own answer for
// passport 0xcdb25d37...d771638, read with curl on 21 September 2026.
// Does NOT cover the wire query or the paging, which are envioSource.test.ts, does not cover the
// chain reads for consent and dispute, which are consentRead.test.ts and disputeRead.test.ts, and
// does not talk to a live index or a chain.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { offlineConsentReader } from "../src/consentRead.js";
import { offlineDisputeReader, withPassportFacts } from "../src/disputeRead.js";
import { fingerprint } from "../src/fingerprint.js";
import { recheckFor, rechecksFrom } from "../src/recheck.js";
import { verifyPaidRoutes } from "../src/routes/verifyPaid.js";
import { buildServer } from "../src/server.js";
import { offlinePictureReader } from "../src/unseal.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import type { Hex, PassportRechecks, PassportRecord } from "../src/types.js";
import { makeImage, multipartBody, recordFor } from "./helpers.js";

const RECEIVER = "0x0d69055c43eacb3b1ca687ca2263a049bc7eff04" as Hex;
const CHECKSUMMED_RECEIVER = "0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04";

/** The re-check fields of the live index's answer for passport 0xcdb25d37...d771638. */
const RECORDED_ROW = {
  attestationCount: 1,
  matchedCount: 1,
  mismatchedCount: 0,
  attestations: [{ receiver: RECEIVER, matched: true, distance: 0, at: "1789368639" }],
};

function sourceOf(records: PassportRecord[]): PassportSource {
  return { load: async () => records };
}

/** The recorded row with one field of its newest attestation replaced. */
function rowWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...RECORDED_ROW, attestations: [{ ...RECORDED_ROW.attestations[0], ...overrides }] };
}

function rechecks(overrides: Partial<PassportRechecks> = {}): PassportRechecks {
  return {
    attestations: 2,
    matched: 2,
    mismatched: 0,
    latest: { receiver: RECEIVER, matched: true, distance: 1, at: 1_789_700_000 },
    ...overrides,
  };
}

/** A record for a picture nobody would upload, for the cases that never reach the matcher. */
function bareRecord(overrides: Partial<PassportRecord> = {}): PassportRecord {
  return {
    id: `0x${"aa".repeat(32)}` as Hex,
    phash: 1n,
    blockhash: `0x${"00".repeat(32)}` as Hex,
    creator: "0x1111111111111111111111111111111111111111" as Hex,
    parentId: null,
    registeredAt: 1_789_000_000,
    metadataURI: "ipfs://placeholder",
    ...overrides,
  };
}

describe("the re-check fact", () => {
  it("publishes what the live index served for a real passport", () => {
    const fact = recheckFor(bareRecord({ rechecks: rechecksFrom(RECORDED_ROW) }));

    expect(fact).toEqual({
      source: "index",
      attestations: 1,
      matched: 1,
      mismatched: 0,
      latest: { matched: true, distance: 0, at: 1_789_368_639, receiver: CHECKSUMMED_RECEIVER },
    });
    // The fact is read by other people's parsers, so the printed shape is pinned, not just its
    // contents: the counts first, the newest verdict last.
    expect(Object.keys(fact)).toEqual(["source", "attestations", "matched", "mismatched", "latest"]);
    expect(Object.keys((fact as { latest: object }).latest)).toEqual(["matched", "distance", "at", "receiver"]);
  });

  it("counts two matched re-checks and names the newest verdict", () => {
    expect(recheckFor(bareRecord({ rechecks: rechecks() }))).toEqual({
      source: "index",
      attestations: 2,
      matched: 2,
      mismatched: 0,
      latest: { matched: true, distance: 1, at: 1_789_700_000, receiver: CHECKSUMMED_RECEIVER },
    });
  });

  it("says nothing has re-checked the picture without pretending that is a verdict", () => {
    const fact = recheckFor(bareRecord({ rechecks: rechecks({ attestations: 0, matched: 0, latest: null }) }));

    expect(fact).toEqual({ source: "index", attestations: 0 });
  });

  it("carries a mismatch through as the verdict it is", () => {
    const fact = recheckFor(
      bareRecord({
        rechecks: rechecks({
          attestations: 3,
          matched: 2,
          mismatched: 1,
          latest: { receiver: RECEIVER, matched: false, distance: 27, at: 1_789_700_500 },
        }),
      }),
    );

    expect(fact).toEqual({
      source: "index",
      attestations: 3,
      matched: 2,
      mismatched: 1,
      latest: { matched: false, distance: 27, at: 1_789_700_500, receiver: CHECKSUMMED_RECEIVER },
    });
  });

  it("is unavailable for a record whose source carries no re-check data", () => {
    expect(recheckFor(bareRecord())).toEqual({ source: "unavailable" });
    expect(recheckFor(undefined)).toEqual({ source: "unavailable" });
  });

  it("refuses to reconcile a count and a verdict that disagree", () => {
    expect(recheckFor(bareRecord({ rechecks: rechecks({ attestations: 2, latest: null }) }))).toEqual({
      source: "unavailable",
    });
    expect(
      recheckFor(bareRecord({ rechecks: rechecks({ attestations: 0, matched: 0, mismatched: 0 }) })),
    ).toEqual({ source: "unavailable" });
  });

  it("refuses a row whose own three counts disagree, rather than publishing a confident number", () => {
    // Two and none do not make three. One of the three numbers is wrong and nothing here can say
    // which, so "3 re-checks, 2 of them matched" never goes out.
    expect(recheckFor(bareRecord({ rechecks: rechecks({ attestations: 3, matched: 2, mismatched: 0 }) }))).toEqual({
      source: "unavailable",
    });

    // The newest verdict is a match under a matched count of zero.
    expect(recheckFor(bareRecord({ rechecks: rechecks({ attestations: 2, matched: 0, mismatched: 2 }) }))).toEqual({
      source: "unavailable",
    });

    // The newest verdict is a mismatch under a mismatched count of zero.
    expect(
      recheckFor(
        bareRecord({
          rechecks: rechecks({
            attestations: 2,
            matched: 2,
            mismatched: 0,
            latest: { receiver: RECEIVER, matched: false, distance: 30, at: 1_789_700_000 },
          }),
        }),
      ),
    ).toEqual({ source: "unavailable" });
  });
});

describe("reading the re-check fields off an index row", () => {
  it("keeps the receiver lower-cased on the record and checksums it only on the way out", () => {
    const read = rechecksFrom(rowWith({ receiver: CHECKSUMMED_RECEIVER }));

    expect(read?.latest?.receiver).toBe(RECEIVER);
    expect(recheckFor(bareRecord({ rechecks: read }))).toMatchObject({ latest: { receiver: CHECKSUMMED_RECEIVER } });
  });

  it("reads a timestamp whether the index serves it as a string or a number", () => {
    expect(rechecksFrom(rowWith({ at: 1_789_368_639 }))?.latest?.at).toBe(1_789_368_639);
  });

  it("gives nothing for a row that does not carry the fields", () => {
    expect(rechecksFrom({ id: "0x01", phash: "7" })).toBeUndefined();
    expect(rechecksFrom(undefined)).toBeUndefined();
  });

  const badRows: [string, Record<string, unknown>][] = [
    ["a count that is not a number", { attestationCount: "one" }],
    ["a count that is negative", { matchedCount: -1 }],
    ["a count that is not whole", { mismatchedCount: 1.5 }],
    ["an attestation list that is not a list", { attestations: { receiver: RECEIVER } }],
    ["a receiver that is not an address", rowWith({ receiver: "0xdead" })],
    ["a verdict that is not a boolean", rowWith({ matched: "yes" })],
    ["a distance that is negative", rowWith({ distance: -3 })],
    ["a timestamp too large to be exact", rowWith({ at: "9007199254740993" })],
  ];

  it.each(badRows)("gives nothing for %s, so the whole fact goes out unavailable", (_name, bad) => {
    const read = rechecksFrom({ ...RECORDED_ROW, ...bad });

    expect(read).toBeUndefined();
    expect(recheckFor(bareRecord({ rechecks: read }))).toEqual({ source: "unavailable" });
  });
});

describe("the fact on the verify answers", () => {
  // One picture and one fingerprint for all three route tests. Drawing and hashing a fresh image
  // per test is the expensive part of this file, and every test here registers the same picture.
  let image: Buffer;
  let registered: PassportRecord;

  beforeAll(async () => {
    image = await makeImage(101);
    registered = recordFor(await fingerprint(image), { rechecks: rechecks() });
  });

  it("attaches one identical fact when the exact match and the best match are the same passport", async () => {
    const passport = `0x${"44".repeat(32)}` as Hex;
    const asked: Hex[] = [];
    const record = bareRecord({ id: passport, rechecks: rechecks() });

    const payload = await withPassportFacts(
      {
        result: { exact: passport, best: { id: passport, score: 1 }, matches: [{ id: passport, score: 1 }] },
        manifest: { present: false },
      },
      offlineConsentReader(),
      offlineDisputeReader(),
      (id) => {
        asked.push(id);
        return id === passport ? record : undefined;
      },
      offlinePictureReader(),
    );

    const result = payload.result as { best: Record<string, unknown>; matches: Record<string, unknown>[] };
    expect(asked).toEqual([passport]);
    expect(result.best.recheck).toEqual(result.matches[0]?.recheck);
    expect(result.best.recheck).toMatchObject({ source: "index", attestations: 2 });
  });

  it("carries the fact after the dispute status on /verify", async () => {
    const app = await buildServer({ source: sourceOf([registered]), logger: false });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
      const response = await app.inject({ method: "POST", url: "/verify", payload, headers });

      expect(response.statusCode).toBe(200);
      const best = response.json().result.best as Record<string, unknown>;
      expect(best.recheck).toEqual({
        source: "index",
        attestations: 2,
        matched: 2,
        mismatched: 0,
        latest: { matched: true, distance: 1, at: 1_789_700_000, receiver: CHECKSUMMED_RECEIVER },
      });
      expect(Object.keys(best).indexOf("dispute")).toBeLessThan(Object.keys(best).indexOf("recheck"));
      expect(response.payload.indexOf('"dispute"')).toBeLessThan(response.payload.indexOf('"recheck"'));
    } finally {
      await app.close();
    }
  });

  it("says unavailable rather than nothing when the matched passport carries no re-check data", async () => {
    const source = sourceOf([{ ...registered, rechecks: undefined }]);
    const app = await buildServer({ source, logger: false });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
      const response = await app.inject({ method: "POST", url: "/verify", payload, headers });

      expect(response.json().result.best.recheck).toEqual({ source: "unavailable" });
    } finally {
      await app.close();
    }
  });

  it("carries the fact in the body /verify/paid settles over", async () => {
    const settle = vi.fn(async (_payload: unknown, _requirements: unknown, _extensions: unknown, context: unknown) => ({
      success: true,
      errorReason: "",
      transaction: "0x4a",
      headers: {},
      response: { status: 200, headers: {}, body: {} },
      seen: (context as { responseBody: Buffer }).responseBody.toString("utf8"),
    }));
    const payments = {
      initialize: async () => undefined,
      processHTTPRequest: async () => ({
        type: "payment-verified",
        paymentPayload: {},
        paymentRequirements: {},
        declaredExtensions: [],
        cancellationDispatcher: { cancel: async () => undefined },
      }),
      processSettlement: settle,
    } as unknown as Parameters<typeof verifyPaidRoutes>[1]["payments"];

    const app = await buildServer({ source: sourceOf([registered]), logger: false });
    await app.register(verifyPaidRoutes, { payments });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
      const response = await app.inject({ method: "POST", url: "/verify/paid", payload, headers });

      expect(response.statusCode).toBe(200);
      expect(response.json().result.best.recheck).toMatchObject({ source: "index", attestations: 2, matched: 2 });
      const settled = (await settle.mock.results[0]?.value) as { seen: string };
      expect(settled.seen.indexOf('"dispute"')).toBeLessThan(settled.seen.indexOf('"recheck"'));
    } finally {
      await app.close();
    }
  });
});
