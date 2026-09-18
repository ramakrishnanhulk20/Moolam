import { BaseError, ContractFunctionRevertedError, encodeFunctionData, type Hex } from "viem";
import { CHAIN_ID, addresses, consentAbi } from "@/lib/chain/client";
import { USE_FIELDS, asUseNumber, type Consent } from "@/lib/chain/consent";

/**
 * The one call this app makes to the consent register, written out.
 *
 * The four values go in the order the struct holds them and as the numbers the
 * contract's enum defines, so what a holder picked on the screen is what an
 * explorer shows afterwards. The batch call is the agent's, never a browser's.
 */

export interface ConsentRequest {
  to: Hex;
  data: Hex;
  chainId: number;
}

/** The statement a holder is about to write, in the shape the contract takes. */
export interface ConsentDraft {
  consent: Consent;
  constraintInfo: string;
}

/** The four words as the four numbers the contract's enum defines, in its own order. */
export function consentStruct(consent: Consent): Record<string, number> {
  return Object.fromEntries(USE_FIELDS.map((field) => [field, asUseNumber(consent[field])]));
}

export function setConsentRequest(passportId: Hex, draft: ConsentDraft): ConsentRequest {
  return {
    to: addresses.consent,
    data: encodeFunctionData({
      abi: consentAbi,
      functionName: "setConsent",
      args: [passportId, consentStruct(draft.consent), draft.constraintInfo],
    }),
    chainId: CHAIN_ID,
  };
}

/** A refusal from the register, named, with whatever the error carried with it. */
export interface ConsentRevert {
  name: string;
  args: readonly unknown[];
}

/**
 * Names the custom error behind a refused call.
 *
 * The simulation is made through viem with the register's own ABI, so viem has
 * already decoded the revert by the time it throws and the name can be lifted
 * off its cause rather than guessed at from the request. Anything that was not
 * a revert this contract knows, a closed wallet prompt most of all, names
 * nothing.
 */
export function consentRevert(error: unknown): ConsentRevert | undefined {
  if (!(error instanceof BaseError)) {
    return undefined;
  }

  const found = error.walk((step) => step instanceof ContractFunctionRevertedError);
  if (!(found instanceof ContractFunctionRevertedError) || found.data === undefined) {
    return undefined;
  }
  return { name: found.data.errorName, args: found.data.args ?? [] };
}

/**
 * When this wallet may write for this passport again, in unix seconds, or null
 * when nothing is holding it back.
 *
 * The register makes the same writer wait out MIN_INTERVAL, and refuses
 * anything sooner with TooSoon. That refusal costs a sponsored transaction to
 * learn, so it is worked out here from the statement the page already read and
 * the interval the contract itself reports.
 */
export function opensAt({
  writer,
  wallet,
  at,
  minInterval,
}: {
  /** Who wrote the statement that stands, or undefined when there is none. */
  writer?: string;
  wallet?: string;
  /** When that statement was written, in whole seconds. */
  at?: number;
  minInterval: number;
}): number | null {
  if (writer === undefined || wallet === undefined || at === undefined) {
    return null;
  }
  return writer.toLowerCase() === wallet.toLowerCase() ? at + minInterval : null;
}
