import type { Hex } from "viem";
import { chain } from "@/lib/chain/client";
import { bindNonce, getPassport } from "@/lib/chain/registry";
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
 * here watches the two facts the registry itself holds: the bind nonce moving,
 * and the passport existing. A hash, when there is a real one, is the faster
 * answer and is raced against the poll rather than depended on.
 */

const POLL_MS = 1_000;

/** How long Monad gets to show the write before the screen says so out loud. */
const CHAIN_WINDOW_MS = 90_000;

/** How long the index gets to catch up, once the chain has already answered. */
const INDEX_WINDOW_MS = 30_000;

const HASH_SHAPE = /^0x[0-9a-fA-F]{64}$/;

/** The sleep tick that loses the race when the receipt turns up first. */
const PENDING = Symbol("pending");

export interface Confirmed {
  landed: true;
  hash?: Hex;
  blockNumber?: bigint;
}

export interface RegistrationConfirmed extends Confirmed {
  /** When the registry says the passport was written, in milliseconds. */
  registeredAt?: number;
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
  nonceBefore: bigint;
  hash?: string | null;
}

/** Waits until the registry's bind nonce for this wallet has moved past the one the signature used. */
export async function confirmBind({ wallet, nonceBefore, hash }: BindConfirmation): Promise<Confirmed> {
  const known = transactionHash(hash);
  const watched = await watchChain(
    async () => {
      const nonce = await bindNonce(wallet);
      return nonce > nonceBefore ? nonce : null;
    },
    known,
    wallet,
  );

  return { landed: true, hash: watched.hash, blockNumber: watched.blockNumber };
}

export interface RegisterConfirmation {
  exactHash: Hex;
  hash?: string | null;
}

/**
 * Waits until the registry holds a passport under this exact hash, then reads
 * the record for the block and the time the receipt shows. When the send came
 * back without a hash, the index is asked for the transaction that carried it,
 * so the receipt still has a link a judge can open.
 */
export async function confirmRegister({ exactHash, hash }: RegisterConfirmation): Promise<RegistrationConfirmed> {
  const known = transactionHash(hash);
  const watched = await watchChain(() => getPassport(exactHash), known, undefined);
  const record = watched.state ?? (await getPassport(exactHash));

  const confirmed: RegistrationConfirmed = {
    landed: true,
    hash: watched.hash,
    blockNumber: watched.blockNumber,
    registeredAt: record === null ? undefined : Number(record.registeredAt) * 1_000,
  };

  if (confirmed.hash !== undefined) {
    return confirmed;
  }

  const indexed = await indexedRegistration(exactHash);
  return indexed === null
    ? confirmed
    : { ...confirmed, hash: indexed.txHash, blockNumber: confirmed.blockNumber ?? indexed.registeredBlock };
}

interface Watched<T> {
  /** Null only when the receipt won the race and the read has not caught up yet. */
  state: T | null;
  hash?: Hex;
  blockNumber?: bigint;
}

async function watchChain<T>(
  read: () => Promise<T | null>,
  hash: Hex | undefined,
  wallet: Hex | undefined,
): Promise<Watched<T>> {
  let receipt =
    hash === undefined
      ? null
      : chain
          .waitForTransactionReceipt({ hash, timeout: CHAIN_WINDOW_MS })
          .then((mined) => ({ block: mined.blockNumber, reverted: mined.status !== "success" }))
          // A receipt that never turns up decides nothing. The state poll does.
          .catch(() => null);

  const deadline = Date.now() + CHAIN_WINDOW_MS;

  for (;;) {
    const state = await read();
    if (state !== null) {
      return { state, hash };
    }

    if (Date.now() >= deadline) {
      throw new ConfirmTimeout(wallet, hash);
    }

    if (receipt === null) {
      await sleep(POLL_MS);
      continue;
    }

    const settled = await Promise.race([receipt, sleep(POLL_MS).then((): typeof PENDING => PENDING)]);
    if (settled === PENDING) {
      continue;
    }

    receipt = null;
    if (settled === null) {
      continue;
    }
    if (settled.reverted) {
      throw new Error(`Monad mined this transaction and it reverted: ${hash}`);
    }

    return { state: await read(), hash, blockNumber: settled.block };
  }
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

  const deadline = Date.now() + INDEX_WINDOW_MS;

  for (;;) {
    try {
      const row = await passportRegistration(exactHash);
      if (row !== null) {
        return row;
      }
    } catch {
      return null;
    }

    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
