import { parseEventLogs, recoverTypedDataAddress, getAddress, type Hex } from "viem";
import { consentAbi, registryAbi } from "./abi.js";
import { passportInputFrom, platformPrepareAnswer } from "./answers.js";
import { assertMonad, chainNow, readerFor, sendAndConfirm, walletAddress, type PlatformWalletClient } from "./chain.js";
import { MOOLAM_CONSENT, MOOLAM_REGISTRY } from "./constants.js";
import { passportDigest, passportTypedData } from "./eip712.js";
import { MoolamPlatformError } from "./errors.js";
import type { ServerPasskey } from "./passkey.js";
import { PREPARE_TIMEOUT_MS, assertTitle, prepareForm, sha256Hex, signPlatformPrepare, type AgentAccount } from "./prepare.js";
import { callService, fetchSignedFile, type ServiceTarget } from "./service.js";
import { assertTerms, consentCall, sameTerms, type AiUseTerms } from "./terms.js";

const FILE_TIMEOUT_MS = 60_000;

export interface RegisterAsPlatformOptions {
  /** The Moolam verify service, for example https://verify.example.com. */
  verifyUrl: string;
  /** The platform's Moolam key. Sent only in the Authorization header. */
  platformKey: string;
  /** The account that owns the platform's ERC-8004 agent. */
  agentAccount: AgentAccount;
  /** The server passkey setupPlatform bound to the platform's wallet. */
  passkey: ServerPasskey;
  /** The platform's wallet: the passport's creator, its first holder, and the payer. */
  walletClient: PlatformWalletClient;
  /** The picture's title, 1 to 120 characters, written into its metadata. */
  title: string;
  /** The platform's AI-use terms, written into the manifest and then stated on chain. Leave out to state none. */
  terms?: AiUseTerms;
}

export interface PlatformRegistration {
  /** The sha256 of signedFile: the passport's id and its token id. */
  passportId: Hex;
  registerTx: Hex;
  /** The setConsent transaction, or null when no terms were given. */
  consentTx: Hex | null;
  /** Moolam's signed copy of the picture. Serve these bytes, not the original: only they carry the passport. */
  signedFile: Uint8Array;
}

/**
 * Registers one picture in platform mode: the platform's agent is the maker, its server passkey
 * signs as the creator key, and its wallet sends, pays, and holds the passport.
 *
 * In order: the agent owner signs a PlatformPrepare and the service signs the manifest and pins;
 * the passport digest is recomputed here with the registry's own EIP-712 encoder and the answer is
 * refused if the service's digest differs; the signed file is fetched and refused unless its sha256
 * is the passport id; the agent signs the digest and the passkey asserts it; register is sent from
 * the wallet; then setConsent states the same terms that went into the manifest (P24).
 *
 * Nothing is sent on chain until every check has passed, and a result is returned only from
 * receipts with status success.
 *
 * Throws MoolamPlatformError: "invalid-input", "invalid-terms", "wrong-chain", "passkey-not-bound",
 * the service errors from callService, "creator-mismatch", "terms-mismatch", "deadline-passed",
 * "digest-mismatch", "signed-file-mismatch", "transaction-failed", and "consent-failed" (with the
 * passport id and register transaction in its details) when the passport landed but the terms did not.
 */
export async function registerAsPlatform(file: Uint8Array, options: RegisterAsPlatformOptions): Promise<PlatformRegistration> {
  const { walletClient, passkey, agentAccount, terms } = options;
  assertTitle(options.title);
  if (terms !== undefined) {
    assertTerms(terms);
  }
  const target: ServiceTarget = { verifyUrl: options.verifyUrl, platformKey: options.platformKey };
  const reader = readerFor(walletClient);
  await assertMonad(reader);
  const wallet = walletAddress(walletClient);

  const [boundX, boundY] = await reader.readContract({
    address: MOOLAM_REGISTRY,
    abi: registryAbi,
    functionName: "getPasskey",
    args: [wallet],
  });
  if (boundX.toLowerCase() !== passkey.qx.toLowerCase() || boundY.toLowerCase() !== passkey.qy.toLowerCase()) {
    throw new MoolamPlatformError("passkey-not-bound", "this passkey is not the one bound to the platform's wallet; run setupPlatform first", {
      wallet,
    });
  }

  const signed = await signPlatformPrepare({ file, mode: "platform", platformKey: target.platformKey, agentAccount, reader });
  const answer = await callService(
    target,
    {
      method: "POST",
      path: "/platform/prepare",
      what: "the platform prepare",
      body: prepareForm(file, "platform", options.title, signed, terms),
      timeoutMs: PREPARE_TIMEOUT_MS,
    },
    platformPrepareAnswer,
  );

  if (answer.passport.creator !== wallet) {
    throw new MoolamPlatformError("creator-mismatch", "the service named a creator other than the platform's wallet", {
      creator: answer.passport.creator,
      wallet,
    });
  }
  if (!sameTerms(terms, answer.training)) {
    throw new MoolamPlatformError("terms-mismatch", "the terms written into the manifest are not the terms the platform sent");
  }
  if (answer.passport.deadline <= (await chainNow(reader))) {
    throw new MoolamPlatformError("deadline-passed", "the passport's signing deadline has already passed on chain");
  }
  const input = passportInputFrom(answer.passport, answer.files, wallet, answer.passport.deadline);
  const digest = passportDigest(input);
  if (digest !== answer.digest) {
    throw new MoolamPlatformError("digest-mismatch", "the service's digest is not the digest of the fields it answered", {
      local: digest,
      service: answer.digest,
    });
  }

  const signedFile = await fetchSignedFile(answer.files.image.gatewayUrl, FILE_TIMEOUT_MS);
  if (sha256Hex(signedFile) !== input.exactHash) {
    throw new MoolamPlatformError("signed-file-mismatch", "the signed file's sha256 is not the passport id, so it would not carry this passport", {
      passportId: input.exactHash,
    });
  }

  const typed = passportTypedData(input);
  const generatorSig = await agentAccount.signTypedData(typed);
  if ((await recoverTypedDataAddress({ ...typed, signature: generatorSig })) !== getAddress(agentAccount.address)) {
    throw new MoolamPlatformError("unexpected-answer", "the agent account signed the passport with another key");
  }
  const creatorAuth = passkey.sign(digest);

  const registered = await sendAndConfirm(walletClient, reader, {
    address: MOOLAM_REGISTRY,
    abi: registryAbi,
    functionName: "register",
    args: [input, creatorAuth, generatorSig],
  });
  const landed = parseEventLogs({ abi: registryAbi, eventName: "PassportRegistered", logs: registered.receipt.logs }).some(
    (log) =>
      log.address.toLowerCase() === MOOLAM_REGISTRY.toLowerCase() &&
      log.args.passportId === input.exactHash &&
      log.args.creator === wallet,
  );
  if (!landed) {
    throw new MoolamPlatformError("transaction-failed", "register landed without a PassportRegistered for this picture", {
      hash: registered.hash,
    });
  }

  let consentTx: Hex | null = null;
  if (terms !== undefined) {
    const { consent, constraintInfo } = consentCall(terms);
    try {
      const stated = await sendAndConfirm(walletClient, reader, {
        address: MOOLAM_CONSENT,
        abi: consentAbi,
        functionName: "setConsent",
        args: [input.exactHash, consent, constraintInfo],
      });
      const written = parseEventLogs({ abi: consentAbi, eventName: "ConsentSet", logs: stated.receipt.logs }).some(
        (log) =>
          log.address.toLowerCase() === MOOLAM_CONSENT.toLowerCase() &&
          log.args.passportId === input.exactHash &&
          log.args.writer === wallet,
      );
      if (!written) {
        throw new MoolamPlatformError("transaction-failed", "setConsent landed without a ConsentSet for this passport", { hash: stated.hash });
      }
      consentTx = stated.hash;
    } catch (error) {
      throw new MoolamPlatformError(
        "consent-failed",
        "the passport is registered, but its terms were not stated on chain; send setConsent again with the same terms",
        {
          passportId: input.exactHash,
          registerTx: registered.hash,
          reason: error instanceof MoolamPlatformError ? error.message : String(error),
        },
      );
    }
  }

  return { passportId: input.exactHash, registerTx: registered.hash, consentTx, signedFile };
}
