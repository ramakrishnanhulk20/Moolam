"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAddress, type Hex } from "viem";
import { pinnedUri } from "@/components/passport/art";
import { gatewayUrl } from "@/lib/chain/client";
import {
  passportHandover,
  passportsHeldNotMade,
  type HeldListing,
  type IndexHandover,
  type PassportListing,
} from "@/lib/data/passports";
import { creditFrom, handoverFacts, heldPlatformList, labelFrom } from "@/lib/data/platform-label";
import type { PlatformList } from "@/lib/platforms/platforms";
import { passportArt } from "@/lib/studio/metadata";

/**
 * Passports a signed-in wallet holds and did not make (P25).
 *
 * Anyone can transfer a passport to anyone, so what lands here was not
 * necessarily asked for. It is listed apart from the wallet's own work, never
 * as made, and the person can hide any of it. Hiding is a choice about this
 * browser's view only: it is kept in local storage, per wallet, and one press
 * brings everything back.
 *
 * The one exception is a platform's handover this person confirmed: a passport
 * a listed platform registered, handed to this wallet first, and this wallet
 * then stated its own AI-use terms on. The credit rule names them as the
 * person who imagined it, so it sits with their own pictures instead, saying
 * where it was drawn and when they confirmed. A handover they have not
 * confirmed stays here, with the line that says how to confirm it.
 */

export interface HeldPassport extends PassportListing {
  title?: string;
  imageUrl?: string;
  /** The platform that handed this wallet the passport, when it was the first recipient and has not confirmed. */
  handedBy?: string;
}

/** A held passport the credit rule says this wallet imagined, with the platform it was drawn on and when it confirmed. */
export interface ConfirmedPassport extends HeldPassport {
  platform: string;
  /** Unix seconds of the wallet's first consent entry on it. */
  confirmedAt: number;
}

/**
 * The held rows the credit rule gives the "confirmed" case with this wallet as
 * the person who imagined them, apart from every other held row. Among the
 * rest, a "handed" row this wallet was the first recipient of carries the
 * platform, so the held grid can say how to confirm it. A wallet that bought a
 * handed passport from its first recipient gets no such line: its terms would
 * never confirm anything, only the first recipient's do.
 *
 * The holder is the wallet the index answered for, so no holder is guessed;
 * the agent's owner is not read, because it only decides the co-signed case,
 * and a co-signed picture held here was imagined by somebody else. A row with
 * no handover answer reads "unknown" and is credited to nobody (P35). A
 * refused list credits nothing.
 */
export function splitCredited(
  rows: readonly HeldListing[],
  list: PlatformList,
  wallet: string,
  handovers: ReadonlyMap<string, IndexHandover | "unknown">,
): { confirmed: (HeldListing & { platform: string; confirmedAt: number })[]; held: (HeldListing & { handedBy?: string })[] } {
  let me: string;
  try {
    me = getAddress(wallet);
  } catch {
    return { confirmed: [], held: [...rows] };
  }
  const confirmed: (HeldListing & { platform: string; confirmedAt: number })[] = [];
  const held: (HeldListing & { handedBy?: string })[] = [];
  for (const row of rows) {
    const facts = handoverFacts(handovers.get(row.id.toLowerCase()) ?? "unknown");
    const credit = creditFrom(list, { ...row, holder: me, agentOwnerNow: null, ...facts });
    if (credit?.case === "confirmed" && credit.imaginedBy === me) {
      confirmed.push({ ...row, platform: credit.platform, confirmedAt: credit.confirmedAt });
    } else if (credit?.case === "handed" && credit.heldBy === me && facts.firstRecipient === me) {
      held.push({ ...row, handedBy: credit.platform });
    } else {
      held.push(row);
    }
  }
  return { confirmed, held };
}

/**
 * The index's handover answer for each held row the kit label covers, the only
 * rows whose credit it can change, so a wallet sent nothing by a platform
 * costs no read. Any read that fails is "unknown".
 */
export async function handoversFor(
  rows: readonly HeldListing[],
  list: PlatformList,
  read: (id: Hex) => Promise<IndexHandover | "unknown"> = passportHandover,
): Promise<Map<string, IndexHandover | "unknown">> {
  const covered = rows.filter((row) => labelFrom(list, row)?.status === "kit");
  const answers = await Promise.all(covered.map(async (row) => await read(row.id).catch(() => "unknown" as const)));
  return new Map(covered.map((row, index) => [row.id.toLowerCase(), answers[index] ?? "unknown"]));
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

/**
 * Whoever is listening for a read from outside the grid. The confirm card is
 * drawn by a sibling component, so it cannot reach the hook's own reread.
 */
const rereadListeners = new Set<() => void>();

/** Asks every mounted held list to read the index again. Does nothing when none is mounted. */
export function rereadHeldPassports(): void {
  for (const listener of rereadListeners) {
    listener();
  }
}

export interface HeldPassports {
  status: "reading" | "ready" | "unreadable";
  /** The handovers this wallet confirmed and is credited with, drawn with its own pictures and never hidden. */
  confirmed: ConfirmedPassport[];
  shown: HeldPassport[];
  hiddenCount: number;
  hide: (id: string) => void;
  showHidden: () => void;
  /** Reads the list again, keeping the rows on screen until the new answer arrives. */
  reread: () => void;
}

/** The held-not-made rows for one wallet, with this browser's hidden list applied. */
export function useHeldPassports(wallet: Hex): HeldPassports {
  const [answer, setAnswer] = useState<{ wallet: Hex; rows: HeldPassport[] | null; confirmed: ConfirmedPassport[] } | null>(
    null,
  );
  // This grid is only ever drawn in the browser, after sign-in, so the store
  // can be read while rendering without a server render to disagree with.
  const [hidden, setHidden] = useState<{ wallet: Hex; ids: Set<string> }>(() => ({
    wallet,
    ids: readHidden(browserStorage(), wallet),
  }));
  const [round, setRound] = useState(0);
  const reread = useCallback(() => setRound((was) => was + 1), []);
  // The wallet a finished answer is on screen for, so a second read does not blank the thumbnails while it fetches them again.
  const drawnFor = useRef<Hex | null>(null);

  useEffect(() => {
    rereadListeners.add(reread);
    return () => {
      rereadListeners.delete(reread);
    };
  }, [reread]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [rows, list] = await Promise.all([passportsHeldNotMade(wallet, HELD_LIMIT), heldPlatformList()]);
        if (!live) {
          return;
        }
        const handovers = await handoversFor(rows, list);
        if (!live) {
          return;
        }
        const { confirmed, held } = splitCredited(rows, list, wallet, handovers);
        if (drawnFor.current !== wallet) {
          setAnswer({ wallet, rows: held, confirmed });
        }
        const [heldArt, confirmedArt] = await Promise.all([Promise.all(held.map(withArt)), Promise.all(confirmed.map(withArt))]);
        if (live) {
          drawnFor.current = wallet;
          setAnswer({ wallet, rows: heldArt, confirmed: confirmedArt });
        }
      } catch {
        if (live) {
          // A read that fails after a good one leaves the good one on screen.
          setAnswer((was) => (was !== null && was.wallet === wallet && was.rows !== null ? was : { wallet, rows: null, confirmed: [] }));
        }
      }
    })();

    return () => {
      live = false;
    };
  }, [wallet, round]);

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
    confirmed: current?.confirmed ?? [],
    shown,
    hiddenCount,
    hide,
    showHidden,
    reread,
  };
}

/**
 * A row with its title and thumbnail, held to the site's one picture-address
 * rule before anything is fetched, because the registry takes any string and
 * this runs in the reader's browser. A gateway that fails costs the picture,
 * never the row.
 */
async function withArt<Row extends PassportListing>(row: Row): Promise<Row & { title?: string; imageUrl?: string }> {
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
