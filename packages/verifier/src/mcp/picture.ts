import type { FastifyRequest } from "fastify";
import { withPassportFacts } from "../disputeRead.js";
import { MAX_UPLOAD_BYTES } from "../env.js";
import { Busy } from "../generate/gate.js";
import {
  CallerGone,
  SERVICE_FAULT_REASON,
  ServiceFault,
  URL_UNFETCHABLE,
  readFromUrl,
  statusOf,
  underUploadCeiling,
  verifyBytes,
} from "../routes/shared.js";
import type { Hex, IndexState } from "../types.js";
import { INDEX_BEHIND, type McpDeps, type Outcome } from "./facts.js";
import { decodedPicture, httpsUrl } from "./inputs.js";

const TOO_LARGE = `the picture is larger than the ${MAX_UPLOAD_BYTES} byte limit, or has more pixels than this service decodes`;
const NOT_A_PICTURE = "the picture could not be read: it is not a JPEG, PNG or WebP this service can decode";
const BUSY = "busy: every matching slot is taken, try again in a moment";
const CALLER_LEFT = "the request ended before the picture was checked";
const UNREADABLE = "the picture could not be read";

/** Which fixed sentence a failure to get or match the picture becomes. The error's own words stay in the log. */
function reasonFor(error: unknown): string {
  if (error instanceof ServiceFault) return SERVICE_FAULT_REASON;
  if (error instanceof Busy) return BUSY;
  if (error instanceof CallerGone) return CALLER_LEFT;
  const status = statusOf(error);
  if (status === 502) return URL_UNFETCHABLE;
  if (status === 413) return TOO_LARGE;
  if (status === 503) return BUSY;
  if (status === 400) return NOT_A_PICTURE;
  return UNREADABLE;
}

/**
 * The request as readFromUrl reads it, with the URL in the body where that function looks. The
 * MCP body is a JSON-RPC envelope, so the URL would never be found there; every other property is
 * the real request's, which is what keeps the fetch on the one guarded path /verify uses (M1):
 * safeFetch's address guard, no hop to a private address, the byte cap, the one deadline, and the
 * same upload ceilings and hang-up handling, counted to this caller's address (M5).
 */
function withUrlBody(request: FastifyRequest, url: URL): FastifyRequest {
  return Object.create(request, { body: { value: { url: url.href }, enumerable: true } }) as FastifyRequest;
}

async function pictureBytes(request: FastifyRequest, input: { url?: string; image?: string }): Promise<Buffer> {
  if (input.url !== undefined) {
    const url = httpsUrl(input.url);
    if (url === null) {
      throw new Error("the url was refused after the schema accepted it");
    }
    return await readFromUrl(withUrlBody(request, url));
  }
  const bytes = decodedPicture(input.image ?? "");
  if (bytes === null) {
    throw Object.assign(new Error("the image did not decode"), { statusCode: 400 });
  }
  // Ties the decoded bytes to this request's upload account, which the envelope was already
  // counted in, so the match gate queues them under this caller's address like an upload.
  return (await underUploadCeiling(request, async () => ({ bytes }))).bytes;
}

export interface PictureCheck {
  verdict: "exact" | "match" | "no-match";
  passportId: Hex | null;
  confidence: number;
  distances: { phash: number; blockhash: number; variant: string } | null;
  contentCredentials: { present: boolean; validation: string | null; credential: string | null };
  facts: Record<string, unknown> | null;
  index: IndexState & { chainHeadAt: number | null; lagSeconds: number | null };
  verifyAnswer: { result: unknown; manifest: unknown };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

const FACT_KEYS = ["consent", "dispute", "inheritedDispute", "recheck", "picture"] as const;

/**
 * check_picture: the same reading, matching and facts as POST /verify, against one copy of the
 * index. The whole verify answer rides along unchanged in `verifyAnswer`, so no sealed, unsealed,
 * disputed or distance fact is dropped (M6); the headline fields are read out of it. Index
 * freshness is the index's own block time against the chain head read now, never a constant. A
 * picture that matches nothing on an index that is behind is "unavailable", never "no match" (M3).
 */
export async function checkPicture(
  deps: McpDeps,
  request: FastifyRequest,
  input: { url?: string; image?: string },
): Promise<Outcome<PictureCheck>> {
  let answer: { result: unknown; manifest: unknown; index: IndexState };
  try {
    const bytes = await pictureBytes(request, input);
    const copy = deps.app.verifier.snapshot(bytes);
    const verified = { ...(await verifyBytes(deps.app, bytes)), index: copy.state() };
    const verifier = deps.app.verifier;
    answer = await withPassportFacts(verified, verifier.consent, verifier.dispute, copy.lookupExact, verifier.picture);
  } catch (error) {
    return { ok: false, reason: reasonFor(error) };
  }

  const result = record(answer.result) ?? {};
  const best = record(result.best);
  const exact = typeof result.exact === "string" ? (result.exact as Hex) : null;
  const passportId = exact ?? (typeof best?.id === "string" ? (best.id as Hex) : null);
  if (passportId === null && answer.index.stale) {
    return { ok: false, reason: INDEX_BEHIND };
  }

  let chainHeadAt: number | null = null;
  try {
    chainHeadAt = await deps.chain.headTime();
  } catch {
    chainHeadAt = null;
  }
  const indexedAt = answer.index.indexedAt ?? null;
  const manifest = record(answer.manifest) ?? {};
  const facts: Record<string, unknown> = {};
  for (const key of FACT_KEYS) {
    if (best !== undefined && key in best) {
      facts[key] = best[key];
    }
  }
  const phash = best?.phashDistance;
  const blockhash = best?.blockhashDistance;
  return {
    ok: true,
    value: {
      verdict: exact !== null ? "exact" : passportId !== null ? "match" : "no-match",
      passportId,
      confidence: typeof result.confidence === "number" ? result.confidence : 0,
      distances:
        typeof phash === "number" && typeof blockhash === "number"
          ? { phash, blockhash, variant: String(best?.variant ?? "identity") }
          : null,
      contentCredentials: {
        present: manifest.present === true,
        validation: typeof manifest.validation === "string" ? manifest.validation : null,
        credential: typeof manifest.credential === "string" ? manifest.credential : null,
      },
      facts: best === undefined ? null : facts,
      index: {
        ...answer.index,
        chainHeadAt,
        lagSeconds: chainHeadAt === null || indexedAt === null ? null : Math.max(0, chainHeadAt - indexedAt),
      },
      verifyAnswer: { result: answer.result, manifest: answer.manifest },
    },
  };
}
