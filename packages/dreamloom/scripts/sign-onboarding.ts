// Step 4 of Dreamloom's setup: sign the onboarding message a Moolam operator printed with
// packages/verifier/scripts/platform-add.ts message, as the agent's owner and as the creator wallet,
// which for Dreamloom are the same wallet.
//
//   npm run setup:sign-onboarding --workspace packages/dreamloom -- <typed-data.json>
//
// The file holds only the typed data JSON the message step printed, never the platform key printed
// above it. Reads DREAMLOOM_WALLET_KEY and DREAMLOOM_AGENT_ID from packages/dreamloom/.env.local and
// prints the two signatures for the operator's add step. Nothing is sent on chain.

import { readFileSync, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { getAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { Refusal, invokedDirectly, runCli } from "./cli";
import { dreamloomEnvFile, requiredValue } from "./env-file";

/** The domain the verify service checks onboarding signatures in (packages/verifier/src/platforms/platforms.ts). */
export const ONBOARDING_DOMAIN = { name: "Moolam platform", version: "1", chainId: 143 } as const;

/** Field for field the verify service's ONBOARDING_TYPES: the order produces the type string, so it is compared whole. */
export const ONBOARDING_TYPES = {
  PlatformOnboarding: [
    { name: "name", type: "string" },
    { name: "agentId", type: "uint256" },
    { name: "agentOwner", type: "address" },
    { name: "creatorWallet", type: "address" },
    { name: "keyHash", type: "bytes32" },
    { name: "origins", type: "string[]" },
    { name: "validFrom", type: "uint64" },
  ],
} as const;

/** The printed message is a few hundred bytes; anything far past that is not the operator's file. */
const MAX_FILE_BYTES = 16_384;

const typedDataSchema = z.strictObject({
  domain: z.strictObject({ name: z.literal(ONBOARDING_DOMAIN.name), version: z.literal(ONBOARDING_DOMAIN.version), chainId: z.literal(143) }),
  types: z.unknown(),
  primaryType: z.literal("PlatformOnboarding"),
  message: z.strictObject({
    name: z.string().min(1).max(200),
    agentId: z.string().regex(/^[1-9][0-9]{0,77}$/),
    agentOwner: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    creatorWallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    keyHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    origins: z.array(z.string().min(1).max(300)).min(1).max(4),
    validFrom: z.string().regex(/^[1-9][0-9]{0,15}$/),
  }),
});

export interface OnboardingSignatures {
  name: string;
  agentId: string;
  origins: string[];
  validFrom: string;
  keyHash: Hex;
  ownerSignature: Hex;
  creatorSignature: Hex;
}

/** The address as the message wrote it, or null for a mixed-case spelling whose checksum is wrong. */
function checked(value: string): Address | null {
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

/**
 * Checks the typed data the operator printed and signs it twice with the Dreamloom wallet: once as
 * the agent's owner and once as the creator wallet. Each signature is recovered before it is returned.
 *
 * Signs only when the domain is Moolam's onboarding domain on chain 143 and nothing more, the types
 * are the service's exactly, the primary type is PlatformOnboarding, the message has exactly its
 * seven fields, and agentOwner and creatorWallet are both the Dreamloom wallet and agentId is
 * Dreamloom's own agent. Throws Refusal naming the first check that failed; nothing is signed then.
 */
export async function signOnboarding(options: { typedData: unknown; walletKey: string; agentId: string }): Promise<OnboardingSignatures> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(options.walletKey)) throw new Refusal("the Dreamloom wallet key is not 32 bytes of hex");
  const account = privateKeyToAccount(options.walletKey as Hex);
  const parsed = typedDataSchema.safeParse(options.typedData);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Refusal(`the typed data is not the onboarding message: ${issue?.path.join(".") || "document"} ${issue?.message ?? "is invalid"}`);
  }
  const { types, message } = parsed.data;
  if (!isDeepStrictEqual(types, ONBOARDING_TYPES)) {
    throw new Refusal("the typed data's types are not the verify service's PlatformOnboarding types");
  }
  const wallet = getAddress(account.address);
  const agentOwner = checked(message.agentOwner);
  const creatorWallet = checked(message.creatorWallet);
  if (agentOwner !== wallet) throw new Refusal(`agentOwner is ${message.agentOwner}, not the Dreamloom wallet ${wallet}`);
  if (creatorWallet !== wallet) throw new Refusal(`creatorWallet is ${message.creatorWallet}, not the Dreamloom wallet ${wallet}`);
  if (message.agentId !== options.agentId) throw new Refusal(`agentId is ${message.agentId}, not Dreamloom's agent ${options.agentId}`);

  const typed = {
    domain: ONBOARDING_DOMAIN,
    types: ONBOARDING_TYPES,
    primaryType: "PlatformOnboarding" as const,
    message: {
      name: message.name,
      agentId: BigInt(message.agentId),
      agentOwner,
      creatorWallet,
      keyHash: message.keyHash as Hex,
      origins: message.origins,
      validFrom: BigInt(message.validFrom),
    },
  };
  const ownerSignature = await account.signTypedData(typed);
  const creatorSignature = await account.signTypedData(typed);
  for (const signature of [ownerSignature, creatorSignature]) {
    if ((await recoverTypedDataAddress({ ...typed, signature })) !== wallet) {
      throw new Error("a signature did not recover to the Dreamloom wallet");
    }
  }
  return {
    name: message.name,
    agentId: message.agentId,
    origins: message.origins,
    validFrom: message.validFrom,
    keyHash: message.keyHash as Hex,
    ownerSignature: ownerSignature.toLowerCase() as Hex,
    creatorSignature: creatorSignature.toLowerCase() as Hex,
  };
}

/** Reads the operator's file: JSON and nothing else, under the size cap. */
export function readTypedDataFile(file: string): unknown {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    throw new Refusal(`cannot read ${file}`);
  }
  if (size > MAX_FILE_BYTES) throw new Refusal(`${file} is larger than the onboarding message could be`);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new Refusal(`${file} is not JSON; save only the typed data block the message step printed`);
  }
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (file === undefined || process.argv.length !== 3) throw new Refusal("pass the path of the typed data JSON file, and nothing else");
  const envFile = dreamloomEnvFile();
  const signed = await signOnboarding({
    typedData: readTypedDataFile(file),
    walletKey: requiredValue(envFile, "DREAMLOOM_WALLET_KEY"),
    agentId: requiredValue(envFile, "DREAMLOOM_AGENT_ID"),
  });
  console.log(`Signed the onboarding of "${signed.name}", agent ${signed.agentId}, valid from ${signed.validFrom}`);
  console.log(`  origins: ${signed.origins.join(", ")}`);
  console.log(`  key hash: ${signed.keyHash}`);
  console.log("Hand these to the operator for platform-add.ts add:");
  console.log(`  --owner-sig ${signed.ownerSignature} --creator-sig ${signed.creatorSignature}`);
}

if (invokedDirectly(import.meta.url)) runCli(main);
