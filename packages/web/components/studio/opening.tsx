"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * How a tool page opens: "full" is today's poster-sized title, "compact" is the
 * short one with the tool in the first screen, which is on /lab/openings until
 * Ram says yes.
 *
 * A context rather than a prop because the sign-in cards it changes sit several
 * components down, under screens that load the wallet, and those screens are
 * left exactly as they are.
 */
export type Opening = "full" | "compact";

const Chosen = createContext<Opening>("full");

export function OpeningProvider({ opening, children }: { opening: Opening; children: ReactNode }) {
  return <Chosen.Provider value={opening}>{children}</Chosen.Provider>;
}

export function useOpening(): Opening {
  return useContext(Chosen);
}
