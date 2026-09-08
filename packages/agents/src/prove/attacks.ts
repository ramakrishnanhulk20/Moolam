import { encodeAbiParameters, encodeFunctionData, parseEther, sha256, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { policyAbi, receiverAbi } from "../chain/artifacts.js";
import { Kind, PASSPORT_TYPES, passportDigest, type PassportInput } from "../chain/eip712.js";
import { isPolicyViolation, ownerContext, privyErrorText } from "../privy/client.js";
import { readStore, sendFromWallet } from "../privy/serverWallet.js";
import {
  appendEditAsSessionSigner,
  currentSigners,
  revokeSessionSigners,
} from "../privy/sessionSigner.js";
import {
  refuseOnChain,
  type ChainRefusal,
  type Original,
  type ProveContext,
  type Signer,
} from "./steps.js";

/**
 * One attack, executed. `refused` is true only when the attack failed for the reason the design
 * says it should fail for, never merely because something went wrong. `evidence` is the full
 * record of the attempt, and its first line is the one line the summary table shows.
 */
export interface AttackResult {
  name: string;
  refused: boolean;
  evidence: string;
}

export interface AttackContext {
  ctx: ProveContext;
  original: Original;
  /** A wallet with no role in Moolam at all: not the creator, not a receiver, not the resolver. */
  outsider: Signer;
  baseUrl: string;
}

/** Enough headroom that a revert is never an out-of-gas, and tight enough that Monad's
 *  charge-the-limit pricing keeps a refused call cheap. */
const REGISTER_GAS = 400_000n;
const SMALL_CALL_GAS = 150_000n;

/** The limit set on calls Privy is expected to refuse. They never reach a node to be estimated. */
const REFUSED_CALL_GAS = 400_000n;

const FINGERPRINT_VERSION = 1;
const DEADLINE_WINDOW = 3600n;

function result(name: string, refused: boolean, summary: string, lines: string[]): AttackResult {
  return { name, refused, evidence: [summary, ...lines].join("\n") };
}

/** A passport id nothing has ever used, derived from a label so the run is readable. */
function freshId(label: string): Hex {
  return sha256(new TextEncoder().encode(`moolam-attack:${label}:${Date.now()}`));
}

/**
 * A passport that is the registered one with one field changed. Everything else, including the
 * metadata document, is the real record, so the only thing an attack changes is the thing it is
 * testing.
 */
function variantOf(original: Original, changes: Partial<PassportInput>): PassportInput {
  return { ...original.input, ...changes };
}

/**
 * Attack a. The creator's passkey assertion from a real passport, replayed on a second passport
 * with a different image hash.
 *
 * This is the whole point of signing the digest rather than a nonce: the digest covers every
 * field, so an assertion that was valid for one record is meaningless on another.
 */
export async function passkeyReplay(a: AttackContext): Promise<AttackResult> {
  const input = variantOf(a.original, { exactHash: freshId("passkey-replay") });
  const refusal = await refuseOnChain(a.ctx, {
    what: "replay the creator's passkey assertion on a changed record",
    from: a.ctx.deployer,
    address: a.ctx.addresses.registry,
    abi: a.ctx.registryAbi,
    functionName: "register",
    args: [input, a.original.creatorAuth, a.original.generatorSig],
    gas: REGISTER_GAS,
    expected: "InvalidPasskeySignature",
  });

  return result(
    "passkey-replay",
    refusal.refused,
    summarise("the creator's own assertion, replayed on a different image hash", refusal),
    [
      "",
      `original passport   ${a.original.passportId}`,
      `replayed onto       ${input.exactHash}`,
      "the assertion and the agent signature are byte for byte the ones that registered the",
      "original passport. Only exactHash changed, and the digest they signed changed with it.",
      "",
      ...refusal.lines,
    ],
  );
}

/**
 * Attack b. A generator signature from a wallet that does not own the ERC-8004 agent.
 *
 * The creator's passkey signs correctly here, so the only thing left to refuse the write is the
 * ownership read on the ERC-8004 Identity Registry.
 */
export async function forgedGeneratorSignature(a: AttackContext): Promise<AttackResult> {
  const stranger = privateKeyToAccount(generatePrivateKey());
  const input = variantOf(a.original, { exactHash: freshId("forged-generator") });
  const digest = passportDigest(input, a.ctx.registry.domain);
  const forged = await stranger.signTypedData({
    domain: a.ctx.registry.domain,
    types: PASSPORT_TYPES,
    primaryType: "Passport",
    message: input,
  });

  const refusal = await refuseOnChain(a.ctx, {
    what: "sign as the generator agent from a wallet that does not own it",
    from: a.ctx.deployer,
    address: a.ctx.addresses.registry,
    abi: a.ctx.registryAbi,
    functionName: "register",
    args: [input, a.original.creatorPasskey.sign(digest), forged],
    gas: REGISTER_GAS,
    expected: "InvalidGeneratorSignature",
  });

  return result(
    "generator-signature-forged",
    refusal.refused,
    summarise("a stranger's wallet signing for someone else's agent", refusal),
    [
      "",
      `agent               ${a.original.agentId} on ${a.ctx.addresses.agentIdentity}`,
      `signed by           ${stranger.address}, a key generated for this attack and thrown away`,
      "the creator's passkey signature over this record is valid, so the only thing refusing the",
      "write is ownerOf on the ERC-8004 registry not matching the recovered signer.",
      "",
      ...refusal.lines,
    ],
  );
}

/**
 * Attack c. A passport that names an agent id nobody registered.
 *
 * The ERC-8004 registry reverts on an unknown id, and the Moolam registry turns that into its own
 * error rather than letting another contract's revert bubble up unexplained.
 */
export async function unknownAgent(a: AttackContext): Promise<AttackResult> {
  const agentId = 10_000_000_000n;
  const input = variantOf(a.original, {
    exactHash: freshId("unknown-agent"),
    generatorAgentId: agentId,
  });
  const digest = passportDigest(input, a.ctx.registry.domain);

  const refusal = await refuseOnChain(a.ctx, {
    what: "claim an agent id that was never registered",
    from: a.ctx.deployer,
    address: a.ctx.addresses.registry,
    abi: a.ctx.registryAbi,
    functionName: "register",
    args: [input, a.original.creatorPasskey.sign(digest), a.original.generatorSig],
    gas: REGISTER_GAS,
    expected: "UnknownAgent",
  });

  return result(
    "unknown-agent",
    refusal.refused,
    summarise(`agent ${agentId} does not exist on the ERC-8004 registry`, refusal),
    [
      "",
      `identity registry   ${a.ctx.addresses.agentIdentity}`,
      `claimed agent       ${agentId}`,
      "the creator's passkey signature is valid over this record, so the refusal is entirely the",
      "ownerOf read on the live ERC-8004 registry failing.",
      "",
      ...refusal.lines,
    ],
  );
}

/**
 * Attack d. Both signatures valid, but past their deadline.
 *
 * A signature that never goes stale is a signature that can be picked up years later and used.
 */
export async function expiredDeadline(a: AttackContext): Promise<AttackResult> {
  const now = (await a.ctx.publicClient.getBlock()).timestamp;
  const deadline = now - 60n;
  const input = variantOf(a.original, { exactHash: freshId("expired-deadline"), deadline });
  const digest = passportDigest(input, a.ctx.registry.domain);
  const generatorSig = await a.ctx.registry.signAsGenerator(input);

  const refusal = await refuseOnChain(a.ctx, {
    what: "use signatures that are past their deadline",
    from: a.ctx.deployer,
    address: a.ctx.addresses.registry,
    abi: a.ctx.registryAbi,
    functionName: "register",
    args: [input, a.original.creatorPasskey.sign(digest), generatorSig],
    gas: REGISTER_GAS,
    expected: "SignatureExpired",
  });

  return result(
    "expired-deadline",
    refusal.refused,
    summarise("both signatures are valid, and both are a minute too late", refusal),
    [
      "",
      `chain time          ${now}`,
      `deadline signed     ${deadline}`,
      "the passkey assertion and the agent signature are freshly made and correct for this record.",
      "The deadline is the only thing wrong with it.",
      "",
      ...refusal.lines,
    ],
  );
}

/**
 * Attack e. An edit appended to a passport the caller does not hold.
 *
 * Holding the parent token, or being approved for it, is the only authority appendEdit accepts,
 * which is what lets an editing session write ten edits without ten passkey prompts.
 */
export async function editByStranger(a: AttackContext): Promise<AttackResult> {
  const input: PassportInput = {
    exactHash: freshId("edit-by-stranger"),
    parentId: a.original.passportId,
    creator: a.outsider.account.address,
    generatorAgentId: 0n,
    phash: a.original.input.phash,
    blockhash256: a.original.input.blockhash256,
    manifestHash: a.original.input.manifestHash,
    kind: Kind.Edited,
    fingerprintVersion: FINGERPRINT_VERSION,
    metadataURI: a.original.metadataUri,
    deadline: (await a.ctx.publicClient.getBlock()).timestamp + DEADLINE_WINDOW,
  };

  const refusal = await refuseOnChain(a.ctx, {
    what: "append an edit to a passport somebody else holds",
    from: a.outsider,
    address: a.ctx.addresses.registry,
    abi: a.ctx.registryAbi,
    functionName: "appendEdit",
    args: [input, "0x"],
    gas: SMALL_CALL_GAS,
    expected: "NotParentOwner",
  });

  return result(
    "edit-by-non-owner",
    refusal.refused,
    summarise("an outsider tries to hang an edit off someone else's passport", refusal),
    [
      "",
      `parent passport     ${a.original.passportId}`,
      `held by             ${a.original.input.creator}`,
      `caller              ${a.outsider.account.address}, not approved for that token`,
      "",
      ...refusal.lines,
    ],
  );
}

/**
 * Attack f. A verification result written straight into the registry by a wallet the policy does
 * not list.
 */
export async function attestFromStranger(a: AttackContext): Promise<AttackResult> {
  const refusal = await refuseOnChain(a.ctx, {
    what: "write a verification result without being a listed receiver",
    from: a.outsider,
    address: a.ctx.addresses.registry,
    abi: a.ctx.registryAbi,
    functionName: "attest",
    args: [a.original.passportId, true, 0, a.original.input.blockhash256],
    gas: SMALL_CALL_GAS,
    expected: "NotReceiver",
  });

  return result(
    "attest-from-stranger",
    refusal.refused,
    summarise("a stranger claims the image checked out", refusal),
    [
      "",
      `policy              ${a.ctx.addresses.policy}`,
      `listed receiver     ${a.ctx.addresses.receiver}`,
      `caller              ${a.outsider.account.address}`,
      "the policy is the only list the registry reads, and adding to it waits 24 hours in the open.",
      "",
      ...refusal.lines,
    ],
  );
}

/**
 * Attack g. A Chainlink report delivered to the receiver by something that is not the Chainlink
 * forwarder.
 *
 * The check is Chainlink's own, in the ReceiverTemplate that is vendored word for word.
 */
export async function reportFromFakeForwarder(a: AttackContext): Promise<AttackResult> {
  const report = encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "uint64" },
      { type: "bytes32" },
      { type: "bool" },
      { type: "uint16" },
      { type: "bytes32" },
    ],
    [
      BigInt(a.ctx.addresses.chainId),
      BigInt(Math.floor(Date.now() / 1000)),
      a.original.passportId,
      true,
      0,
      a.original.input.blockhash256,
    ],
  );

  const refusal = await refuseOnChain(a.ctx, {
    what: "deliver a verification report without being the Chainlink forwarder",
    from: a.outsider,
    address: a.ctx.addresses.receiver,
    abi: receiverAbi(),
    functionName: "onReport",
    args: ["0x", report],
    gas: SMALL_CALL_GAS,
    expected: "InvalidSender",
  });

  return result(
    "report-from-fake-forwarder",
    refusal.refused,
    summarise("a hand written report from the wrong sender", refusal),
    [
      "",
      `receiver            ${a.ctx.addresses.receiver}`,
      `caller              ${a.outsider.account.address}`,
      "the report itself is well formed: the right chain id, a current timestamp and a real",
      "passport id. Only the sender is wrong, and that is enough.",
      "",
      ...refusal.lines,
    ],
  );
}

/**
 * Attack h. A report replayed, and a report built for another chain.
 *
 * Both checks live inside _processReport, which is only reachable through the Chainlink
 * forwarder, and on mainnet that address belongs to Chainlink. So this one is proved by the
 * Foundry tests that stand in the forwarder's shoes, not by a transaction, and the run says so
 * rather than dressing something else up as the same thing.
 */
export async function receiverReplayAndWrongChain(a: AttackContext): Promise<AttackResult> {
  const forwarder = (await a.ctx.publicClient.readContract({
    address: a.ctx.addresses.receiver,
    abi: receiverAbi(),
    functionName: "getForwarderAddress",
  })) as Hex;
  const lastSeen = (await a.ctx.publicClient.readContract({
    address: a.ctx.addresses.receiver,
    abi: receiverAbi(),
    functionName: "lastExecutedAt",
    args: [a.original.passportId],
  })) as bigint;

  const named = [
    "test_theSameReportSentTwiceIsRefused          StaleReport",
    "test_anOlderReportAfterANewerOneIsRefused     StaleReport",
    "test_aReportBuiltForAnotherChainIsRefused     WrongChain",
  ];

  return result(
    "receiver-replay-and-wrong-chain",
    true,
    "covered by three Foundry tests, not by a mainnet transaction: only Chainlink's forwarder can reach the check",
    [
      "",
      `receiver            ${a.ctx.addresses.receiver}`,
      `forwarder on chain  ${forwarder}`,
      `last report seen    ${lastSeen} for passport ${a.original.passportId}`,
      "",
      "onReport refuses anything that is not the forwarder before it decodes a byte, which is the",
      "attack in report-from-fake-forwarder.txt and it is executed live. The replay and wrong chain",
      "checks sit behind that door, inside _processReport, so reaching them on mainnet would mean",
      "sending from Chainlink's own forwarder address. Nobody can, and that is the point.",
      "",
      "packages/contracts/test/MoolamReceiver.t.sol, run with npm test in packages/contracts:",
      ...named.map((line) => `  ${line}`),
      "",
      "Each of those deploys the same receiver, pranks the forwarder address, delivers a report,",
      "and expects the named custom error on the second delivery, on the older one, and on the one",
      "built for chain 1.",
    ],
  );
}

/**
 * Attack i. The generator agent's own wallet asked to move money, and to call a function its
 * policy does not name.
 *
 * Privy's enclave holds the key. The refusal happens there, so nothing is signed and nothing
 * reaches Monad, which is different in kind from a transaction that reverts.
 */
export async function privyPolicyRefusals(a: AttackContext): Promise<AttackResult> {
  const generator = readStore().generator;
  if (!generator) {
    throw new Error(
      "No Privy generator wallet on this machine. Run npm run prove:privy once: it creates the wallet, its policy and its ERC-8004 identity.",
    );
  }
  const owner = ownerContext();

  const transfer = await expectRefusal(() =>
    sendFromWallet(generator.id, {
      to: a.ctx.deployerAddress,
      value: parseEther("0.1"),
      gasLimit: 21_000n,
      chainId: a.ctx.addresses.chainId,
      context: owner,
    }),
  );

  const editInput: PassportInput = {
    exactHash: freshId("privy-policy-edit"),
    parentId: a.original.passportId,
    creator: a.original.input.creator,
    generatorAgentId: 0n,
    phash: a.original.input.phash,
    blockhash256: a.original.input.blockhash256,
    manifestHash: a.original.input.manifestHash,
    kind: Kind.Edited,
    fingerprintVersion: FINGERPRINT_VERSION,
    metadataURI: a.original.metadataUri,
    deadline: (await a.ctx.publicClient.getBlock()).timestamp + DEADLINE_WINDOW,
  };
  const edit = await expectRefusal(() =>
    sendFromWallet(generator.id, {
      to: a.ctx.addresses.registry,
      data: encodeFunctionData({
        abi: a.ctx.registryAbi,
        functionName: "appendEdit",
        args: [editInput, "0x"],
      }),
      gasLimit: REFUSED_CALL_GAS,
      chainId: a.ctx.addresses.chainId,
      context: owner,
    }),
  );

  const refused = transfer.policyViolation && edit.policyViolation;
  return result(
    "privy-policy-refusal",
    refused,
    refused
      ? "policy_violation twice: the agent's wallet cannot move MON and cannot call appendEdit"
      : `NOT REFUSED: transfer said "${transfer.text}", edit said "${edit.text}"`,
    [
      "",
      `generator wallet    ${generator.address}`,
      `policy              ${generator.policyId ?? "none recorded"}`,
      `registry            ${a.ctx.addresses.registry}`,
      "",
      "1. send 0.1 MON to the deployer",
      `   ${transfer.text}`,
      `   policy violation: ${transfer.policyViolation ? "yes" : "no"}`,
      "2. call appendEdit on the Moolam registry",
      `   ${edit.text}`,
      `   policy violation: ${edit.policyViolation ? "yes" : "no"}`,
      "",
      "Same wallet, same contract in the second case, different function. The policy names register",
      "and typed data whose domain is that registry, and Privy denies everything no rule covers.",
      "Neither attempt produced a transaction hash, because neither was ever signed.",
    ],
  );
}

/**
 * Attack j. The app's session key, used after the creator took the permission back.
 *
 * The permission lives on Privy's side, not in our code, so revoking it stops the signature
 * before it exists rather than stopping the transaction after it is signed.
 */
export async function revokedSessionSigner(a: AttackContext): Promise<AttackResult> {
  const creator = readStore().creator;
  if (!creator) {
    throw new Error(
      "No Privy creator wallet on this machine. Run npm run prove:privy once: it creates the wallet and grants the session signer.",
    );
  }

  const before = await currentSigners(creator.id);
  const after = before.length === 0 ? before : await revokeSessionSigners(creator.id);

  const editInput: PassportInput = {
    exactHash: freshId("revoked-session"),
    parentId: a.original.passportId,
    creator: a.original.input.creator,
    generatorAgentId: 0n,
    phash: a.original.input.phash,
    blockhash256: a.original.input.blockhash256,
    manifestHash: a.original.input.manifestHash,
    kind: Kind.Edited,
    fingerprintVersion: FINGERPRINT_VERSION,
    metadataURI: a.original.metadataUri,
    deadline: (await a.ctx.publicClient.getBlock()).timestamp + DEADLINE_WINDOW,
  };

  const attempt = await expectRefusal(() =>
    appendEditAsSessionSigner(creator.id, {
      to: a.ctx.addresses.registry,
      data: encodeFunctionData({
        abi: a.ctx.registryAbi,
        functionName: "appendEdit",
        args: [editInput, "0x"],
      }),
      gasLimit: REFUSED_CALL_GAS,
      chainId: a.ctx.addresses.chainId,
    }),
  );

  const refused = attempt.failed && after.length === 0;
  return result(
    "revoked-session-signer",
    refused,
    refused
      ? "the app's key is no longer a signer on the creator's wallet, and Privy refuses it"
      : `NOT REFUSED: ${attempt.text}`,
    [
      "",
      `creator wallet      ${creator.address}`,
      `signers before      ${before.length === 0 ? "none" : before.join(", ")}`,
      `signers now         ${after.length === 0 ? "none" : after.join(", ")}`,
      "",
      "appendEdit attempted with the app's session key:",
      `  ${attempt.text}`,
      "",
      "The same key wrote a real edit while the permission stood, in step 6 of",
      "kitchen/reports/WO-4-output.txt. The creator keeps the wallet either way: what is granted",
      "and taken back is only the app's ability to sign on it.",
    ],
  );
}

/**
 * Attack k. The three ways someone would try to take money out of the registry: flag with the
 * wrong bond, settle a dispute without being the resolver, and withdraw with nothing owed.
 */
export async function disputeMoneyRules(a: AttackContext): Promise<AttackResult> {
  const bond = (await a.ctx.publicClient.readContract({
    address: a.ctx.addresses.policy,
    abi: policyAbi(),
    functionName: "disputeBond",
  })) as bigint;

  const wrongBond = await refuseOnChain(a.ctx, {
    what: "open a dispute without posting the bond",
    from: a.outsider,
    address: a.ctx.addresses.registry,
    abi: a.ctx.registryAbi,
    functionName: "flag",
    args: [a.original.passportId, "ipfs://moolam-prove-run/no-bond"],
    value: 0n,
    gas: SMALL_CALL_GAS,
    expected: "InvalidBond",
  });

  const notResolver = await refuseOnChain(a.ctx, {
    what: "settle a dispute without being the resolver",
    from: a.outsider,
    address: a.ctx.addresses.registry,
    abi: a.ctx.registryAbi,
    functionName: "resolve",
    args: [a.original.passportId, true],
    gas: SMALL_CALL_GAS,
    expected: "NotResolver",
  });

  const nothingOwed = await refuseOnChain(a.ctx, {
    what: "withdraw with nothing owed",
    from: a.outsider,
    address: a.ctx.addresses.registry,
    abi: a.ctx.registryAbi,
    functionName: "withdraw",
    args: [],
    gas: SMALL_CALL_GAS,
    expected: "NothingToWithdraw",
  });

  const refused = wrongBond.refused && notResolver.refused && nothingOwed.refused;
  return result(
    "dispute-money-rules",
    refused,
    refused
      ? "three refusals: InvalidBond, NotResolver, NothingToWithdraw"
      : `NOT REFUSED: ${[wrongBond, notResolver, nothingOwed].map((r) => r.errorName).join(", ")}`,
    [
      "",
      `caller              ${a.outsider.account.address}`,
      `bond the policy asks for  ${bond} wei`,
      "",
      "1. flag with no bond attached",
      ...wrongBond.lines.map((line) => `   ${line}`),
      "",
      "2. resolve, sent by someone who is not the resolver the policy names",
      ...notResolver.lines.map((line) => `   ${line}`),
      "",
      "3. withdraw, with no credit standing to this address",
      ...nothingOwed.lines.map((line) => `   ${line}`),
    ],
  );
}

interface ApiCheck {
  what: string;
  expected: number;
  got: number;
  body: string;
}

/**
 * Attack l. The four ways to abuse the verify API: an oversized upload, a file that is not an
 * image, a URL pointing back inside our own network, and a flood.
 *
 * The flood waits for the current rate limit window to close first, so the count starts from
 * nothing and the 61st request is genuinely the 61st.
 */
export async function verifierApiLimits(a: AttackContext): Promise<AttackResult> {
  const checks: ApiCheck[] = [];

  // The rate limit counts every request, including the ones the earlier sections made, so the
  // three checks below wait for a clean window rather than collecting somebody else's 429.
  await waitForCredit(a.baseUrl, 12);

  checks.push(
    await postUpload(a.baseUrl, "a 25 MB upload", 413, {
      bytes: Buffer.alloc(25 * 1024 * 1024),
      filename: "big.jpg",
      contentType: "image/jpeg",
    }),
  );

  // The same upload again, this time built by the browser FormData path, which writes the body in
  // exact 64 KB blocks. The cap still cuts the stream off at 20 MB, but the plugin only raises its
  // too-large error when it sees the truncation part way through a block, so the answer comes back
  // as the plain "not an image" 400 instead. Recorded here rather than hidden.
  const browserStyle = new FormData();
  browserStyle.append(
    "file",
    new File([new Uint8Array(25 * 1024 * 1024)], "big.jpg", { type: "image/jpeg" }),
  );
  const alignedResponse = await fetch(`${a.baseUrl}/verify`, { method: "POST", body: browserStyle });
  const aligned = { status: alignedResponse.status, body: (await alignedResponse.text()).slice(0, 200) };

  checks.push(
    await postUpload(a.baseUrl, "a text file dressed as an image", 400, {
      bytes: Buffer.from("this is not an image", "utf8"),
      filename: "notes.txt",
      contentType: "text/plain",
    }),
  );

  const loopback = await fetch(`${a.baseUrl}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "http://127.0.0.1:9/secret.jpg" }),
  });
  checks.push({
    what: "a URL pointing at 127.0.0.1",
    expected: 403,
    got: loopback.status,
    body: (await loopback.text()).slice(0, 200),
  });

  const flood = await floodUntilRefused(a.baseUrl);
  checks.push({
    what: `61 requests in one minute (first refusal at request ${flood.refusedAt})`,
    expected: 429,
    got: flood.lastStatus,
    body: flood.body.slice(0, 200),
  });

  const cleanCount = flood.refusedAt === 61;
  const refused = checks.every((check) => check.got === check.expected) && cleanCount;

  return result(
    "verifier-api-limits",
    refused,
    refused
      ? "413 on 25 MB, 400 on a text file, 403 on a loopback URL, 429 on the 61st request"
      : `NOT REFUSED: ${checks.map((c) => `${c.what} answered ${c.got}, wanted ${c.expected}`).join("; ")}`,
    [
      "",
      `service             ${a.baseUrl}`,
      "",
      ...checks.flatMap((check) => [
        `${check.got === check.expected ? "REFUSED" : "NOT REFUSED"}  ${check.what}`,
        `          expected HTTP ${check.expected}, got ${check.got}`,
        `          ${check.body}`,
      ]),
      "",
      `The flood waited ${flood.waitedSeconds} seconds for the rate limit window to close first, so`,
      "the count starts from nothing. Requests are counted on the socket address, so a caller",
      "cannot pick their own bucket by sending a header.",
      "",
      "The 25 MB upload is sent twice, because the way a client frames the body can change the",
      "answer. The first check above uses the framing curl and a browser use. The same 25 MB sent",
      `through Node's own FormData answered ${aligned.status}: ${aligned.body}`,
      "Node's FormData writes the body in exact 64 KB blocks, and this check has also seen that",
      "framing answered 400 with \"not an image\" rather than 413, because @fastify/multipart raises",
      "its too-large error from inside its read loop and does not see the truncation when the cap",
      "falls on a block boundary. Both answers are refusals, and either way the file stream is cut",
      "off at 20 MB, so nothing past the cap is ever buffered.",
    ],
  );
}

/**
 * Posts one file the way curl and a browser post it: a multipart body written as a single stream
 * rather than in the exact 64 KB blocks Node's own FormData uses.
 */
async function postUpload(
  baseUrl: string,
  what: string,
  expected: number,
  file: { bytes: Buffer; filename: string; contentType: string },
): Promise<ApiCheck> {
  const boundary = "----moolamprove";
  const crlf = "\r\n";
  const head = Buffer.from(
    `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="file"; filename="${file.filename}"${crlf}` +
      `Content-Type: ${file.contentType}${crlf}${crlf}`,
    "utf8",
  );
  const tail = Buffer.from(`${crlf}--${boundary}--${crlf}`, "utf8");

  const response = await fetch(`${baseUrl}/verify`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: new Uint8Array(Buffer.concat([head, file.bytes, tail])),
  });
  return { what, expected, got: response.status, body: (await response.text()).slice(0, 200) };
}

async function floodUntilRefused(baseUrl: string): Promise<{
  refusedAt: number;
  lastStatus: number;
  body: string;
  waitedSeconds: number;
}> {
  const waitedSeconds = await waitForCredit(baseUrl, 61);

  let lastStatus = 0;
  let body = "";
  for (let i = 1; i <= 61; i += 1) {
    const response = await fetch(`${baseUrl}/health`);
    lastStatus = response.status;
    body = await response.text();
    if (response.status === 429) {
      return { refusedAt: i, lastStatus, body, waitedSeconds };
    }
  }
  return { refusedAt: 0, lastStatus, body, waitedSeconds };
}

/**
 * Waits for the rate limit window to close when the service has fewer than `needed` requests left
 * in it, and answers with how many seconds that took.
 *
 * The service publishes what is left and when the window closes in its own headers, so this is
 * read from the service rather than guessed.
 */
async function waitForCredit(baseUrl: string, needed: number): Promise<number> {
  const probe = await fetch(`${baseUrl}/health`);
  await probe.text();
  const remaining = Number(probe.headers.get("x-ratelimit-remaining") ?? "0");
  const reset = Number(probe.headers.get("x-ratelimit-reset") ?? "60");
  if (Number.isFinite(remaining) && remaining >= needed) {
    return 0;
  }

  const seconds = (Number.isFinite(reset) ? reset : 60) + 2;
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  return seconds;
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

function summarise(what: string, refusal: ChainRefusal): string {
  if (refusal.refused) {
    return `${refusal.errorName}: ${what}${refusal.txHash ? `, on chain in ${refusal.txHash}` : ""}`;
  }
  if (refusal.wentThrough) {
    return `NOT REFUSED: ${what}. The call went through.`;
  }
  return `NOT REFUSED: ${what}. Refused with ${refusal.errorName}, expected ${refusal.expected}.`;
}
