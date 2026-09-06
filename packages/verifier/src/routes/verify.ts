import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { readManifest, type ManifestSummary } from "../c2pa.js";
import { matchImage, type MatchResult } from "../match.js";
import { FETCH_TIMEOUT_MS, MAX_UPLOAD_BYTES } from "../env.js";

const urlBodySchema = z.object({
  url: z.string().refine(isHttpUrl, "url must be an absolute http or https URL"),
});

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

class BadRequest extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const MAX_REDIRECTS = 3;

/**
 * A server-side fetch is a request made from inside our network, so a URL that
 * points at loopback, a private range, link-local or the cloud metadata address
 * must never be followed, before or after a redirect.
 */
function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") ||
    v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb");
}

async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new BadRequest(`refusing to fetch ${host}: not a public address`, 403);
  }
  const addresses = isIP(host) !== 0 ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new BadRequest(`refusing to fetch ${host}: not a public address`, 403);
  }
}

/**
 * POST /verify: takes an image, returns the passport it belongs to.
 *
 * Accepts either a multipart upload in a field named "file" or a JSON body of
 * { "url": "..." }. Both are capped at 20 MB, and the URL form is fetched
 * server-side with a 10 second timeout.
 */
export async function verifyRoutes(app: FastifyInstance): Promise<void> {
  app.post("/verify", async (request: FastifyRequest, reply: FastifyReply) => {
    let bytes: Buffer;
    try {
      bytes = request.isMultipart() ? await readUpload(request) : await readFromUrl(request);
    } catch (error) {
      return rejected(request, reply, error);
    }

    let result: MatchResult;
    let manifest: ManifestSummary;
    try {
      [result, manifest] = await Promise.all([
        matchImage(bytes, app.verifier.index, app.verifier.lookupExact),
        readManifest(bytes),
      ]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return rejected(request, reply, new BadRequest(`the upload is not an image we can read: ${detail}`));
    }

    return reply.send({ result: renderResult(result), manifest: renderManifest(manifest) });
  });
}

async function readUpload(request: FastifyRequest): Promise<Buffer> {
  const part = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
  if (part === undefined) {
    throw new BadRequest('send the image in a multipart field named "file"');
  }
  if (part.fieldname !== "file") {
    throw new BadRequest(`expected a multipart field named "file", got "${part.fieldname}"`);
  }

  let bytes: Buffer;
  try {
    bytes = await part.toBuffer();
  } catch (error) {
    if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
      throw new BadRequest(`the image is larger than the ${MAX_UPLOAD_BYTES} byte limit`, 413);
    }
    throw error;
  }

  if (bytes.length === 0) {
    throw new BadRequest("the uploaded file is empty");
  }
  return bytes;
}

/**
 * Fetches a remote image within the timeout and the size cap.
 *
 * The body is read chunk by chunk and abandoned the moment it crosses the cap,
 * because a Content-Length header is a claim by the remote server, not a fact.
 */
async function readFromUrl(request: FastifyRequest): Promise<Buffer> {
  const parsed = urlBodySchema.safeParse(request.body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new BadRequest(`send a multipart "file" field or a JSON body of { "url": "..." }: ${detail}`);
  }

  // Redirects are followed by hand so every hop is checked against the private ranges;
  // a public URL that bounces to an internal address is the classic way in.
  let target = new URL(parsed.data.url);
  let response: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(target);
    try {
      response = await fetch(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "manual" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new BadRequest(`could not fetch ${target}: ${detail}`, 502);
    }
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) break;
    target = new URL(location, target);
    response = undefined;
  }

  if (response === undefined) {
    throw new BadRequest(`fetching ${parsed.data.url} redirected more than ${MAX_REDIRECTS} times`, 502);
  }
  if (!response.ok || response.body === null) {
    throw new BadRequest(`fetching ${parsed.data.url} returned ${response.status}`, 502);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > MAX_UPLOAD_BYTES) {
      throw new BadRequest(`the image at ${parsed.data.url} is larger than the ${MAX_UPLOAD_BYTES} byte limit`, 413);
    }
    chunks.push(Buffer.from(chunk));
  }

  if (total === 0) {
    throw new BadRequest(`the image at ${parsed.data.url} is empty`);
  }
  return Buffer.concat(chunks);
}

function rejected(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  const status = error instanceof BadRequest ? error.statusCode : 400;
  const reason = error instanceof Error ? error.message : String(error);
  request.log.warn({ ip: request.ip, url: request.url, status, reason }, "rejected: /verify");
  return reply.code(status).send({ error: reason });
}

/** Renders the match for JSON: the 64-bit pHash goes out as a decimal string, never a double. */
function renderResult(result: MatchResult): unknown {
  return {
    exact: result.exact,
    best: result.best,
    matches: result.matches,
    confidence: result.confidence,
    queried: { ...result.queried, phash: result.queried.phash.toString() },
  };
}

function renderManifest(manifest: ManifestSummary): unknown {
  if (manifest.softBinding === undefined) {
    return manifest;
  }
  return {
    ...manifest,
    softBinding: { ...manifest.softBinding, phash: manifest.softBinding.phash.toString() },
  };
}
