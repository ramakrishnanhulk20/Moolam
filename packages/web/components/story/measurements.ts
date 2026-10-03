import type { Hex } from "viem";
import { gatewayUrl } from "@/lib/chain/client";

/** One step of the degrade ladder, as the film shows it. */
export interface DegradeStep {
  transform: string;
  confidence: number;
  phashDistance: number | null;
  blockhashDistance: number | null;
  variant: string | null;
  bytes: number;
  frame: string | null;
}

/** The parts of public/hero/degrade.json the ladder is built from. */
interface DegradeFile {
  shown: readonly string[];
  steps: readonly Omit<DegradeStep, "frame">[];
  frames: Readonly<Record<string, { file: string; bytes: number }>>;
}

/**
 * The six steps the film plays and the four frames behind them, copied word for
 * word from public/hero/degrade.json, which was written by posting the real
 * transformed files to the running verifier.
 *
 * The file is not imported here on purpose. A client chunk that imported it
 * carried the whole file, including the address of the verifier it was measured
 * against, which on this machine is a localhost address. Only the values the
 * film shows are kept, and test/degrade-ladder.test.ts holds every one of them
 * to the file, so a new measurement that changes a figure fails there rather
 * than showing an old number.
 */
const ladder: DegradeFile = {
  shown: ["rotate-90", "mirror", "reencode-q60", "reencode-q30", "social-chain", "resize-10"],
  steps: [
    { transform: "rotate-90", confidence: 1, phashDistance: 0, blockhashDistance: 0, variant: "rot90", bytes: 193230 },
    { transform: "mirror", confidence: 0.9454545454545454, phashDistance: 1, blockhashDistance: 0, variant: "mirror", bytes: 194122 },
    { transform: "reencode-q60", confidence: 1, phashDistance: 0, blockhashDistance: 0, variant: "identity", bytes: 66097 },
    { transform: "reencode-q30", confidence: 1, phashDistance: 0, blockhashDistance: 0, variant: "identity", bytes: 36765 },
    { transform: "social-chain", confidence: 0.8363636363636364, phashDistance: 3, blockhashDistance: 0, variant: "identity", bytes: 51552 },
    { transform: "resize-10", confidence: 0.9804878048780488, phashDistance: 0, blockhashDistance: 2, variant: "identity", bytes: 3430 },
  ],
  frames: {
    "reencode-q60": { file: "/hero/frame-reencode-q60.jpg", bytes: 66097 },
    "reencode-q30": { file: "/hero/frame-reencode-q30.jpg", bytes: 36765 },
    "social-chain": { file: "/hero/frame-social-chain.jpg", bytes: 51552 },
    "resize-10": { file: "/hero/frame-resize-10.jpg", bytes: 3430 },
  },
};

/**
 * The six steps the verified beat ticks through, in the order degrade.json
 * lists them.
 *
 * Every value was measured by the running verifier. Nothing here is computed in
 * the browser. A shown step the verifier could not fingerprint has no distance,
 * and the film prints a distance for every step it shows, so such a step stops
 * the load like a missing one rather than being printed as a guess.
 */
export function degradeSteps(file: DegradeFile = ladder): DegradeStep[] {
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
      frame: file.frames[name]?.file ?? null,
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
  passportId: "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638" as Hex,
  imageCid: "bafybeibkodpslo5oyxt7h7kkghiydxipzmrw2actqpssp5p2mavh7umz44",
  measuredAt: "2026-10-01T14:12:25.893Z",
  registry: "0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0" as Hex,
  exactConfidence: 1,
  imageUrl: gatewayUrl("ipfs://bafybeibkodpslo5oyxt7h7kkghiydxipzmrw2actqpssp5p2mavh7umz44"),
};
