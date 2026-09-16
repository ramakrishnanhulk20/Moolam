import { publicEnv } from "@/lib/env";

/**
 * Where pinned pictures are read from, and in what order.
 *
 * Every picture on this site lives on IPFS and is served by the account's own
 * Pinata gateway, which has a monthly request allowance. Two things keep the
 * site inside it: the pictures go through Next's image optimizer, which serves
 * them from its own cache after the first read, and a gateway that stops
 * answering falls through to a public gateway instead of leaving a dark plate.
 */

/** Tried in order after the account's own gateway. Both serve any CID. */
const PUBLIC_GATEWAYS = ["https://ipfs.io/ipfs/", "https://dweb.link/ipfs/"] as const;

const GATEWAY = publicEnv.ipfsGateway.endsWith("/") ? publicEnv.ipfsGateway : `${publicEnv.ipfsGateway}/`;

/**
 * The content id inside a stored URI, so a link can be named after what it
 * points at rather than after whichever gateway is reading it today. Null when
 * the URI is not an IPFS one at all.
 */
export function cidOf(uri: string): string | null {
  if (uri.startsWith("ipfs://")) {
    const rest = uri.slice("ipfs://".length);
    return rest.length === 0 ? null : rest;
  }
  const found = /\/ipfs\/([^/?#]+)/.exec(uri);
  return found === null ? null : found[1];
}

/**
 * Everything after the /ipfs/ marker, the CID and any path under it. cidOf
 * stops at the CID because that is what a label shows; a second gateway has to
 * be handed the file inside the directory as well or it answers with the
 * directory.
 */
function ipfsPath(uri: string): string | null {
  if (uri.startsWith("ipfs://")) {
    const rest = uri.slice("ipfs://".length);
    return rest.length === 0 ? null : rest;
  }
  const found = /\/ipfs\/(.+)$/.exec(uri);
  return found === null || found[1].length === 0 ? null : found[1];
}

/**
 * Every address one pinned file can be read from, the account's own gateway
 * first and the public ones behind it. A picture that is not on IPFS at all is
 * returned as it stands, so a record pointing at an ordinary web address still
 * draws.
 *
 * The same order is used for metadata documents, which are pinned the same way.
 */
export function pictureSources(uri: string): string[] {
  const path = ipfsPath(uri);
  const own = uri.startsWith("ipfs://") ? `${GATEWAY}${uri.slice("ipfs://".length)}` : uri;
  if (path === null) {
    return [own];
  }
  return [own, ...PUBLIC_GATEWAYS.map((gateway) => `${gateway}${path}`)].filter(
    (address, at, all) => all.indexOf(address) === at,
  );
}

/**
 * The address to try after the one that just failed, or null when every
 * gateway has been asked and the caller should draw the seal instead.
 */
export function nextSource(sources: string[], current: string): string | null {
  const at = sources.indexOf(current);
  if (at === -1) {
    return sources[0] ?? null;
  }
  return sources[at + 1] ?? null;
}

/** The hosts next.config lets the optimizer fetch from. */
export const PICTURE_HOSTS: string[] = [
  hostOf(GATEWAY) ?? "gateway.pinata.cloud",
  ...PUBLIC_GATEWAYS.map((gateway) => hostOf(gateway) as string),
].filter((host, at, all) => all.indexOf(host) === at);

function hostOf(address: string): string | null {
  try {
    return new URL(address).hostname;
  } catch {
    return null;
  }
}

/**
 * True when the optimizer is allowed to fetch this address. A picture on any
 * other host has to be drawn as it stands, because the optimizer answers 400
 * for a host that is not configured and the plate would go dark.
 */
export function isOptimizable(url: string): boolean {
  const host = hostOf(url);
  return host !== null && PICTURE_HOSTS.includes(host);
}

/**
 * The optimizer's own address for a picture, for the places that cannot use
 * next/image: the WebGL plates in the film load their textures with three.js,
 * and a raw gateway address there would cost a gateway request on every single
 * view. Sent through here they are cached exactly like every other picture.
 */
export function optimizedUrl(url: string, width: number, quality = 70): string {
  if (!isOptimizable(url)) {
    return url;
  }
  return `/_next/image?url=${encodeURIComponent(url)}&w=${width}&q=${quality}`;
}

/** Every gateway was asked for the file and none of them handed it over whole. */
export class NoGatewayAnswered extends Error {
  /** One line per attempt, host and what it did, for a caller that wants to say why. */
  readonly tried: string[];

  constructor(uri: string, tried: string[]) {
    super(`no gateway served ${uri}: ${tried.join("; ")}`);
    this.name = "NoGatewayAnswered";
    this.tried = tried;
  }
}

/**
 * The pinned file itself, as bytes, for the one caller that needs the registered
 * copy rather than a picture on a screen: a sample handed to the verify service.
 *
 * The optimizer is deliberately not in this path. It re-encodes what it serves,
 * and a re-encoded copy carries a different fingerprint from the one the
 * registry holds, so the gateways are asked directly.
 *
 * Two things here are not in the picture path. A gateway that accepts the
 * connection and then never answers is the failure this exists for, so the walk
 * does not wait on any single one: after `patienceMs` the next gateway is asked
 * beside it and whichever answers first wins. And the whole walk is capped, so
 * a caller always gets either bytes or a refusal it can print.
 *
 * The account's own gateway is asked once more at the end of the list. The stall
 * is one held connection rather than a host that is down, and a fresh request to
 * the same host answers while the first one is still hanging.
 */
export function pinnedBytes(uri: string, options: { patienceMs?: number; timeoutMs?: number } = {}): Promise<Blob> {
  const patience = options.patienceMs ?? 2000;
  const whole = options.timeoutMs ?? 9000;
  const sources = pictureSources(uri);
  const walk = sources.length > 1 ? [...sources, sources[0]] : sources;

  return new Promise<Blob>((resolve, reject) => {
    const abort = new AbortController();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const tried: string[] = [];
    let settled = false;
    let next = 0;
    let running = 0;

    const finish = (blob: Blob | null) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      abort.abort();
      if (blob === null) {
        reject(new NoGatewayAnswered(uri, tried));
      } else {
        resolve(blob);
      }
    };

    const cap = setTimeout(() => finish(null), whole);
    timers.add(cap);

    const ask = () => {
      if (settled || next >= walk.length) {
        return;
      }
      const source = walk[next];
      next += 1;
      running += 1;
      const nudge = setTimeout(ask, patience);
      timers.add(nudge);

      void (async () => {
        try {
          const response = await fetch(source, { signal: abort.signal });
          if (!response.ok) {
            throw new Error(`answered ${response.status}`);
          }
          const blob = await response.blob();
          if (blob.size === 0) {
            throw new Error("answered with an empty file");
          }
          finish(blob);
        } catch (error) {
          if (settled) {
            return;
          }
          tried.push(`${hostOf(source) ?? source} ${error instanceof Error ? error.message : String(error)}`);
          running -= 1;
          clearTimeout(nudge);
          timers.delete(nudge);
          ask();
          if (running === 0 && next >= walk.length) {
            finish(null);
          }
        }
      })();
    };

    ask();
  });
}
