// Step 3 of Dreamloom's setup: make Dreamloom's server passkey and bind it on the Moolam registry as
// the creator key of the Dreamloom wallet, with the kit's setupPlatform.
//
//   npm run setup:passkey --workspace packages/dreamloom
//   npm run setup:passkey --workspace packages/dreamloom -- --rotate   (replace a bound key on purpose)
//
// Reads DREAMLOOM_WALLET_KEY, MONAD_RPC_URL and DREAMLOOM_PASSKEY_RP_ID (Dreamloom's own hostname)
// from packages/dreamloom/.env.local, writes DREAMLOOM_PASSKEY_KEY there, and prints the bind
// transaction. Costs about 0.013 MON.

import { parseArgs } from "node:util";
import { rpIdProblem, setupPlatform } from "@moolam/platform";
import type { Address, Hex } from "viem";
import { Refusal, invokedDirectly, runCli } from "./cli";
import { assertWritable, dreamloomEnvFile, readEnvFile, requiredValue, valueOf, writeEnvValue } from "./env-file";
import { dreamloomClients } from "./monad";

export interface PasskeyBinding {
  wallet: Address;
  rpId: string;
  qx: Hex;
  qy: Hex;
  bindTx: Hex;
}

/**
 * Runs setupPlatform from the Dreamloom wallet under `rpId` and writes the new passkey's private key
 * into `envFile` as DREAMLOOM_PASSKEY_KEY. The private key is not returned: the file is its only copy.
 *
 * Throws Refusal, before anything is sent, for an rpId the kit refuses, when `envFile` already has
 * DREAMLOOM_PASSKEY_KEY and `rotate` is false, when the file cannot be written, and when the RPC is
 * not Monad. Throws the kit's MoolamPlatformError for what setupPlatform refuses on chain, such as a
 * key already bound without `rotate`.
 */
export async function bindServerPasskey(options: {
  envFile: string;
  walletKey: string;
  rpcUrl: string;
  rpId: string;
  rotate: boolean;
}): Promise<PasskeyBinding> {
  const problem = rpIdProblem(options.rpId);
  if (problem !== null) throw new Refusal(`DREAMLOOM_PASSKEY_RP_ID: ${problem}`);
  if (valueOf(readEnvFile(options.envFile), "DREAMLOOM_PASSKEY_KEY") !== undefined && !options.rotate) {
    throw new Refusal(`DREAMLOOM_PASSKEY_KEY is already set in ${options.envFile}; pass --rotate to replace it on purpose`);
  }
  assertWritable(options.envFile);
  const { kitWallet } = await dreamloomClients(options.walletKey, options.rpcUrl);

  const setup = await setupPlatform({ walletClient: kitWallet, rpId: options.rpId, rotate: options.rotate });
  writeEnvValue(options.envFile, "DREAMLOOM_PASSKEY_KEY", setup.passkeyPrivateKey, { replace: options.rotate });
  return { wallet: setup.wallet, rpId: setup.rpId, qx: setup.qx, qy: setup.qy, bindTx: setup.bindTx };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { rotate: { type: "boolean", default: false } }, strict: true });
  const envFile = dreamloomEnvFile();
  const result = await bindServerPasskey({
    envFile,
    walletKey: requiredValue(envFile, "DREAMLOOM_WALLET_KEY"),
    rpcUrl: requiredValue(envFile, "MONAD_RPC_URL"),
    rpId: requiredValue(envFile, "DREAMLOOM_PASSKEY_RP_ID"),
    rotate: values.rotate,
  });
  console.log(`Server passkey bound to ${result.wallet} under ${result.rpId} in transaction ${result.bindTx}`);
  console.log(`Its private key is in ${envFile} as DREAMLOOM_PASSKEY_KEY and is not shown anywhere.`);
}

if (invokedDirectly(import.meta.url)) runCli(main);
