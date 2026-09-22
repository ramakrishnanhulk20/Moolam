import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { VerifierError, readUnsealRecord, unseal, unsealResponseSchema } from "@/lib/verifier/client";

/**
 * The two calls that open a sealed passport, against the shapes in
 * docs/api/verifier-endpoints.md.
 *
 * The lookup is the one with teeth. Three answers exist and only one of them
 * says "there is no picture": the other two are a record and a service that
 * could not find out, and reading the third as the second is how a published
 * picture would be hidden from the person who published it.
 */

const PASSPORT = `0x${"7c".repeat(32)}` as Hex;
const HOLDER = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a";

const record = {
  passportId: PASSPORT,
  image: { cid: "bafkreiimage", uri: "ipfs://bafkreiimage", gatewayUrl: "https://gateway.example/ipfs/bafkreiimage" },
  thumbnail: { cid: "bafkreithumb", uri: "ipfs://bafkreithumb", gatewayUrl: "https://gateway.example/ipfs/bafkreithumb" },
  manifest: { cid: "bafkreic2pa", uri: "ipfs://bafkreic2pa", gatewayUrl: "https://gateway.example/ipfs/bafkreic2pa" },
  record: { cid: "bafkreirecord", uri: "ipfs://bafkreirecord", gatewayUrl: "https://gateway.example/ipfs/bafkreirecord" },
  unsealedBy: HOLDER,
  unsealedAt: "2026-09-22T06:12:44.000Z",
};

const published = {
  ...record,
  fingerprint: { phash: "0x6ccf137087789a25", blockhash: `0x${"3e".repeat(32)}`, version: 1 },
  quota: { used: 1, limit: 5, resetsAt: 1_788_961_533 },
};

function stubFetch(status: number, body: unknown, ok = status < 400) {
  const fetchStub = vi.fn(async () => ({ ok, status, json: async () => body }));
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

function keptFile(): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff])], "kadal-at-dawn.jpg", { type: "image/jpeg" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the call that publishes the picture", () => {
  it("posts the kept file and the passport id with the holder's token", async () => {
    const fetchStub = stubFetch(200, published);

    const answer = await unseal({ file: keptFile(), passportId: PASSPORT, accessToken: "token-123" });
    expect(answer.image.uri).toBe("ipfs://bafkreiimage");
    expect(answer.record.cid).toBe("bafkreirecord");

    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4010/unseal");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-123");

    const body = init.body as FormData;
    expect(body.get("passportId")).toBe(PASSPORT);
    expect(body.get("file")).toBeInstanceOf(File);
  });

  it("takes an answer without the fingerprint or the allowance, because the picture is already public", () => {
    const thin: Record<string, unknown> = { ...published };
    delete thin.fingerprint;
    delete thin.quota;
    delete (thin as { manifest?: unknown }).manifest;

    const parsed = unsealResponseSchema.safeParse(thin);
    expect(parsed.success).toBe(true);
  });

  it("refuses an answer with no record address in it, which is the one field the page needs", () => {
    const missing: Record<string, unknown> = { ...published };
    delete missing.record;
    expect(unsealResponseSchema.safeParse(missing).success).toBe(false);
  });

  it("keeps the service's own refusal word, so each one can have its own sentence", async () => {
    const refused: [number, string][] = [
      [400, "hash-mismatch"],
      [400, "fingerprint-mismatch"],
      [403, "not-holder"],
      [404, "no-passport"],
      [409, "not-sealed"],
      [409, "already-unsealed"],
      [422, "thumbnail-too-large"],
      [429, "quota"],
      [429, "global-limit"],
      [502, "record-pin-failed"],
      [503, "busy"],
    ];

    for (const [status, word] of refused) {
      stubFetch(status, { error: word, passportId: PASSPORT });
      const failure = await unseal({ file: keptFile(), passportId: PASSPORT, accessToken: "t" }).catch((error) => error);
      expect(failure).toBeInstanceOf(VerifierError);
      expect((failure as VerifierError).serviceCode).toBe(word);
      expect((failure as VerifierError).status).toBe(status);
    }
  });

  it("reads a service that never answered as offline rather than as a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const failure = await unseal({ file: keptFile(), passportId: PASSPORT, accessToken: "t" }).catch((error) => error);
    expect((failure as VerifierError).code).toBe("offline");
    expect((failure as VerifierError).serviceCode).toBeUndefined();
  });
});

describe("the lookup that says where an unsealed picture lives", () => {
  it("asks for the passport by name and reads the record back", async () => {
    const fetchStub = stubFetch(200, record);

    const answer = await readUnsealRecord(PASSPORT);
    expect(answer.state).toBe("unsealed");
    expect(answer.state === "unsealed" ? answer.record.thumbnail.uri : null).toBe("ipfs://bafkreithumb");

    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://localhost:4010/unseal/${PASSPORT}`);
    expect(init.method).toBe("GET");
  });

  it("says sealed only when the service names not-unsealed on a 404", async () => {
    stubFetch(404, { error: "not-unsealed", passportId: PASSPORT });
    expect((await readUnsealRecord(PASSPORT)).state).toBe("sealed");
  });

  it("says unknown when the service could not find out, never sealed", async () => {
    stubFetch(503, { error: "lookup-unavailable" });
    const answer = await readUnsealRecord(PASSPORT);
    expect(answer.state).toBe("unknown");
    expect(answer.state === "unknown" ? answer.reason : "").toContain("lookup-unavailable");
  });

  it("says unknown for a 404 that is not the service's own word, such as an edge or a wrong host", async () => {
    stubFetch(404, { message: "Not Found" });
    expect((await readUnsealRecord(PASSPORT)).state).toBe("unknown");
  });

  it("says unknown when the network never answered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect((await readUnsealRecord(PASSPORT)).state).toBe("unknown");
  });

  it("refuses a record filed under another passport", async () => {
    stubFetch(200, { ...record, passportId: `0x${"11".repeat(32)}` });
    expect((await readUnsealRecord(PASSPORT)).state).toBe("unknown");
  });

  it("refuses an answer this app cannot read, rather than drawing half a record", async () => {
    stubFetch(200, { passportId: PASSPORT, image: { cid: "bafkreiimage" } });
    expect((await readUnsealRecord(PASSPORT)).state).toBe("unknown");
  });
});
