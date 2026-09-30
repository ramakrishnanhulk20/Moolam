import { loadPlatforms, platformLabel, type LabelPassport, type PlatformLabel, type PlatformList } from "@/lib/platforms/platforms";

/**
 * The web app's one door to Moolam's signed platform list (P16).
 *
 * The list ships inside the build, next to this app, so it is read from the
 * copied file and never over the network from the verify service. Loading it
 * checks every EIP-712 signature, which is too slow to repeat per render and
 * cannot change while the process lives, so the answer is kept for the life of
 * the server process.
 *
 * A list that fails any check is refused whole by loadPlatforms, and a refused
 * list here means no labels at all (P15): the base words on every page are
 * true without the list, so losing it can only lose a label, never add a claim.
 */
let held: Promise<PlatformList> | null = null;

const REFUSED: PlatformList = { ok: false, platforms: [], reason: "the platform list did not load" };

export function heldPlatformList(): Promise<PlatformList> {
  held ??= loadPlatforms().catch(() => REFUSED);
  return held;
}

/**
 * The label for one passport from a list already loaded, or null when there is
 * none to show. The only place a page turns a list into a label, so every
 * screen asks the same question the same way.
 */
export function labelFrom(list: PlatformList, passport: LabelPassport, now?: bigint): PlatformLabel | null {
  if (!list.ok) {
    return null;
  }
  return platformLabel(passport, list.platforms, now);
}

/** The label for one passport, read against the held list. */
export async function labelFor(passport: LabelPassport): Promise<PlatformLabel | null> {
  return labelFrom(await heldPlatformList(), passport);
}

/**
 * The platform name a plate may wear, or null. Only a "kit" label earns the
 * mark on a plate: a listed wallet's passport made outside the kit is said in
 * full on its own page, where there is room to say why it is not labelled.
 */
export function plateMark(list: PlatformList, passport: LabelPassport): string | null {
  const label = labelFrom(list, passport);
  return label?.status === "kit" ? label.name : null;
}
