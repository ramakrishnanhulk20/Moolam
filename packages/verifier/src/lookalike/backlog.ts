import { registeredBefore } from "../lookalike-rule.js";
import { isPassportId } from "../consentRead.js";
import { passportKey } from "../mcp/inputs.js";
import { BlockedTarget } from "../net/safeFetch.js";
import type { Hex, PassportRecord } from "../types.js";
import { pinnedContentId, sealedStateOf, type DocumentReader } from "../unseal.js";
import { lookalikeOrder } from "./search.js";

/**
 * The receiver Chainlink's network writes its match verdicts to, 0x0d69, lower-cased the way the
 * index stores a receiver. It cannot change: a new verdict receiver means a new listing and a new
 * build of this service.
 */
export const NETWORK_RECEIVER = "0x0d69055c43eacb3b1ca687ca2263a049bc7eff04" as Hex;

/** The most passports one backlog answer names, the workflow's own ceiling per cron run. */
export const MAX_BACKLOG = 7;

/**
 * What the backlog judges against. `activation` is the unix second from which a verdict on 0x0d69
 * counts as the network's; `receiver` is MoolamLookalikes. Either may be unset, and the list then
 * says nothing about what that setting would have decided.
 */
export interface BacklogSettings {
  activation?: number;
  receiver?: Hex;
}

/**
 * What one passport's metadata document says about checking it: "checkable" is a public document
 * naming its picture as pinned content, "not-checkable" is anything the workflow would refuse
 * (sealed, no picture, an address that is not pinned content, not a document at all), and
 * "failed" is a read that did not answer, tried again later.
 */
export type PictureCheck = "checkable" | "not-checkable" | "failed";

/** The newest look-alike record per passport, and whether the scan behind it has caught up. */
export interface LookalikeRecordView {
  ready: boolean;
  /** The newest record's executedAt for this passport, at or after activation, or undefined for none. */
  newestAt: (passportId: Hex) => number | undefined;
}

/** Everything the backlog reads besides the index copy, fixed for one answer. */
export interface BacklogView {
  settings: BacklogSettings;
  pictureOf: (metadataURI: string) => PictureCheck | undefined;
  /** Undefined when the look-alike half is off: no receiver or no activation time set. */
  records: LookalikeRecordView | undefined;
}

export type BacklogAnswer = { status: "ok"; passports: Hex[] } | { status: "not-ready" };

const NOT_READY: BacklogAnswer = { status: "not-ready" };

/**
 * What a passport still lacks, or "unknown" when the source behind the index cannot say whether
 * it has a network verdict. Only an original (no parent) gets a look-alike record; an edit skips
 * that step, as the workflow does (L9).
 */
export function missingOf(
  record: PassportRecord,
  settings: BacklogSettings,
  records: LookalikeRecordView | undefined,
): { verdict: boolean; lookalike: boolean } | "unknown" {
  let verdict = false;
  if (settings.activation !== undefined) {
    if (record.networkVerdict === undefined) return "unknown";
    verdict = !record.networkVerdict;
  }
  const lookalike = records !== undefined && record.parentId === null && records.newestAt(record.id) === undefined;
  return { verdict, lookalike };
}

/** The settings the look-alike half needs: both, since records before activation never count. */
export function lookalikeHalfOn(settings: BacklogSettings): boolean {
  return settings.receiver !== undefined && settings.activation !== undefined;
}

/**
 * Up to `n` passports registered strictly before `asOf` that still lack a network verdict or, for
 * an original, a look-alike record, and that the workflow can check: a public document naming its
 * picture. Oldest first by the shared rule, then id.
 *
 * "not-ready" rather than a shorter list whenever any passport that could belong in it cannot be
 * judged yet: the look-alike scan has not caught up, the source cannot say whether a passport has
 * a verdict, or a passport's document has never been read. A document whose read failed is left
 * out until a later refresh reads it, so one dead address cannot hold the list for good.
 *
 * `ordered` must already be in the look-alike order (see `inLookalikeOrder`).
 */
export function backlogOf(ordered: readonly PassportRecord[], asOf: number, n: number, view: BacklogView): BacklogAnswer {
  if (view.records !== undefined && !view.records.ready) return NOT_READY;
  const limit = { registeredAt: BigInt(asOf) };
  const passports: Hex[] = [];
  for (const record of ordered) {
    if (passports.length >= n) break;
    if (!registeredBefore({ registeredAt: BigInt(record.registeredAt) }, limit)) break;
    const missing = missingOf(record, view.settings, view.records);
    if (missing === "unknown") return NOT_READY;
    if (!missing.verdict && !missing.lookalike) continue;
    const picture = view.pictureOf(record.metadataURI);
    if (picture === undefined) return NOT_READY;
    if (picture !== "checkable") continue;
    if (!isPassportId(record.id)) continue;
    passports.push(passportKey(record.id));
  }
  return { status: "ok", passports };
}

const sortedCopies = new WeakMap<object, readonly PassportRecord[]>();

/**
 * A copy's passports in the look-alike order, worked out once per copy. `owner` is the copy's
 * own map, which lives exactly as long as the copy does.
 */
export function inLookalikeOrder(owner: ReadonlyMap<Hex, PassportRecord>): readonly PassportRecord[] {
  const held = sortedCopies.get(owner);
  if (held !== undefined) return held;
  const sorted = [...owner.values()].sort(lookalikeOrder);
  sortedCopies.set(owner, sorted);
  return sorted;
}

/** What one document says about checking its passport, by the workflow's own reading of it. */
export function pictureCheckOf(document: unknown): PictureCheck {
  if (sealedStateOf(document) !== "public") return "not-checkable";
  const fields = document as Record<string, unknown>;
  return pinnedContentId(fields.thumbnail ?? fields.image) === null ? "not-checkable" : "checkable";
}

/** A failed read is tried again after this long. */
export const PICTURE_RETRY_MS = 10 * 60 * 1000;

/** How many documents one refresh reads, so a first boot over a long backlog spreads its reads out. */
export const PICTURE_READS_PER_REFRESH = 64;

/** Documents read at once during a refresh. */
const PICTURE_READS_AT_ONCE = 4;

/**
 * A memory of what each metadata document says about checking its passport. A document address
 * names fixed bytes, so an answer read once stays right; only a failed read is tried again.
 *
 * Reads happen only in `readSome`, which the background refresh calls, never a request. Its
 * results are committed together when it ends, so an answer never sees half a refresh.
 */
export class PictureBook {
  private known = new Map<string, { check: PictureCheck; at: number }>();

  constructor(
    private readonly read: DocumentReader | undefined,
    private readonly clock: () => number = Date.now,
  ) {}

  /** What is known of this document now, or undefined when it has never been read. */
  checkOf(metadataURI: string): PictureCheck | undefined {
    return this.known.get(metadataURI)?.check;
  }

  /** Whether this document should be read in the next refresh: never read, or failed long enough ago. */
  wants(metadataURI: string): boolean {
    const held = this.known.get(metadataURI);
    return held === undefined || (held.check === "failed" && this.clock() - held.at >= PICTURE_RETRY_MS);
  }

  /**
   * Reads up to PICTURE_READS_PER_REFRESH of these documents, in the order given. Never throws.
   * With no reader (a host under a test runner, unless a test hands one in) it reads nothing.
   */
  async readSome(metadataURIs: readonly string[]): Promise<void> {
    const read = this.read;
    if (read === undefined) return;
    const due = [...new Set(metadataURIs)].filter((uri) => this.wants(uri)).slice(0, PICTURE_READS_PER_REFRESH);
    const found = new Map<string, PictureCheck>();
    for (let at = 0; at < due.length; at += PICTURE_READS_AT_ONCE) {
      await Promise.all(
        due.slice(at, at + PICTURE_READS_AT_ONCE).map(async (uri) => {
          if (pinnedContentId(uri) === null) {
            found.set(uri, "not-checkable");
            return;
          }
          try {
            found.set(uri, pictureCheckOf(await read(uri)));
          } catch (error) {
            found.set(uri, error instanceof BlockedTarget ? "not-checkable" : "failed");
          }
        }),
      );
    }
    const now = this.clock();
    for (const [uri, check] of found) {
      this.known.set(uri, { check, at: now });
    }
  }
}
