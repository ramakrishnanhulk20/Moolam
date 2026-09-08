import { z } from "zod";
import { env } from "../env.js";

/**
 * Pinata's current upload endpoint. Their docs mark the v3 files API as the one to use and the
 * older pinFileToIPFS route as legacy, kept only for folder uploads, which we do not do.
 */
const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";

/** The public gateway the Chainlink workflow fetches thumbnails through. */
// The public gateway rate-limits a busy address with 429s; an account's dedicated gateway is
// limited per account instead, so it is preferred whenever the root .env names one.
export const PINATA_GATEWAY = env.PINATA_GATEWAY_URL;

const IPFS_SCHEME = "ipfs://";

const uploadResponseSchema = z.object({
  data: z.object({
    cid: z.string().min(1),
    size: z.number().optional(),
  }),
});

/**
 * Pins bytes to public IPFS and returns the content id.
 *
 * Throws when the buffer is empty, when Pinata refuses the upload, or when the answer is not the
 * shape their API documents. A 5xx is retried once, because a gateway hiccup in the middle of a
 * seed run would otherwise cost a whole set of uploads.
 */
export async function pinFile(
  bytes: Buffer,
  name: string,
  contentType: string,
): Promise<{ cid: string; uri: `ipfs://${string}`; size: number }> {
  if (bytes.length === 0) {
    throw new Error(`Refusing to pin ${name}: there are no bytes to pin.`);
  }
  if (name.length === 0 || contentType.length === 0) {
    throw new Error("pinFile needs a file name and a content type.");
  }

  // A Node Buffer can sit on a shared ArrayBuffer, which File will not accept, so the bytes are
  // copied into a plain view first.
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], name, { type: contentType }));
  form.append("network", "public");
  form.append("name", name);

  const data = await upload(form, name);
  return { cid: data.cid, uri: `${IPFS_SCHEME}${data.cid}`, size: data.size ?? bytes.length };
}

/**
 * Pins a JSON document to public IPFS. The document is written with two space indentation so a
 * judge opening the gateway URL reads something legible.
 *
 * Throws when the value cannot be serialised, which includes a bigint anywhere inside it.
 */
export async function pinJson(value: unknown, name: string): Promise<{ cid: string; uri: `ipfs://${string}` }> {
  let text: string;
  try {
    text = `${JSON.stringify(value, null, 2)}\n`;
  } catch (error) {
    throw new Error(`Cannot turn ${name} into JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const pinned = await pinFile(Buffer.from(text, "utf8"), name, "application/json");
  return { cid: pinned.cid, uri: pinned.uri };
}

/** Turns an ipfs:// reference, or a bare content id, into a URL anything can GET. */
export function gatewayUrl(uri: string): string {
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    return uri;
  }
  const path = uri.startsWith(IPFS_SCHEME) ? uri.slice(IPFS_SCHEME.length) : uri;
  return `${PINATA_GATEWAY}${path}`;
}

async function upload(form: FormData, what: string): Promise<{ cid: string; size?: number }> {
  let lastServerError = "";

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${readToken()}` },
      body: form,
    });

    if (response.status >= 500) {
      lastServerError = `${response.status} ${await response.text()}`;
      continue;
    }
    if (!response.ok) {
      throw new Error(`Pinata refused to pin ${what}: ${response.status} ${await response.text()}`);
    }

    const parsed = uploadResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error(`Pinata pinned ${what} but answered in a shape this client does not know.`);
    }
    return parsed.data.data;
  }

  throw new Error(`Pinata failed twice on ${what}: ${lastServerError}`);
}

/**
 * Reads the Pinata token at the moment it is needed, not at import, so the verify service can
 * boot and answer /verify on a host that was never given a pinning token. The message never
 * repeats the token itself.
 *
 * Throws when PINATA_JWT is missing. Every pin happens before any transaction is sent, so a run
 * that dies here has spent no gas.
 */
function readToken(): string {
  const parsed = z.string().min(20).safeParse(env.PINATA_JWT);
  if (!parsed.success) {
    throw new Error(
      "PINATA_JWT is missing or too short in the root .env. Make an API key at app.pinata.cloud and paste its JWT there.",
    );
  }
  return parsed.data;
}
