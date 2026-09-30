import { getAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { registryAbi } from "./abi.js";
import {
  assertPlatformFields,
  cosignPrepareAnswer,
  passportInputFrom,
  recordAnswer,
  type FilesAnswer,
  type PassportFieldsAnswer,
  type RecordAnswer,
} from "./answers.js";
import { assertMonad, chainNow, type ChainReader } from "./chain.js";
import { MOOLAM_REGISTRY, MOOLAM_SITE_URL } from "./constants.js";
import { passportDigest, passportTypedData, type PassportInput } from "./eip712.js";
import { MoolamPlatformError } from "./errors.js";
import { PREPARE_TIMEOUT_MS, assertTitle, prepareForm, signPlatformPrepare, type AgentAccount } from "./prepare.js";
import { callService, checkedUrl, type ServiceTarget } from "./service.js";
import { assertTerms, sameTerms, type AiUseTerms } from "./terms.js";

const STATUS_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 3_000;
/** The co-sign link is open 30 minutes and the signature window another 30, so an hour covers both. */
const DEFAULT_WAIT_MS = 60 * 60 * 1000;

export interface StartCosignOptions {
  verifyUrl: string;
  platformKey: string;
  agentAccount: AgentAccount;
  /** A viem public client on Monad, for chain time and the final chain read. */
  publicClient: ChainReader;
  /** The picture's title, 1 to 120 characters. */
  title: string;
  /** The AI-use terms the person will see and sign under. Leave out to state none. */
  terms?: AiUseTerms;
  /** The Moolam site the person opens. Defaults to the live one. */
  siteUrl?: string;
}

/**
 * What resumeCosign needs: startCosign's options without the picture's title and terms, which the
 * record already fixed when it was made.
 */
export type ResumeCosignOptions = Omit<StartCosignOptions, "title" | "terms">;

const HANDLE = /^[0-9a-f]{32}$/;

/**
 * One picture waiting for its person. Safe to log and to store: it carries no key, and the handle
 * inside cosignUrl is the capability the person needs, so share it with that person only (P4).
 */
export interface CosignHandle {
  readonly handle: string;
  readonly cosignUrl: string;
  /** The passport id the picture will have: the sha256 of Moolam's signed copy. */
  readonly passportId: Hex;
  /** Chain time, in unix seconds, after which an unopened link is dead. */
  readonly openBy: number;
}

export interface WaitOptions {
  pollMs?: number;
  timeoutMs?: number;
}

export interface CosignedPassport {
  passportId: Hex;
  creator: Address;
  registeredAt: bigint;
}

/** What the kit remembers about a handle. Kept off the handle so the key never rides with it. */
interface CosignSession {
  target: ServiceTarget;
  agentAccount: AgentAccount;
  reader: ChainReader;
  fields: PassportFieldsAnswer;
  files: FilesAnswer;
  terms: AiUseTerms | undefined;
  creatorSet?: { creator: Address; deadline: bigint; digest: Hex };
}

const sessions = new WeakMap<CosignHandle, CosignSession>();

function sessionOf(handle: CosignHandle): CosignSession {
  const session = sessions.get(handle);
  if (session === undefined) {
    throw new MoolamPlatformError("invalid-input", "this handle did not come from startCosign in this process");
  }
  return session;
}

/**
 * Starts a co-sign: the agent owner signs a PlatformPrepare in co-sign mode, the service signs the
 * manifest and freezes the files without pinning them (P6), and the kit returns the handle and the
 * link the platform gives its user.
 *
 * Throws MoolamPlatformError: "invalid-input", "invalid-terms", "wrong-chain", the service errors
 * from callService, "terms-mismatch", and "unexpected-answer" for fields a platform passport cannot have.
 */
export async function startCosign(file: Uint8Array, options: StartCosignOptions): Promise<CosignHandle> {
  const { agentAccount, publicClient: reader, terms } = options;
  assertTitle(options.title);
  if (terms !== undefined) {
    assertTerms(terms);
  }
  const site = checkedUrl(options.siteUrl ?? MOOLAM_SITE_URL, "siteUrl");
  const target: ServiceTarget = { verifyUrl: options.verifyUrl, platformKey: options.platformKey };
  await assertMonad(reader);

  const signed = await signPlatformPrepare({ file, mode: "cosign", platformKey: target.platformKey, agentAccount, reader });
  const answer = await callService(
    target,
    {
      method: "POST",
      path: "/platform/prepare",
      what: "the co-sign prepare",
      body: prepareForm(file, "cosign", options.title, signed, terms),
      timeoutMs: PREPARE_TIMEOUT_MS,
    },
    cosignPrepareAnswer,
  );
  if (!sameTerms(terms, answer.training)) {
    throw new MoolamPlatformError("terms-mismatch", "the terms written into the manifest are not the terms the platform sent");
  }
  assertPlatformFields(answer.passport, answer.files);

  const handle = handleFor(site, answer.handle, answer.passport.exactHash, answer.openBy);
  sessions.set(handle, { target, agentAccount, reader, fields: answer.passport, files: answer.files, terms });
  return handle;
}

function handleFor(site: URL, handle: string, passportId: Hex, openBy: number): CosignHandle {
  const link = new URL(site);
  link.pathname = `${link.pathname.replace(/\/+$/, "")}/cosign/${handle}`;
  return Object.freeze({ handle, cosignUrl: link.toString(), passportId, openBy });
}

/**
 * Picks a co-sign up again after the platform restarted and lost the handle startCosign returned:
 * reads GET /platform/status for the handle and returns a handle of the same shape, so
 * waitForCreator, signAsAgent and waitForPassport carry on from wherever the record is. The fields
 * are taken from the record as the service holds it and pass the same checks a prepare's do; the
 * digest waitForCreator rebuilds from them is still compared with the service's before anything is
 * signed. The platform key goes only in the Authorization header.
 *
 * Throws MoolamPlatformError: "invalid-input" for a handle that is not 32 hex characters, "wrong-chain",
 * the service errors from callService (a handle this key did not make is "service-refused" 404),
 * "cosign-expired", "passport-taken", and "unexpected-answer" for fields a platform passport cannot have.
 */
export async function resumeCosign(handle: string, options: ResumeCosignOptions): Promise<CosignHandle> {
  if (typeof handle !== "string" || !HANDLE.test(handle)) {
    throw new MoolamPlatformError("invalid-input", "a co-sign handle is the 32 hex characters startCosign returned");
  }
  const { agentAccount, publicClient: reader } = options;
  const site = checkedUrl(options.siteUrl ?? MOOLAM_SITE_URL, "siteUrl");
  const target: ServiceTarget = { verifyUrl: options.verifyUrl, platformKey: options.platformKey };
  await assertMonad(reader);

  const record = await callService(
    target,
    { method: "GET", path: `/platform/status/${handle}`, what: "the co-sign status", timeoutMs: STATUS_TIMEOUT_MS },
    recordAnswer,
  );
  refuseEnded(record);
  const { creator: _creator, deadline: _deadline, ...fields } = record.passport;
  if (record.exactHash !== fields.exactHash) {
    throw new MoolamPlatformError("unexpected-answer", "the co-sign record names two different passport ids");
  }
  assertPlatformFields(fields, record.files);

  const resumed = handleFor(site, handle, fields.exactHash, record.openBy);
  sessions.set(resumed, { target, agentAccount, reader, fields, files: record.files, terms: undefined });
  return resumed;
}

async function readStatus(handle: CosignHandle, session: CosignSession): Promise<RecordAnswer> {
  return await callService(
    session.target,
    { method: "GET", path: `/platform/status/${handle.handle}`, what: "the co-sign status", timeoutMs: STATUS_TIMEOUT_MS },
    recordAnswer,
  );
}

/**
 * Whether a record's fields are still the ones the prepare answered. Every field is fixed when the
 * record is made (P3), so any change means the record is not the one this handle started.
 */
function sameFields(record: RecordAnswer, session: CosignSession): boolean {
  const a = record.passport;
  const b = session.fields;
  return (
    record.exactHash === b.exactHash &&
    a.exactHash === b.exactHash &&
    a.parentId === b.parentId &&
    a.generatorAgentId === b.generatorAgentId &&
    a.phash === b.phash &&
    a.blockhash256 === b.blockhash256 &&
    a.manifestHash === b.manifestHash &&
    a.kind === b.kind &&
    a.fingerprintVersion === b.fingerprintVersion &&
    a.metadataURI === b.metadataURI
  );
}

function refuseEnded(record: RecordAnswer): void {
  if (record.state === "expired") {
    throw new MoolamPlatformError("cosign-expired", "the co-sign ran out of time on chain before it finished");
  }
  if (record.state === "failed") {
    throw new MoolamPlatformError("passport-taken", "another passport already holds this picture", { reason: record.reason });
  }
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls the co-sign status until the person has opened the link and their wallet is the creator,
 * then returns the passport digest the agent must sign. The digest is recomputed here from the
 * record's fields, creator and deadline, and refused unless it equals the service's, and the fields
 * must be the ones the prepare answered.
 *
 * Throws MoolamPlatformError: "cosign-expired", "passport-taken", "digest-mismatch",
 * "unexpected-answer" for changed fields or an unknown state, "timed-out", and the service errors.
 */
export async function waitForCreator(handle: CosignHandle, wait: WaitOptions = {}): Promise<Hex> {
  const session = sessionOf(handle);
  const giveUpAt = Date.now() + (wait.timeoutMs ?? DEFAULT_WAIT_MS);
  for (;;) {
    const record = await readStatus(handle, session);
    refuseEnded(record);
    if (!sameFields(record, session)) {
      throw new MoolamPlatformError("unexpected-answer", "the co-sign record's fields changed after the prepare");
    }
    if (record.state !== "awaiting-creator") {
      if (!["creator-set", "signed", "registered"].includes(record.state)) {
        throw new MoolamPlatformError("unexpected-answer", `the co-sign record is in a state the kit does not know: ${record.state.slice(0, 40)}`);
      }
      const { creator, deadline } = record.passport;
      if (creator === undefined || deadline === undefined || record.digest === undefined) {
        throw new MoolamPlatformError("unexpected-answer", "the co-sign record has a creator state with no creator, deadline or digest");
      }
      const digest = passportDigest(passportInputFrom(session.fields, session.files, creator, deadline));
      if (digest !== record.digest) {
        throw new MoolamPlatformError("digest-mismatch", "the service's digest is not the digest of the record's fields, creator and deadline", {
          local: digest,
          service: record.digest,
        });
      }
      session.creatorSet = { creator, deadline, digest };
      return digest;
    }
    if (Date.now() + (wait.pollMs ?? DEFAULT_POLL_MS) > giveUpAt) {
      throw new MoolamPlatformError("timed-out", "nobody opened the co-sign link in the time given");
    }
    await pause(wait.pollMs ?? DEFAULT_POLL_MS);
  }
}

/**
 * Signs the passport digest as the platform's agent and posts the signature, after which the service
 * pins the frozen files and the person's page may ask for their passkey. The digest passed in must be
 * the one waitForCreator returned; the kit signs the typed data it rebuilt, never a bare hash.
 *
 * Throws MoolamPlatformError: "creator-not-set" before waitForCreator, "digest-mismatch",
 * "deadline-passed", the service errors, and "unexpected-answer" when the answer does not show this
 * very signature stored.
 */
export async function signAsAgent(handle: CosignHandle, digest: Hex): Promise<Hex> {
  const session = sessionOf(handle);
  const set = session.creatorSet;
  if (set === undefined) {
    throw new MoolamPlatformError("creator-not-set", "wait for the creator before signing");
  }
  if (typeof digest !== "string" || digest.toLowerCase() !== set.digest) {
    throw new MoolamPlatformError("digest-mismatch", "that digest is not the one the kit rebuilt for this record");
  }
  if (set.deadline <= (await chainNow(session.reader))) {
    throw new MoolamPlatformError("deadline-passed", "the co-sign deadline has passed on chain");
  }
  const input: PassportInput = passportInputFrom(session.fields, session.files, set.creator, set.deadline);
  const typed = passportTypedData(input);
  const signature = await session.agentAccount.signTypedData(typed);
  if ((await recoverTypedDataAddress({ ...typed, signature })) !== getAddress(session.agentAccount.address)) {
    throw new MoolamPlatformError("unexpected-answer", "the agent account signed the passport with another key");
  }
  const answer = await callService(
    session.target,
    {
      method: "POST",
      path: `/platform/sign/${handle.handle}`,
      what: "the agent signature",
      body: { signature },
      timeoutMs: PREPARE_TIMEOUT_MS,
    },
    recordAnswer,
  );
  if (answer.state !== "signed" || answer.agentSignature !== signature.toLowerCase()) {
    throw new MoolamPlatformError("unexpected-answer", "the service did not answer with this signature stored");
  }
  return signature;
}

/**
 * Polls until the service says the passport is registered, then reads the registry itself and
 * returns only when the chain holds this very passport: this creator, this agent, this manifest and
 * this metadata (P13).
 *
 * Throws MoolamPlatformError: "cosign-expired", "passport-taken" (also when the chain holds a
 * different passport under this id), "timed-out", and the service errors.
 */
export async function waitForPassport(handle: CosignHandle, wait: WaitOptions = {}): Promise<CosignedPassport> {
  const session = sessionOf(handle);
  const giveUpAt = Date.now() + (wait.timeoutMs ?? DEFAULT_WAIT_MS);
  for (;;) {
    const record = await readStatus(handle, session);
    refuseEnded(record);
    if (record.state === "registered") {
      const set = session.creatorSet;
      const creator = set?.creator ?? record.passport.creator;
      if (creator === undefined) {
        throw new MoolamPlatformError("unexpected-answer", "the service says registered for a record with no creator");
      }
      const onChain = await session.reader.readContract({
        address: MOOLAM_REGISTRY,
        abi: registryAbi,
        functionName: "getPassport",
        args: [handle.passportId],
      });
      const ours =
        onChain.registeredAt !== 0n &&
        getAddress(onChain.creator) === creator &&
        onChain.generatorAgentId === session.fields.generatorAgentId &&
        onChain.manifestHash.toLowerCase() === session.fields.manifestHash &&
        onChain.metadataURI === session.fields.metadataURI;
      if (!ours) {
        throw new MoolamPlatformError("passport-taken", "the chain does not hold this passport under its id");
      }
      return { passportId: handle.passportId, creator, registeredAt: onChain.registeredAt };
    }
    if (Date.now() + (wait.pollMs ?? DEFAULT_POLL_MS) > giveUpAt) {
      throw new MoolamPlatformError("timed-out", "the passport did not land in the time given");
    }
    await pause(wait.pollMs ?? DEFAULT_POLL_MS);
  }
}
