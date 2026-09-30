import { createHash, timingSafeEqual } from "node:crypto";
import type { Platform } from "../platforms/platforms.js";

/**
 * A platform key as the operator script hands it out: 32 bytes from a CSPRNG, written as 64 hex
 * characters. Anything else is not a key this service ever issued, so it is refused before hashing.
 */
const KEY_TEXT = /^[0-9a-fA-F]{64}$/;

/** The key's text out of an Authorization header, or undefined when the header does not carry one. */
export function platformKeyText(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer ([^\s]+)$/i.exec(header.trim());
  const text = match?.[1];
  return text !== undefined && KEY_TEXT.test(text) ? text : undefined;
}

/**
 * Whether an Authorization header is shaped like a platform key rather than a Privy token. A Privy
 * access token is a JWT with dots in it, never 64 bare hex characters, so the two cannot be mixed up.
 */
export function looksLikePlatformKey(header: string | undefined): boolean {
  return platformKeyText(header) !== undefined;
}

/**
 * The sha256 of the key's 32 raw bytes, the value an entry's keyHash records. The hex text is
 * decoded first, so upper and lower case spell the same key and hash to the same value.
 */
export function platformKeyHash(text: string): Buffer {
  return createHash("sha256").update(Buffer.from(text.toLowerCase(), "hex")).digest();
}

/**
 * The entry whose keyHash is this key's hash and whose window holds `nowSeconds`, or undefined.
 *
 * Every entry is compared, with timingSafeEqual and no early exit, so how long the check takes says
 * nothing about which entry, or how much of a hash, a guess came close to. An entry outside its
 * window is a retired or not yet active platform and answers like an unknown key. The key text itself
 * is never stored, logged or returned by anything here.
 */
export function platformForKey(
  header: string | undefined,
  platforms: readonly Platform[],
  nowSeconds: bigint,
): Platform | undefined {
  const text = platformKeyText(header);
  if (text === undefined) {
    return undefined;
  }
  const presented = platformKeyHash(text);
  let found: Platform | undefined;
  for (const entry of platforms) {
    const stored = Buffer.from(entry.keyHash.slice(2), "hex");
    const same = stored.length === presented.length && timingSafeEqual(stored, presented);
    if (same && found === undefined) {
      found = entry;
    }
  }
  if (found === undefined) {
    return undefined;
  }
  const open = found.validFrom <= nowSeconds && (found.validTo === null || nowSeconds < found.validTo);
  return open ? found : undefined;
}
