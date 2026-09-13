import { decodeErrorResult, encodeFunctionData, type Hex } from "viem";
import { registryAbi } from "./client";
import type { WebAuthnAuth } from "@/lib/passkey/webauthn";
import type { GenerateResponse, PrepareResponse } from "@/lib/verifier/client";

/**
 * The registry's PassportInput, field for field and in the same order as
 * IMoolamRegistry.sol. The order is load bearing: it is what the EIP-712 type
 * string is built from, so a field out of place changes the digest and the
 * passkey ends up signing something the contract will not recognise.
 */
export interface PassportInput {
  exactHash: Hex;
  parentId: Hex;
  creator: Hex;
  generatorAgentId: bigint;
  phash: bigint;
  blockhash256: Hex;
  manifestHash: Hex;
  kind: number;
  fingerprintVersion: number;
  metadataURI: string;
  deadline: bigint;
}

/**
 * How long a signed passport stays valid. Long enough for a creator to read
 * what they are signing and for the transaction to be mined, short enough that
 * a signature picked up later is already dead.
 */
export const SIGNATURE_WINDOW_SECONDS = 3600n;

/**
 * Turns what the verify service prepared into the struct the creator signs.
 *
 * The service knows nothing about the wallet, so the creator address is added
 * here, and the deadline is set from the browser's clock. pHash arrives as a
 * decimal string because 64 bits do not survive a JSON number.
 */
export function passportInputFrom(
  prepared: PrepareResponse["passport"],
  creator: Hex,
  now: number = Date.now(),
): PassportInput {
  return {
    exactHash: prepared.exactHash,
    parentId: prepared.parentId,
    creator,
    generatorAgentId: BigInt(prepared.generatorAgentId),
    phash: BigInt(prepared.phash),
    blockhash256: prepared.blockhash256,
    manifestHash: prepared.manifestHash,
    kind: prepared.kind,
    fingerprintVersion: prepared.fingerprintVersion,
    metadataURI: prepared.metadataURI,
    deadline: BigInt(Math.floor(now / 1000)) + SIGNATURE_WINDOW_SECONDS,
  };
}

/**
 * Turns what the agent drew and signed into the struct the creator signs.
 *
 * Nothing is added here, unlike the upload path: the agent's signature is
 * already over this exact struct, creator and deadline included, so a browser
 * that replaced either field would send two signatures over two different
 * digests and the registry would refuse the second one.
 */
export function passportInputFromGenerated(generated: GenerateResponse["passport"]): PassportInput {
  return {
    exactHash: generated.exactHash,
    parentId: generated.parentId,
    creator: generated.creator,
    generatorAgentId: BigInt(generated.generatorAgentId),
    phash: BigInt(generated.phash),
    blockhash256: generated.blockhash256,
    manifestHash: generated.manifestHash,
    kind: generated.kind,
    fingerprintVersion: generated.fingerprintVersion,
    metadataURI: generated.metadataURI,
    deadline: BigInt(generated.deadline),
  };
}

/** The transaction that binds a passkey to the wallet sending it, or rotates the bound one. */
export function bindPasskeyCalldata(qx: Hex, qy: Hex, auth: WebAuthnAuth): Hex {
  return encodeFunctionData({
    abi: registryAbi,
    functionName: "bindPasskey",
    args: [qx, qy, auth],
  });
}

/**
 * The transaction that registers an original image.
 *
 * generatorSig stays "0x" for a Captured image the creator made themselves.
 * A Generated one carries the agent owner's signature over the same digest.
 */
export function registerCalldata(input: PassportInput, auth: WebAuthnAuth, generatorSig: Hex = "0x"): Hex {
  return encodeFunctionData({
    abi: registryAbi,
    functionName: "register",
    args: [input, auth, generatorSig],
  });
}

/**
 * The transaction that opens a dispute against a passport.
 *
 * The bond does not appear here: it rides on the transaction as its value, and
 * the registry refuses anything that is not exactly what the policy asks for.
 * Only the keccak256 of the URI is stored, computed by the contract itself, so
 * what a challenger pointed at cannot be swapped afterwards.
 */
export function flagCalldata(passportId: Hex, evidenceURI: string): Hex {
  return encodeFunctionData({
    abi: registryAbi,
    functionName: "flag",
    args: [passportId, evidenceURI],
  });
}

/**
 * The transaction that settles an open dispute. Upheld marks the passport
 * disputed for good and credits the bond back to the challenger; rejected
 * leaves the record standing and credits the bond to the treasury.
 */
export function resolveCalldata(passportId: Hex, upheld: boolean): Hex {
  return encodeFunctionData({
    abi: registryAbi,
    functionName: "resolve",
    args: [passportId, upheld],
  });
}

/** The transaction that pulls whatever the registry owes the sender. */
export function withdrawCalldata(): Hex {
  return encodeFunctionData({ abi: registryAbi, functionName: "withdraw", args: [] });
}

/**
 * Names the custom error behind a failed call.
 *
 * viem buries the revert data a few layers down, so every candidate string on
 * the error is tried against the ABI. Returns undefined when the failure was
 * not a revert this contract knows, which is the case for a rejected wallet
 * prompt or a dropped connection.
 */
export function decodeRegistryError(error: unknown): string | undefined {
  for (const data of revertData(error)) {
    try {
      return decodeErrorResult({ abi: registryAbi, data }).errorName;
    } catch {
      // Not this one. The next candidate might be the actual revert.
    }
  }
  return undefined;
}

function revertData(error: unknown): Hex[] {
  const found: Hex[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === null || current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string") {
      if (/^0x[0-9a-fA-F]{8,}$/.test(current)) {
        found.push(current as Hex);
      }
      continue;
    }
    if (typeof current !== "object") {
      continue;
    }

    const record = current as Record<string, unknown>;
    for (const key of ["data", "cause", "error", "details", "raw", "signature"]) {
      if (key in record) {
        queue.push(record[key]);
      }
    }
  }

  return found;
}
