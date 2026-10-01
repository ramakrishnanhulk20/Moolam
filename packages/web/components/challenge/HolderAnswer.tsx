"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import type { Hex } from "viem";
import { useWalletMounted } from "@/components/providers/WalletProvider";
import type { AnswerDispute } from "@/lib/disputes/answer";

interface Props {
  passportId: Hex;
  dispute: AnswerDispute;
  until: number;
  /** What every reader who is not the holder sees: the line that says the holder has until when. */
  fallback: ReactNode;
}

type Panel = ComponentType<Props>;

// Held at module level so a second answer slot on the same page, or a remount,
// never fetches the chunk twice.
let loaded: Promise<Panel> | null = null;

function loadPanel(): Promise<Panel> {
  loaded ??= import("./HolderAnswerPanel").then((module) => module.HolderAnswerPanel);
  return loaded;
}

/**
 * The holder's answer form, shown only to the wallet that holds the passport,
 * only while the dispute is open and inside its 14 days (the caller decides the
 * last two from the chain).
 *
 * The form's file pulls in the wallet SDK through useHolderAnswer, so it is
 * fetched only once the wallet's provider is up, the way DisputePanel fetches
 * the flag. Until then, and for every reader who is not the holder, the
 * fallback line stays exactly where it is, so nothing on the page jumps.
 */
export function HolderAnswer(props: Props) {
  const mounted = useWalletMounted();
  const [panel, setPanel] = useState<{ Panel: Panel } | null>(null);

  useEffect(() => {
    if (!mounted) {
      return;
    }
    let live = true;
    void loadPanel().then((Panel) => {
      if (live) {
        setPanel({ Panel });
      }
    });
    return () => {
      live = false;
    };
  }, [mounted]);

  if (!mounted || panel === null) {
    return <>{props.fallback}</>;
  }
  return <panel.Panel {...props} />;
}
