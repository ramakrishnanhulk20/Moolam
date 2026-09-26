import { HttpError, cut, textOf, type Fetcher } from "./net.js";

/**
 * What happened when the runner tried to take a request off the queue. "taken" is a request somebody
 * is running now; "finished" is one already answered, which the service also refuses with a 409 but
 * which nobody holds.
 */
export type Claim = "claimed" | "not-requested" | "taken" | "finished" | "disabled";

/**
 * What happened when the runner asked the queue for a request of its own. "sealed" is the queue's
 * 409: it reads the passport's private copy as gone, so there is nothing for a sealed run to open.
 */
export type Placed = "placed" | "sealed" | "failed";

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
  /**
   * Makes sure a request exists for this passport, the public POST /recheck/request. A sealed run
   * needs one, because the service mints a private link only for a passport the runner has claimed.
   */
  request(passportId: string): Promise<Placed>;
  claim(passportId: string): Promise<Claim>;
  done(report: DoneReport): Promise<void>;
}

/**
 * How long to wait before each further try at POST /recheck/done, doubling each time. Three tries
 * in about six seconds ride out a redeploy's restart or one dropped connection, and stay short
 * against the ten minutes a run itself may take.
 */
export const DONE_RETRY_DELAYS_MS = [2_000, 4_000] as const;

export interface QueueClientOptions {
  /** Swapped in tests so a retry costs no real waiting. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Whether a done that was not accepted may be accepted if sent again: the connection failing, a
 * timeout, a 429 or any 5xx, a 503 included. A 4xx such as 409 not-running is the service's
 * answer about this request, and sending it again cannot change it.
 */
function worthRetrying(status: number | undefined): boolean {
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

/**
 * The verify service's re-check queue, as packages/verifier serves it.
 *
 * The queue route answers 503 when the service has no runner token set, which is a service that
 * is simply not running the queue rather than a fault: the runner then works from the index alone
 * and says so once. Every call carries the shared token, and nothing here ever logs it.
 */
export function queueClient(
  baseUrl: string,
  token: string,
  fetcher: Fetcher = fetch,
  options: QueueClientOptions = {},
): QueueClient {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
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

    async request(passportId: string): Promise<Placed> {
      // The public route, so the runner token is not sent with it.
      let response: Response;
      try {
        response = await fetcher(`${baseUrl}/recheck/request`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ passportId }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        return "failed";
      }
      if (response.ok) {
        return "placed";
      }
      return response.status === 409 ? "sealed" : "failed";
    },

    async claim(passportId: string): Promise<Claim> {
      const response = await post("claim", { passportId });
      if (response.ok) {
        return "claimed";
      }
      if (response.status === 409) {
        // Only the service's own word for a finished request reads as finished. Anything else under
        // a 409, a body that is not JSON included, reads as taken, which runs nothing.
        return (await errorOf(response)) === "not-pending" ? "finished" : "taken";
      }
      if (response.status === 503) {
        return "disabled";
      }
      return "not-requested";
    },

    // Only a 2xx means the service recorded the verdict. A 503 used to read as delivered, which left
    // the request "running" on the service after a redeploy (review pass 4, V19), so every other
    // answer is a failure here, tried again while it may pass and thrown once it will not.
    async done(report: DoneReport): Promise<void> {
      const body: DoneReport = { ...report };
      if (body.reason !== undefined) {
        body.reason = cut(body.reason, 200);
      }
      for (let attempt = 0; ; attempt += 1) {
        let failure: Error;
        let status: number | undefined;
        try {
          const response = await post("done", body);
          if (response.ok) {
            return;
          }
          status = response.status;
          failure = new HttpError("the re-check done route", response.status, await textOf(response));
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
        const delay = DONE_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !worthRetrying(status)) {
          throw failure;
        }
        await sleep(delay);
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

async function errorOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as unknown;
    const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
    return typeof error === "string" ? error : null;
  } catch {
    return null;
  }
}

/**
 * The passport ids out of whatever shape the queue route returned.
 *
 * The record's shape is fixed, `{ passportId, requestedAt, requestedBy }`, but not the envelope the
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

/**
 * A transaction hash is 32 bytes as well, so it is held to the passport id's own predicate rather
 * than a second pattern that could drift from it. Anything else, a flag included, never reaches
 * the CRE CLI's argv.
 */
export function isTxHash(value: string): boolean {
  return isPassportId(value);
}
