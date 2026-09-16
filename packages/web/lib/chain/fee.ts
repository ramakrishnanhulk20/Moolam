import { formatEther } from "viem";

/**
 * What a transaction cost, in MON, from the two numbers on its receipt.
 *
 * Monad bills the gas limit rather than the gas burned, so this is what the
 * sender was charged and never an estimate of the work done.
 */
export function feeInMon(gasUsed: bigint, gasPrice: bigint): string {
  return formatEther(gasUsed * gasPrice);
}
