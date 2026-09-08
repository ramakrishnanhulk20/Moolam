import type { Hex } from "viem";
import { addresses, chain, gatewayUrl } from "./client";

/** Thrown when the identity registry has no token with that id. */
export class AgentNotFound extends Error {
  constructor(agentId: bigint) {
    super(`no agent ${agentId} on the identity registry`);
    this.name = "AgentNotFound";
  }
}

/**
 * The two reads Moolam needs from the ERC-8004 identity registry. It is an
 * ERC-721, so the agent card is whatever tokenURI points at, and the demo agent
 * carries its card inline as a data URI.
 */
const identityAbi = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ type: "string" }],
  },
] as const;

const CARD_TIMEOUT_MS = 8_000;

/**
 * Reads an agent's owner and card.
 *
 * The card is best effort: a URI that does not answer, or answers with
 * something that is not JSON, leaves `card` null and the page says so. An id
 * that was never minted throws AgentNotFound, which is a different answer from
 * "the chain is unreachable" and is shown differently.
 */
export async function getAgent(agentId: bigint): Promise<{ owner: Hex; uri: string; card: unknown | null }> {
  let owner: Hex;
  try {
    owner = (await chain.readContract({
      address: addresses.agentIdentity,
      abi: identityAbi,
      functionName: "ownerOf",
      args: [agentId],
    })) as Hex;
  } catch (error) {
    if (String(error).includes("reverted")) {
      throw new AgentNotFound(agentId);
    }
    throw error;
  }

  const uri = await chain.readContract({
    address: addresses.agentIdentity,
    abi: identityAbi,
    functionName: "tokenURI",
    args: [agentId],
  });

  return { owner, uri, card: await readCard(uri) };
}

async function readCard(uri: string): Promise<unknown | null> {
  if (uri.startsWith("data:")) {
    return parseDataUri(uri);
  }
  const url = gatewayUrl(uri);
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return null;
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(CARD_TIMEOUT_MS) });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function parseDataUri(uri: string): unknown | null {
  const comma = uri.indexOf(",");
  if (comma === -1) {
    return null;
  }
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  try {
    const text = meta.includes(";base64")
      ? Buffer.from(payload, "base64").toString("utf8")
      : decodeURIComponent(payload);
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
