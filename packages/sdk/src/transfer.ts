import { getAddress, isAddress, parseEventLogs, zeroAddress, type Address, type Hex } from "viem";
import { registryAbi } from "./abi.js";
import { assertMonad, readerFor, sendAndConfirm, walletAddress, type ChainReader, type PlatformWalletClient } from "./chain.js";
import { MOOLAM_REGISTRY } from "./constants.js";
import { MoolamPlatformError } from "./errors.js";

export interface PassportTransfer {
  passportId: Hex;
  from: Address;
  to: Address;
  txHash: Hex;
  blockNumber: bigint;
}

/**
 * The one check every address a passport is sent to passes, whether a person typed it, the platform
 * stored it, or the verify service answered it (P22, P31). Returns the address checksummed.
 *
 * Covers: a malformed address, a mixed-case address whose checksum is wrong, the zero address, the
 * platform's own wallet and the registry. Does not cover: whether the address belongs to the person
 * the platform means, or whether a contract there can receive ERC-721 tokens (the send's simulation
 * catches that one).
 *
 * Throws MoolamPlatformError "invalid-input" for a malformed address and "refused-recipient" for the
 * three refused ones. The address is never quoted.
 */
export function checkedRecipient(to: unknown, from: Address): Address {
  const text = typeof to === "string" ? to.trim() : "";
  // getAddress alone lower-cases a mixed-case address without checking its checksum, so a typo that
  // still spells 40 hex characters would pass. The strict check refuses a mixed-case address whose
  // checksum is wrong; an all-lower or all-upper address carries no checksum and is accepted.
  if (!isAddress(text, { strict: true })) {
    throw new MoolamPlatformError("invalid-input", "the recipient is not a valid address; check every character, or its checksum");
  }
  const recipient: Address = getAddress(text);
  if (recipient === zeroAddress) {
    throw new MoolamPlatformError("refused-recipient", "a passport sent to the zero address would be lost for good");
  }
  if (recipient === getAddress(from)) {
    throw new MoolamPlatformError("refused-recipient", "the recipient is the platform's own wallet, which already holds the passport");
  }
  if (recipient === getAddress(MOOLAM_REGISTRY)) {
    throw new MoolamPlatformError("refused-recipient", "a passport sent to the registry itself could never be moved again");
  }
  return recipient;
}

/** Throws MoolamPlatformError "invalid-input" unless the id is 0x and 64 hex characters; returns it lower-cased. */
export function checkedPassportId(passportId: unknown): Hex {
  if (typeof passportId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(passportId)) {
    throw new MoolamPlatformError("invalid-input", "a passport id is 0x and 64 hex characters");
  }
  return passportId.toLowerCase() as Hex;
}

/**
 * The registry's ownerOf for a passport, checksummed, read now.
 *
 * Throws MoolamPlatformError "not-holder" when the read fails, which is how the registry answers an
 * id it never minted.
 */
export async function holderOf(reader: ChainReader, id: Hex): Promise<Address> {
  try {
    return getAddress(await reader.readContract({ address: MOOLAM_REGISTRY, abi: registryAbi, functionName: "ownerOf", args: [BigInt(id)] }));
  } catch {
    throw new MoolamPlatformError("not-holder", "no passport with this id exists on the registry", { passportId: id });
  }
}

/**
 * Sends safeTransferFrom from the platform's wallet after simulating it, and answers only from a
 * receipt with status success that carries this Transfer, and after ownerOf, read again, names the
 * recipient. The caller has already checked the recipient and that the wallet holds the passport.
 *
 * Throws MoolamPlatformError "transaction-failed".
 */
export async function sendTransfer(
  walletClient: PlatformWalletClient,
  reader: ChainReader,
  id: Hex,
  from: Address,
  recipient: Address,
): Promise<PassportTransfer> {
  const tokenId = BigInt(id);
  const { hash, receipt } = await sendAndConfirm(walletClient, reader, {
    address: MOOLAM_REGISTRY,
    abi: registryAbi,
    functionName: "safeTransferFrom",
    args: [from, recipient, tokenId],
  });
  const moved = parseEventLogs({ abi: registryAbi, eventName: "Transfer", logs: receipt.logs }).some(
    (log) =>
      log.address.toLowerCase() === MOOLAM_REGISTRY.toLowerCase() &&
      log.args.from === from &&
      log.args.to === recipient &&
      log.args.tokenId === tokenId,
  );
  const now = getAddress(await reader.readContract({ address: MOOLAM_REGISTRY, abi: registryAbi, functionName: "ownerOf", args: [tokenId] }));
  if (!moved || now !== recipient) {
    throw new MoolamPlatformError("transaction-failed", "the transfer landed but the registry does not show the recipient holding the passport", {
      hash,
    });
  }
  return { passportId: id, from, to: recipient, txHash: hash, blockNumber: receipt.blockNumber };
}

/**
 * Hands a passport the platform's wallet holds to the person who claims it, by the registry's
 * safeTransferFrom. `to` must pass checkedRecipient: the strict checksum check, then getAddress, so a
 * mistyped checksum is refused rather than guessed, and the zero address, the platform's own wallet
 * and the registry itself are refused (P22).
 * A contract that cannot receive ERC-721 tokens makes the simulation revert, so nothing is sent.
 *
 * The result exists only for a receipt with status success that carries this Transfer, and after
 * ownerOf, read again, names `to`.
 *
 * Throws MoolamPlatformError: "invalid-input" for a malformed id or address, "refused-recipient",
 * "wrong-chain", "not-holder" when the wallet does not hold the passport, and "transaction-failed".
 */
export async function transferPassport(passportId: Hex, to: string, walletClient: PlatformWalletClient): Promise<PassportTransfer> {
  const id = checkedPassportId(passportId);
  const from = walletAddress(walletClient);
  const recipient = checkedRecipient(to, from);

  const reader = readerFor(walletClient);
  await assertMonad(reader);
  const holder = await holderOf(reader, id);
  if (holder !== from) {
    throw new MoolamPlatformError("not-holder", "the platform's wallet does not hold this passport", { passportId: id, holder });
  }
  return await sendTransfer(walletClient, reader, id, from, recipient);
}
