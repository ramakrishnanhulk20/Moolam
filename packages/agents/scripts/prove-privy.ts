import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { p256 } from "@noble/curves/nist.js";
import { APIError } from "@privy-io/node";
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  parseEther,
  parseEventLogs,
  sha256,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "viem/chains";
import { fingerprint } from "@moolam/verifier/src/fingerprint.js";
import { loadDeployment, MONAD_MAINNET, type Addresses } from "../src/chain/addresses.js";
import { agentIdentityAbi, loadArtifact } from "../src/chain/artifacts.js";
import { bindDigest, Kind, passportDigest, type PassportInput } from "../src/chain/eip712.js";
import { SoftwarePasskey } from "../src/chain/passkey.js";
import { RegistryClient } from "../src/chain/registry.js";
import { pinFile } from "../src/ipfs/pinata.js";
import { isPolicyViolation, ownerContext, privy, privyErrorText } from "../src/privy/client.js";
import { signPassportAsGenerator } from "../src/privy/generatorSigner.js";
import {
  generatorPolicy,
  livePolicyAddresses,
  sessionSignerPolicy,
  syncPolicy,
} from "../src/privy/policies.js";
import {
  getOrCreateWallet,
  readStore,
  sendFromWallet,
  setWalletPolicies,
  SponsoredSendFailed,
  SponsoredSendPending,
  updateStore,
  walletPolicyIds,
  type StoredWallet,
} from "../src/privy/serverWallet.js";
import {
  appendEditAsSessionSigner,
  currentSigners,
  ensureSessionSigner,
  grantSessionSigner,
  revokeSessionSigners,
} from "../src/privy/sessionSigner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
const PASSKEY_FILE = join(PACKAGE_ROOT, ".moolam", "creator-passkey.json");
const REPORT_FILE = join(REPO_ROOT, "proofs", "privy.txt");
const SOURCE_IMAGE = join(REPO_ROOT, "packages", "verifier", "test-assets", "original.jpg");

const EXPLORER_TX = "https://monadvision.com/tx/";

/** Monad reserves 10 MON per account, so a wallet that can work needs that plus a gas budget. */
const MINIMUM_BALANCE = parseEther("11");
const TOP_UP = parseEther("12");

/** Monad charges the gas limit rather than the gas used, so every limit is an estimate plus this. */
const GAS_MARGIN_PERCENT = 110n;

/**
 * The limit set on the two calls Privy is expected to refuse. They never reach the chain, so
 * there is nothing to estimate against, and this is close to what an appendEdit costs.
 */
const REFUSED_CALL_GAS = 400_000n;

/** A 32 byte transaction hash, which is what Privy reports once it has one. */
const TX_HASH = /^0x[0-9a-f]{64}$/i;

/** How far back the registry's own logs are searched for a bind, and how wide each query is. */
const LOG_LOOKBACK = 2_000n;
const LOG_WINDOW = 100n;

const FINGERPRINT_VERSION = 1;
const DEADLINE_WINDOW = 3600n;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

const AGENT_CARD =
  'data:application/json,{"type":"https://eips.ethereum.org/EIPS/eip-8004#registration-v1",' +
  '"name":"Moolam generator on a Privy server wallet",' +
  '"description":"A Moolam generator agent whose signing key lives in Privy secure enclave under ' +
  'a policy that only allows registering passports on the Moolam registry.",' +
  '"services":[],"active":true}';

const registryAbi = loadArtifact("MoolamRegistry").abi;

type Deployer = WalletClient<Transport, Chain, Account>;

export interface Context {
  addresses: Addresses;
  publicClient: PublicClient;
  deployer: Deployer;
  deployerAddress: Hex;
  registry: RegistryClient;
  say: (line?: string) => void;
}

interface GeneratorWallet {
  id: string;
  address: Hex;
  policyId: string;
  /** The contracts Privy's live copy of the policy names, so the report prints fact, not intent. */
  policyTargets: string[];
  agentId: bigint;
}

async function main(): Promise<void> {
  const lines: string[] = [];
  const say = (line = "") => {
    console.log(line);
    lines.push(line);
  };

  const addresses = loadDeployment();
  if (addresses.chainId !== monad.id) {
    throw new Error(
      `The deployment file is for chain ${addresses.chainId}. This proof only runs on Monad mainnet (${monad.id}).`,
    );
  }

  const account = privateKeyToAccount(deployerKey());
  const transport = http(MONAD_MAINNET.rpc);
  const publicClient = createPublicClient({ chain: monad, transport }) as PublicClient;
  const deployer = createWalletClient({ account, chain: monad, transport }) as Deployer;
  const ctx: Context = {
    addresses,
    publicClient,
    deployer,
    deployerAddress: account.address,
    registry: new RegistryClient({ publicClient, walletClient: deployer, addresses }),
    say,
  };

  const owner = ownerContext();
  const runId = `moolam-privy-proof:${Date.now()}`;

  say(`Moolam Privy proof, live on Monad mainnet (chain ${addresses.chainId}).`);
  say(`Started ${new Date().toISOString()}`);
  say(`Registry ${addresses.registry}`);
  say(`Run id   ${runId}`);
  say();

  const generator = await prepareGenerator(ctx, owner);
  say(
    `1. generator wallet: ${generator.address} policy: ${generator.policyId} agentId: ${generator.agentId}`,
  );
  say(
    `   read back from Privy: that policy allows register on ${generator.policyTargets.join(", ")} and nothing else`,
  );
  say();

  const creator = await prepareCreator(ctx);
  const passkey = await creatorPasskey();
  const bind = await bindCreatorPasskey(ctx, creator, passkey, owner);
  say(
    `2. creator wallet: ${creator.address} passkey bound: ${bind.hash} (sponsored: ${bind.sponsored ? "yes" : "no"})`,
  );
  say(`   ${EXPLORER_TX}${bind.hash}`);
  if (bind.sponsored) {
    say("   sponsorship: on, the app paid the gas, not the creator's wallet");
    if (bind.userOperationHash) {
      say(`   Privy routed it as user operation ${bind.userOperationHash}`);
    }
  } else {
    say("   sponsorship: not enabled, paid by wallet");
    if (bind.sponsorError) say(`   Privy refused the sponsored send: ${bind.sponsorError}`);
  }
  say();

  const print = await fingerprint(await readFile(SOURCE_IMAGE));
  const parent = await registerAsGenerator(ctx, {
    generator,
    creator,
    passkey,
    phash: print.phash,
    blockhash: print.blockhash,
    runId,
    owner,
  });
  say(`3. register by generator under policy: ${parent.hash} tokenId ${parent.exactHash}`);
  say(`   ${EXPLORER_TX}${parent.hash}`);
  say();

  const transferRefusal = await expectRefusal(() =>
    sendFromWallet(generator.id, {
      to: ctx.deployerAddress,
      value: parseEther("0.1"),
      gasLimit: 21_000n,
      chainId: addresses.chainId,
      context: owner,
    }),
  );
  if (!transferRefusal.policyViolation) {
    throw new Error(
      `The generator's MON transfer was not refused by the policy: ${transferRefusal.text}`,
    );
  }
  say("4. policy refusal (generator tried to transfer MON): policy_violation");
  say(`   Privy said: ${transferRefusal.text}`);
  say("   no transaction hash: the enclave refused to sign, so nothing reached Monad");
  say();

  const strayEdit = await buildEdit(ctx, {
    parentId: parent.exactHash,
    creator: creator.address,
    agentId: 0n,
    phash: print.phash,
    blockhash: print.blockhash,
    runId: `${runId}#refused-edit`,
    title: "Moolam Privy proof, the edit the generator may not send",
  });
  const editRefusal = await expectRefusal(() =>
    sendFromWallet(generator.id, {
      to: addresses.registry,
      data: encodeFunctionData({
        abi: registryAbi,
        functionName: "appendEdit",
        args: [strayEdit, "0x"],
      }),
      gasLimit: REFUSED_CALL_GAS,
      chainId: addresses.chainId,
      context: owner,
    }),
  );
  if (!editRefusal.policyViolation) {
    throw new Error(`The generator's appendEdit was not refused by the policy: ${editRefusal.text}`);
  }
  say("5. policy refusal (generator tried appendEdit): policy_violation");
  say(`   Privy said: ${editRefusal.text}`);
  say("   same wallet, same contract, different function: the policy names register only");
  say();

  const session = await prepareSessionSigner(ctx, creator.id);
  const edit = await appendEditWithSession(ctx, {
    generator,
    creator,
    parentId: parent.exactHash,
    phash: print.phash,
    blockhash: print.blockhash,
    runId,
    owner,
  });
  say(`6. session signer appendEdit on creator's wallet: ${edit.hash} tokenId ${edit.exactHash}`);
  say(`   ${EXPLORER_TX}${edit.hash}`);
  say(`   signed by key quorum ${session.keyQuorumId} under policy ${session.policyId}`);
  say();

  const remaining = await revokeSessionSigners(creator.id);
  if (remaining.length !== 0) {
    throw new Error(`Privy still lists signers on the creator's wallet: ${remaining.join(", ")}`);
  }
  const afterRevokeEdit = await buildEdit(ctx, {
    parentId: parent.exactHash,
    creator: creator.address,
    agentId: 0n,
    phash: print.phash,
    blockhash: print.blockhash,
    runId: `${runId}#after-revoke`,
    title: "Moolam Privy proof, the edit attempted after the signer was removed",
  });
  const afterRevoke = await expectRefusal(() =>
    appendEditAsSessionSigner(creator.id, {
      to: addresses.registry,
      data: encodeFunctionData({
        abi: registryAbi,
        functionName: "appendEdit",
        args: [afterRevokeEdit, "0x"],
      }),
      gasLimit: REFUSED_CALL_GAS,
      chainId: addresses.chainId,
    }),
  );
  if (!afterRevoke.failed) {
    throw new Error("The session signer could still sign after the creator removed it.");
  }
  say(`7. signer removed; appendEdit attempt refused: ${afterRevoke.text}`);
  const left = await currentSigners(creator.id);
  say(`   signers now on ${creator.address}: ${left.length === 0 ? "none" : left.join(", ")}`);
  say();

  say("Gas. Monad charges the limit that was set, which is why the receipt repeats it as gasUsed.");
  say(`  bindPasskey ${await gasLine(ctx, bind.hash, bind.gasLimit)}`);
  say(`  register    ${await gasLine(ctx, parent.hash, parent.gasLimit)}`);
  say(`  appendEdit  ${await gasLine(ctx, edit.hash, edit.gasLimit)}`);

  await mkdir(dirname(REPORT_FILE), { recursive: true });
  await writeFile(REPORT_FILE, `${lines.join("\n")}\n`, "utf8");
  console.log();
  console.log(`Saved to ${REPORT_FILE}`);
}

/**
 * Brings the generator wallet to the state the proof needs: funded, holding its own ERC-8004
 * identity, and locked down by its policy.
 *
 * The order matters. Minting an identity is a call to another contract, which the policy forbids,
 * so the identity comes first and the policy goes on after. A later run skips both.
 */
async function prepareGenerator(
  ctx: Context,
  owner: ReturnType<typeof ownerContext>,
): Promise<GeneratorWallet> {
  const { wallet, created } = await getOrCreateWallet("generator");
  ctx.say(
    created
      ? `Created the generator server wallet ${wallet.address}`
      : `Reusing the generator server wallet ${wallet.address}`,
  );

  // The policy is built before any MON moves, so a rejected rule costs nothing but a round trip.
  // Every rule is rebuilt from the registry in the deployment file. A policy id cached before a
  // redeploy still resolves, while every address inside it points at the contract that is gone.
  const synced = await syncPolicy(
    wallet.policyId,
    generatorPolicy(ctx.addresses.registry, ctx.addresses.chainId),
    ctx.addresses.registry,
  );
  const policyId = synced.policyId;
  ctx.say(
    `Generator policy ${policyId} ${synced.action}, rebuilt from registry ${ctx.addresses.registry}`,
  );

  await fundIfNeeded(ctx, wallet.address, "generator");

  let agentId = await knownAgent(ctx, wallet);
  if (agentId === undefined) {
    if ((await walletPolicyIds(wallet.id)).length > 0) {
      await setWalletPolicies(wallet.id, []);
      ctx.say("Lifted the policy so the wallet could mint its own agent identity");
    }
    agentId = await registerAgent(ctx, wallet, owner);
    updateStore({ generator: { ...wallet, policyId, agentId: agentId.toString() } });
    ctx.say(`Minted ERC-8004 agent ${agentId} to the generator wallet`);
  }

  if (!(await walletPolicyIds(wallet.id)).includes(policyId)) {
    await setWalletPolicies(wallet.id, [policyId]);
    ctx.say(`Attached policy ${policyId} to the generator wallet`);
  }
  const live = await walletPolicyIds(wallet.id);
  if (!live.includes(policyId)) {
    throw new Error(`Privy did not attach policy ${policyId} to wallet ${wallet.id}.`);
  }

  updateStore({
    generator: { id: wallet.id, address: wallet.address, policyId, agentId: agentId.toString() },
  });
  return {
    id: wallet.id,
    address: wallet.address,
    policyId,
    policyTargets: await livePolicyAddresses(policyId),
    agentId,
  };
}

/** The agent id this wallet already owns on the ERC-8004 registry, or undefined when it owns none. */
async function knownAgent(ctx: Context, wallet: StoredWallet): Promise<bigint | undefined> {
  const recorded = readStore().generator?.agentId ?? wallet.agentId;
  if (!recorded) return undefined;
  try {
    const owner = (await ctx.publicClient.readContract({
      address: ctx.addresses.agentIdentity,
      abi: agentIdentityAbi,
      functionName: "ownerOf",
      args: [BigInt(recorded)],
    })) as Hex;
    return getAddress(owner) === getAddress(wallet.address) ? BigInt(recorded) : undefined;
  } catch {
    return undefined;
  }
}

/** Mints an ERC-8004 identity from the generator's own wallet, so the agent owns its name. */
async function registerAgent(
  ctx: Context,
  wallet: StoredWallet,
  owner: ReturnType<typeof ownerContext>,
): Promise<bigint> {
  const data = encodeFunctionData({
    abi: agentIdentityAbi,
    functionName: "register",
    args: [AGENT_CARD],
  });
  const gasLimit = await estimate(ctx, wallet.address, ctx.addresses.agentIdentity, data);
  const sent = await sendFromWallet(wallet.id, {
    to: ctx.addresses.agentIdentity,
    data,
    gasLimit,
    chainId: ctx.addresses.chainId,
    context: owner,
  });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: sent.hash });
  if (receipt.status !== "success") {
    throw new Error(`Registering the agent reverted in ${sent.hash}.`);
  }

  const [minted] = parseEventLogs({
    abi: agentIdentityAbi,
    eventName: "Transfer",
    logs: receipt.logs,
  }).filter(
    (log) =>
      log.address.toLowerCase() === ctx.addresses.agentIdentity.toLowerCase() &&
      log.args.from === "0x0000000000000000000000000000000000000000",
  );
  if (!minted) {
    throw new Error(`No agent was minted in ${sent.hash}.`);
  }
  return minted.args.tokenId;
}

/** The creator's wallet. The creator owns it; the app can only ever borrow it through a signer. */
async function prepareCreator(ctx: Context): Promise<StoredWallet> {
  const { wallet, created } = await getOrCreateWallet("creator");
  ctx.say(
    created ? `Created the creator wallet ${wallet.address}` : `Reusing the creator wallet ${wallet.address}`,
  );
  await fundIfNeeded(ctx, wallet.address, "creator");
  return wallet;
}

/** Tops a wallet up from the deployer when it cannot cover Monad's 10 MON reserve plus gas. */
async function fundIfNeeded(ctx: Context, address: Hex, label: string): Promise<void> {
  const balance = await ctx.publicClient.getBalance({ address });
  if (balance >= MINIMUM_BALANCE) {
    ctx.say(`  ${label} balance ${Number(formatEther(balance)).toFixed(3)} MON, no top up needed`);
    return;
  }
  const hash = await ctx.deployer.sendTransaction({ to: address, value: TOP_UP, gas: 21_000n });
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  ctx.say(`  funded ${label} with ${formatEther(TOP_UP)} MON in ${hash}`);
}

/** The creator's passkey, generated once and kept out of the console and out of git. */
async function creatorPasskey(): Promise<SoftwarePasskey> {
  try {
    const stored = JSON.parse(await readFile(PASSKEY_FILE, "utf8")) as { privateKey?: string };
    if (typeof stored.privateKey === "string") {
      return SoftwarePasskey.fromPrivateKey(stored.privateKey as Hex);
    }
  } catch {
    // There is no key yet, so one is made below.
  }

  const privateKey = bytesToHex(p256.utils.randomSecretKey());
  await mkdir(dirname(PASSKEY_FILE), { recursive: true });
  await writeFile(PASSKEY_FILE, `${JSON.stringify({ privateKey }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return SoftwarePasskey.fromPrivateKey(privateKey);
}

export interface BoundPasskey {
  hash: Hex;
  sponsored: boolean;
  gasLimit: bigint;
  /** What Privy said when it turned the sponsored send down, printed as it came. */
  sponsorError?: string;
  userOperationHash?: string;
}

/**
 * Binds the creator's passkey to their Privy wallet, sponsored when the app has sponsorship on.
 *
 * The passkey signature is the authority the registry checks. Privy's wallet only sends the call
 * and pays for it. A refusal is printed and the wallet pays instead. Anything that is not a
 * refusal is treated as a send that may already be on chain, and the bind nonce settles it.
 */
export async function bindCreatorPasskey(
  ctx: Context,
  creator: StoredWallet,
  passkey: SoftwarePasskey,
  owner: ReturnType<typeof ownerContext>,
): Promise<BoundPasskey> {
  const nonce = await ctx.registry.bindNonce(creator.address);
  const digest = bindDigest(creator.address, passkey.qx, passkey.qy, nonce, ctx.registry.domain);
  const onChain = await ctx.registry.hashBind(creator.address, passkey.qx, passkey.qy, nonce);
  if (onChain.toLowerCase() !== digest.toLowerCase()) {
    throw new Error(`The bind digest here is ${digest} and the contract says ${onChain}.`);
  }

  const data = encodeFunctionData({
    abi: registryAbi,
    functionName: "bindPasskey",
    args: [passkey.qx, passkey.qy, passkey.sign(digest)],
  });
  const gasLimit = await estimate(ctx, creator.address, ctx.addresses.registry, data);
  const call = {
    to: ctx.addresses.registry,
    data,
    gasLimit,
    chainId: ctx.addresses.chainId,
    context: owner,
  };

  let sponsorError: string;
  try {
    const sponsored = await sendFromWallet(creator.id, { ...call, sponsor: true });
    await confirm(ctx, sponsored.hash, "bindPasskey");
    return {
      hash: sponsored.hash,
      sponsored: true,
      gasLimit,
      userOperationHash: sponsored.userOperationHash,
    };
  } catch (error) {
    if (!isPrivyRefusal(error)) {
      return await settleSponsoredBind(ctx, creator, nonce, gasLimit, error);
    }
    sponsorError = privyErrorText(error);
    ctx.say(`  Privy refused the sponsored send before submitting it: ${sponsorError}`);
  }

  const sent = await sendFromWallet(creator.id, call);
  await confirm(ctx, sent.hash, "bindPasskey");
  return { hash: sent.hash, sponsored: false, gasLimit, sponsorError };
}

/**
 * Whether Privy turned a request down before it submitted anything.
 *
 * Only an HTTP 4xx from Privy counts: a policy violation, invalid data, a key it would not accept.
 * A sponsored send that stalled, one Privy later reported dead, and a receipt wait that timed out
 * are not refusals. Calling one of those a refusal is what made an earlier run send a second bind
 * on top of one that had already landed, and the second one reverted.
 */
export function isPrivyRefusal(error: unknown): boolean {
  if (error instanceof SponsoredSendPending || error instanceof SponsoredSendFailed) return false;
  if (!(error instanceof APIError)) return false;
  return typeof error.status === "number" && error.status >= 400 && error.status < 500;
}

/**
 * Works out what happened to a sponsored bind that neither reported a hash nor was refused.
 *
 * The bind nonce is the honest witness: the registry only moves it when a bind succeeded. If it
 * moved, this run's bind is already written and a second one would revert, so the hash is hunted
 * down through Privy and then through the registry's own logs. If it did not move, nothing is
 * assumed and the run stops with the transaction id to look up.
 */
async function settleSponsoredBind(
  ctx: Context,
  creator: StoredWallet,
  nonce: bigint,
  gasLimit: bigint,
  error: unknown,
): Promise<BoundPasskey> {
  const transactionId =
    error instanceof SponsoredSendPending || error instanceof SponsoredSendFailed
      ? error.transactionId
      : undefined;
  const named = transactionId
    ? `Privy transaction ${transactionId}`
    : "the send, which carried no Privy transaction id,";
  const detail = error instanceof Error ? error.message : String(error);
  const now = await ctx.registry.bindNonce(creator.address);

  if (now === nonce) {
    throw new Error(
      `The sponsored bind is unresolved. ${detail} The bind nonce is still ${nonce}, so nothing was written, and no unsponsored bind was sent because ${named} may still land. Check it on Privy before running this again.`,
    );
  }

  ctx.say(`  the sponsored bind did land: the bind nonce moved from ${nonce} to ${now}`);
  const found =
    (transactionId ? await bindHashFromPrivy(transactionId) : undefined) ??
    (await bindHashFromLogs(ctx, creator.address, nonce));
  if (!found) {
    throw new Error(
      `The sponsored bind landed but its hash is nowhere to be found: ${named} reports none, and the registry logged no PasskeyBound for ${creator.address} at nonce ${nonce} within the last ${LOG_LOOKBACK} blocks.`,
    );
  }
  await confirm(ctx, found.hash, "bindPasskey");
  return {
    hash: found.hash,
    sponsored: true,
    gasLimit,
    userOperationHash: found.userOperationHash,
  };
}

/** The hash Privy holds for a transaction id, once it has one. */
async function bindHashFromPrivy(
  transactionId: string,
): Promise<{ hash: Hex; userOperationHash?: string } | undefined> {
  const transaction = await privy().transactions().get(transactionId);
  const hash = transaction.transaction_hash ?? "";
  if (!TX_HASH.test(hash)) return undefined;
  return { hash: hash as Hex, userOperationHash: transaction.user_operation_hash };
}

/**
 * The transaction that bound this wallet's passkey at this nonce, read from the registry's logs.
 *
 * This is the last resort when Privy still has no hash. Monad caps how wide an eth_getLogs range
 * may be, so the search walks backwards in small windows rather than asking for the whole span.
 */
async function bindHashFromLogs(
  ctx: Context,
  wallet: Hex,
  nonce: bigint,
): Promise<{ hash: Hex; userOperationHash?: string } | undefined> {
  const latest = await ctx.publicClient.getBlockNumber();
  const floor = latest > LOG_LOOKBACK ? latest - LOG_LOOKBACK : 0n;

  for (let toBlock = latest; toBlock >= floor; ) {
    const fromBlock = toBlock > floor + LOG_WINDOW ? toBlock - LOG_WINDOW : floor;
    const logs = await ctx.publicClient.getLogs({
      address: ctx.addresses.registry,
      fromBlock,
      toBlock,
    });
    const bound = parseEventLogs({
      abi: registryAbi,
      eventName: "PasskeyBound",
      logs,
    }) as unknown as { args: { wallet: Hex; nonce: bigint }; transactionHash: Hex }[];
    const match = bound.find(
      (log) => log.args.nonce === nonce && log.args.wallet.toLowerCase() === wallet.toLowerCase(),
    );
    if (match) return { hash: match.transactionHash };
    if (fromBlock === floor) return undefined;
    toBlock = fromBlock - 1n;
  }
  return undefined;
}

/** The passport the generator registers: its own agent id, the creator's passkey, one policy. */
async function registerAsGenerator(
  ctx: Context,
  args: {
    generator: GeneratorWallet;
    creator: StoredWallet;
    passkey: SoftwarePasskey;
    phash: bigint;
    blockhash: Hex;
    runId: string;
    owner: ReturnType<typeof ownerContext>;
  },
): Promise<{ hash: Hex; exactHash: Hex; gasLimit: bigint }> {
  const exactHash = sha256(new TextEncoder().encode(args.runId));
  const pinned = await pinRunDocument({
    title: "Moolam Privy proof, the original",
    runId: args.runId,
    exactHash,
    parentId: ZERO_BYTES32,
    creator: args.creator.address,
    agentId: args.generator.agentId,
    phash: args.phash,
    blockhash: args.blockhash,
  });

  const input: PassportInput = {
    exactHash,
    parentId: ZERO_BYTES32,
    creator: args.creator.address,
    generatorAgentId: args.generator.agentId,
    phash: args.phash,
    blockhash256: args.blockhash,
    manifestHash: pinned.manifestHash,
    kind: Kind.Generated,
    fingerprintVersion: FINGERPRINT_VERSION,
    metadataURI: pinned.uri,
    deadline: (await ctx.publicClient.getBlock()).timestamp + DEADLINE_WINDOW,
  };

  const digest = passportDigest(input, ctx.registry.domain);
  const onChain = await ctx.registry.hashPassport(input);
  if (onChain.toLowerCase() !== digest.toLowerCase()) {
    throw new Error(`The passport digest here is ${digest} and the contract says ${onChain}.`);
  }

  const generatorSig = await signPassportAsGenerator(
    args.generator.id,
    args.generator.address,
    input,
    ctx.registry.domain,
    args.owner,
  );
  ctx.say(`  the agent signed the passport through Privy, recovered back to ${args.generator.address}`);
  ctx.say(`  metadata pinned at ${pinned.uri}`);

  const data = encodeFunctionData({
    abi: registryAbi,
    functionName: "register",
    args: [input, args.passkey.sign(digest), generatorSig],
  });
  const gasLimit = await estimate(ctx, args.generator.address, ctx.addresses.registry, data);
  const sent = await sendFromWallet(args.generator.id, {
    to: ctx.addresses.registry,
    data,
    gasLimit,
    chainId: ctx.addresses.chainId,
    context: args.owner,
  });
  await confirm(ctx, sent.hash, "register");
  return { hash: sent.hash, exactHash, gasLimit };
}

/** Makes sure the app's session key exists, is scoped by a policy, and is a signer on the wallet. */
async function prepareSessionSigner(
  ctx: Context,
  creatorWalletId: string,
): Promise<{ keyQuorumId: string; policyId: string }> {
  const signer = await ensureSessionSigner();
  const synced = await syncPolicy(
    readStore().sessionSigner?.policyId,
    sessionSignerPolicy(ctx.addresses.registry, ctx.addresses.chainId),
    ctx.addresses.registry,
  );
  const policyId = synced.policyId;
  ctx.say(
    `Session signer policy ${policyId} ${synced.action}, rebuilt from registry ${ctx.addresses.registry}`,
  );
  updateStore({ sessionSigner: { keyQuorumId: signer.keyQuorumId, policyId } });

  const listed = await grantSessionSigner(creatorWalletId, {
    keyQuorumId: signer.keyQuorumId,
    policyId,
  });
  if (!listed.includes(signer.keyQuorumId)) {
    throw new Error(`Privy did not list ${signer.keyQuorumId} as a signer on the creator's wallet.`);
  }
  ctx.say(`The creator granted key quorum ${signer.keyQuorumId} permission to append edits`);
  return { keyQuorumId: signer.keyQuorumId, policyId };
}

/** The edit the session signer sends on the creator's behalf, co-signed by the agent. */
async function appendEditWithSession(
  ctx: Context,
  args: {
    generator: GeneratorWallet;
    creator: StoredWallet;
    parentId: Hex;
    phash: bigint;
    blockhash: Hex;
    runId: string;
    owner: ReturnType<typeof ownerContext>;
  },
): Promise<{ hash: Hex; exactHash: Hex; gasLimit: bigint }> {
  const input = await buildEdit(ctx, {
    parentId: args.parentId,
    creator: args.creator.address,
    agentId: args.generator.agentId,
    phash: args.phash,
    blockhash: args.blockhash,
    runId: `${args.runId}#edit`,
    title: "Moolam Privy proof, the edit",
  });

  const generatorSig = await signPassportAsGenerator(
    args.generator.id,
    args.generator.address,
    input,
    ctx.registry.domain,
    args.owner,
  );
  const data = encodeFunctionData({
    abi: registryAbi,
    functionName: "appendEdit",
    args: [input, generatorSig],
  });
  const gasLimit = await estimate(ctx, args.creator.address, ctx.addresses.registry, data);
  const sent = await appendEditAsSessionSigner(args.creator.id, {
    to: ctx.addresses.registry,
    data,
    gasLimit,
    chainId: ctx.addresses.chainId,
  });
  await confirm(ctx, sent.hash, "appendEdit");
  return { hash: sent.hash, exactHash: input.exactHash, gasLimit };
}

/** Builds one edit passport and pins its document, so metadataURI points at something real. */
async function buildEdit(
  ctx: Context,
  args: {
    parentId: Hex;
    creator: Hex;
    agentId: bigint;
    phash: bigint;
    blockhash: Hex;
    runId: string;
    title: string;
  },
): Promise<PassportInput> {
  const exactHash = sha256(new TextEncoder().encode(args.runId));
  const pinned = await pinRunDocument({
    title: args.title,
    runId: args.runId,
    exactHash,
    parentId: args.parentId,
    creator: args.creator,
    agentId: args.agentId,
    phash: args.phash,
    blockhash: args.blockhash,
  });

  return {
    exactHash,
    parentId: args.parentId,
    creator: args.creator,
    generatorAgentId: args.agentId,
    phash: args.phash,
    blockhash256: args.blockhash,
    manifestHash: pinned.manifestHash,
    kind: Kind.Edited,
    fingerprintVersion: FINGERPRINT_VERSION,
    metadataURI: pinned.uri,
    deadline: (await ctx.publicClient.getBlock()).timestamp + DEADLINE_WINDOW,
  };
}

/**
 * Pins the document a passport points at and returns the hash of exactly those bytes.
 *
 * manifestHash on chain is the sha256 of the pinned file, so anyone can fetch the file and check
 * that the record and the document are the same thing.
 */
async function pinRunDocument(doc: {
  title: string;
  runId: string;
  exactHash: Hex;
  parentId: Hex;
  creator: Hex;
  agentId: bigint;
  phash: bigint;
  blockhash: Hex;
}): Promise<{ uri: string; manifestHash: Hex }> {
  const body = {
    name: doc.title,
    description:
      "A record written by the Moolam Privy proof. The wallets named here are Privy server wallets on Monad mainnet, and the fingerprint fields come from packages/verifier/test-assets/original.jpg.",
    run: doc.runId,
    passportId: doc.exactHash,
    parentId: doc.parentId,
    creator: doc.creator,
    generatorAgentId: doc.agentId.toString(),
    fingerprint: {
      phash: `0x${doc.phash.toString(16).padStart(16, "0")}`,
      blockhash: doc.blockhash,
      version: FINGERPRINT_VERSION,
      source: "packages/verifier/test-assets/original.jpg",
    },
    createdAt: new Date().toISOString(),
  };

  const bytes = Buffer.from(`${JSON.stringify(body, null, 2)}\n`, "utf8");
  const name = `${doc.runId.replace(/[^a-z0-9]+/gi, "-")}.json`;
  const pinned = await pinFile(bytes, name, "application/json");
  return { uri: pinned.uri, manifestHash: sha256(new Uint8Array(bytes)) };
}

/** Runs a call that is meant to fail and reports what came back, without ever hiding a success. */
async function expectRefusal(
  call: () => Promise<unknown>,
): Promise<{ failed: boolean; policyViolation: boolean; text: string }> {
  try {
    await call();
    return { failed: false, policyViolation: false, text: "the call went through" };
  } catch (error) {
    return { failed: true, policyViolation: isPolicyViolation(error), text: privyErrorText(error) };
  }
}

/** An estimate plus ten percent, because Monad charges the limit that was set. */
async function estimate(ctx: Context, from: Hex, to: Hex, data: Hex): Promise<bigint> {
  const used = await ctx.publicClient.estimateGas({ account: from, to, data });
  return (used * GAS_MARGIN_PERCENT) / 100n;
}

async function confirm(ctx: Context, hash: Hex, what: string): Promise<void> {
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`${what} reverted on chain in ${hash}.`);
  }
}

/** What one transaction cost: the limit that was set, the price it paid, and the MON that left. */
async function gasLine(ctx: Context, hash: Hex, limit: bigint): Promise<string> {
  const receipt = await ctx.publicClient.getTransactionReceipt({ hash });
  const price = receipt.effectiveGasPrice;
  const cost = limit * price;
  return (
    `limit ${limit.toLocaleString("en-US")} at ${(Number(price) / 1e9).toFixed(0)} gwei, ` +
    `${Number(formatEther(cost)).toFixed(4)} MON`
  );
}

function deployerKey(): Hex {
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (key === undefined || !/^0x[0-9a-f]{64}$/i.test(key)) {
    throw new Error(
      "DEPLOYER_PRIVATE_KEY is missing from the root .env, or is not a 32 byte hex key.",
    );
  }
  return key as Hex;
}

// Running this file starts the proof; importing it, as the tests do, does not.
// The comparison is lowercased because Windows hands back the drive letter in either case.
const entry = process.argv[1];
const here = fileURLToPath(import.meta.url).toLowerCase();
if (entry !== undefined && resolve(entry).toLowerCase() === here) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
