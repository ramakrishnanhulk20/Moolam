import { McpServer } from "@modelcontextprotocol/server";
import type { FastifyRequest } from "fastify";
import type { McpDeps } from "./facts.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

/**
 * A fresh server for one HTTP request, the stateless shape both protocol eras are served in: it
 * holds nothing between requests, and it is built the same way for every caller, so the tool and
 * resource lists never vary.
 */
export function moolamMcpServer(deps: McpDeps, request: FastifyRequest): McpServer {
  const server = new McpServer({ name: "moolam", title: "Moolam", version: deps.app.verifier.version });
  registerTools(server, deps, request);
  registerResources(server, deps);
  return server;
}
