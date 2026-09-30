"use client";

import { useCosign } from "@/lib/cosign/useCosign";
import { CosignSheet } from "./CosignSheet";

/** The signed-in half: Privy's hooks and the whole run, fetched beside the wallet SDK. */
export function CosignLive() {
  const cosign = useCosign();
  return <CosignSheet
      model={cosign.model}
      agent={cosign.agent}
      wallet={cosign.wallet ?? null}
      balance={cosign.balance}
      onPress={cosign.press}
    />;
}
