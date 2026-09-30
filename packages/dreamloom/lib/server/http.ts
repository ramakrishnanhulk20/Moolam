import { EnvError, canonicalOrigin, env } from "./env";

/**
 * Every word a refusal can carry. A refusal is JSON with one of these and nothing else from the
 * failure itself: no stack, no key, no handle, no upstream message.
 */
export type RefusalWord =
  | "not-found"
  | "prompt"
  | "terms"
  | "title"
  | "origin"
  | "address"
  | "recipient"
  | "state"
  | "not-holder"
  | "forgotten"
  | "refused"
  | "limit"
  | "busy"
  | "closed"
  | "upstream";

const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE, ...headers },
  });
}

export function refuse(status: number, error: RefusalWord, extra: Record<string, string> = {}): Response {
  return json(status, { ...extra, error });
}

/** Image bytes for the owning session only, never cached by a browser or a proxy. */
export function image(bytes: Uint8Array, contentType: string): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": contentType, "content-length": String(bytes.byteLength), ...NO_STORE },
  });
}

/** Far above the largest body any route takes: a 600 character prompt, a terms word or an address. */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * The request's JSON object, or null for anything else: a body that is not application/json, is
 * larger than MAX_BODY_BYTES, does not parse, or is not a plain object. Requiring the JSON type
 * also means a page on another site cannot post here without a preflight this server never answers.
 */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type.trim())) return null;
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return null;
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Whether a POST comes from Dreamloom's own pages: its Origin header, put through the same parser
 * as DREAMLOOM_ORIGIN, equals it exactly. No header is a refusal. This sits behind SameSite=Lax and
 * the JSON content type, so a gap in either one alone does not let another site act for a visitor.
 */
export function originAllowed(request: Request): boolean {
  const header = request.headers.get("origin");
  return header !== null && canonicalOrigin(header) === env().origin;
}

/** One log line with fixed words only. Nothing a caller sent and nothing an upstream said goes in. */
export function logLine(what: string, word: string): void {
  console.error(`dreamloom: ${what}: ${word}`);
}

/**
 * Runs a route with its failures turned into fixed words. Settings that cannot run the server stop
 * it in production, after naming the variables, so the host restarts it into the same clear line
 * rather than serving with half its keys. Any other unexpected failure is logged by its class name
 * only, since a viem or OpenAI message can quote an RPC URL that carries a provider key.
 */
export async function guarded(run: () => Promise<Response>, stop: () => void = stopServer): Promise<Response> {
  try {
    env();
    return await run();
  } catch (error) {
    if (error instanceof EnvError) {
      console.error(error.message);
      if (process.env.NODE_ENV === "production") stop();
      return refuse(503, "closed");
    }
    logLine("request failed", error instanceof Error ? error.name : "unknown");
    return refuse(503, "busy");
  }
}

function stopServer(): void {
  setImmediate(() => process.exit(1));
}
