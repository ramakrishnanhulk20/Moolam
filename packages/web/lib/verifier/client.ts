import { z } from "zod";
import type { Hex } from "viem";
import { publicEnv } from "@/lib/env";

/**
 * The browser's side of the verify service. The shapes below are read off the
 * routes in packages/verifier/src/routes, so a change there fails here loudly
 * at the schema instead of quietly at the screen that renders it.
 */

const hexWord = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32 byte hex word")
  .transform((value) => value as Hex);

/** 64 bit hashes and agent ids travel as decimal strings, never as doubles. */
const decimal = z.string().regex(/^\d+$/, "expected a decimal string");

const addressWord = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20 byte address")
  .transform((value) => value as Hex);

/**
 * The agent's signature, 64 or 65 bytes. Privy signs 65, and the registry's
 * checker takes the shorter compact form too, so both are let through rather
 * than pinning the browser to one wallet's habit.
 */
const signatureWord = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/, "expected a 64 or 65 byte signature")
  .transform((value) => value as Hex);

const cidSchema = z.object({ cid: z.string().min(1), uri: z.string().min(1) });

const manifestSchema = z.union([
  z.object({ embedded: z.literal(true) }),
  z.object({ embedded: z.literal(false), reason: z.string().optional() }),
]);

/** How many pictures this creator has had from the agent today, and when the oldest one drops out. */
export const quotaSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  resetsAt: z.number().int().positive(),
});

export const prepareResponseSchema = z.object({
  passport: z.object({
    exactHash: hexWord,
    parentId: hexWord,
    generatorAgentId: decimal,
    phash: decimal,
    blockhash256: hexWord,
    manifestHash: hexWord,
    kind: z.number().int().min(0).max(2),
    fingerprintVersion: z.number().int().min(1).max(255),
    metadataURI: z.string().min(1),
  }),
  image: cidSchema.extend({
    gatewayUrl: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  thumbnail: cidSchema.extend({ gatewayUrl: z.string().min(1) }),
  metadata: cidSchema,
  manifest: manifestSchema,
  preparedBy: z.string().min(1),
});

/**
 * What the agent hands back after it has drawn, pinned and signed.
 *
 * The passport block carries two fields prepare does not: the creator it drew
 * for and the deadline it signed against. Both are the agent's, not the
 * browser's, because the agent's signature is already over them, so the
 * creator's passkey has to sign exactly what came back.
 */
export const generateResponseSchema = z.object({
  passport: z.object({
    exactHash: hexWord,
    parentId: hexWord,
    creator: addressWord,
    generatorAgentId: decimal,
    phash: decimal,
    blockhash256: hexWord,
    manifestHash: hexWord,
    kind: z.number().int().min(0).max(2),
    fingerprintVersion: z.number().int().min(1).max(255),
    metadataURI: z.string().min(1),
    deadline: decimal,
  }),
  generatorSig: signatureWord,
  image: cidSchema.extend({
    gatewayUrl: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  thumbnail: cidSchema.extend({ gatewayUrl: z.string().min(1) }),
  metadata: cidSchema,
  manifest: manifestSchema,
  model: z.string().min(1),
  agent: z.object({ id: decimal, wallet: addressWord }),
  quota: quotaSchema,
  preparedBy: z.string().min(1),
});

const matchSchema = z.object({
  id: hexWord,
  phashDistance: z.number().int().nonnegative(),
  blockhashDistance: z.number().int().nonnegative(),
  variant: z.enum([
    "identity",
    "rot90",
    "rot180",
    "rot270",
    "mirror",
    "mirror-rot90",
    "mirror-rot180",
    "mirror-rot270",
  ]),
  score: z.number(),
});

export const verifyResponseSchema = z.object({
  result: z.object({
    exact: hexWord.nullable(),
    best: matchSchema.nullable(),
    matches: z.array(matchSchema),
    confidence: z.number().min(0).max(1),
    queried: z.object({
      sha256: hexWord,
      phash: decimal,
      blockhash: hexWord,
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      format: z.string(),
    }),
  }),
  manifest: z.object({
    present: z.boolean(),
    manifestHash: hexWord.optional(),
    title: z.string().optional(),
    claimGenerator: z.string().optional(),
    actions: z.array(z.string()).optional(),
    ingredients: z.number().int().nonnegative().optional(),
    softBinding: z.object({ alg: z.string(), phash: decimal, blockhash: hexWord }).optional(),
  }),
});

export type PrepareResponse = z.infer<typeof prepareResponseSchema>;
export type GenerateResponse = z.infer<typeof generateResponseSchema>;
export type VerifyResponse = z.infer<typeof verifyResponseSchema>;
export type QuotaState = z.infer<typeof quotaSchema>;
export type Match = z.infer<typeof matchSchema>;

export type VerifierCode =
  | "unauthorized"
  | "bad-request"
  | "too-large"
  | "not-an-image"
  | "rate-limited"
  | "quota"
  | "prompt-refused"
  | "model-failed"
  | "sign-failed"
  | "busy"
  | "pin-failed"
  | "offline"
  | "bad-response";

/** One failure a screen can branch on, with the service's own words kept in the message. */
export class VerifierError extends Error {
  readonly status: number;
  readonly code: VerifierCode;
  /** Only on a refused generation: what the creator has already used today. */
  readonly quota?: QuotaState;

  constructor(code: VerifierCode, status: number, message: string, quota?: QuotaState) {
    super(message);
    this.name = "VerifierError";
    this.code = code;
    this.status = status;
    this.quota = quota;
  }
}

/**
 * Prepares an upload for signing: the service embeds the manifest,
 * fingerprints the signed bytes and pins everything, and answers with the
 * passport fields the browser then signs with a passkey.
 *
 * The access token is the caller's Privy token. Without a valid one the
 * service answers 401 and nothing is pinned.
 */
export async function prepare(options: {
  file: File;
  title: string;
  accessToken: string;
  signal?: AbortSignal;
}): Promise<PrepareResponse> {
  const body = new FormData();
  body.append("file", options.file);
  body.append("title", options.title);
  body.append("kind", "human");

  return await post("/prepare", body, prepareResponseSchema, {
    signal: options.signal,
    headers: { authorization: `Bearer ${options.accessToken}` },
  });
}

/**
 * Asks the generator agent for a picture and its half of the signature.
 *
 * The service draws, embeds the manifest, pins everything and signs the
 * passport with the agent's Privy wallet. Nothing reaches the chain here: the
 * browser adds the creator's passkey signature over the same struct and sends
 * the one transaction.
 *
 * The deadline is the window both signatures are good for, in unix seconds,
 * and the service refuses anything under ten minutes or over two hours.
 */
export async function generate(options: {
  prompt: string;
  title: string;
  creator: Hex;
  deadline: bigint | number;
  accessToken: string;
  signal?: AbortSignal;
}): Promise<GenerateResponse> {
  const body = JSON.stringify({
    prompt: options.prompt,
    title: options.title,
    creator: options.creator,
    deadline: options.deadline.toString(),
  });

  return await post("/generate", body, generateResponseSchema, {
    signal: options.signal,
    headers: { authorization: `Bearer ${options.accessToken}`, "content-type": "application/json" },
  });
}

/** Matches an image against the registry. No sign in: anyone may check a picture. */
export async function verify(options: { file: File; signal?: AbortSignal }): Promise<VerifyResponse> {
  const body = new FormData();
  body.append("file", options.file);

  return await post("/verify", body, verifyResponseSchema, { signal: options.signal });
}

export function verifierUrl(path: string): string {
  return `${publicEnv.verifierUrl.replace(/\/$/, "")}${path}`;
}

async function post<T>(
  path: string,
  body: BodyInit,
  schema: z.ZodType<T>,
  options: { signal?: AbortSignal; headers?: Record<string, string> },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(verifierUrl(path), {
      method: "POST",
      body,
      headers: options.headers,
      signal: options.signal,
    });
  } catch (error) {
    // An abort is the caller's own doing, so it travels on rather than being renamed.
    if (options.signal?.aborted === true) {
      throw error;
    }
    throw new VerifierError("offline", 0, `the verify service at ${verifierUrl(path)} did not answer`);
  }

  if (!response.ok) {
    throw await failureOf(response);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new VerifierError("bad-response", response.status, "the verify service answered with something that is not JSON");
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    throw new VerifierError("bad-response", response.status, `the verify service answered in a shape this app does not know: ${detail}`);
  }

  return parsed.data;
}

/**
 * The failures /generate names in the body rather than in the status, because
 * one status covers several of them: 400 is a bad field or a refused prompt,
 * and 502 is any one of the three outside services.
 */
const BODY_CODES: Record<string, VerifierCode> = {
  quota: "quota",
  "prompt-refused": "prompt-refused",
  "model-failed": "model-failed",
  "sign-failed": "sign-failed",
  busy: "busy",
  "pin-failed": "pin-failed",
};

function codeFor(status: number): VerifierCode {
  if (status === 401 || status === 403) {
    return "unauthorized";
  }
  if (status === 413) {
    return "too-large";
  }
  if (status === 415) {
    return "not-an-image";
  }
  if (status === 429) {
    return "rate-limited";
  }
  if (status === 502) {
    return "pin-failed";
  }
  if (status === 400) {
    return "bad-request";
  }
  return "bad-response";
}

/**
 * The routes answer failures as { error: "..." }, sometimes with the model's
 * own reason or the quota beside it, and anything else is reported as the
 * status.
 */
async function failureOf(response: Response): Promise<VerifierError> {
  let body: { error?: unknown; reason?: unknown; quota?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // A body that is not JSON says nothing useful, so the status speaks instead.
  }

  const named = typeof body.error === "string" ? BODY_CODES[body.error] : undefined;
  const code = named ?? codeFor(response.status);

  const message =
    typeof body.reason === "string" && body.reason.length > 0
      ? body.reason
      : typeof body.error === "string" && body.error.length > 0
        ? body.error
        : `the verify service answered ${response.status}`;

  const quota = quotaSchema.safeParse(body.quota);
  return new VerifierError(code, response.status, message, quota.success ? quota.data : undefined);
}
