"use client";

import dynamic from "next/dynamic";
import type { Hex } from "viem";
import { useWalletMounted } from "@/components/providers/WalletProvider";

// Same shape as the edit panel next to it: the wallet SDK lives behind this one
// import, so a reader who never signs in downloads a sealed passport page
// without any of it. There is nothing to draw until the chunk lands, which is
// what everyone except the holder sees anyway.
const Unsealer = dynamic(() => import("./Unsealer").then((module) => module.Unsealer), {
  ssr: false,
  loading: () => null,
});

/**
 * The holder's publish control on a sealed passport.
 *
 * Drawn for one reader only, the wallet the registry says holds this passport,
 * and only while the passport is still sealed. Everybody else gets no markup at
 * all rather than a button they could never press, because the one thing this
 * panel does cannot be undone and has no business on a stranger's screen.
 */
export function UnsealPanel({ passportId, owner, sealed }: { passportId: Hex; owner: Hex | null; sealed: boolean }) {
  if (!sealed) {
    return null;
  }
  return <Gate passportId={passportId} owner={owner} />;
}

function Gate({ passportId, owner }: { passportId: Hex; owner: Hex | null }) {
  return useWalletMounted() ? <Unsealer passportId={passportId} owner={owner} /> : null;
}
