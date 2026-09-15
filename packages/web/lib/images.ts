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
