import type { Hex } from "viem";
import { MONAD_EXPLORER, addresses } from "@/lib/chain/client";

/**
 * Which of the four ABIs decodes this row's answer. The name rather than the
 * ABI itself, so the list of attacks stays a few kilobytes of data and the
 * ABIs are only fetched when a reader presses a button.
 */
export type AbiName = "consent" | "registry" | "receiver";

/** Which table in lib/chain/reverts.ts holds the sentence for this row's error. */
export type RevertTable = "consent" | "registry" | "none";

/**
 * The one argument this list cannot write down as data: a Chainlink report,
 * which is six values packed the way the receiver decodes them. The caller
 * hands the encoder in, so this file needs nothing from viem but a type and
 * stays a few kilobytes of plain data.
 */
export interface Encoders {
  report(passportId: Hex, at: bigint): Hex;
}

export interface Attack {
  id: string;
  /** What is being tried, in words a judge reads once. */
  what: string;
  contract: string;
  address: Hex;
  abi: AbiName;
  /** Empty for the plain transfer of MON, which calls no function at all. */
  fn: string;
  /** The address the call is simulated as. No key for it exists here. */
  from: Hex;
  /** MON sent with the call, in wei. Only the money row carries any. */
  value?: bigint;
  /**
   * The arguments, built against the timestamp of the block the call is pinned
   * to, because two rows turn on the clock: one deadline a minute in the past
   * and one an hour ahead.
   */
  args: (now: bigint, encode: Encoders) => readonly unknown[];
  /** The error name the saved run got, or null for the control that passes. */
  expected: string | null;
  /** "empty" is a revert with no data, which is what a missing function answers. */
  answer: "refused" | "empty" | "passes";
  reverts: RevertTable;
  /** The namespace in the message file that holds the copy key reverts.ts gives. */
  copyIn: string | null;
  test: { file: string; name: string };
  /** The saved transcript of the same attack, served from the repo. */
  saved: string;
}

/** The passport the consent rows are aimed at: monsoon-fishing-nets-drying. */
const PASSPORT = "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638" as Hex;

/** Its holder, read from the registry rather than chosen. */
const HOLDER = "0x85a88Ca81ff5f681D96AB86fa60ccB8452A139a6" as Hex;

/** The burn address, which has never held anything. */
const STRANGER = "0x000000000000000000000000000000000000dEaD" as Hex;

/** The outsider wallet the saved attacks were sent from. */
const OUTSIDER = "0xC5ead1E4E5C6d56E87e02317f3fB3731cB0b6Ef7" as Hex;

/** The wallet that registered the parent passport the edit row hangs off. */
const CREATOR = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;

/** A passport that exists, so the edit row reaches the owner check. */
const PARENT = "0x1d9dfdba01c1ef72921337f08fafab55375f6cca15b704e2b04280a7fa6dab6e" as Hex;

const ZERO32 = `0x${"0".repeat(64)}` as Hex;

/**
 * Two image hashes nobody has registered. A hash already in the registry would
 * be refused as PassportAlreadyExists before the call reached the rule the row
 * is about, so these are fixed values with no image behind them, and both were
 * checked against the live registry.
 */
const UNREGISTERED_EDIT = "0x4272656b497400000000000000000000000000000000000000000000000ed17e" as Hex;
const UNREGISTERED_NEW = "0x4272656b497400000000000000000000000000000000000000000000007e6973" as Hex;

/** Not allowed, on all four uses. */
const CLOSED = { aiTraining: 2, aiGenerativeTraining: 2, aiInference: 2, dataMining: 2 } as const;

/** Ask me first on all four uses, which is the setting that needs conditions. */
const ASK = { aiTraining: 3, aiGenerativeTraining: 3, aiInference: 3, dataMining: 3 } as const;

/**
 * An empty WebAuthn assertion. The registry checks the deadline before it looks
 * at any signature, so the stale deadline row reaches its refusal without one
 * and nothing here pretends to be a signature.
 */
const NO_ASSERTION = {
  r: ZERO32,
  s: ZERO32,
  challengeIndex: 0n,
  typeIndex: 0n,
  authenticatorData: "0x" as Hex,
  clientDataJSON: "",
} as const;

function passportInput(over: Record<string, unknown>): Record<string, unknown> {
  return {
    exactHash: UNREGISTERED_NEW,
    parentId: ZERO32,
    creator: CREATOR,
    generatorAgentId: 0n,
    phash: 0n,
    blockhash256: ZERO32,
    manifestHash: ZERO32,
    kind: 1,
    fingerprintVersion: 1,
    metadataURI: "ipfs://moolam-break-it",
    deadline: 0n,
    ...over,
  };
}

const CONSENT_TEST = "packages/contracts/test/MoolamConsent.t.sol";
const REGISTRY_TEST = "packages/contracts/test/MoolamRegistry.t.sol";
const RECEIVER_TEST = "packages/contracts/test/MoolamReceiver.t.sol";

const CONSENT_SAVED = "proofs/consent-attacks.txt";
const CONSENT_COPY = "passport.consent.failure";

/**
 * The twelve calls this page sends: seven refusals from the consent register,
 * four from the registry and the receiver, then the control that has to pass.
 *
 * Every one was executed and written down before it was put on a screen. The
 * address a call is sent from, the arguments and the error name all come from
 * the transcript named in `saved`, so a reader can run the same thing with
 * cast and get the same answer.
 */
export const ATTACKS: readonly Attack[] = [
  {
    id: "consent-from-stranger",
    what: "Speak for a passport you do not hold",
    contract: "MoolamConsent",
    address: addresses.consent,
    abi: "consent",
    fn: "setConsent",
    from: STRANGER,
    args: () => [PASSPORT, CLOSED, ""],
    expected: "NotPassportHolder",
    answer: "refused",
    reverts: "consent",
    copyIn: CONSENT_COPY,
    test: { file: CONSENT_TEST, name: "test_aStrangerCannotSpeakForAPassport" },
    saved: CONSENT_SAVED,
  },
  {
    id: "conditions-missing",
    what: "Ask to be asked first, and leave the conditions blank",
    contract: "MoolamConsent",
    address: addresses.consent,
    abi: "consent",
    fn: "setConsent",
    from: HOLDER,
    args: () => [PASSPORT, ASK, ""],
    expected: "ConstraintInfoRequired",
    answer: "refused",
    reverts: "consent",
    copyIn: CONSENT_COPY,
    test: { file: CONSENT_TEST, name: "test_aConstrainedFieldNeedsItsText" },
    saved: CONSENT_SAVED,
  },
  {
    id: "conditions-newline",
    what: "Hide a line break inside the conditions",
    contract: "MoolamConsent",
    address: addresses.consent,
    abi: "consent",
    fn: "setConsent",
    from: HOLDER,
    args: () => [PASSPORT, ASK, "Ask first:\nmail me"],
    expected: "ConstraintInfoNotPrintable",
    answer: "refused",
    reverts: "consent",
    copyIn: CONSENT_COPY,
    test: { file: CONSENT_TEST, name: "test_textWithAByteOutsidePrintableAsciiIsRefusedWithItsPosition" },
    saved: CONSENT_SAVED,
  },
  {
    id: "conditions-too-long",
    what: "Write 257 bytes of conditions, one byte past the limit",
    contract: "MoolamConsent",
    address: addresses.consent,
    abi: "consent",
    fn: "setConsent",
    from: HOLDER,
    args: () => [PASSPORT, ASK, "A".repeat(257)],
    expected: "ConstraintInfoTooLong",
    answer: "refused",
    reverts: "consent",
    copyIn: CONSENT_COPY,
    test: { file: CONSENT_TEST, name: "test_textOneByteTooLongIsRefused" },
    saved: CONSENT_SAVED,
  },
  {
    id: "batch-too-large",
    what: "State for 33 passports in one call, one past the cap",
    contract: "MoolamConsent",
    address: addresses.consent,
    abi: "consent",
    fn: "setConsentBatch",
    from: HOLDER,
    args: () => [Array.from({ length: 33 }, () => PASSPORT), CLOSED, ""],
    expected: "BatchTooLarge",
    answer: "refused",
    reverts: "consent",
    copyIn: CONSENT_COPY,
    test: { file: CONSENT_TEST, name: "test_aBatchOfThirtyThreeIsRefused" },
    saved: CONSENT_SAVED,
  },
  {
    id: "batch-empty",
    what: "Send a batch of nothing, which would look like a statement and change nothing",
    contract: "MoolamConsent",
    address: addresses.consent,
    abi: "consent",
    fn: "setConsentBatch",
    from: HOLDER,
    args: () => [[], CLOSED, ""],
    expected: "EmptyBatch",
    answer: "refused",
    reverts: "consent",
    copyIn: CONSENT_COPY,
    test: { file: CONSENT_TEST, name: "test_anEmptyBatchIsRefused" },
    saved: CONSENT_SAVED,
  },
  {
    id: "consent-no-money",
    what: "Send the consent register one wei of MON",
    contract: "MoolamConsent",
    address: addresses.consent,
    abi: "consent",
    fn: "",
    from: HOLDER,
    value: 1n,
    args: () => [],
    expected: null,
    answer: "empty",
    reverts: "none",
    copyIn: null,
    test: { file: CONSENT_TEST, name: "test_thereIsNoWayToSendMonToThisContract" },
    saved: CONSENT_SAVED,
  },
  {
    id: "edit-by-non-owner",
    what: "Hang an edit off a passport somebody else holds",
    contract: "MoolamRegistry",
    address: addresses.registry,
    abi: "registry",
    fn: "appendEdit",
    from: OUTSIDER,
    args: (now) => [
      passportInput({
        exactHash: UNREGISTERED_EDIT,
        parentId: PARENT,
        creator: OUTSIDER,
        kind: 2,
        deadline: now + 3600n,
      }),
      "0x",
    ],
    expected: "NotParentOwner",
    answer: "refused",
    reverts: "registry",
    copyIn: "passport.edit.failure",
    test: { file: REGISTRY_TEST, name: "test_appendEditRejectsSomeoneWhoDoesNotHoldTheParent" },
    saved: "docs/security/attacks/edit-by-non-owner.txt",
  },
  {
    id: "attest-from-stranger",
    what: "Write a verification result without being a listed receiver",
    contract: "MoolamRegistry",
    address: addresses.registry,
    abi: "registry",
    fn: "attest",
    from: OUTSIDER,
    args: () => [PASSPORT, true, 0, ZERO32],
    expected: "NotReceiver",
    answer: "refused",
    reverts: "registry",
    copyIn: null,
    test: { file: REGISTRY_TEST, name: "test_attestRejectsAnAddressThePolicyDoesNotList" },
    saved: "docs/security/attacks/attest-from-stranger.txt",
  },
  {
    id: "report-from-fake-forwarder",
    what: "Deliver a well formed Chainlink report from the wrong sender",
    contract: "MoolamReceiver",
    address: addresses.receiver,
    abi: "receiver",
    fn: "onReport",
    from: OUTSIDER,
    // The report is well formed: the right chain, a current timestamp and a
    // real passport. Only the sender is wrong, and that is enough.
    args: (now, encode) => ["0x", encode.report(PASSPORT, now)],
    expected: "InvalidSender",
    answer: "refused",
    reverts: "none",
    copyIn: null,
    test: { file: RECEIVER_TEST, name: "test_aReportFromAnyOtherAddressIsRefused" },
    saved: "docs/security/attacks/report-from-fake-forwarder.txt",
  },
  {
    id: "expired-deadline",
    what: "Register a picture with a deadline that passed a minute ago",
    contract: "MoolamRegistry",
    address: addresses.registry,
    abi: "registry",
    fn: "register",
    from: CREATOR,
    args: (now) => [passportInput({ deadline: now - 60n }), NO_ASSERTION, "0x"],
    expected: "SignatureExpired",
    answer: "refused",
    reverts: "registry",
    copyIn: "studio.failure",
    test: { file: REGISTRY_TEST, name: "test_registerRejectsAPassedDeadline" },
    saved: "docs/security/attacks/expired-deadline.txt",
  },
  {
    id: "control",
    what: "The same statement as the first row, sent by the wallet that does hold the passport",
    contract: "MoolamConsent",
    address: addresses.consent,
    abi: "consent",
    fn: "setConsent",
    from: HOLDER,
    args: () => [PASSPORT, CLOSED, ""],
    expected: null,
    answer: "passes",
    reverts: "none",
    copyIn: null,
    test: { file: CONSENT_TEST, name: "test_theHolderStatesWhatAiMayDoAndItReadsBack" },
    saved: CONSENT_SAVED,
  },
];

/** A contract on the explorer, on the tab that shows its verified source. */
export function sourceHref(address: Hex): string {
  return `${MONAD_EXPLORER}/address/${address}#code`;
}

/** The file the same attack was saved in, served straight out of the repo. */
export function savedHref(file: string): string {
  return `/docs-files/${file}`;
}

/** The test that pins the rule, on GitHub, at the line the reader can read. */
export function testHref(file: string): string {
  return `https://github.com/ramakrishnanhulk20/Moolam/blob/master/${file}`;
}
