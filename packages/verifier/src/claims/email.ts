import { createHmac } from "node:crypto";
import { env } from "../env.js";

/** RFC 5321's limit on a forward path, counted here in code points so a non-Latin address is not cut short. */
export const MAX_EMAIL_CODE_POINTS = 254;

/**
 * Far past any address that could pass, and checked before NFKC so a megabyte of text is refused
 * without being normalised. NFKC can grow a string, so the real cap is applied after it.
 */
const MAX_RAW_CODE_UNITS = 4 * MAX_EMAIL_CODE_POINTS;

/**
 * The secret every email hash is keyed with, and the number that says which secret it is. The
 * number travels inside each hash, so a ticket written under an older secret never matches a hash
 * made under the new one and the sweep can expire it.
 */
export interface Pepper {
  secret: Buffer;
  version: string;
}

// One dot-atom, RFC 5322's unquoted local part, with letters and digits from any script as RFC
// 6531 allows. Covers: a display name, a comment, angle or square brackets, a quoted local part,
// white space anywhere, a control or format character, a leading, trailing or doubled dot. Each
// of those has no character this predicate lets through, so none needs naming. Does not cover
// look-alike letters from two scripts: they stay two addresses and never match each other.
const ATOM = "[\\p{L}\\p{M}\\p{N}!#$%&'*+\\-/=?^_`{|}~]+";
const LOCAL_PART = new RegExp(`^${ATOM}(?:\\.${ATOM})*$`, "u");

// Dot-separated labels of letters, marks and digits, a hyphen only inside a label. Refuses an
// address literal such as [192.0.2.1], which no provider verifies.
const LABEL = "[\\p{L}\\p{M}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]*[\\p{L}\\p{M}\\p{N}])?";
const DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`, "u");

/**
 * The one form an email address is compared in (P28), or null for anything that is not exactly one
 * address: NFKC, trimmed, lowercased, then one addr-spec with a single @, both sides non-empty, at
 * most 254 code points, every character printable.
 *
 * Nothing is folded beyond that. A dot or a plus tag in a Gmail address, a googlemail.com domain,
 * or any other provider's rule would be a list that knows some providers and not others, so
 * "r.am@gmail.com" and "ram@gmail.com" stay two addresses. Lowercasing can leave a string that is
 * no longer in NFKC (a capital dotted I becomes i and a combining dot), so NFKC runs once more and
 * the output is a fixed point: normalising it again changes nothing.
 *
 * Covers spelling drift between the platform's string and Privy's. Does not cover one person with
 * two addresses, which stay two people here.
 */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_RAW_CODE_UNITS) {
    return null;
  }
  const folded = raw.normalize("NFKC").trim().toLowerCase().normalize("NFKC");
  if ([...folded].length > MAX_EMAIL_CODE_POINTS) {
    return null;
  }
  const at = folded.indexOf("@");
  if (at <= 0 || at !== folded.lastIndexOf("@") || at === folded.length - 1) {
    return null;
  }
  const local = folded.slice(0, at);
  const domain = folded.slice(at + 1);
  return LOCAL_PART.test(local) && DOMAIN.test(domain) ? folded : null;
}

/**
 * The address's hash under the pepper, as "<version>:<64 hex>", or null when normaliseEmail refuses
 * it. The only way any part of this service turns an email into something it keeps, so the
 * platform's string and every address read from Privy go through the same normaliser and the same
 * key before they are compared (P28, P29). The address itself goes no further than this call.
 *
 * Covers a store that leaks on its own: without the pepper a hash cannot be tested against a guess.
 * Does not cover someone holding both the store and the pepper, who can test a dictionary of
 * addresses against it; that is why the pepper lives only in the host's environment.
 */
export function emailHash(raw: unknown, pepper: Pepper): string | null {
  const normalised = normaliseEmail(raw);
  if (normalised === null) {
    return null;
  }
  const mac = createHmac("sha256", pepper.secret).update(normalised, "utf8").digest("hex");
  return `${pepper.version}:${mac}`;
}

/** Whether a stored hash was made under this pepper's version. */
export function underPepper(hash: string, pepper: Pepper): boolean {
  return hash.startsWith(`${pepper.version}:`);
}

/** A stored email hash as emailHash writes it, so a record holding anything else fails its schema. */
export const EMAIL_HASH_TEXT = /^[1-9][0-9]{0,8}:[0-9a-f]{64}$/;

/** The pepper this host was given, or undefined when it has none and the claim routes stay closed. */
export function pepperFromEnv(): Pepper | undefined {
  if (env.CLAIM_PEPPER === undefined || env.CLAIM_PEPPER_VERSION === undefined) {
    return undefined;
  }
  return { secret: Buffer.from(env.CLAIM_PEPPER, "hex"), version: env.CLAIM_PEPPER_VERSION };
}

/** The names of the pepper variables this host is missing, for the one boot line that says so. */
export function missingPepperVariables(): string[] {
  return (["CLAIM_PEPPER", "CLAIM_PEPPER_VERSION"] as const).filter((name) => env[name] === undefined);
}
