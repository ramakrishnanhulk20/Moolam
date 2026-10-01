import { addressId } from "./ids.js";

/// When Chainlink's network deployment of the moolam-verifier workflow went
/// live, in unix seconds. Zero means it has not, and then nothing in this index is
/// marked as the network's. The verdict receiver held simulator results long
/// before this moment, so the time is what separates the two, and it is set once
/// from the deploy, never read from a service.
export const NETWORK_ACTIVATION_TIME = 0n;

/// Chainlink's KeystoneForwarder on Monad, the only sender a network report has.
export const FORWARDER = "0x76c9cf548b4179f8901cda1f8623568b58215e62";

/// MoolamReceiver, which turns a network report into the registry's
/// VerificationAttested. Its event names it as `receiver`.
export const VERDICT_RECEIVER = "0x0d69055c43eacb3b1ca687ca2263a049bc7eff04";

/// MoolamLookalikes, which emits LookalikeChecked itself. Kept here as well as in
/// config.yaml so a config pointed at another address marks nothing as the
/// network's instead of trusting whatever it was pointed at.
export const LOOKALIKE_RECEIVER = "0xc0f3984a8116db8be514f649e3605a2a3acd454c";

const TEST_ACTIVATION_VARIABLE = "MOOLAM_TEST_NETWORK_ACTIVATION_TIME";

/// The activation time the handlers use.
///
/// Envio's test indexer loads the handlers through Node's own import, outside
/// vitest's module graph, so a test cannot swap the constant above. Inside vitest
/// only, the variable stands in for it, read on every call; anywhere else it is
/// ignored, so the hosted index always runs on the constant.
export function activationTime(): bigint {
  if (process.env.VITEST !== undefined) {
    const raw = process.env[TEST_ACTIVATION_VARIABLE];
    if (raw !== undefined && /^\d+$/.test(raw)) {
      return BigInt(raw);
    }
  }
  return NETWORK_ACTIVATION_TIME;
}

export type Write = {
  /// The contract the event says wrote it: the emitter for LookalikeChecked, the
  /// `receiver` parameter for VerificationAttested.
  writer: string;
  /// The receiver that writer must be.
  expectedWriter: string;
  /// The transaction's `to`, undefined for a contract creation.
  transactionTo: string | undefined;
  blockTimestamp: number;
};

/// Whether a write is Chainlink's network speaking.
///
/// One rule over the transaction and the event, never over a receiver's stored
/// settings: a receiver's owner can re-point it at any sender, but a transaction
/// that went to anything other than the forwarder did not come through
/// Chainlink. Covers the receivers' owner keys and a re-pointed receiver. Does
/// not cover the network itself writing a wrong result. Both addresses go through
/// the same lowercasing before they are compared, and an activation of zero means
/// nothing passes.
export function isNetworkWrite(write: Write, activation: bigint = activationTime()): boolean {
  if (activation <= 0n || write.transactionTo === undefined) {
    return false;
  }
  return (
    addressId(write.writer) === addressId(write.expectedWriter) &&
    addressId(write.transactionTo) === FORWARDER &&
    BigInt(write.blockTimestamp) >= activation
  );
}
