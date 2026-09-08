import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import OpenAI from "openai";
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { z } from "zod";
import type { ToolDefinition } from "./tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");

// One .env at the repo root serves every package, and it has to be read before the schema below
// runs, because that check is what decides which provider this process can reach.
loadEnv({ path: join(REPO_ROOT, ".env"), quiet: true });

/**
 * The cheapest current text model with tool calling on the account's models endpoint, checked on
 * 2026-09-08: 0.20 dollars per million input tokens and 1.25 per million output tokens.
 */
export const DEFAULT_TEXT_MODEL = "gpt-5.4-nano";

/** OpenRouter names the same model with its vendor in front. */
export const DEFAULT_OPENROUTER_TEXT_MODEL = "openai/gpt-5.4-nano";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const environment = z.object({
  OPENAI_API_KEY: z.string().min(20).optional(),
  OPENROUTER_API_KEY: z.string().min(20).optional(),
  AGENT_PROVIDER: z.enum(["openai", "openrouter"]).optional(),
  AGENT_TEXT_MODEL: z.string().min(1).optional(),
  AGENT_LLM_BASE_URL: z.string().url().optional(),
});

export type ChatMessage = ChatCompletionMessageParam;

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface ChatReply {
  message: ChatCompletionMessage;
  model: string;
  usage: TokenUsage;
}

export interface LlmConfig {
  provider: "openai" | "openrouter";
  baseURL: string;
  model: string;
  apiKey: string;
}

/**
 * Which brain is answering and where it lives.
 *
 * OpenAI is the default because the image model only exists there. OpenRouter is the fallback and
 * speaks the same API, so pointing at it is a change of two environment variables and nothing
 * else in this package moves.
 *
 * Throws when neither key is in the root .env, and when the provider named in AGENT_PROVIDER has
 * no key.
 */
export function llmConfig(): LlmConfig {
  const parsed = environment.safeParse(process.env);
  if (!parsed.success) {
    const bad = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`The root .env is malformed for: ${bad}.`);
  }
  const env = parsed.data;

  const provider = env.AGENT_PROVIDER ?? (env.OPENAI_API_KEY ? "openai" : "openrouter");
  const apiKey = provider === "openai" ? env.OPENAI_API_KEY : env.OPENROUTER_API_KEY;
  if (apiKey === undefined) {
    throw new Error(
      `The agent is set to use ${provider}, but the root .env has no ${provider === "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY"}.`,
    );
  }

  const defaultModel = provider === "openai" ? DEFAULT_TEXT_MODEL : DEFAULT_OPENROUTER_TEXT_MODEL;
  const defaultBase = provider === "openai" ? OPENAI_BASE_URL : OPENROUTER_BASE_URL;

  return {
    provider,
    baseURL: env.AGENT_LLM_BASE_URL ?? defaultBase,
    model: env.AGENT_TEXT_MODEL ?? defaultModel,
    apiKey,
  };
}

/**
 * One turn of the conversation, with the tools the model may call.
 *
 * Throws when the provider returns no choice, which is the only answer this loop cannot use.
 */
export async function chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatReply> {
  if (messages.length === 0) throw new Error("The model needs at least one message.");

  const config = llmConfig();
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });

  const completion = await client.chat.completions.create({
    model: config.model,
    messages,
    tools,
    tool_choice: "auto",
  });

  const choice = completion.choices[0];
  if (choice === undefined) {
    throw new Error(`${config.model} answered with no choices.`);
  }

  return {
    message: choice.message,
    model: completion.model,
    usage: {
      prompt: completion.usage?.prompt_tokens ?? 0,
      completion: completion.usage?.completion_tokens ?? 0,
      total: completion.usage?.total_tokens ?? 0,
    },
  };
}
