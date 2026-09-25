import fs from "node:fs";
import { passportKey } from "./document.js";
import type { Fetcher } from "./net.js";

/**
 * What the verify service's GET /sealed/status said about a passport's private copy. "unknown" is
 * its own answer and is never read as either of the others: a copy nobody could look up is neither
 * there to spend a report on nor gone for good.
 */
export type CopyState = "kept" | "gone" | "unknown";

/** The variable the sealed workflow's secrets.yaml maps SEALED_LINK_TOKEN to. */
export const SEALED_TOKEN_NAME = "CRE_SEALED_LINK_TOKEN";

const TIMEOUT_MS = 10_000;
const PASSPORT_ID = /^0x[0-9a-f]{64}$/;

/**
 * Asks the verify service whether this passport's private copy is still kept.
 *
 * Only a 200 whose body names this same passport and says kept or gone is taken at its word.
 * Every other outcome, a timeout, another status, a body that is not JSON, one about another
 * passport or a state this code does not know, is "unknown".
 */
export async function readSealedStatus(
  serviceUrl: string,
  passportId: string,
  fetcher: Fetcher = fetch,
): Promise<CopyState> {
  const id = passportKey(passportId);
  if (!PASSPORT_ID.test(id)) {
    return "unknown";
  }

  let response: Response;
  try {
    response = await fetcher(`${serviceUrl}/sealed/status/${id}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return "unknown";
  }
  if (response.status !== 200) {
    return "unknown";
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return "unknown";
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "unknown";
  }
  const answer = body as Record<string, unknown>;
  if (typeof answer.passportId !== "string" || passportKey(answer.passportId) !== id) {
    return "unknown";
  }
  return answer.state === "kept" || answer.state === "gone" ? answer.state : "unknown";
}

/**
 * The value one name has in an env file, or null when the file cannot be read, the name is not in
 * it, or its value is empty.
 *
 * The runner reads this for two things only: to refuse a sealed run whose CRE CLI would have no
 * token to hand the enclave, and to strip that value out of any reason it posts or logs. The value
 * is never printed, and nothing else in the file is kept.
 */
export function envFileValue(file: string, name: string): string | null {
  const found = readEnvFile(file)?.get(name) ?? null;
  return found === null || found === "" ? null : found;
}

/**
 * Every value assigned in an env file, or an empty list when the file cannot be read. Used only to
 * strip those values out of every reason and log line (R11); nothing here is ever printed.
 */
export function envFileValues(file: string): string[] {
  return [...(readEnvFile(file)?.values() ?? [])].filter((value) => value !== "");
}

function readEnvFile(file: string): Map<string, string> | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    const equals = line.indexOf("=");
    if (line.startsWith("#") || equals === -1) {
      continue;
    }
    // The last assignment wins, as it does for the dotenv reader the CLI uses.
    values.set(line.slice(0, equals).trim(), unquote(line.slice(equals + 1).trim()));
  }
  return values;
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted === null ? value : (quoted[2] ?? "");
}

/**
 * The host of the verify service's address, so a reason can be stripped of it even where the CLI
 * printed it without a scheme. Null when the address does not parse.
 */
export function serviceHost(serviceUrl: string): string | null {
  try {
    return new URL(serviceUrl).host || null;
  } catch {
    return null;
  }
}
