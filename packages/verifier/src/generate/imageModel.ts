import OpenAI, { APIError } from "openai";
import sharp from "sharp";
import { env } from "../env.js";

/**
 * The cheapest image model on the account's models endpoint, checked on 2026-09-08. Its image
 * output tokens bill at 8 dollars per million, against 40 for the full size model, and one
 * medium 1024 by 1024 picture is about a thousand of those tokens.
 */
export const DEFAULT_IMAGE_MODEL = "gpt-image-1-mini";

/** OpenRouter names the same model with its vendor in front. */
export const DEFAULT_OPENROUTER_IMAGE_MODEL = "openai/gpt-image-1-mini";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Square, because the passport thumbnail and the app grid are both square. */
const IMAGE_SIZE = "1024x1024";

/** Medium is the middle of the model's three quality steps: a poster a judge would look at, for about a cent. */
const IMAGE_QUALITY = "medium";

/** What the C2PA signed file is encoded at. High enough that signing does not move the perceptual hash. */
const JPEG_QUALITY = 92;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8]);

/** What the provider says when its safety system will not draw a prompt. */
const REFUSAL = /safety system|moderation|content policy|not allowed|violat/i;

/**
 * The model's safety system refused the prompt.
 *
 * Nothing was drawn and nothing was billed, so a caller can hand the reason back to the person who
 * typed the prompt and let them try again.
 */
export class PromptRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PromptRefused";
  }
}

export interface ImageUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface GeneratedImage {
  bytes: Buffer;
  model: string;
  /** The prompt the model actually drew from, which is the one sent unless the API rewrote it. */
  promptUsed: string;
  usage?: ImageUsage;
}

export interface CreateImageOptions {
  /**
   * How long the provider gets before the call is abandoned. When it is set the SDK's own retries
   * are switched off as well, because a retry after a timeout can bill a second picture.
   */
  timeoutMs?: number;
}

/**
 * Draws one picture and hands back JPEG bytes ready for the C2PA signer.
 *
 * The images endpoint answers with base64 in whatever format it chose, so anything that is not
 * already a JPEG is re-encoded at quality 92 here: prepareImage signs JPEG containers, and the
 * fingerprint on chain is taken from the signed file, not from this one.
 *
 * Throws PromptRefused when the provider's safety system turns the prompt down, and a plain Error
 * when the prompt is empty, when no API key is configured, when the API returns no image, and when
 * the bytes it returns are not a picture sharp can read.
 */
export async function createImage(
  prompt: string,
  options: CreateImageOptions = {},
): Promise<GeneratedImage> {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    throw new Error("The image model needs a prompt with something in it.");
  }

  const config = imageConfig();
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });

  let response;
  try {
    response = await client.images.generate(
      {
        model: config.model,
        prompt: trimmed,
        size: IMAGE_SIZE,
        quality: IMAGE_QUALITY,
        n: 1,
      },
      options.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs, maxRetries: 0 },
    );
  } catch (error) {
    const refused = refusalReason(error);
    if (refused !== undefined) throw new PromptRefused(refused);
    throw error;
  }

  const first = response.data?.[0];
  const encoded = first?.b64_json;
  if (encoded === undefined) {
    throw new Error(`${config.model} answered without image bytes, so there is nothing to register.`);
  }

  const raw = Buffer.from(encoded, "base64");
  return {
    bytes: await asJpeg(raw),
    model: config.model,
    promptUsed: first?.revised_prompt ?? trimmed,
    usage: response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          totalTokens: response.usage.total_tokens,
        }
      : undefined,
  };
}

/**
 * Which model is drawing, where, and with which key.
 *
 * OpenAI is the default because the image model started there. OpenRouter speaks the same API and
 * takes over when only its key is set, so moving provider is a change of one variable.
 *
 * Throws when neither key is in the environment.
 */
export function imageConfig(): { model: string; baseURL: string; apiKey: string } {
  const openAiKey = env.OPENAI_API_KEY;
  const apiKey = openAiKey ?? env.OPENROUTER_API_KEY;
  if (apiKey === undefined) {
    throw new Error(
      "The root .env has neither OPENAI_API_KEY nor OPENROUTER_API_KEY, so nothing can draw a picture.",
    );
  }
  const openai = openAiKey !== undefined;
  return {
    model: env.AGENT_IMAGE_MODEL ?? (openai ? DEFAULT_IMAGE_MODEL : DEFAULT_OPENROUTER_IMAGE_MODEL),
    baseURL: env.AGENT_IMAGE_BASE_URL ?? (openai ? OPENAI_BASE_URL : OPENROUTER_BASE_URL),
    apiKey,
  };
}

/**
 * The provider's own words when it refused the prompt, or undefined for any other failure.
 *
 * Only a 400 can be a refusal: a 401 is our key, a 429 is our quota and a 5xx is theirs. The text
 * is matched as well, so a malformed request is reported as a failure rather than blamed on the
 * person who typed the prompt.
 */
function refusalReason(error: unknown): string | undefined {
  if (!(error instanceof APIError) || error.status !== 400) return undefined;
  const body = error.error as { message?: unknown } | undefined;
  const message = typeof body?.message === "string" ? body.message : error.message;
  const code = error.code ?? "";
  if (!REFUSAL.test(message) && !REFUSAL.test(code)) return undefined;
  return message.slice(0, 300);
}

async function asJpeg(bytes: Buffer): Promise<Buffer> {
  if (bytes.length === 0) {
    throw new Error("The image model returned an empty file.");
  }
  if (bytes.subarray(0, 2).equals(JPEG_MAGIC)) {
    return bytes;
  }

  const what = bytes.subarray(0, 4).equals(PNG_MAGIC) ? "PNG" : "an unlabelled format";
  try {
    return await sharp(bytes).jpeg({ quality: JPEG_QUALITY, progressive: false }).toBuffer();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`The image model returned ${what} that could not be re-encoded as JPEG: ${detail}`);
  }
}
