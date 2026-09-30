import type { Address } from "viem";

/** Monad mainnet. Every Moolam signature names this chain, so a wallet on any other is refused. */
export const MONAD_CHAIN_ID = 143;

/** The Moolam passport registry on Monad mainnet: an ERC-721 whose token id is the picture's sha256. */
export const MOOLAM_REGISTRY: Address = "0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0";

/** The AI-use terms register on Monad mainnet. Only a passport's current holder may write to it. */
export const MOOLAM_CONSENT: Address = "0x1151E69a82947920546e779c4C8c785b2a3C1277";

/** The ERC-8004 identity registry on Monad mainnet. The owner of an agent token signs for that agent. */
export const AGENT_IDENTITY_REGISTRY: Address = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

/** The Moolam site a co-sign link opens on. */
export const MOOLAM_SITE_URL = "https://moolam.vercel.app";

/**
 * The hostnames Moolam's own passkeys are made under. A platform's server key must never claim one
 * of them, or any name under them, as its relying party (P20).
 */
export const MOOLAM_HOSTNAMES: readonly string[] = ["moolam.vercel.app"];

export const ZERO_BYTES32 = `0x${"00".repeat(32)}` as const;
