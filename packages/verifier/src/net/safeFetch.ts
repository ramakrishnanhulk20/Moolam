import { promises as dnsPromises } from "node:dns";
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

/**
 * The hard limit on one hop's name lookup, whatever the resolver does. A caller chooses the host,
 * so a host whose name server answers slowly on purpose must cost a few seconds and no more.
 */
export const LOOKUP_TIMEOUT_MS = 3_000;

/** c-ares's own limits for one query, inside the hard limit above: one second a try, two tries. */
const RESOLVER_QUERY_TIMEOUT_MS = 1_000;
const RESOLVER_TRIES = 2;

export class BlockedTarget extends Error {
  readonly statusCode = 403;
}

export class UnreachableTarget extends Error {
  readonly statusCode = 502;
}

/** Resolves a host name to every address it points at. */
export type ResolveAll = (hostname: string) => Promise<string[]>;

/** The two queries a name is resolved with: the shape of node's dns.promises.Resolver. */
export interface RecordResolver {
  resolve4: (hostname: string) => Promise<string[]>;
  resolve6: (hostname: string) => Promise<string[]>;
}

/**
 * What one hop hands the transport. `addresses` are the ones the guard already checked for this
 * hop's host, and the live transport dials only those, so the name is never looked up twice.
 */
export interface HopInit {
  signal: AbortSignal;
  redirect: "manual";
  addresses: string[];
}

export interface SafeFetchOptions {
  /** One limit for the whole call: every lookup, every redirect and the final answer's body. */
  timeoutMs?: number;
  maxRedirects?: number;
  /** The hard limit on each hop's lookup. Tests pass a short one. */
  lookupTimeoutMs?: number;
  /** Swapped in tests so a name can be pointed at a chosen address without touching DNS. */
  resolve?: ResolveAll;
  /** Swapped in tests so a redirect chain can be replayed without a network. */
  transport?: (url: string, init: HopInit) => Promise<Response>;
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

/**
 * Resolves a name with an A and an AAAA query, and an address literal to itself.
 *
 * The queries go through c-ares (dns.promises.Resolver), which runs on the event loop, and never
 * through dns.lookup, which is getaddrinfo on libuv's small thread pool: that pool is where sharp
 * decodes every picture, so a slow name server must not be able to hold it. The cost is that
 * /etc/hosts is not read, which a service fetching public URLs has no use for.
 *
 * Either family may be missing. Only when both queries fail does the lookup fail, with the A
 * query's error. The addresses kept are the only ones the connection may dial, so a family that
 * failed is simply not dialled.
 */
export function resolveWith(resolver: RecordResolver): ResolveAll {
  return async (hostname) => {
    if (isIP(hostname) !== 0) {
      return [hostname];
    }
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    if (v4.status === "rejected" && v6.status === "rejected") {
      throw v4.reason instanceof Error ? v4.reason : new Error(String(v4.reason));
    }
    return [...(v4.status === "fulfilled" ? v4.value : []), ...(v6.status === "fulfilled" ? v6.value : [])];
  };
}

/** The live resolver: c-ares with its own per-query limits, under the hard limit in safeFetch. */
export const resolveThroughDns: ResolveAll = resolveWith(
  new dnsPromises.Resolver({ timeout: RESOLVER_QUERY_TIMEOUT_MS, tries: RESOLVER_TRIES }),
);

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
 * One deadline, `timeoutMs` from the call, covers the whole fetch: each hop's
 * lookup and request get only the time that is left, and the answer handed back
 * keeps the same deadline for its body. A fresh limit per hop let four slow
 * redirects hold one request for four times the limit (review pass 11, V119).
 *
 * Throws BlockedTarget (403) when a hop resolves to an address we refuse, and
 * UnreachableTarget (502) when the host does not answer, the deadline passes, or
 * the chain of redirects runs past the limit. Both carry the detail for a log;
 * the /verify URL form never passes it on (V118).
 */
export async function safeFetch(url: URL, options: SafeFetchOptions = {}): Promise<Response> {
  const resolve = options.resolve ?? resolveThroughDns;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const lookupTimeoutMs = options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS;
  const transport = options.transport ?? pinnedTransport(timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const signal = AbortSignal.timeout(timeoutMs);

  let target = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new UnreachableTarget(`fetching ${url.toString()} took longer than ${timeoutMs} ms`);
    }
    const addresses = await assertPublicHost(target, resolve, Math.min(lookupTimeoutMs, left));

    let response: Response;
    try {
      response = await transport(target.toString(), { signal, redirect: "manual", addresses });
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
    // The redirect's own body is never read, and until it is released this hop's agent cannot
    // finish closing.
    await response.body?.cancel().catch(() => undefined);
    try {
      target = new URL(location, target);
    } catch {
      throw new UnreachableTarget(`${target.toString()} redirected to a location that is not a URL`);
    }
  }

  throw new UnreachableTarget(`fetching ${url.toString()} redirected more than ${maxRedirects} times`);
}

/**
 * Checks the host before the request is made, so a private address is refused
 * with a reason a caller can read rather than as a failed connection.
 *
 * Throws BlockedTarget when the name is localhost, resolves to nothing, or
 * resolves to any address we refuse, and UnreachableTarget when the lookup fails
 * or runs past `lookupTimeoutMs`. Returns the addresses it approved, which are
 * the only ones this hop may dial.
 */
async function assertPublicHost(url: URL, resolve: ResolveAll, lookupTimeoutMs: number): Promise<string[]> {
  const host = hostOf(url);
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new BlockedTarget(`refusing to fetch ${host}: not a public address`);
  }

  let addresses: string[];
  try {
    addresses = await withLookupTimeout(resolve(host), lookupTimeoutMs);
  } catch (error) {
    throw new UnreachableTarget(`could not resolve ${host}: ${reasonOf(error)}`);
  }

  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new BlockedTarget(`refusing to fetch ${host}: not a public address`);
  }
  return addresses;
}

function withLookupTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`the lookup took longer than ${ms} ms`)), ms);
  });
  return Promise.race([work, limit]).finally(() => {
    clearTimeout(timer);
  });
}

function pinnedTransport(timeoutMs: number): (url: string, init: HopInit) => Promise<Response> {
  return async (url, { addresses, ...init }) => {
    // A fresh agent for every hop. Each one is closed once its answer is back, and a closed agent
    // refuses any further request, so sharing one across a redirect chain failed every second hop.
    // Its lookup hands back the addresses this hop already approved, checked once more, and never
    // asks a resolver again.
    const dispatcher = new Agent({
      connect: { lookup: guardedLookup(async () => addresses), timeout: CONNECT_TIMEOUT_MS },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
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
