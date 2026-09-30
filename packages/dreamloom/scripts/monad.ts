import type { PlatformWalletClient } from "@moolam/platform";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "viem/chains";
import { Refusal } from "./cli";

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/**
 * Dreamloom's wallet on Monad, read and write, over one RPC address.
 *
 * Throws Refusal for a key that is not 32 bytes of hex, and when the RPC answers for any chain but
 * Monad's 143, before anything is signed: every Moolam signature names chain 143.
 */
export async function dreamloomClients(walletKey: string, rpcUrl: string) {
  if (!PRIVATE_KEY.test(walletKey)) throw new Refusal("the Dreamloom wallet key is not 32 bytes of hex");
  const account = privateKeyToAccount(walletKey as Hex);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: monad, transport });
  const walletClient = createWalletClient({ account, chain: monad, transport });
  const chainId = await publicClient.getChainId();
  if (chainId !== monad.id) throw new Refusal(`the RPC answers for chain ${chainId}, not Monad (${monad.id})`);
  // The kit and Dreamloom each carry viem 2.57.1; TypeScript cannot match the two copies' client
  // types, and at run time they are the same client. lib/server/kit.ts makes the same cast.
  return { account, publicClient, walletClient, kitWallet: walletClient as unknown as PlatformWalletClient };
}
