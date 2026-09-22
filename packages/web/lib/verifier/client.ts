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

/** The consent register's four words, in the contract's own vocabulary. */
const useWord = z.enum(["unspecified", "allowed", "notAllowed", "constrained"]);

/**
 * The three words a creator may say about one use on the way in. There is no
 * fourth: a use left out of the statement is one they have said nothing about,
 * which the service writes as absent rather than as a word of its own.
 */
const statedUse = z.enum(["allowed", "notAllowed", "constrained"]);

/**
 * How AI may use the picture, as /prepare and /generate take it and hand it
 * back, exactly as docs/api/verifier-endpoints.md describes it.
 *
 * The answer is the one that counts. The service trims the conditions text and
 * drops any choice it would not write, so the echo is what really went into the
 * signed manifest and the pinned metadata, and it is what the studio then writes
 * to the consent register so the file and the chain say the same words.
 */
const trainingSchema = z.object({
  aiTraining: statedUse.optional(),
  aiGenerativeTraining: statedUse.optional(),
  aiInference: statedUse.optional(),
  dataMining: statedUse.optional(),
  constraintInfo: z.string().optional(),
  standard: z.string().min(1),
});

const cidSchema = z.object({ cid: z.string().min(1), uri: z.string().min(1) });

/**
 * The signed picture itself, base64, as a sealed answer hands it back.
 *
 * It travels in the answer because the service pins no copy of it and keeps
 * none: this is the only copy there will be, and the browser checks its hash
 * against the passport id before anything is signed.
 */
const signedFileSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  bytes: z.string().min(1),
  sha256: hexWord,
});

/**
 * A key a sealed answer may not carry a value for.
 *
 * A sealed registration pins no image, no thumbnail and no manifest document,
 * so an answer that says sealed and still names a pin is not a sealed answer
 * this app knows. It is refused as malformed rather than read as either kind,
 * because guessing which half to believe is how a picture gets published by
 * accident.
 */
const noPin = z.undefined().optional();

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

const pinnedImage = cidSchema.extend({
  gatewayUrl: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const pinnedThumbnail = cidSchema.extend({ gatewayUrl: z.string().min(1) });

/** Everything both kinds of prepare answer carry, whatever became public. */
const preparedFields = {
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
  metadata: cidSchema,
  manifest: manifestSchema,
  training: trainingSchema.optional(),
  preparedBy: z.string().min(1),
};

/**
 * The two answers /prepare can give, and nothing in between.
 *
 * The sealed one carries the file and no pin; the public one carries the pins
 * and says nothing about sealing. An answer that mixes them fits neither, so it
 * is refused: the public branch names `sealed` as false on purpose, or a
 * sealed answer that still carried a pinned image would quietly pass as a
 * published one.
 */
export const prepareResponseSchema = z.union([
  z.object({
    ...preparedFields,
    sealed: z.literal(true),
    signedFile: signedFileSchema,
    image: noPin,
    thumbnail: noPin,
  }),
  z.object({
    ...preparedFields,
    sealed: z.literal(false).optional(),
    image: pinnedImage,
    thumbnail: pinnedThumbnail,
  }),
]);

/**
 * What the agent hands back after it has drawn, pinned and signed.
 *
 * The passport block carries two fields prepare does not: the creator it drew
 * for and the deadline it signed against. Both are the agent's, not the
 * browser's, because the agent's signature is already over them, so the
 * creator's passkey has to sign exactly what came back.
 */
const drawnFields = {
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
  metadata: cidSchema,
  manifest: manifestSchema,
  model: z.string().min(1),
  agent: z.object({ id: decimal, wallet: addressWord }),
  quota: quotaSchema,
  training: trainingSchema.optional(),
  preparedBy: z.string().min(1),
};

/** The same two answers on the agent path, held apart by the same rule. */
export const generateResponseSchema = z.union([
  z.object({
    ...drawnFields,
    sealed: z.literal(true),
    signedFile: signedFileSchema,
    image: noPin,
    thumbnail: noPin,
  }),
  z.object({
    ...drawnFields,
    sealed: z.literal(false).optional(),
    image: pinnedImage,
    thumbnail: pinnedThumbnail,
  }),
]);

/**
 * What /edit answers with once the child passport is on chain.
 *
 * The child block is the passport the service built and sent: the same fields the registry
 * stores, with the parent it was appended to. The hash is a real one, because the route waits
 * for Privy's relayer to report it before answering.
 */
export const editResponseSchema = z.object({
  child: z.object({
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
  tokenId: decimal,
  hash: hexWord,
  sponsored: z.boolean(),
  image: cidSchema.extend({
    gatewayUrl: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  thumbnail: cidSchema.extend({ gatewayUrl: z.string().min(1) }),
  metadata: cidSchema,
  manifest: manifestSchema,
  quota: quotaSchema,
});

/**
 * What the holder of a matched passport has stated about AI use, read by the
 * service from the consent register while it answered.
 *
 * Three sources and never a fourth, exactly as docs/api/verifier-endpoints.md
 * describes them. "chain" with stated false is the contract saying that holder
 * has never spoken; "unavailable" is the service saying it could not find out,
 * which is not the same thing and is never permission. The whole field is
 * optional, so a service that predates it leaves the stamp undrawn instead of
 * failing the answer a reader came for.
 */
const consentSchema = z.union([
  z.object({
    source: z.literal("chain"),
    stated: z.literal(true),
    standard: z.string(),
    aiTraining: useWord,
    aiGenerativeTraining: useWord,
    aiInference: useWord,
    dataMining: useWord,
    constraintInfo: z.string().optional(),
    /** Unix seconds: the block timestamp the statement was written at. */
    at: z.number().int().positive(),
    writer: addressWord,
  }),
  z.object({ source: z.literal("chain"), stated: z.literal(false) }),
  z.object({ source: z.literal("unavailable") }),
]);

/**
 * Whether the matched passport is under challenge, read live from the
 * registry's own dispute view while the service answered.
 *
 * The four words are the registry's DisputeStatus enum, one for one, exactly as
 * docs/api/verifier-endpoints.md describes them. It is read together with the
 * statement above: a holder's word about AI use rests on a record that a
 * challenge has put in question. "unavailable" is the service saying it could
 * not find out, which is not a clean record, and the whole field is optional so
 * a service that predates it leaves the line undrawn.
 */
const disputeSchema = z.union([
  z.object({ source: z.literal("chain"), status: z.enum(["none", "open", "upheld", "rejected"]) }),
  z.object({ source: z.literal("unavailable") }),
]);

/**
 * What has independently re-checked the matched picture since it was
 * registered: a Chainlink CRE workflow fetched it from the address in its
 * passport, recomputed the fingerprint and wrote the verdict to Monad.
 *
 * Three shapes and never a fourth, exactly as docs/api/verifier-endpoints.md
 * describes them. "index" with a count of zero is the service saying nothing
 * has re-checked this picture yet; "unavailable" is the service saying it
 * cannot tell, which is not the same thing. A count and a newest verdict that
 * disagree never travel together: the service sends the whole fact as
 * unavailable rather than half of it. The field is optional, so a service that
 * predates it leaves the line undrawn instead of failing the answer.
 */
const recheckSchema = z.union([
  z.object({
    source: z.literal("index"),
    attestations: z.number().int().positive(),
    matched: z.number().int().nonnegative(),
    mismatched: z.number().int().nonnegative(),
    latest: z.object({
      matched: z.boolean(),
      /** How many of the 64 fingerprint bits the recomputed value differed by. */
      distance: z.number().int().nonnegative(),
      /** Unix seconds: when the verdict was written. */
      at: z.number().int().positive(),
      receiver: addressWord,
    }),
  }),
  z.object({ source: z.literal("index"), attestations: z.literal(0) }),
  z.object({ source: z.literal("unavailable") }),
]);

const matchSchema = z.object({
  id: hexWord,
  consent: consentSchema.optional(),
  dispute: disputeSchema.optional(),
  recheck: recheckSchema.optional(),
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
export type EditResponse = z.infer<typeof editResponseSchema>;
export type GenerateResponse = z.infer<typeof generateResponseSchema>;
/** The answers that carry the picture instead of a link to it. */
export type SealedPrepareResponse = Extract<PrepareResponse, { sealed: true }>;
export type SealedGenerateResponse = Extract<GenerateResponse, { sealed: true }>;
export type SignedFile = z.infer<typeof signedFileSchema>;
export type VerifyResponse = z.infer<typeof verifyResponseSchema>;
export type QuotaState = z.infer<typeof quotaSchema>;
export type Match = z.infer<typeof matchSchema>;
export type MatchConsent = z.infer<typeof consentSchema>;
export type MatchRecheck = z.infer<typeof recheckSchema>;
export type MatchDispute = z.infer<typeof disputeSchema>;
export type StatedUse = z.infer<typeof statedUse>;
export type TrainingStatement = z.infer<typeof trainingSchema>;
/** The same statement on the way out. The standard is the service's to name, not a caller's. */
export type TrainingRequest = Omit<TrainingStatement, "standard">;

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
  | "no-signer"
  | "not-owner"
  | "no-parent"
  | "send-failed"
  | "send-pending"
  | "privy-unavailable"
  | "chain-unavailable"
  | "creator-mismatch"
  | "deadline-passed"
  | "already-registered"
  | "busy"
  | "pin-failed"
  | "sealed-metadata-refused"
  | "sealed-file-refused"
  | "offline"
  | "bad-response";

/** What a refusal names beside its code, when the route names anything at all. */
export interface VerifierDetail {
  /** A send Privy took and has not reported a hash for. It may still land, so it is never resent. */
  transactionId?: string;
  hash?: Hex;
  /**
   * The passport this failure is about: the one that already holds the picture on a 409, and the
   * child an /edit send-pending left out on the network.
   */
  passportId?: Hex;
  /**
   * Whether the service named this failure in its own body. A fetch that never got an answer, an
   * edge that returned 502 with an HTML page and a body this app could not read all name nothing,
   * and a caller cannot read "nothing was sent" into silence.
   */
  named?: boolean;
}

/** One failure a screen can branch on, with the service's own words kept in the message. */
export class VerifierError extends Error {
  readonly status: number;
  readonly code: VerifierCode;
  /** Only on a refused generation: what the creator has already used today. */
  readonly quota?: QuotaState;
  readonly transactionId?: string;
  readonly hash?: Hex;
  readonly passportId?: Hex;
  readonly named: boolean;

  constructor(
    code: VerifierCode,
    status: number,
    message: string,
    quota?: QuotaState,
    detail: VerifierDetail = {},
  ) {
    super(message);
    this.name = "VerifierError";
    this.code = code;
    this.status = status;
    this.quota = quota;
    this.transactionId = detail.transactionId;
    this.hash = detail.hash;
    this.passportId = detail.passportId;
    this.named = detail.named === true;
  }
}

/**
 * Prepares an upload for signing: the service embeds the manifest,
 * fingerprints the signed bytes and pins everything, and answers with the
 * passport fields the browser then signs with a passkey.
 *
 * The access token is the caller's Privy token. Without a valid one the
 * service answers 401 and nothing is pinned.
 *
 * The training statement is optional and travels as one JSON part, which is the
 * shape the route reads. Left out, the creator has said nothing about AI use,
 * and nothing about it goes into the manifest or the metadata.
 */
export async function prepare(options: {
  file: File;
  title: string;
  accessToken: string;
  training?: TrainingRequest;
  /** True to register the picture without publishing it. The route reads the two words and nothing else. */
  sealed?: boolean;
  signal?: AbortSignal;
}): Promise<PrepareResponse> {
  const body = new FormData();
  body.append("file", options.file);
  body.append("title", options.title);
  body.append("kind", "human");
  if (options.training !== undefined) {
    body.append("training", JSON.stringify(options.training));
  }
  // Left out rather than sent as false, so a service that predates sealing
  // reads the same request it always did.
  if (options.sealed === true) {
    body.append("sealed", "true");
  }

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
  training?: TrainingRequest;
  /** True to register the drawing without publishing it. */
  sealed?: boolean;
  /** Whether the prompt joins the public record. It only has a meaning on a sealed drawing. */
  includePrompt?: boolean;
  signal?: AbortSignal;
}): Promise<GenerateResponse> {
  const sealed = options.sealed === true;
  // A statement that was not made is left out of the body rather than sent as
  // null: the route refuses a key it has no room for, and an empty statement
  // and no statement mean the same thing to it. The prompt choice travels the
  // same way, because on a published drawing the prompt is public regardless.
  const body = JSON.stringify({
    prompt: options.prompt,
    title: options.title,
    creator: options.creator,
    deadline: options.deadline.toString(),
    training: options.training,
    sealed: sealed ? true : undefined,
    includePrompt: sealed ? options.includePrompt === true : undefined,
  });

  return await post("/generate", body, generateResponseSchema, {
    signal: options.signal,
    headers: { authorization: `Bearer ${options.accessToken}`, "content-type": "application/json" },
  });
}

/**
 * Appends an edited version of a passport the caller owns.
 *
 * Nothing is signed in the browser. The owner has already granted this app a signer on their
 * Privy wallet, held to appendEdit by a policy, so the service pins the edited picture and sends
 * the one transaction from the owner's own wallet with gas sponsored. The answer carries the
 * child passport, its transaction hash and what is left of today's allowance.
 *
 * The note is what the owner says they changed, up to 280 characters, and travels with the pinned
 * metadata rather than on chain.
 */
export async function edit(options: {
  file: File;
  title: string;
  parentId: Hex;
  note: string;
  accessToken: string;
  signal?: AbortSignal;
}): Promise<EditResponse> {
  const body = new FormData();
  body.append("file", options.file);
  body.append("title", options.title);
  body.append("parentId", options.parentId);
  body.append("note", options.note);

  return await post("/edit", body, editResponseSchema, {
    signal: options.signal,
    headers: { authorization: `Bearer ${options.accessToken}` },
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

/**
 * The host a file is actually sent to, for the sentence on the verify page that
 * promises where it goes. It is read from the same value the upload uses, so
 * the promise cannot drift from the destination.
 */
export function verifierHost(): string {
  try {
    return new URL(publicEnv.verifierUrl).host;
  } catch {
    return publicEnv.verifierUrl;
  }
}

let requestTimeoutMs = 120_000;

/** Tests shorten the wait; the product never calls this. */
export function configureRequestTimeout(ms: number): void {
  requestTimeoutMs = ms;
}

async function post<T>(
  path: string,
  body: BodyInit,
  schema: z.ZodType<T>,
  options: { signal?: AbortSignal; headers?: Record<string, string> },
): Promise<T> {
  let response: Response;
  // A service that accepts the request and never answers would otherwise hold a screen in its
  // busy state for good. The cap is generous because /generate draws for up to a minute and /edit
  // waits for Privy and the receipt; a timed-out call reads as offline, the caller's own abort
  // travels on unchanged.
  const timeout = AbortSignal.timeout(requestTimeoutMs);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  try {
    response = await fetch(verifierUrl(path), {
      method: "POST",
      body,
      headers: options.headers,
      signal,
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
 * The failures the routes name in the body rather than in the status, because
 * one status covers several of them: 400 is a bad field, a refused prompt or a
 * window that closed, 403 is a wrong creator or a wallet that does not hold the
 * parent, and 502 is any of the outside services plus a send that is still out.
 */
const BODY_CODES: Record<string, VerifierCode> = {
  quota: "quota",
  "prompt-refused": "prompt-refused",
  "model-failed": "model-failed",
  "sign-failed": "sign-failed",
  busy: "busy",
  "pin-failed": "pin-failed",
  "sealed-metadata-refused": "sealed-metadata-refused",
  "sealed-file-refused": "sealed-file-refused",
  "no-signer": "no-signer",
  "not-owner": "not-owner",
  "no-parent": "no-parent",
  "send-failed": "send-failed",
  "send-pending": "send-pending",
  "privy-unavailable": "privy-unavailable",
  "chain-unavailable": "chain-unavailable",
  "creator-mismatch": "creator-mismatch",
  "deadline-passed": "deadline-passed",
  "already-registered": "already-registered",
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
  let body: {
    error?: unknown;
    reason?: unknown;
    quota?: unknown;
    transactionId?: unknown;
    hash?: unknown;
    passportId?: unknown;
  } = {};
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
  const transactionId = typeof body.transactionId === "string" ? body.transactionId : "";
  return new VerifierError(code, response.status, message, quota.success ? quota.data : undefined, {
    transactionId: transactionId.length === 0 ? undefined : transactionId,
    hash: hexWordOrNothing(body.hash),
    passportId: hexWordOrNothing(body.passportId),
    named: typeof body.error === "string" && body.error.length > 0,
  });
}

/** A 32 byte word from a failure body, or nothing. Anything else is not worth carrying to a screen. */
function hexWordOrNothing(value: unknown): Hex | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? (value as Hex) : undefined;
}
