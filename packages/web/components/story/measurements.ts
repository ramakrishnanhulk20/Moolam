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

/** The parts of degrade.json the ladder is built from. */
type DegradeFile = Pick<typeof degrade, "shown" | "steps" | "frames">;

/**
 * The six steps the verified beat ticks through, in the order degrade.json
 * lists them.
 *
 * Every value comes out of that file, which was written by posting the real
 * transformed files to the running verifier. Nothing here is computed in the
 * browser. A shown step the verifier could not fingerprint has no distance, and
 * the film prints a distance for every step it shows, so such a step stops the
 * load like a missing one rather than being printed as a guess.
 */
export function degradeSteps(file: DegradeFile = degrade): DegradeStep[] {
  const frames = file.frames as Record<string, { file: string; bytes: number }>;

  return file.shown.map((name) => {
    const step = file.steps.find((entry) => entry.transform === name);
    if (step === undefined) {
      throw new Error(`degrade.json lists ${name} as shown but holds no measurement for it`);
    }
    if (step.phashDistance === null) {
      throw new Error(`degrade.json lists ${name} as shown but the verifier measured no distance for it`);
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
 * the film says it. Only a measured step has a figure: degradeSteps refuses a
 * shown one without, so a step reaching here with none is a caller's mistake
 * and is refused rather than printed as a number nobody measured.
 */
export function bitsApart(step: Pick<DegradeStep, "phashDistance">): string {
  if (step.phashDistance === null) {
    throw new Error("bitsApart was handed a step with no measured distance");
  }
  return String(step.phashDistance);
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
