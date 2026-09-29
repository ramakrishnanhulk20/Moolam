"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Hex } from "viem";
import { gatewayUrl, reason } from "@/lib/chain/client";
import {
  confirmedPassports,
  passportsByCreator,
  settleListedPassports,
  subscribeConfirmedPassports,
  type ConfirmedPassports,
  type PassportListing,
} from "@/lib/data/passports";
import { passportArt } from "./metadata";

export interface CreatorPassport extends PassportListing {
  title?: string;
  /** A gateway URL for the pinned thumbnail, or nothing when the metadata could not be read. */
  imageUrl?: string;
}

export interface CreatorPassports {
  status: "reading" | "ready" | "unreadable";
  passports: CreatorPassport[];
  error: string | null;
  refresh: () => void;
  /** True when the last page came back full, so the index may hold older rows still. */
  hasMore: boolean;
  loadingMore: boolean;
  /** Why the last Load more failed. The rows already shown stay where they are. */
  moreError: string | null;
  /** Reads the next page and puts it under the rows already shown. */
  more: () => void;
}

interface Answer {
  wallet: Hex;
  tick: number;
  passports: CreatorPassport[];
  error: string | null;
  /** How many of this wallet's rows the index has been asked past so far. */
  offset: number;
  hasMore: boolean;
  loadingMore: boolean;
  moreError: string | null;
}

/** How long the index is watched for a passport Monad has already confirmed. */
export const INDEX_CATCH_UP_MS = 60_000;

const NOTHING_CONFIRMED: ConfirmedPassports = new Map();
const nothingOnServer = () => NOTHING_CONFIRMED;

/**
 * How long to wait before the next look at the index, or null once the window
 * has closed. The looks space out, 1, 2, 4, 8 and then every 16 seconds, which
 * is about seven reads against a shared index over the minute.
 */
export function nextLook(attempt: number, waitedMs: number): number | null {
  const delay = Math.min(1_000 * 2 ** attempt, 16_000);
  return waitedMs + delay > INDEX_CATCH_UP_MS ? null : delay;
}

/**
 * Everything this wallet has registered, newest first, straight from the index.
 *
 * The thumbnails are a second round of fetches against the IPFS gateway, one
 * per row, so the list appears as soon as the index answers and the pictures
 * fill in behind it. A row whose metadata will not load keeps its id and its
 * block rather than disappearing.
 *
 * Each page asks for one row more than it shows. That spare row is the only way
 * to know an older one exists, so a wallet with exactly a page of pictures is
 * never offered a Load more that brings back nothing.
 */
export function useCreatorPassports(wallet: Hex | undefined, pageSize = 12): CreatorPassports {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [tick, setTick] = useState(0);
  // Two presses inside one frame both see loadingMore false in state, so the
  // page in flight is also held here, named by the wallet and the read it
  // belongs to.
  const inFlight = useRef<string | null>(null);
  const release = useCallback((key: string) => {
    if (inFlight.current === key) {
      inFlight.current = null;
    }
  }, []);

  useEffect(() => {
    if (wallet === undefined) {
      return;
    }

    let live = true;

    void (async () => {
      try {
        const read = await passportsByCreator(wallet, pageSize + 1, 0);
        if (!live) {
          return;
        }
        const rows = read.slice(0, pageSize);
        const page = { offset: rows.length, hasMore: read.length > pageSize, loadingMore: false, moreError: null };
        setAnswer({ wallet, tick, passports: rows, error: null, ...page });

        const decorated = await Promise.all(rows.map(withArt));
        if (live) {
          // Functional, so a second page that landed while these pictures were
          // still on their way is kept rather than written over.
          setAnswer((held) =>
            held !== null && held.wallet === wallet && held.tick === tick
              ? { ...held, passports: fillIn(held.passports, decorated) }
              : held,
          );
        }
      } catch (thrown) {
        if (live) {
          setAnswer({
            wallet,
            tick,
            passports: [],
            error: reason(thrown),
            offset: 0,
            hasMore: false,
            loadingMore: false,
            moreError: null,
          });
        }
      }
    })();

    return () => {
      live = false;
    };
  }, [wallet, tick, pageSize]);

  const current = answer !== null && answer.wallet === wallet && answer.tick === tick ? answer : null;
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  const more = useCallback(() => {
    if (current === null || current.error !== null || !current.hasMore) {
      return;
    }
    const owner = current.wallet;
    const read = current.tick;
    const key = `${owner}:${read}`;
    if (inFlight.current === key) {
      return;
    }
    inFlight.current = key;

    // Every write below checks it still belongs to the same wallet and the same
    // read, so a page that lands after a switch or a refresh is dropped.
    const mine = (held: Answer | null): held is Answer => held !== null && held.wallet === owner && held.tick === read;

    setAnswer((held) => (mine(held) ? { ...held, loadingMore: true, moreError: null } : held));

    void (async () => {
      try {
        const from = current.offset;
        const got = await passportsByCreator(owner, pageSize + 1, from);
        const rows = got.slice(0, pageSize);
        setAnswer((held) => {
          if (!mine(held)) {
            return held;
          }
          // A press read from a render that had not caught up yet asked for a page
          // the list already holds; counting it again would skip the next one.
          if (held.offset !== from) {
            return { ...held, loadingMore: false };
          }
          // Offset paging can hand back a row twice when a new picture is
          // registered between two presses, so an id already shown is not added again.
          const seen = new Set(held.passports.map((row) => row.id));
          return {
            ...held,
            passports: [...held.passports, ...rows.filter((row) => !seen.has(row.id))],
            offset: held.offset + rows.length,
            hasMore: got.length > pageSize,
            loadingMore: false,
            moreError: null,
          };
        });
        // Released once the rows are in, not after their pictures: the button is
        // live again at this point, and a press on it must not be swallowed while
        // a slow gateway is still filling in thumbnails.
        release(key);

        const decorated = await Promise.all(rows.map(withArt));
        setAnswer((held) => (mine(held) ? { ...held, passports: fillIn(held.passports, decorated) } : held));
      } catch (thrown) {
        release(key);
        setAnswer((held) => (mine(held) ? { ...held, loadingMore: false, moreError: reason(thrown) } : held));
      }
    })();
  }, [current, pageSize, release]);

  // Re-renders this grid when a registration anywhere in the tab is confirmed.
  const confirmed = useSyncExternalStore(subscribeConfirmedPassports, confirmedPassports, nothingOnServer);
  // The confirmed passports the rows on screen do not hold yet, as one stable
  // key, so the look below starts once per gap rather than once per render.
  const missing = useMemo(() => {
    const held = wallet === undefined ? undefined : confirmed.get(wallet.toLowerCase());
    if (held === undefined || current === null || current.error !== null) {
      return { ids: "", since: 0 };
    }
    const shown = new Set(current.passports.map((row) => row.id.toLowerCase()));
    const gap = Array.from(held).filter(([id]) => !shown.has(id));
    return { ids: gap.map(([id]) => id).join(","), since: Math.max(0, ...gap.map(([, at]) => at)) };
  }, [wallet, current, confirmed]);
  const { ids: missingIds, since: missingSince } = missing;

  useEffect(() => {
    if (wallet !== undefined && current !== null) {
      settleListedPassports(wallet, current.passports);
    }
  }, [wallet, current]);

  // The index lags Monad by a block or more, so a grid read the moment Monad
  // answered can miss the passport it just confirmed. It looks again, spacing
  // the looks out, until the row is there or the window closes, and puts the
  // new rows on top of the ones already shown rather than blanking the grid.
  useEffect(() => {
    if (wallet === undefined || missingIds === "") {
      return;
    }
    const wanted = new Set(missingIds.split(","));
    const read = tick;
    const mine = (held: Answer | null): held is Answer => held !== null && held.wallet === wallet && held.tick === read;
    let live = true;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const look = async () => {
      let found: CreatorPassport[] = [];
      try {
        const got = await passportsByCreator(wallet, pageSize + 1, 0);
        found = got.slice(0, pageSize).filter((row) => wanted.has(row.id.toLowerCase()));
      } catch {
        // A failed look is one more reason to look again, not a grid error.
      }
      if (!live) {
        return;
      }
      if (found.length === 0) {
        schedule();
        return;
      }

      // Every row added on top pushes the older ones one place down the index's
      // order, so the next Load more starts that much further in. The rows the
      // index still lacks start a fresh look once these land.
      setAnswer((held) => {
        if (!mine(held)) {
          return held;
        }
        const seen = new Set(held.passports.map((row) => row.id));
        const added = found.filter((row) => !seen.has(row.id));
        return { ...held, passports: [...added, ...held.passports], offset: held.offset + added.length };
      });
      // Not gated on this effect still running: the rows above end it, and
      // their pictures are still owed.
      const decorated = await Promise.all(found.map(withArt));
      setAnswer((held) => (mine(held) ? { ...held, passports: fillIn(held.passports, decorated) } : held));
    };

    function schedule() {
      const delay = nextLook(attempt, Date.now() - missingSince);
      attempt += 1;
      if (delay !== null) {
        timer = setTimeout(() => void look(), delay);
      }
    }

    schedule();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [wallet, tick, missingIds, missingSince, pageSize]);

  // One object per answer, so the panels below do not re-render on every
  // keystroke in the studio above them.
  return useMemo(
    () => ({
      // An empty answer while Monad has confirmed a passport for this account
      // is the index behind, not an empty account, so it reads as still reading.
      status:
        current === null || (current.error === null && current.passports.length === 0 && missingIds !== "")
          ? ("reading" as const)
          : current.error === null
            ? ("ready" as const)
            : ("unreadable" as const),
      passports: current?.passports ?? [],
      error: current?.error ?? null,
      refresh,
      hasMore: current?.hasMore ?? false,
      loadingMore: current?.loadingMore ?? false,
      moreError: current?.moreError ?? null,
      more,
    }),
    [current, refresh, more, missingIds],
  );
}

/** The rows already held, with each one's title and thumbnail swapped in once they have arrived. */
function fillIn(held: CreatorPassport[], decorated: CreatorPassport[]): CreatorPassport[] {
  const byId = new Map(decorated.map((row) => [row.id, row]));
  return held.map((row) => byId.get(row.id) ?? row);
}

async function withArt(row: PassportListing): Promise<CreatorPassport> {
  try {
    const response = await fetch(gatewayUrl(row.metadataURI), { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) {
      return row;
    }
    const art = passportArt(await response.json());
    return { ...row, title: art.title, imageUrl: art.uri === undefined ? undefined : gatewayUrl(art.uri) };
  } catch {
    // A gateway that is slow or rate limited costs a thumbnail, never the row.
    return row;
  }
}
