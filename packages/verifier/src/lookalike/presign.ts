import { plainTitle } from "../claims/preview.js";
import { isPassportId } from "../consentRead.js";
import { DIHEDRAL_NAMES, dihedralFingerprints } from "../dihedral.js";
import { passportKey } from "../mcp/inputs.js";
import type { IndexCopy } from "../server.js";
import type { Hex, PassportRecord } from "../types.js";
import { readMetadataDocument } from "../unseal.js";
import { lookalikesOf, type FingerprintPair } from "./search.js";

/**
 * What a prepare answer says about earlier passports that look like the new picture (L19). Three
 * states and one more: "found" names the earliest earlier passport by another creator and another
 * edit family; "yours" names the caller's own earlier one when nobody else's is there; "none" is a
 * search that succeeded on an index current to `indexAt`; "unchecked" is every way the search could
 * not answer, which a screen must say in words and never draw as nothing.
 */
export type LookalikeAnswer =
  | { state: "found"; passportId: Hex; title: string; registeredAt: number }
  | { state: "yours"; passportId: Hex }
  | { state: "none"; indexAt: number }
  | { state: "unchecked" };

const UNCHECKED: LookalikeAnswer = { state: "unchecked" };

/** How long the wallet read and the title read each get before the answer gives up on them. */
export const PRESIGN_READ_MS = 5_000;

/** The most parent links one family walk follows, so a long or looping chain of edits costs a fixed amount. */
export const FAMILY_HOPS = 16;

export interface PresignReaders {
  /** The addresses the new passport's creator holds. Throws when they cannot be read. */
  creators: () => Promise<readonly string[]>;
  /** The title of the passport this metadata document belongs to, as one plain line. */
  titleOf: (metadataURI: string) => Promise<string>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** One spelling for an address on both sides of a comparison, or undefined for anything that is not one. */
function addressKey(value: unknown): string | undefined {
  return typeof value === "string" && ADDRESS.test(value) ? value.toLowerCase() : undefined;
}

/** Waits for `work` up to `ms`, then gives up with a throw. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The creator of the first passport of this one's edit family, walking parent links in this copy
 * of the index. Undefined when a parent is not in the copy or the walk passes FAMILY_HOPS.
 */
function familyRootCreator(record: PassportRecord, passports: ReadonlyMap<Hex, PassportRecord>): string | undefined {
  let current = record;
  for (let hop = 0; hop < FAMILY_HOPS; hop += 1) {
    if (current.parentId === null) return addressKey(current.creator);
    const parent = passports.get(passportKey(current.parentId));
    if (parent === undefined) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * The look-alike state for a picture about to be signed, from one copy of the index. The picture
 * will register no earlier than `nowSeconds`, so only passports registered strictly before that
 * second count as earlier (L10). Never throws: any read that fails, an index that is stale, or
 * fingerprints that could not be taken is "unchecked".
 *
 * Only the passport's id, its chain registration second and its title leave here, each through its
 * own rule: the id by the one passport id pattern, lower-cased; the second from the indexed chain
 * record; the title by plainTitle, one printable line of at most 120 code points (L20).
 */
export async function lookalikeBeforeSigning(
  copy: IndexCopy,
  pairs: readonly FingerprintPair[] | undefined,
  readers: PresignReaders,
  nowSeconds: number,
): Promise<LookalikeAnswer> {
  try {
    if (pairs === undefined || pairs.length === 0) return UNCHECKED;
    const state = copy.state();
    if (state.stale) return UNCHECKED;

    const earlier = lookalikesOf(copy.index, pairs, nowSeconds)
      .map((entry) => copy.passports.get(entry.id) ?? copy.passports.get(passportKey(entry.id)))
      .filter((record): record is PassportRecord => record !== undefined && isPassportId(record.id));
    if (earlier.length === 0) {
      return { state: "none", indexAt: state.indexedAt ?? state.loadedAt };
    }

    const held = new Set((await within(readers.creators(), PRESIGN_READ_MS)).map(addressKey));
    held.delete(undefined);
    const mine = (record: PassportRecord): boolean => {
      const creator = addressKey(record.creator);
      const root = familyRootCreator(record, copy.passports);
      return (creator !== undefined && held.has(creator)) || (root !== undefined && held.has(root));
    };

    const theirs = earlier.find((record) => !mine(record));
    if (theirs === undefined) {
      return { state: "yours", passportId: passportKey((earlier[0] as PassportRecord).id) };
    }
    let title = "";
    try {
      title = plainTitle(await within(readers.titleOf(theirs.metadataURI), PRESIGN_READ_MS));
    } catch {
      title = "";
    }
    return { state: "found", passportId: passportKey(theirs.id), title, registeredAt: theirs.registeredAt };
  } catch {
    return UNCHECKED;
  }
}

/**
 * The fingerprints a pre-sign search asks with: the signed file's own, which is what the passport
 * will store, and the seven other turns and mirrors of it, the same eight the workflow sends. Never
 * throws: a picture this service could not turn answers undefined, and the prepare goes on with
 * "unchecked". Run inside the caller's studio turn, since it decodes.
 */
export async function pairsOf(bytes: Buffer, own: FingerprintPair): Promise<FingerprintPair[] | undefined> {
  try {
    const turned = await dihedralFingerprints(bytes);
    const others = DIHEDRAL_NAMES.filter((name) => name !== "identity").map((name) => turned[name]);
    return [own, ...others].map((print) => ({ phash: print.phash, blockhash: print.blockhash }));
  } catch {
    return undefined;
  }
}

/** A memory of titles by document address: a pinned document never changes. */
const TITLE_CACHE_MAX = 2_000;

/**
 * The live title reader: the metadata document through the pinned-content rule (a bare ipfs
 * content id, the configured gateway, no redirect, a byte cap), its `name` made plain. A read that
 * fails answers "" and is not kept, so the next prepare tries again.
 */
export function liveTitleReader(): (metadataURI: string) => Promise<string> {
  const kept = new Map<string, string>();
  return async (metadataURI) => {
    const held = kept.get(metadataURI);
    if (held !== undefined) return held;
    let title: string;
    try {
      const document = await readMetadataDocument(metadataURI, { timeoutMs: PRESIGN_READ_MS });
      title = plainTitle((document as { name?: unknown } | null)?.name);
    } catch {
      return "";
    }
    if (kept.size >= TITLE_CACHE_MAX) {
      const oldest = kept.keys().next().value;
      if (oldest !== undefined) kept.delete(oldest);
    }
    kept.set(metadataURI, title);
    return title;
  };
}
