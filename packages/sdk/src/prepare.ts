import { createHash, randomBytes } from "node:crypto";
import { getAddress, recoverTypedDataAddress, type Address, type Hex, type LocalAccount } from "viem";
import { chainNow, type ChainReader } from "./chain.js";
import { MODE, prepareTypedData, type PlatformMode, type PlatformPrepareMessage } from "./eip712.js";
import { MoolamPlatformError } from "./errors.js";
import type { AiUseTerms } from "./terms.js";

/** Signing, fingerprinting and pinning a picture takes the service a while. */
export const PREPARE_TIMEOUT_MS = 120_000;

/**
 * The account that owns the platform's ERC-8004 agent token. It signs every PlatformPrepare and
 * every passport; any viem local account works, including one backed by a key vault.
 */
export type AgentAccount = Pick<LocalAccount, "address" | "signTypedData">;

/** A platform key as Moolam hands it out: 32 bytes written as 64 hex characters. */
const PLATFORM_KEY = /^[0-9a-fA-F]{64}$/;

/** Throws MoolamPlatformError "invalid-input" for anything that is not a Moolam platform key. The key is never quoted. */
export function assertPlatformKey(platformKey: string): void {
  if (typeof platformKey !== "string" || !PLATFORM_KEY.test(platformKey)) {
    throw new MoolamPlatformError("invalid-input", "the platform key must be the 64 hex characters Moolam issued");
  }
}

/**
 * The platform's id as the verify service knows it: the sha256 of the key's 32 raw bytes, the value
 * its signed entry records. Safe to publish; the key itself is not.
 */
export function platformIdOf(platformKey: string): Hex {
  assertPlatformKey(platformKey);
  return `0x${createHash("sha256").update(Buffer.from(platformKey.toLowerCase(), "hex")).digest("hex")}`;
}

/** The sha256 of a file's exact bytes, as 0x hex: a picture's hash, and a signed file's passport id. */
export function sha256Hex(bytes: Uint8Array): Hex {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

export interface SignedPrepare {
  message: PlatformPrepareMessage;
  signature: Hex;
}

/**
 * Builds and signs the PlatformPrepare the verify service checks before it signs a manifest naming
 * the platform's agent (P19): the mode, the sha256 of the exact file, the platform id, a fresh
 * 32-byte nonce from the CSPRNG, and issuedAt read from the latest block, signed by the agent owner
 * in the "Moolam platform" domain on chain 143.
 *
 * The signature is recovered here before it is returned, so a signer that signed something else
 * fails now, not at the service.
 *
 * Throws MoolamPlatformError "invalid-input" for an empty file or a malformed key, and
 * "unexpected-answer" when the signature does not recover to the agent account.
 */
export async function signPlatformPrepare(input: {
  file: Uint8Array;
  mode: PlatformMode;
  platformKey: string;
  agentAccount: AgentAccount;
  reader: ChainReader;
}): Promise<SignedPrepare> {
  if (!(input.file instanceof Uint8Array) || input.file.length === 0) {
    throw new MoolamPlatformError("invalid-input", "the picture must be its file's bytes");
  }
  const message: PlatformPrepareMessage = {
    mode: MODE[input.mode],
    pictureHash: sha256Hex(input.file),
    platformId: platformIdOf(input.platformKey),
    nonce: `0x${randomBytes(32).toString("hex")}`,
    issuedAt: await chainNow(input.reader),
  };
  const typed = prepareTypedData(message);
  const signature = await input.agentAccount.signTypedData(typed);
  const signer: Address = await recoverTypedDataAddress({ ...typed, signature });
  if (signer !== getAddress(input.agentAccount.address)) {
    throw new MoolamPlatformError("unexpected-answer", "the agent account signed the PlatformPrepare with another key");
  }
  return { message, signature };
}

/** Throws MoolamPlatformError "invalid-input" unless the title is 1 to 120 characters, the service's rule. */
export function assertTitle(title: string): void {
  if (typeof title !== "string" || title.trim().length === 0 || title.trim().length > 120) {
    throw new MoolamPlatformError("invalid-input", "the title must be 1 to 120 characters");
  }
}

/** How the platform knows an email address belongs to its user: its claim, shown to the person as the platform's word. */
export type VerifiedBy = "google" | "email-code" | "platform";

/** The user's email a platform-mode passport waits for at Moolam, and how the platform checked it. */
export interface DeliverTo {
  email: string;
  verifiedBy: VerifiedBy;
}

const VERIFIED_BY: readonly string[] = ["google", "email-code", "platform"];

/** The longest address the service's rule takes, in code points. */
const MAX_EMAIL_CODE_POINTS = 254;

/**
 * Throws MoolamPlatformError "invalid-input" unless deliverTo is an object of exactly an email and one
 * of the three verifiedBy words. The email is only checked for shape and size here; the verify
 * service normalises and judges it by its one rule (P28), so the kit never holds a second parser for
 * it. Errors name the field and never the value (P29).
 */
export function assertDeliverTo(deliverTo: DeliverTo): void {
  if (deliverTo === null || typeof deliverTo !== "object" || Array.isArray(deliverTo)) {
    throw new MoolamPlatformError("invalid-input", "deliverTo must be an object of email and verifiedBy");
  }
  if (Object.keys(deliverTo).some((key) => key !== "email" && key !== "verifiedBy")) {
    throw new MoolamPlatformError("invalid-input", "deliverTo carries only email and verifiedBy");
  }
  const email = deliverTo.email;
  if (typeof email !== "string" || email.trim().length === 0 || [...email.trim()].length > MAX_EMAIL_CODE_POINTS) {
    throw new MoolamPlatformError("invalid-input", `deliverTo.email must be an address of 1 to ${MAX_EMAIL_CODE_POINTS} characters`);
  }
  if (typeof deliverTo.verifiedBy !== "string" || !VERIFIED_BY.includes(deliverTo.verifiedBy)) {
    throw new MoolamPlatformError("invalid-input", 'deliverTo.verifiedBy must be "google", "email-code" or "platform"');
  }
}

/**
 * Throws MoolamPlatformError "invalid-input" unless the platform's statement is a non-empty string.
 * The full rule (one printable line, the byte limit, no spaces at either end) is the verify service's,
 * which refuses rather than rewrites, so the kit holds no second copy of it and never trims. Errors
 * name the field and never the value.
 */
export function assertPlatformStatement(statement: string): void {
  if (typeof statement !== "string" || statement.length === 0) {
    throw new MoolamPlatformError("invalid-input", "platformStatement must be a non-empty string");
  }
}

/**
 * The multipart body /platform/prepare reads: the file, the signed PlatformPrepare's parts, the title,
 * the terms and, in platform mode, the email the passport waits for and the platform's own statement.
 * The email travels only here, in the body over https, never in a URL or a header. The statement goes
 * exactly as given, and only in platform mode: a co-sign passport carries the person's sworn line.
 *
 * Throws MoolamPlatformError "invalid-input" for a bad title, an empty statement, or a statement in
 * co-sign mode.
 */
export function prepareForm(
  file: Uint8Array,
  mode: PlatformMode,
  title: string,
  signed: SignedPrepare,
  terms?: AiUseTerms,
  deliverTo?: DeliverTo,
  platformStatement?: string,
): FormData {
  assertTitle(title);
  if (platformStatement !== undefined) {
    if (mode !== "platform") {
      throw new MoolamPlatformError("invalid-input", "platformStatement is for platform mode; a co-sign passport carries the person's sworn line");
    }
    assertPlatformStatement(platformStatement);
  }
  const form = new FormData();
  form.set("mode", mode);
  form.set("title", title);
  form.set("nonce", signed.message.nonce);
  form.set("issuedAt", signed.message.issuedAt.toString());
  form.set("signature", signed.signature);
  if (terms !== undefined) {
    form.set("training", JSON.stringify(terms));
  }
  if (deliverTo !== undefined) {
    form.set("deliverTo", JSON.stringify({ email: deliverTo.email, verifiedBy: deliverTo.verifiedBy }));
  }
  if (platformStatement !== undefined) {
    form.set("platformStatement", platformStatement);
  }
  form.set("file", new Blob([new Uint8Array(file)], { type: "application/octet-stream" }), "picture");
  return form;
}
