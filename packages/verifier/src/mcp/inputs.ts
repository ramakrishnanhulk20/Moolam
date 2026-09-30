import { z } from "zod";
import { MAX_UPLOAD_BYTES } from "../env.js";
import type { Hex } from "../types.js";

/**
 * The one shape a passport id may have here: 0x and 32 bytes of hex in either case, the same
 * predicate consentRead's isPassportId applies. Every read keys on passportKey's lower-cased form,
 * so two spellings of one id share one cache entry and one chain read.
 */
export const PASSPORT_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export function passportKey(id: string): Hex {
  return id.toLowerCase() as Hex;
}

/** An ERC-8004 agent id is a uint256; a JSON number past this is no longer exact, so it is refused. */
export const MAX_AGENT_ID = Number.MAX_SAFE_INTEGER;

/** How many passports one list may name. The site's Explore page shows the same two dozen. */
export const MAX_RECENT = 24;
export const DEFAULT_RECENT = 10;

/** 1 January 2100 in unix seconds: far past any statement, and small enough to sit in a uint64. */
export const MAX_UNIX_SECONDS = 4_102_444_800;

/**
 * The most text one answer may carry. Claude Code keeps 25,000 tokens of a tool result by default
 * and the hosted apps about 150,000 characters; the answer goes out twice, as structured content
 * and as the same JSON in text, so 24,000 characters each stays far inside both (M4). Every field
 * is capped well below this; the check is the backstop that refuses rather than cuts.
 */
export const MAX_RESULT_CHARS = 24_000;

/** The refusal for an answer that cannot be brought under MAX_RESULT_CHARS. */
export const RESULT_TOO_LARGE = "the answer was larger than this service returns in one result";

/** A browser's own practical limit on an address. Nothing longer is parsed. */
export const MAX_URL_CHARS = 2_048;

/**
 * The longest base64 text whose decoded bytes fit the upload cap. Checking the text's length is
 * checking the decoded size before a byte is decoded: every four characters are at most three bytes.
 */
export const MAX_BASE64_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The address a check_picture caller named, parsed once by the WHATWG parser, or null. Only https
 * is taken, with no user name or password, so the value validated here is the value fetched: the
 * route hands on this URL's own href rather than the caller's text.
 */
export function httpsUrl(value: string): URL | null {
  if (value.length > MAX_URL_CHARS) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return null;
  }
  return url;
}

/** Whether text is strict base64 short enough to decode under the upload cap. Nothing is decoded. */
export function isPictureBase64(text: string): boolean {
  return text.length <= MAX_BASE64_CHARS && text.length % 4 === 0 && BASE64.test(text);
}

/** Decodes a base64 picture. Text that fails isPictureBase64, or decodes to nothing or past the cap, is null. */
export function decodedPicture(text: string): Buffer | null {
  if (!isPictureBase64(text)) {
    return null;
  }
  const bytes = Buffer.from(text, "base64");
  return bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES ? null : bytes;
}

export const passportIdInput = z
  .string()
  .regex(PASSPORT_ID_PATTERN, "passportId must be 0x followed by 64 hex characters")
  .describe("The passport id: 0x and 64 hex characters, the sha256 of the registered file.");

export const agentIdInput = z
  .number()
  .int()
  .min(0)
  .max(MAX_AGENT_ID)
  .describe("The ERC-8004 agent id on Monad mainnet, a whole number.");

export const limitInput = z
  .number()
  .int()
  .min(1)
  .max(MAX_RECENT)
  .optional()
  .describe(`How many passports to list, 1 to ${MAX_RECENT}. ${DEFAULT_RECENT} when left out.`);

export const atInput = z
  .number()
  .int()
  .min(1)
  .max(MAX_UNIX_SECONDS)
  .optional()
  .describe("A moment in unix seconds. Left out, the statement in force now is read.");

export const pictureInput = z
  .object({
    url: z
      .string()
      .max(MAX_URL_CHARS)
      .refine((value) => httpsUrl(value) !== null, "url must be an absolute https address with no user name or password")
      .optional()
      .describe("An https address of a JPEG, PNG or WebP picture, fetched by the service."),
    image: z
      .string()
      .min(4)
      .max(MAX_BASE64_CHARS)
      .refine(isPictureBase64, `image must be plain base64 of at most ${MAX_UPLOAD_BYTES} bytes`)
      .optional()
      .describe(`The picture itself as plain base64 with no data: prefix, at most ${MAX_UPLOAD_BYTES} bytes decoded.`),
  })
  .refine((value) => (value.url === undefined) !== (value.image === undefined), "send exactly one of url or image");
