import OpenAI, { APIError } from "openai";
import { env } from "./env";
import { imageType, type ImageType } from "./store";

/**
 * The cheapest image model on OpenAI's list, the one Moolam's own studio draws with: a medium
 * 1024 by 1024 picture is about a thousand output tokens at 8 dollars per million, about a cent.
 */
export const IMAGE_MODEL = "gpt-image-1-mini";
const IMAGE_SIZE = "1024x1024";
const IMAGE_QUALITY = "medium";

/**
 * A slow draw is abandoned rather than left holding a request open. With a timeout set the SDK's
 * own retries are switched off too, because a retry after a timeout can bill a second picture.
 */
const DRAW_TIMEOUT_MS = 120_000;

/**
 * What the provider says when its safety system will not draw a prompt. It only picks the wording
 * of the refusal; whether a failed call cost money is decided by the status, in billedOrUnknown.
 */
const REFUSAL = /safety system|moderation|content policy|not allowed|violat/i;

/** The model's safety system refused the prompt: nothing was drawn and nothing was billed. */
export class PromptRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PromptRefused";
  }
}

export interface DrawnPicture {
  bytes: Buffer;
  contentType: ImageType;
}

/**
 * Draws one picture from the prompt exactly as the visitor typed it.
 *
 * Unlike Moolam's studio this keeps the model's own format (PNG, JPEG or WebP): the verify service
 * re-encodes on prepare, so Dreamloom has no reason to carry an image library.
 *
 * Throws PromptRefused when the provider's safety system turns the prompt down, and a plain Error
 * when no key is set, the answer has no image, or the bytes are not a picture a browser shows.
 */
export async function drawPicture(prompt: string): Promise<DrawnPicture> {
  const apiKey = env().OPENAI_API_KEY;
  if (apiKey === undefined) {
    throw new Error("OPENAI_API_KEY is not set, so nothing can be drawn");
  }
  const client = new OpenAI({ apiKey });

  let response;
  try {
    response = await client.images.generate(
      { model: IMAGE_MODEL, prompt, size: IMAGE_SIZE, quality: IMAGE_QUALITY, n: 1 },
      { timeout: DRAW_TIMEOUT_MS, maxRetries: 0 },
    );
  } catch (error) {
    const refused = refusalReason(error);
    if (refused !== undefined) throw new PromptRefused(refused);
    throw error;
  }

  const encoded = response.data?.[0]?.b64_json;
  if (encoded === undefined) {
    throw new Error("the image model answered without image bytes");
  }
  const bytes = Buffer.from(encoded, "base64");
  const contentType = imageType(bytes);
  if (contentType === null) {
    throw new Error("the image model answered with bytes that are not a PNG, JPEG or WebP");
  }
  return { bytes, contentType };
}

/**
 * Whether the provider may have drawn and billed for the picture before this error.
 *
 * A status under 500 is a request the provider turned down before it drew anything, so the caller
 * can hand the count back. No status at all is a timeout or a dead connection, where a picture may
 * well have been drawn on the other side, and a 5xx can be a failure after the work; both of those
 * keep the count. Anything that is not the provider's own error is treated the same cautious way,
 * which includes an answer whose bytes were billed but could not be used.
 */
export function billedOrUnknown(error: unknown): boolean {
  if (!(error instanceof APIError)) return true;
  return typeof error.status !== "number" || error.status >= 500;
}

/**
 * The provider's own words when it refused the prompt, or undefined for any other failure.
 *
 * Only a 400 can be a refusal: a 401 is our key, a 429 is our quota and a 5xx is theirs. The text
 * is matched as well, so a malformed request is reported as a failure rather than blamed on the
 * person who typed the prompt. Control characters are dropped and the length capped, because the
 * words go back to the browser.
 */
function refusalReason(error: unknown): string | undefined {
  if (!(error instanceof APIError) || error.status !== 400) return undefined;
  const body = error.error as { message?: unknown } | undefined;
  const message = typeof body?.message === "string" ? body.message : error.message;
  const code = error.code ?? "";
  if (!REFUSAL.test(message) && !REFUSAL.test(code)) return undefined;
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
}
