import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { chat, llmConfig, type ChatMessage, type TokenUsage } from "./llm.js";
import {
  generateImage,
  lookupAgent,
  registerPassport,
  tools,
  verifyImage,
  type GeneratedImageResult,
} from "./tools.js";

/**
 * How many tools the model may call in one run. Four is the whole job, so eight leaves room for
 * one retry per step and still ends rather than spinning on a provider that keeps calling tools.
 */
const MAX_TOOL_CALLS = 8;

const SYSTEM_PROMPT = [
  "You are the Moolam generator agent. You make images and you give each one a passport on Monad mainnet.",
  "You own an ERC-8004 identity, and your signing key lives in a Privy enclave under a policy that lets you register passports and nothing else.",
  "When the user asks for a picture: call generate_image once with a full visual prompt, then call register_passport once with a short title and that same prompt. Do not call either tool twice.",
  "When the user hands you a file to check: call verify_image once, then call lookup_agent once for the generatorAgentId it returns. Your answer must name the creator wallet, the generator agent id and the wallet that owns it, the registration time, and how sure the match was.",
  "Then stop calling tools and answer in plain English, three or four sentences. Always quote the passport id and, when there is one, the transaction hash. Never invent an id, a hash or a wallet address: use only what a tool returned.",
  "Write the answer as plain prose on one line per sentence. No markdown, no bold, no bullet points, no headings, and never a long dash: use a full stop or a comma instead.",
].join("\n");

export interface RunInput {
  prompt?: string;
  verifyFile?: string;
}

export interface RunResult {
  transcript: string[];
  answer: string;
}

/**
 * Runs the agent once: a prompt to make and register a picture, or a file to trace back to its
 * creator.
 *
 * Every tool call and every tool result is written to the transcript as it happens, so the run can
 * be read afterwards without the model's own summary in the way.
 *
 * Throws when neither a prompt nor a file is given, when the file cannot be read, and when the
 * model uses its whole tool budget without answering.
 */
export async function runAgent(input: RunInput): Promise<RunResult> {
  const prompt = input.prompt?.trim();
  const hasPrompt = prompt !== undefined && prompt.length > 0;
  if (!hasPrompt && input.verifyFile === undefined) {
    throw new Error("runAgent needs either a prompt to draw or a file to verify.");
  }
  if (hasPrompt && input.verifyFile !== undefined) {
    throw new Error("runAgent takes a prompt or a file to verify, not both.");
  }

  const transcript: string[] = [];
  const say = (line: string) => {
    console.log(line);
    transcript.push(line);
  };

  const config = llmConfig();
  const queryBytes = input.verifyFile === undefined ? undefined : await readFile(input.verifyFile);
  let generated: GeneratedImageResult | undefined;
  const usage: TokenUsage = { prompt: 0, completion: 0, total: 0 };

  say(`Moolam generator agent. Brain: ${config.model} on ${config.provider}.`);
  say(
    hasPrompt
      ? `Task: make a picture and register its passport. Prompt: ${prompt}`
      : `Task: work out who made ${basename(input.verifyFile ?? "")} (${queryBytes?.length ?? 0} bytes).`,
  );
  say("");

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: hasPrompt
        ? (prompt as string)
        : `Here is an image file called ${basename(input.verifyFile ?? "")}. Who made it, and is it registered?`,
    },
  ];

  let calls = 0;
  let answer = "";

  while (calls <= MAX_TOOL_CALLS) {
    const reply = await chat(messages, tools);
    usage.prompt += reply.usage.prompt;
    usage.completion += reply.usage.completion;
    usage.total += reply.usage.total;

    const plan = reply.message.content?.trim();
    if (plan && plan.length > 0 && reply.message.tool_calls?.length) {
      say(`plan: ${plan}`);
    }

    const toolCalls = reply.message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      answer = plan ?? "";
      break;
    }

    messages.push(reply.message);

    for (const call of toolCalls) {
      if (call.type !== "function") continue;
      calls += 1;
      if (calls > MAX_TOOL_CALLS) {
        throw new Error(`The model asked for more than ${MAX_TOOL_CALLS} tool calls, so the run was stopped.`);
      }

      const args = call.function.arguments;
      say(`tool call ${calls}: ${call.function.name} ${args}`);

      let result: string;
      try {
        const outcome = await callTool(call.function.name, args, {
          queryBytes,
          generated,
          remember: (image) => {
            generated = image;
          },
        });
        result = JSON.stringify(outcome);
        say(`tool result: ${result}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        result = JSON.stringify({ error: detail });
        say(`tool failed: ${detail}`);
      }

      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  if (answer.trim().length === 0) {
    throw new Error("The model stopped without an answer.");
  }

  say("");
  say(`answer: ${answer.trim()}`);
  say(
    `tokens: ${usage.prompt} in, ${usage.completion} out, ${usage.total} total on ${config.model}` +
      (generated ? `; image drawn by ${generated.model}` : ""),
  );

  return { transcript, answer: answer.trim() };
}

interface ToolState {
  queryBytes?: Buffer;
  generated?: GeneratedImageResult;
  remember: (image: GeneratedImageResult) => void;
}

/**
 * Runs one tool the model asked for.
 *
 * Image bytes never travel through the model: generate_image keeps them here and register_passport
 * picks them up, which is also what stops a second registration of a picture the model imagined.
 *
 * Throws when the arguments do not parse, when a tool is named that does not exist, and whatever
 * the tool itself throws.
 */
async function callTool(name: string, rawArgs: string, state: ToolState): Promise<unknown> {
  const args = parseArgs(name, rawArgs);

  if (name === "generate_image") {
    const prompt = requireString(args, "prompt", name);
    const image = await generateImage(prompt);
    state.remember(image);
    return {
      bytes: image.bytes.length,
      model: image.model,
      imageTokens: image.usage?.totalTokens,
      note: "The picture is held by the agent. Call register_passport next.",
    };
  }

  if (name === "register_passport") {
    if (state.generated === undefined) {
      throw new Error("There is no picture to register yet. Call generate_image first.");
    }
    const title = requireString(args, "title", name);
    const prompt = requireString(args, "prompt", name);
    const written = await registerPassport(state.generated.bytes, title, prompt);
    return {
      passportId: written.passportId,
      txHash: written.txHash,
      explorerUrl: written.explorerUrl,
      metadataUri: written.metadataUri,
      imageFile: written.imageFile,
      gasLimit: written.gasLimit.toString(),
    };
  }

  if (name === "verify_image") {
    if (state.queryBytes === undefined) {
      throw new Error("No file was handed to this run, so there is nothing to verify.");
    }
    return verifyImage(state.queryBytes);
  }

  if (name === "lookup_agent") {
    const agentId = requireString(args, "agentId", name);
    if (!/^[0-9]+$/.test(agentId.trim())) {
      throw new Error(`lookup_agent needs a decimal agent id, and got "${agentId}".`);
    }
    return lookupAgent(BigInt(agentId.trim()));
  }

  throw new Error(`The model asked for a tool called ${name}, which this agent does not have.`);
}

function parseArgs(name: string, rawArgs: string): Record<string, unknown> {
  if (rawArgs.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(rawArgs) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error(`The arguments for ${name} were not valid JSON: ${rawArgs}`);
  }
}

function requireString(args: Record<string, unknown>, field: string, name: string): string {
  const value = args[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} needs a non-empty "${field}".`);
  }
  return value;
}
