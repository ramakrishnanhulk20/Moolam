import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { env } from "./env";

/**
 * The pictures Dreamloom keeps: one JSON record and one image file per picture, in
 * DATA_DIR/pictures. Every read and write here is synchronous on purpose: Node runs one callback at
 * a time, so a read, a check and a write with no await between them cannot interleave with another
 * request's, and that is what makes a picture registered once and moved once (D2).
 */

/** Past this many pictures the oldest is removed with its file. The site keeps pictures only for the demo. */
export const MAX_PICTURES = 500;

export const PICTURE_STATES = ["woven", "cosign-open", "cosign-signed", "registered", "moved", "failed"] as const;
export type PictureState = (typeof PICTURE_STATES)[number];

/**
 * The only moves a record can make. Nothing goes back, nothing repeats, and "moved" and "failed"
 * are the end.
 */
const NEXT: Record<PictureState, readonly PictureState[]> = {
  woven: ["cosign-open", "registered", "failed"],
  "cosign-open": ["cosign-signed", "registered", "failed"],
  "cosign-signed": ["registered", "failed"],
  registered: ["moved", "failed"],
  moved: [],
  failed: [],
};

export type Busy = "register" | "move" | "cosign";

const ID = /^[0-9a-f]{32}$/;
const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);

const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;
export type ImageType = keyof typeof IMAGE_TYPES;

const recordSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(ID),
  sessionHash: z.string().regex(/^[0-9a-f]{64}$/),
  prompt: z.string().min(1).max(600),
  createdAt: z.iso.datetime(),
  contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  state: z.enum(PICTURE_STATES),
  /** Set before an SDK call and cleared by the transition that call ends in, so a second request waits its turn. */
  busy: z.enum(["register", "move", "cosign"]).optional(),
  /** When the claim was taken, so a claim a dead process left behind can be told from a live one. */
  busyAt: z.iso.datetime().optional(),
  /** The title the picture was registered or offered for co-signing under, public for good once used. */
  title: z.string().min(1).max(120).optional(),
  mode: z.enum(["platform", "cosign"]).optional(),
  /** The co-sign capability. It stays on the volume and is never logged (D5). */
  cosign: z
    .strictObject({
      handle: z.string().regex(/^[0-9a-f]{32}$/),
      cosignUrl: z.string().min(1).max(2048),
      openBy: z.number().int().nonnegative(),
    })
    .optional(),
  passportId: hex32.optional(),
  registerTx: hex32.optional(),
  consentTx: hex32.optional(),
  moveTx: hex32.optional(),
  movedTo: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  failure: z.string().regex(/^[a-z-]{1,32}$/).optional(),
});

export type PictureRecord = z.infer<typeof recordSchema>;

/** What a transition may write. The state, the owner and the prompt are never among them. */
export type TransitionFields = Partial<
  Pick<PictureRecord, "title" | "mode" | "cosign" | "passportId" | "registerTx" | "consentTx" | "moveTx" | "movedTo" | "failure">
>;

function picturesDir(): string {
  return path.join(env().dataDir, "pictures");
}

function recordPath(id: string): string {
  return path.join(picturesDir(), `${id}.json`);
}

function imagePath(record: Pick<PictureRecord, "id" | "contentType">): string {
  return path.join(picturesDir(), `${record.id}.${IMAGE_TYPES[record.contentType]}`);
}

/**
 * Writes under a temp name and renames it over the target, so a process killed mid-write leaves
 * the previous file whole. The verify service's writeJsonFile pattern: one writer, no fsync.
 */
export function writeAtomic(filePath: string, data: string | Uint8Array): void {
  const temp = `${filePath}.tmp`;
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(temp, data);
  renameSync(temp, filePath);
}

function writeRecord(record: PictureRecord): void {
  writeAtomic(recordPath(record.id), `${JSON.stringify(recordSchema.parse(record))}\n`);
}

/** The picture's type read from its first bytes, or null when it is none of the three a browser shows. */
export function imageType(bytes: Uint8Array): ImageType | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * A record as stored, or null for an id that is not 32 hex characters, a missing file, or a file
 * that fails the schema. An unreadable record is treated as absent, never repaired.
 */
export function readPicture(id: string): PictureRecord | null {
  if (typeof id !== "string" || !ID.test(id)) return null;
  let raw: string;
  try {
    raw = readFileSync(recordPath(id), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = recordSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.id === id ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Every readable record, oldest first. At most MAX_PICTURES of them exist. */
export function listPictures(): PictureRecord[] {
  let names: string[];
  try {
    names = readdirSync(picturesDir());
  } catch {
    return [];
  }
  const records: PictureRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = readPicture(name.slice(0, -".json".length));
    if (record !== null) records.push(record);
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function removePicture(record: PictureRecord): void {
  rmSync(imagePath(record), { force: true });
  rmSync(recordPath(record.id), { force: true });
}

/**
 * Stores a newly woven picture and its record, then removes the oldest pictures past MAX_PICTURES.
 * The id is 128 bits from the CSPRNG and is never the session.
 *
 * Throws when the bytes are not a PNG, JPEG or WebP, or when the folder cannot be written.
 */
export function createPicture(input: { sessionHash: string; prompt: string; bytes: Uint8Array }): PictureRecord {
  const contentType = imageType(input.bytes);
  if (contentType === null) {
    throw new Error("the picture is not a PNG, JPEG or WebP");
  }
  const record: PictureRecord = {
    version: 1,
    id: randomBytes(16).toString("hex"),
    sessionHash: input.sessionHash,
    prompt: input.prompt,
    createdAt: new Date().toISOString(),
    contentType,
    state: "woven",
  };
  writeAtomic(imagePath(record), input.bytes);
  writeRecord(record);

  const all = listPictures();
  for (const old of all.slice(0, Math.max(0, all.length - MAX_PICTURES))) {
    if (old.id !== record.id) removePicture(old);
  }
  return record;
}

/** The picture's bytes, or null when the file is gone. */
export function readImage(record: PictureRecord): Buffer | null {
  try {
    return readFileSync(imagePath(record));
  } catch {
    return null;
  }
}

/**
 * Marks a picture busy with one action, only when its state is one of `from` and no other action
 * holds it. Returns the record as claimed, or null when the state is wrong, it is busy, or it is gone.
 */
export function claimPicture(id: string, from: readonly PictureState[], busy: Busy): PictureRecord | null {
  const record = readPicture(id);
  if (record === null || record.busy !== undefined || !from.includes(record.state)) return null;
  const claimed: PictureRecord = { ...record, busy, busyAt: new Date().toISOString() };
  writeRecord(claimed);
  return claimed;
}

/** Lets go of a claim when the action provably changed nothing, so the visitor can try again. */
export function releasePicture(id: string, busy: Busy): void {
  const record = readPicture(id);
  if (record === null || record.busy !== busy) return;
  const { busy: _busy, busyAt: _busyAt, ...rest } = record;
  writeRecord(rest);
}

/**
 * Moves a record to `to`, writing `fields` with it and clearing any claim. A move the NEXT table
 * does not allow is refused and nothing is written, so each state is entered at most once. When
 * `image` is given (Moolam's signed copy after a platform registration) it replaces the picture's
 * file before the record says so.
 *
 * Returns the new record, or null when the record is gone or the move is not allowed.
 */
export function advancePicture(id: string, to: PictureState, fields: TransitionFields = {}, image?: Uint8Array): PictureRecord | null {
  const record = readPicture(id);
  if (record === null || !NEXT[record.state].includes(to)) return null;
  const { busy: _busy, busyAt: _busyAt, ...rest } = record;
  const next: PictureRecord = { ...rest, ...fields, state: to };
  if (image !== undefined) {
    const contentType = imageType(image);
    if (contentType !== null) {
      next.contentType = contentType;
      writeAtomic(imagePath(next), image);
    }
  }
  writeRecord(next);
  if (next.contentType !== record.contentType) {
    rmSync(imagePath(record), { force: true });
  }
  return next;
}

/**
 * Marks every picture whose claim is older than `olderThanMs` as failed with "interrupted", for a
 * start after a process died in the middle of an action. Nothing is known about whether that action
 * spent anything, so the picture is never offered for it again and no count is handed back. A claim
 * with no time on it is treated as old.
 *
 * Returns the ids it marked.
 */
export function failStuckClaims(olderThanMs: number): string[] {
  const cutoff = Date.now() - olderThanMs;
  const marked: string[] = [];
  for (const record of listPictures()) {
    if (record.busy === undefined) continue;
    if (record.busyAt !== undefined && Date.parse(record.busyAt) > cutoff) continue;
    if (advancePicture(record.id, "failed", { failure: "interrupted" }) !== null) marked.push(record.id);
  }
  return marked;
}

/**
 * A session's own record, kept only once its visitor asks Dreamloom to send later pictures straight
 * to their Moolam account. The file is named by the session's hash, never the session itself, and
 * is read only for the session whose cookie hashes to that name, so no other session sees it (D2).
 */
const sessionSchema = z.strictObject({
  version: z.literal(1),
  sessionHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Where later pictures go. It passed the kit's transfer checks (P22) when it was set. */
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  /** The visitor's tick on "Send my future pictures straight to my Moolam account". */
  sendStraight: z.literal(true),
  updatedAt: z.iso.datetime(),
});

export type SessionRecord = z.infer<typeof sessionSchema>;

const SESSION_HASH = /^[0-9a-f]{64}$/;

function sessionPath(hash: string): string {
  return path.join(env().dataDir, "sessions", `${hash}.json`);
}

/** The session's record, or null for a malformed hash, no record, or a record that fails the schema. */
export function readSessionRecord(hash: string): SessionRecord | null {
  if (!SESSION_HASH.test(hash)) return null;
  try {
    const parsed = sessionSchema.safeParse(JSON.parse(readFileSync(sessionPath(hash), "utf8")));
    return parsed.success && parsed.data.sessionHash === hash && parsed.data.sendStraight ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Stores the address later pictures go to, with the flag, replacing any earlier one. The caller has checked it. */
export function rememberAddress(hash: string, address: string): SessionRecord {
  const record: SessionRecord = { version: 1, sessionHash: hash, address, sendStraight: true, updatedAt: new Date().toISOString() };
  writeAtomic(sessionPath(hash), `${JSON.stringify(sessionSchema.parse(record))}\n`);
  return record;
}

/** Removes the address and the flag. Nothing to remove is not an error. */
export function forgetAddress(hash: string): void {
  if (!SESSION_HASH.test(hash)) return;
  rmSync(sessionPath(hash), { force: true });
}

/** Whether any stored picture belongs to this session, so only a session Dreamloom knows can keep a record. */
export function sessionHasPictures(hash: string): boolean {
  return listPictures().some((record) => record.sessionHash === hash);
}
