import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { dayLimitRefusal, type DayAction, type DayTake } from "./globalDay.js";

/**
 * Either the slot this request took, or the 429 the route should return.
 *
 * The refusal is already written when `ok` is false, so the route hands it straight back rather
 * than repeating the shape, the sentence and the retry-after in three places.
 */
export type DayGate = { ok: true; slot: DayTake } | { ok: false; refused: FastifyReply };

/**
 * Takes one of today's slots for `action`, or refuses the request on behalf of the whole world.
 *
 * The three routes that spend money asked for this in the same words three times over, and one of
 * the three had drifted, so it lives here once. The order of the checks is the route's business
 * and does not change: this is called after the caller's token and their own allowance have both
 * let them through, and before the first thing that costs anything.
 *
 * `handBack` runs before the refusal is written, for whatever this request took in front of the
 * ceiling. A ceiling that is not this creator's fault must not eat their own allowance.
 */
export function takeToday(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  action: DayAction,
  handBack?: () => void,
): DayGate {
  const today = app.globalDay.tryTake(action);
  if (today.ok) {
    return { ok: true, slot: today };
  }

  handBack?.();
  request.log.warn(
    { url: request.url, action, used: today.use.used, max: today.use.max },
    "rejected: today's ceiling for everyone is spent",
  );
  const refusal = dayLimitRefusal(today.use);
  return {
    ok: false,
    refused: reply.code(429).header("retry-after", String(refusal.retryAfter)).send(refusal.body),
  };
}
