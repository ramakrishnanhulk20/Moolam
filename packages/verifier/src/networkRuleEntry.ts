import { hammingHex } from "../../workflow/moolam-verifier/blockhash.js";
import config from "../../workflow/moolam-verifier/config.network.json" with { type: "json" };
import { decodeJpeg } from "../../workflow/moolam-verifier/decode.js";
import { dihedralFingerprints } from "../../workflow/moolam-verifier/dihedral.js";
import { LOOKALIKE_BLOCKHASH_BITS } from "../../workflow/moolam-verifier/lookalike-rule.js";
import { hamming64 } from "../../workflow/moolam-verifier/phash.js";
import type { NetworkRule } from "./networkRule.js";

/**
 * The workflow's own code, imported from packages/workflow and never copied. Everything but the
 * last line of measure is the workflow's functions; that line is measureThumbnail's rule, which
 * lives inside workflow.ts next to the Chainlink SDK and cannot be imported, so
 * test/network-rule.test.ts holds it to the text of workflow.ts.
 *
 * tsc does not compile this file into dist, because the workflow sits outside this package.
 * scripts/bundle-network-rule.mjs bundles it, with the workflow's files and jpeg-js, into
 * dist/networkRuleEntry.js, and src/networkRule.ts loads that.
 */
export const networkRule: NetworkRule = {
  phashBits: config.matchThreshold,
  blockhashBits: LOOKALIKE_BLOCKHASH_BITS,
  measure(thumbnail, stored) {
    const upright = dihedralFingerprints(decodeJpeg(thumbnail))[0];
    if (upright === undefined || upright.variant !== "identity") {
      throw new Error("the eight fingerprints did not start with the upright picture");
    }
    const phashDistance = hamming64(BigInt(upright.phash), stored.phash);
    const blockhashDistance = hammingHex(upright.blockhash, stored.blockhash);
    return {
      phashDistance,
      blockhashDistance,
      matched: phashDistance <= config.matchThreshold && blockhashDistance <= LOOKALIKE_BLOCKHASH_BITS,
    };
  },
};
