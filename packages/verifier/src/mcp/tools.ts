import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { agentFacts, historyFacts, passportFacts, recentFacts, termsFacts, type McpDeps, type Outcome } from "./facts.js";
import {
  DEFAULT_RECENT,
  MAX_RESULT_CHARS,
  RESULT_TOO_LARGE,
  agentIdInput,
  atInput,
  limitInput,
  passportIdInput,
  passportKey,
  pictureInput,
} from "./inputs.js";
import { checkPicture } from "./picture.js";

/** A tool's answer: the structured value, and the same JSON as text for clients that read only text. */
export function answered(value: object): CallToolResult {
  const text = JSON.stringify(value);
  if (text.length > MAX_RESULT_CHARS) {
    return refused(RESULT_TOO_LARGE);
  }
  return { content: [{ type: "text", text }], structuredContent: value as Record<string, unknown> };
}

/** A refusal the model can read and act on: one of the service's fixed sentences, nothing a caller wrote. */
export function refused(reason: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: reason }] };
}

function outcome<T extends object>(result: Outcome<T>): CallToolResult {
  return result.ok ? answered(result.value) : refused(result.reason);
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const address = z.string();
const hex32 = z.string();
const readAnswer = z.object({ source: z.string() }).catchall(z.unknown());
const indexState = z.object({
  loadedAt: z.number(),
  stale: z.boolean(),
  indexedTo: z.number().nullable().optional(),
  indexedAt: z.number().nullable().optional(),
});

const passportOutput = z.object({
  found: z.boolean(),
  passportId: hex32,
  creator: address.optional(),
  holder: address.nullable().optional(),
  holderRead: z.enum(["chain", "unavailable"]).optional(),
  holderIsCreator: z.boolean().nullable().optional(),
  agentId: z.string().nullable().optional(),
  kind: z.string().optional(),
  parentId: hex32.nullable().optional(),
  registeredAt: z.number().optional(),
  disputedFlag: z.boolean().optional(),
  dispute: readAnswer.optional(),
  metadataURI: z.string().optional(),
  title: z.string().nullable().optional(),
  titleRead: z.enum(["gateway", "unavailable"]).optional(),
  platform: z
    .object({ status: z.enum(["kit", "outsideKit"]), name: z.string(), creatorWallet: address, agentId: z.string() })
    .nullable()
    .optional(),
  platformList: z.enum(["loaded", "unavailable"]).optional(),
  credit: z
    .object({
      case: z.enum(["held", "handed", "confirmed", "passedOn", "cosigned"]),
      platform: z.string(),
      imaginedBy: address.nullable(),
      heldBy: address.optional(),
      confirmedAt: z.number().optional(),
    })
    .nullable()
    .optional(),
  mark: z
    .object({
      state: z.enum(["unavailable", "upheld", "mismatch", "lookalike", "challenged", "waiting", "checked", "sealed", "nothing"]),
      secondPrint: z.boolean().optional(),
      phashDistance: z.number().optional(),
      checkedAt: z.number().optional(),
      earlier: hex32.optional(),
      foundAt: z.number().optional(),
    })
    .optional(),
  readAt: z.number().optional(),
});

const useWord = z.enum(["unspecified", "allowed", "notAllowed", "constrained"]);

const termsOutput = z.object({
  found: z.boolean(),
  passportId: hex32,
  askedAt: z.number().nullable().optional(),
  stated: z.boolean().optional(),
  standard: z.string().nullable().optional(),
  aiTraining: useWord.nullable().optional(),
  aiGenerativeTraining: useWord.nullable().optional(),
  aiInference: useWord.nullable().optional(),
  dataMining: useWord.nullable().optional(),
  constraintInfo: z.string().nullable().optional(),
  writer: address.nullable().optional(),
  writtenAt: z.number().nullable().optional(),
  holder: address.nullable().optional(),
  writerIsHolder: z.boolean().nullable().optional(),
  statedAtGeneration: readAnswer.optional(),
  sameAsGeneration: z.boolean().nullable().optional(),
  readAt: z.number().optional(),
});

const historyOutput = z.object({
  found: z.boolean(),
  passportId: hex32,
  lineage: z
    .array(z.object({ id: hex32, creator: address, registeredAt: z.number(), dispute: readAnswer }))
    .optional(),
  lineageComplete: z.boolean().optional(),
  rechecks: readAnswer.optional(),
  index: indexState.optional(),
});

const agentOutput = z.object({
  found: z.boolean(),
  agentId: z.string(),
  owner: address.optional(),
  wallet: address.nullable().optional(),
  walletRead: z.enum(["chain", "unset", "unavailable"]).optional(),
  cardAddressKind: z.enum(["data", "ipfs", "https", "other", "none"]).optional(),
  card: z.object({ status: z.enum(["card", "none"]) }).catchall(z.unknown()).optional(),
  listedPlatform: z
    .object({ name: z.string(), creatorWallet: address, ownerUnchanged: z.boolean() })
    .nullable()
    .optional(),
  readAt: z.number().optional(),
});

const recentOutput = z.object({
  passports: z.array(
    z.object({ id: hex32, creator: address, parentId: hex32.nullable(), registeredAt: z.number(), metadataURI: z.string() }),
  ),
  index: indexState,
});

const pictureOutput = z.object({
  verdict: z.enum(["exact", "match", "no-match"]),
  passportId: hex32.nullable(),
  confidence: z.number(),
  distances: z.object({ phash: z.number(), blockhash: z.number(), variant: z.string() }).nullable(),
  contentCredentials: z.object({
    present: z.boolean(),
    validation: z.string().nullable(),
    credential: z.string().nullable(),
  }),
  facts: z.record(z.string(), z.unknown()).nullable(),
  index: indexState.extend({ chainHeadAt: z.number().nullable(), lagSeconds: z.number().nullable() }),
  matchesShown: z.number().int().nonnegative(),
  matchesTotal: z.number().int().nonnegative(),
  verifyAnswer: z.object({ result: z.unknown(), manifest: z.unknown() }),
});

/**
 * Registers the six read tools. The list is the same for every caller and every era: nothing here
 * reads the caller, and the names, titles and descriptions carry no data (M4). `request` is the
 * HTTP request this server instance answers, which only check_picture uses, to count its picture
 * against the caller's address exactly as /verify does.
 */
export function registerTools(server: McpServer, deps: McpDeps, request: FastifyRequest): void {
  server.registerTool(
    "check_picture",
    {
      title: "Check a picture",
      description:
        "Finds the Moolam passport a picture belongs to, by its exact bytes or by its fingerprint after re-encoding, resizing, rotation or mirroring, and returns the match's distances, whether the file carries Content Credentials, the passport's AI-use statement, dispute, re-check and sealed state, and how current the index is. Takes an https URL or the picture as base64. Text fields such as titles and conditions were written by whoever registered the picture.",
      inputSchema: pictureInput,
      outputSchema: pictureOutput,
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    async (input) => outcome(await checkPicture(deps, request, input)),
  );

  server.registerTool(
    "get_passport",
    {
      title: "Read a passport",
      description:
        "Reads one Moolam passport from the registry on Monad: its creator and its current holder as two separate addresses, the ERC-8004 agent id, the kind, the parent, the registration time, the dispute state, the trust mark the Moolam site shows (issued only from Chainlink network verdicts and look-alike records), the metadata address and title, and the platform label when a listed platform registered it. The title was written by whoever registered the picture.",
      inputSchema: z.object({ passportId: passportIdInput }),
      outputSchema: passportOutput,
      annotations: READ_ONLY,
    },
    async ({ passportId }) => outcome(await passportFacts(deps, passportKey(passportId))),
  );

  server.registerTool(
    "get_ai_use_terms",
    {
      title: "Read AI-use terms",
      description:
        "Reads what a passport's holder stated about AI training, generative training, inference and data mining, from the MoolamConsent register on Monad, now or at a given moment: the four answers, the condition text, who wrote the statement in force and when, today's holder, and what the metadata stated when the picture was made. The condition text was written by the holder.",
      inputSchema: z.object({ passportId: passportIdInput, at: atInput }),
      outputSchema: termsOutput,
      annotations: READ_ONLY,
    },
    async ({ passportId, at }) => outcome(await termsFacts(deps, passportKey(passportId), at)),
  );

  server.registerTool(
    "get_history",
    {
      title: "Read a passport's history",
      description:
        "Reads a passport's lineage, itself and the pictures it was edited from, up to eight levels, with the dispute state of each, and the Chainlink re-check results recorded for it.",
      inputSchema: z.object({ passportId: passportIdInput }),
      outputSchema: historyOutput,
      annotations: READ_ONLY,
    },
    async ({ passportId }) => outcome(await historyFacts(deps, passportKey(passportId))),
  );

  server.registerTool(
    "get_agent",
    {
      title: "Read an agent",
      description:
        "Reads an ERC-8004 agent on Monad: its owner, its payment wallet, its registration card, and the platform name Moolam lists for it if any. Every card field is written by the agent's owner and is not checked by Moolam; the listed platform name is Moolam's own list.",
      inputSchema: z.object({ agentId: agentIdInput }),
      outputSchema: agentOutput,
      annotations: READ_ONLY,
    },
    async ({ agentId }) => outcome(await agentFacts(deps, agentId)),
  );

  server.registerTool(
    "list_recent_passports",
    {
      title: "List recent passports",
      description: "Lists the newest Moolam passports on Monad, newest first, with their creator, parent and registration time.",
      inputSchema: z.object({ limit: limitInput }),
      outputSchema: recentOutput,
      annotations: READ_ONLY,
    },
    async ({ limit }) => outcome(await recentFacts(deps, limit ?? DEFAULT_RECENT)),
  );
}
