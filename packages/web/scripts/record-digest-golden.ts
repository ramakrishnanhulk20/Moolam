// Records what the deployed registry answers for the digests test/digest.test.ts checks, so that
// test can hold this app's own digests to the contract without calling out on every run.
//
// It reads hashPassport and hashBind, both pure views, through the same chain client and the same
// environment the app and the test use (MONAD_RPC_URL if set, else NEXT_PUBLIC_MONAD_RPC_URL, else
// the public endpoint), all at one block, and writes test/fixtures/digest-golden.json. It sends
// nothing and costs nothing. Re-run it when the registry is redeployed or an input below changes.
//
// Usage, from packages/web:
//   npx tsx scripts/record-digest-golden.ts
//
// The RPC address is never printed: it can carry an access key, so every error goes through
// reason(), which takes any address out of the line.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Hex } from "viem";
import type { PassportInput } from "../lib/chain/calldata";
import { CHAIN_ID, addresses, chain, reason, registryAbi } from "../lib/chain/client";

const FIXTURE = path.join(__dirname, "..", "test", "fixtures", "digest-golden.json");

// The inputs test/digest.test.ts uses. The test checks the fixture carries these exact values, so
// an input changed on one side only fails there instead of passing against a stale digest.
const WALLET = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;

const BASE: PassportInput = {
  exactHash: `0x${"ab".repeat(32)}`,
  parentId: `0x${"00".repeat(32)}`,
  creator: WALLET,
  generatorAgentId: 10249n,
  phash: 17297841240124424192n,
  blockhash256: `0x${"cd".repeat(32)}`,
  manifestHash: `0x${"ef".repeat(32)}`,
  kind: 0,
  fingerprintVersion: 1,
  metadataURI: "ipfs://bafkreimetadata",
  deadline: 1_788_878_342n,
};

const OTHER_PICTURE: PassportInput = { ...BASE, exactHash: `0x${"ac".repeat(32)}` };

const BIND_QX = `0x${"11".repeat(32)}` as Hex;
const BIND_QY = `0x${"22".repeat(32)}` as Hex;

/** JSON has no bigint, so the three bigint fields are written as decimal strings. */
function recordedInput(input: PassportInput): Record<string, string | number> {
  return {
    ...input,
    generatorAgentId: input.generatorAgentId.toString(),
    phash: input.phash.toString(),
    deadline: input.deadline.toString(),
  };
}

async function main(): Promise<void> {
  const chainId = await chain.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new Error(`the RPC endpoint answers for chain ${chainId}, and the registry is deployed on chain ${CHAIN_ID}`);
  }

  // One block for every read, so the bind nonce and the digests describe the same moment.
  const blockNumber = await chain.getBlockNumber();
  const read = async (functionName: string, args: readonly unknown[]): Promise<unknown> =>
    await chain.readContract({ address: addresses.registry, abi: registryAbi, functionName, args, blockNumber });

  const base = (await read("hashPassport", [BASE])) as Hex;
  const otherPicture = (await read("hashPassport", [OTHER_PICTURE])) as Hex;
  const nonce = (await read("bindNonce", [WALLET])) as bigint;
  const bind = (await read("hashBind", [WALLET, BIND_QX, BIND_QY, nonce])) as Hex;

  const fixture = {
    recordedBy: "scripts/record-digest-golden.ts",
    chainId,
    registry: addresses.registry,
    blockNumber: blockNumber.toString(),
    passport: {
      base: { input: recordedInput(BASE), digest: base },
      otherPicture: { input: recordedInput(OTHER_PICTURE), digest: otherPicture },
    },
    bind: { wallet: WALLET, qx: BIND_QX, qy: BIND_QY, nonce: nonce.toString(), digest: bind },
  };

  mkdirSync(path.dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  console.log(`wrote ${path.relative(process.cwd(), FIXTURE)}: registry ${addresses.registry} on chain ${chainId}, block ${blockNumber}`);
}

main().catch((error: unknown) => {
  console.error(`could not record the digests: ${reason(error)}`);
  process.exit(1);
});
