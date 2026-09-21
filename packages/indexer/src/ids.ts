import type { Address } from "envio";

/// The one row that holds the running totals for the whole index.
export const GLOBAL_STATS_ID = "global";

const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

/// Envio hands addresses back EIP-55 checksummed. Passport ids are lowercase hex
/// because they come from a bytes32. Lowercasing every address gives the whole
/// GraphQL API one casing rule instead of two, so a caller never misses a row by
/// looking it up with the wrong case.
export function addressId(address: Address | string): string {
  return address.toLowerCase();
}

/// A passport id is the exact hash of the image, as it appears in the event.
export function passportId(exactHash: string): string {
  return exactHash.toLowerCase();
}

/// The registry mints token id `uint256(exactHash)`, so an ERC-721 Transfer has
/// to be converted back to the 32 byte hash before it can find its passport.
export function passportIdFromTokenId(tokenId: bigint): string {
  return `0x${tokenId.toString(16).padStart(64, "0")}`;
}

/// An ERC-8004 agent id of zero means the image had no generating agent, so
/// there is no Generator row to attach.
export function generatorId(agentId: bigint): string | undefined {
  return agentId === 0n ? undefined : agentId.toString();
}

/// A parent id of zero bytes means this passport is an original, not an edit.
export function parentPassportId(parentId: string): string | undefined {
  const normalised = parentId.toLowerCase();
  return normalised === ZERO_BYTES32 ? undefined : normalised;
}

/// One attestation per log, so the transaction hash plus the log index is unique
/// even when a receiver attests to several passports in one transaction.
export function attestationId(txHash: string, logIndex: number): string {
  return `${txHash.toLowerCase()}-${logIndex}`;
}

/// One consent statement per passport per position in its history. The index
/// comes from the event, so a statement keeps the same row whether it is read
/// during the first sync or after a reorg replays the block it sits in.
export function consentEntryId(passport: string, index: number): string {
  return `${passport.toLowerCase()}-${index}`;
}

/// Buckets a block into a UTC calendar day, "YYYY-MM-DD". UTC and not local time
/// so the daily chart reads the same wherever it is served from.
export function dayId(blockTimestampSeconds: number): string {
  return new Date(blockTimestampSeconds * 1000).toISOString().slice(0, 10);
}
