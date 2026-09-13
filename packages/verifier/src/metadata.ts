import type { Hex } from "./fingerprint.js";
import type { Fingerprint } from "./fingerprint.js";
import type { PreparedImage } from "./prepare.js";

/** The fingerprint recipe the registry records. Bump it only when the hashes themselves change. */
export const FINGERPRINT_VERSION = 1;

/**
 * The canonical ERC-8004 Identity Registry. The same address on every chain that has one, which
 * is why it can be a constant here rather than a deployment artefact the container has to carry.
 */
export const AGENT_IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Hex;

/** IPTC digital source types: what made the picture. C2PA readers key their labels off these. */
export const AI_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";
export const CAPTURE_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture";

export const GENERATED_DESCRIPTION =
  "An image made by the Moolam demo generator agent. The agent signed this fingerprint with the wallet that owns its ERC-8004 identity, and the creator signed it with a passkey, before the registry would write the record.";

export const CAPTURED_DESCRIPTION =
  "A picture registered with Moolam from a file its creator uploaded. The creator signed this fingerprint with a passkey before the registry would write the record.";

export interface PassportMetadata {
  name: string;
  description: string;
  image: string;
  thumbnail: string;
  manifest?: string;
  prompt?: string;
  generator: { agentId: string; registry: Hex };
  fingerprint: { phash: string; blockhash: Hex; version: 1 };
  createdAt: string;
}

export interface PassportMetadataInput {
  title: string;
  description: string;
  image: string;
  thumbnail: string;
  /** Left out when the picture carries no manifest we could pin next to it. */
  manifest?: string;
  prompt?: string;
  agentId: bigint;
  /** Defaults to the canonical ERC-8004 registry; the seed passes the address it deployed against. */
  identityRegistry?: Hex;
  fingerprint: Fingerprint;
  createdAt?: Date;
}

/**
 * The document a passport's metadataURI points at.
 *
 * The seed, the generator agent and the studio all build it here so the three routes into the
 * registry pin the same shape. Anything reading a passport can then expect the same keys whoever
 * created it.
 */
export function passportMetadata(input: PassportMetadataInput): PassportMetadata {
  return {
    name: input.title,
    description: input.description,
    image: input.image,
    thumbnail: input.thumbnail,
    manifest: input.manifest,
    prompt: input.prompt,
    generator: {
      agentId: input.agentId.toString(),
      registry: input.identityRegistry ?? AGENT_IDENTITY_REGISTRY,
    },
    fingerprint: {
      phash: phashHex(input.fingerprint.phash),
      blockhash: input.fingerprint.blockhash,
      version: FINGERPRINT_VERSION,
    },
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  };
}

/** The 64 bit perceptual hash as it reads in the metadata and in the logs. */
export function phashHex(phash: bigint): string {
  return `0x${phash.toString(16).padStart(16, "0")}`;
}

/**
 * The readable copy of the C2PA manifest that gets pinned next to the image.
 *
 * The signed image itself carries the real manifest store; this document is the summary plus the
 * sha256 the chain commits to, so anyone can line the two up without a C2PA reader.
 */
export function manifestDocument(prepared: PreparedImage): unknown {
  const binding = prepared.manifest.softBinding;
  return {
    manifestHash: prepared.manifestHash,
    title: prepared.manifest.title,
    claimGenerator: prepared.manifest.claimGenerator,
    actions: prepared.manifest.actions,
    ingredients: prepared.manifest.ingredients,
    softBinding:
      binding === undefined
        ? undefined
        : { alg: binding.alg, phash: phashHex(binding.phash), blockhash: binding.blockhash },
    note: "manifestHash is the sha256 of the C2PA manifest store embedded in the image this document sits next to, and it is the value recorded on chain.",
  };
}

/** A file name a judge can read on the gateway: the title, then enough of the passport id to be unique. */
export function fileSlug(title: string, passportId: Hex): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${words.length === 0 ? "moolam" : words}-${passportId.slice(2, 10)}`;
}
