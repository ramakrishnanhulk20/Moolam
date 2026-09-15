/**
 * Every custom error the registry and the policy can throw, with the sentence
 * a screen prints for it and the one thing worth offering afterwards.
 *
 * One table, because the studio, the edit panel and the dispute panel all send
 * to the same two contracts and were each keeping their own partial copy. The
 * copy keys are the ones those screens already use: they name a string under
 * "studio.failure", "passport.edit.failure" or "passport.dispute.flag.failure"
 * in the message files, and each error belongs to exactly one of those flows.
 *
 * A revert means the call was mined and did nothing, so nothing was written
 * and there is no risk in offering another attempt. "again" is only offered
 * where a second, identical attempt could actually succeed: an expired window
 * or a bond read a moment too early. Where the chain's answer would be the
 * same tomorrow, the reader is sent somewhere else instead of into a loop.
 *
 * The test beside this file reads both ABIs, so an error added to a contract
 * fails the build here until it has a line.
 */

/** The single button a screen offers under the message. Every value is one the flows already know. */
export type RevertNext = "again" | "bind" | "openPassport" | "generateAgain";

export interface RevertCopy {
  key: string;
  /** Left off when a second attempt would only fail the same way. */
  next?: RevertNext;
}

export const REGISTRY_REVERTS: Record<string, RevertCopy> = {
  PassportAlreadyExists: { key: "alreadyRegistered", next: "openPassport" },
  SignatureExpired: { key: "expired", next: "again" },
  PasskeyNotBound: { key: "notBound", next: "bind" },
  InvalidPasskeySignature: { key: "badSignature", next: "again" },
  InvalidPublicKey: { key: "badKey", next: "bind" },
  InvalidCreator: { key: "wrongWallet" },
  EmptyMetadataURI: { key: "rejected" },
  InvalidExactHash: { key: "rejected" },
  InvalidKind: { key: "rejected" },
  InvalidFingerprintVersion: { key: "rejected" },
  EnforcedPause: { key: "paused" },
  ExpectedPause: { key: "reverted" },

  // The agent path. A signature the registry refuses cannot be repaired in the
  // browser, so the only honest offer is a new drawing with a new window.
  InvalidGeneratorSignature: { key: "agentSignFailed", next: "generateAgain" },
  InvalidAgentId: { key: "rejected" },
  UnknownAgent: { key: "rejected" },

  // Edits, where the parent is the thing being judged.
  InvalidParent: { key: "noParent" },
  ParentNotFound: { key: "noParent" },
  ParentNotAllowed: { key: "noParent" },
  NotParentOwner: { key: "notOwner" },

  // Disputes and the money behind them.
  InvalidBond: { key: "badBond", next: "again" },
  DisputeAlreadyOpen: { key: "alreadyOpen" },
  PassportAlreadyDisputed: { key: "alreadyDisputed" },
  PassportNotFound: { key: "notFound" },
  NoOpenDispute: { key: "noOpenDispute" },
  NotResolver: { key: "notResolver" },
  NothingToWithdraw: { key: "nothingOwed" },
  // The registry pays by pull, so this is a wallet that refused its own money.
  TransferFailed: { key: "reverted" },

  // The token half of the registry. Only the missing token has a sentence of
  // its own: the rest are transfer and approval errors a Moolam screen never
  // sends, and a generic line is more honest than an invented one.
  ERC721NonexistentToken: { key: "notFound" },
  ERC721IncorrectOwner: { key: "notOwner" },
  ERC721InsufficientApproval: { key: "reverted" },
  ERC721InvalidApprover: { key: "reverted" },
  ERC721InvalidOperator: { key: "reverted" },
  ERC721InvalidOwner: { key: "reverted" },
  ERC721InvalidReceiver: { key: "reverted" },
  ERC721InvalidSender: { key: "reverted" },

  // Attestations are written by the verifier's receiver, never by a visitor.
  AttestationCapReached: { key: "reverted" },
  NotReceiver: { key: "reverted" },

  // Owner-only paths and the guards underneath them. A visitor reaching one of
  // these is looking at a bug or at somebody else's transaction.
  OwnableInvalidOwner: { key: "reverted" },
  OwnableUnauthorizedAccount: { key: "reverted" },
  ReentrancyGuardReentrantCall: { key: "reverted" },
  SafeERC20FailedOperation: { key: "reverted" },
  NothingToRescue: { key: "reverted" },
  NotAContract: { key: "reverted" },
  ZeroAddress: { key: "reverted" },
  InvalidShortString: { key: "reverted" },
  StringTooLong: { key: "reverted" },

  // The policy contract: the bond, the resolver, the treasury and the
  // receivers, all of them behind the owner's timelock.
  AlreadyReceiver: { key: "reverted" },
  NotAReceiver: { key: "reverted" },
  BootstrapClosed: { key: "reverted" },
  ChangeAlreadyQueued: { key: "reverted" },
  ChangeNotReady: { key: "reverted" },
  UnknownChange: { key: "reverted" },
  TreasuryCannotReceive: { key: "reverted" },
};

/** The line for a named revert, or the generic one for anything the ABIs do not know. */
export function revertCopy(name: string | undefined): RevertCopy {
  if (name === undefined) {
    return { key: "reverted", next: "again" };
  }
  return REGISTRY_REVERTS[name] ?? { key: "reverted", next: "again" };
}
