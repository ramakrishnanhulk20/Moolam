// Covers review pass 10, sealed #1 and #2 (V104, V105): once this server has pinned an unseal
// record, every reader on it says the picture is published, from its own memory of that record,
// while Pinata's listing still shows nothing under the record's name. The three readers are the
// picture fact on a /verify answer, POST /recheck/request, and GET /unseal/:passportId, and each is
// asked first while the passport still reads sealed, so a "sealed" answer each of them holds for
// ten seconds is in memory when the unseal lands. The second case is the V105 one: the check for
// an earlier record could not answer before the pins, so GET used to answer 404 not-unsealed.
// The picture reader and the re-check route use the live record finder, unsealRecordFor, fed a
// Pinata listing that answers an empty list, so the finder that runs in production is the one that
// trails.
// Does NOT cover another server's unseal (a server knows only what it pinned itself), a real Pinata,
// Privy, gateway or chain: the chain, document and holder reads are stubbed as test/unseal.test.ts
// stubs them, and every pin is answered at the fetch layer.

import { SignJWT, generateKeyPair } from "jose";
import { getAddress, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { multipartBody, recordFor } from "./helpers.js";
import { texturedPicture } from "./texturedPicture.js";

const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000104";
  process.env.PRIVY_APP_ID = id;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.EDITS_PER_DAY = "5";
  process.env.GLOBAL_UNSEALS_PER_DAY = "60";
  process.env.X402_ENABLED = "false";
  process.env.GENERATOR_WALLET_ID = "";
  process.env.EXPECT_ROUTES = "";
  return id;
});

const stubs = vi.hoisted(() => ({
  readPassport: vi.fn(),
  holderOf: vi.fn(),
  readMetadataDocument: vi.fn(),
  findUnsealRecord: vi.fn(),
  readUnsealRecord: vi.fn(),
  embeddedWallets: vi.fn(),
}));

vi.mock("../src/unseal.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/unseal.js")>();
  return {
    ...real,
    readPassport: stubs.readPassport,
    holderOf: stubs.holderOf,
    readMetadataDocument: stubs.readMetadataDocument,
    findUnsealRecord: stubs.findUnsealRecord,
    readUnsealRecord: stubs.readUnsealRecord,
  };
});

vi.mock("../src/auth/wallet.js", () => ({ embeddedWallets: stubs.embeddedWallets }));

vi.mock("../src/generate/privy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/privy.js")>()),
  privy: () => ({}),
}));

const { prepareSealed } = await import("../src/prepare.js");
const { sealedMetadata } = await import("../src/sealed.js");
const { buildServer } = await import("../src/server.js");
const { contentIdOf } = await import("../src/ipfs/pinata.js");
const { pictureReader, unsealRecordFor } = await import("../src/unseal.js");

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const PRIVATE_FILES_URL = "https://api.pinata.cloud/v3/files/private";
const HOLDER = getAddress("0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6");
const RUNNER_TOKEN = "moolam-runner-token-for-tests-0104";

interface Sealed {
  bytes: Buffer;
  passportId: Hex;
  metadataURI: string;
  document: unknown;
  phash: bigint;
  blockhash: Hex;
  manifestHash: Hex;
}

let signing: CryptoKey;
let verifying: CryptoKey;
let app: FastifyInstance;
/** Two sealed registrations, one per case, so neither case is answered from the other's unseal. */
const files: Sealed[] = [];

/** A Pinata public listing that trails every pin: it answers an empty list for every name. */
const emptyListing = (async () =>
  new Response(JSON.stringify({ data: { files: [] } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

/** The live record finder as server.ts builds it, asking a listing that still shows nothing. */
const trailingFinder = async (passportId: Hex) =>
  await unsealRecordFor(passportId, { lookup: { fetchImpl: emptyListing } });

async function sealed(background: string, title: string): Promise<Sealed> {
  const prepared = await prepareSealed(
    await texturedPicture(background),
    { title, claimGenerator: "moolam-studio/0.1.0", action: "c2pa.created" },
  );
  const passportId = prepared.print.sha256;
  return {
    bytes: prepared.bytes,
    passportId,
    metadataURI: `ipfs://bafysealed${files.length}`,
    document: sealedMetadata({
      title,
      description: "A picture registered with Moolam and kept sealed.",
      passportId,
      fingerprint: prepared.print,
    }),
    phash: prepared.print.phash,
    blockhash: prepared.print.blockhash,
    manifestHash: prepared.manifestHash as Hex,
  };
}

function byId(id: Hex): Sealed | undefined {
  return files.find((file) => file.passportId === id.toLowerCase());
}

function byUri(uri: string): Sealed | undefined {
  return files.find((file) => file.metadataURI === uri);
}

async function token(subject: string): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("privy.io")
    .setAudience(APP_ID)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signing);
}

async function unseal(file: Sealed, ip: string): Promise<LightMyRequestResponse> {
  const boundary = "----moolamreaders";
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="passportId"\r\n\r\n${file.passportId}\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sealed.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
    ),
    file.bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return await app.inject({
    method: "POST",
    url: "/unseal",
    payload,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      authorization: `Bearer ${await token("did:privy:readers-holder")}`,
    },
    remoteAddress: ip,
  });
}

/** The picture fact on a /verify answer for this exact file. */
async function pictureFact(file: Sealed): Promise<Record<string, unknown>> {
  const { payload, headers } = multipartBody("file", "sealed.jpg", "image/jpeg", file.bytes);
  const response = await app.inject({ method: "POST", url: "/verify", payload, headers });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.result.exact).toBe(file.passportId);
  return body.result.best.picture as Record<string, unknown>;
}

async function recheckRequest(file: Sealed, ip: string): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: "POST",
    url: "/recheck/request",
    payload: { passportId: file.passportId },
    remoteAddress: ip,
  });
}

describe("V104 and V105: this server's own unseal is read as unsealed everywhere at once", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;
    files.push(await sealed("#1d3b53", "Monsoon nets, sealed"));
    files.push(await sealed("#3b531d", "Harbour lights, sealed"));

    stubs.readPassport.mockImplementation(async (_chain: unknown, _registry: unknown, id: Hex) => {
      const file = byId(id);
      return file === undefined
        ? undefined
        : {
            registeredAt: 1_758_000_000,
            phash: file.phash,
            blockhash256: file.blockhash,
            fingerprintVersion: 1,
            metadataURI: file.metadataURI,
            creator: HOLDER,
            parentId: `0x${"00".repeat(32)}`,
            manifestHash: file.manifestHash,
          };
    });
    stubs.holderOf.mockResolvedValue(HOLDER);
    stubs.embeddedWallets.mockResolvedValue([HOLDER]);
    stubs.readMetadataDocument.mockImplementation(async (uri: string) => byUri(uri)?.document);
    stubs.findUnsealRecord.mockResolvedValue({ state: "none" });

    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(`${PRIVATE_FILES_URL}?`)) {
        return new Response(JSON.stringify({ data: { files: [], next_page_token: "" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url !== UPLOAD_URL) {
        return await realFetch(input, init);
      }
      const form = init?.body as FormData;
      const bytes = Buffer.from(await (form.get("file") as File).arrayBuffer());
      return new Response(JSON.stringify({ data: { cid: contentIdOf(bytes), size: bytes.length, network: "public" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const readDocument = async (uri: string): Promise<unknown> => byUri(uri)?.document;
    const index = await Promise.all(
      files.map(async (file) =>
        recordFor(
          { sha256: file.passportId, phash: file.phash, blockhash: file.blockhash, width: 640, height: 480, format: "jpeg" },
          { metadataURI: file.metadataURI, creator: HOLDER },
        ),
      ),
    );
    app = await buildServer({
      source: { load: async () => index },
      logger: false,
      unseal: { keys: verifying },
      picture: pictureReader({ readDocument, findRecord: trailingFinder }),
      recheck: { runnerToken: RUNNER_TOKEN, readDocument, findRecord: trailingFinder },
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it("V104: the verify picture fact, /recheck/request and GET /unseal read unsealed the moment the record is pinned", async () => {
    const file = files[0] as Sealed;
    // Each reader is asked first while the passport is sealed, so a held "sealed" is in memory.
    expect((await pictureFact(file)).state).toBe("sealed");
    const refused = await recheckRequest(file, "198.51.100.1");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("sealed");
    expect((await app.inject({ method: "GET", url: `/unseal/${file.passportId}` })).statusCode).toBe(404);

    const unsealed = await unseal(file, "198.51.100.2");
    expect(unsealed.statusCode, unsealed.body).toBe(200);
    const at = unsealed.json().unsealedAt as string;

    // The listing still answers nothing, and every reader believes this server's own record.
    expect(await pictureFact(file)).toMatchObject({ state: "unsealed", at });
    const queued = await recheckRequest(file, "198.51.100.3");
    expect(queued.statusCode, queued.body).toBe(200);
    expect(queued.json()).toMatchObject({ passportId: file.passportId, status: "pending" });
    const read = await app.inject({ method: "GET", url: `/unseal/${file.passportId}` });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ passportId: file.passportId, unsealedAt: at, record: unsealed.json().record });
  }, 120_000);

  it("V105: GET /unseal answers this server's own record, never not-unsealed, after an unavailable pre-check", async () => {
    const file = files[1] as Sealed;
    // The pre-check before the pins cannot answer, and every listing after the pin still trails.
    stubs.findUnsealRecord
      .mockResolvedValueOnce({ state: "unavailable", reason: "Pinata answered 500 to the record lookup" })
      .mockResolvedValue({ state: "none" });

    const unsealed = await unseal(file, "198.51.100.4");
    expect(unsealed.statusCode, unsealed.body).toBe(200);

    for (let i = 0; i < 2; i += 1) {
      const read = await app.inject({ method: "GET", url: `/unseal/${file.passportId}` });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json()).toMatchObject({
        passportId: file.passportId,
        record: unsealed.json().record,
        unsealedAt: unsealed.json().unsealedAt,
      });
    }
    expect((await pictureFact(file)).state).toBe("unsealed");
  }, 120_000);
});
