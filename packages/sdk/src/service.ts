import { isIP } from "node:net";
import type { z } from "zod";
import { MoolamPlatformError } from "./errors.js";
import { assertPlatformKey } from "./prepare.js";

/** Where the verify service is and the key the platform holds for it. */
export interface ServiceTarget {
  verifyUrl: string;
  platformKey: string;
}

/** Far above any answer the platform routes give that carries fields and ids but no picture. */
const MAX_ANSWER_BYTES = 256 * 1024;

/** The verify service refuses a signed file larger than its 20 MB upload limit, so nothing larger is taken. */
export const MAX_SIGNED_FILE_BYTES = 20 * 1024 * 1024;

/**
 * The platform-mode prepare answer carries the signed file as base64: at most the upload limit
 * written as base64, plus 64 KB for the fields around it. Only that one call reads this much.
 */
export const MAX_PREPARE_ANSWER_BYTES = Math.ceil(MAX_SIGNED_FILE_BYTES / 3) * 4 + 64 * 1024;

/** Whether a URL hostname is this machine: the one place plain http may carry a key, for local tests. */
function isLoopback(hostname: string): boolean {
  const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (bare === "localhost") return true;
  if (isIP(bare) === 4) return bare.startsWith("127.");
  return bare === "::1";
}

/**
 * A URL the kit may call, or MoolamPlatformError "invalid-input". It must be https, or http to this
 * machine only, and carry no user, password or fragment, and no query unless `query` allows one, so
 * a bearer key never travels in clear text to another host and nothing secret rides in the URL.
 */
export function checkedUrl(text: string, what: string, options: { query?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new MoolamPlatformError("invalid-input", `${what} must be a full URL`);
  }
  if (url.username !== "" || url.password !== "" || (url.search !== "" && options.query !== true) || url.hash !== "") {
    throw new MoolamPlatformError("invalid-input", `${what} must carry no user, password, query or fragment`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new MoolamPlatformError("invalid-input", `${what} must use https`);
  }
  return url;
}

function serviceUrl(verifyUrl: string, path: string): URL {
  const base = checkedUrl(verifyUrl, "verifyUrl");
  base.pathname = `${base.pathname.replace(/\/+$/, "")}${path}`;
  return base;
}

/** The body of a response, stopped at `cap` bytes, however long the sender makes it. */
export async function readCapped(response: Response, cap: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > cap) {
    await response.body?.cancel();
    throw new MoolamPlatformError("unexpected-answer", `the answer is larger than ${cap} bytes`);
  }
  if (response.body === null) {
    return new Uint8Array(0);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      throw new MoolamPlatformError("unexpected-answer", `the answer is larger than ${cap} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function shortText(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 300) : undefined;
}

/**
 * One call to a platform route. The platform key travels only in the Authorization header: never in
 * the URL, the body, an error or a log line, and the kit logs nothing at all. A redirect is refused,
 * so the header can never follow one to another host. Errors name the route by `what` rather than by
 * URL, because a co-sign URL carries its handle.
 *
 * Throws MoolamPlatformError: "invalid-input" for a bad key or URL, "service-unreachable" when no
 * answer came in time, "service-refused" with the service's status and error code for a non-2xx
 * answer, and "unexpected-answer" for an answer that fails `schema`.
 */
export async function callService<Output>(
  target: ServiceTarget,
  call: {
    method: "GET" | "POST";
    path: string;
    what: string;
    body?: FormData | Record<string, unknown>;
    timeoutMs: number;
    /** The most the answer may be. Left out, 256 KB, which every answer without a picture fits. */
    maxAnswerBytes?: number;
  },
  schema: z.ZodType<Output>,
): Promise<Output> {
  assertPlatformKey(target.platformKey);
  const url = serviceUrl(target.verifyUrl, call.path);
  const headers: Record<string, string> = { authorization: `Bearer ${target.platformKey}`, accept: "application/json" };
  let body: FormData | string | undefined;
  if (call.body instanceof FormData) {
    body = call.body;
  } else if (call.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(call.body);
  }

  let response: Response;
  let bytes: Uint8Array;
  try {
    response = await fetch(url, {
      method: call.method,
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(call.timeoutMs),
    });
    bytes = await readCapped(response, call.maxAnswerBytes ?? MAX_ANSWER_BYTES);
  } catch (error) {
    if (error instanceof MoolamPlatformError) throw error;
    throw new MoolamPlatformError("service-unreachable", `the verify service did not answer ${call.what}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const answer = (parsed ?? {}) as Record<string, unknown>;
    throw new MoolamPlatformError(
      "service-refused",
      `the verify service refused ${call.what} with ${response.status}${typeof answer.error === "string" ? `: ${shortText(answer.error)}` : ""}`,
      { status: response.status, error: shortText(answer.error), reason: shortText(answer.reason) },
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new MoolamPlatformError("unexpected-answer", `the verify service's answer to ${call.what} is not in the shape the kit expects`);
  }
  return result.data;
}
