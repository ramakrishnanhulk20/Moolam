import { z } from "zod";
import type { Hex } from "viem";
import { publicEnv } from "@/lib/env";

/**
 * The co-sign page's side of the verify service's two browser routes,
 * GET /platform/record/:handle and GET /platform/status/:handle
 * (packages/verifier/src/routes/platform.ts). Both take the person's Privy
 * access token, and only in the Authorization header.
 *
 * Every refusal becomes a named outcome rather than an exception, so the page
 * draws a state for it. Nothing here logs, and no outcome carries the handle
 * or the address it was sent to (P4): the handle travels in one place, the
 * request path, and leaves this module in none.
 */

const hexWord = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as Hex);
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value as Hex);
const decimal = z.string().regex(/^\d{1,78}$/);

const fileSchema = z.object({
  cid: z.string().min(1).max(120),
  uri: z.string().min(1).max(200),
  gatewayUrl: z.string().min(1).max(400),
  bytes: z.number().int().positive(),
});

const passportSchema = z.object({
  exactHash: hexWord,
  parentId: hexWord,
  creator: address.optional(),
  generatorAgentId: decimal,
  phash: decimal,
  blockhash256: hexWord,
  manifestHash: hexWord,
  kind: z.number().int().min(0).max(255),
  fingerprintVersion: z.number().int().min(0).max(255),
  metadataURI: z.string().min(1).max(400),
  deadline: decimal.optional(),
});

const platformSchema = z.object({ name: z.string().max(200), agentId: decimal });

/** The words the service uses for where a record stands. The status route adds the last two from a chain read. */
export const RECORD_STATES = ["awaiting-creator", "creator-set", "signed", "expired", "registered", "failed"] as const;

export type RecordState = (typeof RECORD_STATES)[number];

const recordSchema = z.object({
  state: z.enum(RECORD_STATES),
  agentId: decimal,
  platform: platformSchema,
  exactHash: hexWord,
  passport: passportSchema,
  files: z.object({ image: fileSchema, thumbnail: fileSchema, manifest: fileSchema, metadata: fileSchema }),
  openBy: z.number().int().positive(),
  digest: hexWord.optional(),
  agentSignature: z
    .string()
    .regex(/^0x[0-9a-fA-F]{130}$/)
    .transform((value) => value.toLowerCase() as Hex)
    .optional(),
  chain: z.literal("unknown").optional(),
  reason: z.string().max(300).optional(),
});

export type CosignRecord = z.infer<typeof recordSchema>;

const namedSchema = z.object({
  agentId: decimal,
  platform: platformSchema.optional(),
  exactHash: hexWord,
});

/**
 * The facts a refusal still names, so a person told no still sees which
 * picture and which agent they were sent (P2).
 */
export type Named = z.infer<typeof namedSchema>;

export type RecordOutcome =
  | { kind: "record"; record: CosignRecord }
  | { kind: "signIn" }
  | { kind: "wrongWallet"; named: Named | null }
  | { kind: "notFound" }
  | { kind: "expired"; named: Named | null }
  | { kind: "refused" }
  | { kind: "unavailable" };

/** What reaches the network. A test swaps it; the page never does. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 15_000;

/** The record for this handle, opened by the signed-in person. The first open writes them in as its creator. */
export async function openRecord(handle: string, token: string, fetcher: Fetcher = fetch): Promise<RecordOutcome> {
  return await ask("record", handle, token, fetcher);
}

/** Where the record stands now, with the chain's word on it once it is signed (P13). */
export async function recordStatus(handle: string, token: string, fetcher: Fetcher = fetch): Promise<RecordOutcome> {
  return await ask("status", handle, token, fetcher);
}

async function ask(route: "record" | "status", handle: string, token: string, fetcher: Fetcher): Promise<RecordOutcome> {
  const base = publicEnv.verifierUrl.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetcher(`${base}/platform/${route}/${handle}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { kind: "unavailable" };
  }
  return await outcomeOf(response);
}

/** One answer from either route, as the state the page draws for it. */
export async function outcomeOf(response: Response): Promise<RecordOutcome> {
  const body = await response.json().catch(() => null);
  switch (response.status) {
    case 200: {
      const parsed = recordSchema.safeParse(body);
      return parsed.success ? { kind: "record", record: parsed.data } : { kind: "refused" };
    }
    case 401:
      return { kind: "signIn" };
    case 403:
      return { kind: "wrongWallet", named: namedFrom(body) };
    case 404:
      return { kind: "notFound" };
    case 410:
      return { kind: "expired", named: namedFrom(body) };
    case 409:
      return { kind: "refused" };
    default:
      return { kind: "unavailable" };
  }
}

function namedFrom(body: unknown): Named | null {
  const parsed = namedSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
