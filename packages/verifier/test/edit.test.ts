// Covers POST /edit with Privy, the chain reads and Pinata all stubbed: a request with no token
// stopping before anything is read, the two refusals a browser has to act on (no signer, not the
// owner), an unknown parent, the daily allowance on a fake clock, which failures give that
// allowance back and which keep it, the wallet chosen out of several by who holds the parent, the
// answers for a send that reverted or never confirmed, and the happy path, where what matters is
// the calldata that would reach the chain and the hash the answer carries back.
// From review pass 4: the review's SVG is refused before the gate (V17), and an edit's manifest
// records opened then edited with no source type Moolam cannot see (V22). From review pass 5: a
// real picture too detailed for the thumbnail budget is told so with 422, not 415 (intake 4).
// From review pass 7 (V58): the creator's own allowance comes back only when nothing was pinned
// and nothing was sent, so an edit whose pins may have landed keeps it spent.
// An edit made from a camera's signed photo answers cameraRecord as /prepare does, and the route
// hands its request logger to prepareOrFallback so a dropped record is logged.
// From review pass 9 (V89): a send reported dead or reverted whose child is on chain for the creator
// is answered as appended. A signing read-back fault is logged as one, not as failed
// fingerprinting. From review pass 10 (V95): the send key is made from the wallet and the whole
// calldata, so a retry with a new deadline is a new send, and an event or a chain record that names
// another creator or another parent is never answered as this edit.
// Does NOT cover Privy actually signing, gas sponsorship, or the registry accepting the edit.
// Those are proven live by packages/agents/scripts/prove-privy.ts step 6 and, from the browser,
// by a real creator granting a signer. The sponsored poll itself is covered in
// packages/agents/test/sponsored-send.test.ts.

import { APIError } from "@privy-io/node";
import { SignJWT, generateKeyPair } from "jose";
import sharp from "sharp";
import { decodeFunctionData, getAddress, toEventSelector, type Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Reader } from "@contentauth/c2pa-node";
import { FILTER_BOMB_SVG, makeImage, registeredEventLog } from "./helpers.js";

// env.ts validates once at import, so everything the route reads has to be set before any module
// in this file loads. vi.hoisted runs before the imports above. The Pinata token is a fake: every
// call to Pinata is answered by the stub below.
const SETTINGS = vi.hoisted(() => {
  const settings = {
    appId: "moolamtestapp0000003",
    signerId: "moolamtesteditsigner01",
    policyId: "moolamtesteditpolicy01",
  };
  process.env.PRIVY_APP_ID = settings.appId;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.PRIVY_EDIT_SIGNER_ID = settings.signerId;
  process.env.PRIVY_EDIT_POLICY_ID = settings.policyId;
  process.env.EDITS_PER_DAY = "2";
  return settings;
});

const stubs = vi.hoisted(() => ({
  delegatedWallets: vi.fn(),
  walletSigners: vi.fn(),
  passportExists: vi.fn(),
  parentOwner: vi.fn(),
  estimateEditGas: vi.fn(),
  send: vi.fn(),
  receipt: vi.fn(),
  prepareOptions: [] as { log?: unknown }[],
  /** While on, every preparation is handed the first one's result, as the unsigned fallback gives one file one id. */
  samePrepared: false,
  prepared: undefined as unknown,
  readPassport: vi.fn(),
  /** Thrown by the next preparation instead of preparing, when set. */
  prepareFault: undefined as Error | undefined,
}));

// The real preparation, with the options the route passed kept for the one test that reads them.
vi.mock("../src/prepare.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/prepare.js")>();
  return {
    ...real,
    prepareOrFallback: async (...args: Parameters<typeof real.prepareOrFallback>) => {
      stubs.prepareOptions.push(args[1]);
      const fault = stubs.prepareFault;
      if (fault !== undefined) {
        stubs.prepareFault = undefined;
        throw fault;
      }
      if (stubs.samePrepared) {
        stubs.prepared ??= await real.prepareOrFallback(...args);
        return stubs.prepared as Awaited<ReturnType<typeof real.prepareOrFallback>>;
      }
      return await real.prepareOrFallback(...args);
    },
  };
});

vi.mock("../src/edit/signers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/signers.js")>()),
  delegatedWallets: stubs.delegatedWallets,
  walletSigners: stubs.walletSigners,
}));

vi.mock("../src/edit/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/registry.js")>()),
  passportExists: stubs.passportExists,
  parentOwner: stubs.parentOwner,
  estimateEditGas: stubs.estimateEditGas,
}));

// The chain's record of a registered passport, read before an edit whose send looked lost is
// answered as appended.
vi.mock("../src/unseal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/unseal.js")>()),
  readPassport: stubs.readPassport,
}));

vi.mock("../src/edit/send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/send.js")>()),
  sendFromWallet: stubs.send,
  awaitReceipt: stubs.receipt,
}));

// The Privy client is never called in these tests: every function that would use it is stubbed
// above. This keeps the route from building a real one out of the root .env.
vi.mock("../src/generate/privy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/privy.js")>()),
  privy: () => ({}),
  ownerContext: () => ({}),
}));

const { registryEditAbi } = await import("../src/edit/registry.js");
const { contentIdOf } = await import("../src/ipfs/pinata.js");
const { env } = await import("../src/env.js");
const { SponsoredSendFailed, SponsoredSendPending, callIdempotencyKey } = await import("../src/edit/send.js");
const { Busy } = await import("../src/generate/gate.js");
const { buildServer } = await import("../src/server.js");
const { fileSlug } = await import("../src/metadata.js");
const { readManifest } = await import("../src/c2pa.js");
const { EDIT_THUMBNAIL_TOO_LARGE_REASON, ReadBackFault, THUMBNAIL_MAX_BYTES } = await import("../src/prepare.js");
const { cameraPhoto } = await import("./cameraPhoto.js");
const emptySource = { load: async () => [] };

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const OWNER = getAddress("0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6");
const STRANGER = getAddress("0x1111111111111111111111111111111111111111");
const PARENT = `0x${"ab".repeat(32)}` as Hex;
const HASH = `0x${"11".repeat(32)}` as Hex;
const PASSPORT_REGISTERED = toEventSelector(
  "PassportRegistered(bytes32,address,uint256,bytes32,uint64,bytes32,bytes32,uint8,uint8,string)",
);

interface SentChild {
  exactHash: Hex;
  parentId: Hex;
  creator: Hex;
}

/** The calldata of the last send. */
function lastSentData(): Hex {
  return (stubs.send.mock.lastCall?.[2] as { data: Hex }).data;
}

/** The child in the calldata of the last send. */
function lastSentChild(): SentChild {
  const [input] = decodeFunctionData({ abi: registryEditAbi, data: lastSentData() }).args as unknown as [SentChild];
  return input;
}

/** The registry's event for the last send's child, with the creator and parent it was written under. */
function registeredLog(changes: { creator?: Hex; parentId?: Hex } = {}): { address: Hex; topics: Hex[]; data: Hex } {
  return registeredEventLog(env.MOOLAM_REGISTRY_ADDRESS as Hex, lastSentData(), changes);
}

/** The receipt of a bundle whose inner call ran: it carries the registry's event for the child that was sent. */
async function landedReceipt(): Promise<{ status: "success"; logs: { address: Hex; topics: Hex[]; data: Hex }[] }> {
  return { status: "success", logs: [registeredLog()] };
}

let signing: CryptoKey;
let verifying: CryptoKey;
let app: FastifyInstance;
let picture: Buffer;
/** How many of the next uploads to Pinata are answered with a failure instead of a cid. */
let pinFailures = 0;
/** How many of the next uploads Pinata refuses with a 4xx, the one answer after which nothing landed. */
let pinRefusals = 0;
/** How many files this request pinned, so a refusal before any pin can be proven. */
let pins = 0;
/** Every file the stub pinned, by the name the route gave it, so a signed edit can be read back. */
const pinnedFiles = new Map<string, Buffer>();
/** Stands in for the shared prepare gate so the route's own handling of Busy can be exercised. */
const prepareGate = vi.fn(async (task: () => Promise<unknown>) => await task());

async function token(subject: string): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("privy.io")
    .setAudience(SETTINGS.appId)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signing);
}

/** A multipart body with the edited picture and the three text fields the route reads. */
function editBody(
  fields: Record<string, string>,
  content: Buffer,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----moolameditest";
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="edited.jpg"\r\n` +
        `Content-Type: image/jpeg\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function ask(
  subject: string,
  fields: Record<string, string>,
  options: { auth?: boolean; image?: Buffer } = {},
) {
  const { payload, headers } = editBody(fields, options.image ?? picture);
  return await app.inject({
    method: "POST",
    url: "/edit",
    payload,
    headers: {
      ...headers,
      ...(options.auth === false ? {} : { authorization: `Bearer ${await token(subject)}` }),
    },
    remoteAddress: "203.0.113.41",
  });
}

function goodFields(note = "brightened the sky") {
  return { title: "Monsoon nets, brightened", parentId: PARENT, note };
}

describe("POST /edit", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;
    picture = await makeImage(12);

    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== UPLOAD_URL) {
        return await realFetch(input, init);
      }
      if (pinFailures > 0) {
        pinFailures -= 1;
        return new Response("gateway said no", { status: 500 });
      }
      if (pinRefusals > 0) {
        pinRefusals -= 1;
        return new Response("over the plan", { status: 403 });
      }
      pins += 1;
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      pinnedFiles.set(String(form.get("name")), bytes);
      return new Response(JSON.stringify({ data: { cid: contentIdOf(bytes), size: bytes.length, network: "public" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    app = await buildServer({ source: emptySource, logger: false, edit: { keys: verifying } });
    app.verifier.runPrepare = ((task: () => Promise<unknown>) =>
      prepareGate(task)) as typeof app.verifier.runPrepare;
    await app.ready();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await app.close();
  });

  beforeEach(() => {
    pinFailures = 0;
    pinRefusals = 0;
    pins = 0;
    prepareGate.mockClear();
    // The route reads the registry twice: the parent must be there, and the child must not.
    stubs.passportExists.mockReset().mockImplementation(async (_chain, _registry, id: Hex) => id === PARENT);
    stubs.delegatedWallets.mockReset().mockResolvedValue([{ id: "privy-wallet-1", address: OWNER }]);
    stubs.walletSigners
      .mockReset()
      .mockResolvedValue([{ signerId: SETTINGS.signerId, policyIds: [SETTINGS.policyId] }]);
    stubs.parentOwner.mockReset().mockResolvedValue(OWNER);
    stubs.estimateEditGas.mockReset().mockResolvedValue(420_000n);
    stubs.send
      .mockReset()
      .mockResolvedValue({ hash: HASH, sponsored: true, transactionId: "privy-tx-1" });
    stubs.receipt.mockReset().mockImplementation(landedReceipt);
    stubs.readPassport.mockReset().mockResolvedValue(undefined);
    stubs.samePrepared = false;
    stubs.prepared = undefined;
  });

  /** What this creator has spent of the daily allowance, read off an edit that goes through. */
  async function usedAfter(user: string): Promise<number> {
    const next = await ask(user, goodFields("the one after"));
    expect(next.statusCode).toBe(200);
    return next.json().quota.used as number;
  }

  it("refuses a request with no token before it reads the chain or Privy", async () => {
    const response = await ask("did:privy:no-token", goodFields(), { auth: false });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
    expect(stubs.passportExists).not.toHaveBeenCalled();
    expect(stubs.delegatedWallets).not.toHaveBeenCalled();
  });

  it("answers 409 no-signer when the creator has granted no wallet this app can sign on", async () => {
    stubs.delegatedWallets.mockResolvedValueOnce([]);

    const response = await ask("did:privy:no-signer-user", goodFields());

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "no-signer" });
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it("answers 403 not-owner when the parent belongs to another address", async () => {
    stubs.parentOwner.mockResolvedValueOnce(STRANGER);

    const response = await ask("did:privy:not-owner-user", goodFields());

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "not-owner" });
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it("answers 404 no-parent for a passport id the registry does not hold", async () => {
    stubs.passportExists.mockResolvedValueOnce(false);

    const response = await ask("did:privy:no-parent-user", goodFields());

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "no-parent" });
    expect(stubs.delegatedWallets).not.toHaveBeenCalled();
  });

  it("refuses a bad parent id, a missing title and an over-long note", async () => {
    const bodies = [
      { ...goodFields(), parentId: "0xnothex" },
      { ...goodFields(), title: "" },
      { ...goodFields(), note: "x".repeat(281) },
    ];

    for (const fields of bodies) {
      const response = await ask("did:privy:bad-fields", fields);
      expect(response.statusCode, JSON.stringify(fields).slice(0, 80)).toBe(400);
    }
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it("stops a creator at EDITS_PER_DAY and lets them back in a day later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-13T09:00:00Z"));
    const user = "did:privy:quota-user";

    expect((await ask(user, goodFields("first"))).statusCode).toBe(200);
    expect((await ask(user, goodFields("second"))).statusCode).toBe(200);

    const sendsBefore = stubs.send.mock.calls.length;
    const refused = await ask(user, goodFields("third"));
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toBe("quota");
    expect(refused.json().quota).toEqual({ used: 2, limit: 2, resetsAt: expect.any(Number) });
    expect(stubs.send.mock.calls.length).toBe(sendsBefore);

    // The count is per verified user id, so another creator is untouched by it.
    expect((await ask("did:privy:other-user", goodFields())).statusCode).toBe(200);

    vi.setSystemTime(new Date("2026-09-14T09:00:01Z"));
    expect((await ask(user, goodFields("next day"))).statusCode).toBe(200);
    vi.useRealTimers();
  }, 120_000);

  it("sends appendEdit for the child passport and answers with the hash Privy returned", async () => {
    const response = await ask("did:privy:edit-user", goodFields("cropped the mast out"));

    expect(response.statusCode).toBe(200);
    const answer = response.json();

    expect(stubs.send).toHaveBeenCalledTimes(1);
    const sent = stubs.send.mock.calls[0]?.[2] as { to: Hex; data: Hex; gasLimit: bigint; sponsor: boolean };
    const call = decodeFunctionData({ abi: registryEditAbi, data: sent.data });
    expect(call.functionName).toBe("appendEdit");

    const [input, generatorSig] = call.args as unknown as [Record<string, unknown>, Hex];
    expect(input.parentId).toBe(PARENT);
    expect(input.creator).toBe(OWNER);
    expect(input.exactHash).toBe(answer.child.exactHash);
    expect(input.kind).toBe(2);
    expect(input.generatorAgentId).toBe(0n);
    expect(generatorSig).toBe("0x");
    expect(sent.sponsor).toBe(true);
    expect(sent.gasLimit).toBe(420_000n);

    expect(answer.hash).toBe(HASH);
    expect(answer.sponsored).toBe(true);
    expect(answer.tokenId).toBe(BigInt(answer.child.exactHash as Hex).toString());
    expect(answer.child.parentId).toBe(PARENT);
    expect(answer.child.creator).toBe(OWNER);
    expect(answer.manifest).toEqual({ embedded: true });
    expect(answer.quota).toEqual({ used: 1, limit: 2, resetsAt: expect.any(Number) });
    expect(answer.image.gatewayUrl).toMatch(/^https:\/\/moolam-test\.mypinata\.cloud\/ipfs\//);
    expect(JSON.stringify(answer)).not.toContain("test-token-not-a-real-pinata-jwt");

    // The decode is the one part of the route that runs behind the service's shared prepare gate.
    expect(prepareGate).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("gives the daily slot back when Pinata refused every pin, so nothing landed", async () => {
    const user = "did:privy:pin-refused-user";
    // The picture, the thumbnail and the manifest go up at once, and a 4xx is never retried.
    pinRefusals = 3;

    const refused = await ask(user, goodFields());

    expect(refused.statusCode).toBe(502);
    expect(refused.json()).toEqual({ error: "pin-failed" });
    expect(stubs.send).not.toHaveBeenCalled();
    expect(await usedAfter(user)).toBe(1);
  }, 60_000);

  it("V58: keeps the daily slot when the pins failed after their bytes left, since they may have landed", async () => {
    const user = "did:privy:pin-fail-user";
    // pinFile tries a 500 three times, so nine failures is what it takes for none of the three to answer.
    pinFailures = 9;

    const refused = await ask(user, goodFields());

    expect(refused.statusCode).toBe(502);
    expect(refused.json()).toEqual({ error: "pin-failed" });
    expect(stubs.send).not.toHaveBeenCalled();
    expect(await usedAfter(user)).toBe(2);
  }, 60_000);

  it("V58: keeps the daily slot when the registry refuses the edit after the pins landed", async () => {
    const user = "did:privy:estimate-fail-user";
    stubs.estimateEditGas.mockRejectedValueOnce(new Error("execution reverted"));

    const refused = await ask(user, goodFields());

    expect(refused.statusCode).toBe(502);
    expect(refused.json().error).toBe("send-failed");
    expect(stubs.send).not.toHaveBeenCalled();
    expect(pins).toBeGreaterThanOrEqual(3);
    expect(await usedAfter(user)).toBe(2);
  }, 60_000);

  it("answers 415 rather than 500 for a picture whose header reads but whose pixels do not, and gives the slot back", async () => {
    const user = "did:privy:truncated-user";
    const truncated = picture.subarray(0, Math.floor(picture.length * 0.55));

    const refused = await ask(user, goodFields(), { image: truncated });

    expect(refused.statusCode).toBe(415);
    expect(refused.json().error).toBe("not-an-image");
    expect(stubs.send).not.toHaveBeenCalled();
    expect(await usedAfter(user)).toBe(1);
  }, 60_000);

  it("intake 4: answers 422 thumbnail-too-large for a real picture too detailed for the budget, and gives the slot back", async () => {
    const user = "did:privy:noise-user";
    const side = 512;
    const raw = Buffer.alloc(side * side * 3);
    let state = 4242;
    for (let i = 0; i < raw.length; i += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      raw[i] = (state >> 16) & 0xff;
    }
    const noise = await sharp(raw, { raw: { width: side, height: side, channels: 3 } }).png().toBuffer();

    const refused = await ask(user, goodFields(), { image: noise });

    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toEqual({
      error: "thumbnail-too-large",
      limit: THUMBNAIL_MAX_BYTES,
      reason: EDIT_THUMBNAIL_TOO_LARGE_REASON,
    });
    expect(pins).toBe(0);
    expect(stubs.send).not.toHaveBeenCalled();
    expect(await usedAfter(user)).toBe(1);
  }, 60_000);

  it("V17: refuses the review's SVG with 415 in milliseconds, before the gate, a pin or the chain", async () => {
    const started = performance.now();

    const refused = await ask("did:privy:svg-user", goodFields(), { image: FILTER_BOMB_SVG });

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(refused.statusCode).toBe(415);
    expect(refused.json()).toEqual({ error: "not-an-image" });
    expect(prepareGate).not.toHaveBeenCalled();
    expect(pins).toBe(0);
    expect(stubs.passportExists).not.toHaveBeenCalled();
  }, 60_000);

  it("V22: signs an edit as a file Moolam opened and the creator edited, with no source type", async () => {
    const response = await ask("did:privy:source-user", goodFields());

    expect(response.statusCode).toBe(200);
    const child = response.json().child as { exactHash: Hex };
    const signed = pinnedFiles.get(`${fileSlug(goodFields().title, child.exactHash)}.jpg`) as Buffer;
    const reader = await Reader.fromAsset({ buffer: signed, mimeType: "image/jpeg" });
    const actions = (reader?.getActive()?.assertions ?? [])
      .filter((one) => one.label?.startsWith("c2pa.actions"))
      .flatMap((one) => (one.data as { actions: Record<string, unknown>[] }).actions);

    expect(actions.map((one) => one.action)).toEqual(["c2pa.opened", "c2pa.edited"]);
    expect(JSON.stringify(actions)).not.toContain("digitalSourceType");
    expect(JSON.stringify(actions)).not.toContain("minorHumanEdits");
    expect((await readManifest(signed)).validation).toBe("valid");
  }, 60_000);

  it("camera record: answers kept for a camera's signed photo, nothing for a plain one, and passes the logger", async () => {
    stubs.prepareOptions.length = 0;
    const camera = await ask("did:privy:camera-edit-user", goodFields("warmer"), { image: await cameraPhoto(94) });
    const plain = await ask("did:privy:camera-edit-user", goodFields("cooler"), { image: await makeImage(94) });

    expect(camera.statusCode).toBe(200);
    expect(camera.json().manifest).toEqual({ embedded: true, cameraRecord: "kept" });
    expect(plain.statusCode).toBe(200);
    expect(plain.json().manifest).toEqual({ embedded: true });
    expect(stubs.prepareOptions).toHaveLength(2);
    for (const options of stubs.prepareOptions) {
      expect(typeof (options.log as { warn?: unknown } | undefined)?.warn).toBe("function");
    }
  }, 60_000);

  it("answers 503 busy and gives the daily slot back when no prepare slot comes free", async () => {
    const user = "did:privy:busy-user";
    prepareGate.mockRejectedValueOnce(new Busy(60_000));

    const refused = await ask(user, goodFields());

    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual({ error: "busy" });
    expect(await usedAfter(user)).toBe(1);
  }, 60_000);

  it("answers send-failed and keeps the daily slot when Privy reports the send reverted", async () => {
    const user = "did:privy:reverted-user";
    stubs.send.mockRejectedValueOnce(new SponsoredSendFailed("privy-tx-9", "execution_reverted", HASH));

    const refused = await ask(user, goodFields());

    expect(refused.statusCode).toBe(502);
    expect(refused.json().error).toBe("send-failed");
    expect(refused.json().reason).toContain("execution_reverted");
    expect(await usedAfter(user)).toBe(2);
  }, 60_000);

  it("answers send-pending, not send-failed, when the send never reported a hash", async () => {
    stubs.send.mockRejectedValueOnce(new SponsoredSendPending("privy-tx-10", 60_000));

    const refused = await ask("did:privy:pending-user", goodFields());

    expect(refused.statusCode).toBe(502);
    expect(refused.json()).toEqual({
      error: "send-pending",
      transactionId: "privy-tx-10",
      passportId: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
  }, 60_000);

  it("names the child on a send-pending, so the browser watches one passport and not the parent's list", async () => {
    stubs.send.mockRejectedValueOnce(new SponsoredSendPending("privy-tx-11", 60_000));

    const refused = await ask("did:privy:pending-id-user", goodFields("the one that never confirmed"));

    expect(refused.statusCode).toBe(502);
    // The id in the answer is the id of the passport that transaction would write, read back out
    // of the calldata Privy was handed.
    const sent = stubs.send.mock.lastCall?.[2] as { data: Hex };
    const [input] = decodeFunctionData({ abi: registryEditAbi, data: sent.data }).args as unknown as [
      Record<string, unknown>,
    ];
    expect(refused.json().passportId).toBe(input.exactHash);
  }, 60_000);

  it("answers 409 already-registered before a single byte is pinned when the child is on chain", async () => {
    const user = "did:privy:duplicate-user";
    stubs.passportExists.mockResolvedValue(true);

    const refused = await ask(user, goodFields("the same edit twice"));

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({
      error: "already-registered",
      passportId: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
    expect(pins).toBe(0);
    expect(stubs.send).not.toHaveBeenCalled();
    // Nothing was pinned and nothing was sent, so the day's allowance is given back.
    stubs.passportExists.mockImplementation(async (_chain, _registry, id: Hex) => id === PARENT);
    expect(await usedAfter(user)).toBe(1);
  }, 60_000);

  it("pins and sends when the duplicate check cannot reach the chain, because the registry refuses a duplicate itself", async () => {
    stubs.passportExists
      .mockImplementationOnce(async () => true)
      .mockImplementationOnce(async () => {
        throw new Error("fetch failed");
      });

    const response = await ask("did:privy:duplicate-check-down-user", goodFields());

    expect(response.statusCode).toBe(200);
    expect(stubs.send).toHaveBeenCalled();
  }, 60_000);

  it("answers send-failed when the chain reverted the edit the hash belongs to", async () => {
    stubs.receipt.mockResolvedValueOnce({ status: "reverted" });

    const refused = await ask("did:privy:receipt-reverted-user", goodFields());

    expect(refused.statusCode).toBe(502);
    expect(refused.json()).toEqual({ error: "send-failed", reason: "reverted" });
  }, 60_000);

  // V14: a sponsored send is a user operation inside a bundle, and the bundle succeeds even when
  // the appendEdit inside it reverted. Only the registry's own event says the child was written.
  it("answers send-failed when the bundle landed but the registry wrote no child, and appended when it did", async () => {
    stubs.receipt.mockResolvedValueOnce({ status: "success", logs: [] });

    const refused = await ask("did:privy:user-op-reverted", goodFields());

    expect(refused.statusCode).toBe(502);
    expect(refused.json().error).toBe("send-failed");
    expect(refused.json().reason).toMatch(/user operation reverted/);
    expect(refused.json().passportId).toMatch(/^0x[0-9a-f]{64}$/);

    // An event for some other passport, or from another contract, is not this edit either.
    stubs.receipt.mockImplementationOnce(async () => {
      const landed = await landedReceipt();
      const log = landed.logs[0] as { address: Hex; topics: Hex[] };
      return {
        status: "success",
        logs: [
          { address: log.address, topics: [PASSPORT_REGISTERED, `0x${"77".repeat(32)}` as Hex] },
          { address: getAddress("0x2222222222222222222222222222222222222222"), topics: log.topics },
        ],
      };
    });
    const elsewhere = await ask("did:privy:user-op-elsewhere", goodFields("another note"));
    expect(elsewhere.statusCode).toBe(502);
    expect(elsewhere.json().error).toBe("send-failed");

    const appended = await ask("did:privy:user-op-landed", goodFields("a third note"));
    expect(appended.statusCode).toBe(200);
  }, 60_000);

  it("answers send-pending with the hash when the receipt does not arrive in time", async () => {
    stubs.receipt.mockResolvedValueOnce(undefined);

    const refused = await ask("did:privy:receipt-pending-user", goodFields());

    expect(refused.statusCode).toBe(502);
    expect(refused.json()).toEqual({
      error: "send-pending",
      transactionId: "privy-tx-1",
      hash: HASH,
      passportId: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
  }, 60_000);

  it("edits from the delegated wallet that holds the parent, not the first one listed", async () => {
    stubs.delegatedWallets.mockResolvedValueOnce([
      { id: "privy-wallet-cold", address: STRANGER },
      { id: "privy-wallet-2", address: OWNER },
    ]);

    const response = await ask("did:privy:two-wallets-user", goodFields());

    expect(response.statusCode).toBe(200);
    expect(stubs.walletSigners.mock.lastCall?.[1]).toBe("privy-wallet-2");
    expect(stubs.send.mock.lastCall?.[1]).toBe("privy-wallet-2");
    expect(response.json().child.creator).toBe(OWNER);
  }, 60_000);

  it("answers privy-unavailable when Privy cannot say who signs on the wallet", async () => {
    stubs.walletSigners.mockRejectedValueOnce(
      new APIError(503, { code: "service_unavailable" }, "upstream", undefined),
    );

    const refused = await ask("did:privy:privy-down-user", goodFields());

    expect(refused.statusCode).toBe(502);
    expect(refused.json()).toEqual({ error: "privy-unavailable" });
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it("answers chain-unavailable when the ownership read cannot reach Monad", async () => {
    stubs.parentOwner.mockRejectedValueOnce(new Error("fetch failed"));

    const refused = await ask("did:privy:rpc-down-user", goodFields());

    expect(refused.statusCode).toBe(502);
    expect(refused.json()).toEqual({ error: "chain-unavailable" });
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it("logs a signing read-back fault as one, not as failed fingerprinting, and answers 503 service-fault", async () => {
    const logged = vi.spyOn(app.log, "error");
    stubs.prepareFault = new ReadBackFault("The C2PA reader could not read back the JPEG just signed.");
    try {
      const refused = await ask("did:privy:readback-log-user", goodFields());
      expect(refused.statusCode).toBe(503);
      expect(refused.json().error).toBe("service-fault");
      const lines = logged.mock.calls.map((call) => call[1]);
      expect(lines).toContain("rejected: /edit signing read-back fault");
      expect(lines).not.toContain("rejected: /edit the service failed fingerprinting");
    } finally {
      logged.mockRestore();
    }
  }, 60_000);

  // Review pass 10, intake #4 (V95): the unsigned fallback gives one file one child id, so a key made
  // from the child alone blocked every retry for a day and could bind another holder's send.
  describe("V95: a send key per wallet and exact call, and an appended answer only for this creator and parent", () => {
    it("sends two edits of one child id with different deadlines under different keys", async () => {
      stubs.samePrepared = true;
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-09-27T09:00:00Z"));
        expect((await ask("did:privy:v95-retry-user", goodFields())).statusCode).toBe(200);
        const first = lastSentChild();
        vi.setSystemTime(new Date("2026-09-27T09:05:00Z"));
        expect((await ask("did:privy:v95-retry-user", goodFields())).statusCode).toBe(200);
        const second = lastSentChild();

        expect(second.exactHash).toBe(first.exactHash);
        const [one, two] = stubs.send.mock.calls.map((call) => call[2] as { idempotencyKey: string; data: Hex });
        expect(one?.data).not.toBe(two?.data);
        expect(one?.idempotencyKey).toMatch(/^moolam-edit-[0-9a-f]{64}$/);
        expect(two?.idempotencyKey).toMatch(/^moolam-edit-[0-9a-f]{64}$/);
        expect(one?.idempotencyKey).not.toBe(two?.idempotencyKey);
      } finally {
        vi.useRealTimers();
      }
    }, 60_000);

    it("never answers appended for a child whose event or chain record names another creator or another parent", async () => {
      const other = `0x${"cd".repeat(32)}` as Hex;
      const cases: { label: string; creator?: Hex; parentId?: Hex }[] = [
        { label: "another creator", creator: STRANGER },
        { label: "another parent", parentId: other },
      ];
      for (const [index, one] of cases.entries()) {
        stubs.receipt.mockImplementationOnce(async () => ({
          status: "success",
          logs: [registeredLog(one)],
        }));
        const refused = await ask(`did:privy:v95-event-${index}`, goodFields(`event ${one.label}`));
        expect(refused.statusCode, one.label).toBe(502);
        expect(refused.json().error, one.label).toBe("send-failed");
      }

      for (const [index, one] of cases.entries()) {
        stubs.send.mockClear();
        stubs.passportExists.mockImplementation(
          async (_chain, _registry, id: Hex) => id === PARENT || stubs.send.mock.calls.length > 0,
        );
        stubs.readPassport.mockImplementation(async (_chain: unknown, _registry: unknown, id: Hex) =>
          id === PARENT || stubs.send.mock.calls.length === 0
            ? undefined
            : { creator: one.creator ?? OWNER, parentId: one.parentId ?? PARENT, registeredAt: 1_758_000_000 },
        );
        stubs.receipt.mockResolvedValueOnce({ status: "reverted" });
        const refused = await ask(`did:privy:v95-chain-${index}`, goodFields(`chain ${one.label}`));
        expect(refused.statusCode, one.label).toBe(502);
        expect(refused.json().error, one.label).toBe("send-failed");
      }
    }, 60_000);
  });

  // V89: one child is one appendEdit, so the send carries a key derived from the
  // child, and a send reported dead or reverted is read against the chain before it is called failed.
  describe("V89: an edit the chain holds is never answered send-failed", () => {
    /**
     * The child is on chain once a send has gone out, and never before, so the duplicate check
     * passes. The chain's record names the creator and the parent this edit was sent for.
     */
    function childOnChainAfterTheSend(creator: Hex = OWNER): void {
      stubs.passportExists.mockImplementation(
        async (_chain, _registry, id: Hex) => id === PARENT || stubs.send.mock.calls.length > 0,
      );
      stubs.readPassport.mockImplementation(async (_chain: unknown, _registry: unknown, id: Hex) =>
        id === PARENT || stubs.send.mock.calls.length === 0
          ? undefined
          : { creator, parentId: PARENT, registeredAt: 1_758_000_000 },
      );
    }

    it("sends under an idempotency key derived from the wallet and the exact calldata (V95)", async () => {
      const response = await ask("did:privy:idempotent-user", goodFields());

      expect(response.statusCode).toBe(200);
      const sent = stubs.send.mock.lastCall?.[2] as { data: Hex; idempotencyKey: string };
      expect(sent.idempotencyKey).toBe(callIdempotencyKey("moolam-edit", "privy-wallet-1", sent.data));
    }, 60_000);

    it("answers success for a revert whose child is on chain under the creator's wallet", async () => {
      childOnChainAfterTheSend();
      stubs.receipt.mockResolvedValueOnce({ status: "reverted", reason: "AlreadyRegistered" });

      const response = await ask("did:privy:reverted-but-landed-user", goodFields());

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ hash: HASH, child: { creator: OWNER } });
    }, 60_000);

    it("answers success when the bundle wrote no child but the child is on chain, and when Privy called a hashed send dead", async () => {
      childOnChainAfterTheSend();
      stubs.receipt.mockResolvedValueOnce({ status: "success", logs: [] });
      expect((await ask("did:privy:no-event-but-landed-user", goodFields())).statusCode).toBe(200);

      stubs.send.mockClear();
      stubs.send.mockRejectedValueOnce(new SponsoredSendFailed("privy-tx-11", "execution_reverted", HASH));
      const dead = await ask("did:privy:dead-but-landed-user", goodFields());
      expect(dead.statusCode).toBe(200);
      expect(dead.json().hash).toBe(HASH);
    }, 60_000);

    it("still answers send-failed when the child on chain belongs to another address, or the chain cannot say", async () => {
      childOnChainAfterTheSend(STRANGER);
      stubs.receipt.mockResolvedValueOnce({ status: "reverted" });
      const elsewhere = await ask("did:privy:front-run-user", goodFields());
      expect(elsewhere.statusCode).toBe(502);
      expect(elsewhere.json().error).toBe("send-failed");

      stubs.send.mockClear();
      stubs.passportExists.mockImplementation(async (_chain, _registry, id: Hex) => id === PARENT);
      stubs.readPassport.mockImplementation(async () => {
        if (stubs.send.mock.calls.length > 0) throw new Error("fetch failed");
        return undefined;
      });
      stubs.receipt.mockResolvedValueOnce({ status: "reverted" });
      const unreadable = await ask("did:privy:chain-silent-user", goodFields());
      expect(unreadable.statusCode).toBe(502);
      expect(unreadable.json().error).toBe("send-failed");
    }, 60_000);
  });
});
