import type { Hex } from "viem";
import { activeSource, envioUrl } from "@/lib/data/source";

/**
 * What the index knows about disputes.
 *
 * The registry stores only the keccak256 of the evidence URI, so the URI itself
 * exists in one place: the PassportFlagged event. The index keeps it, which is
 * why the reason behind a challenge is read from here and then checked against
 * the hash the chain holds before anybody is shown it.
 *
 * The index also answers the one question the registry cannot: which disputes
 * are open right now. The contract has no list, so without the index the
 * resolver console would have to walk the log itself.
 */

/** One dispute row, exactly as the index keeps it, plus the passport it is against. */
export interface IndexedDispute {
  passportId: Hex;
  challenger: Hex;
  bond: bigint;
  evidenceHash: Hex;
  evidenceURI: string;
  /** 1 open, 2 upheld, 3 rejected. Mirrors DisputeStatus in the registry. */
  status: number;
  openedAt: bigint;
  resolvedAt: bigint | null;
  resolver: Hex | null;
  /** Where the picture and its words are pinned, for the thumbnail on the console. */
  metadataURI: string;
}

const FIELDS = `
  id
  challenger
  bond
  evidenceHash
  evidenceURI
  status
  openedAt
  resolvedAt
  resolver
  passport { metadataURI }
`;

const DISPUTE_OPEN = 1;

interface Row {
  id: string;
  challenger: string;
  bond: string;
  evidenceHash: string;
  evidenceURI: string;
  status: number;
  openedAt: string;
  resolvedAt: string | null;
  resolver: string | null;
  passport: { metadataURI: string } | null;
}

/** Whether this deployment has an index at all. Without one, neither read below can run. */
export function indexAvailable(): boolean {
  return activeSource() === "envio";
}

/**
 * Every dispute still waiting on the resolver, oldest first.
 *
 * Oldest first on purpose: the queue is worked from the front, and a challenger
 * who has waited longest should be the one answered next.
 */
export async function openDisputes(limit = 50): Promise<IndexedDispute[]> {
  const rows = await ask(
    `query OpenDisputes($status: Int!, $limit: Int!) {
      Dispute(where: { status: { _eq: $status } }, order_by: { openedAt: asc }, limit: $limit) {
        ${FIELDS}
      }
    }`,
    { status: DISPUTE_OPEN, limit },
  );

  return rows.map(shape);
}

/** The dispute on one passport, or null when the index has not seen one. */
export async function indexedDispute(passportId: Hex): Promise<IndexedDispute | null> {
  const rows = await ask(
    `query DisputeByPassport($id: String!) {
      Dispute(where: { id: { _eq: $id } }, limit: 1) {
        ${FIELDS}
      }
    }`,
    { id: passportId.toLowerCase() },
  );

  const row = rows[0];
  return row === undefined ? null : shape(row);
}

function shape(row: Row): IndexedDispute {
  return {
    passportId: row.id as Hex,
    challenger: row.challenger as Hex,
    bond: BigInt(row.bond),
    evidenceHash: row.evidenceHash as Hex,
    evidenceURI: row.evidenceURI,
    status: row.status,
    openedAt: BigInt(row.openedAt),
    resolvedAt: row.resolvedAt === null ? null : BigInt(row.resolvedAt),
    resolver: row.resolver === null ? null : (row.resolver as Hex),
    metadataURI: row.passport?.metadataURI ?? "",
  };
}

async function ask(query: string, variables: Record<string, unknown>): Promise<Row[]> {
  if (!indexAvailable()) {
    throw new Error("NEXT_PUBLIC_ENVIO_GRAPHQL_URL is not set, so the list of disputes cannot be read");
  }

  const response = await fetch(envioUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`the Envio endpoint answered ${response.status}`);
  }

  const body = (await response.json()) as { errors?: { message: string }[]; data?: { Dispute: Row[] } };

  if (body.errors !== undefined && body.errors.length > 0) {
    throw new Error(body.errors.map((entry) => entry.message).join("; "));
  }
  if (body.data === undefined) {
    throw new Error("the Envio endpoint returned no data block");
  }

  return body.data.Dispute;
}
