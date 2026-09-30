"use client";

import { MotionConfig } from "framer-motion";
import dynamic from "next/dynamic";
import { useEffect, useReducer } from "react";
import { useWalletMounted } from "@/components/providers/WalletProvider";
import { cosignReducer, initialCosign } from "@/lib/cosign/flow";
import { readHandle } from "@/lib/cosign/handle";
import { isPrivyConfigured } from "@/lib/env";
import { CosignSheet } from "./CosignSheet";

const loadLive = () => import("./CosignLive").then((module) => module.CosignLive);

const CosignLive = dynamic(loadLive, { loading: () => <CosignWaiting /> });

const ignore = () => undefined;

/**
 * The page a person lands on from an AI image site's co-sign link.
 *
 * The handle is in the fragment, so the server rendered this without it and
 * only this browser ever reads it (P4). Until the wallet SDK is up the sheet
 * draws its reading state, or the not-found state for a link with no handle.
 * Privy's hooks and the run itself are a chunk of their own, fetched beside
 * the SDK.
 */
export function CosignScreen() {
  const mounted = useWalletMounted();

  useEffect(() => {
    if (isPrivyConfigured) {
      void loadLive();
    }
  }, []);

  return <MotionConfig reducedMotion="user">{mounted ? <CosignLive /> : <CosignWaiting />}</MotionConfig>;
}

/** The sheet before anyone is known: the link read, nothing asked of the service. */
function CosignWaiting() {
  const [model, dispatch] = useReducer(cosignReducer, initialCosign);

  useEffect(() => {
    dispatch({ type: "handle", valid: readHandle() !== null });
  }, []);

  return <CosignSheet model={model} agent={null} wallet={null} onPress={ignore} />;
}
