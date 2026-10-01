import type { FastifyRequest } from "fastify";
import { getAddress, type Hex } from "viem";
import { z } from "zod";
import { trainingSchema, type TrainingConsent } from "../consent.js";
import { MAX_UPLOAD_BYTES } from "../env.js";
import type { Platform } from "../platforms/platforms.js";
import { BadRequest, textField, underUploadCeiling } from "../routes/shared.js";
import { MAX_PLATFORM_STATEMENT_BYTES, platformStatementSchema } from "../statements.js";
import type { PlatformMode } from "./signatures.js";

/** Every text field a platform prepare may carry. Any other name is refused, never skipped. */
const FIELDS = [
  "mode",
  "title",
  "nonce",
  "issuedAt",
  "signature",
  "training",
  "creator",
  "wallet",
  "agentId",
  "deliverTo",
  "platformStatement",
] as const;

type FieldName = (typeof FIELDS)[number];

/** The most text fields the parser reads before it stops: one more than FIELDS, so an extra one is refused by name. */
export const MAX_PLATFORM_FIELDS = FIELDS.length + 1;

/** Checked before the JSON is parsed, as /prepare checks it: the whole statement is far smaller. */
const MAX_TRAINING_FIELD_BYTES = 1024;

const MAX_UINT64 = (1n << 64n) - 1n;

const titleSchema = z.string().trim().min(1).max(120);

export interface PlatformUpload {
  bytes: Buffer;
  mode: PlatformMode;
  title: string;
  nonce: Hex;
  issuedAt: bigint;
  /** Undefined when the request carried none, which the route refuses before any work (P19). */
  signature: string | undefined;
  training: TrainingConsent | undefined;
  /** Identity fields a body may repeat but never choose (P18). */
  claimed: { creator?: string; wallet?: string; agentId?: string };
  /**
   * The deliverTo field as sent, unread: it carries an email address, so it is parsed and hashed
   * only by readDeliverTo and never goes into a message this parser throws.
   */
  deliverTo: string | undefined;
  /**
   * The platform's own statement for the document, platform mode only, exactly as sent. Undefined
   * when the kit sent none, and then the document carries no statement at all.
   */
  platformStatement: string | undefined;
}

/**
 * Reads the picture and the fields of a platform prepare, counted against the upload ceilings as it
 * arrives, exactly as /prepare reads a studio upload.
 *
 * Throws BadRequest: 413 over the byte limit, 400 for a missing or misnamed file, a field this route
 * does not know or one sent twice, a mode other than "platform" or "cosign", a title outside 1 to 120
 * characters, a nonce that is not 32 bytes of hex, an issuedAt that is not a uint64, or terms the
 * consent contract would refuse (readTerms), or a platformStatement in co-sign mode or outside its
 * shape. UploadsBusy (503) past the ceiling.
 */
export async function readPlatformUpload(request: FastifyRequest): Promise<PlatformUpload> {
  if (!request.isMultipart()) {
    throw new BadRequest('send the picture in a multipart field named "file"');
  }
  return await underUploadCeiling(request, async () => await parse(request));
}

async function parse(request: FastifyRequest): Promise<PlatformUpload> {
  let bytes: Buffer | undefined;
  const fields = new Map<FieldName, string>();
  try {
    for await (const part of request.parts({ limits: { fileSize: MAX_UPLOAD_BYTES, fields: MAX_PLATFORM_FIELDS } })) {
      if (part.type === "file") {
        if (part.fieldname !== "file") {
          throw new BadRequest(`expected a multipart field named "file", got "${part.fieldname}"`);
        }
        bytes = await part.toBuffer();
        continue;
      }
      const name = FIELDS.find((one) => one === part.fieldname);
      if (name === undefined) {
        throw new BadRequest(`"${part.fieldname}" is not a field /platform/prepare reads`);
      }
      if (fields.has(name)) {
        throw new BadRequest(`the "${name}" field was sent twice`);
      }
      fields.set(name, textField(part));
    }
  } catch (error) {
    if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
      throw new BadRequest(`the picture is larger than the ${MAX_UPLOAD_BYTES} byte limit`, 413);
    }
    throw error;
  }

  if (bytes === undefined || bytes.length === 0) {
    throw new BadRequest('send the picture in a multipart field named "file"');
  }
  const mode = fields.get("mode");
  if (mode !== "platform" && mode !== "cosign") {
    throw new BadRequest('mode must be "platform" or "cosign"');
  }
  const title = titleSchema.safeParse(fields.get("title"));
  if (!title.success) {
    throw new BadRequest('send a "title" field of 1 to 120 characters');
  }
  const nonce = fields.get("nonce") ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
    throw new BadRequest("nonce must be 0x and 64 hex characters");
  }
  const issuedText = fields.get("issuedAt") ?? "";
  if (!/^[0-9]{1,20}$/.test(issuedText) || BigInt(issuedText) > MAX_UINT64) {
    throw new BadRequest("issuedAt must be a whole number of unix seconds");
  }
  const signature = fields.get("signature");
  const statement = fields.get("platformStatement");
  if (statement !== undefined) {
    // In co-sign mode the person swears Moolam's own line on the co-sign page, so a platform's
    // words would sit under a signature that is not the platform's.
    if (mode !== "platform") {
      throw new BadRequest("platformStatement is for platform mode; in co-sign mode the person signs Moolam's sworn line");
    }
    if (!platformStatementSchema.safeParse(statement).success) {
      throw new BadRequest(
        `platformStatement must be one line of printable text with no spaces at either end, at most ${MAX_PLATFORM_STATEMENT_BYTES} bytes`,
      );
    }
  }
  const claimed: PlatformUpload["claimed"] = {};
  for (const name of ["creator", "wallet", "agentId"] as const) {
    const value = fields.get(name);
    if (value !== undefined) claimed[name] = value;
  }
  return {
    bytes,
    mode,
    title: title.data,
    nonce: nonce.toLowerCase() as Hex,
    issuedAt: BigInt(issuedText),
    signature: signature === undefined || signature.trim().length === 0 ? undefined : signature.trim(),
    training: readTerms(fields.get("training")),
    claimed,
    deliverTo: fields.get("deliverTo"),
    platformStatement: statement,
  };
}

/**
 * The AI-use terms, through the one predicate the consent contract enforces (P9): the four answers
 * in the standard's words, the condition required exactly when an answer is "constrained", at most
 * 256 bytes of printable ASCII. The shared schema trims the condition; a condition that trimming
 * would change is refused here instead, so the bytes the platform stated are the bytes written into
 * the manifest, the metadata and later setConsent, with nothing rewritten on the way (P24).
 *
 * Throws BadRequest naming the field for anything the contract would refuse.
 */
export function readTerms(raw: string | undefined): TrainingConsent | undefined {
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_TRAINING_FIELD_BYTES) {
    throw new BadRequest(`training must be a JSON object under ${MAX_TRAINING_FIELD_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequest('training must be a JSON object, such as {"aiTraining":"notAllowed"}');
  }
  const statement = trainingSchema.safeParse(parsed);
  if (!statement.success) {
    throw new BadRequest(
      statement.error.issues.map((issue) => `${["training", ...issue.path].join(".")}: ${issue.message}`).join("; "),
    );
  }
  const stated = (parsed as { constraintInfo?: unknown }).constraintInfo;
  if (statement.data?.constraintInfo !== undefined && statement.data.constraintInfo !== stated) {
    throw new BadRequest("training.constraintInfo: must not start or end with a space, so it is written exactly as sent");
  }
  return statement.data;
}

/**
 * The identity field a body tried to choose, or null when it chose none (P18). In platform mode the
 * creator is the key's creator wallet and the agent the key's agent, so a body may repeat either and
 * never name another. In co-sign mode the creator is whoever opens the link, so a body may not name
 * one at all. Both sides go through getAddress or BigInt before they are compared.
 */
export function crossedField(upload: PlatformUpload, platform: Platform): "creator" | "wallet" | "agentId" | null {
  for (const name of ["creator", "wallet"] as const) {
    const value = upload.claimed[name];
    if (value === undefined) continue;
    if (upload.mode === "cosign") return name;
    let address: string;
    try {
      address = getAddress(value.trim());
    } catch {
      return name;
    }
    if (address !== platform.creatorWallet) return name;
  }
  const agentId = upload.claimed.agentId;
  if (agentId !== undefined) {
    const text = agentId.trim();
    if (!/^[0-9]{1,78}$/.test(text) || BigInt(text) !== platform.agentId) return "agentId";
  }
  return null;
}
