/** The one fetch shape the runner's clients are given, so a test can hand them a fake. */
export type Fetcher = typeof fetch;

export const DEFAULT_TIMEOUT_MS = 15_000;

export class HttpError extends Error {
  readonly status: number;

  constructor(what: string, status: number, body: string) {
    super(`${what} answered ${status}${body === "" ? "" : `: ${cut(body, 200)}`}`);
    this.name = "HttpError";
    this.status = status;
  }
}

/** A JSON POST with a timeout, failing loudly rather than returning an empty answer. */
export async function postJson<T>(
  fetcher: Fetcher,
  url: string,
  body: unknown,
  what: string,
  headers: Record<string, string> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new HttpError(what, response.status, await textOf(response));
  }
  return (await response.json()) as T;
}

export async function textOf(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

export function cut(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}
