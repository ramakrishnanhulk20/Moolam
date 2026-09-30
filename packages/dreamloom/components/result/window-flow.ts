import { getAddress, isAddress } from "viem";

/**
 * How this page talks to Moolam's pages in another window. A window is opened blank inside the
 * click itself, before any request, because a browser only lets a click open a window straight
 * away; it is sent to Moolam once the link is known. From Moolam's pages this page takes exactly two
 * messages, each only from Moolam's exact origin, and uses nothing from them but what is named here.
 */

export interface WindowLike {
  closed: boolean;
  location: { href: string };
  close: () => void;
}

/** A blank window opened in the click, or null when the browser stopped it. Its opener stays set, so Moolam can answer. */
export function openBlank(open: (url: string, target: string) => WindowLike | null = defaultOpen): WindowLike | null {
  try {
    return open("about:blank", "_blank");
  } catch {
    return null;
  }
}

function defaultOpen(url: string, target: string): WindowLike | null {
  return window.open(url, target) as WindowLike | null;
}

/** Sends a window this page opened to a link. "blocked" when there is no window to send, so the page shows the link instead. */
export function sendWindow(target: WindowLike | null, link: string): "sent" | "blocked" {
  if (target === null || target.closed) return "blocked";
  try {
    target.location.href = link;
    return "sent";
  } catch {
    return "blocked";
  }
}

export function closeWindow(target: WindowLike | null): void {
  try {
    if (target !== null && !target.closed) target.close();
  } catch {
    // A window the visitor already closed or navigated away needs nothing more.
  }
}

export interface MessageLike {
  origin: string;
  data: unknown;
}

function typed(event: MessageLike, expectedOrigin: string | null, type: string): Record<string, unknown> | null {
  if (expectedOrigin === null || event.origin !== expectedOrigin) return null;
  const data = event.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const fields = data as Record<string, unknown>;
  return fields.type === type ? fields : null;
}

/**
 * Whether a message is Moolam's co-sign page saying a passport landed. It is only a hint to read the
 * picture again at once: the passport this page shows always comes from Dreamloom's server, never
 * from the message.
 */
export function isRegisteredHint(event: MessageLike, expectedOrigin: string | null): boolean {
  return typed(event, expectedOrigin, "moolam:registered") !== null;
}

/**
 * The address Moolam's connect page shared, checksummed, or null for anything else: a wrong origin,
 * a wrong type, or an address that does not parse. Nothing else in the message is read.
 */
export function sharedAddress(event: MessageLike, expectedOrigin: string | null): string | null {
  const fields = typed(event, expectedOrigin, "moolam:address");
  const address = fields?.address;
  if (typeof address !== "string" || !isAddress(address, { strict: true })) return null;
  return getAddress(address);
}
