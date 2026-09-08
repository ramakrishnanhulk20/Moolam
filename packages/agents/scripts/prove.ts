import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletClient, formatEther, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "viem/chains";
import { DEFAULT_DEPLOYMENT_FILE, MONAD_MAINNET } from "../src/chain/addresses.js";
import { SoftwarePasskey } from "../src/chain/passkey.js";
import { readStore } from "../src/privy/serverWallet.js";
import {
  attestFromStranger,
  disputeMoneyRules,
  editByStranger,
  expiredDeadline,
  forgedGeneratorSignature,
  passkeyReplay,
  privyPolicyRefusals,
  receiverReplayAndWrongChain,
  reportFromFakeForwarder,
  revokedSessionSigner,
  unknownAgent,
  verifierApiLimits,
  type AttackContext,
  type AttackResult,
} from "../src/prove/attacks.js";
import {
  checkStrip,
  checkSurvivors,
  copiesOf,
  EXPLORER_TX,
  proveContext,
  refuseOnChain,
  registerImpostor,
  registerOriginal,
  requiredKey,
  startVerifyService,
  verifyFile,
  writePassportIndex,
  type ProveContext,
  type Signer,
} from "../src/prove/steps.js";
import { heading, renderTable, verdict } from "../src/prove/table.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
const REPORT_FILE = join(REPO_ROOT, "kitchen", "reports", "WO-8-prove.txt");
const ATTACKS_DIR = join(REPO_ROOT, "docs", "docs", "security", "attacks");
const PASSPORTS_FILE = join(PACKAGE_ROOT, ".moolam", "prove-passports.json");
const CREATOR_PASSKEY_FILE = join(PACKAGE_ROOT, ".moolam", "creator-passkey.json");

const VERIFIER_PORT = Number(process.env.VERIFIER_PORT ?? "4010");
const REGISTER_GAS = 400_000n;

const lines: string[] = [];
const say = (line = ""): void => {
  console.log(line);
  lines.push(line);
};
const sayAll = (rows: string[]): void => {
  for (const row of rows) say(row);
};

interface Section {
  number: string;
  title: string;
  passed: boolean;
  evidence: string;
}

interface OriginCandidate {
  id: string;
  creator: Hex;
  registeredAt: bigint;
  phashDistance: number;
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const ctx = proveContext(say);
  const demoAgentId = await readDemoAgentId();
  const outsider = outsiderWallet();
  const block = await ctx.publicClient.getBlockNumber();
  const balance = await ctx.publicClient.getBalance({ address: ctx.deployerAddress });
  const outsiderBalance = await ctx.publicClient.getBalance({ address: outsider.account.address });

  say("Moolam prove-it run: one image gets a passport, six mangled copies still find it, the C2PA");
  say("manifest is stripped and it still finds it, a forgery is answered, and every attack in the");
  say("threat model is executed. All of it against Monad mainnet.");
  say();
  say(`started     ${startedAt.toISOString()}`);
  say(`network     Monad mainnet, chain ${ctx.addresses.chainId}, block ${block}`);
  say(`registry    ${ctx.addresses.registry}`);
  say(`policy      ${ctx.addresses.policy}`);
  say(`receiver    ${ctx.addresses.receiver}`);
  say(`ERC-8004    ${ctx.addresses.agentIdentity}, demo agent ${demoAgentId}`);
  say(`creator     ${ctx.deployerAddress}, ${Number(formatEther(balance)).toFixed(3)} MON`);
  say(`outsider    ${outsider.account.address}, ${Number(formatEther(outsiderBalance)).toFixed(3)} MON`);
  say("            the outsider is the wallet the attacks are sent from. It is not the creator, not");
  say("            a listed receiver, not the dispute resolver and not the owner of anything here.");

  const sections: Section[] = [];
  const attacks: AttackResult[] = [];

  sayAll(heading("1. Register: a new image gets a passport"));
  const original = await registerOriginal(ctx, {
    seed: startedAt.getTime() % 2 ** 31,
    title: `Moolam prove-it ${startedAt.toISOString()}`,
    agentId: demoAgentId,
  });
  const registered = original.registeredAt > 0n && original.metadataStatus === 200;
  say(`  image       ${original.print.width} by ${original.print.height}, ${original.signed.length.toLocaleString("en-US")} bytes once the C2PA manifest is signed in`);
  say(`  fingerprint phash 0x${original.print.phash.toString(16).padStart(16, "0")}, blockhash ${original.print.blockhash}`);
  say(`  manifest    ${original.manifest.present ? "present" : "MISSING"}, soft binding ${original.manifest.softBinding?.alg ?? "none"}`);
  say(`  files       image ${original.imageUri}`);
  say(`              thumb ${original.thumbnailUri}`);
  say(`              meta  ${original.metadataUri}, public gateway answered ${original.metadataStatus}`);
  say(`  passport    ${original.passportId}`);
  say(`  token id    ${BigInt(original.passportId)}`);
  say(`  registered  block ${original.blockNumber}, ${new Date(Number(original.registeredAt) * 1000).toISOString()}`);
  say(`  transaction ${original.txHash}`);
  say(`              ${EXPLORER_TX}${original.txHash}`);
  say(`  gas         ${original.gasUsed.toLocaleString("en-US")} used of a ${original.gasLimit.toLocaleString("en-US")} limit, and Monad bills the limit`);
  say(`  ${verdict(registered)}: the passport is on Monad and its four files are on IPFS.`);
  say("  Not proved here: who the creator is offline. A passport proves which key signed and when,");
  say("  not the identity of the person holding it.");
  sections.push({
    number: "1",
    title: "Register",
    passed: registered,
    evidence: `${EXPLORER_TX}${original.txHash}`,
  });

  const copies = await copiesOf(original.signed);
  await writePassportIndex(ctx, [original.passportId], PASSPORTS_FILE);
  let service = await startVerifyService({ port: VERIFIER_PORT, passportsFile: PASSPORTS_FILE, say });

  try {
    sayAll(heading("2. Survive: six copies of the same picture"));
    const survivors = await checkSurvivors(original, service.baseUrl, copies);
    const allSurvived = survivors.every((row) => row.resolved);
    sayAll(
      renderTable(
        [
          { header: "copy" },
          { header: "bytes", align: "right" },
          { header: "matched as" },
          { header: "phash" },
          { header: "blockhash" },
          { header: "confidence", align: "right" },
          { header: "resolves to the passport" },
        ],
        survivors.map((row) => [
          row.name,
          row.bytes.toLocaleString("en-US"),
          row.variant,
          `${row.phashDistance} of 64`,
          `${row.blockhashDistance} of 256`,
          row.confidence.toFixed(2),
          row.resolved ? "yes" : "NO",
        ]),
      ).map((line) => `  ${line}`),
    );
    say(
      `  ${verdict(allSurvived)}: ${survivors.filter((row) => row.resolved).length} of ${survivors.length} copies resolve to ${original.passportId}.`,
    );
    say("  Not proved here: crops. Cutting 10 percent off each edge breaks both fingerprints. That is");
    say("  measured in kitchen/reports/WO-2-robustness.txt and stated in the threat model.");
    sections.push({
      number: "2",
      title: "Survive",
      passed: allSurvived,
      evidence: `${survivors.filter((row) => row.resolved).length} of 6 copies matched`,
    });

    sayAll(heading("3. Strip: the C2PA manifest removed entirely"));
    const stripped = await checkStrip(original, service.baseUrl, copies["strip-metadata"]);
    const strippedOk = stripped.manifestBefore && !stripped.manifestAfter && stripped.resolved;
    say(`  signed copy    C2PA manifest present: ${stripped.manifestBefore ? "yes" : "no"}`);
    say(
      `  stripped copy  C2PA manifest present: ${stripped.manifestAfter ? "yes" : "no"}, and the service read it as ${stripped.serviceSawManifest ? "present" : "absent"} too`,
    );
    say(`  stripped copy  ${stripped.bytes.toLocaleString("en-US")} bytes`);
    say(
      `  verify answer  phash ${stripped.phashDistance} of 64, blockhash ${stripped.blockhashDistance} of 256, confidence ${stripped.confidence.toFixed(2)}`,
    );
    say(`  ${verdict(strippedOk)}: the manifest is gone and the passport still resolves.`);
    say("  Not proved here: that the manifest was trustworthy to begin with. It is signed with a");
    say("  throwaway certificate, so every reader marks it untrusted. The chain record carries the");
    say("  signatures that matter.");
    sections.push({
      number: "3",
      title: "Strip",
      passed: strippedOk,
      evidence: `manifest gone, confidence ${stripped.confidence.toFixed(2)}`,
    });

    sayAll(heading("4. Forge: someone else tries to claim the picture"));
    const impostorAddress = privyCreatorAddress();
    const duplicate = await refuseOnChain(ctx, {
      what: "register the same bytes again under a different creator",
      from: ctx.deployer,
      address: ctx.addresses.registry,
      abi: ctx.registryAbi,
      functionName: "register",
      args: [
        { ...original.input, creator: impostorAddress },
        original.creatorAuth,
        original.generatorSig,
      ],
      gas: REGISTER_GAS,
      expected: "PassportAlreadyExists",
    });
    say("  4a. the same bytes, a different creator");
    sayAll(duplicate.lines.map((line) => `      ${line}`));

    const impostor = await registerImpostor(ctx, {
      bytes: copies["reencode-q60"],
      creator: impostorAddress,
      passkey: creatorPasskeyFromDisk(),
      title: `Moolam prove-it forgery attempt ${startedAt.toISOString()}`,
    });
    say();
    say("  4b. a re-encoded copy, registered as a fresh original by that second creator");
    say(`      passport    ${impostor.passportId}`);
    say(`      creator     ${impostor.creator}`);
    say(`      transaction ${impostor.txHash}`);
    say(`                  ${EXPLORER_TX}${impostor.txHash}`);
    say(
      `      registered  ${new Date(Number(impostor.registeredAt) * 1000).toISOString()}, ${Number(impostor.registeredAt - original.registeredAt)} seconds after the original`,
    );
    say("      The chain accepted it, and it was always going to: different bytes are a different");
    say("      image as far as a hash is concerned. What answers the theft is the next step.");

    await service.stop();
    await writePassportIndex(ctx, [original.passportId, impostor.passportId], PASSPORTS_FILE);
    service = await startVerifyService({ port: VERIFIER_PORT, passportsFile: PASSPORTS_FILE, say });

    const third = await verifyFile(service.baseUrl, copies["reencode-q30"], "third-copy.jpg");
    const origins: OriginCandidate[] = [];
    for (const match of third.matches) {
      const passport = await ctx.registry.getPassport(match.id as Hex);
      origins.push({
        id: match.id,
        creator: passport.creator,
        registeredAt: passport.registeredAt,
        phashDistance: match.phashDistance,
      });
    }
    origins.sort((left, right) => Number(left.registeredAt - right.registeredAt));
    const origin = origins[0];

    say();
    say("  4c. a third copy, re-encoded at quality 30, handed to the verify service");
    sayAll(
      renderTable(
        [{ header: "passport" }, { header: "creator" }, { header: "registered" }, { header: "phash" }],
        origins.map((row) => [
          row.id,
          row.creator,
          new Date(Number(row.registeredAt) * 1000).toISOString(),
          `${row.phashDistance} of 64`,
        ]),
      ).map((line) => `      ${line}`),
    );
    const exactOnCopy = await verifyFile(service.baseUrl, copies["reencode-q60"], "impostor-copy.jpg");
    say("      The impostor's own file is still an exact byte match for the impostor's record");
    say(`      (${exactOnCopy.exact ?? "no exact match"}), and that record is the newer of the two.`);

    const forgeOk =
      duplicate.refused &&
      origin !== undefined &&
      origin.id.toLowerCase() === original.passportId.toLowerCase() &&
      origin.registeredAt < impostor.registeredAt;
    say(`  ${verdict(forgeOk)}: the chain refused the duplicate with ${duplicate.errorName}, and the`);
    say(`  oldest passport for this picture is the first one, ${original.passportId}.`);
    say("  Not proved here: who really made the picture. Moolam records who registered first and says");
    say("  so plainly in the threat model. For an AI image the two are the same moment, because the");
    say("  generator registers before publication.");
    sections.push({
      number: "4",
      title: "Forge",
      passed: forgeOk,
      evidence: `${duplicate.errorName}, oldest passport is the first one`,
    });

    sayAll(heading("5. Attacks: every claim in the threat model, executed"));
    const attackContext: AttackContext = { ctx, original, outsider, baseUrl: service.baseUrl };

    for (const run of [
      passkeyReplay,
      forgedGeneratorSignature,
      unknownAgent,
      expiredDeadline,
      editByStranger,
      attestFromStranger,
      reportFromFakeForwarder,
      receiverReplayAndWrongChain,
      privyPolicyRefusals,
      revokedSessionSigner,
      disputeMoneyRules,
      verifierApiLimits,
    ]) {
      const attack = await run(attackContext);
      attacks.push(attack);
      say(`  ${verdict(attack.refused)}  ${attack.name}`);
      say(`        ${attack.evidence.split("\n")[0] ?? ""}`);
    }

    const allRefused = attacks.every((attack) => attack.refused);
    say();
    say(
      `  ${verdict(allRefused)}: ${attacks.filter((attack) => attack.refused).length} of ${attacks.length} attacks refused, each for the reason the design gives.`,
    );
    say("  Not proved here: an attack nobody thought of. This is the list in");
    say("  docs/docs/security/threat-model.md, self-audited, with no third party audit behind it.");
    sections.push({
      number: "5",
      title: "Attacks",
      passed: allRefused,
      evidence: `${attacks.filter((attack) => attack.refused).length} of ${attacks.length} refused`,
    });
  } finally {
    await service.stop();
    say();
    say(`The run started the verify service itself on port ${VERIFIER_PORT} with PASSPORT_SOURCE=json,`);
    say("and stopped it again just now. In production the same service reads passports from Envio.");
  }

  sayAll(heading("6. Summary"));
  sayAll(
    renderTable(
      [{ header: "section" }, { header: "result" }, { header: "evidence" }],
      sections.map((section) => [
        `${section.number}. ${section.title}`,
        verdict(section.passed),
        section.evidence,
      ]),
    ).map((line) => `  ${line}`),
  );
  say();
  sayAll(
    renderTable(
      [{ header: "attack" }, { header: "result" }, { header: "saved output" }],
      attacks.map((attack) => [
        attack.name,
        attack.refused ? "REFUSED" : "NOT REFUSED",
        `docs/docs/security/attacks/${attack.name}.txt`,
      ]),
    ).map((line) => `  ${line}`),
  );

  await writeAttackFiles(ctx, attacks, startedAt);

  const passed = sections.every((section) => section.passed);
  say();
  say(`${verdict(passed)}: the Moolam prove-it run, end to end, against Monad mainnet.`);
  say(
    `finished ${new Date().toISOString()}, ${Math.round((Date.now() - startedAt.getTime()) / 1000)} seconds`,
  );
  process.exitCode = passed ? 0 : 1;
}

/** One file per attack, so the evidence lives in the repo and not only in somebody's terminal. */
async function writeAttackFiles(
  ctx: ProveContext,
  attacks: AttackResult[],
  startedAt: Date,
): Promise<void> {
  await mkdir(ATTACKS_DIR, { recursive: true });
  for (const attack of attacks) {
    const header = [
      `Moolam attack: ${attack.name}`,
      attack.refused ? "REFUSED" : "NOT REFUSED",
      "",
      `run         ${startedAt.toISOString()}`,
      "command     npm run prove",
      `network     Monad mainnet, chain ${ctx.addresses.chainId}`,
      `registry    ${ctx.addresses.registry}`,
      "",
    ];
    await writeFile(
      join(ATTACKS_DIR, `${attack.name}.txt`),
      `${[...header, attack.evidence].join("\n")}\n`,
      "utf8",
    );
  }
}

/** The wallet the attacks are sent from. It holds no role in Moolam, which is the point of it. */
function outsiderWallet(): Signer {
  const account = privateKeyToAccount(requiredKey("VERIFIER_PRIVATE_KEY"));
  return createWalletClient({
    account,
    chain: monad,
    transport: http(MONAD_MAINNET.rpc),
  }) as Signer;
}

/** The second creator in the forgery: a real wallet with its own passkey bound on the registry. */
function privyCreatorAddress(): Hex {
  const creator = readStore().creator;
  if (!creator) {
    throw new Error(
      "No second creator wallet on this machine. Run npm run prove:privy once: it creates the creator wallet and binds its passkey.",
    );
  }
  return creator.address;
}

/** That creator's passkey, read from the gitignored store. The key itself never reaches a log. */
function creatorPasskeyFromDisk(): SoftwarePasskey {
  let raw: string;
  try {
    raw = readFileSync(CREATOR_PASSKEY_FILE, "utf8");
  } catch {
    throw new Error(
      `No second creator passkey at ${CREATOR_PASSKEY_FILE}. Run npm run prove:privy once to create and bind it.`,
    );
  }
  const stored = JSON.parse(raw) as { privateKey?: string };
  if (typeof stored.privateKey !== "string") {
    throw new Error(`The passkey file at ${CREATOR_PASSKEY_FILE} has no privateKey field.`);
  }
  return SoftwarePasskey.fromPrivateKey(stored.privateKey as Hex);
}

async function readDemoAgentId(): Promise<bigint> {
  const parsed = JSON.parse(await readFile(DEFAULT_DEPLOYMENT_FILE, "utf8")) as {
    demoAgentId?: number;
  };
  if (typeof parsed.demoAgentId !== "number") {
    throw new Error(`The deployment file at ${DEFAULT_DEPLOYMENT_FILE} has no demoAgentId.`);
  }
  return BigInt(parsed.demoAgentId);
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    say();
    say(`FAIL: the run stopped before it finished: ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mkdir(dirname(REPORT_FILE), { recursive: true });
    await writeFile(REPORT_FILE, `${lines.join("\n")}\n`, "utf8");
    console.log();
    console.log(`Saved to ${REPORT_FILE}`);
    console.log(`Attack outputs in ${ATTACKS_DIR}`);
  });
