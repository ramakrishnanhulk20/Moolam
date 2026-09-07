import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  parseEventLogs,
  type Abi,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import type { Addresses } from "./addresses.js";
import { agentIdentityAbi, loadArtifact } from "./artifacts.js";
import { bindDigest, domain, PASSPORT_TYPES, type PassportInput } from "./eip712.js";
import type { SoftwarePasskey, WebAuthnAuth } from "./passkey.js";

export interface Passport {
  exactHash: Hex;
  parentId: Hex;
  creator: Hex;
  generatorAgentId: bigint;
  phash: bigint;
  blockhash256: Hex;
  manifestHash: Hex;
  kind: number;
  fingerprintVersion: number;
  registeredAt: bigint;
  disputed: boolean;
  metadataURI: string;
}

export interface WriteResult {
  hash: Hex;
  tokenId: bigint;
  gasUsed: bigint;
}

type AnyPublicClient = PublicClient<Transport, Chain | undefined>;
type AnyWalletClient = WalletClient<Transport, Chain | undefined, Account>;

export interface RegistryClientOptions {
  publicClient: AnyPublicClient;
  walletClient: AnyWalletClient;
  addresses: Addresses;
}

/**
 * The one client every part of Moolam talks to the registry through: the agent, the prove-it
 * command and the app. It builds the digests the contract checks, sends the three writes, and
 * turns a revert back into the custom error name the contract raised.
 */
export class RegistryClient {
  readonly addresses: Addresses;

  readonly #publicClient: AnyPublicClient;
  readonly #walletClient: AnyWalletClient;
  readonly #registryAbi: Abi;
  readonly #errorAbis: Abi[];

  constructor(opts: RegistryClientOptions) {
    this.addresses = opts.addresses;
    this.#publicClient = opts.publicClient;
    this.#walletClient = opts.walletClient;
    this.#registryAbi = loadArtifact("MoolamRegistry").abi;
    this.#errorAbis = [
      this.#registryAbi,
      loadArtifact("VerifierPolicy").abi,
      loadArtifact("MoolamReceiver").abi,
    ];
  }

  /** The EIP-712 domain the registry signs under. */
  get domain() {
    return domain(this.addresses.registry, this.addresses.chainId);
  }

  /** The contract's own view of the passport digest, used to check the local one agrees. */
  async hashPassport(input: PassportInput): Promise<Hex> {
    return (await this.#publicClient.readContract({
      address: this.addresses.registry,
      abi: this.#registryAbi,
      functionName: "hashPassport",
      args: [input],
    })) as Hex;
  }

  /** The contract's own view of the bind digest. */
  async hashBind(wallet: Hex, qx: Hex, qy: Hex, nonce: bigint): Promise<Hex> {
    return (await this.#publicClient.readContract({
      address: this.addresses.registry,
      abi: this.#registryAbi,
      functionName: "hashBind",
      args: [wallet, qx, qy, nonce],
    })) as Hex;
  }

  /** The nonce the next bind signature from this wallet must carry. */
  async bindNonce(wallet: Hex): Promise<bigint> {
    return (await this.#publicClient.readContract({
      address: this.addresses.registry,
      abi: this.#registryAbi,
      functionName: "bindNonce",
      args: [wallet],
    })) as bigint;
  }

  /**
   * Binds a passkey to the wallet this client signs with, or rotates the one already bound.
   *
   * Builds the bind digest locally, signs it with the passkey, and sends the transaction.
   * Throws the decoded contract error when the assertion does not check out.
   */
  async bindPasskey(passkey: SoftwarePasskey): Promise<Hex> {
    const wallet = this.#account.address;
    const nonce = await this.bindNonce(wallet);
    const digest = bindDigest(wallet, passkey.qx, passkey.qy, nonce, this.domain);
    const auth = passkey.sign(digest);

    const { hash } = await this.#send("bindPasskey", [passkey.qx, passkey.qy, auth]);
    return hash;
  }

  /**
   * Signs a passport as the generator agent's owner. The wallet signs the same EIP-712 struct
   * the creator's passkey signs, so the two signatures always cover identical bytes.
   */
  async signAsGenerator(input: PassportInput, account?: Account): Promise<Hex> {
    return this.#walletClient.signTypedData({
      account: account ?? this.#account,
      domain: this.domain,
      types: PASSPORT_TYPES,
      primaryType: "Passport",
      message: input,
    });
  }

  /**
   * Registers an original image. The creator's passkey assertion and, for a Generated image,
   * the agent owner's signature are the authority; whoever sends the transaction only pays gas.
   */
  async register(
    input: PassportInput,
    creatorAuth: WebAuthnAuth,
    generatorSig: Hex,
  ): Promise<WriteResult> {
    return this.#send("register", [input, creatorAuth, generatorSig]);
  }

  /**
   * Records an edit of an existing passport. Holding the parent token is the authority here,
   * so there is no passkey prompt.
   */
  async appendEdit(input: PassportInput, generatorSig: Hex): Promise<WriteResult> {
    return this.#send("appendEdit", [input, generatorSig]);
  }

  /** Reads a whole passport record. Every field is zero when the passport does not exist. */
  async getPassport(id: Hex): Promise<Passport> {
    return (await this.#publicClient.readContract({
      address: this.addresses.registry,
      abi: this.#registryAbi,
      functionName: "getPassport",
      args: [id],
    })) as Passport;
  }

  /** Who owns a passport token. */
  async ownerOf(id: Hex): Promise<Hex> {
    return (await this.#publicClient.readContract({
      address: this.addresses.registry,
      abi: this.#registryAbi,
      functionName: "ownerOf",
      args: [BigInt(id)],
    })) as Hex;
  }

  /**
   * Mints an agent identity on the canonical ERC-8004 Identity Registry.
   *
   * The id comes from the ERC-721 Transfer log rather than the simulated return value, because
   * another registration landing first would shift the id the simulation predicted.
   */
  async registerAgentOnIdentityRegistry(agentURI: string): Promise<{ hash: Hex; agentId: bigint }> {
    const account = this.#account;
    const hash = await this.#walletClient.writeContract({
      address: this.addresses.agentIdentity,
      abi: agentIdentityAbi,
      functionName: "register",
      args: [agentURI],
      chain: this.#walletClient.chain,
      account,
    });
    const receipt = await this.#publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`Registering the agent failed in transaction ${hash}.`);
    }

    const [minted] = parseEventLogs({
      abi: agentIdentityAbi,
      eventName: "Transfer",
      logs: receipt.logs,
    }).filter(
      (log) =>
        log.address.toLowerCase() === this.addresses.agentIdentity.toLowerCase() &&
        log.args.from === "0x0000000000000000000000000000000000000000",
    );

    if (!minted) {
      throw new Error(`No agent was minted in transaction ${hash}.`);
    }
    return { hash, agentId: minted.args.tokenId };
  }

  /**
   * Turns a revert into the custom error name the contract raised, so a caller can act on
   * "UnknownAgent" rather than on a hex blob. Falls back to the plain message when the data
   * belongs to no ABI this client knows.
   */
  decodeError(error: unknown): string {
    const raw = revertData(error);
    if (raw && raw !== "0x") {
      for (const abi of this.#errorAbis) {
        try {
          return decodeErrorResult({ abi, data: raw }).errorName;
        } catch {
          // The data belongs to a different contract, so try the next ABI.
        }
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

  get #account(): Account {
    const account = this.#walletClient.account;
    if (!account) {
      throw new Error("This RegistryClient has no account. Build the wallet client with one.");
    }
    return account;
  }

  async #send(functionName: string, args: unknown[]): Promise<WriteResult> {
    const account = this.#account;
    const { request } = await this.#publicClient.simulateContract({
      address: this.addresses.registry,
      abi: this.#registryAbi,
      functionName,
      args,
      account,
    });

    const hash = await this.#walletClient.writeContract({
      ...request,
      chain: this.#walletClient.chain,
      account,
    });
    const receipt = await this.#publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`${functionName} reverted on chain in transaction ${hash}.`);
    }

    const [transfer] = parseEventLogs({
      abi: this.#registryAbi,
      eventName: "Transfer",
      logs: receipt.logs,
    }) as { args: { tokenId?: bigint } }[];

    return { hash, tokenId: transfer?.args.tokenId ?? 0n, gasUsed: receipt.gasUsed };
  }
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
