// Covers POST /generate with the image model, Pinata, the caller's wallet list and the Privy
// signer all stubbed: the whole route from a signed-in creator's prompt to a passport the browser
// can co-sign, the generator signature recovering to the wallet that made it, a creator address
// that is not the caller's, a deadline that runs out while the picture is drawn, the daily quota
// on a fake clock and which failures give a quota slot back, a prompt the model refuses, a body
// that does not parse, and the waiting gate giving up.
// Does NOT cover the real image model, a real pin, or Privy actually signing or listing wallets:
// the live check in the work order does all of those against the hosted services. It also does
// not cover the browser side, which adds the passkey signature and sends the transaction.

import { SignJWT, generateKeyPair } from "jose";
import { APIError, APIConnectionError } from "openai";
import { getAddress, recoverAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { PASSPORT_TYPES, passportDigest, type PassportInput } from "../src/generate/eip712.js";
import { Busy, waitingGate } from "../src/generate/gate.js";
import { fileSlug } from "../src/metadata.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import { makeImage } from "./helpers.js";

// env.ts validates once at import, so everything the route reads has to be set before any module
// in this file loads. vi.hoisted runs before the imports above. The Pinata token is a fake: every
// call to Pinata is answered by the stub below. No image model key is set at all, which is also
// what proves the route stays off a host that has none.
const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000002";
  process.env.PRIVY_APP_ID = id;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.GENERATE_PER_DAY = "2";
  process.env.GENERATOR_AGENT_ID = "10249";
  return id;
});

const stubs = vi.hoisted(() => ({
  createImage: vi.fn(),
  sign: vi.fn(),
  wallet: vi.fn(),
  embeddedWallets: vi.fn(),
}));

vi.mock("../src/auth/wallet.js", () => ({ embeddedWallets: stubs.embeddedWallets }));

vi.mock("../src/generate/imageModel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/imageModel.js")>()),
  createImage: stubs.createImage,
}));

vi.mock("../src/generate/generatorSigner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/generatorSigner.js")>()),
  generatorWallet: stubs.wallet,
  signPassportAsGenerator: stubs.sign,
}));

const { PromptRefused, billedOrUnknown } = await import("../src/generate/imageModel.js");
const { generatorDomain } = await import("../src/generate/generatorSigner.js");
const { buildServer } = await import("../src/server.js");

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const PROMPT = "A lighthouse in a monsoon storm, painted in thick oils";
const MODEL = "gpt-image-1-mini";
const emptySource: PassportSource = { load: async () => [] };

/** Every file the stub was asked to pin, by the name the route gave it. */
const pinned = new Map<string, Buffer>();

/**
 * What Privy says the signed-in caller's own embedded wallets are. The route asks with the user
 * id alone, so one list stands for every user in this file, and a test that needs a mismatch asks
 * for an address that is not on it.
 */
let callerWallets: Hex[] = [];
let signing: CryptoKey;
let verifying: CryptoKey;
let agent: PrivateKeyAccount;
let app: FastifyInstance;

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

function deadline(): number {
  return Math.floor(Date.now() / 1000) + 1800;
}

async function ask(
  subject: string,
  body: Record<string, unknown>,
  auth = true,
): Promise<ReturnType<FastifyInstance["inject"]> extends Promise<infer R> ? R : never> {
  return await app.inject({
    method: "POST",
    url: "/generate",
    payload: body,
    headers: auth ? { authorization: `Bearer ${await token(subject)}` } : {},
    remoteAddress: "203.0.113.40",
  });
}

/** The passport in the answer, back in the shape the digest is built from. */
function inputFrom(passport: Record<string, string | number>): PassportInput {
  return {
    exactHash: passport.exactHash as Hex,
    parentId: passport.parentId as Hex,
    creator: passport.creator as Hex,
    generatorAgentId: BigInt(passport.generatorAgentId as string),
    phash: BigInt(passport.phash as string),
    blockhash256: passport.blockhash256 as Hex,
    manifestHash: passport.manifestHash as Hex,
    kind: passport.kind as 0,
    fingerprintVersion: passport.fingerprintVersion as number,
    metadataURI: passport.metadataURI as string,
    deadline: BigInt(passport.deadline as string),
  };
}

describe("POST /generate", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;
    agent = privateKeyToAccount(generatePrivateKey());

    stubs.wallet.mockImplementation(async () => ({ id: "moolam-test-generator", address: agent.address }));
    stubs.sign.mockImplementation(
      async (_id: string, _address: Hex, input: PassportInput, dom: Parameters<typeof passportDigest>[1]) =>
        await agent.signTypedData({
          domain: dom,
          types: PASSPORT_TYPES,
          primaryType: "Passport",
          message: input,
        }),
    );
    callerWallets = [
      "0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6",
      "0x2222222222222222222222222222222222222222",
      "0x3333333333333333333333333333333333333333",
      "0x4444444444444444444444444444444444444444",
      "0x5555555555555555555555555555555555555555",
    ].map((address) => getAddress(address as Hex));
    stubs.embeddedWallets.mockImplementation(async () => callerWallets);
    stubs.createImage.mockImplementation(async (prompt: string) => ({
      bytes: await makeImage(prompt.length % 40),
      model: MODEL,
      promptUsed: prompt,
    }));

    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== UPLOAD_URL) {
        return await realFetch(input, init);
      }
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      pinned.set(String(form.get("name")), bytes);
      return new Response(JSON.stringify({ data: { cid: `bafygen${pinned.size}`, size: bytes.length } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    app = await buildServer({ source: emptySource, logger: false, generate: { keys: verifying } });
    await app.ready();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await app.close();
  });

  it("draws, pins and hands back a passport the generator has signed", async () => {
    const creator = "0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6";
    const title = "Lighthouse in a monsoon storm";
    const response = await ask("did:privy:draw-user", {
      prompt: PROMPT,
      title,
      creator,
      deadline: deadline(),
    });

    expect(response.statusCode).toBe(200);
    const answer = response.json();

    expect(stubs.createImage).toHaveBeenCalledWith(PROMPT, { timeoutMs: 60_000 });
    expect(answer.passport.kind).toBe(0);
    expect(answer.passport.parentId).toBe(`0x${"00".repeat(32)}`);
    expect(answer.passport.generatorAgentId).toBe("10249");
    expect(answer.passport.creator).toBe(getAddress(creator as Hex));
    expect(answer.passport.fingerprintVersion).toBe(1);
    expect(answer.passport.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(answer.manifest).toEqual({ embedded: true });
    expect(answer.model).toBe(MODEL);
    expect(answer.agent).toEqual({ id: "10249", wallet: agent.address });
    expect(answer.preparedBy).toBe("did:privy:draw-user");
    expect(answer.quota).toEqual({ used: 1, limit: 2, resetsAt: expect.any(Number) });
    expect(answer.image.gatewayUrl).toMatch(/^https:\/\/moolam-test\.mypinata\.cloud\/ipfs\//);
    expect(JSON.stringify(answer)).not.toContain("test-token-not-a-real-pinata-jwt");

    const slug = fileSlug(title, answer.passport.exactHash);
    const metadata = JSON.parse((pinned.get(`${slug}.json`) as Buffer).toString("utf8"));
    expect(metadata.prompt).toBe(PROMPT);
    expect(metadata.model).toBe(MODEL);
    expect(metadata.generator.agentId).toBe("10249");
    expect(answer.passport.metadataURI).toMatch(/^ipfs:\/\/.+/);

    const recovered = await recoverAddress({
      hash: passportDigest(inputFrom(answer.passport), generatorDomain()),
      signature: answer.generatorSig as Hex,
    });
    expect(answer.generatorSig).toMatch(/^0x[0-9a-f]{130}$/i);
    expect(getAddress(recovered)).toBe(agent.address);
  }, 60_000);

  it("refuses a request with no token before the model is called", async () => {
    const callsBefore = stubs.createImage.mock.calls.length;

    const response = await ask(
      "did:privy:no-token",
      { prompt: PROMPT, title: "No token", creator: "0x1111111111111111111111111111111111111111", deadline: deadline() },
      false,
    );

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
    expect(stubs.createImage.mock.calls.length).toBe(callsBefore);
  });

  it("stops a creator at GENERATE_PER_DAY and lets them back in a day later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-13T09:00:00Z"));
    const user = "did:privy:quota-user";
    const body = (n: number) => ({
      prompt: `${PROMPT}, take ${n}`,
      title: `Quota ${n}`,
      creator: "0x2222222222222222222222222222222222222222",
      deadline: deadline(),
    });

    expect((await ask(user, body(1))).statusCode).toBe(200);
    expect((await ask(user, body(2))).statusCode).toBe(200);

    const callsBefore = stubs.createImage.mock.calls.length;
    const refused = await ask(user, body(3));
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toBe("quota");
    expect(refused.json().quota).toEqual({ used: 2, limit: 2, resetsAt: expect.any(Number) });
    expect(stubs.createImage.mock.calls.length).toBe(callsBefore);

    // Another creator is untouched by that, because the count is per verified user id.
    expect((await ask("did:privy:other-user", body(4))).statusCode).toBe(200);

    vi.setSystemTime(new Date("2026-09-14T09:00:01Z"));
    expect((await ask(user, body(5))).statusCode).toBe(200);
    vi.useRealTimers();
  }, 120_000);

  it("passes a refused prompt back as 400 prompt-refused", async () => {
    stubs.createImage.mockRejectedValueOnce(
      new PromptRefused("Your request was rejected as a result of our safety system."),
    );

    const response = await ask("did:privy:refused-user", {
      prompt: "something the safety system will not draw",
      title: "Refused",
      creator: "0x3333333333333333333333333333333333333333",
      deadline: deadline(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("prompt-refused");
    expect(response.json().reason).toMatch(/safety system/);
  });

  it("refuses a short prompt, a missing title, a bad creator and a deadline outside the window", async () => {
    const good = {
      prompt: PROMPT,
      title: "Fine title",
      creator: "0x4444444444444444444444444444444444444444",
      deadline: deadline(),
    };
    const bodies = [
      { ...good, prompt: "short" },
      { ...good, title: "" },
      { ...good, creator: "0xnothexnothexnothexnothexnothexnothexnot" },
      { ...good, deadline: Math.floor(Date.now() / 1000) + 60 },
      { ...good, deadline: Math.floor(Date.now() / 1000) + 3 * 60 * 60 },
    ];

    for (const body of bodies) {
      const response = await ask("did:privy:bad-body", body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("refuses 403 creator-mismatch when the creator is not one of the caller's wallets", async () => {
    const callsBefore = stubs.createImage.mock.calls.length;

    const response = await ask("did:privy:mismatch-user", {
      prompt: PROMPT,
      title: "Someone else's wallet",
      creator: "0x9999999999999999999999999999999999999999",
      deadline: deadline(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "creator-mismatch" });
    expect(stubs.createImage.mock.calls.length).toBe(callsBefore);
  });

  it("refuses to sign when drawing ate the deadline, and the picture still costs a slot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T09:00:00Z"));
    const user = "did:privy:deadline-user";
    const creator = "0x5555555555555555555555555555555555555555";
    const asked = Math.floor(Date.now() / 1000) + 700;

    // The picture is drawn and pinned, and by the time it is ready only 50 seconds of the window
    // are left, which is less than the passkey prompt alone takes.
    stubs.createImage.mockImplementationOnce(async (prompt: string) => {
      vi.setSystemTime(Date.now() + 650_000);
      return { bytes: await makeImage(prompt.length % 40), model: MODEL, promptUsed: prompt };
    });

    const refused = await ask(user, { prompt: PROMPT, title: "Slow draw", creator, deadline: asked });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: "deadline-passed" });

    const next = await ask(user, { prompt: PROMPT, title: "Second try", creator, deadline: deadline() });
    expect(next.statusCode).toBe(200);
    expect(next.json().quota).toEqual({ used: 2, limit: 2, resetsAt: expect.any(Number) });
    vi.useRealTimers();
  }, 60_000);

  it("hands the slot back when the provider refused the call, and keeps it when it may have billed", async () => {
    const user = "did:privy:billing-user";
    const creator = "0x4444444444444444444444444444444444444444";
    const body = (title: string) => ({ prompt: PROMPT, title, creator, deadline: deadline() });

    stubs.createImage.mockRejectedValueOnce(new APIError(403, { message: "your key cannot use this model" }, undefined, undefined));
    const refused = await ask(user, body("Refused by the provider"));
    expect(refused.statusCode).toBe(502);
    expect(refused.json()).toEqual({ error: "model-failed" });

    stubs.createImage.mockRejectedValueOnce(new APIError(500, { message: "the provider fell over" }, undefined, undefined));
    const broke = await ask(user, body("Provider fell over"));
    expect(broke.statusCode).toBe(502);

    // The 403 gave its slot back and the 500 kept its own, so one of the two allowed pictures is
    // already spent and the one that works is the last of the day.
    const drawn = await ask(user, body("The one that works"));
    expect(drawn.statusCode).toBe(200);
    expect(drawn.json().quota).toEqual({ used: 2, limit: 2, resetsAt: expect.any(Number) });
    expect((await ask(user, body("One too many"))).statusCode).toBe(429);
  }, 60_000);

  it("is not mounted on a host without the generator's own variables", async () => {
    const bare = await buildServer({ source: emptySource, logger: false });
    await bare.ready();
    const response = await bare.inject({ method: "POST", url: "/generate", payload: {} });
    expect(response.statusCode).toBe(404);
    await bare.close();
  });
});

describe("what a failed image call may have cost", () => {
  it("counts a 4xx as never drawn, and a 5xx, a connection error or anything else as maybe drawn", () => {
    const refused = (status: 400 | 403 | 429 | 500) =>
      new APIError(status, { message: "no picture for you" }, undefined, undefined);

    expect(billedOrUnknown(refused(400))).toBe(false);
    expect(billedOrUnknown(refused(403))).toBe(false);
    expect(billedOrUnknown(refused(429))).toBe(false);
    expect(billedOrUnknown(refused(500))).toBe(true);
    expect(billedOrUnknown(new APIConnectionError({ message: "the socket died" }))).toBe(true);
    expect(billedOrUnknown(new Error("something else entirely"))).toBe(true);
  });
});

describe("the generation gate", () => {
  it("runs two at a time and tells the third it is busy when the wait runs out", async () => {
    const gate = waitingGate(2, 50);
    let running = 0;
    let peak = 0;
    const slow = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 200));
      running -= 1;
    };

    const first = gate(slow);
    const second = gate(slow);
    await expect(gate(slow)).rejects.toBeInstanceOf(Busy);
    await Promise.all([first, second]);

    expect(peak).toBe(2);
    await expect(gate(async () => "free")).resolves.toBe("free");
  });
});
