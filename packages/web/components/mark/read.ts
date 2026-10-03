import { formatEther, type Hex } from "viem";
import type { Art } from "@/components/passport/art";
import { heldIndexedVerdictRows, transactionFor, type IndexedAttestation } from "@/components/passport/indexed";
import { recordUnread } from "@/components/passport/unread";
import { addresses } from "@/lib/chain/client";
import { bitsApart, phashWord } from "@/lib/chain/fingerprint";
import { sameAddress } from "@/lib/chain/receivers";
import { DisputeStatus, heldPassportRecord, type Attestation, type Dispute, type Passport } from "@/lib/chain/registry";
import { heldReportDelivery } from "@/lib/chain/reports";
import { heldLookalikeFacts, markSchema, type LookalikeFacts } from "@/lib/data/marks";
import { heldArt } from "@/lib/data/passports";
import { issueMark, lightsLookalike, type Mark, type MarkDispute, type MarkPicture, type MarkVerdict } from "./mark";
import { networkCanFetch } from "./networkFetch";
import { ANSWER_DAYS, DAY_SECONDS, MARK_PHASH_LIMIT } from "./rule";
import { heldSearchedEarlier } from "./search";

/** One other passport as a look-alike line names it. */
export interface OtherPassport {
  id: Hex;
  /** Null when its record could not be read or names nothing. */
  title: string | null;
  registeredAt: number;
}

/** What the look-alike block draws, one state at a time. */
export type LookalikeView =
  /** Chainlink's network wrote a valid record naming an earlier passport (L4, L5). */
  | { kind: "found"; earlier: OtherPassport; sealed: boolean; bits: number; at: number }
  /** Chainlink's network wrote a valid record that names none (L31). */
  | { kind: "none"; at: number }
  /** No record from the network yet, and Moolam's own search proposes an earlier passport. */
  | { kind: "searching"; earlier: OtherPassport }
  /** Nothing to draw: no record, no search find, or an index that does not serve the rows yet. */
  | { kind: "quiet" }
  /** The index serves the rows and did not answer, which the block says in words (L32). */
  | { kind: "unread" };

/** Everything the passport page draws about its mark and its look-alikes. */
export interface PassportMarkFacts {
  mark: Mark;
  /** The passport's own registration, in unix seconds, for the waiting line. */
  registeredAt: number;
  /** The open challenge's bond in MON and the last day the holder can answer, for the challenged line. */
  challenge: { bond: string; answerBy: number } | null;
  /** The earlier passport the mark names, for its line. */
  earlier: OtherPassport | null;
  lookalike: LookalikeView;
  /** The later passports whose newest valid network record names this one (L6). */
  later: { first: OtherPassport | null; count: number };
  /**
   * True when the record lists a run that was not the network's, a test run in
   * Chainlink's simulator, so a mark that says the network has not checked the
   * picture can point at the run listed below it rather than contradict it.
   */
  testRun: boolean;
}

/** A read, or the given answer when it throws. */
async function settle<T>(read: () => Promise<T>, failed: T): Promise<T> {
  try {
    return await read();
  } catch {
    return failed;
  }
}

/** What the registry's dispute view says, for the mark. */
export function markDispute(passport: Pick<Passport, "disputed">, dispute: Dispute | null): MarkDispute {
  if (passport.disputed || dispute?.status === DisputeStatus.Upheld) {
    return "upheld";
  }
  if (dispute === null) {
    return "none";
  }
  if (dispute.status === DisputeStatus.Open) {
    return "open";
  }
  return dispute.status === DisputeStatus.Rejected ? "rejected" : "none";
}

/**
 * What a passport's document says it points at, for the mark. The registry
 * takes any string as the document address, and Chainlink's workflow fetches
 * only a bare ipfs://<cid> one. A file under the id or Moolam's own gateway
 * link draws on this site and is never checked by the network, so those name
 * no picture it can check and never read "waiting".
 */
export function markPicture(passport: Pick<Passport, "metadataURI">, art: Art | null): MarkPicture | null {
  if (passport.metadataURI === "" || !networkCanFetch(passport.metadataURI)) {
    return "none";
  }
  if (art === null || recordUnread(art)) {
    return null;
  }
  if (art.sealed === true) {
    return "sealed";
  }
  return art.thumbnailUrl === undefined && art.imageUrl === undefined ? "none" : "public";
}

/**
 * Whether Chainlink's network delivered each verdict, or null when that could
 * not be told for one of them (L4, L32).
 *
 * Only Moolam's network receiver can hold a network verdict, so a verdict from
 * any other receiver is not one, on the chain's own word. For the network
 * receiver the index's flag decides once the index serves it. Until then the
 * report transaction's `to` decides, as the attestation rows already read it:
 * the network forwarder is the network, anything else is not, and a
 * transaction that cannot be found or read decides nothing.
 */
export async function networkVerdicts(
  passport: Pick<Passport, "phash">,
  attestations: readonly Attestation[],
  rows: readonly IndexedAttestation[] | null,
  indexServesNetwork: boolean,
): Promise<MarkVerdict[] | null> {
  const verdicts: MarkVerdict[] = [];
  for (const attestation of attestations) {
    const base = {
      matched: attestation.matched,
      phashBits: bitsApart(passport.phash, phashWord(attestation.recomputed)),
      at: Number(attestation.at),
    };
    if (!sameAddress(attestation.receiver, addresses.receiver)) {
      verdicts.push({ ...base, network: false });
      continue;
    }
    if (rows === null) {
      return null;
    }
    const row = rows.find(
      (one) =>
        sameAddress(one.receiver, attestation.receiver) &&
        one.at === attestation.at &&
        one.distance === attestation.distance,
    );
    if (indexServesNetwork && row?.network !== undefined) {
      verdicts.push({ ...base, network: row.network });
      continue;
    }
    const txHash = transactionFor([...rows], attestation);
    if (txHash === undefined) {
      return null;
    }
    const delivery = await heldReportDelivery(txHash).catch(() => "unknown" as const);
    if (delivery === "unknown") {
      return null;
    }
    verdicts.push({ ...base, network: delivery === "network" });
  }
  return verdicts;
}

/** The title and date of another passport, read through the held document. A record that will not load costs the title only. */
async function otherPassport(id: Hex, line?: { registeredAt: number; metadataURI: string } | null): Promise<OtherPassport | null> {
  let registeredAt = line?.registeredAt;
  let metadataURI = line?.metadataURI;
  if (registeredAt === undefined || metadataURI === undefined) {
    try {
      const record = (await heldPassportRecord(id)).passport;
      if (record === null) {
        return null;
      }
      registeredAt = Number(record.registeredAt);
      metadataURI = record.metadataURI;
    } catch {
      return { id, title: null, registeredAt: 0 };
    }
  }
  const uri = metadataURI;
  const art = uri === "" ? null : await settle(async () => await heldArt(uri, id), null);
  return { id, title: art?.title ?? null, registeredAt };
}

/** The look-alike block's state from the index's answer and Moolam's search. */
async function lookalikeView(passport: Passport, facts: LookalikeFacts, sealed: boolean): Promise<LookalikeView> {
  if (facts.kind === "failed") {
    return { kind: "unread" };
  }
  const own = facts.kind === "rows" ? facts.own : null;
  if (own !== null && own.network && own.valid) {
    if (own.earlier === null) {
      return { kind: "none", at: own.executedAt };
    }
    const named = own.earlier;
    const earlier = await settle(async () => await otherPassport(named, own.earlierPassport), null);
    return earlier === null
      ? { kind: "unread" }
      : { kind: "found", earlier, sealed: own.earlierSealed, bits: own.phashDistance, at: own.executedAt };
  }
  // Moolam's search is asked only where Chainlink could still answer: a sealed
  // picture is never fetched, so the network will never confirm anything here.
  if (sealed) {
    return { kind: "quiet" };
  }
  const searched = await settle(async () => await heldSearchedEarlier(passport), null);
  if (searched === null) {
    return { kind: "quiet" };
  }
  const earlier = await settle(async () => await otherPassport(searched.id, searched), null);
  return earlier === null ? { kind: "quiet" } : { kind: "searching", earlier };
}

/**
 * Every read behind the mark on a passport page, from the same held reads the
 * page already makes, and the mark issued from them by the one function the
 * MCP server shares.
 */
export async function passportMarkFacts(passport: Passport, art: Art): Promise<PassportMarkFacts> {
  // Each read fails on its own into "could not be read", never into the page.
  const [record, rows, schema, lookalikes] = await Promise.all([
    settle(async () => await heldPassportRecord(passport.id), null),
    settle(async () => await heldIndexedVerdictRows(passport.id), null),
    settle(async () => await markSchema(), { network: false, lookalikes: false, networkCount: false }),
    settle(async (): Promise<LookalikeFacts> => await heldLookalikeFacts(passport.id), { kind: "failed" }),
  ]);

  const verdicts =
    record === null ? null : await networkVerdicts(passport, record.attestations, rows, schema.network);
  const dispute = record === null ? null : markDispute(passport, record.dispute);
  const picture = markPicture(passport, art);
  const ownRecord = lookalikes.kind === "rows" ? lookalikes.own : null;

  const mark = issueMark({
    dispute,
    verdicts,
    // An index that does not serve the rows yet predates every record
    // MoolamLookalikes can hold: the look-alike step and the redeploy that
    // teaches the index to read it land together. Until then there is no
    // record to find, and that is said as "none", never as an error.
    lookalike:
      lookalikes.kind === "failed"
        ? { read: false }
        : {
            read: true,
            record:
              ownRecord === null
                ? null
                : { network: ownRecord.network, valid: ownRecord.valid, earlier: ownRecord.earlier, executedAt: ownRecord.executedAt },
          },
    picture,
    phashLimit: MARK_PHASH_LIMIT,
  });

  const open = record?.dispute ?? null;
  const challenge =
    mark.state === "challenged" && open !== null
      ? { bond: formatEther(open.bond), answerBy: Number(open.openedAt) + ANSWER_DAYS * DAY_SECONDS }
      : null;

  const view = await lookalikeView(passport, lookalikes, art.sealed === true);
  const earlier =
    mark.state === "lookalike" && lightsLookalike(ownRecord) && view.kind === "found" ? view.earlier : null;

  const laterLine = lookalikes.kind === "rows" ? lookalikes.later : null;
  const later =
    laterLine === null ? null : await settle(async () => await otherPassport(laterLine.id, laterLine), null);

  return {
    mark,
    registeredAt: Number(passport.registeredAt),
    challenge,
    earlier,
    lookalike: view,
    later: { first: later, count: lookalikes.kind === "rows" ? lookalikes.laterCount : 0 },
    testRun: verdicts !== null && verdicts.some((verdict) => !verdict.network),
  };
}
