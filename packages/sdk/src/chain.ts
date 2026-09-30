import {
  createPublicClient,
  custom,
  getAddress,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { MONAD_CHAIN_ID } from "./constants.js";
import { MoolamPlatformError } from "./errors.js";

/** The platform's wallet: a viem wallet client with its account and chain set. */
export type PlatformWalletClient = WalletClient<Transport, Chain, Account>;

/** Any viem public client on Monad, used for reads and chain time. */
export type ChainReader = PublicClient<Transport, Chain | undefined>;

/** A reader over the wallet client's own transport, so a platform hands the kit one client, not two. */
export function readerFor(walletClient: PlatformWalletClient): ChainReader {
  return createPublicClient({
    chain: walletClient.chain,
    transport: custom({ request: walletClient.request }),
  }) as ChainReader;
}

/** Throws MoolamPlatformError "wrong-chain" unless the client is on Monad, the chain every signature names. */
export async function assertMonad(reader: ChainReader): Promise<void> {
  const chainId = await reader.getChainId();
  if (chainId !== MONAD_CHAIN_ID) {
    throw new MoolamPlatformError("wrong-chain", `the client is on chain ${chainId}; Moolam lives on Monad, chain ${MONAD_CHAIN_ID}`);
  }
}

/** The latest block's timestamp: the clock every Moolam window is read against (P12). */
export async function chainNow(reader: ChainReader): Promise<bigint> {
  return (await reader.getBlock({ blockTag: "latest" })).timestamp;
}

/** The wallet client's account address, checksummed. */
export function walletAddress(walletClient: PlatformWalletClient): Address {
  return getAddress(walletClient.account.address);
}

interface ViemErrorShape {
  shortMessage: string;
  walk: (match: (inner: unknown) => boolean) => unknown;
}

interface RevertShape {
  name: "ContractFunctionRevertedError";
  shortMessage: string;
  reason?: string;
  data?: { errorName?: string };
}

function isViemError(value: unknown): value is ViemErrorShape {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ViemErrorShape).walk === "function" &&
    typeof (value as ViemErrorShape).shortMessage === "string"
  );
}

function isRevert(value: unknown): value is RevertShape {
  return typeof value === "object" && value !== null && (value as { name?: unknown }).name === "ContractFunctionRevertedError";
}

/**
 * The custom error name a revert carried, or the plain short message when there is none. Read by
 * shape rather than instanceof: a platform brings its own copy of viem, and the errors its clients
 * throw are not instances of this package's copy.
 */
export function revertReason(error: unknown): string {
  if (isViemError(error)) {
    const reverted = error.walk(isRevert);
    if (isRevert(reverted)) {
      return reverted.data?.errorName ?? reverted.reason ?? reverted.shortMessage;
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Simulates a write against the current chain, sends it from the platform's wallet, and waits for
 * its receipt. A write that would revert is never sent, and a result exists only for a receipt with
 * status success.
 *
 * Throws MoolamPlatformError "transaction-failed" naming the contract's error, with the hash when
 * the transaction was sent.
 */
export async function sendAndConfirm<
  const abi extends Abi,
  functionName extends ContractFunctionName<abi, "nonpayable" | "payable">,
>(
  walletClient: PlatformWalletClient,
  reader: ChainReader,
  call: {
    address: Address;
    abi: abi;
    functionName: functionName;
    args: ContractFunctionArgs<abi, "nonpayable" | "payable", functionName>;
  },
): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  let hash: Hex;
  try {
    const { request } = await reader.simulateContract({ ...call, account: walletClient.account } as never);
    hash = await walletClient.writeContract(request as never);
  } catch (error) {
    throw new MoolamPlatformError("transaction-failed", `${call.functionName} would revert: ${revertReason(error)}`, {
      functionName: call.functionName,
      reason: revertReason(error),
    });
  }
  const receipt = await reader.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new MoolamPlatformError("transaction-failed", `${call.functionName} reverted on chain`, {
      functionName: call.functionName,
      hash,
    });
  }
  return { hash, receipt };
}
