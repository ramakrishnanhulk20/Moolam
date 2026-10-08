import { getAddress, isAddress } from "viem";

/**
 * How this page talks to Moolam's pages in another window. Like a checkout, Moolam opens as a small
 * window centred over this one, never inside this page: both Moolam pages refuse to be framed, so
 * the window always shows Moolam's own address. The window is opened inside the click itself,
 * before any request, because a browser only lets a click open a window straight away; it is sent
 * to Moolam once the link is known. From Moolam's pages this page takes exactly two messages, each
 * only from Moolam's exact origin, and uses nothing from them but what is named here.
 */

export interface WindowLike {
  closed: boolean;
  location: { href: string };
  close: () => void;
  focus: () => void;
}

/** One name for every Moolam window this page opens, so a second press reaches the same window. */
export const CHECKOUT_NAME = "moolam-checkout";
export const CHECKOUT_WIDTH = 480;
export const CHECKOUT_HEIGHT = 760;

export interface ScreenLike {
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
}

/**
 * The window's features: a popup of about 480 by 760, centred over the browser window this page is
 * in. No "noopener", because Moolam's page answers through its opener.
 */
export function checkoutFeatures(screen: ScreenLike): string {
  const left = Math.round(screen.screenX + Math.max(0, (screen.outerWidth - CHECKOUT_WIDTH) / 2));
  const top = Math.round(screen.screenY + Math.max(0, (screen.outerHeight - CHECKOUT_HEIGHT) / 2));
  return `popup=yes,width=${CHECKOUT_WIDTH},height=${CHECKOUT_HEIGHT},left=${left},top=${top}`;
}

export type OpenWindow = (url: string, name: string, features: string) => WindowLike | null;

function defaultOpen(url: string, name: string, features: string): WindowLike | null {
  return window.open(url, name, features) as WindowLike | null;
}

function defaultScreen(): ScreenLike {
  return { screenX: window.screenX, screenY: window.screenY, outerWidth: window.outerWidth, outerHeight: window.outerHeight };
}

/** A short line in the fresh window while Dreamloom asks Moolam for the link, so it never sits blank. */
function holdingLine(target: WindowLike): void {
  try {
    const doc = (target as unknown as { document?: Document }).document;
    if (doc === undefined || doc.body === null) return;
    doc.title = "Opening Moolam";
    doc.body.style.cssText =
      "margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0d12;color:#f1efe8;font:16px system-ui,sans-serif";
    doc.body.textContent = "Opening Moolam's page...";
  } catch {
    // A window already on Moolam's site belongs to another origin and is left as it is.
  }
}

export interface Checkout {
  /** Opens the window in the click, or focuses it when it is already open. Null when the browser refused. */
  open: () => WindowLike | null;
  /** Brings the window back: focuses it when open, else opens it again straight on the link. */
  reopen: (link: string) => "focused" | "sent" | "blocked";
  close: () => void;
}

/**
 * The one Moolam window this page keeps. A second press never opens a second window: it focuses the
 * one already open, and a reopen does not send it anywhere, so a visitor midway through signing in
 * keeps their place.
 */
export function createCheckout(open: OpenWindow = defaultOpen, screen: () => ScreenLike = defaultScreen): Checkout {
  let current: WindowLike | null = null;

  const live = (): WindowLike | null => {
    try {
      return current !== null && !current.closed ? current : null;
    } catch {
      return null;
    }
  };

  const focus = (target: WindowLike) => {
    try {
      target.focus();
    } catch {
      // A browser that will not raise the window still leaves it open behind this one.
    }
  };

  const fresh = (url: string): WindowLike | null => {
    try {
      current = open(url, CHECKOUT_NAME, checkoutFeatures(screen()));
    } catch {
      current = null;
    }
    return current;
  };

  return {
    open() {
      const existing = live();
      if (existing !== null) {
        focus(existing);
        return existing;
      }
      // An empty address opens a blank window, and for a window of this name that is already open it
      // hands it back without moving it.
      const opened = fresh("");
      if (opened !== null) holdingLine(opened);
      return opened;
    },
    reopen(link) {
      const existing = live();
      if (existing !== null) {
        focus(existing);
        return "focused";
      }
      return sendWindow(fresh(""), link);
    },
    close() {
      closeWindow(current);
      current = null;
    },
  };
}

/** The page's one checkout window. */
export const checkout: Checkout = createCheckout();

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
 * Whether a message is Moolam's co-sign page saying a passport landed, with a well-formed passport
 * id. It is only a hint to close the window and read the picture again at once: the passport this
 * page shows always comes from Dreamloom's server, never from the message.
 */
export function isRegisteredHint(event: MessageLike, expectedOrigin: string | null): boolean {
  const passportId = typed(event, expectedOrigin, "moolam:registered")?.passportId;
  return typeof passportId === "string" && /^0x[0-9a-fA-F]{64}$/.test(passportId);
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

export type MoolamAnswer = { kind: "registered" } | { kind: "address"; address: string };

/**
 * A message heard while Moolam's window is open. Moolam's answer for this place (a landed passport
 * for "sign", a shared address for "share") comes back; anything else, including the right message
 * from the wrong origin, comes back null. Only the connect window is closed here: the co-sign window
 * posts "registered" before the person's AI-use terms go out in a second transaction, and it closes
 * itself once they are written, so shutting it on that message could drop them.
 */
export function takeAnswer(
  event: MessageLike,
  expectedOrigin: string | null,
  place: "sign" | "share",
  target: Pick<Checkout, "close">,
): MoolamAnswer | null {
  let answer: MoolamAnswer | null = null;
  if (place === "sign" && isRegisteredHint(event, expectedOrigin)) answer = { kind: "registered" };
  if (place === "share") {
    const address = sharedAddress(event, expectedOrigin);
    if (address !== null) answer = { kind: "address", address };
  }
  if (answer !== null && place === "share") target.close();
  return answer;
}
