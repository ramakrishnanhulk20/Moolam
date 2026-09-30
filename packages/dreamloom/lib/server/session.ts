import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isLoopbackHost } from "./env";

export const SESSION_COOKIE = "dl_session";

const SESSION = /^[0-9a-f]{32}$/;

/**
 * The session this request carries, or null when the cookie is absent or not 32 hex characters.
 * A malformed value is treated as no session at all, never repaired into one.
 */
export function readSession(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  let found: string | null = null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    if (part.slice(0, at).trim() !== SESSION_COOKIE) continue;
    // Two dl_session cookies means something planted one; neither is trusted.
    if (found !== null) return null;
    found = part.slice(at + 1).trim();
  }
  return found !== null && SESSION.test(found) ? found : null;
}

/** A fresh session: 128 bits from the CSPRNG. */
export function newSession(): string {
  return randomBytes(16).toString("hex");
}

/**
 * What a record stores in place of the session, so a copy of the data folder does not hand out
 * working cookies.
 */
export function sessionHash(session: string): string {
  return createHash("sha256").update(`dreamloom-session:${session}`).digest("hex");
}

/** Whether `session` is the one whose hash a record holds, compared in constant time. */
export function ownsHash(session: string | null, storedHash: string): boolean {
  if (session === null) return false;
  const mine = Buffer.from(sessionHash(session), "hex");
  const theirs = Buffer.from(storedHash, "hex");
  return mine.length === theirs.length && timingSafeEqual(mine, theirs);
}

/**
 * The Set-Cookie line for a new session. Secure everywhere except plain http to this machine,
 * because a browser drops a Secure cookie sent over http and local work would lose its pictures.
 */
export function sessionCookie(session: string, request: Request): string {
  const url = new URL(request.url);
  const local = url.protocol === "http:" && isLoopbackHost(url.hostname);
  const parts = [`${SESSION_COOKIE}=${session}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (!local) parts.push("Secure");
  return parts.join("; ");
}
