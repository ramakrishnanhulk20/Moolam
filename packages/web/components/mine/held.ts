"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Hex } from "viem";
import { pinnedUri } from "@/components/passport/art";
import { gatewayUrl } from "@/lib/chain/client";
import { passportsHeldNotMade, type PassportListing } from "@/lib/data/passports";
import { passportArt } from "@/lib/studio/metadata";

/**
 * Passports a signed-in wallet holds and did not make (P25).
 *
 * Anyone can transfer a passport to anyone, so what lands here was not
 * necessarily asked for. It is listed apart from the wallet's own work, never
 * as made, and the person can hide any of it. Hiding is a choice about this
 * browser's view only: it is kept in local storage, per wallet, and one press
 * brings everything back.
 */

export interface HeldPassport extends PassportListing {
  title?: string;
  imageUrl?: string;
}

/** Far more than anyone is sent. The list is one read, with no paging, so it needs a ceiling. */
export const HELD_LIMIT = 48;

const HIDDEN_PREFIX = "moolam:held-hidden:";

/** The storage key for one wallet's hidden list. Lowercased, so a checksum change finds the same list. */
export function hiddenKey(wallet: string): string {
  return `${HIDDEN_PREFIX}${wallet.toLowerCase()}`;
}

/** The ids this browser hid for the wallet. Anything that is not a list of passport ids reads as nothing hidden. */
export function readHidden(storage: Pick<Storage, "getItem"> | null, wallet: string): Set<string> {
  if (storage === null) {
    return new Set();
  }
  try {
    const stored: unknown = JSON.parse(storage.getItem(hiddenKey(wallet)) ?? "[]");
    if (!Array.isArray(stored)) {
      return new Set();
    }
    return new Set(
      stored.filter((id): id is string => typeof id === "string" && /^0x[0-9a-f]{64}$/.test(id)),
    );
  } catch {
    return new Set();
  }
}

/** Writes the hidden list, or removes it when it is empty. A full or refused store keeps the choice for this visit only. */
export function writeHidden(storage: Pick<Storage, "setItem" | "removeItem"> | null, wallet: string, ids: ReadonlySet<string>): void {
  if (storage === null) {
    return;
  }
  try {
    if (ids.size === 0) {
      storage.removeItem(hiddenKey(wallet));
    } else {
      storage.setItem(hiddenKey(wallet), JSON.stringify([...ids].sort()));
    }
  } catch {
    // Private windows and full stores refuse writes; the page still hides for now.
  }
}

/** The rows left on screen, and how many of the held rows the hidden list covers. */
export function splitHeld<T extends { id: string }>(rows: readonly T[], hidden: ReadonlySet<string>): { shown: T[]; hiddenCount: number } {
  const shown = rows.filter((row) => !hidden.has(row.id.toLowerCase()));
  return { shown, hiddenCount: rows.length - shown.length };
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export interface HeldPassports {
  status: "reading" | "ready" | "unreadable";
  shown: HeldPassport[];
  hiddenCount: number;
  hide: (id: string) => void;
  showHidden: () => void;
}

/** The held-not-made rows for one wallet, with this browser's hidden list applied. */
export function useHeldPassports(wallet: Hex): HeldPassports {
  const [answer, setAnswer] = useState<{ wallet: Hex; rows: HeldPassport[] | null } | null>(null);
  // This grid is only ever drawn in the browser, after sign-in, so the store
  // can be read while rendering without a server render to disagree with.
  const [hidden, setHidden] = useState<{ wallet: Hex; ids: Set<string> }>(() => ({
    wallet,
    ids: readHidden(browserStorage(), wallet),
  }));

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const rows = await passportsHeldNotMade(wallet, HELD_LIMIT);
        if (!live) {
          return;
        }
        setAnswer({ wallet, rows });
        const decorated = await Promise.all(rows.map(withArt));
        if (live) {
          setAnswer({ wallet, rows: decorated });
        }
      } catch {
        if (live) {
          setAnswer({ wallet, rows: null });
        }
      }
    })();

    return () => {
      live = false;
    };
  }, [wallet]);

  const ids = useMemo(
    () => (hidden.wallet === wallet ? hidden.ids : readHidden(browserStorage(), wallet)),
    [hidden, wallet],
  );

  const hide = useCallback(
    (id: string) => {
      const next = new Set(ids);
      next.add(id.toLowerCase());
      writeHidden(browserStorage(), wallet, next);
      setHidden({ wallet, ids: next });
    },
    [ids, wallet],
  );

  const showHidden = useCallback(() => {
    writeHidden(browserStorage(), wallet, new Set());
    setHidden({ wallet, ids: new Set() });
  }, [wallet]);

  const current = answer !== null && answer.wallet === wallet ? answer : null;
  const { shown, hiddenCount } = splitHeld(current?.rows ?? [], ids);

  return {
    status: current === null ? "reading" : current.rows === null ? "unreadable" : "ready",
    shown,
    hiddenCount,
    hide,
    showHidden,
  };
}

/**
 * A row with its title and thumbnail, held to the site's one picture-address
 * rule before anything is fetched, because the registry takes any string and
 * this runs in the reader's browser. A gateway that fails costs the picture,
 * never the row.
 */
async function withArt(row: PassportListing): Promise<HeldPassport> {
  const document = pinnedUri(row.metadataURI);
  if (document === undefined) {
    return row;
  }
  try {
    const response = await fetch(gatewayUrl(document), { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) {
      return row;
    }
    const art = passportArt(await response.json());
    const picture = art.uri === undefined ? undefined : pinnedUri(art.uri);
    return { ...row, title: art.title, imageUrl: picture === undefined ? undefined : gatewayUrl(picture) };
  } catch {
    return row;
  }
}
