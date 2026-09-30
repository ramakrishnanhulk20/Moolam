import type { Hex } from "viem";
import { canonicalOrigin } from "@/lib/platforms/platforms";

/**
 * The only two things these pages ever say to the window that opened them,
 * and how (P10, P22). Each goes to one explicit origin at a time, never "*",
 * so a browser delivers it only if the opener really is that site. Nothing is
 * ever read back: neither page listens for a message, so an opener cannot
 * change what is drawn or signed.
 */

/** The part of window.opener these pages use. */
export interface OpenerLike {
  postMessage: (message: unknown, targetOrigin: string) => void;
}

export interface Registered {
  type: "moolam:registered";
  passportId: Hex;
  txHash: Hex;
}

export interface SharedAddress {
  type: "moolam:address";
  address: Hex;
}

/** The origins a message may go to: each one canonical https, each once, "*" and anything else dropped. */
export function targetOrigins(origins: readonly string[]): string[] {
  const kept = new Set<string>();
  for (const origin of origins) {
    const canonical = canonicalOrigin(origin);
    if (canonical !== null && canonical === origin) {
      kept.add(canonical);
    }
  }
  return [...kept];
}

/**
 * Tells the platform's page the passport landed: the passport id and the
 * transaction hash, both public, posted once to each origin the listing names.
 * An unlisted platform names none, so it is told nothing. Returns where it went.
 */
export function postRegistered(opener: OpenerLike | null, origins: readonly string[], facts: Omit<Registered, "type">): string[] {
  if (opener === null) {
    return [];
  }
  const targets = targetOrigins(origins);
  const message: Registered = { type: "moolam:registered", passportId: facts.passportId, txHash: facts.txHash };
  for (const origin of targets) {
    opener.postMessage(message, origin);
  }
  return targets;
}

/** Hands the person's address to the one site that asked, after their press. False when there is nowhere to send it. */
export function postAddress(opener: OpenerLike | null, origin: string | null, address: Hex): boolean {
  if (opener === null || origin === null) {
    return false;
  }
  const [target] = targetOrigins([origin]);
  if (target === undefined) {
    return false;
  }
  const message: SharedAddress = { type: "moolam:address", address };
  opener.postMessage(message, target);
  return true;
}

/** The window that opened this one, or null. Read only when a message is about to go out. */
export function currentOpener(): OpenerLike | null {
  if (typeof window === "undefined") {
    return null;
  }
  const opener = window.opener as OpenerLike | null | undefined;
  return opener === null || opener === undefined || opener === (window as unknown) ? null : opener;
}
