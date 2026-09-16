import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureRequestTimeout,
  VerifierError,
  edit,
  editResponseSchema,
  generate,
  generateResponseSchema,
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

const CREATOR = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c";
const PARENT_ID = `0x${"3f".repeat(32)}`;

const editPayload = {
  child: {
    exactHash: WORD,
    parentId: PARENT_ID,
    creator: CREATOR,
    generatorAgentId: "0",
    phash: "17297841240124424192",
    blockhash256: WORD,
    manifestHash: WORD,
    kind: 2,
    fingerprintVersion: 1,
    metadataURI: "ipfs://bafkreiedited",
    deadline: "1788878733",
  },
  tokenId: "77045069988464985183988543906144022395969906830851064729409639142441101033899",
  hash: `0x${"1c".repeat(32)}`,
  sponsored: true,
  image: {
    cid: "bafkreiedited",
    uri: "ipfs://bafkreiedited",
    gatewayUrl: "https://gateway.pinata.cloud/ipfs/bafkreiedited",
    bytes: 305221,
    width: 1024,
    height: 1024,
  },
  thumbnail: {
    cid: "bafkreieditedthumb",
    uri: "ipfs://bafkreieditedthumb",
    gatewayUrl: "https://gateway.pinata.cloud/ipfs/bafkreieditedthumb",
  },
  metadata: { cid: "bafkreieditedmeta", uri: "ipfs://bafkreieditedmeta" },
  manifest: { embedded: true },
  quota: { used: 1, limit: 5, resetsAt: 1788961533 },
};

const generatePayload = {
  passport: {
    exactHash: WORD,
    parentId: `0x${"00".repeat(32)}`,
    creator: CREATOR,
    generatorAgentId: "10249",
    phash: "17297841240124424192",
    blockhash256: WORD,
    manifestHash: WORD,
    kind: 0,
    fingerprintVersion: 1,
    metadataURI: "ipfs://bafkreimetadata",
    deadline: "1788878733",
  },
  generatorSig: `0x${"cd".repeat(65)}`,
  image: {
    cid: "bafkreiimage",
    uri: "ipfs://bafkreiimage",
    gatewayUrl: "https://gateway.pinata.cloud/ipfs/bafkreiimage",
    bytes: 208383,
    width: 1024,
    height: 1024,
  },
  thumbnail: {
    cid: "bafkreithumb",
    uri: "ipfs://bafkreithumb",
    gatewayUrl: "https://gateway.pinata.cloud/ipfs/bafkreithumb",
  },
  metadata: { cid: "bafkreimetadata", uri: "ipfs://bafkreimetadata" },
  manifest: { embedded: true },
  model: "gpt-image-1",
  agent: { id: "10249", wallet: "0xa37418c4047Fb6A42150D6E9Ddab77580Ddb9AFb" },
  quota: { used: 1, limit: 3, resetsAt: 1788961533 },
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

  it("accepts what /generate answers with, deadline and agent signature included", () => {
    const parsed = generateResponseSchema.parse(generatePayload);
    expect(parsed.passport.deadline).toBe("1788878733");
    expect(parsed.passport.creator).toBe(CREATOR);
    expect(parsed.agent.id).toBe("10249");
    expect(parsed.quota).toEqual({ used: 1, limit: 3, resetsAt: 1788961533 });
  });

  it("refuses a generate answer whose signature is the wrong length or whose deadline is a number", () => {
    expect(generateResponseSchema.safeParse({ ...generatePayload, generatorSig: "0xdead" }).success).toBe(false);

    const deadlineAsNumber = {
      ...generatePayload,
      passport: { ...generatePayload.passport, deadline: 1788878733 },
    };
    expect(generateResponseSchema.safeParse(deadlineAsNumber).success).toBe(false);
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

  it("posts the prompt, the title, the creator and the deadline as JSON with the token", async () => {
    const fetchStub = stubFetch(200, generatePayload);

    const result = await generate({
      prompt: "a fishing boat at first light off the Coromandel coast",
      title: "First light",
      creator: CREATOR,
      deadline: 1788878733n,
      accessToken: "token-123",
    });
    expect(result.model).toBe("gpt-image-1");
    expect(result.generatorSig).toBe(`0x${"cd".repeat(65)}`);

    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4010/generate");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-123");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: "a fishing boat at first light off the Coromandel coast",
      title: "First light",
      creator: CREATOR,
      deadline: "1788878733",
    });
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

  it("reads the generate failures out of the body, not the status", async () => {
    const asked = {
      prompt: "a fishing boat at first light",
      title: "First light",
      creator: CREATOR,
      deadline: 1788878733n,
      accessToken: "t",
    };

    const refused: [number, unknown, string, string][] = [
      [400, { error: "prompt-refused", reason: "the safety system turned this prompt down" }, "prompt-refused", "the safety system turned this prompt down"],
      [502, { error: "model-failed" }, "model-failed", "model-failed"],
      [502, { error: "sign-failed" }, "sign-failed", "sign-failed"],
      [503, { error: "busy" }, "busy", "busy"],
    ];

    for (const [status, body, code, message] of refused) {
      stubFetch(status, body);
      const failure = await generate(asked).catch((error) => error);
      expect(failure).toBeInstanceOf(VerifierError);
      expect(failure.code).toBe(code);
      expect(failure.message).toBe(message);
      vi.unstubAllGlobals();
    }
  });

  it("reads a creator that is not the caller's and a window that closed out of the body", async () => {
    const asked = {
      prompt: "a fishing boat at first light",
      title: "First light",
      creator: CREATOR,
      deadline: 1788878733n,
      accessToken: "t",
    };

    const refused: [number, string][] = [
      [403, "creator-mismatch"],
      [400, "deadline-passed"],
    ];

    for (const [status, code] of refused) {
      stubFetch(status, { error: code });
      const failure = await generate(asked).catch((error) => error);
      expect(failure.code).toBe(code);
      expect(failure.status).toBe(status);
      vi.unstubAllGlobals();
    }
  });

  it("names the passport that already holds a picture a prepare was refused for", async () => {
    const passportId = `0x${"7d".repeat(32)}`;
    stubFetch(409, { error: "already-registered", passportId });

    const failure = await prepare({ file: imageFile(), title: "Kadal at dawn", accessToken: "t" }).catch(
      (error) => error,
    );
    expect(failure.code).toBe("already-registered");
    expect(failure.status).toBe(409);
    expect(failure.passportId).toBe(passportId);
  });

  it("reads the 503 a full decode gate answers a prepare with as busy", async () => {
    stubFetch(503, { error: "busy" });

    const failure = await prepare({ file: imageFile(), title: "Kadal at dawn", accessToken: "t" }).catch(
      (error) => error,
    );
    expect(failure.code).toBe("busy");
    expect(failure.status).toBe(503);
  });

  it("keeps the quota block from a refused generation, and 429 without one stays rate limited", async () => {
    const asked = {
      prompt: "a fishing boat at first light",
      title: "First light",
      creator: CREATOR,
      deadline: 1788878733n,
      accessToken: "t",
    };

    stubFetch(429, { error: "quota", quota: { used: 3, limit: 3, resetsAt: 1788961533 } });
    const refused = await generate(asked).catch((error) => error);
    expect(refused.code).toBe("quota");
    expect(refused.quota).toEqual({ used: 3, limit: 3, resetsAt: 1788961533 });

    vi.unstubAllGlobals();
    stubFetch(429, { error: "Too Many Requests" });
    const limited = await generate(asked).catch((error) => error);
    expect(limited.code).toBe("rate-limited");
    expect(limited.quota).toBeUndefined();
  });

  it("says offline when the service accepts the request and never answers", async () => {
    configureRequestTimeout(50);
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
        }),
      ),
    );
    const failure = await verify({ file: new File([new Uint8Array([1, 2, 3])], "a.jpg", { type: "image/jpeg" }) }).catch((error: unknown) => error);
    configureRequestTimeout(120_000);
    expect(failure).toBeInstanceOf(VerifierError);
    expect((failure as VerifierError).code).toBe("offline");
  });

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

describe("the edit the owner appends without a passkey", () => {
  it("accepts what /edit answers with, the child passport and its parent", () => {
    const parsed = editResponseSchema.parse(editPayload);
    expect(parsed.child.parentId).toBe(PARENT_ID);
    expect(parsed.child.kind).toBe(2);
    expect(parsed.sponsored).toBe(true);
    expect(parsed.quota).toEqual({ used: 1, limit: 5, resetsAt: 1788961533 });
  });

  it("refuses an answer whose hash is not a transaction hash, or whose quota is missing", () => {
    expect(editResponseSchema.safeParse({ ...editPayload, hash: "0x" }).success).toBe(false);

    const withoutQuota: Record<string, unknown> = { ...editPayload };
    delete withoutQuota.quota;
    expect(editResponseSchema.safeParse(withoutQuota).success).toBe(false);
  });

  it("posts the picture, the title, the parent and the note with the access token", async () => {
    const fetchStub = stubFetch(200, editPayload);

    const result = await edit({
      file: imageFile(),
      title: "Kadal at dawn, warmer",
      parentId: PARENT_ID,
      note: "Lifted the shadows and cropped the right edge.",
      accessToken: "token-123",
    });
    expect(result.child.exactHash).toBe(WORD);

    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4010/edit");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-123");

    const body = init.body as FormData;
    expect(body.get("title")).toBe("Kadal at dawn, warmer");
    expect(body.get("parentId")).toBe(PARENT_ID);
    expect(body.get("note")).toBe("Lifted the shadows and cropped the right edge.");
    expect(body.get("file")).toBeInstanceOf(File);
  });

  it("reads the edit refusals out of the body rather than the status", async () => {
    const asked = {
      file: imageFile(),
      title: "Kadal at dawn, warmer",
      parentId: PARENT_ID as `0x${string}`,
      note: "",
      accessToken: "t",
    };

    const refused: [number, unknown, string, string][] = [
      [409, { error: "no-signer" }, "no-signer", "no-signer"],
      [403, { error: "not-owner" }, "not-owner", "not-owner"],
      [404, { error: "no-parent" }, "no-parent", "no-parent"],
      [502, { error: "send-failed", reason: "PassportAlreadyExists" }, "send-failed", "PassportAlreadyExists"],
      [503, { error: "busy" }, "busy", "busy"],
    ];

    for (const [status, body, code, message] of refused) {
      stubFetch(status, body);
      const failure = await edit(asked).catch((error) => error);
      expect(failure).toBeInstanceOf(VerifierError);
      expect(failure.code).toBe(code);
      expect(failure.message).toBe(message);
      vi.unstubAllGlobals();
    }
  });

  it("carries the transaction a pending send left behind, so the panel can look it up", async () => {
    const hash = `0x${"1c".repeat(32)}`;
    stubFetch(502, { error: "send-pending", transactionId: "tx_0198", hash });

    const failure = await edit({
      file: imageFile(),
      title: "Kadal at dawn, warmer",
      parentId: PARENT_ID as `0x${string}`,
      note: "",
      accessToken: "t",
    }).catch((error) => error);

    expect(failure.code).toBe("send-pending");
    expect(failure.status).toBe(502);
    expect(failure.transactionId).toBe("tx_0198");
    expect(failure.hash).toBe(hash);
  });

  it("takes a pending send that has no hash yet, and refuses a hash that is not one", async () => {
    const asked = {
      file: imageFile(),
      title: "Kadal at dawn, warmer",
      parentId: PARENT_ID as `0x${string}`,
      note: "",
      accessToken: "t",
    };

    stubFetch(502, { error: "send-pending", transactionId: "tx_0199" });
    const noHash = await edit(asked).catch((error) => error);
    expect(noHash.transactionId).toBe("tx_0199");
    expect(noHash.hash).toBeUndefined();

    vi.unstubAllGlobals();
    stubFetch(502, { error: "send-pending", transactionId: "tx_0200", hash: "0xabc" });
    const shortHash = await edit(asked).catch((error) => error);
    expect(shortHash.hash).toBeUndefined();
  });

  it("tells the two dependencies that did not answer apart from a send that failed", async () => {
    const asked = {
      file: imageFile(),
      title: "Kadal at dawn, warmer",
      parentId: PARENT_ID as `0x${string}`,
      note: "",
      accessToken: "t",
    };

    for (const code of ["privy-unavailable", "chain-unavailable"] as const) {
      stubFetch(502, { error: code });
      const failure = await edit(asked).catch((error) => error);
      expect(failure.code).toBe(code);
      expect(failure.hash).toBeUndefined();
      vi.unstubAllGlobals();
    }
  });

  it("keeps the allowance from a refused edit", async () => {
    stubFetch(429, { error: "quota", quota: { used: 5, limit: 5, resetsAt: 1788961533 } });

    const failure = await edit({
      file: imageFile(),
      title: "x",
      parentId: PARENT_ID as `0x${string}`,
      note: "",
      accessToken: "t",
    }).catch((error) => error);
    expect(failure.code).toBe("quota");
    expect(failure.quota).toEqual({ used: 5, limit: 5, resetsAt: 1788961533 });
  });
});
