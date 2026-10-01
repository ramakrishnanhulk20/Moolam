import { parseAbiItem, type Hex } from "viem";

/**
 * Where Moolam's resolver publishes the reasons for a decision, bound to it on
 * chain: MoolamDecisions takes a reasons address only from the policy's
 * resolver, only once the registry shows that dispute settled, and emits the
 * outcome it read from the registry beside it (L28). In a file of its own so
 * the console in the browser can name it without the server's held reads.
 */
export const DECISIONS_ADDRESS = "0x30AbA7747342fA3ac9d990Ec2Cf407cC968c497F" as Hex;

/** The block MoolamDecisions was deployed in (packages/contracts/broadcast/DeployLookalikes.s.sol/143/run-latest.json). */
export const DECISIONS_BLOCK = 109_555_263n;

export const decisionPublishedEvent = parseAbiItem(
  "event DecisionPublished(bytes32 indexed passportId, uint64 indexed openedAt, bool upheld, string reasonsURI, address resolver)",
);
