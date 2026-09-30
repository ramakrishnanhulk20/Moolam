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

/** The multipart body /platform/prepare reads: the file, the signed PlatformPrepare's parts, the title and the terms. */
export function prepareForm(file: Uint8Array, mode: PlatformMode, title: string, signed: SignedPrepare, terms?: AiUseTerms): FormData {
  assertTitle(title);
  const form = new FormData();
  form.set("mode", mode);
  form.set("title", title);
  form.set("nonce", signed.message.nonce);
  form.set("issuedAt", signed.message.issuedAt.toString());
  form.set("signature", signed.signature);
  if (terms !== undefined) {
    form.set("training", JSON.stringify(terms));
  }
  form.set("file", new Blob([new Uint8Array(file)], { type: "application/octet-stream" }), "picture");
  return form;
}
