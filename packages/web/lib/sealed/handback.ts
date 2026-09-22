import type { Hex } from "viem";
import type { SignedFile } from "@/lib/verifier/client";

/**
 * The signed picture as this browser holds it: decoded, measured, and ready to
 * be written to the creator's own disk.
 *
 * There is no second copy anywhere. The verify service pinned nothing of the
 * picture and kept nothing, so what is in this Blob is the only thing that can
 * ever unseal the passport about to be signed.
 */
export interface SealedHandback {
  name: string;
  type: string;
  blob: Blob;
  /** The hash this browser computed, which has already been held against the passport id. */
  sha256: Hex;
  size: number;
}

/**
 * Why a sealed answer was not good enough to sign over.
 *
 * None of these reaches the screen. The creator gets one sentence for all three,
 * because the difference between them is this app's or the service's problem to
 * fix and telling them apart helps nobody holding a picture.
 */
export type SealedProblem = "notSealed" | "undecodable" | "hashMismatch";

export type SealedCheck = { ok: true; file: SealedHandback } | { ok: false; problem: SealedProblem };

/**
 * Invariant 3 of the sealed threat model, in one function: the creator holds
 * the bytes before the chain does.
 *
 * Three values have to agree before anything is signed. The hash this browser
 * computes over the bytes it received, the hash the service put beside them,
 * and the passport id the registry is about to commit to. Two of those agreeing
 * is not enough: the id is what the chain stores, the recomputed hash is the
 * only one this browser can trust, and the service's own field is what proves
 * the two ends are talking about the same file.
 *
 * A creator whose file did not survive the trip would otherwise sign a
 * commitment to a picture nobody holds, and an immutable registry has no way to
 * take that back.
 */
export async function checkSealedFile(options: {
  signedFile: SignedFile;
  /** The passport id from the same answer, which is what the passkey is about to sign. */
  passportId: Hex;
}): Promise<SealedCheck> {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(options.signedFile.bytes);
  } catch {
    return { ok: false, problem: "undecodable" };
  }
  if (bytes.length === 0) {
    return { ok: false, problem: "undecodable" };
  }

  const sha256 = await sha256Of(bytes);
  const claimed = options.signedFile.sha256.toLowerCase();
  const id = options.passportId.toLowerCase();
  if (sha256 !== claimed || sha256 !== id) {
    return { ok: false, problem: "hashMismatch" };
  }

  return {
    ok: true,
    file: {
      name: options.signedFile.name,
      type: options.signedFile.type,
      // Copied into the Blob so the base64 text can be dropped: at the 20 MB
      // cap the string and the bytes together are most of what this tab holds.
      blob: new Blob([bytes as BlobPart], { type: options.signedFile.type }),
      sha256: sha256 as Hex,
      size: bytes.length,
    },
  };
}

/** The SHA-256 of some bytes, as the registry writes it: 0x and 64 lower case characters. */
export async function sha256Of(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return `0x${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Base64 to bytes, through the browser's own decoder.
 *
 * Throws on anything atob will not take, which is the first sign that what came
 * back is not the file it says it is.
 */
export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * What the studio is allowed to do next with an answer, decided before a
 * passkey is touched.
 *
 * Keeping it here rather than inside the hook means the gate can be run on its
 * own with a tampered byte, which is the one test that matters: "stop" has to
 * come out of it, and the caller has nothing to sign.
 */
export type SealedDecision =
  | { next: "sign"; file: SealedHandback | null }
  | { next: "stop"; failure: "sealedNotHeld" | "sealedMismatch" };

/** Just enough of a prepare or generate answer to judge it. */
export interface SealedAnswer {
  sealed?: boolean;
  signedFile?: SignedFile;
  passport: { exactHash: Hex };
}

/**
 * Whether this answer may go on to the passkey prompt.
 *
 * A published registration passes straight through with nothing to hold. A
 * sealed one passes only once the check above has agreed three ways. An answer
 * that was asked to be sealed and came back without a file stops the run: the
 * creator asked for this picture to be kept, and signing a passport over
 * whatever the service did instead is not this app's call to make.
 */
export async function decideSealed(answer: SealedAnswer, asked: boolean): Promise<SealedDecision> {
  if (answer.sealed !== true || answer.signedFile === undefined) {
    return asked ? { next: "stop", failure: "sealedNotHeld" } : { next: "sign", file: null };
  }

  const check = await checkSealedFile({ signedFile: answer.signedFile, passportId: answer.passport.exactHash });
  return check.ok ? { next: "sign", file: check.file } : { next: "stop", failure: "sealedMismatch" };
}
