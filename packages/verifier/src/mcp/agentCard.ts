import { isIP } from "node:net";
import type { Response } from "undici";
import { z } from "zod";
import { LOOKUP_TIMEOUT_MS, hostOf, safeFetch, type SafeFetchOptions } from "../net/safeFetch.js";
import { MAX_METADATA_BYTES, readMetadataDocument } from "../unseal.js";

/** The card type ERC-8004 names for a registration file. A document without it is not a card. */
export const CARD_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

/** A card is a short JSON document; the same 64 KB the metadata read allows, and the site's own cap. */
export const CARD_MAX_BYTES = MAX_METADATA_BYTES;

/**
 * No redirect is followed. safeFetch would check each hop's address, but not that the next hop is
 * still https to a named host, which is the rule the first hop is held to; a card host that moves
 * its file gets no card rather than a weaker check.
 */
const CARD_MAX_REDIRECTS = 0;

/**
 * The fields a card may carry, each cut to a length a model's context can afford (M4). Anything
 * else in the document is dropped: it was written by the agent's owner and nobody has vetted it.
 */
const LIMITS = { name: 100, description: 1_000, url: 500, short: 64, services: 16, registrations: 8, trust: 8 } as const;

const cardSchema = z.object({
  type: z.literal(CARD_TYPE),
  name: z.string().min(1),
  description: z.string().optional(),
  image: z.string().optional(),
  services: z
    .array(z.object({ name: z.string(), endpoint: z.string(), version: z.string().optional() }))
    .optional(),
  x402Support: z.boolean().optional(),
  active: z.boolean().optional(),
  registrations: z
    .array(z.object({ agentId: z.union([z.number(), z.string()]), agentRegistry: z.string() }))
    .optional(),
  supportedTrust: z.array(z.string()).optional(),
});

export interface AgentCard {
  name: string;
  description: string | null;
  image: string | null;
  services: { name: string; endpoint: string; version: string | null }[];
  x402Support: boolean | null;
  active: boolean | null;
  registrations: { agentId: string; agentRegistry: string }[];
  supportedTrust: string[];
}

/**
 * What a card read found. "card" is a document that passed the ERC-8004 shape; "none" is every
 * other outcome, with one of a fixed set of reasons and never the address or the host's words.
 */
export type CardAnswer =
  | { status: "card"; card: AgentCard }
  | { status: "none"; reason: "no-address" | "address-refused" | "unreadable" | "not-a-card" };

export type CardReader = (uri: string) => Promise<CardAnswer>;

function cut(value: string, max: number): string {
  return [...value].slice(0, max).join("");
}

/** The card a document is, cut to the limits above, or null when it is not an ERC-8004 card. */
export function cardFrom(document: unknown): AgentCard | null {
  const parsed = cardSchema.safeParse(document);
  if (!parsed.success) {
    return null;
  }
  const card = parsed.data;
  return {
    name: cut(card.name, LIMITS.name),
    description: card.description === undefined ? null : cut(card.description, LIMITS.description),
    image: card.image === undefined ? null : cut(card.image, LIMITS.url),
    services: (card.services ?? []).slice(0, LIMITS.services).map((service) => ({
      name: cut(service.name, LIMITS.short),
      endpoint: cut(service.endpoint, LIMITS.url),
      version: service.version === undefined ? null : cut(service.version, LIMITS.short),
    })),
    x402Support: card.x402Support ?? null,
    active: card.active ?? null,
    registrations: (card.registrations ?? []).slice(0, LIMITS.registrations).map((entry) => ({
      agentId: cut(String(entry.agentId), LIMITS.short),
      agentRegistry: cut(entry.agentRegistry, LIMITS.short * 2),
    })),
    supportedTrust: (card.supportedTrust ?? []).slice(0, LIMITS.trust).map((entry) => cut(entry, LIMITS.short)),
  };
}

/**
 * The card an https address may be fetched from, or null: https only, no user name or password,
 * and a host written as a name, never as an address or localhost. The name is then resolved and
 * checked by safeFetch, which also covers a public name pointing inward, the gap the site's own
 * check leaves open.
 */
export function cardHttpsUrl(uri: string): URL | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return null;
  }
  const host = hostOf(url).replace(/\.$/, "").toLowerCase();
  if (isIP(host) !== 0 || host === "localhost" || host.endsWith(".localhost")) {
    return null;
  }
  return url;
}

/** A data: address's JSON text, or null past the cap or when it does not decode. */
function dataText(uri: string): string | null {
  // Base64 grows a document by a third, so anything longer than this cannot decode under the cap.
  if (uri.length > Math.ceil(CARD_MAX_BYTES / 3) * 4 + 256) {
    return null;
  }
  const comma = uri.indexOf(",");
  if (comma === -1) {
    return null;
  }
  const meta = uri.slice("data:".length, comma);
  const payload = uri.slice(comma + 1);
  let text: string;
  if (meta.split(";").includes("base64")) {
    text = Buffer.from(payload, "base64").toString("utf8");
  } else {
    // The demo agent writes its JSON raw after the comma; a percent-encoded card decodes first.
    try {
      text = decodeURIComponent(payload);
    } catch {
      text = payload;
    }
  }
  return Buffer.byteLength(text, "utf8") > CARD_MAX_BYTES ? null : text;
}

/** The body as text, or null past `cap` bytes, counted after decompression. */
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
  return Buffer.concat(chunks).toString("utf8");
}

function parsed(text: string | null): unknown {
  if (text === null) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The agent card reader get_agent uses, held to the site's rules for an agent card and to M1:
 * a data: address is decoded in place under the size cap; ipfs:// is read only as a bare pinned
 * content id, through the configured gateway, by the same reader and cap as a passport's metadata;
 * https goes to a named host through safeFetch, with its address guard, its one deadline, no
 * redirect and the size cap. Anything else, and anything that fails, is no card.
 *
 * Never throws. `fetchOptions` is for tests, which point safeFetch's resolver and transport away
 * from the network.
 */
export function liveCardReader(fetchOptions: SafeFetchOptions = {}): CardReader {
  return async (uri) => {
    if (uri.length === 0) {
      return { status: "none", reason: "no-address" };
    }
    let document: unknown;
    try {
      if (uri.startsWith("data:")) {
        document = parsed(dataText(uri));
      } else if (uri.startsWith("ipfs://")) {
        document = await readMetadataDocument(uri, { timeoutMs: LOOKUP_TIMEOUT_MS, ...fetchOptions });
      } else {
        const url = cardHttpsUrl(uri);
        if (url === null) {
          return { status: "none", reason: "address-refused" };
        }
        const response = await safeFetch(url, {
          timeoutMs: LOOKUP_TIMEOUT_MS,
          maxRedirects: CARD_MAX_REDIRECTS,
          ...fetchOptions,
        });
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          return { status: "none", reason: "unreadable" };
        }
        document = parsed(await cappedText(response, CARD_MAX_BYTES));
      }
    } catch {
      return { status: "none", reason: "unreadable" };
    }
    if (document === undefined) {
      return { status: "none", reason: "unreadable" };
    }
    const card = cardFrom(document);
    return card === null ? { status: "none", reason: "not-a-card" } : { status: "card", card };
  };
}

/** A reader that finds no card without opening a connection: the default under a test runner. */
export function offlineCardReader(): CardReader {
  return async () => ({ status: "none", reason: "unreadable" });
}
