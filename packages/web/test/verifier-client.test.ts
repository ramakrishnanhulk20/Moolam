import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VerifierError,
  prepare,
  prepareResponseSchema,
  verify,
  verifyResponseSchema,
} from "@/lib/verifier/client";

const WORD = `0x${"ab".repeat(32)}`;

const preparePayload = {
  passport: {
    exactHash: WORD,
    parentId: `0x${"00".repeat(32)}`,
    generatorAgentId: "0",
    phash: "17297841240124424192",
    blockhash256: WORD,
    manifestHash: WORD,
    kind: 1,
    fingerprintVersion: 1,
    metadataURI: "ipfs://bafkreimetadata",
  },
  image: {
    cid: "bafkreiimage",
    uri: "ipfs://bafkreiimage",
    gatewayUrl: "https://gateway.pinata.cloud/ipfs/bafkreiimage",
    bytes: 482913,
    width: 1024,
    height: 768,
  },
  thumbnail: {
    cid: "bafkreithumb",
    uri: "ipfs://bafkreithumb",
    gatewayUrl: "https://gateway.pinata.cloud/ipfs/bafkreithumb",
  },
  metadata: { cid: "bafkreimetadata", uri: "ipfs://bafkreimetadata" },
  manifest: { embedded: true },
  preparedBy: "did:privy:cm123",
};

const verifyPayload = {
  result: {
    exact: null,
    best: { id: WORD, phashDistance: 2, blockhashDistance: 11, variant: "rot90", score: 0.87 },
    matches: [{ id: WORD, phashDistance: 2, blockhashDistance: 11, variant: "rot90", score: 0.87 }],
    confidence: 0.84,
    queried: {
      sha256: WORD,
      phash: "17297841240124424192",
      blockhash: `0x${"cd".repeat(32)}`,
      width: 1024,
      height: 768,
      format: "jpeg",
    },
  },
  manifest: {
    present: true,
    manifestHash: WORD,
    claimGenerator: "moolam-studio/0.1.0",
    actions: ["c2pa.created"],
    softBinding: { alg: "com.moolam.phash-blockhash.v1", phash: "17297841240124424192", blockhash: WORD },
  },
};

function stubFetch(status: number, body: unknown, ok = status < 400) {
  const fetchStub = vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

function imageFile(): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff])], "still.jpg", { type: "image/jpeg" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the response schemas", () => {
  it("accepts what the routes answer with", () => {
    expect(prepareResponseSchema.parse(preparePayload).passport.phash).toBe("17297841240124424192");
    expect(verifyResponseSchema.parse(verifyPayload).result.best?.variant).toBe("rot90");
  });

  it("refuses a prepare answer with a field missing or the wrong shape", () => {
    const withoutUri: Record<string, unknown> = { ...preparePayload.passport };
    delete withoutUri.metadataURI;
    expect(prepareResponseSchema.safeParse({ ...preparePayload, passport: withoutUri }).success).toBe(false);

    const phashAsNumber = { ...preparePayload, passport: { ...preparePayload.passport, phash: 172978412401244241 } };
    expect(prepareResponseSchema.safeParse(phashAsNumber).success).toBe(false);
  });

  it("refuses a verify answer with a hash that is not 32 bytes or a variant it does not know", () => {
    const shortHash = { ...verifyPayload, result: { ...verifyPayload.result, queried: { ...verifyPayload.result.queried, sha256: "0xabcd" } } };
    expect(verifyResponseSchema.safeParse(shortHash).success).toBe(false);

    const oddVariant = {
      ...verifyPayload,
      result: { ...verifyPayload.result, best: { ...verifyPayload.result.best, variant: "upside-down" } },
    };
    expect(verifyResponseSchema.safeParse(oddVariant).success).toBe(false);
  });
});

describe("prepare and verify over a stubbed fetch", () => {
  it("posts the file, the title and the kind with the access token", async () => {
    const fetchStub = stubFetch(200, preparePayload);

    const result = await prepare({ file: imageFile(), title: "Kadal at dawn", accessToken: "token-123" });
    expect(result.image.cid).toBe("bafkreiimage");

    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4010/prepare");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-123");

    const body = init.body as FormData;
    expect(body.get("title")).toBe("Kadal at dawn");
    expect(body.get("kind")).toBe("human");
    expect(body.get("file")).toBeInstanceOf(File);
  });

  it("posts verify with no token and reads the match back", async () => {
    const fetchStub = stubFetch(200, verifyPayload);

    const result = await verify({ file: imageFile() });
    expect(result.result.confidence).toBe(0.84);

    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4010/verify");
    expect(init.headers).toBeUndefined();
  });
});

describe("VerifierError", () => {
  const cases: [number, string, string][] = [
    [401, "unauthorized", "unauthorized"],
    [400, "bad-request", 'send a "title" field of 1 to 120 characters'],
    [413, "too-large", "the image is larger than the 20971520 byte limit"],
    [415, "not-an-image", "not-an-image"],
    [429, "rate-limited", "Too Many Requests"],
    [502, "pin-failed", "pin-failed"],
    [500, "bad-response", "boom"],
  ];

  for (const [status, code, message] of cases) {
    it(`turns ${status} into ${code}`, async () => {
      stubFetch(status, { error: message });

      const failure = await prepare({ file: imageFile(), title: "x", accessToken: "t" }).catch((error) => error);
      expect(failure).toBeInstanceOf(VerifierError);
      expect(failure.code).toBe(code);
      expect(failure.status).toBe(status);
      expect(failure.message).toBe(message);
    });
  }

  it("says offline when the service cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const failure = await verify({ file: imageFile() }).catch((error) => error);
    expect(failure).toBeInstanceOf(VerifierError);
    expect(failure.code).toBe("offline");
    expect(failure.status).toBe(0);
  });

  it("says bad-response when the answer does not match the schema", async () => {
    stubFetch(200, { passport: {} });

    const failure = await prepare({ file: imageFile(), title: "x", accessToken: "t" }).catch((error) => error);
    expect(failure).toBeInstanceOf(VerifierError);
    expect(failure.code).toBe("bad-response");
  });

  it("lets an abort through as the caller's own abort", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }),
    );

    const failure = await verify({ file: imageFile(), signal: controller.signal }).catch((error) => error);
    expect(failure).not.toBeInstanceOf(VerifierError);
    expect((failure as Error).name).toBe("AbortError");
  });
});
