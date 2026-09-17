"use client";

import dynamic from "next/dynamic";
import type { Hex } from "viem";
import { useWalletMounted } from "@/components/providers/WalletProvider";

// The panel's own file pulls in the wallet SDK through useEditPassport, about 173 kB of it with
// walletconnect, jose and libphonenumber underneath. Asking for it here keeps all of that in a
// chunk of its own, so a reader who never signs in downloads a passport page without any of it.
// There is nothing to render until the chunk lands, which is what a signed out reader sees anyway.
const Editor = dynamic(() => import("./Editor").then((module) => module.Editor), {
  ssr: false,
  loading: () => null,
});

/**
 * The owner's panel under the lineage tree: give this app a signer once, then add edited versions
 * of this picture without a passkey prompt.
 *
 * It is drawn for one reader only, the wallet the registry says holds this passport. A signed out
 * visitor and a signed in stranger get no markup at all, not a disabled button, because an edit
 * they could never make is not worth the space on a page about someone else's picture.
 *
 * The hook waits for the wallet's own provider. Privy's hooks warn into the console on every
 * render that happens without it, and this panel is blank until they answer anyway.
 */
export function EditPanel(props: { parentId: Hex; owner: Hex | null }) {
  return useWalletMounted() ? <Editor {...props} /> : null;
}
