import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { readArt } from "@/components/passport/art";
import { withUnseal } from "@/lib/data/unseal";
import { VerifierError, forgetPrivateCopy, sealedStatus } from "@/lib/verifier/client";

/**
 * The two reads the passport page makes about a private re-check: whether the
 * pinned document asked for one, and whether Moolam still keeps the copy.
 *
 * The first has to agree with the predicate the service, the queue, the runner
 * and the sealed workflow share, so it is run against their own fixtures. The
 * second has three answers and never a fourth, because a page that read
 * "could not tell" as "deleted" would tell a creator something untrue.
 */

const URI = "ipfs://bafkreisealedmetadata";
const PASSPORT = `0x${"7c".repeat(32)}` as Hex;

const PRIVATE = {
  name: "Monsoon nets, Kovalam",
  description: "Registered on Moolam. The picture is not published.",
  sealed: true,
  privateRecheck: true,
  commitment: { algorithm: "sha-256", value: PASSPORT },
  fingerprint: { phash: "0x6ccf137087789a25", blockhash: `0x${"11".repeat(32)}`, version: 1 },
};

function answering(document: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(document), { status, headers: { "content-type": "application/json" } }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reading the private re-check off the pinned document", () => {
  it("is set on a sealed document that asked for one", async () => {
    vi.stubGlobal("fetch", answering(PRIVATE));
    const art = await readArt(URI);

    expect(art.sealed).toBe(true);
    expect(art.privateRecheck).toBe(true);
  });

  it("is not set on a plain sealed document", async () => {
    vi.stubGlobal("fetch", answering({ ...PRIVATE, privateRecheck: undefined }));
    expect((await readArt(URI)).privateRecheck).toBeUndefined();
  });

  it("is never set on a published document, whatever it says", async () => {
    vi.stubGlobal(
      "fetch",
      answering({ name: "Kadal", image: "ipfs://bafkreiimage", thumbnail: "ipfs://bafkreithumb", privateRecheck: true }),
    );
    const art = await readArt(URI);

    expect(art.sealed).toBeUndefined();
    expect(art.privateRecheck).toBeUndefined();
  });

  it("reads a word that is not the boolean true as no, and keeps the rest of the document", async () => {
    vi.stubGlobal("fetch", answering({ ...PRIVATE, privateRecheck: "true" }));
    const art = await readArt(URI);

    expect(art.sealed).toBe(true);
    expect(art.title).toBe("Monsoon nets, Kovalam");
    expect(art.privateRecheck).toBeUndefined();
  });

  it("is dropped once the holder has published the picture", async () => {
    vi.stubGlobal("fetch", answering(PRIVATE));
    const art = await readArt(URI);
    const record = {
      passportId: PASSPORT,
      image: { cid: "a", uri: "ipfs://a", gatewayUrl: "https://g/a" },
      thumbnail: { cid: "b", uri: "ipfs://b", gatewayUrl: "https://g/b" },
      record: { cid: "c", uri: "ipfs://c", gatewayUrl: "https://g/c" },
      unsealedBy: "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a",
      unsealedAt: "2026-09-22T06:12:44.000Z",
    };
    vi.stubGlobal("fetch", answering(record));

    expect((await withUnseal(art, PASSPORT)).privateRecheck).toBeUndefined();
  });

  describe("agrees with every case in the shared fixtures", () => {
    const fixtures = JSON.parse(
      readFileSync("../verifier/test/fixtures/sealed-documents.json", "utf8"),
    ) as { cases: { name: string; recheckable: boolean; document: unknown }[] };

    it("has cases to agree with", () => {
      expect(fixtures.cases.length).toBeGreaterThan(3);
    });

    for (const fixture of fixtures.cases) {
      it(fixture.name, async () => {
        vi.stubGlobal("fetch", answering(fixture.document));
        expect((await readArt(URI)).privateRecheck === true).toBe(fixture.recheckable);
      });
    }
  });
});

describe("sealedStatus", () => {
  it("reads kept and gone as the service says them", async () => {
    vi.stubGlobal("fetch", answering({ passportId: PASSPORT, state: "kept", privateRecheck: true }));
    expect(await sealedStatus(PASSPORT)).toEqual({ state: "kept" });

    vi.stubGlobal("fetch", answering({ passportId: PASSPORT, state: "gone", privateRecheck: true }));
    expect(await sealedStatus(PASSPORT)).toEqual({ state: "gone" });
  });

  it("asks the service's status route for this passport", async () => {
    const stub = answering({ passportId: PASSPORT, state: "kept", privateRecheck: true });
    vi.stubGlobal("fetch", stub);
    await sealedStatus(PASSPORT);

    expect(String((stub.mock.calls[0] as unknown[])[0])).toContain(`/sealed/status/${PASSPORT}`);
  });

  it("keeps unknown apart from gone", async () => {
    vi.stubGlobal("fetch", answering({ passportId: PASSPORT, state: "unknown", privateRecheck: true }));
    expect((await sealedStatus(PASSPORT)).state).toBe("unknown");
  });

  it("reads a refusal, a silent network, a strange shape or another passport as unknown", async () => {
    vi.stubGlobal("fetch", answering({ error: "no-passport", passportId: PASSPORT }, 404));
    expect((await sealedStatus(PASSPORT)).state).toBe("unknown");

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect((await sealedStatus(PASSPORT)).state).toBe("unknown");

    vi.stubGlobal("fetch", answering({ passportId: PASSPORT, state: "maybe", privateRecheck: true }));
    expect((await sealedStatus(PASSPORT)).state).toBe("unknown");

    vi.stubGlobal("fetch", answering({ passportId: `0x${"ab".repeat(32)}`, state: "kept", privateRecheck: true }));
    expect((await sealedStatus(PASSPORT)).state).toBe("unknown");
  });

  it("does not believe a kept copy for a document that did not ask for one", async () => {
    vi.stubGlobal("fetch", answering({ passportId: PASSPORT, state: "kept", privateRecheck: false }));
    expect((await sealedStatus(PASSPORT)).state).toBe("unknown");
  });
});

describe("forgetPrivateCopy", () => {
  it("sends the passport id with the holder's token and reads the count back", async () => {
    const stub = answering({ passportId: PASSPORT, deleted: 1 });
    vi.stubGlobal("fetch", stub);

    const answer = await forgetPrivateCopy({ passportId: PASSPORT, accessToken: "privy-token" });

    expect(answer).toEqual({ passportId: PASSPORT, deleted: 1 });
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/sealed/forget");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ passportId: PASSPORT });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer privy-token");
  });

  it("keeps the service's own word on a refusal", async () => {
    for (const [status, word] of [
      [403, "not-holder"],
      [404, "nothing-kept"],
      [404, "no-passport"],
      [503, "lookup-unavailable"],
      [502, "delete-failed"],
    ] as const) {
      vi.stubGlobal("fetch", answering({ error: word, passportId: PASSPORT }, status));
      const failure = await forgetPrivateCopy({ passportId: PASSPORT, accessToken: "t" }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(VerifierError);
      expect((failure as VerifierError).serviceCode).toBe(word);
      expect((failure as VerifierError).status).toBe(status);
    }
  });
});
