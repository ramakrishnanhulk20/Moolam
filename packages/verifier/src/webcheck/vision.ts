import { z } from "zod";
import { safeReason } from "../net/errorText.js";

/** Google Cloud Vision's annotate endpoint. The key never goes into it: it rides in a header. */
export const VISION_URL = "https://vision.googleapis.com/v1/images:annotate";

/**
 * How many results Vision is asked for per list. The price is per picture whatever this says, so it
 * is set high enough that the count a person sees is the pages Google found, not a page size.
 */
export const VISION_MAX_RESULTS = 50;

/**
 * The most of Vision's answer this service reads, counted as it arrives. Fifty pages with their
 * image lists come to tens of kilobytes; anything past this is not an answer to this question.
 */
export const VISION_ANSWER_MAX_BYTES = 512 * 1024;

/** The most page addresses a document or an answer carries (L23). */
export const MAX_PAGES = 10;

/** The longest page address kept, in characters. A longer one is dropped whole, never cut. */
export const MAX_PAGE_CHARS = 256;

/** The longest address even looked at, so a hostile entry costs no URL parse. */
const MAX_RAW_ADDRESS_CHARS = 4_096;

/** The most entries any one list in the answer may hold before the whole answer is refused. */
const MAX_LIST_ENTRIES = 1_000;

/** What one web check found: every distinct page Google named, and the first MAX_PAGES of them. */
export interface WebPages {
  count: number;
  pages: string[];
}

/**
 * Sends one picture to Vision and answers what it found. Throws for anything but an answer that
 * passed the schema; the caller reads every throw as "found nothing it can say".
 */
export type WebDetector = (picture: Buffer, signal: AbortSignal) => Promise<WebPages>;

/** Vision answered something other than a 200, or an answer this service will not read. */
export class VisionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionRefused";
  }
}

/**
 * A page address made safe to store, return and draw (L23): the URL parser, then an http or https
 * scheme and a host it parsed, then only the scheme, host and path, so the query and the fragment,
 * where tracking ids and tokens live, never travel on, and neither does a user name or password.
 * A result over MAX_PAGE_CHARS is dropped rather than cut, since a cut address names another page.
 *
 * Covers the scheme, the host and the length. It does not judge what the page shows or whether the
 * host is a real site: the address is drawn as text and never followed.
 */
export function pageAddress(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RAW_ADDRESS_CHARS) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hostname.length === 0) {
    return undefined;
  }
  const kept = `${url.protocol}//${url.host}${url.pathname}`;
  return kept.length <= MAX_PAGE_CHARS ? kept : undefined;
}

const pageSchema = z.object({ url: z.string() });

const answerSchema = z.object({
  responses: z
    .array(
      z.object({
        webDetection: z
          .object({ pagesWithMatchingImages: z.array(pageSchema).max(MAX_LIST_ENTRIES).optional() })
          .optional(),
        error: z.object({ code: z.number().optional() }).optional(),
      }),
    )
    .length(1),
});

/**
 * Vision's answer, already parsed as JSON, read like an input (L23). The pages are the ones Google
 * lists as showing a full or partial match of the picture; each goes through pageAddress, and two
 * entries that come out the same are one page. `count` is every distinct page that survived, and
 * `pages` the first MAX_PAGES of them in Google's order, so the count a screen shows is the count a
 * document stores.
 *
 * Throws VisionRefused for an answer that does not have the documented shape, or that carries
 * Vision's own per-picture error.
 */
export function pagesFromAnswer(body: unknown): WebPages {
  const parsed = answerSchema.safeParse(body);
  if (!parsed.success) {
    throw new VisionRefused("Vision's answer is not the shape this service reads");
  }
  const only = parsed.data.responses[0];
  if (only === undefined || only.error !== undefined) {
    throw new VisionRefused(`Vision could not check this picture (code ${String(only?.error?.code ?? "none")})`);
  }
  const seen = new Set<string>();
  for (const page of only.webDetection?.pagesWithMatchingImages ?? []) {
    const address = pageAddress(page.url);
    if (address !== undefined) seen.add(address);
  }
  const pages = [...seen];
  return { count: pages.length, pages: pages.slice(0, MAX_PAGES) };
}

/** The body as text, refused once it passes `cap` bytes, whatever the length header claimed. */
async function cappedBody(response: Response, cap: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel().catch(() => undefined);
    throw new VisionRefused(`Vision's answer is over the ${cap} byte cap`);
  }
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > cap) {
      await reader.cancel().catch(() => undefined);
      throw new VisionRefused(`Vision's answer is over the ${cap} byte cap`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The live detector: one WEB_DETECTION request to Vision with the picture's bytes, base64, and the
 * key in the x-goog-api-key header. The key is never put in the address, so no proxy, access log or
 * error text that carries an address can carry the key. Redirects are refused, because a redirect
 * would carry that header to wherever it pointed.
 *
 * Every error it throws is built here from a status or safeReason, with the key cut out of the text
 * as a last guard, so whatever a caller logs cannot hold it (L24).
 */
export function visionDetector(key: string, fetcher: typeof fetch = fetch): WebDetector {
  const hidden = (text: string): string => text.split(key).join("[key]");
  return async (picture, signal) => {
    let response: Response;
    try {
      response = await fetcher(VISION_URL, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", "x-goog-api-key": key },
        body: JSON.stringify({
          requests: [
            {
              image: { content: picture.toString("base64") },
              features: [{ type: "WEB_DETECTION", maxResults: VISION_MAX_RESULTS }],
            },
          ],
        }),
        redirect: "error",
        signal,
      });
    } catch (error) {
      throw new VisionRefused(hidden(`the call to Vision did not complete: ${safeReason(error)}`));
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new VisionRefused(`Vision answered ${response.status}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(await cappedBody(response, VISION_ANSWER_MAX_BYTES));
    } catch (error) {
      if (error instanceof VisionRefused) throw error;
      throw new VisionRefused(hidden(`Vision's answer could not be read: ${safeReason(error)}`));
    }
    return pagesFromAnswer(body);
  };
}
