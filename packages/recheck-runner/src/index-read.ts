import { postJson, type Fetcher } from "./net.js";
import { isPassportId } from "./queue.js";

/** One passport as the Envio index holds it, reduced to what a re-check run needs. */
export interface PassportRow {
  id: string;
  metadataURI: string;
  /** Unix seconds. */
  registeredAt: number;
  /** The transaction that carried the registration. The index is the only place this is written. */
  txHash: string;
  attestationCount: number;
}

export interface IndexClient {
  /**
   * Real candidates for a sweep: nothing re-checked, registered before the given second, and none of
   * the excluded ids. The exclusion is in the query rather than applied after it, so passports the
   * runner has already settled cannot fill the page and hide an older one (tally R3).
   */
  unrechecked(before: number, limit: number, excluding?: readonly string[]): Promise<PassportRow[]>;
  byId(passportId: string): Promise<PassportRow | null>;
}

const FIELDS = "id metadataURI registeredAt txHash attestationCount";

const LIST = `query UnrecheckedPassports($where: Passport_bool_exp!, $limit: Int!) {
  Passport(where: $where, order_by: [{ registeredAt: desc }, { id: desc }], limit: $limit) {
    ${FIELDS}
  }
}`;

const ONE = `query PassportById($id: String!) {
  Passport(where: { id: { _eq: $id } }, limit: 1) {
    ${FIELDS}
  }
}`;

/**
 * The index, asked two questions and nothing else.
 *
 * The hosted index allows on the order of a hundred queries a minute shared with the live site,
 * so the sweep is one query a pass and a queued request costs one more. At the default two minute
 * interval that is well under one query a minute from this process.
 */
export function indexClient(url: string, fetcher: Fetcher = fetch): IndexClient {
  return {
    async unrechecked(before: number, limit: number, excluding: readonly string[] = []): Promise<PassportRow[]> {
      const where = {
        _and: [
          { attestationCount: { _eq: 0 } },
          { registeredAt: { _lt: String(before) } },
          ...(excluding.length === 0 ? [] : [{ id: { _nin: excluding.map((one) => one.toLowerCase()) } }]),
        ],
      };
      return rowsOf(await ask(LIST, { where, limit }));
    },

    async byId(passportId: string): Promise<PassportRow | null> {
      const rows = rowsOf(await ask(ONE, { id: passportId.toLowerCase() }));
      return rows[0] ?? null;
    },
  };

  async function ask(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const body = await postJson<{ errors?: { message: string }[]; data?: unknown }>(
      fetcher,
      url,
      { query, variables },
      "the index",
    );
    if (body.errors !== undefined && body.errors.length > 0) {
      throw new Error(`the index refused the query: ${body.errors.map((one) => one.message).join("; ")}`);
    }
    if (body.data === undefined) {
      throw new Error("the index returned no data block");
    }
    return body.data;
  }
}

/**
 * The rows out of a GraphQL answer.
 *
 * Envio serves a BigInt column as a decimal string and an Int as a number, so the timestamp and
 * the count are both read through Number rather than assumed to be one or the other.
 */
export function rowsOf(data: unknown): PassportRow[] {
  const list = (data as { Passport?: unknown }).Passport;
  if (!Array.isArray(list)) {
    return [];
  }
  const rows: PassportRow[] = [];
  for (const entry of list) {
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.toLowerCase() : "";
    const txHash = typeof row.txHash === "string" ? row.txHash : "";
    // A malformed id is dropped here as the queue drops one. A malformed txHash is kept, so the
    // runner can refuse that passport by name rather than say it is missing from the index.
    if (!isPassportId(id) || txHash === "") {
      continue;
    }
    rows.push({
      id,
      metadataURI: typeof row.metadataURI === "string" ? row.metadataURI : "",
      registeredAt: Number(row.registeredAt ?? 0),
      txHash,
      attestationCount: Number(row.attestationCount ?? 0),
    });
  }
  return rows;
}
