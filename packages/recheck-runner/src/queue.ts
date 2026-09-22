import { HttpError, cut, textOf, type Fetcher } from "./net.js";

/** What happened when the runner tried to take a request off the queue. */
export type Claim = "claimed" | "not-requested" | "taken" | "disabled";

export interface DoneReport {
  passportId: string;
  reportTx?: string;
  matched?: boolean;
  distance?: number;
  reason?: string;
}

export interface QueueClient {
  /** The pending requests, oldest first. An empty list when the queue is switched off. */
  pending(): Promise<string[]>;
  claim(passportId: string): Promise<Claim>;
  done(report: DoneReport): Promise<void>;
}

/**
 * The verify service's re-check queue, as packages/verifier serves it.
 *
 * The queue route answers 503 when the service has no runner token set, which is a service that
 * is simply not running the queue rather than a fault: the runner then works from the index alone
 * and says so once. Every call carries the shared token, and nothing here ever logs it.
 */
export function queueClient(baseUrl: string, token: string, fetcher: Fetcher = fetch): QueueClient {
  const headers = { authorization: `Bearer ${token}` };

  return {
    async pending(): Promise<string[]> {
      const response = await fetcher(`${baseUrl}/recheck/queue`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 503) {
        return [];
      }
      if (!response.ok) {
        throw new HttpError("the re-check queue", response.status, await textOf(response));
      }
      return readIds(await response.json());
    },

    async claim(passportId: string): Promise<Claim> {
      const response = await post("claim", { passportId });
      if (response.ok) {
        return "claimed";
      }
      if (response.status === 409) {
        return "taken";
      }
      if (response.status === 503) {
        return "disabled";
      }
      return "not-requested";
    },

    async done(report: DoneReport): Promise<void> {
      const body: DoneReport = { ...report };
      if (body.reason !== undefined) {
        body.reason = cut(body.reason, 200);
      }
      const response = await post("done", body);
      if (!response.ok && response.status !== 503) {
        throw new HttpError("the re-check done route", response.status, await textOf(response));
      }
    },
  };

  function post(route: string, body: unknown): Promise<Response> {
    return fetcher(`${baseUrl}/recheck/${route}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  }
}

/**
 * The passport ids out of whatever shape the queue route returned.
 *
 * WO-121a fixes the record, `{ passportId, requestedAt, requestedBy }`, but not the envelope the
 * list arrives in, so a bare array and the three obvious wrappers are all read. Anything without
 * a passport id that looks like one is dropped rather than guessed at, because a malformed id
 * would be handed straight to the CRE CLI.
 */
export function readIds(body: unknown): string[] {
  const rows = listOf(body);
  const ids: string[] = [];
  for (const row of rows) {
    const id = typeof row === "string" ? row : idOf(row);
    if (id !== null && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

function listOf(body: unknown): unknown[] {
  if (Array.isArray(body)) {
    return body;
  }
  if (typeof body !== "object" || body === null) {
    return [];
  }
  const record = body as Record<string, unknown>;
  for (const key of ["requests", "queue", "pending", "items"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function idOf(row: unknown): string | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }
  const value = (row as Record<string, unknown>).passportId;
  return typeof value === "string" && isPassportId(value) ? value.toLowerCase() : null;
}

export function isPassportId(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}
