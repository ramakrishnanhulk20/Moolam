import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAddress, type Address } from "viem";
import { z } from "zod";
import { InvalidToken, bearerToken, verifyPrivyToken, type PrivyKeys } from "../auth/privy.js";
import { embeddedWallets } from "../auth/wallet.js";
import { emailHash } from "../claims/email.js";
import type { Preview } from "../claims/preview.js";
import { verifiedEmails } from "../claims/privyUser.js";
import { deliverable, type ClaimService, type ClaimSetup } from "../claims/service.js";
import {
  ClaimStoreClosed,
  acceptTickets,
  clearStanding,
  isMuted,
  isTicketId,
  refuseTickets,
  unmute,
  type ClaimState,
  type Outcome,
} from "../claims/store.js";
import { termsSchema } from "../claims/terms.js";
import { privy, privyErrorText } from "../generate/privy.js";
import { rateLimitKey } from "../limits/addressKey.js";
import { dayLimitRefusal } from "../limits/globalDay.js";
import { safeReason } from "../net/errorText.js";

/** The batch cap: setConsentBatch takes 32 passports, so one accept never asks for more than one send (P32, P37). */
export const MAX_TICKETS_PER_CALL = 32;

/** The most offers, and the most waiting tickets, one /claims answer lists, newest first. */
export const MAX_LISTED = 100;

/** Gateway reads in flight at once for one /claims answer's previews. */
const PREVIEWS_AT_ONCE = 8;

const ticketIds = z
  .array(z.string().refine(isTicketId))
  .min(1)
  .max(MAX_TICKETS_PER_CALL)
  .refine((ids) => new Set(ids).size === ids.length);

const acceptBody = z.strictObject({ ticketIds, terms: termsSchema, sendFuture: z.boolean() });
const refuseBody = z.strictObject({ ticketIds });
const keyHashText = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const unmuteBody = z.strictObject({ platformKeyHash: keyHashText });

export interface ClaimRouteOptions {
  /** The claim service, or why it is closed, in which case every route here answers 503. */
  claims: ClaimSetup | undefined;
  keys?: PrivyKeys;
}

/** Who is asking, proven by Privy, and the hashes of every address Privy verified for them. */
interface Caller {
  service: ClaimService;
  userId: string;
  hashes: ReadonlySet<string>;
}

/**
 * The person routes: what waits for your verified email, and your answer to it.
 *
 * The caller is the Privy token's user, checked by the service's one identity reader. Their
 * addresses are read from Privy's own record of them, server-side, never from the request, and
 * turned into hashes by the same function the platform's address went through (P28); a ticket is
 * theirs only when its hash is one of those (P32). The wallet a passport goes to is Privy's first
 * embedded Ethereum wallet, by the selector the co-sign routes use, never a value in the body (P31).
 *
 * Every refusal is JSON with one fixed word. No answer, log line or error here carries an email or
 * an email's hash (P29). Every call is metered per user, per address and for everyone (P38).
 */
export async function claimRoutes(app: FastifyInstance, options: ClaimRouteOptions): Promise<void> {
  // Encapsulated in this plugin, so it reaches these routes only, the rate limiter's 429 included.
  app.addHook("onSend", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });

  /** The checks every person route makes, in order; undefined once a refusal has been sent. */
  const callerOf = async (request: FastifyRequest, reply: FastifyReply, check?: () => string | null): Promise<Caller | undefined> => {
    const setup = options.claims;
    if (setup === undefined || !setup.open) {
      reply.code(503).send({ error: "claims-unavailable" });
      return undefined;
    }
    const service = setup.service;
    const token = bearerToken(request.headers.authorization);
    let userId: string;
    try {
      if (token === undefined) throw new InvalidToken("no access token");
      userId = (await verifyPrivyToken(token, options.keys)).userId;
    } catch (error) {
      if (!(error instanceof InvalidToken)) throw error;
      request.log.warn({ ip: request.ip, reason: safeReason(error) }, "rejected: claims, no valid Privy token");
      reply.code(401).send({ error: "unauthorized" });
      return undefined;
    }
    const bad = check?.() ?? null;
    if (bad !== null) {
      reply.code(400).send({ error: bad });
      return undefined;
    }

    const byAddress = service.meter.address.take(rateLimitKey(request.ip));
    const byUser = byAddress.ok ? service.meter.user.take(userId) : undefined;
    if (!byAddress.ok || byUser?.ok !== true) {
      request.log.warn({ ip: request.ip, by: byAddress.ok ? "user" : "address" }, "rejected: claims, daily limit");
      reply.code(429).send({ error: "limit" });
      return undefined;
    }
    const today = service.meter.day.tryTake("prepares");
    if (!today.ok) {
      request.log.warn({ used: today.use.used, max: today.use.max }, "rejected: claims, today's ceiling for everyone is spent");
      const refusal = dayLimitRefusal(today.use);
      reply.code(429).header("retry-after", String(refusal.retryAfter)).send(refusal.body);
      return undefined;
    }

    let addresses: string[];
    try {
      addresses = await verifiedEmails(privy(), userId);
    } catch (error) {
      request.log.error({ reason: privyErrorText(error) }, "rejected: claims, Privy's user record could not be read");
      reply.code(502).send({ error: "privy-unavailable" });
      return undefined;
    }
    const hashes = new Set<string>();
    for (const address of addresses) {
      const hash = emailHash(address, service.pepper);
      if (hash !== null) hashes.add(hash);
    }
    return { service, userId, hashes };
  };

  /** The store's verdict as an answer; a store that cannot be read is a 503, never a guess. */
  const settle = <T>(reply: FastifyReply, run: () => Outcome<T>): Outcome<T> | undefined => {
    try {
      return run();
    } catch (error) {
      if (!(error instanceof ClaimStoreClosed)) throw error;
      reply.code(503).send({ error: "claims-unavailable" });
      return undefined;
    }
  };

  app.get("/claims", async (request: FastifyRequest, reply: FastifyReply) => {
    const caller = await callerOf(request, reply);
    if (caller === undefined) return reply;
    const read = settle(reply, (): Outcome<ClaimState> => ({ ok: true, value: caller.service.store.read() }));
    if (read === undefined || !read.ok) return reply;
    const state = read.value;
    const now = Math.floor(Date.now() / 1000);
    const mine = state.tickets.filter((ticket) => caller.hashes.has(ticket.emailHash));

    const offered = mine
      .filter((ticket) => ticket.state === "open" && ticket.expiresAt > now && !isMuted(state, ticket.emailHash, ticket.keyHash))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_LISTED);
    const previews: (Preview | null)[] = [];
    for (let at = 0; at < offered.length; at += PREVIEWS_AT_ONCE) {
      const chunk = offered.slice(at, at + PREVIEWS_AT_ONCE);
      previews.push(
        ...(await Promise.all(
          chunk.map(async (ticket) => {
            try {
              return await caller.service.preview(ticket.metadataURI);
            } catch {
              return null;
            }
          }),
        )),
      );
    }

    const waiting = mine
      .filter((ticket) => ticket.state === "accepted" || ticket.state === "delivered" || ticket.state === "failed")
      .sort((a, b) => (b.acceptedAt ?? 0) - (a.acceptedAt ?? 0))
      .slice(0, MAX_LISTED);

    return reply.send({
      offers: offered.map((ticket, index) => ({
        ticketId: ticket.ticketId,
        passportId: ticket.passportId,
        platform: platformOf(ticket),
        verifiedBy: ticket.verifiedBy,
        preview: previews[index] ?? null,
        createdAt: ticket.createdAt,
      })),
      waiting: waiting.map((ticket) => ({
        ticketId: ticket.ticketId,
        passportId: ticket.passportId,
        platform: platformOf(ticket),
        state: ticket.state,
        destination: ticket.destination,
        // Exactly as accepted (P37), so the page can build setConsentBatch after a reload. Every
        // waiting state's schema requires terms, so this is never null.
        terms: ticket.terms,
      })),
      standing: onePerPlatform(state.standing.filter((one) => caller.hashes.has(one.emailHash))).map((one) => ({
        platform: platformOf(one),
        destination: one.destination,
      })),
      muted: onePerPlatform(state.muted.filter((one) => caller.hashes.has(one.emailHash))).map((one) => ({ platform: platformOf(one) })),
    });
  });

  app.post("/claims/accept", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = acceptBody.safeParse(request.body);
    const caller = await callerOf(request, reply, () => (body.success ? null : fieldOf(body.error, ["ticketIds", "terms", "sendFuture"])));
    if (caller === undefined || !body.success) return reply;

    // The first embedded Ethereum wallet Privy lists, the one the co-sign routes write as creator and
    // the web app signs from. A person never chooses among their wallets here (P31).
    let wallet: Address;
    try {
      const first = (await embeddedWallets(privy(), caller.userId))[0];
      if (first === undefined) return reply.code(403).send({ error: "no-wallet" });
      wallet = getAddress(first);
    } catch (error) {
      request.log.error({ reason: privyErrorText(error) }, "rejected: claims accept, wallet lookup failed");
      return reply.code(502).send({ error: "privy-unavailable" });
    }
    if (!deliverable(wallet, caller.service)) {
      return reply.code(403).send({ error: "destination" });
    }

    const outcome = settle(reply, () =>
      acceptTickets(
        caller.service.store,
        {
          ticketIds: body.data.ticketIds,
          emailHashes: caller.hashes,
          destination: wallet,
          terms: body.data.terms,
          sendFuture: body.data.sendFuture,
          now: Math.floor(Date.now() / 1000),
          allowed: (ticket) => deliverable(wallet, caller.service, ticket.creatorWallet),
        },
        caller.service.caps,
      ),
    );
    if (outcome === undefined) return reply;
    if (!outcome.ok) {
      request.log.warn({ ip: request.ip, count: body.data.ticketIds.length, reason: outcome.reason }, "rejected: claims accept");
      return reply.code(statusFor(outcome.reason)).send({ error: wordFor(outcome.reason) });
    }
    request.log.info({ count: outcome.value.length, sendFuture: body.data.sendFuture }, "claims: tickets accepted");
    return reply.send({ accepted: outcome.value.map((ticket) => ticket.ticketId), destination: wallet });
  });

  app.post("/claims/refuse", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = refuseBody.safeParse(request.body);
    const caller = await callerOf(request, reply, () => (body.success ? null : fieldOf(body.error, ["ticketIds"])));
    if (caller === undefined || !body.success) return reply;
    const outcome = settle(reply, () =>
      refuseTickets(
        caller.service.store,
        { ticketIds: body.data.ticketIds, emailHashes: caller.hashes, now: Math.floor(Date.now() / 1000) },
        caller.service.caps,
      ),
    );
    if (outcome === undefined) return reply;
    if (!outcome.ok) {
      request.log.warn({ ip: request.ip, count: body.data.ticketIds.length, reason: outcome.reason }, "rejected: claims refuse");
      return reply.code(statusFor(outcome.reason)).send({ error: wordFor(outcome.reason) });
    }
    request.log.info({ count: outcome.value.length }, "claims: tickets refused");
    return reply.send({ refused: outcome.value.map((ticket) => ticket.ticketId) });
  });

  app.post("/claims/unmute", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = unmuteBody.safeParse(request.body);
    const caller = await callerOf(request, reply, () => (body.success ? null : fieldOf(body.error, ["platformKeyHash"])));
    if (caller === undefined || !body.success) return reply;
    const outcome = settle(reply, () => unmute(caller.service.store, caller.hashes, body.data.platformKeyHash.toLowerCase()));
    if (outcome === undefined) return reply;
    return outcome.ok ? reply.send({ ok: true }) : reply.code(409).send({ error: "record-refused" });
  });

  app.delete(
    "/claims/standing/:platformKeyHash",
    async (request: FastifyRequest<{ Params: { platformKeyHash: string } }>, reply: FastifyReply) => {
      const param = keyHashText.safeParse(request.params.platformKeyHash);
      const caller = await callerOf(request, reply, () => (param.success ? null : "platformKeyHash"));
      if (caller === undefined || !param.success) return reply;
      const outcome = settle(reply, () => clearStanding(caller.service.store, caller.hashes, param.data.toLowerCase()));
      if (outcome === undefined) return reply;
      return outcome.ok ? reply.send({ ok: true }) : reply.code(409).send({ error: "record-refused" });
    },
  );
}

/** A platform as every list in /claims names it: the listed name it was written under, and its key hash. */
function platformOf(row: { platformName: string; keyHash: string }): { name: string; keyHash: string } {
  return { name: row.platformName, keyHash: row.keyHash };
}

/** One row per platform, since a person with two verified addresses may hold the same choice twice. */
function onePerPlatform<T extends { keyHash: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.keyHash) ? false : (seen.add(row.keyHash), true)));
}

/** The first field a body failed on, by name only, or "body" for a key the route does not read. */
function fieldOf(error: z.ZodError, fields: readonly string[]): string {
  const first = error.issues[0]?.path[0];
  return typeof first === "string" && fields.includes(first) ? first : "body";
}

function statusFor(reason: string): number {
  if (reason === "not-found") return 404;
  if (reason === "destination") return 403;
  if (reason === "full") return 429;
  return 409;
}

/** The store's reasons that are already fixed words pass through; anything else is one word for a refused step. */
function wordFor(reason: string): string {
  return ["not-found", "not-open", "destination", "full"].includes(reason) ? reason : "record-refused";
}

