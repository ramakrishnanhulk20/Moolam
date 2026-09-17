import { unstable_cache } from "next/cache";
import type { Hex } from "viem";
import { CACHE_TAGS, HOLD_SECONDS } from "@/lib/chain/client";
import { passportTag } from "@/lib/chain/registry";
import { activeSource, envioUrl } from "@/lib/data/source";

/** One attestation as the index holds it, which is the only place its transaction exists. */
export interface IndexedAttestation {
  txHash: Hex;
  receiver: string;
  matched: boolean;
  distance: number;
  at: bigint;
}

const QUERY = `query AttestationsOn($passport: String!) {
  Attestation(where: { passport_id: { _eq: $passport } }, order_by: { at: asc }) {
    id
    receiver
    matched
    distance
    at
  }
}`;

/**
 * The attestation rows the index holds for one passport.
 *
 * The registry stores who wrote a re-check and when, but not which transaction
 * carried it. Envio keys each row as "<txHash>-<logIndex>", so the link to the
 * transaction can only come from here. This read lives beside the page rather
 * than in lib/data because the passport screen is the only thing that wants it.
 *
 * Returns an empty list when there is no index configured or it will not answer:
 * the page still has every fact the chain gave it, minus the link.
 */
export async function indexedAttestations(passportId: Hex): Promise<IndexedAttestation[]> {
  return (await attestationRows(passportId)).map(toAttestation);
}

/**
 * The same rows, held for a minute under this passport's own name.
 *
 * The passport page is built once and handed to everybody who asks inside that
 * minute, and this query is what stands between the re-check row and its
 * transaction link. A write to the record drops the name, so a re-check that
 * lands is one refresh away rather than a minute.
 */
export async function heldIndexedAttestations(passportId: Hex): Promise<IndexedAttestation[]> {
  const held = unstable_cache(
    async () => await attestationRows(passportId),
    ["moolam-passport-attestations", passportId.toLowerCase()],
    { revalidate: HOLD_SECONDS, tags: [CACHE_TAGS.index, passportTag(passportId)] },
  );
  return (await held()).map(toAttestation);
}

/** One row with its timestamp still a string, because a bigint cannot be held. */
interface AttestationRow {
  txHash: Hex;
  receiver: string;
  matched: boolean;
  distance: number;
  at: string;
}

function toAttestation(row: AttestationRow): IndexedAttestation {
  return { ...row, at: BigInt(row.at) };
}

async function attestationRows(passportId: Hex): Promise<AttestationRow[]> {
  if (activeSource() !== "envio") {
    return [];
  }

  try {
    const response = await fetch(envioUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { passport: passportId } }),
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });

    if (!response.ok) {
      return [];
    }

    const body = (await response.json()) as {
      data?: { Attestation: { id: string; receiver: string; matched: boolean; distance: number; at: string }[] };
    };

    return (body.data?.Attestation ?? []).flatMap((row) => {
      const hash = row.id.split("-")[0];
      return hash.startsWith("0x")
        ? [{ txHash: hash as Hex, receiver: row.receiver, matched: row.matched, distance: row.distance, at: row.at }]
        : [];
    });
  } catch {
    return [];
  }
}

/**
 * Pairs the chain's attestations with the index's, so a row can carry its
 * transaction link. Receiver, timestamp and distance together are enough: two
 * rows that agreed on all three would be the same re-check written twice.
 */
export function transactionFor(
  indexed: IndexedAttestation[],
  attestation: { receiver: string; at: bigint; distance: number },
): Hex | undefined {
  const found = indexed.find(
    (row) =>
      row.receiver.toLowerCase() === attestation.receiver.toLowerCase() &&
      row.at === attestation.at &&
      row.distance === attestation.distance,
  );
  return found?.txHash;
}
