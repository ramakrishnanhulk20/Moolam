import type { Hex } from "viem";
import { gatewayUrl } from "@/lib/chain/client";
import degrade from "@/public/hero/degrade.json";

/** One step of the degrade ladder, all of it read off degrade.json. */
export interface DegradeStep {
  transform: string;
  confidence: number;
  phashDistance: number | null;
  blockhashDistance: number | null;
  variant: string | null;
  bytes: number;
  frame: string | null;
}

/**
 * The six steps the verified beat ticks through, in the order degrade.json
 * lists them.
 *
 * Every value comes out of that file, which was written by posting the real
 * transformed files to the running verifier. Nothing here is computed in the
 * browser.
 */
export function degradeSteps(): DegradeStep[] {
  const frames = degrade.frames as Record<string, { file: string; bytes: number }>;

  return degrade.shown.map((name) => {
    const step = degrade.steps.find((entry) => entry.transform === name);
    if (step === undefined) {
      throw new Error(`degrade.json lists ${name} as shown but holds no measurement for it`);
    }
    return {
      transform: step.transform,
      confidence: step.confidence,
      phashDistance: step.phashDistance,
      blockhashDistance: step.blockhashDistance,
      variant: step.variant,
      bytes: step.bytes,
      frame: frames[name]?.file ?? null,
    };
  });
}

/**
 * How far one step's copy is from the original on the 64 bit fingerprint, as
 * the film says it. Every step the ladder shows was measured; a step the
 * verifier could not fingerprint at all has no distance to give, and says so
 * as the whole width of the fingerprint.
 */
export function bitsApart(step: Pick<DegradeStep, "phashDistance">): string {
  return String(step.phashDistance ?? 64);
}

/** Which passport, which file and which day those figures belong to, so the caption can say so. */
export const measurement = {
  passportId: degrade.passportId as Hex,
  imageCid: degrade.imageCid,
  measuredAt: degrade.measuredAt,
  registry: degrade.registry as Hex,
  exactConfidence: degrade.original.confidence,
  imageUrl: gatewayUrl(`ipfs://${degrade.imageCid}`),
};
