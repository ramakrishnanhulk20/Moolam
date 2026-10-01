import { z } from "zod";
import type { Hex } from "viem";
import { publicEnv } from "@/lib/env";
import { refusalFor, type ClaimRefusal } from "./refusal";

/**
 * My pictures' side of the verify service's claim routes
 * (packages/verifier/src/routes/claims.ts): what platforms are holding for the
 * signed-in person's verified email, and their answer to it.
 *
 * Every route takes the person's Privy access token, and only in the
 * Authorization header: never in the path, the query or the body, so it is in
 * no log line, history entry or referrer. Every refusal comes back as a named
 * outcome with plain words and a next step, so the page draws a state for it.
 *
 * Nothing in an answer is taken as the person's email. The service never sends
 * one (P29), and the schemas below drop any key they do not name, so a page
 * that wants the address reads it from the person's own session.
 */

/** setConsentBatch takes 32 passports, and the service refuses a longer list whole (P32, P37). */
export const MAX_IDS_PER_CALL = 32;

export const VERIFIED_BY = ["google", "email-code", "platform"] as const;
export type VerifiedBy = (typeof VERIFIED_BY)[number];

const USE_WORDS = ["unspecified", "allowed", "notAllowed", "constrained"] as const;

const ticketId = z.string().regex(/^[0-9a-f]{32}$/);
const passportId = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as Hex);
const keyHash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as Hex);
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value as Hex);

const platformSchema = z.object({ name: z.string().min(1).max(200), keyHash });

/** The service's own preview rule already ran (P36); the page holds the picture to its pinned rule again before drawing it. */
const previewSchema = z.object({ title: z.string().min(1).max(400), image: z.string().min(1).max(200) });

export const termsSchema = z.object({
  aiTraining: z.enum(USE_WORDS),
  aiGenerativeTraining: z.enum(USE_WORDS),
  aiInference: z.enum(USE_WORDS),
  dataMining: z.enum(USE_WORDS),
  constraintInfo: z.string().max(1024),
});

export type ClaimTerms = z.infer<typeof termsSchema>;

const offerSchema = z.object({
  ticketId,
  passportId,
  platform: platformSchema,
  verifiedBy: z.enum(VERIFIED_BY),
  preview: previewSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
});

const waitingSchema = z.object({
  ticketId,
  passportId,
  platform: platformSchema,
  state: z.enum(["accepted", "delivered", "failed"]),
  destination: address,
  terms: termsSchema,
});

const claimsSchema = z.object({
  offers: z.array(offerSchema).max(200),
  waiting: z.array(waitingSchema).max(200),
  standing: z.array(z.object({ platform: platformSchema, destination: address })).max(200),
  muted: z.array(z.object({ platform: platformSchema })).max(200),
});

export type ClaimOffer = z.infer<typeof offerSchema>;
export type WaitingClaim = z.infer<typeof waitingSchema>;
export type ClaimsAnswer = z.infer<typeof claimsSchema>;
export type ClaimPlatform = z.infer<typeof platformSchema>;

const acceptedSchema = z.object({ accepted: z.array(ticketId), destination: address });
const refusedSchema = z.object({ refused: z.array(ticketId) });
const okSchema = z.object({ ok: z.literal(true) });

export type ClaimOutcome<T> = { ok: true; value: T } | { ok: false; refusal: ClaimRefusal };

/** What reaches the network. A test swaps it; the page never does. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 20_000;

/** Everything platforms hold for this person, what they accepted, and the choices they keep per platform. */
export async function readClaims(token: string, fetcher: Fetcher = fetch): Promise<ClaimOutcome<ClaimsAnswer>> {
  return await ask("GET", "/claims", token, undefined, claimsSchema, fetcher);
}

/** "These are mine" for up to 32 offers, with the AI-use terms the confirm step will write. */
export async function acceptClaims(
  input: { ticketIds: string[]; terms: ClaimTerms; sendFuture: boolean },
  token: string,
  fetcher: Fetcher = fetch,
): Promise<ClaimOutcome<z.infer<typeof acceptedSchema>>> {
  const tooMany = idsRefusal(input.ticketIds);
  if (tooMany !== null) return tooMany;
  return await ask(
    "POST",
    "/claims/accept",
    token,
    { ticketIds: input.ticketIds, terms: input.terms, sendFuture: input.sendFuture },
    acceptedSchema,
    fetcher,
  );
}

/** "Not mine" for up to 32 offers. The service also stops that platform offering more to this email. */
export async function refuseClaims(
  ticketIds: string[],
  token: string,
  fetcher: Fetcher = fetch,
): Promise<ClaimOutcome<z.infer<typeof refusedSchema>>> {
  const tooMany = idsRefusal(ticketIds);
  if (tooMany !== null) return tooMany;
  return await ask("POST", "/claims/refuse", token, { ticketIds }, refusedSchema, fetcher);
}

/** Lets a platform this person said no to offer pictures again. */
export async function unmutePlatform(platformKeyHash: Hex, token: string, fetcher: Fetcher = fetch): Promise<ClaimOutcome<{ ok: true }>> {
  return await ask("POST", "/claims/unmute", token, { platformKeyHash }, okSchema, fetcher);
}

/** Stops a platform sending future pictures straight to this person's wallet. */
export async function stopStanding(platformKeyHash: Hex, token: string, fetcher: Fetcher = fetch): Promise<ClaimOutcome<{ ok: true }>> {
  if (!/^0x[0-9a-f]{64}$/.test(platformKeyHash)) {
    return { ok: false, refusal: refusalFor(400, null) };
  }
  return await ask("DELETE", `/claims/standing/${platformKeyHash}`, token, undefined, okSchema, fetcher);
}

/** An empty list or one over the cap is never sent: the service would refuse it whole anyway. */
function idsRefusal(ids: readonly string[]): { ok: false; refusal: ClaimRefusal } | null {
  return ids.length === 0 || ids.length > MAX_IDS_PER_CALL ? { ok: false, refusal: refusalFor(400, null) } : null;
}

async function ask<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  token: string,
  body: unknown,
  schema: z.ZodType<T>,
  fetcher: Fetcher,
): Promise<ClaimOutcome<T>> {
  const base = publicEnv.verifierUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  let response: Response;
  try {
    response = await fetcher(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, refusal: refusalFor(0, null) };
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return { ok: false, refusal: refusalFor(response.status, payload) };
  }
  const parsed = schema.safeParse(payload);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, refusal: refusalFor(-1, null) };
}
