import { unstable_cache } from "next/cache";
import type { Hex } from "viem";
import { CACHE_TAGS, HOLD_SECONDS } from "@/lib/chain/client";
import { sameAddress } from "@/lib/chain/receivers";
import { passportTag } from "@/lib/chain/registry";
import { markSchema } from "@/lib/data/marks";
import { activeSource, envioUrl } from "@/lib/data/source";

/** One attestation as the index holds it, which is the only place its transaction exists. */
export interface IndexedAttestation {
  txHash: Hex;
  receiver: string;
  matched: boolean;
  distance: number;
  at: bigint;
  /**
   * True when the index says Chainlink's network delivered this verdict (L4).
   * Left out by an index that does not serve the field yet, which is a fact
   * nobody can read, never a "no".
   */
  network?: boolean;
}

/** The rows, with the network flag only where the index serves it, so an older index still answers. */
function queryFor(network: boolean): string {
  return `query AttestationsOn($passport: String!) {
  Attestation(where: { passport_id: { _eq: $passport } }, order_by: { at: asc }) {
    id
    receiver
    matched
    distance
    at
    ${network ? "network" : ""}
  }
}`;
}

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
  return (await heldIndexedVerdictRows(passportId)) ?? [];
}

/**
 * The same held rows, or null when the index was asked and did not answer.
 *
 * The trust mark needs that difference: an empty list from an index that
 * answered says no verdict carries a network flag, and a failed read says
 * nothing at all (L32). A failure is thrown inside the hold so it is never
 * kept for the minute.
 */
export async function heldIndexedVerdictRows(passportId: Hex): Promise<IndexedAttestation[] | null> {
  if (activeSource() !== "envio") {
    return [];
  }
  const held = unstable_cache(
    async () => await readAttestationRows(passportId),
    ["moolam-passport-attestations", passportId.toLowerCase()],
    { revalidate: HOLD_SECONDS, tags: [CACHE_TAGS.index, passportTag(passportId)] },
  );
  try {
    return (await held()).map(toAttestation);
  } catch (error) {
    if ((error as Error | undefined)?.message?.includes("incrementalCache") === true) {
      try {
        return (await readAttestationRows(passportId)).map(toAttestation);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** One row with its timestamp still a string, because a bigint cannot be held. */
interface AttestationRow {
  txHash: Hex;
  receiver: string;
  matched: boolean;
  distance: number;
  at: string;
  network?: boolean;
}

function toAttestation(row: AttestationRow): IndexedAttestation {
  return { ...row, at: BigInt(row.at) };
}

async function attestationRows(passportId: Hex): Promise<AttestationRow[]> {
  if (activeSource() !== "envio") {
    return [];
  }
  try {
    return await readAttestationRows(passportId);
  } catch {
    return [];
  }
}

/** One read of the index's rows for a passport. Throws when the index does not answer. */
async function readAttestationRows(passportId: Hex): Promise<AttestationRow[]> {
  const network = (await markSchema()).network;
  const response = await fetch(envioUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: queryFor(network), variables: { passport: passportId } }),
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`the Envio endpoint answered ${response.status}`);
  }

  const body = (await response.json()) as {
    errors?: unknown[];
    data?: {
      Attestation: { id: string; receiver: string; matched: boolean; distance: number; at: string; network?: boolean }[];
    };
  };
  if ((body.errors?.length ?? 0) > 0 || body.data === undefined) {
    throw new Error("the Envio endpoint did not return the attestation rows");
  }

  return body.data.Attestation.flatMap((row) => {
    const hash = row.id.split("-")[0];
    return hash.startsWith("0x")
      ? [
          {
            txHash: hash as Hex,
            receiver: row.receiver,
            matched: row.matched,
            distance: row.distance,
            at: row.at,
            ...(network && typeof row.network === "boolean" ? { network: row.network } : {}),
          },
        ]
      : [];
  });
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
      sameAddress(row.receiver, attestation.receiver) &&
      row.at === attestation.at &&
      row.distance === attestation.distance,
  );
  return found?.txHash;
}
