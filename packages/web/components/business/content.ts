import type { Hex } from "viem";

/**
 * Everything the business page needs that is not a word: where each link goes,
 * and the order its lists are drawn in. The words live under `business` in the
 * message files, keyed by the same names used here.
 */

export const DREAMLOOM_URL = "https://dreamloom-production-3e74.up.railway.app";
/** The demo site's own name, for the moment the signed list has not named it. */
export const DREAMLOOM_NAME = "Dreamloom";
export const VERIFY_URL = "https://verifier-production-d76f.up.railway.app";

/**
 * The passport whose picture the demo draws: the picture the demo's own prompt
 * describes, made on Dreamloom and registered through the kit. It is named here
 * rather than taken from Dreamloom's newest passports because Dreamloom is a
 * public demo, and the first screen of a page for companies must never draw
 * whatever a stranger typed last. The picture itself is read live, and shown
 * only while its passport carries Dreamloom's kit label and no dispute.
 */
export const DEMO_PASSPORT: Hex = "0xc7f3f3f00252519e5bef4f59c48285e2bbefe4c6ecf8625b9d8f6bc9e23256c4";

/**
 * Every place the page sends a reader. A path starting with /docs or another
 * app route goes through the locale-aware Link; /docs-files is served outside
 * the locale; the https address is the live demo site.
 */
export const LINKS = {
  guide: "/docs/developers/platform-kit",
  ways: "/docs/developers/platform-kit#which-way-to-hand-passports-to-people",
  join: "/docs/developers/platform-kit#joining-the-list",
  credit: "/docs/developers/platform-kit#how-moolam-credits-a-platform-picture",
  costs: "/docs/developers/platform-kit#what-it-costs-on-monad-mainnet",
  fingerprints: "/docs/concepts/fingerprints",
  mcp: "/docs/developers/mcp",
  threat: "/docs/security/threat-model#the-platform-kit-and-the-mcp-server",
  transcript: "/docs-files/proofs/attacks/pass-kit.txt",
  dreamloom: DREAMLOOM_URL,
} as const;

export type LinkKey = keyof typeof LINKS;

/** True for an address that leaves the app, or that the locale router must not prefix. */
export function isPlainHref(href: string): boolean {
  return href.startsWith("https://") || href.startsWith("/docs-files/");
}

export const HERO_META = ["audience", "chain", "tap"] as const;

/** The demo loop's beats, in the order a person meets them, and how long each holds in milliseconds. */
export const DEMO_STAGES = [
  { key: "prompt", hold: 2300 },
  { key: "picture", hold: 1500 },
  { key: "press", hold: 1300 },
  { key: "window", hold: 1900 },
  { key: "passkey", hold: 1700 },
  { key: "passport", hold: 1900 },
  // The last beat holds longest so the lit card can be read.
  { key: "chainlink", hold: 3200 },
] as const;

export const REASONS = [
  { key: "credit", link: "credit" },
  { key: "name", link: "fingerprints" },
  { key: "terms", link: "mcp" },
] as const satisfies readonly { key: string; link: LinkKey }[];

export const WAY_ROWS = ["person", "credit", "cost", "build"] as const;

/** The three ways, the recommended one first, each with the tag it wears. */
export const WAYS = [
  { key: "cosign", tag: "recommended" },
  { key: "email", tag: "next" },
  { key: "connect", tag: null },
] as const;

export const PERSON_STEPS = ["make", "press", "window", "signIn", "passkey", "passport"] as const;

export const BUILD_STEPS = ["start", "send", "wait"] as const;

export const PLANS = ["free", "payg", "monthly"] as const;
