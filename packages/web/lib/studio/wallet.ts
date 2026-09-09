import type { ConnectedWallet } from "@privy-io/react-auth";
import { CHAIN_ID } from "@/lib/chain/client";

/** Monad mainnet as a wallet expects it: 143 in hex. */
export const MONAD_CHAIN_HEX = `0x${CHAIN_ID.toString(16)}` as const;

/**
 * Puts the embedded wallet on Monad before a write.
 *
 * Privy reports the current chain in CAIP-2 form, and sends the transaction on
 * whatever chain the wallet is on when no chain id travels with it. The switch
 * runs through the wallet's own provider so the request is the same one any
 * other dapp would make.
 */
export async function ensureMonad(wallet: ConnectedWallet): Promise<void> {
  if (wallet.chainId === `eip155:${CHAIN_ID}`) {
    return;
  }

  const provider = await wallet.getEthereumProvider();
  await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: MONAD_CHAIN_HEX }] });
}
