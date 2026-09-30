// Step 1 of Dreamloom's setup: make its wallet. It is the ERC-8004 agent's owner, the creator wallet
// its server passkey is bound to, and the payer of every platform-mode registration.
//
//   npm run setup:wallet --workspace packages/dreamloom
//
// The key goes into packages/dreamloom/.env.local as DREAMLOOM_WALLET_KEY and nowhere else: it is
// never printed or logged. Only the address is printed, with what to send it.

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { invokedDirectly, runCli } from "./cli";
import { assertWritable, dreamloomEnvFile, writeEnvValue } from "./env-file";

/** What the wallet needs for setup, ten pictures with terms and one move, measured on mainnet (PLAN.md 9.1). */
export const WALLET_NEEDS_MON = "1.5";

/**
 * Makes a fresh wallet key from viem's CSPRNG and writes it into `envFile` as DREAMLOOM_WALLET_KEY.
 * Returns only the address; the key is never returned, printed or logged.
 *
 * Throws Refusal when the file already holds a DREAMLOOM_WALLET_KEY, leaving the file untouched, so
 * a funded wallet can never be replaced by a second run.
 */
export function createWallet(options: { envFile: string }): { address: Address } {
  assertWritable(options.envFile);
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  writeEnvValue(options.envFile, "DREAMLOOM_WALLET_KEY", key);
  return { address };
}

async function main(): Promise<void> {
  const envFile = dreamloomEnvFile();
  const { address } = createWallet({ envFile });
  console.log(`Dreamloom wallet: ${address}`);
  console.log(`Its key is in ${envFile} as DREAMLOOM_WALLET_KEY and is not shown anywhere.`);
  console.log(`Send it ${WALLET_NEEDS_MON} MON on Monad mainnet before the next step (npm run setup:agent).`);
}

if (invokedDirectly(import.meta.url)) runCli(main);
