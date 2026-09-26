import { execFileSync } from "node:child_process";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatEther,
  http,
  parseEventLogs,
  sha256,
  type Abi,
  type Account,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MONAD_MAINNET, loadDeployment, type Addresses } from "../src/chain/addresses.js";
import { monadFork, startAnvilFork } from "../src/chain/anvil.js";
import { loadArtifact, policyAbi, receiverAbi, registryAbi } from "../src/chain/artifacts.js";
import { Kind, passportDigest, type PassportInput } from "../src/chain/eip712.js";
import { SoftwarePasskey } from "../src/chain/passkey.js";
import { RegistryClient } from "../src/chain/registry.js";

/**
 * The second attack pass, executed against a local fork of Monad mainnet.
 *
 * Every contract here is a deployed one: the registry, the policy and the receiver are the
 * deployed addresses with their real bytecode and their real state, forked. Nothing in this file
 * can reach mainnet, because every write goes to the anvil fork started below, and mainnet is only
 * ever read from.
 *
 * The receiver is the first MoolamReceiver, the deployment file's "receiver", and it is attacked
 * on purpose although the policy retired it at block 108,102,728. The replay gap in attack 5
 * belongs to its design and this pass is the record of it. The SimulationReceivers that replaced
 * it are attacked by npm run prove and by SimulationReceiver.fork.t.sol.
 *
 * Two of the attacks are known gaps rather than refusals. They print LANDED AS EXPECTED and name
 * the remedy, because a proof that hides the holes is worth nothing.
 */

/** The passport ids this run uses, fixed so a reader can find the same rows on every run. */
const ID = {
  substitution: label("digest-substitution"),
  attackerCopy: label("digest-substitution-attacker"),
  stale: label("stale-deadline"),
  replay: label("replayed-recheck"),
  parent: label("disputed-parent"),
  child: label("edit-of-disputed-parent"),
  bond: label("bond-safety"),
};

const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
const ZERO_BYTES10 = "0x00000000000000000000" as Hex;

/** Enough for any of these calls, and set by hand so a refusal is never an out of gas. */
const CALL_GAS = 600_000n;

interface Line {
  n: string;
  what: string;
  verdict: string;
  /** What this attack did not put to the test, said next to what it found. */
  notCovered: string;
}

const lines: Line[] = [];
const say = (line = ""): void => console.log(line);

function label(name: string): Hex {
  return sha256(new TextEncoder().encode(`moolam-attack-pass-2:${name}`));
}

function commitHash(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const addresses: Addresses = loadDeployment();
  const fork = await startAnvilFork(MONAD_MAINNET.rpc);

  try {
    const chain = monadFork(fork.rpc);
    const publicClient = createPublicClient({ chain, transport: http(fork.rpc) }) as PublicClient;
    const forkBlock = await publicClient.getBlockNumber({ cacheTime: 0 });

    const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
      const response = await fetch(fork.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = (await response.json()) as { result?: unknown; error?: { message: string } };
      if (body.error) throw new Error(`${method} on the fork failed: ${body.error.message}`);
      return body.result;
    };

    const walletFor = (account: Account | Hex) =>
      createWalletClient({ account, chain, transport: http(fork.rpc) });

    /** Ten thousand MON on the fork, which is where every wallet in this run gets its money. */
    const fund = async (who: Hex): Promise<void> => {
      await rpc("anvil_setBalance", [who, "0x21e19e0c9bab2400000"]);
    };

    /** A mainnet address, borrowed on the fork only. Nothing signs; anvil answers for it. */
    const impersonate = async (who: Hex) => {
      await rpc("anvil_impersonateAccount", [who]);
      await fund(who);
      return walletFor(who);
    };

    // Fresh keys, not anvil's published ten. Every one of those ten carries an EIP-7702
    // delegation on Monad mainnet today, and the delegate sweeps whatever is sent to it, so a
    // bond paid back to one of them leaves the fork with an empty wallet and a wrong proof.
    const creatorAccount = privateKeyToAccount(generatePrivateKey());
    const challengerAccount = privateKeyToAccount(generatePrivateKey());
    const strangerAccount = privateKeyToAccount(generatePrivateKey());
    // The bond attack gets a challenger of its own, so the credit it withdraws is one bond and
    // not that bond plus the one the disputed parent above left standing.
    const bondChallengerAccount = privateKeyToAccount(generatePrivateKey());
    for (const account of [creatorAccount, challengerAccount, strangerAccount, bondChallengerAccount]) {
      await fund(account.address);
    }

    const creator = new RegistryClient({
      publicClient,
      walletClient: walletFor(creatorAccount),
      addresses,
    });

    const registry = registryAbi();
    const policy = policyAbi();
    const receiver = receiverAbi();

    const read = async (address: Hex, abi: Abi, functionName: string, args: unknown[] = []): Promise<unknown> =>
      await publicClient.readContract({ address, abi, functionName, args });


    /**
     * Which custom error a mined transaction reverted with.
     *
     * The transaction's own bytes are replayed against the state of the block before it, so the
     * name comes from the contract running that exact call and not from a guess about it.
     */
    const revertNameOf = async (hash: Hex, minedIn: bigint): Promise<string> => {
      const tx = await publicClient.getTransaction({ hash });
      try {
        await publicClient.call({
          account: tx.from,
          to: tx.to ?? undefined,
          data: tx.input,
          value: tx.value,
          blockNumber: minedIn - 1n,
        });
        return "no revert data";
      } catch (error) {
        return creator.decodeError(error);
      }
    };

    /**
     * Sends a call that is supposed to be refused, and reports what refused it.
     *
     * The call is sent with a gas limit rather than an estimate, so the refusal comes from the
     * contract running on the fork and never from a simulation this script did instead of it.
     */
    const mustRefuse = async (
      expected: string,
      send: () => Promise<Hex>,
    ): Promise<{ refused: boolean; name: string }> => {
      try {
        const hash = await send();
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status === "success") {
          return { refused: false, name: `it went through in ${hash}` };
        }
        const name = await revertNameOf(hash, receipt.blockNumber);
        return { refused: name === expected, name: `${name}, reverted on chain in ${hash}` };
      } catch (error) {
        const name = creator.decodeError(error);
        return { refused: name === expected, name };
      }
    };

    const registerWith = async (input: PassportInput, passkey: SoftwarePasskey) =>
      await creator.register(input, passkey.sign(passportDigest(input, creator.domain)), "0x");

    const head = async (): Promise<bigint> => (await publicClient.getBlock({ blockTag: "latest" })).timestamp;

    const passportBase = async (overrides: Partial<PassportInput>): Promise<PassportInput> => ({
      exactHash: ID.substitution,
      parentId: ZERO_BYTES32,
      creator: creatorAccount.address,
      generatorAgentId: 0n,
      phash: 0x336b806a7e894e76n,
      blockhash256: `0x${"0f".repeat(32)}`,
      manifestHash: ZERO_BYTES32,
      kind: Kind.Captured,
      fingerprintVersion: 1,
      metadataURI: "ipfs://bafkreiggnfemzyzzrs6ba2ycklbfghbmpwd6mmzcy3rxhh4ovfxkfvvzsm",
      deadline: (await head()) + 3600n,
      ...overrides,
    });

    say("Moolam attack pass 2, executed against a local fork of Monad mainnet.");
    say("Every write below goes to the fork. Nothing here can reach mainnet.");
    say();
    say(`date        ${startedAt.toISOString()}`);
    say(`fork block  ${forkBlock.toLocaleString("en-US")} of Monad mainnet, chain ${addresses.chainId}`);
    say(`commit      ${commitHash()}`);
    say(`registry    ${addresses.registry} (deployed, forked)`);
    say(`policy      ${addresses.policy} (deployed, forked)`);
    say(`receiver    ${addresses.receiver} (deployed, forked, retired at block 108,102,728)`);
    say(`creator     ${creatorAccount.address} (a fresh key, funded on the fork)`);
    say(`challenger  ${challengerAccount.address}`);
    say(`stranger    ${strangerAccount.address}`);
    say(`bond payer  ${bondChallengerAccount.address}`);
    say("            These four are fresh keys on purpose. Anvil's published ten all carry an");
    say("            EIP-7702 delegation on Monad mainnet, and the delegate sweeps anything paid");
    say("            to them, which would quietly swallow the bond in attack 8.");
    say();

    const passkey = SoftwarePasskey.random();
    await creator.bindPasskey(passkey);
    say(`The creator's passkey is bound on the forked registry: qx ${passkey.qx}`);
    say();

    // 1b. Digest substitution, the contract's half.
    say("1b. Digest substitution: an assertion over passport P, relayed as a registration of P'");
    say("    ------------------------------------------------------------------------------------");
    const mine = await passportBase({});
    const theirs: PassportInput = {
      ...mine,
      exactHash: ID.attackerCopy,
      metadataURI: "ipfs://bafkreiattackerscopy",
    };
    const honestAuth = passkey.sign(passportDigest(mine, creator.domain));

    const substitution = await mustRefuse(
      "InvalidPasskeySignature",
      async () =>
        await walletFor(creatorAccount).writeContract({
          address: addresses.registry,
          abi: registry,
          functionName: "register",
          args: [theirs, honestAuth, "0x"],
          chain,
          account: creatorAccount,
          gas: CALL_GAS,
        }),
    );
    const mineResult = await creator.register(mine, honestAuth, "0x");

    say(`    signed digest      ${passportDigest(mine, creator.domain)} (passport P)`);
    say(`    relayed digest     ${passportDigest(theirs, creator.domain)} (passport P', same creator)`);
    say(`    P' refused with    ${substitution.name}`);
    say(`    the same assertion registered P in ${mineResult.hash}, so the signature was genuine`);
    say("    The contract binds the digest to the struct it was handed. It cannot see that an RPC");
    say("    lied about which struct that was: the browser check in lib/chain/digest.ts is the");
    say("    defence against the RPC, and it is proved in packages/web/test/attacks.");
    lines.push({
      n: "1b",
      what: "digest substitution, relayed to the registry",
      verdict: verdict(substitution),
      notCovered: "whether the RPC lied about the digest, which only the browser can see",
    });
    say();

    // 2b. A deadline the chain has already passed.
    say("2b. Stale deadline: a signature stamped from a clock that runs 61 minutes slow");
    say("    ------------------------------------------------------------------------------------");
    const now = await head();
    const stale = await passportBase({ exactHash: ID.stale, deadline: now - 3660n + 1800n });
    const staleAuth = passkey.sign(passportDigest(stale, creator.domain));

    const expired = await mustRefuse(
      "SignatureExpired",
      async () =>
        await walletFor(creatorAccount).writeContract({
          address: addresses.registry,
          abi: registry,
          functionName: "register",
          args: [stale, staleAuth, "0x"],
          chain,
          account: creatorAccount,
          gas: CALL_GAS,
        }),
    );

    say(`    chain time         ${now}`);
    say(`    deadline signed    ${stale.deadline}, which is ${now - stale.deadline} seconds in the past`);
    say(`    refused with       ${expired.name}`);
    lines.push({
      n: "2b",
      what: "stale deadline, sent to the registry",
      verdict: verdict(expired),
      notCovered: "a clock that is fast rather than slow, which signs a window the chain has not opened",
    });
    say();

    // 5. The same signed report, delivered twice.
    say("5. Replayed re-check: one signed report delivered twice, then to a second receiver");
    say("    ------------------------------------------------------------------------------------");
    const policyOwner = (await read(addresses.policy, policy, "owner")) as Hex;
    const asPolicyOwner = await impersonate(policyOwner);

    /** Lists a receiver the way the owner would on mainnet: queued, 24 hours waited, executed. */
    const listThroughPolicy = async (who: Hex): Promise<{ queueHash: Hex; executeHash: Hex }> => {
      const queueHash = await asPolicyOwner.writeContract({
        address: addresses.policy,
        abi: policy,
        functionName: "queueAddReceiver",
        args: [who],
        chain,
        account: policyOwner,
        gas: CALL_GAS,
      });
      const queued = await publicClient.waitForTransactionReceipt({ hash: queueHash });

      // The change id comes from the policy's own ChangeQueued event rather than being rebuilt
      // here, so the id executed below is the one the contract actually wrote.
      const [queuedLog] = parseEventLogs({ abi: policy, eventName: "ChangeQueued", logs: queued.logs });
      const changeId = (queuedLog as unknown as { args: { id: Hex } }).args.id;

      await rpc("evm_increaseTime", [24 * 60 * 60]);
      await rpc("evm_mine", []);

      const executeHash = await asPolicyOwner.writeContract({
        address: addresses.policy,
        abi: policy,
        functionName: "execute",
        args: [changeId],
        chain,
        account: policyOwner,
        gas: CALL_GAS,
      });
      await publicClient.waitForTransactionReceipt({ hash: executeHash });
      return { queueHash, executeHash };
    };

    if (!((await read(addresses.policy, policy, "isReceiver", [addresses.receiver])) as boolean)) {
      const relisted = await listThroughPolicy(addresses.receiver);
      say(`    relisted on fork   ${addresses.receiver}, queued in ${relisted.queueHash}, executed in ${relisted.executeHash}`);
      say("                       It is off the policy on mainnet since block 108,102,728. Listing it");
      say("                       again on the fork only lets the attack below reach its replay floor.");
    }

    const replay = await passportBase({ exactHash: ID.replay });
    await registerWith(replay, passkey);

    const forwarder = (await read(addresses.receiver, receiver, "getForwarderAddress")) as Hex;
    const expectedAuthor = (await read(addresses.receiver, receiver, "getExpectedAuthor")) as Hex;
    const expectedName = (await read(addresses.receiver, receiver, "getExpectedWorkflowName")) as Hex;
    const expectedId = (await read(addresses.receiver, receiver, "getExpectedWorkflowId")) as Hex;
    const metadata = encodeMetadata(expectedId, expectedName, expectedAuthor);

    const executedAt = (await head()) + 1n;
    const report = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint64" }, { type: "bytes32" }, { type: "bool" }, { type: "uint16" }, { type: "bytes32" }],
      [BigInt(addresses.chainId), executedAt, ID.replay, true, 0, replay.blockhash256],
    );

    const asForwarder = await impersonate(forwarder);
    const firstDelivery = await asForwarder.writeContract({
      address: addresses.receiver,
      abi: receiver,
      functionName: "onReport",
      args: [metadata, report],
      chain,
      account: forwarder,
      gas: CALL_GAS,
    });
    await publicClient.waitForTransactionReceipt({ hash: firstDelivery });
    const afterFirst = (await read(addresses.registry, registry, "attestationCount", [ID.replay])) as bigint;

    const replayed = await mustRefuse(
      "StaleReport",
      async () =>
        await asForwarder.writeContract({
          address: addresses.receiver,
          abi: receiver,
          functionName: "onReport",
          args: [metadata, report],
          chain,
          account: forwarder,
          gas: CALL_GAS,
        }),
    );

    say(`    forwarder          ${forwarder} (the real Chainlink one, impersonated on the fork)`);
    say(`    report executedAt  ${executedAt} for passport ${ID.replay}`);
    say(`    first delivery     landed in ${firstDelivery}, attestation count ${afterFirst}`);
    say(`    second delivery    ${replayed.name}`);
    lines.push({
      n: "5a",
      what: "report replayed to the same receiver",
      verdict: verdict(replayed),
      notCovered: "the Chainlink forwarder's own signature checks, which happen before this contract is called",
    });

    const fresh = loadArtifact("MoolamReceiver");
    const deployHash = await asPolicyOwner.deployContract({
      abi: fresh.abi,
      bytecode: fresh.bytecode,
      args: [forwarder, addresses.registry],
      chain,
      account: policyOwner,
    });
    const freshAddress = (await publicClient.waitForTransactionReceipt({ hash: deployHash })).contractAddress as Hex;

    const { queueHash, executeHash } = await listThroughPolicy(freshAddress);

    const secondDelivery = await asForwarder.writeContract({
      address: freshAddress,
      abi: receiver,
      functionName: "onReport",
      args: [metadata, report],
      chain,
      account: forwarder,
      gas: CALL_GAS,
    });
    await publicClient.waitForTransactionReceipt({ hash: secondDelivery });
    const afterSecond = (await read(addresses.registry, registry, "attestationCount", [ID.replay])) as bigint;

    say(`    a fresh receiver   ${freshAddress}, deployed on the fork and listed through the policy`);
    say(`    the 24 hour queue  queued in ${queueHash}, executed in ${executeHash} after the warp`);
    say(`    same report again  landed in ${secondDelivery}, attestation count ${afterFirst} to ${afterSecond}`);
    say("    This is the known gap: the replay floor lives in each receiver's own storage and starts");
    say("    at zero, so a report one receiver has used still lands on a receiver deployed later.");
    say("    Listing one takes the policy's 24 hour queue in the open, which is the control today.");
    say("    The remedy is receiver v2: an executedAt floor set at deploy time, which makes every");
    say("    report older than the deployment stale on arrival.");
    lines.push({
      n: "5b",
      what: "same report to a newly listed receiver",
      verdict: "LANDED AS EXPECTED, remedy: receiver v2 with a deploy-time executedAt floor",
      notCovered: "how a second receiver gets listed at all, which is the policy's 24 hour queue in the open",
    });
    say();

    // 6. An edit of a picture that was proven fake.
    say("6. Edit of a disputed parent: the child reads clean on chain");
    say("    ------------------------------------------------------------------------------------");
    const parent = await passportBase({ exactHash: ID.parent });
    await registerWith(parent, passkey);

    const bond = (await read(addresses.policy, policy, "disputeBond")) as bigint;
    const resolverAddress = (await read(addresses.policy, policy, "resolver")) as Hex;
    const asResolver = await impersonate(resolverAddress);

    const flagHash = await walletFor(challengerAccount).writeContract({
      address: addresses.registry,
      abi: registry,
      functionName: "flag",
      args: [ID.parent, "ipfs://moolam-attack-pass-2/evidence"],
      value: bond,
      chain,
      account: challengerAccount,
      gas: CALL_GAS,
    });
    await publicClient.waitForTransactionReceipt({ hash: flagHash });

    const upheldHash = await asResolver.writeContract({
      address: addresses.registry,
      abi: registry,
      functionName: "resolve",
      args: [ID.parent, true],
      chain,
      account: resolverAddress,
      gas: CALL_GAS,
    });
    await publicClient.waitForTransactionReceipt({ hash: upheldHash });

    const child = await passportBase({
      exactHash: ID.child,
      parentId: ID.parent,
      kind: Kind.Edited,
      metadataURI: "ipfs://bafkreitheeditofthedisputedpicture",
    });
    const editResult = await creator.appendEdit(child, "0x");

    const parentRow = await creator.getPassport(ID.parent);
    const childRow = await creator.getPassport(ID.child);

    say(`    parent             ${ID.parent}`);
    say(`    flagged            ${flagHash}, bond ${formatEther(bond)} MON`);
    say(`    upheld             ${upheldHash}, parent disputed ${parentRow.disputed}`);
    say(`    child              ${ID.child}, appended in ${editResult.hash}`);
    say(`    child disputed     ${childRow.disputed}, parent of the child ${childRow.parentId}`);
    say("    The registry marks only the passport a challenge named, so the edit reads clean here.");
    say("    The web walks the parent links the index already stores and shows the child as");
    say("    disputed, which is executed in packages/web/test/attacks/disputed-parent.test.ts on");
    say("    exactly these two ids. The index-side field inheritedDisputed will answer it in one");
    say("    column with no walk at all, once the hosted index redeploys with it.");
    lines.push({
      n: "6",
      what: "edit of a disputed parent, read on chain",
      verdict: "LANDED AS EXPECTED, remedy: the index's inheritedDisputed field, walked in the web today",
      notCovered: "the walk itself, which is executed in packages/web/test/attacks/disputed-parent.test.ts",
    });
    say();

    // 8. What can and cannot be done to a bond.
    say("8. Bond safety: a stranger settling, an owner sweeping, and the challenger's money");
    say("    ------------------------------------------------------------------------------------");
    const disputed = await passportBase({ exactHash: ID.bond });
    await registerWith(disputed, passkey);

    const bondFlag = await walletFor(bondChallengerAccount).writeContract({
      address: addresses.registry,
      abi: registry,
      functionName: "flag",
      args: [ID.bond, "ipfs://moolam-attack-pass-2/bond-evidence"],
      value: bond,
      chain,
      account: bondChallengerAccount,
      gas: CALL_GAS,
    });
    await publicClient.waitForTransactionReceipt({ hash: bondFlag });

    const strangerResolve = await mustRefuse(
      "NotResolver",
      async () =>
        await walletFor(strangerAccount).writeContract({
          address: addresses.registry,
          abi: registry,
          functionName: "resolve",
          args: [ID.bond, false],
          chain,
          account: strangerAccount,
          gas: CALL_GAS,
        }),
    );

    const registryOwner = (await read(addresses.registry, registry, "owner")) as Hex;
    const asRegistryOwner = await impersonate(registryOwner);
    const heldBefore = await publicClient.getBalance({ address: addresses.registry });
    const bondsBefore = (await read(addresses.registry, registry, "totalBonds")) as bigint;
    const owedBefore = (await read(addresses.registry, registry, "totalOwed")) as bigint;

    const sweep = await mustRefuse(
      "NothingToRescue",
      async () =>
        await asRegistryOwner.writeContract({
          address: addresses.registry,
          abi: registry,
          functionName: "rescueNative",
          args: [registryOwner],
          chain,
          account: registryOwner,
          gas: CALL_GAS,
        }),
    );

    const settle = await asResolver.writeContract({
      address: addresses.registry,
      abi: registry,
      functionName: "resolve",
      args: [ID.bond, true],
      chain,
      account: resolverAddress,
      gas: CALL_GAS,
    });
    await publicClient.waitForTransactionReceipt({ hash: settle });

    const credit = (await read(addresses.registry, registry, "withdrawable", [bondChallengerAccount.address])) as bigint;
    const walletBefore = await publicClient.getBalance({ address: bondChallengerAccount.address });
    const withdrawHash = await walletFor(bondChallengerAccount).writeContract({
      address: addresses.registry,
      abi: registry,
      functionName: "withdraw",
      args: [],
      chain,
      account: bondChallengerAccount,
      gas: CALL_GAS,
    });
    const withdrawReceipt = await publicClient.waitForTransactionReceipt({ hash: withdrawHash });
    const walletAfter = await publicClient.getBalance({ address: bondChallengerAccount.address });

    // What the withdraw cost is read off the wallet rather than worked out from gasUsed: this
    // fork charges the gas limit, the way Monad does, so gasUsed alone would understate it.
    const gained = walletAfter - walletBefore;
    const charged = bond - gained;
    const ceiling = CALL_GAS * withdrawReceipt.effectiveGasPrice;
    const paidBack = credit === bond && gained > 0n && charged <= ceiling;
    say(`    bond the policy asks for  ${formatEther(bond)} MON, posted in ${bondFlag}`);
    say(`    stranger calls resolve    ${strangerResolve.name}`);
    say(`    registry balance          ${formatEther(heldBefore)} MON, of which bonds ${formatEther(bondsBefore)} and owed ${formatEther(owedBefore)}`);
    say(`    owner calls rescueNative  ${sweep.name}, so nothing of the bond moved`);
    say(`    resolver upholds          ${settle}`);
    say(`    challenger credit         ${formatEther(credit)} MON, equal to the bond: ${credit === bond}`);
    say(`    challenger withdraws      ${withdrawHash}`);
    say(`    challenger balance        ${formatEther(walletBefore)} to ${formatEther(walletAfter)} MON`);
    say(`    the bond, less the fee    gained ${formatEther(gained)} MON, the network took ${formatEther(charged)}`);
    say(`                              gas used ${withdrawReceipt.gasUsed} of the ${CALL_GAS} limit this fork charges for, at ${withdrawReceipt.effectiveGasPrice} wei`);
    lines.push({
      n: "8a",
      what: "a stranger settling a dispute",
      verdict: verdict(strangerResolve),
      notCovered: "the resolver's own judgement, which is a person and not a contract",
    });
    lines.push({
      n: "8b",
      what: "the owner sweeping a held bond",
      verdict: verdict(sweep),
      notCovered: "a surplus sent to the registry by mistake, which rescueNative is there to move",
    });
    lines.push({
      n: "8c",
      what: "the challenger's bond after an upheld resolve",
      verdict: paidBack ? "PAID BACK, the bond less the network fee" : "NOT PAID BACK",
      notCovered: "a challenger contract that refuses native token, which withdrawTo is the way out of",
    });
    say();

    say("Summary of what this script executed on the fork");
    say("================================================");
    for (const line of lines) {
      say(`  ${line.n.padEnd(3)} ${line.what.padEnd(46)} ${line.verdict}`);
      say(`      ${" ".repeat(46)} not covered: ${line.notCovered}`);
    }
    say();
    say("The browser half of this pass, executed separately by npx vitest run test/attacks in");
    say("packages/web, and printed under this output:");
    say("  1a digest substitution refused before the passkey prompt");
    say("     not covered: the registry's half, which is attack 1b above");
    say("  2a a deadline measured from the chain's head block, not from a slow laptop");
    say("     not covered: the registry's half, which is attack 2b above");
    say("  3  a second send while the first is unconfirmed");
    say("     not covered: the rendered React screens, only the reducers they read");
    say("  4  an assertion made for evil.example, by relying party and by origin");
    say("     not covered: the registry, which cannot see either field");
    say("  6  the web's lineage walk over the two ids above");
    say("     not covered: the hosted index's own inheritedDisputed column, which is not deployed yet");
    say("  7  the same fallback bytes posted twice to the verify service");
    say("     not covered: the signed path, where a fresh manifest gives one picture two ids");
    say();
    say(`finished ${new Date().toISOString()}, fork block ${forkBlock.toLocaleString("en-US")}`);
  } finally {
    await fork.stop();
  }
}

function verdict(outcome: { refused: boolean; name: string }): string {
  return outcome.refused ? `REFUSED, ${outcome.name}` : `NOT REFUSED, ${outcome.name}`;
}

/**
 * The 64 byte slice the production forwarder hands a receiver: 32 bytes of workflow id, 10 of
 * workflow name, the 20 byte workflow owner, then a 2 byte report id.
 */
function encodeMetadata(workflowId: Hex, workflowName: Hex, author: Hex): Hex {
  const id = workflowId === ZERO_BYTES32 ? `0x${"00".repeat(31)}01` : workflowId;
  const name = workflowName === ZERO_BYTES10 ? ZERO_BYTES10 : workflowName;
  return `0x${id.slice(2)}${name.slice(2)}${author.slice(2)}0000` as Hex;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
