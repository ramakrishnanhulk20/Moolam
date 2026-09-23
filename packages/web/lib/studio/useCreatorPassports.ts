"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Hex } from "viem";
import { gatewayUrl, reason } from "@/lib/chain/client";
import { passportsByCreator, type PassportListing } from "@/lib/data/passports";
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

  // One object per answer, so the panels below do not re-render on every
  // keystroke in the studio above them.
  return useMemo(
    () => ({
      status: current === null ? ("reading" as const) : current.error === null ? ("ready" as const) : ("unreadable" as const),
      passports: current?.passports ?? [],
      error: current?.error ?? null,
      refresh,
      hasMore: current?.hasMore ?? false,
      loadingMore: current?.loadingMore ?? false,
      moreError: current?.moreError ?? null,
      more,
    }),
    [current, refresh, more],
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
