import { readFileSync } from "node:fs";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  decodeErrorResult,
  getAddress,
  http,
  isAddress,
  type Hex,
  type PublicClient,
} from "viem";
import { monad } from "viem/chains";
import { consentAbi, registryHolderAbi } from "./abi.js";
import type { OnChainEntry } from "./statements.js";
import { DEFAULT_DEPLOYMENT_FILE, MONAD_MAINNET } from "../chain/addresses.js";

const NOBODY = "0x0000000000000000000000000000000000000000" as Hex;

/** How long a read waits before its one retry, and how that retry is recognised. */
const RETRY_AFTER_MS = 3_000;
const RATE_LIMITED = /429|rate.?limit|too many requests/i;

export interface ConsentDeployment {
  consent: Hex;
  registry: Hex;
  chainId: number;
  /** The block the consent contract was deployed in, for the header of the run. */
  consentBlock?: number;
}

/**
 * Reads the live consent address out of the file the deploy script wrote.
 *
 * Separate from loadDeployment in src/chain/addresses.ts because that one returns the three
 * registry contracts and this script needs the fourth, and because a missing consent address has
 * to name the consent deploy rather than the registry one.
 */
export function consentDeployment(file: string = DEFAULT_DEPLOYMENT_FILE): ConsentDeployment {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Cannot read the deployment file at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const address = (field: string): Hex => {
    const value = parsed[field];
    if (typeof value !== "string" || !isAddress(value)) {
      throw new Error(`The deployment file at ${file} has no valid "${field}" address.`);
    }
    return getAddress(value);
  };

  const chainId = parsed.chainId;
  if (typeof chainId !== "number" || chainId !== monad.id) {
    throw new Error(`The deployment file at ${file} is not for Monad mainnet (chain ${monad.id}).`);
  }

  const block = parsed.consentBlock;
  return {
    consent: address("consent"),
    registry: address("registry"),
    chainId,
    ...(typeof block === "number" ? { consentBlock: block } : {}),
  };
}

/** A read-only client on Monad mainnet, pointed at the RPC in the root .env. */
export function monadClient(): PublicClient {
  return createPublicClient({ chain: monad, transport: http(MONAD_MAINNET.rpc) }) as PublicClient;
}

/**
 * Who holds each passport, read one at a time so a single unknown passport cannot hide the rest.
 *
 * A passport nobody has minted makes ownerOf revert, and that comes back as the zero address, the
 * same answer the contract's own _holderOf gives, so both sides of the comparison agree.
 */
export async function holdersOf(
  client: PublicClient,
  registry: Hex,
  passportIds: Hex[],
): Promise<Map<Hex, Hex>> {
  const holders = new Map<Hex, Hex>();
  for (const id of passportIds) {
    const holder = await retryOnce(async () => {
      try {
        return (await client.readContract({
          address: registry,
          abi: registryHolderAbi,
          functionName: "ownerOf",
          args: [BigInt(id)],
        })) as Hex;
      } catch (error) {
        if (isReverted(error)) return NOBODY;
        throw error;
      }
    });
    holders.set(id, holder);
  }
  return holders;
}

/** The newest statement each passport carries, left out of the map when nobody has spoken for it. */
export async function latestConsents(
  client: PublicClient,
  consent: Hex,
  passportIds: Hex[],
): Promise<Map<Hex, OnChainEntry>> {
  const latest = new Map<Hex, OnChainEntry>();
  for (const id of passportIds) {
    const [stated, entry] = await retryOnce(
      async () =>
        (await client.readContract({
          address: consent,
          abi: consentAbi(),
          functionName: "consentOf",
          args: [id],
        })) as [boolean, OnChainEntry],
    );
    if (stated) latest.set(id, entry);
  }
  return latest;
}

export interface Simulation {
  passed: boolean;
  /** The decoded contract error when the call was refused, empty when it went through. */
  error: string;
}

/**
 * Runs one call the way the chain would run it, without sending anything.
 *
 * eth_call from the address that would send is the whole point: it proves the holder check, the
 * ten minute rule and the text rules all pass for this exact calldata, from this exact wallet,
 * against the live contract, before a single MON is spent.
 */
export async function simulate(
  client: PublicClient,
  from: Hex,
  to: Hex,
  data: Hex,
): Promise<Simulation> {
  try {
    await retryOnce(() => client.call({ account: from, to, data }));
    return { passed: true, error: "" };
  } catch (error) {
    return { passed: false, error: decodeConsentError(error) };
  }
}

/** What one call would cost, plus a tenth, because Monad charges the limit that was declared. */
export async function estimateBatchGas(
  client: PublicClient,
  from: Hex,
  to: Hex,
  data: Hex,
): Promise<bigint> {
  const used = await retryOnce(() => client.estimateGas({ account: from, to, data }));
  return (used * 110n) / 100n;
}

/**
 * The contract's own error name for a refused call, so a reader sees NotPassportHolder rather than
 * a hex blob. Falls back to the plain message when the data belongs to no ABI known here.
 */
export function decodeConsentError(error: unknown): string {
  const raw = revertData(error);
  if (raw && raw !== "0x") {
    try {
      const decoded = decodeErrorResult({ abi: consentAbi(), data: raw });
      const args = (decoded.args ?? []).map((value) => String(value)).join(", ");
      return args.length > 0 ? `${decoded.errorName}(${args})` : decoded.errorName;
    } catch {
      // The data belongs to another contract, so the message below is the honest answer.
    }
  }

  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      return reverted.data?.errorName ?? reverted.reason ?? reverted.shortMessage;
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

function isReverted(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return /revert/i.test(error.shortMessage) || error.walk((e) => e instanceof ContractFunctionRevertedError) !== null;
}

function revertData(error: unknown): Hex | undefined {
  if (!(error instanceof BaseError)) return undefined;

  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError && reverted.raw) return reverted.raw;

  const withData = error.walk((e) => {
    const data = (e as { data?: unknown }).data;
    return typeof data === "string" && data.startsWith("0x");
  });
  const data = (withData as { data?: unknown } | null)?.data;
  return typeof data === "string" ? (data as Hex) : undefined;
}

/**
 * One retry for a read the public RPC turned away for asking too often.
 *
 * Only a rate limit is retried. A revert, a bad address or a malformed call means the same thing
 * the second time and hiding it behind a retry would only make the run slower and less clear.
 */
async function retryOnce<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const text = error instanceof Error ? `${error.message}` : String(error);
    if (!RATE_LIMITED.test(text)) throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS));
    return read();
  }
}
