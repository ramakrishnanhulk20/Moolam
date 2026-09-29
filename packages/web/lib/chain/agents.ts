import { unstable_cache } from "next/cache";
import type { Hex } from "viem";
import { CACHE_TAGS, HOLD_SECONDS, addresses, chain, gatewayUrl } from "./client";

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

/** An agent card is a short JSON document; anything past this is not one. */
export const CARD_MAX_BYTES = 64 * 1024;

/** A card host may move its file once or twice, and every hop is held to the same rule. */
const CARD_MAX_HOPS = 3;

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

  return { owner, uri, card: await readAgentCard(uri) };
}

/**
 * The same read, held for a minute.
 *
 * An agent's owner and card are two chain reads and often a gateway fetch, and
 * the page asks for them twice: once for the tab's title and once for the page
 * itself. An id that was never minted still throws every time, because a throw
 * is never kept, which is what stops a page from remembering a 404 for an agent
 * that gets minted a second later. The argument is a string because a bigint
 * cannot be part of a cache key.
 */
export const heldAgent = unstable_cache(
  async (agentId: string) => await getAgent(BigInt(agentId)),
  ["moolam-agent-identity"],
  { revalidate: HOLD_SECONDS, tags: [CACHE_TAGS.chain] },
);

/**
 * The address an agent card may be fetched from, or null.
 *
 * This read runs on the server only: the agent page, the agents roster and the
 * passport facts are server components, and the answer is held in the server's
 * cache. The token URI is whatever the agent's owner wrote on chain, so an
 * address that points back into Moolam's own machine or network is the thing
 * to refuse. ipfs:// is read through the gateway, and after that only https to
 * a named host passes: no http, no IP address written as the host, no
 * localhost. A name that resolves to a private address is not caught here.
 */
export function cardUrl(uri: string): URL | null {
  let url: URL;
  try {
    url = new URL(gatewayUrl(uri));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return null;
  }
  // The URL parser already writes every IPv4 spelling (0x7f.1, 2130706433) as
  // four decimal parts and wraps IPv6 in brackets, so these two shapes cover them.
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return null;
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    return null;
  }
  return url;
}

/**
 * The agent card a token URI names, or null when it is not one Moolam will read.
 *
 * data: is decoded in place. Everything else goes through cardUrl, with an
 * eight second limit for the whole read, a size cap, and every redirect checked
 * against the same rule before it is followed.
 */
export async function readAgentCard(uri: string): Promise<unknown | null> {
  if (uri.startsWith("data:")) {
    return parseDataUri(uri);
  }
  let url = cardUrl(uri);
  if (url === null) {
    return null;
  }
  const signal = AbortSignal.timeout(CARD_TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= CARD_MAX_HOPS; hop += 1) {
      const response: Response = await fetch(url, { signal, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        const next: URL | null = location === null ? null : cardUrl(new URL(location, url).href);
        if (next === null) {
          return null;
        }
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const text = await cappedText(response, CARD_MAX_BYTES);
      return text === null ? null : (JSON.parse(text) as unknown);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The body as text, or null past `cap` bytes. A declared length over the cap is
 * refused unread, and otherwise reading stops at the first chunk past it.
 */
async function cappedText(response: Response, cap: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
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
