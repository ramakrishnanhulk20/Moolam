import { getAddress, zeroAddress, type Hex, type TypedDataDomain } from "viem";
import { Kind, passportDigest, type PassportInput } from "../generate/eip712.js";
import { generatorDomain } from "../generate/generatorSigner.js";
import { FINGERPRINT_VERSION } from "../metadata.js";

/**
 * How long a creator has between the fields being fixed and the registry refusing them: the web
 * app's SIGNATURE_WINDOW_SECONDS, read against chain time here (P12). The registry itself sets no
 * upper bound; it only refuses a deadline that has passed.
 */
export const SIGNATURE_WINDOW_SECONDS = 30n * 60n;

/**
 * Every field of a platform passport except the two only a co-signer can fix, the creator and the
 * deadline. Numbers travel as decimal strings, the form they are stored and answered in.
 */
export interface PassportFields {
  exactHash: Hex;
  parentId: Hex;
  generatorAgentId: string;
  phash: string;
  blockhash256: Hex;
  manifestHash: Hex;
  kind: typeof Kind.Generated;
  fingerprintVersion: typeof FINGERPRINT_VERSION;
  metadataURI: string;
}

/** The struct the registry's hashPassport reads, from the fields plus a creator and a deadline. */
export function passportInput(fields: PassportFields, creator: string, deadline: bigint): PassportInput {
  return {
    exactHash: fields.exactHash,
    parentId: fields.parentId,
    creator: getAddress(creator),
    generatorAgentId: BigInt(fields.generatorAgentId),
    phash: BigInt(fields.phash),
    blockhash256: fields.blockhash256,
    manifestHash: fields.manifestHash,
    kind: fields.kind,
    fingerprintVersion: fields.fingerprintVersion,
    metadataURI: fields.metadataURI,
    deadline,
  };
}

/** The deployed registry's EIP-712 domain, the one hashPassport is computed in. */
export function registryDomain(): TypedDataDomain {
  return generatorDomain();
}

/**
 * The digest the creator's key and the agent both sign: the registry's hashPassport, computed by the
 * same encoder /generate signs with.
 */
export function signingDigest(fields: PassportFields, creator: string, deadline: bigint, dom: TypedDataDomain = registryDomain()): Hex {
  return passportDigest(passportInput(fields, creator, deadline), dom);
}

/**
 * The same digest with no creator and no deadline, stored when a co-sign record is made. It is what
 * a record's fields are checked against before a creator exists to put into the real one.
 */
export function fieldsDigest(fields: PassportFields, dom: TypedDataDomain = registryDomain()): Hex {
  return passportDigest(passportInput(fields, zeroAddress, 0n), dom);
}

/** The passport as an answer carries it: every number a decimal string, the creator checksummed. */
export function passportAnswer(fields: PassportFields, creator?: string, deadline?: bigint): Record<string, unknown> {
  return {
    exactHash: fields.exactHash,
    parentId: fields.parentId,
    ...(creator === undefined ? {} : { creator: getAddress(creator) }),
    generatorAgentId: fields.generatorAgentId,
    phash: fields.phash,
    blockhash256: fields.blockhash256,
    manifestHash: fields.manifestHash,
    kind: fields.kind,
    fingerprintVersion: fields.fingerprintVersion,
    metadataURI: fields.metadataURI,
    ...(deadline === undefined ? {} : { deadline: deadline.toString() }),
  };
}
