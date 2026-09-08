import { lookup as systemLookup, type LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch, type Response } from "undici";
import { FETCH_TIMEOUT_MS } from "../env.js";

/**
 * The address ranges a server-side fetch must never reach. A request made from
 * inside our network can see the private LAN, the loopback interface and the
 * cloud metadata service, none of which the caller is entitled to read.
 */
const BLOCKED_RANGES = new Set([
  "private",
  "loopback",
  "linkLocal",
  "uniqueLocal",
  "unspecified",
  "multicast",
  "carrierGradeNat",
  "broadcast",
  "reserved",
]);

/** The cloud metadata endpoint, named on its own so the refusal is unmistakable in a log. */
const METADATA_ADDRESS = "169.254.169.254";

const MAX_REDIRECTS = 3;

/** How long the socket may take to open before the attempt is abandoned. */
const CONNECT_TIMEOUT_MS = 5_000;

export class BlockedTarget extends Error {
  readonly statusCode = 403;
}

export class UnreachableTarget extends Error {
  readonly statusCode = 502;
}

/** Resolves a host name to every address it points at. */
export type ResolveAll = (hostname: string) => Promise<string[]>;

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  /** Swapped in tests so a name can be pointed at a chosen address without touching DNS. */
  resolve?: ResolveAll;
  /** Swapped in tests so a redirect chain can be replayed without a network. */
  transport?: (url: string, init: { signal: AbortSignal; redirect: "manual" }) => Promise<Response>;
}

/**
 * Whether an address is one we are willing to open a socket to.
 *
 * Every form of an address is folded to one canonical value first with
 * ipaddr.process, so "::ffff:127.0.0.1" and "::ffff:7f00:1" are both judged as
 * 127.0.0.1 rather than as some unfamiliar IPv6 host. The hexadecimal and
 * decimal spellings of an IPv4 address (0x7f000001, 2130706433) are folded by
 * the URL parser before they ever reach here.
 */
export function isPublicAddress(address: string): boolean {
  let parsed: ReturnType<typeof ipaddr.process>;
  try {
    parsed = ipaddr.process(address);
  } catch {
    return false;
  }
  if (parsed.toString() === METADATA_ADDRESS) {
    return false;
  }
  return !BLOCKED_RANGES.has(parsed.range());
}

/** The host of a URL with the brackets an IPv6 literal carries stripped off. */
export function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

/** Resolves a name through the system resolver, and an address literal to itself. */
export const resolveThroughDns: ResolveAll = async (hostname) => {
  if (isIP(hostname) !== 0) {
    return [hostname];
  }
  return await new Promise<string[]>((resolve, reject) => {
    systemLookup(hostname, { all: true, verbatim: true }, (error, addresses: LookupAddress[]) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(addresses.map((entry) => entry.address));
    });
  });
};

/**
 * The socket-level guard: the lookup the connection itself uses.
 *
 * Checking a name and then handing the name to fetch leaves a gap, because the
 * second resolution can answer differently from the first. This closes it: the
 * addresses the socket is given are the addresses that were checked, and a name
 * that resolves to anything private fails the connection instead of being
 * dialled.
 */
export function guardedLookup(resolve: ResolveAll): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname)
      .then((addresses) => {
        const refused = addresses.filter((address) => !isPublicAddress(address));
        if (addresses.length === 0 || refused.length > 0) {
          callback(new BlockedTarget(`refusing to fetch ${hostname}: not a public address`), "", 0);
          return;
        }
        const entries = addresses.map((address) => {
          const parsed = ipaddr.process(address);
          return { address: parsed.toString(), family: parsed.kind() === "ipv6" ? 6 : 4 };
        });
        const first = entries[0] as { address: string; family: number };
        if ((options as { all?: boolean }).all === true) {
          callback(null, entries as never);
          return;
        }
        callback(null, first.address, first.family);
      })
      .catch((error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)), "", 0);
      });
  };
}

/**
 * Fetches a URL that a caller chose, refusing anything that points inside our
 * own network, before and after every redirect.
 *
 * Redirects are followed by hand because a public URL that bounces to an
 * internal address is the classic way in, and every hop is checked the same way
 * as the first. The connection is pinned to the addresses that were checked.
 *
 * Throws BlockedTarget (403) when a hop resolves to an address we refuse, and
 * UnreachableTarget (502) when the host does not answer or the chain of
 * redirects runs past the limit.
 */
export async function safeFetch(url: URL, options: SafeFetchOptions = {}): Promise<Response> {
  const resolve = options.resolve ?? resolveThroughDns;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const transport = options.transport ?? pinnedTransport(resolve, timeoutMs);

  let target = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertPublicHost(target, resolve);

    let response: Response;
    try {
      response = await transport(target.toString(), {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      });
    } catch (error) {
      if (error instanceof BlockedTarget) {
        throw error;
      }
      throw new UnreachableTarget(`could not fetch ${target.toString()}: ${reasonOf(error)}`);
    }

    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) {
      return response;
    }
    target = new URL(location, target);
  }

  throw new UnreachableTarget(`fetching ${url.toString()} redirected more than ${maxRedirects} times`);
}

/**
 * Checks the host before the request is made, so a private address is refused
 * with a reason a caller can read rather than as a failed connection.
 *
 * Throws BlockedTarget when the name is localhost, resolves to nothing, or
 * resolves to any address we refuse.
 */
async function assertPublicHost(url: URL, resolve: ResolveAll): Promise<void> {
  const host = hostOf(url);
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new BlockedTarget(`refusing to fetch ${host}: not a public address`);
  }

  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (error) {
    throw new UnreachableTarget(`could not resolve ${host}: ${reasonOf(error)}`);
  }

  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new BlockedTarget(`refusing to fetch ${host}: not a public address`);
  }
}

function pinnedTransport(
  resolve: ResolveAll,
  timeoutMs: number,
): (url: string, init: { signal: AbortSignal; redirect: "manual" }) => Promise<Response> {
  const dispatcher = new Agent({
    connect: { lookup: guardedLookup(resolve), timeout: CONNECT_TIMEOUT_MS },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });

  return async (url, init) => {
    try {
      return await undiciFetch(url, { ...init, dispatcher });
    } finally {
      // close() waits for the body to finish streaming and then drops the
      // sockets, so no pooled connection outlives the check that approved it.
      void dispatcher.close();
    }
  };
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
  }
  return String(error);
}
