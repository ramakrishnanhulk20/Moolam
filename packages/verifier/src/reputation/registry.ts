import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "viem/chains";
import { env } from "../env.js";
import type { Hex } from "../types.js";

/**
 * The canonical ERC-8004 Reputation Registry on Monad mainnet, the one Monad's
 * own guide points builders at. It is a proxy; the implementation behind the
 * ERC-1967 slot is 0x16e0FA7f7C56B9a767E34B192B51f921BE31dA34 and reports
 * getVersion() "2.0.0".
 */
export const REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as Hex;

/** Monad mainnet. The registries only exist here, not on the testnet. */
export const MONAD_CHAIN_ID = 143;

/**
 * Both tags Moolam writes on every entry. Reading back a summary needs the same
 * pair, because the registry filters by tag and there is no "all tags" view.
 */
export const FEEDBACK_TAG_PRODUCT = "moolam";
export const FEEDBACK_TAG_KIND = "verification";

/**
 * The four functions Moolam uses, matched against the deployed implementation's
 * selectors before this file was written:
 *   0x3c036a7e giveFeedback   0x81bbba58 getSummary
 *   0x42dd519c getClients     0xf2d81759 getLastIndex
 *
 * giveFeedback's parameters, in the order the deployment takes them:
 *   agentId        the ERC-8004 identity token id being rated
 *   value          the score itself, a signed 128-bit number
 *   valueDecimals  how many decimal places `value` carries, so 90 with 0 is
 *                  ninety and 900 with 1 is also ninety
 *   tag1, tag2     two free-text labels the read side filters on
 *   endpoint       which service of the agent this feedback is about
 *   feedbackURI    where the long form of this review lives off chain
 *   feedbackHash   the hash of that off-chain document, so it cannot be
 *                  swapped later
 *
 * The deployment has no feedback authorisation, no EIP-712 domain and no nonce.
 * It refuses feedback from the agent's owner or an approved operator, which is
 * why the verifier signs with its own wallet.
 */
export const reputationAbi = [
  {
    type: "function",
    name: "giveFeedback",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "endpoint", type: "string" },
      { name: "feedbackURI", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getSummary",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddresses", type: "address[]" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
    ],
    outputs: [
      { name: "count", type: "uint64" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
    ],
  },
  {
    type: "function",
    name: "getClients",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "clients", type: "address[]" }],
  },
  {
    type: "function",
    name: "getLastIndex",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddress", type: "address" },
    ],
    outputs: [{ name: "index", type: "uint64" }],
  },
] as const;

/**
 * The way every read and every send in this service reaches Monad.
 *
 * MONAD_MAINNET_RPC_URL answers first and MONAD_RPC_FALLBACK_URL only picks up what it drops, so a
 * rate-limited minute on a dedicated endpoint becomes a slower answer rather than a failed one.
 * Ranking is off on purpose: the order is the one written here, not whichever endpoint happened to
 * be quickest a moment ago. When the two names hold the same address there is nothing to fall back
 * to, so it stays a plain transport instead of asking one endpoint twice for every failure.
 *
 * Both sides of that comparison come out of the same environment schema, which trims and checks
 * them, so they are compared as the strings that schema produced rather than parsed again here.
 *
 * Neither address is ever logged or returned. viem writes the endpoint it called into its own
 * errors, and a dedicated endpoint's path is its access token, so the routes answer with their own
 * words instead of viem's.
 */
export function monadTransport(options: { rpcUrl?: string; timeout?: number } = {}): Transport {
  const first = options.rpcUrl ?? env.MONAD_MAINNET_RPC_URL;
  const second = env.MONAD_RPC_FALLBACK_URL;
  const settings = options.timeout === undefined ? {} : { timeout: options.timeout };
  if (first === second) {
    return http(first, settings);
  }
  return fallback([http(first, settings), http(second, settings)], { rank: false });
}

/** A read-only client on Monad mainnet. Tests pass their own transport instead of a URL. */
export function readClient(
  options: { rpcUrl?: string; transport?: Transport } = {},
): PublicClient<Transport, typeof monad> {
  return createPublicClient({
    chain: monad,
    transport: options.transport ?? monadTransport({ rpcUrl: options.rpcUrl }),
  });
}

/**
 * A signing client for the verifier's own wallet.
 *
 * The key never leaves this process and is never logged. Throws when the key is
 * not 32 bytes of hex, so a truncated .env line fails before a transaction is
 * built rather than after.
 */
export function writeClient(
  signerKey: Hex,
  options: { rpcUrl?: string; transport?: Transport } = {},
): { wallet: WalletClient<Transport, typeof monad, PrivateKeyAccount>; address: Hex } {
  const account = privateKeyToAccount(signerKey);
  const wallet = createWalletClient({
    account,
    chain: monad,
    transport: options.transport ?? monadTransport({ rpcUrl: options.rpcUrl }),
  });
  return { wallet, address: account.address as Hex };
}
