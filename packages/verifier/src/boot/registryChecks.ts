import type { FastifyBaseLogger } from "fastify";
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, getAddress } from "viem";
import type { Env } from "../env.js";
import { domain } from "../generate/eip712.js";
import { AGENT_IDENTITY_REGISTRY } from "../metadata.js";
import { safeReason } from "../net/errorText.js";
import { MONAD_CHAIN_ID, readClient } from "../reputation/registry.js";
import type { Hex } from "../types.js";

/** How often a host whose registry check could not read the chain tries again. */
export const REGISTRY_RETRY_MS = 5 * 60_000;

/** What /generate answers, and /health says, while the registry has not been read yet. */
export const GENERATOR_UNCHECKED_REASON =
  "this host has not yet been able to read the registry on chain to confirm the generator agent's settings, so it draws nothing until it can. It tries again on its own every few minutes.";

/** What /generate answers, and /health says, when a later check found the chain disagreeing. */
export const GENERATOR_MISMATCH_REASON =
  "the registry on chain does not match this host's generator agent settings, so it draws nothing until they agree.";

/**
 * The chain could not be read, which says nothing about whether it agrees with this host. A boot
 * that meets this keeps serving and leaves /generate closed until a later check reads the chain.
 */
export class RegistryUnreadable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryUnreadable";
  }
}

/**
 * Whether a failed read was the chain answering. A revert, or no code at the address, is the chain
 * saying something about this host's settings: a wrong registry address or an agent that does not
 * exist. Every other failure, a connection that drops, a timeout, an endpoint that answers with an
 * error of its own or with bytes that do not decode, is the read failing and proves nothing. Erring
 * that way only keeps /generate closed and re-checked, where erring the other way takes /verify down.
 */
function chainAnswered(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk(
      (inner) => inner instanceof ContractFunctionRevertedError || inner instanceof ContractFunctionZeroDataError,
    ) !== null
  );
}

/** Runs one chain read, and names a failure as a disagreement or as RegistryUnreadable. */
async function readChain<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (chainAnswered(error)) {
      throw new Error(`the chain does not match this host's settings: reading ${what}, ${safeReason(error)}`, {
        cause: error,
      });
    }
    throw new RegistryUnreadable(`could not read ${what} from the chain: ${safeReason(error)}`, { cause: error });
  }
}

/**
 * ERC-5267. The Moolam registry inherits OpenZeppelin's EIP712, which implements this, so the
 * domain the contract will accept signatures under can be read rather than assumed.
 */
const eip712DomainAbi = [
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
] as const;

const ownerOfAbi = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
] as const;

/**
 * Checks that the chain agrees with what this host thinks it is signing for.
 *
 * The generator agent signs EIP-712 passports offline, so a wrong registry address or a wrong
 * chain id produces signatures that look fine here and are rejected by the contract, one wasted
 * image at a time. The same goes for the agent: if the ERC-8004 identity in GENERATOR_AGENT_ID is
 * no longer owned by GENERATOR_WALLET_ADDRESS, every passport this host signs will be refused.
 * Both are read once at boot so the host fails at start instead of per request.
 *
 * The agent check is skipped when GENERATOR_WALLET_ADDRESS is unset, which is allowed: the host
 * then asks Privy for the address at the first signature and there is nothing here to compare.
 *
 * Throws one Error naming every mismatch found, a read the chain reverted or found no contract for
 * among them, and RegistryUnreadable when a read failed without the chain answering.
 */
export async function checkRegistry(config: Env): Promise<void> {
  const registry = getAddress(config.MOOLAM_REGISTRY_ADDRESS) as Hex;
  const client = readClient({ rpcUrl: config.MONAD_MAINNET_RPC_URL });
  const expected = domain(registry, MONAD_CHAIN_ID);
  const problems: string[] = [];

  const [, name, version, chainId, verifyingContract] = await readChain("the registry's signing domain", () =>
    client.readContract({
      address: registry,
      abi: eip712DomainAbi,
      functionName: "eip712Domain",
    }),
  );

  if (name !== expected.name) {
    problems.push(`the registry signs under the domain name "${name}", this host signs "${String(expected.name)}"`);
  }
  if (version !== expected.version) {
    problems.push(
      `the registry signs under domain version "${version}", this host signs "${String(expected.version)}"`,
    );
  }
  if (Number(chainId) !== MONAD_CHAIN_ID) {
    problems.push(`the registry answers for chain ${String(chainId)}, this host signs for ${MONAD_CHAIN_ID}`);
  }
  if (getAddress(verifyingContract) !== registry) {
    problems.push(
      `the registry names ${getAddress(verifyingContract)} as its verifying contract, MOOLAM_REGISTRY_ADDRESS is ${registry}`,
    );
  }

  if (config.GENERATOR_WALLET_ADDRESS !== undefined) {
    const owner = await readChain(`the owner of agent ${config.GENERATOR_AGENT_ID.toString()}`, () =>
      client.readContract({
        address: AGENT_IDENTITY_REGISTRY,
        abi: ownerOfAbi,
        functionName: "ownerOf",
        args: [config.GENERATOR_AGENT_ID],
      }),
    );
    const wallet = getAddress(config.GENERATOR_WALLET_ADDRESS);
    if (getAddress(owner) !== wallet) {
      problems.push(
        `agent ${config.GENERATOR_AGENT_ID.toString()} is owned by ${getAddress(owner)}, GENERATOR_WALLET_ADDRESS is ${wallet}`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`the chain does not match this host's settings: ${problems.join("; ")}`);
  }
}

/** Whether /generate may draw, by the latest registry check. */
export interface GeneratorCheck {
  /** Why /generate is closed right now, or undefined once a check has read the chain and it agreed. */
  closed: () => string | undefined;
  /** Stops any re-check still scheduled. */
  stop: () => void;
}

/**
 * Runs the registry check at boot, and keeps re-running it while it cannot read the chain.
 *
 * A check that agrees opens /generate for good, as the boot check always has. A check that finds a
 * disagreement at boot throws, so the host still refuses to start with settings the chain rejects.
 * A check that cannot read the chain is not a disagreement: the host boots with /verify and the
 * re-check queue serving, /generate answers 503 until a re-check every `retryMs` reads the chain
 * and agrees, and one that finds a disagreement later keeps it closed with that reason (review
 * pass 8, V76). Only one re-check runs at a time, and the timer never keeps the process alive.
 *
 * Throws what `check` throws at boot, except RegistryUnreadable.
 */
export async function watchRegistry(
  check: () => Promise<void>,
  options: { retryMs: number; log: FastifyBaseLogger },
): Promise<GeneratorCheck> {
  try {
    await check();
    return { closed: () => undefined, stop: () => undefined };
  } catch (error) {
    if (!(error instanceof RegistryUnreadable)) {
      throw error;
    }
    options.log.warn(
      { reason: safeReason(error), retryMs: options.retryMs },
      "generate route closed: the registry check could not read the chain, trying again",
    );
  }

  let reason: string | undefined = GENERATOR_UNCHECKED_REASON;
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    void (async () => {
      try {
        await check();
        reason = undefined;
        clearInterval(timer);
        options.log.info("generate route open: the registry check read the chain and it agrees");
      } catch (error) {
        if (error instanceof RegistryUnreadable) {
          reason = GENERATOR_UNCHECKED_REASON;
          options.log.warn({ reason: safeReason(error) }, "generate route still closed: the chain could not be read");
        } else {
          reason = GENERATOR_MISMATCH_REASON;
          options.log.error({ reason: safeReason(error) }, "generate route closed: the chain does not match this host");
        }
      } finally {
        running = false;
      }
    })();
  }, options.retryMs);
  timer.unref();
  return {
    closed: () => reason,
    stop: () => {
      clearInterval(timer);
    },
  };
}
