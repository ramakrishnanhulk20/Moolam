/** Every reason the kit refuses or fails, so a caller can branch on a code rather than on words. */
export type PlatformErrorCode =
  | "invalid-input"
  | "invalid-rp-id"
  | "invalid-terms"
  | "wrong-chain"
  | "passkey-already-bound"
  | "passkey-not-bound"
  | "wallet-holds-passports"
  | "service-refused"
  | "service-unreachable"
  | "unexpected-answer"
  | "digest-mismatch"
  | "signed-file-mismatch"
  | "terms-mismatch"
  | "creator-mismatch"
  | "creator-not-set"
  | "deadline-passed"
  | "cosign-expired"
  | "passport-taken"
  | "timed-out"
  | "transaction-failed"
  | "consent-failed"
  | "refused-recipient"
  | "not-holder";

/**
 * The one error the kit throws. Its message and details never carry the platform key, a private
 * key or a co-sign handle, so it is safe to log.
 */
export class MoolamPlatformError extends Error {
  readonly code: PlatformErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: PlatformErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "MoolamPlatformError";
    this.code = code;
    this.details = details;
  }
}
