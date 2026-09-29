import type { Hex } from "viem";
import { bindNonce, getPasskey, getPassport } from "@/lib/chain/registry";
import { watchState, type Watched } from "@/lib/chain/watch";
import { passportRegistration } from "@/lib/data/passports";
import { activeSource } from "@/lib/data/source";

/**
 * Confirming a write by the state it changes, not by the hash the wallet
 * returned.
 *
 * Privy's sponsored sends go out through its own EIP-7702 path, and its reply
 * can carry an empty hash while the transaction lands on Monad seconds later.
 * A screen that waits on that hash shows a failure for a write that worked and
 * invites a second send, which is the worst thing it could do. So the wait
 * here watches the two facts the registry itself holds: the passkey it stores
 * for a wallet, and the passport existing. The wait itself is the shared one in
 * lib/chain/watch, which survives a read that throws and ends only at the
 * window.
 *
 * A hash is only ever handed back once a receipt says that transaction
 * succeeded. A sponsored send can land while the caller's own attempt reverted
 * or was replaced, and a receipt link to that transaction would tell the reader
 * a story the chain does not agree with.
 */

const POLL_MS = 1_000;

/** How long Monad gets to show the write before the screen says so out loud. */
const CHAIN_WINDOW_MS = 90_000;

/** How long the index gets to catch up, once the chain has already answered. */
const INDEX_WINDOW_MS = 30_000;

const HASH_SHAPE = /^0x[0-9a-fA-F]{64}$/;

export interface Confirmed {
  landed: true;
  hash?: Hex;
  blockNumber?: bigint;
}

export interface RegistrationConfirmed extends Confirmed {
  /** When the registry says the passport was written, in milliseconds. */
  registeredAt?: number;
  /**
   * performance.now() at the moment Monad showed the passport. Taken before the
   * index is asked for the transaction, so the receipt's "confirmed in" figure
   * never includes a wait on the index.
   */
  answeredAt: number;
}

/**
 * The write was accepted and Monad has not shown it inside the window. It may
 * still land, so nothing here suggests sending again.
 */
export class ConfirmTimeout extends Error {
  readonly wallet?: Hex;
  readonly hash?: Hex;

  constructor(wallet?: Hex, hash?: Hex) {
    super(
      `Monad has not shown this write ${CHAIN_WINDOW_MS / 1_000} seconds after it was accepted. It may still land, so it must not be sent again.`,
    );
    this.name = "ConfirmTimeout";
    this.wallet = wallet;
    this.hash = hash;
  }
}

/**
 * The hash a wallet handed back, when it is one. Anything else, an empty
 * string most of all, is absent rather than wrong: the send itself may have
 * gone through perfectly.
 */
export function transactionHash(value: string | null | undefined): Hex | undefined {
  return typeof value === "string" && HASH_SHAPE.test(value) ? (value as Hex) : undefined;
}

export interface BindConfirmation {
  wallet: Hex;
  /** The key this device made. The bind is only this bind once the registry holds these bytes. */
  qx: Hex;
  qy: Hex;
  nonceBefore: bigint;
  hash?: string | null;
}

/**
 * Waits until the registry holds the key this device made for this wallet.
 *
 * The nonce moving is not enough on its own: another device binding a
 * different key moves it too, and a browser that remembered a credential on
 * that answer would sign with a key the registry has already replaced. So both
 * are read, and the wait ends only when the stored point is the one this
 * ceremony created.
 */
export async function confirmBind({ wallet, qx, qy, nonceBefore, hash }: BindConfirmation): Promise<Confirmed> {
  const watched = await watchState({
    read: async () => {
      const [passkey, nonce] = await Promise.all([getPasskey(wallet), bindNonce(wallet)]);
      return { passkey, nonce };
    },
    done: (state) =>
      state.nonce > nonceBefore &&
      state.passkey !== null &&
      state.passkey.qx.toLowerCase() === qx.toLowerCase() &&
      state.passkey.qy.toLowerCase() === qy.toLowerCase(),
    hash: transactionHash(hash),
    windowMs: CHAIN_WINDOW_MS,
    pollMs: POLL_MS,
  });

  return { landed: true, hash: linkable(watched) };
}

export interface RegisterConfirmation {
  exactHash: Hex;
  hash?: string | null;
  /**
   * When the registry already held this passport before the send, the time on
   * that record. Without it a record written by somebody else would read as
   * this send landing.
   */
  registeredBefore?: bigint;
}

/**
 * Waits until the registry holds a passport under this exact hash, then reads
 * the block and the time the receipt shows. When the send came back without a
 * usable hash, the index is asked for the transaction that carried it, so the
 * receipt still has a link a judge can open. That wait can run to thirty
 * seconds, which is why the moment Monad answered is stamped before it.
 */
export async function confirmRegister({
  exactHash,
  hash,
  registeredBefore,
}: RegisterConfirmation): Promise<RegistrationConfirmed> {
  const watched = await watchState({
    read: () => getPassport(exactHash),
    done: (record) => record !== null && (registeredBefore === undefined || record.registeredAt !== registeredBefore),
    hash: transactionHash(hash),
    windowMs: CHAIN_WINDOW_MS,
    pollMs: POLL_MS,
  });
  const answeredAt = performance.now();

  const confirmed: RegistrationConfirmed = {
    landed: true,
    answeredAt,
    hash: linkable(watched),
    registeredAt: watched.state === null ? undefined : Number(watched.state.registeredAt) * 1_000,
  };

  if (confirmed.hash !== undefined) {
    return confirmed;
  }

  const indexed = await indexedRegistration(exactHash);
  return indexed === null ? confirmed : { ...confirmed, hash: indexed.txHash, blockNumber: indexed.registeredBlock };
}

/** The hash worth printing: one whose receipt came back successful, and nothing else. */
function linkable(watched: Watched<unknown>): Hex | undefined {
  return watched.receiptStatus === "success" ? watched.hash : undefined;
}

/**
 * The block and the transaction the index recorded for one passport. It runs
 * only when the index is the live source, and a slow or missing index costs a
 * link rather than the registration.
 */
async function indexedRegistration(exactHash: Hex) {
  if (activeSource() !== "envio") {
    return null;
  }

  try {
    const watched = await watchState({
      read: () => passportRegistration(exactHash),
      done: (row) => row !== null,
      windowMs: INDEX_WINDOW_MS,
      pollMs: POLL_MS,
    });
    return watched.state;
  } catch {
    // The index is a nicety here. The passport is already on chain either way.
    return null;
  }
}
