import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { env } from "./env";
import { writeAtomic } from "./store";

/**
 * Who a Dreamloom session signed in as with Google, and the sign-ins still on their way. Both live
 * on the volume beside the pictures, each file named by a hash so a copy of the folder hands out no
 * working cookie. An account file is read only for the session whose cookie hashes to its name, so
 * one session never sees another's email.
 */

/** How long a sign-in lasts before Dreamloom asks for Google again. */
export const ACCOUNT_DAYS = 30;

/** How long a visitor has at Google's page before the sign-in they started is thrown away. */
export const PENDING_MS = 10 * 60 * 1000;

/** Past this many sign-ins in flight, a new one is refused rather than written, so a loop cannot fill the volume. */
export const MAX_PENDING = 500;

const HASH = /^[0-9a-f]{64}$/;
const SIGNIN_ID = /^[0-9a-f]{32}$/;

/** Where a sign-in may send the visitor back to: the home page or one of their pictures. */
const RETURN_PATH = /^\/(p\/[0-9a-f]{32})?$/;

const accountSchema = z.strictObject({
  version: z.literal(1),
  sessionHash: z.string().regex(HASH),
  /** Google's subject id, stable for this Google account even if its email changes. */
  sub: z.string().min(1).max(255),
  /** An address Google said it verified, exactly as Google gave it. */
  email: z.string().min(3).max(320),
  signedInAt: z.iso.datetime(),
});

export type Account = z.infer<typeof accountSchema>;

const pendingSchema = z.strictObject({
  version: z.literal(1),
  state: z.string().min(16).max(128),
  nonce: z.string().min(16).max(128),
  verifier: z.string().min(43).max(128),
  returnTo: z.string().regex(RETURN_PATH),
  createdAt: z.iso.datetime(),
});

export type PendingSignIn = z.infer<typeof pendingSchema>;

function accountPath(hash: string): string {
  return path.join(env().dataDir, "accounts", `${hash}.json`);
}

function pendingDir(): string {
  return path.join(env().dataDir, "signins");
}

function pendingHash(id: string): string {
  return createHash("sha256").update(`dreamloom-signin:${id}`).digest("hex");
}

/** A path a sign-in may return to, or "/" for anything else, so the callback never redirects off the site. */
export function safeReturn(value: string | null): string {
  return value !== null && RETURN_PATH.test(value) ? value : "/";
}

/** The account this session signed in as, or null when it did not, the file fails its schema, or it is too old. */
export function readAccount(hash: string): Account | null {
  if (!HASH.test(hash)) return null;
  try {
    const parsed = accountSchema.safeParse(JSON.parse(readFileSync(accountPath(hash), "utf8")));
    if (!parsed.success || parsed.data.sessionHash !== hash) return null;
    if (Date.now() - Date.parse(parsed.data.signedInAt) > ACCOUNT_DAYS * 24 * 60 * 60 * 1000) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function writeAccount(hash: string, who: { sub: string; email: string }): Account {
  const record: Account = { version: 1, sessionHash: hash, sub: who.sub, email: who.email, signedInAt: new Date().toISOString() };
  writeAtomic(accountPath(hash), `${JSON.stringify(accountSchema.parse(record))}\n`);
  return record;
}

/** Signs the session out. Nothing to remove is not an error. */
export function forgetAccount(hash: string): void {
  if (!HASH.test(hash)) return;
  rmSync(accountPath(hash), { force: true });
}

/** Throws away sign-ins older than PENDING_MS and answers how many are left. */
function sweepPending(): number {
  let names: string[];
  try {
    names = readdirSync(pendingDir());
  } catch {
    return 0;
  }
  const cutoff = Date.now() - PENDING_MS;
  let left = 0;
  for (const name of names) {
    const file = path.join(pendingDir(), name);
    try {
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
      else left += 1;
    } catch {
      // A file another request just removed needs nothing more.
    }
  }
  return left;
}

/**
 * Keeps a sign-in's PKCE verifier, state and nonce until Google sends the visitor back, and answers
 * the id the visitor's browser carries in its sign-in cookie. Null when too many are in flight.
 */
export function savePending(values: Omit<PendingSignIn, "version" | "createdAt">): string | null {
  if (sweepPending() >= MAX_PENDING) return null;
  const id = randomBytes(16).toString("hex");
  const record: PendingSignIn = { version: 1, ...values, createdAt: new Date().toISOString() };
  writeAtomic(path.join(pendingDir(), `${pendingHash(id)}.json`), `${JSON.stringify(pendingSchema.parse(record))}\n`);
  return id;
}

/**
 * The sign-in this browser started, removed as it is read so a callback can be used once. Null for a
 * malformed id, no file, a file that fails its schema, or one older than PENDING_MS.
 */
export function takePending(id: string | null): PendingSignIn | null {
  if (id === null || !SIGNIN_ID.test(id)) return null;
  const file = path.join(pendingDir(), `${pendingHash(id)}.json`);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  rmSync(file, { force: true });
  try {
    const parsed = pendingSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return Date.now() - Date.parse(parsed.data.createdAt) > PENDING_MS ? null : parsed.data;
  } catch {
    return null;
  }
}
