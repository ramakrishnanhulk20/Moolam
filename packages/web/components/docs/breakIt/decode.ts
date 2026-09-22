import {
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  RawContractError,
  decodeErrorResult,
  type Abi,
  type Hex,
} from "viem";

/**
 * What the chain answered, in the three shapes this page can honestly print.
 *
 * "refused" is a revert the ABI names. "empty" is a revert carrying no data at
 * all, which is what a contract with no payable function answers a transfer.
 * "unknown" is everything else: a rate limited endpoint, a dropped connection,
 * a node that would not answer. It never becomes a result on the screen.
 */
export type Refusal =
  | { kind: "refused"; name: string; args: readonly unknown[]; decoded: boolean }
  | { kind: "empty" }
  | { kind: "unknown" };

/** A revert that carries no selector: four bytes is the shortest answer with a name in it. */
function hasSelector(data: Hex | undefined): data is Hex {
  return typeof data === "string" && data.length >= 10;
}

/**
 * The revert bytes read against the ABI of the contract that produced them.
 *
 * An error the ABI does not carry keeps its four byte selector as its name,
 * marked undecoded, because a selector a reader can check by hand is worth
 * more than a blank.
 */
export function decodeRefusal(data: Hex | undefined, abi: Abi): Refusal {
  if (!hasSelector(data)) {
    return { kind: "empty" };
  }
  try {
    const result = decodeErrorResult({ abi, data });
    return { kind: "refused", name: result.errorName, args: result.args ?? [], decoded: true };
  } catch {
    return { kind: "refused", name: data.slice(0, 10), args: [], decoded: false };
  }
}

/** The raw bytes viem hangs on its lower level errors, whichever shape they arrived in. */
function rawOf(error: RawContractError): Hex | undefined {
  const data = error.data;
  if (typeof data === "string") {
    return data;
  }
  return data === undefined ? undefined : data.data;
}

/**
 * Turns anything thrown by a simulated call into one of the three answers.
 *
 * viem decodes a custom error itself when the ABI carries it, so that branch is
 * taken first and the args come back already typed. The lower two branches
 * catch a revert whose bytes arrived without a decode, and a revert with no
 * bytes at all.
 */
export function refusalOf(error: unknown, abi: Abi): Refusal {
  if (!(error instanceof BaseError)) {
    return { kind: "unknown" };
  }

  const reverted = error.walk((step) => step instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) {
    if (reverted.data !== undefined) {
      return { kind: "refused", name: reverted.data.errorName, args: reverted.data.args ?? [], decoded: true };
    }
    return decodeRefusal(reverted.raw, abi);
  }

  const raw = error.walk((step) => step instanceof RawContractError);
  if (raw instanceof RawContractError) {
    return decodeRefusal(rawOf(raw), abi);
  }

  // A node that says "execution reverted" and nothing more. The call ran and
  // the contract refused it, which is the whole answer for a value transfer.
  const plain = error.walk((step) => step instanceof ExecutionRevertedError);
  return plain instanceof ExecutionRevertedError ? { kind: "empty" } : { kind: "unknown" };
}

/** One printable line: NotPassportHolder(0xcdb2...1638, 0x0000...dEaD). */
export function refusalLine(refusal: Refusal): string {
  if (refusal.kind === "empty") {
    return "a revert carrying no data";
  }
  if (refusal.kind === "unknown") {
    return "no answer";
  }
  return refusal.args.length === 0 ? `${refusal.name}()` : `${refusal.name}(${refusal.args.map(printArg).join(", ")})`;
}

function printArg(value: unknown): string {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}
