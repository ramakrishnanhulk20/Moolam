// Covers the resolver's reasons for a challenge decision (WO-275c, L28). The resolver's wallet signs
// EIP-712 DecisionReasons typed data in Moolam's registry domain over the passport id, the dispute's
// openedAt, the outcome, the sha256 of the reasons and a deadline. In one call the service reads, at
// one block, the policy's resolver, getDispute and MoolamDecisions.published, and accepts only a body
// of the exact shape, before the deadline by that block's time, signed by that resolver with a plain
// 65 byte signature, for a dispute settled with that openedAt and that outcome, not yet published,
// with 1 to 8,000 bytes of printable reasons whose only control character is the line break. The
// address it answers fits MoolamDecisions.publish, and the same reasons answer the same address
// without a second pin, under a daily ceiling of the route's own.
// Does NOT cover the live Monad read (a stand-in answers for one block), a real pin (a stand-in
// computes the content id Pinata would give the bytes), the resolver console that signs, or the
// publish transaction itself, which packages/contracts/test/MoolamDecisions.t.sol covers.

import Fastify, { type FastifyInstance } from "fastify";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DecisionAtBlock, DecisionChain } from "../src/challenges/decisionChain.js";
import {
  MAX_REASONS_BYTES,
  MAX_REASONS_URI_LENGTH,
  fitsDecisions,
  reasonsDocumentSchema,
  reasonsHashOf,
  reasonsTypedData,
  type ReasonsDocument,
} from "../src/challenges/reasons.js";
import { ReasonsStore } from "../src/challenges/reasonsStore.js";
import { env } from "../src/env.js";
import { contentIdOf } from "../src/ipfs/pinata.js";
import { decisionRoutes, type DecisionRouteOptions } from "../src/routes/decisions.js";
import { buildServer } from "../src/server.js";
import { idFrom } from "./helpers.js";

const REGISTRY = env.MOOLAM_REGISTRY_ADDRESS as Hex;
const OPENED_AT = 1_790_000_000n;
const UPHELD = 2;
const REJECTED = 3;
const resolver = privateKeyToAccount(`0x${"61".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"62".repeat(32)}`);

/** The one block the stand-in chain answers for. */
const world: { now: bigint; resolver: Address; status: number; openedAt: bigint; published: boolean; fail: boolean } = {
  now: OPENED_AT + 86_400n,
  resolver: resolver.address,
  status: UPHELD,
  openedAt: OPENED_AT,
  published: false,
  fail: false,
};
const asked: { passportId: Hex; openedAt: bigint }[] = [];
const pinned: ReasonsDocument[] = [];
let pinAnswer: ((document: ReasonsDocument) => `ipfs://${string}`) | undefined;

const chain: DecisionChain = {
  decisionAt: async (passportId, openedAt): Promise<DecisionAtBlock> => {
    if (world.fail) throw new Error("rpc refused the read");
    asked.push({ passportId, openedAt });
    return {
      now: world.now,
      resolver: world.resolver,
      dispute: { status: world.status, openedAt: world.openedAt },
      published: world.published,
    };
  },
};

/** Pins as Pinata would: the content id of the very bytes pinJson sends. */
async function standInPin(document: ReasonsDocument): Promise<{ cid: string; uri: `ipfs://${string}` }> {
  pinned.push(document);
  if (pinAnswer !== undefined) {
    const uri = pinAnswer(document);
    return { cid: uri.slice("ipfs://".length), uri };
  }
  const cid = contentIdOf(Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8"));
  return { cid, uri: `ipfs://${cid}` };
}

let app: FastifyInstance;
let passportByte = 0x20;
let callerByte = 0;

beforeAll(async () => {
  app = await buildServer({
    source: { load: async () => [] },
    logger: false,
    decisions: { chain, store: new ReasonsStore(undefined), pin: standInPin, perDay: 1_000 },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  world.now = OPENED_AT + 86_400n;
  world.resolver = resolver.address;
  world.status = UPHELD;
  world.openedAt = OPENED_AT;
  world.published = false;
  world.fail = false;
  pinAnswer = undefined;
});

function freshPassport(): Hex {
  passportByte += 1;
  return idFrom(passportByte);
}

interface Signing {
  signer?: typeof resolver;
  openedAt?: bigint;
  upheld?: boolean;
  reasons?: string;
  deadline?: bigint;
}

interface Body {
  passportId: Hex;
  openedAt: number;
  upheld: boolean;
  reasons: string;
  deadline: number;
  signature: Hex;
}

async function signedBody(passportId: Hex, reasons: string, upheld = true, over: Signing = {}): Promise<Body> {
  const deadline = over.deadline ?? world.now + 600n;
  const signature = await (over.signer ?? resolver).signTypedData(
    reasonsTypedData(
      {
        passportId,
        openedAt: over.openedAt ?? OPENED_AT,
        upheld: over.upheld ?? upheld,
        reasonsHash: reasonsHashOf(over.reasons ?? reasons),
        deadline,
      },
      REGISTRY,
    ),
  );
  return { passportId, openedAt: Number(OPENED_AT), upheld, reasons, deadline: Number(deadline), signature };
}

async function post(target: FastifyInstance, body: unknown) {
  callerByte += 1;
  const response = await target.inject({
    method: "POST",
    url: "/decisions/reasons",
    payload: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    remoteAddress: `198.51.${Math.floor(callerByte / 250)}.${(callerByte % 250) + 1}`,
  });
  return { status: response.statusCode, json: response.json() as Record<string, unknown>, headers: response.headers };
}

async function publish(passportId: Hex, reasons: string, upheld = true, over: Signing = {}) {
  return await post(app, await signedBody(passportId, reasons, upheld, over));
}

describe("L28: the resolver's reasons are pinned only for the decision they explain", () => {
  it("pins the resolver's reasons for a settled dispute as one document and answers its address", async () => {
    const passportId = freshPassport();
    const reasons = "The earlier post on the photographer's site shows the same frame.\nThe challenge stands.";
    const before = pinned.length;

    const response = await publish(passportId, reasons);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(pinned.length).toBe(before + 1);
    const document = reasonsDocumentSchema.parse(pinned.at(-1));
    expect(document).toMatchObject({
      kind: "moolam-decision-reasons",
      passportId,
      openedAt: Number(OPENED_AT),
      upheld: true,
      resolver: resolver.address,
      reasons,
      reasonsHash: reasonsHashOf(reasons),
    });
    expect(response.json).toEqual({ reasonsURI: `ipfs://${contentIdOf(Buffer.from(`${JSON.stringify(document, null, 2)}\n`))}` });
    expect(asked.at(-1)).toEqual({ passportId, openedAt: OPENED_AT });
  });

  it("refuses a body of any other shape before reading the chain", async () => {
    const passportId = freshPassport();
    const body = await signedBody(passportId, "Reasons.");
    const reads = asked.length;

    expect((await post(app, { ...body, note: "extra" })).status).toBe(400);
    expect((await post(app, { ...body, upheld: "true" })).status).toBe(400);
    expect((await post(app, { ...body, passportId: "0x1234" })).status).toBe(400);
    expect((await post(app, { ...body, openedAt: 0 })).status).toBe(400);
    expect((await post(app, { ...body, signature: `${body.signature}00` })).status).toBe(400);
    expect(asked.length).toBe(reads);
  });

  it("refuses an expired deadline by chain time, whatever the caller's clock says", async () => {
    const passportId = freshPassport();
    const body = await signedBody(passportId, "Reasons.", true, { deadline: world.now - 1n });
    const before = pinned.length;

    const response = await post(app, body);

    expect(response.status).toBe(403);
    expect(response.json).toMatchObject({ error: "reasons-expired", chainTime: world.now.toString() });
    expect(pinned.length).toBe(before);
  });

  it("refuses a stranger's signature, and the resolver's signature over other words or the other outcome", async () => {
    const passportId = freshPassport();
    const before = pinned.length;

    const byStranger = await publish(passportId, "Reasons.", true, { signer: stranger });
    expect(byStranger.status).toBe(403);
    expect(byStranger.json.error).toBe("not-the-resolver");

    expect((await publish(passportId, "Reasons.", true, { reasons: "Other reasons." })).json.error).toBe("not-the-resolver");
    expect((await publish(passportId, "Reasons.", true, { upheld: false })).json.error).toBe("not-the-resolver");
    expect((await publish(passportId, "Reasons.", true, { openedAt: OPENED_AT + 1n })).json.error).toBe("not-the-resolver");
    expect(pinned.length).toBe(before);
  });

  it("refuses the old resolver's signature once the policy names another", async () => {
    const passportId = freshPassport();
    world.resolver = stranger.address;

    const response = await publish(passportId, "Reasons.");

    expect(response.status).toBe(403);
    expect(response.json.error).toBe("not-the-resolver");
  });

  it("refuses a never-flagged or still open dispute", async () => {
    const passportId = freshPassport();

    world.status = 0;
    world.openedAt = 0n;
    const never = await publish(passportId, "Reasons.");
    expect(never.status).toBe(409);
    expect(never.json.error).toBe("dispute-not-settled");

    world.status = 1;
    world.openedAt = OPENED_AT;
    const open = await publish(passportId, "Reasons.");
    expect(open.status).toBe(409);
    expect(open.json.error).toBe("dispute-not-settled");
  });

  it("refuses a dispute settled with another openedAt or the other outcome", async () => {
    const passportId = freshPassport();

    world.openedAt = OPENED_AT + 3_600n;
    const later = await publish(passportId, "Reasons.");
    expect(later.status).toBe(409);
    expect(later.json.error).toBe("dispute-mismatch");

    world.openedAt = OPENED_AT;
    world.status = REJECTED;
    const otherOutcome = await publish(passportId, "Reasons.", true);
    expect(otherOutcome.json.error).toBe("dispute-mismatch");

    world.status = UPHELD;
    expect((await publish(passportId, "Reasons.", false)).json.error).toBe("dispute-mismatch");
  });

  it("pins reasons for a rejected challenge when the signature says rejected", async () => {
    world.status = REJECTED;
    const response = await publish(freshPassport(), "The evidence shows a different picture.", false);

    expect(response.status).toBe(200);
    expect(pinned.at(-1)?.upheld).toBe(false);
  });

  it("refuses a decision whose reasons are already published", async () => {
    const passportId = freshPassport();
    world.published = true;
    const before = pinned.length;

    const response = await publish(passportId, "Reasons.");

    expect(response.status).toBe(409);
    expect(response.json.error).toBe("already-published");
    expect(pinned.length).toBe(before);
  });

  it("answers the same address for a reused body, and for a fresh signature over the same reasons, without a second pin", async () => {
    const passportId = freshPassport();
    const body = await signedBody(passportId, "One reason.\r\nA second line.");
    const first = await post(app, body);
    const pins = pinned.length;

    const again = await post(app, body);
    const resigned = await publish(passportId, "One reason.\r\nA second line.", true, { deadline: world.now + 900n });

    expect(first.status).toBe(200);
    expect(again).toMatchObject({ status: 200, json: first.json });
    expect(resigned).toMatchObject({ status: 200, json: first.json });
    expect(pinned.length).toBe(pins);
  });

  it("refuses reasons over 8,000 bytes and takes exactly 8,000", async () => {
    // Three byte characters, so the cut is on bytes and not on characters.
    const over = "ம".repeat(Math.ceil(MAX_REASONS_BYTES / 3));
    expect(Buffer.byteLength(over, "utf8")).toBe(MAX_REASONS_BYTES + 1);
    const refused = await publish(freshPassport(), over);
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/over 8000 bytes/);

    const exact = "x".repeat(MAX_REASONS_BYTES);
    expect((await publish(freshPassport(), exact)).status).toBe(200);
  });

  it("refuses empty reasons and every control character but the line break", async () => {
    const before = pinned.length;
    for (const reasons of ["", "tab\there", "nul\u0000", "lone\rreturn", "bell\u0007", "‮override", "zero​width", "half\uD800"]) {
      const response = await publish(freshPassport(), reasons);
      expect(response.status, JSON.stringify(reasons)).toBe(400);
    }
    expect(pinned.length).toBe(before);
  });

  it("answers 503 and pins nothing when the chain cannot be read", async () => {
    world.fail = true;
    const before = pinned.length;

    const response = await publish(freshPassport(), "Reasons.");

    expect(response.status).toBe(503);
    expect(response.json.error).toBe("chain-unreachable");
    expect(pinned.length).toBe(before);
  });
});

describe("the address fits MoolamDecisions' rule", () => {
  it("answers an address MoolamDecisions.publish takes", async () => {
    const response = await publish(freshPassport(), "Reasons.");
    const uri = response.json.reasonsURI as string;

    expect(uri).toMatch(/^ipfs:\/\/[A-Za-z0-9]+$/);
    expect(Buffer.byteLength(uri)).toBeLessThanOrEqual(MAX_REASONS_URI_LENGTH);
    expect(uri.length - "ipfs://".length).toBeGreaterThanOrEqual(46);
    expect(fitsDecisions(uri)).toBe(true);
  });

  it("holds the contract's rule: prefix, letters and digits only, at least 46 of them, at most 128 bytes", () => {
    expect(fitsDecisions(`ipfs://${"a".repeat(46)}`)).toBe(true);
    expect(fitsDecisions(`ipfs://${"a".repeat(121)}`)).toBe(true);
    expect(fitsDecisions(`ipfs://${"a".repeat(45)}`)).toBe(false);
    expect(fitsDecisions(`ipfs://${"a".repeat(122)}`)).toBe(false);
    expect(fitsDecisions(`ipfs://${"a".repeat(45)}/b`)).toBe(false);
    expect(fitsDecisions(`https://${"a".repeat(50)}`)).toBe(false);
    expect(fitsDecisions(`ipfs://${"a".repeat(50)}\n`)).toBe(false);
  });

  it("refuses to hand out a pinned address that would not fit, and keeps nothing", async () => {
    const passportId = freshPassport();
    pinAnswer = () => `ipfs://${"b".repeat(MAX_REASONS_URI_LENGTH)}`;

    const response = await publish(passportId, "Reasons.");
    expect(response.status).toBe(502);
    expect(response.json.error).toBe("address-unfit");

    pinAnswer = undefined;
    const retried = await publish(passportId, "Reasons.");
    expect(retried.status).toBe(200);
    expect(fitsDecisions(retried.json.reasonsURI as string)).toBe(true);
  });
});

describe("the route's own daily ceiling", () => {
  it("pins at most its ceiling a day, and a repeat of reasons already pinned takes no slot", async () => {
    const bare = Fastify({ logger: false });
    const options: DecisionRouteOptions = { chain, store: new ReasonsStore(undefined), pin: standInPin, perDay: 1 };
    await bare.register(decisionRoutes, options);
    await bare.ready();
    try {
      const passportId = freshPassport();
      const first = await post(bare, await signedBody(passportId, "First reasons."));
      expect(first.status).toBe(200);
      expect((await post(bare, await signedBody(passportId, "First reasons."))).json).toEqual(first.json);

      const second = await post(bare, await signedBody(passportId, "Revised reasons."));
      expect(second.status).toBe(429);
      expect(second.json.error).toBe("global-limit");
      expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);
    } finally {
      await bare.close();
    }
  });
});
