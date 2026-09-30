import { parseEventLogs, type Address, type Hex } from "viem";
import { registryAbi } from "./abi.js";
import { assertMonad, readerFor, sendAndConfirm, walletAddress, type PlatformWalletClient } from "./chain.js";
import { MOOLAM_REGISTRY, ZERO_BYTES32 } from "./constants.js";
import { bindDigest } from "./eip712.js";
import { MoolamPlatformError } from "./errors.js";
import { ServerPasskey, rpIdProblem } from "./passkey.js";

export interface SetupPlatformOptions {
  /** The platform's own wallet on Monad. It sends and pays for the bind, and later for every register. */
  walletClient: PlatformWalletClient;
  /** The platform's own public hostname, hashed into every assertion its server key makes. */
  rpId: string;
  /**
   * Replace a passkey this wallet already has bound. Without it, an existing binding is refused. A
   * working platform's wallet holds passports, so a rotation may go ahead on a wallet that holds
   * some, but only when a key is already bound to it.
   */
  rotate?: boolean;
}

export interface PlatformSetup {
  /**
   * The server passkey's P-256 private key. It is handed back once, for the platform's own secret
   * store; the kit never writes, logs or sends it anywhere (P21).
   */
  passkeyPrivateKey: Hex;
  rpId: string;
  qx: Hex;
  qy: Hex;
  wallet: Address;
  bindTx: Hex;
}

/**
 * Sets a platform up once: makes a server passkey and binds it on the registry as the creator key of
 * the platform's wallet, sent and paid for by that wallet.
 *
 * Preconditions, each checked on chain before anything is signed or sent (P20): the wallet has no
 * passkey bound unless `rotate` is true; the wallet holds no passports, unless `rotate` is true and a
 * passkey is already bound, which is a platform replacing its own key; and `rpId` is the platform's
 * own hostname, never Moolam's and never "localhost".
 *
 * Throws MoolamPlatformError: "invalid-rp-id", "wrong-chain", "passkey-already-bound",
 * "wallet-holds-passports", or "transaction-failed" when the bind would revert or did.
 * Emits, on chain, the registry's PasskeyBound for the wallet.
 */
export async function setupPlatform(options: SetupPlatformOptions): Promise<PlatformSetup> {
  const { walletClient, rpId, rotate = false } = options;
  const problem = rpIdProblem(rpId);
  if (problem !== null) {
    throw new MoolamPlatformError("invalid-rp-id", problem);
  }
  const reader = readerFor(walletClient);
  await assertMonad(reader);
  const wallet = walletAddress(walletClient);

  const [boundX, boundY] = await reader.readContract({
    address: MOOLAM_REGISTRY,
    abi: registryAbi,
    functionName: "getPasskey",
    args: [wallet],
  });
  const alreadyBound = boundX !== ZERO_BYTES32 || boundY !== ZERO_BYTES32;
  if (alreadyBound && !rotate) {
    throw new MoolamPlatformError(
      "passkey-already-bound",
      "this wallet already has a passkey bound; pass rotate: true to replace it on purpose",
      { wallet },
    );
  }
  // A wallet holding passports is someone's Moolam wallet or a platform already at work; binding a
  // new creator key over it would change whose key signs for everything it makes next. Only the
  // platform replacing a key it already has bound may do that, and a wallet with no key bound is
  // not rotating anything.
  const held = await reader.readContract({
    address: MOOLAM_REGISTRY,
    abi: registryAbi,
    functionName: "balanceOf",
    args: [wallet],
  });
  if (held > 0n && !(rotate && alreadyBound)) {
    throw new MoolamPlatformError("wallet-holds-passports", "this wallet already holds passports; set a platform up on a wallet of its own", {
      wallet,
      held: held.toString(),
    });
  }

  const passkeyPrivateKey = ServerPasskey.newPrivateKey();
  const passkey = ServerPasskey.fromPrivateKey(passkeyPrivateKey, rpId);
  const nonce = await reader.readContract({
    address: MOOLAM_REGISTRY,
    abi: registryAbi,
    functionName: "bindNonce",
    args: [wallet],
  });
  const auth = passkey.sign(bindDigest(wallet, passkey.qx, passkey.qy, nonce));

  const { hash, receipt } = await sendAndConfirm(walletClient, reader, {
    address: MOOLAM_REGISTRY,
    abi: registryAbi,
    functionName: "bindPasskey",
    args: [passkey.qx, passkey.qy, auth],
  });
  const bound = parseEventLogs({ abi: registryAbi, eventName: "PasskeyBound", logs: receipt.logs }).some(
    (log) =>
      log.address.toLowerCase() === MOOLAM_REGISTRY.toLowerCase() &&
      log.args.wallet === wallet &&
      log.args.qx === passkey.qx &&
      log.args.qy === passkey.qy,
  );
  if (!bound) {
    throw new MoolamPlatformError("transaction-failed", "the bind landed without a PasskeyBound for this wallet and key", { hash });
  }

  return { passkeyPrivateKey, rpId, qx: passkey.qx, qy: passkey.qy, wallet, bindTx: hash };
}
