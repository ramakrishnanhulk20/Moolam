import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
  type ReadResourceResult,
  type Variables,
} from "@modelcontextprotocol/server";
import type { Hex } from "../types.js";
import { passportFacts, termsFacts, type McpDeps, type Outcome } from "./facts.js";
import { MAX_RESULT_CHARS, PASSPORT_ID_PATTERN, RESULT_TOO_LARGE, passportKey } from "./inputs.js";

const NOT_AN_ID = "the id in this address is not a passport id: 0x and 64 hex characters";

/** The id in a resource address, shape-checked before any read (M2). */
function idFrom(variables: Variables): Hex {
  const raw = variables.id;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !PASSPORT_ID_PATTERN.test(value)) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, NOT_AN_ID);
  }
  return passportKey(value);
}

/**
 * One resource read's contents, the same JSON the matching tool returns. An id the chain says was
 * never registered is the JSON-RPC not-found error; a read that failed is an internal error with
 * the service's fixed sentence, never an empty document (M3).
 */
function contents(uri: URL, result: Outcome<{ found: boolean }>): ReadResourceResult {
  if (!result.ok) {
    throw new ProtocolError(ProtocolErrorCode.InternalError, result.reason);
  }
  if (!result.value.found) {
    throw new ResourceNotFoundError(uri.href);
  }
  const text = JSON.stringify(result.value);
  if (text.length > MAX_RESULT_CHARS) {
    throw new ProtocolError(ProtocolErrorCode.InternalError, RESULT_TOO_LARGE);
  }
  return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
}

/** The two resources. Neither can be listed: there is no way to enumerate passports here but the tool. */
export function registerResources(server: McpServer, deps: McpDeps): void {
  server.registerResource(
    "passport",
    new ResourceTemplate("moolam://passport/{id}", { list: undefined }),
    {
      title: "Moolam passport",
      description: "The same facts get_passport returns, for the passport id in the address.",
      mimeType: "application/json",
    },
    async (uri, variables) => contents(uri, await passportFacts(deps, idFrom(variables))),
  );

  server.registerResource(
    "terms",
    new ResourceTemplate("moolam://terms/{id}", { list: undefined }),
    {
      title: "Moolam AI-use terms",
      description: "The same statement get_ai_use_terms returns for now, for the passport id in the address.",
      mimeType: "application/json",
    },
    async (uri, variables) => contents(uri, await termsFacts(deps, idFrom(variables))),
  );
}
