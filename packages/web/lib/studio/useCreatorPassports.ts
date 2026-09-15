"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
}

interface Answer {
  wallet: Hex;
  tick: number;
  passports: CreatorPassport[];
  error: string | null;
}

const HOW_MANY = 12;

/**
 * Everything this wallet has registered, newest first, straight from the index.
 *
 * The thumbnails are a second round of fetches against the IPFS gateway, one
 * per row, so the list appears as soon as the index answers and the pictures
 * fill in behind it. A row whose metadata will not load keeps its id and its
 * block rather than disappearing.
 */
export function useCreatorPassports(wallet: Hex | undefined): CreatorPassports {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (wallet === undefined) {
      return;
    }

    let live = true;

    void (async () => {
      try {
        const rows = await passportsByCreator(wallet, HOW_MANY);
        if (!live) {
          return;
        }
        setAnswer({ wallet, tick, passports: rows, error: null });

        const decorated = await Promise.all(rows.map(withArt));
        if (live) {
          setAnswer({ wallet, tick, passports: decorated, error: null });
        }
      } catch (thrown) {
        if (live) {
          setAnswer({ wallet, tick, passports: [], error: reason(thrown) });
        }
      }
    })();

    return () => {
      live = false;
    };
  }, [wallet, tick]);

  const current = answer !== null && answer.wallet === wallet && answer.tick === tick ? answer : null;
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  // One object per answer, so the panels below do not re-render on every
  // keystroke in the studio above them.
  return useMemo(
    () => ({
      status: current === null ? ("reading" as const) : current.error === null ? ("ready" as const) : ("unreadable" as const),
      passports: current?.passports ?? [],
      error: current?.error ?? null,
      refresh,
    }),
    [current, refresh],
  );
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
