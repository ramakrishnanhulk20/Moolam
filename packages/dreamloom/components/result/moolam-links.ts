/** Monad's explorer, the same one Moolam's own pages link to. */
export const MONAD_EXPLORER = "https://monadvision.com";

const HEX32 = /^0x[0-9a-f]{64}$/;

/** The exact origin Moolam's pages post from, or null when the site setting does not parse. */
export function moolamOrigin(moolamSite: string): string | null {
  try {
    const url = new URL(moolamSite);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

function base(moolamSite: string): string {
  return moolamSite.replace(/\/+$/, "");
}

/** A passport's page on Moolam, in English. Only a well-formed passport id becomes a link. */
export function passportLink(moolamSite: string, passportId: string): string | null {
  const id = passportId.toLowerCase();
  return HEX32.test(id) ? `${base(moolamSite)}/en/passport/${id}` : null;
}

/** Moolam's My pictures page, where a passport waiting under a verified email is claimed. */
export function mineLink(moolamSite: string): string {
  return `${base(moolamSite)}/en/mine`;
}

/** The same page written for reading: the host and path, no scheme. */
export function mineLabel(moolamSite: string): string {
  try {
    return `${new URL(moolamSite).host}/en/mine`;
  } catch {
    return "moolam.vercel.app/en/mine";
  }
}

/** Moolam's connect page, told which site asked so it can name it and answer only there. */
export function connectLink(moolamSite: string, ownOrigin: string): string {
  return `${base(moolamSite)}/en/connect?origin=${encodeURIComponent(ownOrigin)}`;
}

export function transactionLink(txHash: string): string | null {
  const hash = txHash.toLowerCase();
  return HEX32.test(hash) ? `${MONAD_EXPLORER}/tx/${hash}` : null;
}

/**
 * The co-sign link, only when it opens a page on Moolam's own site. A window this page opened is
 * never sent anywhere else, whatever the answer said.
 */
export function cosignLink(cosignUrl: string | undefined, moolamSite: string): string | null {
  if (cosignUrl === undefined) return null;
  const expected = moolamOrigin(moolamSite);
  try {
    const url = new URL(cosignUrl);
    return expected !== null && url.origin === expected ? url.href : null;
  } catch {
    return null;
  }
}

/** A long hash cut to its ends, for a label; the link always carries the whole of it. */
export function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 8)}...${hash.slice(-6)}` : hash;
}
