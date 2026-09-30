import { getAddress, isAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { ZERO_BYTES32 } from "./constants.js";
import type { PassportInput } from "./eip712.js";
import { MoolamPlatformError } from "./errors.js";
import { MAX_SIGNED_FILE_BYTES } from "./service.js";
import type { AiUseTerms } from "./terms.js";

// Every answer from the verify service is input to a transaction the platform pays for, so it is
// parsed as strictly as the service parses a request. Hex is lower-cased and addresses checksummed
// here, once, so every later comparison sees both sides in the same form.

const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as Hex);
const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .transform((value) => BigInt(value));
const address = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), "not an address")
  .transform((value) => getAddress(value) as Address);
const signature = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/)
  .transform((value) => value.toLowerCase() as Hex);
const use = z.enum(["allowed", "notAllowed", "constrained"]);

const passportFields = {
  exactHash: bytes32,
  parentId: bytes32,
  generatorAgentId: decimal,
  phash: decimal,
  blockhash256: bytes32,
  manifestHash: bytes32,
  kind: z.literal(0),
  fingerprintVersion: z.literal(1),
  metadataURI: z.string().regex(/^ipfs:\/\/b[a-z2-7]{20,100}$/),
};

const fileAnswer = z.object({
  cid: z.string().regex(/^b[a-z2-7]{20,100}$/),
  uri: z.string(),
  gatewayUrl: z.string().min(1).max(2048),
  bytes: z.number().int().positive(),
});

const filesAnswer = z.object({ image: fileAnswer, thumbnail: fileAnswer, manifest: fileAnswer, metadata: fileAnswer });

/**
 * Moolam's signed copy of the picture, as the platform-mode prepare hands it back: strict base64 no
 * longer than the upload limit written as base64. Its sha256 is checked against the passport id by
 * the caller, from the decoded bytes, never taken from the answer's own sha256 field alone.
 */
const signedFileAnswer = z.object({
  name: z.string().min(1).max(300),
  type: z.string().min(1).max(100),
  bytes: z
    .string()
    .min(4)
    .max(Math.ceil(MAX_SIGNED_FILE_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .refine((text) => text.length % 4 === 0, "not whole base64"),
  sha256: bytes32,
});

/** The statement the service wrote into the manifest and metadata. Any field beyond these is a mismatch. */
const trainingAnswer = z
  .strictObject({
    aiTraining: use.optional(),
    aiGenerativeTraining: use.optional(),
    aiInference: use.optional(),
    dataMining: use.optional(),
    constraintInfo: z.string().optional(),
    standard: z.literal("cawg.training-mining/1.1"),
  })
  .transform(({ standard: _standard, ...terms }): AiUseTerms => terms);

const platformAnswer = z.object({ name: z.string(), agentId: decimal });

export const platformPrepareAnswer = z.object({
  mode: z.literal("platform"),
  passport: z.object({ ...passportFields, creator: address, deadline: decimal }),
  digest: bytes32,
  files: filesAnswer,
  signedFile: signedFileAnswer,
  training: trainingAnswer.optional(),
  platform: platformAnswer,
});

export const cosignPrepareAnswer = z.object({
  mode: z.literal("cosign"),
  handle: z.string().regex(/^[0-9a-f]{32}$/),
  passport: z.object(passportFields),
  files: filesAnswer,
  openBy: z.number().int().nonnegative(),
  training: trainingAnswer.optional(),
  platform: platformAnswer,
});

/** A co-sign record as /platform/status and /platform/sign answer it. */
export const recordAnswer = z.object({
  state: z.string(),
  exactHash: bytes32,
  passport: z.object({ ...passportFields, creator: address.optional(), deadline: decimal.optional() }),
  files: filesAnswer,
  openBy: z.number().int().nonnegative(),
  digest: bytes32.optional(),
  agentSignature: signature.optional(),
  registeredAt: decimal.optional(),
  reason: z.string().max(500).optional(),
  chain: z.string().optional(),
});

export type PlatformPrepareAnswer = z.infer<typeof platformPrepareAnswer>;
export type CosignPrepareAnswer = z.infer<typeof cosignPrepareAnswer>;
export type RecordAnswer = z.infer<typeof recordAnswer>;
export type FilesAnswer = z.infer<typeof filesAnswer>;
export type PassportFieldsAnswer = CosignPrepareAnswer["passport"];

/**
 * The checks a platform passport's fields must pass before anyone signs them, beyond the schema's
 * Generated kind and fingerprint version: an original (no parent), naming as its metadata the very
 * document whose id the service computed.
 *
 * Throws MoolamPlatformError "unexpected-answer" when either fails.
 */
export function assertPlatformFields(fields: PassportFieldsAnswer, files: FilesAnswer): void {
  if (fields.parentId !== ZERO_BYTES32) {
    throw new MoolamPlatformError("unexpected-answer", "a platform passport is an original, and the answer names a parent");
  }
  if (fields.metadataURI !== `ipfs://${files.metadata.cid}`) {
    throw new MoolamPlatformError("unexpected-answer", "the passport names a metadata document other than the one the answer lists");
  }
}

/** The registry struct from checked fields plus the creator and deadline. Throws as assertPlatformFields does. */
export function passportInputFrom(
  fields: PassportFieldsAnswer,
  files: FilesAnswer,
  creator: Address,
  deadline: bigint,
): PassportInput {
  assertPlatformFields(fields, files);
  return {
    exactHash: fields.exactHash,
    parentId: fields.parentId,
    creator,
    generatorAgentId: fields.generatorAgentId,
    phash: fields.phash,
    blockhash256: fields.blockhash256,
    manifestHash: fields.manifestHash,
    kind: fields.kind,
    fingerprintVersion: fields.fingerprintVersion,
    metadataURI: fields.metadataURI,
    deadline,
  };
}
