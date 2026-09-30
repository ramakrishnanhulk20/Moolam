import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAddress, type Hex, type TypedDataDomain } from "viem";
import { z } from "zod";
import { MAX_UPLOAD_BYTES } from "../env.js";
import { contentIdOf } from "../ipfs/pinata.js";
import { writeJsonFile } from "../stateDir.js";
import { FILE_ROLES, type FileEntry, type FileRole } from "./files.js";
import { fieldsDigest, signingDigest, type PassportFields } from "./passport.js";

/**
 * 128 bits from the operating system's CSPRNG. A handle is a bearer capability carried in a URL, so
 * guessing one must be hopeless and nothing about one may be derived from another (P4).
 */
const HANDLE_BYTES = 16;

const HANDLE_TEXT = /^[0-9a-f]{32}$/;

/**
 * Past what the daily quotas can leave pending at once. The store refuses a new record rather than
 * walk a folder larger than this on every prepare.
 */
export const MAX_PENDING_RECORDS = 5_000;

/** How long a finished or expired record is kept, so /platform/status can still say what became of it. */
export const KEEP_AFTER_SECONDS = 24n * 60n * 60n;

export type PendingState = "awaiting-creator" | "creator-set" | "signed" | "expired";

const bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const unixSeconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// The same parser on both sides of every later comparison: an address is stored exactly as
// getAddress writes it, and a stored value that is not in that form is refused, never normalised.
const checksummed = z.string().refine((value) => {
  try {
    return getAddress(value) === value;
  } catch {
    return false;
  }
}, "not a checksummed address");
const signature = z.string().regex(/^0x[0-9a-f]{130}$/);

const fieldsSchema = z.strictObject({
  exactHash: bytes32,
  parentId: bytes32,
  generatorAgentId: decimal,
  phash: decimal,
  blockhash256: bytes32,
  manifestHash: bytes32,
  kind: z.literal(0),
  fingerprintVersion: z.literal(1),
  metadataURI: z.string().regex(/^ipfs:\/\/b[a-z2-7]{20,100}$/),
});

const fileSchema = z.strictObject({
  name: z.string().min(1).max(200),
  contentType: z.enum(["image/jpeg", "application/json"]),
  cid: z.string().regex(/^b[a-z2-7]{20,100}$/),
  sha256: bytes32,
  bytes: z.number().int().positive().max(2 * MAX_UPLOAD_BYTES),
});

const base = {
  version: z.literal(1),
  handleHash: bytes32,
  keyHash: bytes32,
  platformName: z.string().min(1).max(200),
  agentId: decimal,
  fields: fieldsSchema,
  files: z.strictObject({ image: fileSchema, thumbnail: fileSchema, manifest: fileSchema, metadata: fileSchema }),
  fieldsDigest: bytes32,
  createdAt: unixSeconds,
  openBy: unixSeconds,
};

/**
 * One schema per state, so a state carries exactly the fields its step has set: a record that says
 * "signed" and has no creator, or "creator-set" and already has a signature, fails the parse, which
 * is how a record that skipped a step is caught on read-back (P3).
 */
const recordSchema = z.discriminatedUnion("state", [
  z.strictObject({
    ...base,
    state: z.literal("awaiting-creator"),
    creator: z.null(),
    deadline: z.null(),
    digest: z.null(),
    agentSignature: z.null(),
  }),
  z.strictObject({
    ...base,
    state: z.literal("creator-set"),
    creator: checksummed,
    deadline: unixSeconds,
    digest: bytes32,
    agentSignature: z.null(),
  }),
  z.strictObject({
    ...base,
    state: z.literal("signed"),
    creator: checksummed,
    deadline: unixSeconds,
    digest: bytes32,
    agentSignature: signature,
    signedAt: unixSeconds,
  }),
  z.strictObject({
    ...base,
    state: z.literal("expired"),
    creator: checksummed.nullable(),
    deadline: unixSeconds.nullable(),
    digest: bytes32.nullable(),
    agentSignature: signature.nullable(),
    expiredAt: unixSeconds,
  }),
]);

export type PendingRecord = z.infer<typeof recordSchema>;

/** The step each state may move to. Nothing moves out of "expired" (P12). */
const NEXT: Record<PendingState, readonly PendingState[]> = {
  "awaiting-creator": ["creator-set", "expired"],
  "creator-set": ["signed", "expired"],
  signed: ["expired"],
  expired: [],
};

/** Fields fixed when a record is made, which no later step may change (P3). */
const FIXED_AT_CREATION = [
  "version",
  "handleHash",
  "keyHash",
  "platformName",
  "agentId",
  "fields",
  "files",
  "fieldsDigest",
  "createdAt",
  "openBy",
] as const;

/** Fields set once by a later step, and never changed after. */
const SET_ONCE = ["creator", "deadline", "digest", "agentSignature"] as const;

export type Opened =
  | { kind: "missing" }
  | { kind: "refused"; reason: string }
  | { kind: "record"; record: PendingRecord };

/** The same record, expired at `at`: everything it had set is kept, so its status can still be read. */
export function expiredFrom(record: PendingRecord, at: bigint): PendingRecord {
  const { state: _state, ...kept } = record;
  const { signedAt: _signedAt, ...rest } = kept as typeof kept & { signedAt?: number };
  return { ...rest, state: "expired", expiredAt: Number(at) } as PendingRecord;
}

/** A new, unguessable handle. It is handed to the platform once and stored only as its sha256. */
export function newHandle(): string {
  return randomBytes(HANDLE_BYTES).toString("hex");
}

/** Whether a string is shaped like a handle this service issues. */
export function isHandle(text: string): boolean {
  return HANDLE_TEXT.test(text);
}

function hashOf(handle: string): Buffer {
  return createHash("sha256").update(Buffer.from(handle, "hex")).digest();
}

/** The handle's sha256 as the record stores it. */
export function handleHash(handle: string): Hex {
  return `0x${hashOf(handle).toString("hex")}`;
}

/**
 * Why a record read back from disk cannot be believed, or null when it can. Every commitment is
 * recomputed from the record's own fields rather than trusted: the stored digests, the metadata id
 * the passport names, the picture hash the passport id is, and the agent the fields carry.
 */
function recordProblem(record: PendingRecord, presented: Buffer, dom: TypedDataDomain): string | null {
  const stored = Buffer.from(record.handleHash.slice(2), "hex");
  if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) {
    return "the record is not the one this handle names";
  }
  if (fieldsDigest(record.fields as PassportFields, dom) !== record.fieldsDigest) {
    return "the record's fields do not hash to the digest stored when it was made";
  }
  if (record.fields.metadataURI !== `ipfs://${record.files.metadata.cid}`) {
    return "the passport names a metadata document other than the one frozen with it";
  }
  if (record.fields.exactHash !== record.files.image.sha256) {
    return "the passport id is not the sha256 of the picture frozen with it";
  }
  if (record.fields.generatorAgentId !== record.agentId) {
    return "the passport names an agent other than the platform's";
  }
  if (record.creator !== null && record.deadline !== null) {
    const recomputed = signingDigest(record.fields as PassportFields, record.creator, BigInt(record.deadline), dom);
    if (recomputed !== record.digest) {
      return "the record's fields, creator and deadline do not hash to its stored digest";
    }
  } else if (record.digest !== null) {
    return "the record holds a digest with no creator or deadline behind it";
  }
  return null;
}

/** Why `next` may not replace `current`, or null when it is the next step and changes nothing fixed. */
function stepProblem(current: PendingRecord, next: PendingRecord): string | null {
  if (!NEXT[current.state].includes(next.state)) {
    return `a record in state ${current.state} cannot move to ${next.state}`;
  }
  for (const key of FIXED_AT_CREATION) {
    if (JSON.stringify(current[key]) !== JSON.stringify(next[key])) {
      return `the step would change ${key}, which was fixed when the record was made`;
    }
  }
  for (const key of SET_ONCE) {
    const before = current[key];
    if (before !== null && before !== next[key]) {
      return `the step would change ${key}, which is set once`;
    }
  }
  return null;
}

export interface PendingStore {
  /** Freezes a new record and its files. Throws when either cannot be written. */
  create: (handle: string, record: PendingRecord, files: Record<FileRole, Buffer>) => void;
  /** The record this handle names, checked in full, or why it was refused and dropped. */
  open: (handle: string) => Opened;
  /**
   * Moves a record one step, from `from` only. The record is read again and checked in the same
   * synchronous stretch as the write, so two requests cannot both take the same step.
   */
  advance: (handle: string, from: PendingState, next: (current: PendingRecord) => PendingRecord) => Opened;
  /** One frozen file, refused when its bytes no longer hash to the ids the record names. */
  frozen: (handle: string, record: PendingRecord, role: FileRole) => Buffer;
  /** Removes a record's frozen files, keeping the record itself. */
  dropFiles: (handle: string) => void;
  /** Removes a record and its files. */
  drop: (handle: string) => void;
  /**
   * The frozen bytes one platform holds in records still waiting on a creator or a signature, after
   * clearing out records past KEEP_AFTER_SECONDS. Throws when the folder holds more records than
   * MAX_PENDING_RECORDS, which the route answers as full.
   */
  heldBytes: (keyHash: string, chainNow: bigint) => number;
}

/** A frozen file whose bytes no longer match what the record says was frozen. */
export class FrozenFileChanged extends Error {
  constructor(role: FileRole) {
    super(`the frozen ${role} no longer matches the ids its record names`);
    this.name = "FrozenFileChanged";
  }
}

/** The folder is past MAX_PENDING_RECORDS. */
export class PendingFull extends Error {
  constructor() {
    super("the pending store is full");
    this.name = "PendingFull";
  }
}

/**
 * The pending co-sign store: one JSON record per handle in `dir`, written with writeJsonFile, and the
 * frozen files in a folder beside it. Both are named by the sha256 of the handle, never the handle.
 *
 * Every read runs the record through its state's schema and recomputes its digests; a record that
 * fails either is dropped with its files and answered as refused, never repaired (P3). Every step is
 * checked against the record's current state and against the fields no step may change.
 *
 * Covers a record that was damaged, edited by hand, or written by an older shape. Does not cover
 * someone who can write this folder and recomputes every digest to match: the folder is trusted as
 * far as the process that owns it is.
 */
export function pendingStore(dir: string, dom: TypedDataDomain): PendingStore {
  mkdirSync(dir, { recursive: true });
  const names = (handle: string): { lookup: string; json: string; folder: string } => {
    const lookup = hashOf(handle).toString("hex");
    return { lookup, json: path.join(dir, `${lookup}.json`), folder: path.join(dir, lookup) };
  };
  const fileName = (role: FileRole): string => `${role}.bin`;

  const removeAt = (json: string, folder: string): void => {
    rmSync(folder, { recursive: true, force: true });
    rmSync(json, { force: true });
  };

  const readAt = (json: string, presented: Buffer, folder: string): Opened => {
    let text: string;
    try {
      text = readFileSync(json, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "missing" };
      }
      return { kind: "refused", reason: "the record could not be read" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      removeAt(json, folder);
      return { kind: "refused", reason: "the record is not JSON" };
    }
    const result = recordSchema.safeParse(parsed);
    if (!result.success) {
      removeAt(json, folder);
      return { kind: "refused", reason: "the record does not match the shape of its state" };
    }
    const problem = recordProblem(result.data, presented, dom);
    if (problem !== null) {
      removeAt(json, folder);
      return { kind: "refused", reason: problem };
    }
    return { kind: "record", record: result.data };
  };

  const store: PendingStore = {
    create(handle, record, files) {
      const parsed = recordSchema.parse(record);
      if (parsed.state !== "awaiting-creator") {
        throw new Error("a pending record starts awaiting its creator");
      }
      const problem = recordProblem(parsed, hashOf(handle), dom);
      if (problem !== null) {
        throw new Error(`refusing to freeze a record that would not read back: ${problem}`);
      }
      const { json, folder } = names(handle);
      mkdirSync(folder, { recursive: true });
      for (const role of FILE_ROLES) {
        const target = path.join(folder, fileName(role));
        writeFileSync(`${target}.tmp`, files[role]);
        renameSync(`${target}.tmp`, target);
      }
      // The record goes last, so a record on disk never names files that are not there yet.
      writeJsonFile(json, parsed);
    },

    open(handle) {
      const { json, folder } = names(handle);
      return readAt(json, hashOf(handle), folder);
    },

    advance(handle, from, build) {
      const { json, folder } = names(handle);
      const opened = readAt(json, hashOf(handle), folder);
      if (opened.kind !== "record") {
        return opened;
      }
      if (opened.record.state !== from) {
        return { kind: "refused", reason: `the record is ${opened.record.state}, not ${from}` };
      }
      const candidate = recordSchema.safeParse(build(opened.record));
      if (!candidate.success) {
        return { kind: "refused", reason: "the next step does not match the shape of its state" };
      }
      const problem = stepProblem(opened.record, candidate.data) ?? recordProblem(candidate.data, hashOf(handle), dom);
      if (problem !== null) {
        return { kind: "refused", reason: problem };
      }
      writeJsonFile(json, candidate.data);
      return { kind: "record", record: candidate.data };
    },

    frozen(handle, record, role) {
      const { folder } = names(handle);
      let bytes: Buffer;
      try {
        bytes = readFileSync(path.join(folder, fileName(role)));
      } catch {
        throw new FrozenFileChanged(role);
      }
      const entry: FileEntry = record.files[role];
      const sha256 = `0x${createHash("sha256").update(bytes).digest("hex")}`;
      if (bytes.length !== entry.bytes || sha256 !== entry.sha256 || contentIdOf(bytes) !== entry.cid) {
        throw new FrozenFileChanged(role);
      }
      return bytes;
    },

    dropFiles(handle) {
      rmSync(names(handle).folder, { recursive: true, force: true });
    },

    drop(handle) {
      const { json, folder } = names(handle);
      removeAt(json, folder);
    },

    heldBytes(keyHash, chainNow) {
      const entries = readdirSync(dir).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
      if (entries.length > MAX_PENDING_RECORDS) {
        throw new PendingFull();
      }
      let held = 0;
      for (const name of entries) {
        const json = path.join(dir, name);
        const folder = json.slice(0, -".json".length);
        let record: PendingRecord;
        try {
          record = recordSchema.parse(JSON.parse(readFileSync(json, "utf8")));
        } catch {
          // A record nobody can read cannot be continued either, so it goes; this is housekeeping,
          // and the handle's own read would have refused and dropped it the same way.
          removeAt(json, folder);
          continue;
        }
        const endsAt = BigInt(record.deadline ?? record.openBy);
        if (endsAt + KEEP_AFTER_SECONDS < chainNow) {
          removeAt(json, folder);
          continue;
        }
        if (record.keyHash === keyHash && (record.state === "awaiting-creator" || record.state === "creator-set")) {
          held += FILE_ROLES.reduce((sum, role) => sum + record.files[role].bytes, 0);
        }
      }
      return held;
    },
  };
  return store;
}
