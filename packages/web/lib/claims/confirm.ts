import { BaseError, ContractFunctionRevertedError, encodeFunctionData, getAddress, type Hex } from "viem";
import { CHAIN_ID, addresses, consentAbi } from "@/lib/chain/client";
import { consentStruct, type ConsentDraft } from "@/lib/consent/call";
import { holdsConsentSet, type ReceiptLike } from "@/lib/cosign/landed";
import { MAX_IDS_PER_CALL, type ClaimTerms, type WaitingClaim } from "./client";
import { draftFromTerms, idKey } from "./offers";

/**
 * The step that makes a handed-over picture the person's own: one
 * setConsentBatch from their own wallet, with the terms they chose when they
 * accepted (P26, P37).
 *
 * The batch is built only from passports the chain says this wallet holds,
 * read at the moment the card is drawn and read again at the press; if the two
 * reads differ nothing is sent and the card asks to be read again, because the
 * person must see the exact pictures they are signing for. A passport this
 * wallet has already written terms on is left out: it is confirmed, and a
 * second statement would only wait out the register's ten minutes.
 *
 * "Confirmed" is said only from a receipt that succeeded and carries one
 * ConsentSet from this wallet for every passport in the batch (P13). The
 * register holding the statement is the wait; the receipt is the proof.
 */

/** The chain reads the batch is chosen by. */
export interface HolderReads {
  /** Who holds the passport now; null when it does not exist. Throws when the chain does not answer. */
  ownerOf: (id: Hex) => Promise<Hex | null>;
  /** The latest consent entry's writer and second, or null when there is none. Throws when the chain does not answer. */
  latestEntry: (id: Hex) => Promise<{ writer: Hex; at: number } | null>;
}

export interface HeldBatch {
  /** The passports to confirm, in the order they were listed, at most 32. */
  ids: Hex[];
  /** The second of the latest entry on each, so the wait can tell this send's entry from an older one. */
  since: Record<Hex, number>;
}

function same(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/**
 * The delivered passports this wallet holds now and has not confirmed, at
 * most 32. Each id is read once, however many tickets name it.
 */
export async function heldBatch(entries: readonly WaitingClaim[], wallet: Hex, reads: HolderReads): Promise<HeldBatch> {
  const ids = [...new Set(entries.map((entry) => idKey(entry.passportId)))];
  const answers = await Promise.all(
    ids.map(async (id) => {
      const owner = await reads.ownerOf(id);
      if (owner === null || !same(owner, wallet)) return null;
      const latest = await reads.latestEntry(id);
      if (latest !== null && same(latest.writer, wallet)) return null;
      return { id, at: latest?.at ?? 0 };
    }),
  );
  const kept = answers.filter((answer): answer is { id: Hex; at: number } => answer !== null).slice(0, MAX_IDS_PER_CALL);
  return { ids: kept.map((answer) => answer.id), since: Object.fromEntries(kept.map((answer) => [answer.id, answer.at])) };
}

export interface ConsentBatchRequest {
  to: Hex;
  data: Hex;
  chainId: number;
  ids: Hex[];
  draft: ConsentDraft;
}

/** The one call, written out. Refuses an empty batch or one over the register's 32 before anything is signed. */
export function consentBatchRequest(ids: readonly Hex[], terms: ClaimTerms): ConsentBatchRequest {
  if (ids.length === 0 || ids.length > MAX_IDS_PER_CALL) {
    throw new RangeError(`a consent batch holds 1 to ${MAX_IDS_PER_CALL} passports, not ${ids.length}`);
  }
  const draft = draftFromTerms(terms);
  return {
    to: addresses.consent,
    data: encodeFunctionData({
      abi: consentAbi,
      functionName: "setConsentBatch",
      args: [ids, consentStruct(draft.consent), draft.constraintInfo],
    }),
    chainId: CHAIN_ID,
    ids: [...ids],
    draft,
  };
}

/** A successful receipt with this wallet's ConsentSet for every passport in the batch. */
export function receiptConfirms(receipt: ReceiptLike, ids: readonly Hex[], wallet: Hex, register: Hex = addresses.consent): boolean {
  return ids.length > 0 && ids.every((id) => holdsConsentSet(receipt, id, wallet, register));
}

/** Everything the press needs from outside: the reads, the wallet and the chain. A test hands in stand-ins. */
export interface ConfirmDeps extends HolderReads {
  simulate: (request: ConsentBatchRequest, wallet: Hex) => Promise<void>;
  /** The sponsored send from the person's embedded wallet; the hash when the wallet gave a usable one. */
  send: (request: ConsentBatchRequest, wallet: Hex) => Promise<Hex | undefined>;
  /** Waits until the register's latest entry on this passport is this statement from this wallet. */
  waitLanded: (input: { passportId: Hex; wallet: Hex; sent: ConsentDraft; since: number; hash?: Hex }) => Promise<void>;
  /** The receipt behind the statement on this passport from this wallet, found by hash or by log; null when none is found. */
  receipt: (passportId: Hex, wallet: Hex, hash: Hex | undefined) => Promise<{ hash: Hex; receipt: ReceiptLike } | null>;
}

export type ConfirmEvent =
  | { at: "checking" }
  | { at: "changed" }
  | { at: "sending" }
  | { at: "confirming"; hash?: Hex }
  | { at: "done"; txHash: Hex }
  /** Sent and not shown with a receipt yet. It may still land, so it is never sent again, only looked for. */
  | { at: "unconfirmed"; hash?: Hex };

/** What is out on the network, kept so a second look never sends twice. */
export interface SentBatch {
  ids: Hex[];
  draft: ConsentDraft;
  since: number;
  hash?: Hex;
}

/**
 * One press: read again, compare with what was shown, simulate, send once,
 * wait for the register, then hold the receipt to every id. Throws what the
 * wallet or the chain threw; the caller turns that into words.
 */
export async function runConfirm(
  input: { shown: readonly Hex[]; entries: readonly WaitingClaim[]; terms: ClaimTerms; wallet: Hex },
  deps: ConfirmDeps,
  emit: (event: ConfirmEvent) => void,
  onSent: (sent: SentBatch) => void = () => undefined,
): Promise<void> {
  emit({ at: "checking" });
  const now = await heldBatch(input.entries, input.wallet, deps);
  const shown = input.shown.map(idKey);
  if (now.ids.length !== shown.length || now.ids.some((id, index) => id !== shown[index])) {
    emit({ at: "changed" });
    return;
  }
  const request = consentBatchRequest(shown, input.terms);
  await deps.simulate(request, input.wallet);

  emit({ at: "sending" });
  const hash = await deps.send(request, input.wallet);
  const sent: SentBatch = { ids: shown, draft: request.draft, since: now.since[shown[0]] ?? 0, hash };
  onSent(sent);
  emit({ at: "confirming", hash });
  await lookForReceipt(sent, input.wallet, deps, emit);
}

/** The wait and the receipt check alone, for a batch already sent. Sends nothing. */
export async function lookForReceipt(
  sent: SentBatch,
  wallet: Hex,
  deps: Pick<ConfirmDeps, "waitLanded" | "receipt">,
  emit: (event: ConfirmEvent) => void,
): Promise<void> {
  const first = sent.ids[0];
  await deps.waitLanded({ passportId: first, wallet, sent: sent.draft, since: sent.since, hash: sent.hash });
  const found = await deps.receipt(first, wallet, sent.hash);
  if (found !== null && receiptConfirms(found.receipt, sent.ids, wallet)) {
    emit({ at: "done", txHash: found.hash });
    return;
  }
  emit({ at: "unconfirmed", hash: sent.hash });
}

/** ownerOf, with a token that does not exist read as null and a chain that does not answer thrown. */
export function ownerOrNull(read: () => Promise<unknown>): Promise<Hex | null> {
  return read().then(
    (owner) => owner as Hex,
    (error: unknown) => {
      if (error instanceof BaseError && error.walk((step) => step instanceof ContractFunctionRevertedError) !== null) {
        return null;
      }
      throw error;
    },
  );
}
