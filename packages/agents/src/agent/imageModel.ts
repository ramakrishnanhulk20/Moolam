import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import OpenAI from "openai";
import sharp from "sharp";
import { z } from "zod";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");

// One .env at the repo root serves every package, and it has to be read before the schema below
// runs, because that check is what decides whether this process can draw anything at all.
loadEnv({ path: join(REPO_ROOT, ".env"), quiet: true });

/**
 * The cheapest image model on the account's models endpoint, checked on 2026-09-08. Its image
 * output tokens bill at 8 dollars per million, against 40 for the full size model, and one
 * medium 1024 by 1024 picture is about a thousand of those tokens.
 */
export const DEFAULT_IMAGE_MODEL = "gpt-image-1-mini";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** Square, because the passport thumbnail and the app grid are both square. */
const IMAGE_SIZE = "1024x1024";

/** Medium is the middle of the model's three quality steps: a poster a judge would look at, for about a cent. */
const IMAGE_QUALITY = "medium";

/** What the C2PA signed file is encoded at. High enough that signing does not move the perceptual hash. */
const JPEG_QUALITY = 92;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8]);

const environment = z.object({
  OPENAI_API_KEY: z.string().min(20),
  AGENT_IMAGE_MODEL: z.string().min(1).optional(),
  AGENT_IMAGE_BASE_URL: z.string().url().optional(),
});

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

/**
 * Draws one picture and hands back JPEG bytes ready for the C2PA signer.
 *
 * The images endpoint answers with base64 in whatever format it chose, so anything that is not
 * already a JPEG is re-encoded at quality 92 here: prepareImage signs JPEG containers, and the
 * fingerprint on chain is taken from the signed file, not from this one.
 *
 * Throws when the prompt is empty, when OPENAI_API_KEY is missing, when the API returns no image,
 * and when the bytes it returns are not a picture sharp can read.
 */
export async function createImage(prompt: string): Promise<GeneratedImage> {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    throw new Error("The image model needs a prompt with something in it.");
  }

  const env = imageConfig();
  const client = new OpenAI({
    apiKey: env.apiKey,
    baseURL: env.baseURL,
  });

  const response = await client.images.generate({
    model: env.model,
    prompt: trimmed,
    size: IMAGE_SIZE,
    quality: IMAGE_QUALITY,
    n: 1,
  });

  const first = response.data?.[0];
  const encoded = first?.b64_json;
  if (encoded === undefined) {
    throw new Error(`${env.model} answered without image bytes, so there is nothing to register.`);
  }

  const raw = Buffer.from(encoded, "base64");
  return {
    bytes: await asJpeg(raw),
    model: env.model,
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

/** Which model is drawing, where, and with which key. Read once per call so a test can swap it. */
export function imageConfig(): { model: string; baseURL: string; apiKey: string } {
  const parsed = environment.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(
      `The root .env is missing or malformed for: ${missing}. The image model needs OPENAI_API_KEY from platform.openai.com.`,
    );
  }
  return {
    model: parsed.data.AGENT_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL,
    baseURL: parsed.data.AGENT_IMAGE_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: parsed.data.OPENAI_API_KEY,
  };
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
