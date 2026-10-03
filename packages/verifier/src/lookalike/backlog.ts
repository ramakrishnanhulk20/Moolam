import { registeredBefore } from "../lookalike-rule.js";
import { isPassportId } from "../consentRead.js";
import { passportKey } from "../mcp/inputs.js";
import { BlockedTarget } from "../net/safeFetch.js";
import type { Hex, PassportRecord } from "../types.js";
import { pinnedContentId, sealedStateOf, type DocumentReader } from "../unseal.js";
import { lookalikeOrder } from "./search.js";

/** The most passports one backlog answer names, the workflow's own ceiling per cron run. */
export const MAX_BACKLOG = 7;

/**
 * What the backlog judges against. `activation` is the unix second from which a look-alike record
 * counts as the network's; `receiver` is MoolamLookalikes. Both are needed: with either unset the
 * backlog is off and answers "not-ready", never a list that says nothing about what the missing
 * setting would have decided.
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
 * What a passport still lacks, or "unknown" when the source behind the index cannot say whether it
 * has a network verdict and what the newest one found. That comes only from the index's own
 * Attestation.network flag (`networkVerdict` and `networkMatched`), never from a receiver and a
 * time worked out here, so an index that does not serve the flag leaves every passport unknown.
 *
 * Only an original (no parent) gets a look-alike record; an edit skips that step, as the workflow
 * does (L9). So does a passport whose newest network verdict says the fingerprints did not match:
 * the workflow proves no look-alike for it, so the record it would wait for never comes.
 */
export function missingOf(
  record: PassportRecord,
  records: LookalikeRecordView,
): { verdict: boolean; lookalike: boolean } | "unknown" {
  if (record.networkVerdict === undefined) return "unknown";
  if (record.networkVerdict && record.networkMatched === undefined) return "unknown";
  const lookalike = record.parentId === null && record.networkMatched !== false && records.newestAt(record.id) === undefined;
  return { verdict: !record.networkVerdict, lookalike };
}

/** The settings the backlog needs: both, since records before activation never count. */
export function lookalikeHalfOn(settings: BacklogSettings): boolean {
  return settings.receiver !== undefined && settings.activation !== undefined;
}

/**
 * Why the backlog is off, in words /health and the boot log can carry, or undefined when both
 * settings are set. It names the settings and never their values.
 */
export function backlogOffReason(settings: BacklogSettings): string | undefined {
  const missing = [
    ...(settings.activation === undefined ? ["NETWORK_ACTIVATION_TIME"] : []),
    ...(settings.receiver === undefined ? ["LOOKALIKE_RECEIVER"] : []),
  ];
  return missing.length === 0
    ? undefined
    : `it needs NETWORK_ACTIVATION_TIME and LOOKALIKE_RECEIVER, and this host has no ${missing.join(" or ")}, so it answers not-ready`;
}

/**
 * `n` entries of `list`, starting at `slot` modulo the list's length and wrapping round its end.
 * The start moves one place with each slot, so over any `list.length` slots in a row every entry
 * leads an answer once, and a leading entry is always the first one a run works on. A list no
 * longer than `n` comes back whole, with its start moved the same way.
 */
export function rotated<T>(list: readonly T[], slot: number, n: number): T[] {
  if (list.length === 0) return [];
  const start = slot % list.length;
  return Array.from({ length: Math.min(n, list.length) }, (_, place) => list[(start + place) % list.length] as T);
}

/**
 * Up to `n` passports registered strictly before `asOf` that still lack a network verdict or, for
 * an original, a look-alike record, and that the workflow can check: a public document naming its
 * picture. The whole waiting list is oldest first by the shared rule, then id; the answer is `n` of
 * it starting `slot` places in and wrapping round (see `rotated`).
 *
 * The rotation is what stops a few passports the workflow can never finish, such as a picture it
 * cannot measure, from sitting at the head of every answer and using up each run's reads. `slot` is
 * the cron slot the workflow passes, so every node asking in one slot gets the same list.
 *
 * "not-ready" rather than a shorter list whenever any passport that could belong in it cannot be
 * judged yet: the backlog is off for want of a setting, the look-alike scan has not caught up, the
 * source cannot say whether a passport has a verdict, or a passport's document has never been read.
 * A document whose read failed is left out until a later refresh reads it, so one dead address
 * cannot hold the list for good.
 *
 * `ordered` must already be in the look-alike order (see `inLookalikeOrder`).
 */
export function backlogOf(
  ordered: readonly PassportRecord[],
  asOf: number,
  n: number,
  slot: number,
  view: BacklogView,
): BacklogAnswer {
  const records = view.records;
  if (!lookalikeHalfOn(view.settings) || records === undefined || !records.ready) return NOT_READY;
  const limit = { registeredAt: BigInt(asOf) };
  const waiting: Hex[] = [];
  for (const record of ordered) {
    if (!registeredBefore({ registeredAt: BigInt(record.registeredAt) }, limit)) break;
    const missing = missingOf(record, records);
    if (missing === "unknown") return NOT_READY;
    if (!missing.verdict && !missing.lookalike) continue;
    const picture = view.pictureOf(record.metadataURI);
    if (picture === undefined) return NOT_READY;
    if (picture !== "checkable") continue;
    if (!isPassportId(record.id)) continue;
    waiting.push(passportKey(record.id));
  }
  return { status: "ok", passports: rotated(waiting, slot, n) };
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
