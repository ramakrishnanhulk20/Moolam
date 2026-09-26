import type { Hex } from "viem";
import { addresses } from "./client";

/**
 * The one form an address takes before it is compared with another.
 *
 * The chain, the index and the deploy files each write an address in their own
 * letter case, so two sides of a comparison that were written differently would
 * silently disagree. Every comparison in the app goes through this, on both
 * sides, so there is only one rule to get right.
 */
export function addressKey(value: string): string {
  return value.trim().toLowerCase();
}

export function sameAddress(one: string, other: string): boolean {
  return addressKey(one) === addressKey(other);
}

/** What a named receiver's verdicts are: a public re-check, or the private one on a sealed picture. */
export type ReceiverRole = "public" | "private";

/**
 * Every receiver Moolam's Chainlink CRE workflows have written through, and
 * what each one's verdicts are.
 *
 * The first two are today's, bound to the CRE wallet. The last two were taken
 * off the policy on 2026-09-26 and keep their names for the verdicts they wrote
 * before that, which stay on chain under their address. This list is labels
 * only: which receivers may write at all is the registry's rule, read at the
 * moment of writing, not this app's.
 *
 * Built on each call rather than at import, so a module that only needs the
 * comparison never reads the deployed addresses before it asks.
 */
export function namedReceivers(): readonly { address: Hex; role: ReceiverRole }[] {
  return [
    { address: addresses.simulationReceiver, role: "public" },
    { address: addresses.sealedSimulationReceiver, role: "private" },
    { address: addresses.receiver, role: "public" },
    { address: addresses.sealedReceiver, role: "private" },
  ];
}

/** The addresses whose verdicts may be called Chainlink re-checks, and no others. */
export function chainlinkReceivers(): readonly Hex[] {
  return namedReceivers().map((one) => one.address);
}

/**
 * What a receiver's verdict is, or "unknown" for a writer this app cannot name.
 * An unknown writer is still shown; it is only never given a Chainlink name.
 */
export function receiverRole(receiver: string): ReceiverRole | "unknown" {
  return namedReceivers().find((one) => sameAddress(one.address, receiver))?.role ?? "unknown";
}

export function isChainlinkReceiver(receiver: string): boolean {
  return receiverRole(receiver) !== "unknown";
}

export function isPrivateRecheck(receiver: string): boolean {
  return receiverRole(receiver) === "private";
}
