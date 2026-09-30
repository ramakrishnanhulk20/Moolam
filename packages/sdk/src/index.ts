export { setupPlatform, type PlatformSetup, type SetupPlatformOptions } from "./setup.js";
export { registerAsPlatform, type PlatformRegistration, type RegisterAsPlatformOptions } from "./register.js";
export {
  signAsAgent,
  startCosign,
  waitForCreator,
  waitForPassport,
  type CosignHandle,
  type CosignedPassport,
  type StartCosignOptions,
  type WaitOptions,
} from "./cosign.js";
export { transferPassport, type PassportTransfer } from "./transfer.js";
export { ServerPasskey, rpIdProblem, type WebAuthnAuth } from "./passkey.js";
export { platformIdOf, sha256Hex, signPlatformPrepare, type AgentAccount, type SignedPrepare } from "./prepare.js";
export { termsProblem, type AiUse, type AiUseTerms } from "./terms.js";
export { MoolamPlatformError, type PlatformErrorCode } from "./errors.js";
export { passportDigest, prepareDigest, type PassportInput, type PlatformMode, type PlatformPrepareMessage } from "./eip712.js";
export type { ChainReader, PlatformWalletClient } from "./chain.js";
export { AGENT_IDENTITY_REGISTRY, MONAD_CHAIN_ID, MOOLAM_CONSENT, MOOLAM_REGISTRY, MOOLAM_SITE_URL } from "./constants.js";
