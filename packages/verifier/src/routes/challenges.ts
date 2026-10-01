import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAddress, type Hex } from "viem";
import { z } from "zod";
import {
  ANSWER_WINDOW_SECONDS,
  answerDigest,
  answerDocument,
  answerHashOf,
  answerTextProblem,
  type AnswerDocument,
} from "../challenges/answer.js";
import { DISPUTE_OPEN, liveChallengeChain, offlineChallengeChain, type ChallengeChain } from "../challenges/chain.js";
import { AnswerStore, AnswerStoreClosed } from "../challenges/store.js";
import { isPassportId } from "../consentRead.js";
import { env } from "../env.js";
import { pinJson } from "../ipfs/pinata.js";
import { passportKey } from "../mcp/inputs.js";
import { safeReason } from "../net/errorText.js";
import { recoverLikeRegistry } from "../platform/signatures.js";
import { STATE_FILES, stateFile } from "../stateDir.js";
import { WINDOW_MS, ceiling } from "./lookalikes.js";

/**
 * What every caller together may ask of each route in a minute, on top of the service's 60 a minute
 * per address (R13). An answer is one per dispute and a dispute costs a bond, so 120 attempts a
 * minute is far past honest use; a read costs one chain read and a page may poll it.
 */
export const ANSWER_CEILINGS = { answer: 120, read: 600 } as const;

/**
 * A body this route reads at most. An answer of 4,000 bytes written as JSON escapes can take six
 * characters a byte; anything past this is not an answer.
 */
const ANSWER_BODY_LIMIT = 32 * 1024;

const bodySchema = z.strictObject({
  text: z.string().max(ANSWER_BODY_LIMIT),
  deadline: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});

export interface ChallengeRouteOptions {
  /** Replaces the chain read; under a test runner the default reads nothing and both routes answer 503. */
  chain?: ChallengeChain;
  /** Replaces the answers store; by default a file in the data folder, memory under a test runner. */
  store?: AnswerStore;
  /** Replaces the pin, for tests. */
  pin?: (document: AnswerDocument, name: string) => Promise<{ cid: string; uri: `ipfs://${string}` }>;
  ceilings?: { answer?: number; read?: number };
  clock?: () => number;
}

/**
 * The holder's answer to a challenge (L26, L27).
 *
 * POST /challenges/:passportId/answer takes `{ text, deadline, signature }`. The signature is the
 * holder's wallet over EIP-712 ChallengeAnswer(passportId, openedAt, challenger, answerHash,
 * deadline) in Moolam's registry domain, answerHash the sha256 of the text's UTF-8 bytes. In the
 * same call the service reads getDispute and ownerOf at one block, and accepts only while that
 * dispute is Open, within 14 days of its openedAt and no later than the deadline, both by that
 * block's time, and only when the signature recovers to that holder. Only plain 65 byte wallet
 * signatures count: a contract wallet's ERC-1271 signature is refused. One answer per dispute; a
 * signature already used is refused. The answer is pinned as a document naming the passport,
 * openedAt, the challenger and the holder, and the route answers its address.
 *
 * GET /challenges/:passportId/answer answers the pinned answer whose passport, openedAt and
 * challenger match the dispute the chain holds for that passport now, or 404.
 *
 * Neither route logs the text. Both answer `no-store`.
 */
export async function challengeRoutes(app: FastifyInstance, options: ChallengeRouteOptions = {}): Promise<void> {
  const chain = options.chain ?? (env.NODE_ENV === "test" ? offlineChallengeChain() : liveChallengeChain());
  const store =
    options.store ??
    new AnswerStore(stateFile(STATE_FILES.challengeAnswers), (line) => {
      app.log.warn(line);
    });
  const pin = options.pin ?? (async (document: AnswerDocument, name: string) => await pinJson(document, name));
  const clock = options.clock ?? Date.now;
  const answerRoom = ceiling(options.ceilings?.answer ?? ANSWER_CEILINGS.answer, clock);
  const readRoom = ceiling(options.ceilings?.read ?? ANSWER_CEILINGS.read, clock);
  const registry = env.MOOLAM_REGISTRY_ADDRESS as Hex;
  /** Disputes being answered right now, so two answers racing for one dispute pin at most once. */
  const answering = new Set<string>();

  if (store.closed() !== undefined) {
    app.log.warn("challenge answers closed: the answers file could not be believed, both routes answer 503");
  }

  app.addHook("onSend", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });

  const refuse = (request: FastifyRequest, reply: FastifyReply, status: number, error: string, extra: Record<string, unknown> = {}): FastifyReply => {
    request.log.warn({ ip: request.ip, status, reason: error }, "rejected: challenge answer");
    return reply.code(status).send({ error, ...extra });
  };

  app.post(
    "/challenges/:passportId/answer",
    { bodyLimit: ANSWER_BODY_LIMIT },
    async (request: FastifyRequest<{ Params: { passportId: string } }>, reply: FastifyReply) => {
      if (!answerRoom()) return refuse(request, reply.header("retry-after", String(WINDOW_MS / 1000)), 429, "route-limit");
      if (!isPassportId(request.params.passportId)) return refuse(request, reply, 400, "passportId must be 0x and 64 hex characters");
      const passportId = passportKey(request.params.passportId);
      const body = bodySchema.safeParse(request.body);
      if (!body.success) {
        return refuse(request, reply, 400, 'send {"text":"...","deadline":<unix seconds>,"signature":"0x..."}');
      }
      const { text, deadline } = body.data;
      const signature = body.data.signature.toLowerCase() as Hex;
      const textProblem = answerTextProblem(text);
      if (textProblem !== null) return refuse(request, reply, 400, textProblem);

      let read;
      try {
        read = await chain.disputeAt(passportId);
      } catch (error) {
        request.log.warn({ reason: safeReason(error) }, "challenge answer: the chain could not be read");
        return refuse(request, reply, 503, "chain-unreachable");
      }
      const { now, holder, dispute } = read;
      if (dispute.status !== DISPUTE_OPEN) return refuse(request, reply, 409, "no-open-dispute");
      if (dispute.openedAt > BigInt(Number.MAX_SAFE_INTEGER)) return refuse(request, reply, 409, "no-open-dispute");
      if (now > dispute.openedAt + ANSWER_WINDOW_SECONDS) return refuse(request, reply, 409, "answer-window-closed");
      if (now > BigInt(deadline)) return refuse(request, reply, 403, "answer-expired", { chainTime: now.toString() });
      if (holder === undefined) return refuse(request, reply, 409, "no-holder");

      const message = {
        passportId,
        openedAt: dispute.openedAt,
        challenger: dispute.challenger,
        answerHash: answerHashOf(text),
        deadline: BigInt(deadline),
      };
      const digest = answerDigest(message, registry);
      const signer = await recoverLikeRegistry(digest, signature);
      if (signer === undefined || signer !== getAddress(holder)) {
        return refuse(request, reply, 403, "not-the-holder", {
          reason: "the signature does not recover to the passport's holder for this dispute: a plain wallet signature over this text, this dispute and this deadline is needed",
        });
      }

      const key = `${passportId}:${dispute.openedAt}`;
      try {
        if (store.usedDigest(digest)) return refuse(request, reply, 409, "signature-used");
        const earlier = store.answerFor(passportId, Number(dispute.openedAt));
        if (earlier !== undefined) return refuse(request, reply, 409, "already-answered", { answerURI: earlier.answerURI });
      } catch (error) {
        if (!(error instanceof AnswerStoreClosed)) throw error;
        return refuse(request, reply, 503, "answers-unavailable");
      }
      if (answering.has(key)) return refuse(request, reply, 409, "answering");
      answering.add(key);
      try {
        const document = answerDocument({
          registry,
          passportId,
          openedAt: dispute.openedAt,
          challenger: dispute.challenger,
          holder: signer,
          text,
          deadline: BigInt(deadline),
          signature,
        });
        let pinned: { cid: string; uri: `ipfs://${string}` };
        try {
          pinned = await pin(document, `challenge-answer-${passportId}-${dispute.openedAt}.json`);
        } catch (error) {
          request.log.error({ passportId, reason: safeReason(error) }, "challenge answer: pin failed, nothing kept");
          return refuse(request, reply, 502, "pin-failed");
        }
        try {
          store.add({ digest, answerURI: pinned.uri, document });
        } catch (error) {
          if (!(error instanceof AnswerStoreClosed)) throw error;
          return refuse(request, reply, 503, "answers-unavailable");
        }
        request.log.info({ passportId, openedAt: dispute.openedAt.toString(), holder: signer }, "challenge answer pinned");
        return reply.send({ answerURI: pinned.uri });
      } finally {
        answering.delete(key);
      }
    },
  );

  app.get(
    "/challenges/:passportId/answer",
    async (request: FastifyRequest<{ Params: { passportId: string } }>, reply: FastifyReply) => {
      if (!readRoom()) return refuse(request, reply.header("retry-after", String(WINDOW_MS / 1000)), 429, "route-limit");
      if (!isPassportId(request.params.passportId)) return refuse(request, reply, 400, "passportId must be 0x and 64 hex characters");
      const passportId = passportKey(request.params.passportId);
      if (store.closed() !== undefined) return refuse(request, reply, 503, "answers-unavailable");

      let read;
      try {
        read = await chain.disputeAt(passportId);
      } catch (error) {
        request.log.warn({ reason: safeReason(error) }, "challenge answer read: the chain could not be read");
        return refuse(request, reply, 503, "chain-unreachable");
      }
      const { dispute } = read;
      const entry =
        dispute.status === 0 || dispute.openedAt > BigInt(Number.MAX_SAFE_INTEGER)
          ? undefined
          : store.answerFor(passportId, Number(dispute.openedAt));
      // Shown only beside the dispute it names: same passport, same openedAt, same challenger (L27).
      if (entry === undefined || getAddress(entry.document.challenger) !== getAddress(dispute.challenger)) {
        return reply.code(404).send({ error: "not-found" });
      }
      return reply.send({ answerURI: entry.answerURI, answer: entry.document });
    },
  );
}
