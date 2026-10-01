// Covers the holder's answer to a challenge (WO-275b, L26, L27). The holder's wallet signs EIP-712
// ChallengeAnswer typed data in Moolam's registry domain over the passport id, the dispute's openedAt
// and challenger, the sha256 of the text and a deadline. The service reads ownerOf and getDispute
// from one block in the same call and accepts only the holder's plain 65 byte signature, only while
// that dispute is Open, within 14 days of openedAt and before the deadline, all by that block's
// time, once per dispute, with a reused signature refused. The text is at most 4,000 bytes of
// printable Unicode with no control characters, never rewritten, and is pinned as one document
// naming the passport, openedAt, the challenger and the holder. GET answers only the answer whose
// passport, openedAt and challenger match the dispute the chain holds now.
// Does NOT cover the live Monad read (a stand-in answers for one block), a real pin (a stand-in
// keeps the documents), the page that draws the answer as text (WO-277), or the host's log, which
// the route never hands the text to.

import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ANSWER_WINDOW_SECONDS, answerDocumentSchema, answerHashOf, answerTypedData, type AnswerDocument } from "../src/challenges/answer.js";
import type { ChallengeChain } from "../src/challenges/chain.js";
import { AnswerStore } from "../src/challenges/store.js";
import { env } from "../src/env.js";
import { buildServer } from "../src/server.js";
import { idFrom } from "./helpers.js";

const REGISTRY = env.MOOLAM_REGISTRY_ADDRESS as Hex;
const OPENED_AT = 1_790_000_000n;
const holder = privateKeyToAccount(`0x${"51".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"52".repeat(32)}`);
const challenger = privateKeyToAccount(`0x${"53".repeat(32)}`).address;
const otherChallenger = privateKeyToAccount(`0x${"54".repeat(32)}`).address;

/** The one block the stand-in chain answers for: its time, the holder and the dispute. */
const world = {
  now: OPENED_AT + 3_600n,
  holder: holder.address as Address | undefined,
  dispute: { challenger, status: 1, openedAt: OPENED_AT },
  fail: false,
};
const reads: Hex[] = [];
const pinned: AnswerDocument[] = [];
let pinDelayMs = 0;

const chain: ChallengeChain = {
  disputeAt: async (passportId) => {
    if (world.fail) throw new Error("rpc refused the read");
    reads.push(passportId);
    return { now: world.now, holder: world.holder, dispute: { ...world.dispute } };
  },
};

let app: FastifyInstance;
let passportByte = 0x80;

beforeAll(async () => {
  app = await buildServer({
    source: { load: async () => [] },
    logger: false,
    challenges: {
      chain,
      store: new AnswerStore(undefined),
      pin: async (document) => {
        if (pinDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, pinDelayMs));
        pinned.push(document);
        const cid = `bafkreianswer${pinned.length}`;
        return { cid, uri: `ipfs://${cid}` };
      },
      ceilings: { answer: 10_000, read: 10_000 },
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  world.now = OPENED_AT + 3_600n;
  world.holder = holder.address;
  world.dispute = { challenger, status: 1, openedAt: OPENED_AT };
  world.fail = false;
  pinDelayMs = 0;
});

/** A passport no earlier test has answered for. */
function freshPassport(): Hex {
  passportByte += 1;
  return idFrom(passportByte);
}

interface Signing {
  signer?: typeof holder;
  passportId?: Hex;
  openedAt?: bigint;
  challenger?: Address;
  text?: string;
  deadline?: bigint;
}

async function signAnswer(passportId: Hex, text: string, over: Signing = {}): Promise<{ deadline: number; signature: Hex }> {
  const deadline = over.deadline ?? world.now + 600n;
  const signature = await (over.signer ?? holder).signTypedData(
    answerTypedData(
      {
        passportId: over.passportId ?? passportId,
        openedAt: over.openedAt ?? world.dispute.openedAt,
        challenger: over.challenger ?? world.dispute.challenger,
        answerHash: answerHashOf(over.text ?? text),
        deadline,
      },
      REGISTRY,
    ),
  );
  return { deadline: Number(deadline), signature };
}

async function post(passportId: Hex, body: unknown) {
  const response = await app.inject({
    method: "POST",
    url: `/challenges/${passportId}/answer`,
    payload: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    remoteAddress: "198.51.100.40",
  });
  return { status: response.statusCode, json: response.json() as Record<string, unknown>, headers: response.headers };
}

async function answer(passportId: Hex, text: string, over: Signing = {}) {
  return await post(passportId, { text, ...(await signAnswer(passportId, text, over)) });
}

async function read(passportId: Hex) {
  const response = await app.inject({ method: "GET", url: `/challenges/${passportId}/answer`, remoteAddress: "198.51.100.41" });
  return { status: response.statusCode, json: response.json() as Record<string, unknown> };
}

describe("L26: a signature binds exactly one answer to one open dispute", () => {
  it("accepts the holder's plain wallet signature over this text and this open dispute, and serves it back", async () => {
    const passportId = freshPassport();
    const accepted = await answer(passportId, "I made this picture in Chennai in 2024; the raw file is with me.");

    expect(accepted.status).toBe(200);
    expect(accepted.json).toEqual({ answerURI: `ipfs://bafkreianswer${pinned.length}` });
    expect(accepted.headers["cache-control"]).toBe("no-store");
    expect(reads.at(-1)).toBe(passportId);
    const served = await read(passportId);
    expect(served.status).toBe(200);
    expect(served.json.answerURI).toBe(accepted.json.answerURI);
    expect((served.json.answer as AnswerDocument).holder).toBe(holder.address);
  });

  it("refuses a signature by anyone but the holder read in that same call", async () => {
    const passportId = freshPassport();
    const before = pinned.length;

    expect((await answer(passportId, "Not mine to answer.", { signer: stranger })).json.error).toBe("not-the-holder");
    const signed = await signAnswer(passportId, "The holder signed, then sold it.");
    world.holder = stranger.address;
    expect((await post(passportId, { text: "The holder signed, then sold it.", ...signed })).status).toBe(403);
    expect(pinned.length).toBe(before);
  });

  it("refuses a signature that binds another text, passport, dispute, challenger or deadline", async () => {
    const passportId = freshPassport();
    const before = pinned.length;
    const text = "This is my picture.";
    const binds: Signing[] = [
      { text: "A different answer." },
      { passportId: freshPassport() },
      { openedAt: OPENED_AT - 86_400n },
      { challenger: otherChallenger },
    ];
    for (const over of binds) {
      const response = await answer(passportId, text, over);
      expect(response.status, JSON.stringify(over, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))).toBe(403);
    }
    const signed = await signAnswer(passportId, text);
    expect((await post(passportId, { text, ...signed, deadline: signed.deadline + 1 })).status).toBe(403);
    expect(pinned.length).toBe(before);
  });

  it("refuses an answer while the dispute is not open", async () => {
    for (const status of [0, 2, 3]) {
      world.dispute = { challenger, status, openedAt: OPENED_AT };
      const response = await answer(freshPassport(), "Too early or too late.");
      expect(response.status).toBe(409);
      expect(response.json.error).toBe("no-open-dispute");
    }
  });

  it("accepts until fourteen days after openedAt by chain time, and not a second later", async () => {
    world.now = OPENED_AT + ANSWER_WINDOW_SECONDS + 1n;
    const late = await answer(freshPassport(), "One second too late.");
    expect(late.status).toBe(409);
    expect(late.json.error).toBe("answer-window-closed");

    world.now = OPENED_AT + ANSWER_WINDOW_SECONDS;
    expect((await answer(freshPassport(), "On the last second.")).status).toBe(200);
    expect(ANSWER_WINDOW_SECONDS).toBe(14n * 86_400n);
  });

  it("refuses an answer whose deadline has passed by chain time", async () => {
    const passportId = freshPassport();
    const expired = await answer(passportId, "Signed yesterday.", { deadline: world.now - 1n });
    expect(expired.status).toBe(403);
    expect(expired.json.error).toBe("answer-expired");
    expect(expired.json.chainTime).toBe(world.now.toString());
    expect((await answer(passportId, "Signed for this very second.", { deadline: world.now })).status).toBe(200);
  });

  it("refuses a reused signature and a second answer to the same dispute", async () => {
    const passportId = freshPassport();
    const body = { text: "My first and only answer.", ...(await signAnswer(passportId, "My first and only answer.")) };
    expect((await post(passportId, body)).status).toBe(200);
    const before = pinned.length;

    const replay = await post(passportId, body);
    expect(replay.status).toBe(409);
    expect(replay.json.error).toBe("signature-used");
    const second = await answer(passportId, "A second thought.");
    expect(second.status).toBe(409);
    expect(second.json.error).toBe("already-answered");
    expect(pinned.length).toBe(before);
  });

  it("pins once when two answers race for one dispute", async () => {
    const passportId = freshPassport();
    const before = pinned.length;
    pinDelayMs = 30;

    const both = await Promise.all([answer(passportId, "First racer."), answer(passportId, "Second racer.")]);

    expect(both.map((one) => one.status).sort()).toEqual([200, 409]);
    expect(pinned.length - before).toBe(1);
  });

  it("takes only a plain 65 byte wallet signature: a compact, a high-s or a contract wallet's signature is refused", async () => {
    const passportId = freshPassport();
    const text = "Signed by my smart account.";
    const signed = await signAnswer(passportId, text);
    const bytes = Buffer.from(signed.signature.slice(2), "hex");

    expect((await post(passportId, { text, deadline: signed.deadline, signature: `0x${bytes.subarray(0, 64).toString("hex")}` })).status).toBe(400);
    const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(`0x${bytes.subarray(32, 64).toString("hex")}`);
    const highS = Buffer.concat([bytes.subarray(0, 32), Buffer.from((order - s).toString(16).padStart(64, "0"), "hex"), Buffer.from([bytes[64] === 27 ? 28 : 27])]);
    expect((await post(passportId, { text, deadline: signed.deadline, signature: `0x${highS.toString("hex")}` })).json.error).toBe("not-the-holder");
    // A contract wallet's ERC-1271 proof is whatever bytes its contract accepts; here it recovers to nobody.
    expect((await post(passportId, { text, deadline: signed.deadline, signature: `0x${"11".repeat(64)}1b` })).json.error).toBe("not-the-holder");
  });

  it("answers 503 and accepts nothing when the chain cannot be read", async () => {
    const before = pinned.length;
    world.fail = true;
    const passportId = freshPassport();
    expect((await answer(passportId, "Anyone there?")).json.error).toBe("chain-unreachable");
    expect((await read(passportId)).status).toBe(503);
    expect(pinned.length).toBe(before);
  });
});

describe("L27: the answer is bounded, inert and attributable", () => {
  it("refuses text over 4,000 bytes, empty, or with control, line or direction characters, before any chain read", async () => {
    const passportId = freshPassport();
    const readsBefore = reads.length;
    const pinsBefore = pinned.length;
    const bad = [`${"é".repeat(2_000)}x`, "", "line one\nline two", "tab\there", "nul\u0000byte", "‮reversed", "zero​width", "lone \ud800 half"];
    for (const text of bad) {
      const response = await post(passportId, { text, deadline: Number(world.now + 600n), signature: `0x${"11".repeat(65)}` });
      expect(response.status, JSON.stringify(text)).toBe(400);
    }
    expect(reads.length).toBe(readsBefore);
    expect(pinned.length).toBe(pinsBefore);

    expect((await answer(passportId, "é".repeat(2_000))).status).toBe(200);
  });

  it("pins one document naming the passport, openedAt, challenger and holder, whose hash and signature check without this service", async () => {
    const passportId = freshPassport();
    const text = "Original négatif, scanned 2019. 写真は私のものです。";
    const accepted = await answer(passportId, text);
    expect(accepted.status).toBe(200);
    const document = pinned.at(-1) as AnswerDocument;

    expect(answerDocumentSchema.parse(document)).toEqual(document);
    expect(document).toMatchObject({
      kind: "moolam-challenge-answer",
      version: 1,
      chainId: 143,
      passportId,
      openedAt: Number(OPENED_AT),
      challenger,
      holder: holder.address,
      text,
    });
    expect(document.answerHash).toBe(`0x${createHash("sha256").update(text, "utf8").digest("hex")}`);
    const recovered = await recoverTypedDataAddress({
      ...answerTypedData(
        { passportId, openedAt: BigInt(document.openedAt), challenger, answerHash: document.answerHash as Hex, deadline: BigInt(document.deadline) },
        REGISTRY,
      ),
      signature: document.signature as Hex,
    });
    expect(recovered).toBe(holder.address);
  });

  it("shows an answer only beside the dispute it was given for", async () => {
    const passportId = freshPassport();
    expect((await answer(passportId, "Answer to the first challenge.")).status).toBe(200);
    expect((await read(passportId)).status).toBe(200);

    world.dispute = { challenger: otherChallenger, status: 1, openedAt: OPENED_AT + 90_000n };
    expect((await read(passportId)).status).toBe(404);
    world.dispute = { challenger: otherChallenger, status: 3, openedAt: OPENED_AT };
    expect((await read(passportId)).status).toBe(404);
    world.dispute = { challenger, status: 0, openedAt: OPENED_AT };
    expect((await read(passportId)).status).toBe(404);
    world.dispute = { challenger, status: 3, openedAt: OPENED_AT };
    expect((await read(passportId)).status).toBe(200);
    expect((await read(freshPassport())).status).toBe(404);
  });
});
