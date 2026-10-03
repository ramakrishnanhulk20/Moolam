import { FingerprintFault } from "./fingerprint.js";

/**
 * What Chainlink's network says about one thumbnail, worked out the way the workflow works it out
 * (packages/workflow/moolam-verifier/workflow.ts, measureThumbnail): the thumbnail is decoded with
 * the workflow's own JPEG decoder and fingerprinted with the workflow's own code, and its upright
 * fingerprints are compared with the ones registered on chain.
 */
export interface NetworkMeasurement {
  /** pHash bits apart, of 64, between the thumbnail's upright pHash and the registered one. */
  phashDistance: number;
  /** Block hash bits apart, of 256. */
  blockhashDistance: number;
  /** The workflow's verdict: both distances at or under their limits. */
  matched: boolean;
}

export interface NetworkRule {
  /** The pHash limit the workflow reads from config.network.json. */
  readonly phashBits: number;
  /** The block hash limit the workflow reads from lookalike-rule.ts. */
  readonly blockhashBits: number;
  /**
   * Measures one thumbnail against the print that was registered for the picture.
   *
   * Throws when the workflow's decoder or fingerprint code cannot read the thumbnail. The network
   * would fail the same way and write no verdict, so a caller treats a throw as "not matched".
   */
  measure(thumbnail: Uint8Array, stored: { phash: bigint; blockhash: string }): NetworkMeasurement;
}

/**
 * The compiled service loads the one file esbuild bundled from the workflow's source
 * (scripts/bundle-network-rule.mjs); the tests and tsx load the source file beside this one. The
 * workflow's files sit outside this package, so tsc cannot compile them into dist and a static import
 * would not build.
 */
const ENTRY = import.meta.url.endsWith(".ts") ? "./networkRuleEntry.ts" : "./networkRuleEntry.js";

let loaded: Promise<NetworkRule> | undefined;

/**
 * The network's rule, loaded once.
 *
 * Throws FingerprintFault when the file is missing or does not hold the rule: that is this host
 * built wrong, says nothing about a picture, and no thumbnail may be judged without it.
 */
export function networkRule(): Promise<NetworkRule> {
  loaded ??= (async () => {
    let entry: { networkRule?: NetworkRule };
    try {
      entry = (await import(ENTRY)) as { networkRule?: NetworkRule };
    } catch (error) {
      throw new FingerprintFault(
        `the network rule could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (typeof entry.networkRule?.measure !== "function") {
      throw new FingerprintFault("the network rule file does not export the rule");
    }
    return entry.networkRule;
  })();
  return loaded;
}
