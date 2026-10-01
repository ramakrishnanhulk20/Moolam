import { ContractFunctionRevertedError, BaseError, getAddress, type Address, type Hex } from "viem";
import { disputeAbi } from "../disputeRead.js";
import { registryEditAbi, tokenIdOf } from "../edit/registry.js";
import { env } from "../env.js";
import { readClient } from "../reputation/registry.js";

/** The registry's DisputeStatus enum, 0 to 3, as the answer route reads it. */
export const DISPUTE_OPEN = 1;

/** One passport's dispute and holder, read at one block, with that block's time. */
export interface DisputeAtBlock {
  /** The block's timestamp in unix seconds: the chain time every window here is read against. */
  now: bigint;
  /** ownerOf at that block, or undefined when the registry holds no token for the id. */
  holder: Address | undefined;
  dispute: { challenger: Address; status: number; openedAt: bigint };
}

/**
 * The one chain read the answer routes make. Every field comes from the same block, so the holder,
 * the dispute and the time an answer is judged against cannot come from two moments (L26).
 * Throws when the chain cannot be read; the routes answer 503 and accept nothing.
 */
export interface ChallengeChain {
  disputeAt: (passportId: Hex) => Promise<DisputeAtBlock>;
}

/** Whether a read reverted on chain, which for ownerOf means the token does not exist. */
function reverted(error: unknown): boolean {
  return error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError) !== null;
}

/** The live read, through the service's one Monad transport. */
export function liveChallengeChain(): ChallengeChain {
  const client = readClient();
  const registry = env.MOOLAM_REGISTRY_ADDRESS as Hex;
  return {
    disputeAt: async (passportId) => {
      const block = await client.getBlock({ blockTag: "latest" });
      const blockNumber = block.number;
      const [dispute, holder] = await Promise.all([
        client.readContract({ address: registry, abi: disputeAbi, functionName: "getDispute", args: [passportId], blockNumber }),
        client
          .readContract({ address: registry, abi: registryEditAbi, functionName: "ownerOf", args: [tokenIdOf(passportId)], blockNumber })
          .then((owner) => getAddress(owner as Hex))
          .catch((error: unknown) => {
            if (reverted(error)) return undefined;
            throw error;
          }),
      ]);
      return {
        now: block.timestamp,
        holder,
        dispute: { challenger: getAddress(dispute.challenger), status: Number(dispute.status), openedAt: dispute.openedAt },
      };
    },
  };
}

/** A chain that cannot be read, for a host under a test runner: both routes answer 503 on it. */
export function offlineChallengeChain(): ChallengeChain {
  return {
    disputeAt: async () => {
      throw new Error("no chain under a test runner");
    },
  };
}
