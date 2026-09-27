import { reason } from "@/lib/chain/client";
import { callerAddress, tooManyPage, withinLimit } from "@/lib/api/limit";
import {
  MAX_PICTURE_BYTES,
  SNIFF_BYTES,
  downloadName,
  findOriginal,
  passportIdFrom,
  pictureType,
  pinnedAddress,
  type Original,
} from "@/lib/passport/original";

export const dynamic = "force-dynamic";

/** Long enough for the largest picture on a slow gateway, short enough that a stalled one lets go. */
const PICTURE_TIMEOUT_MS = 60_000;

/** A year: the file lives under its own content id and can never change. */
const KEPT_SECONDS = 31_536_000;

/**
 * The registered picture of one passport, as the exact file that was signed,
 * saved rather than shown.
 *
 * The bytes come straight from the IPFS gateway and are passed through as they
 * arrive. Next's image optimizer is never in this path: it re-encodes what it
 * serves, and a re-encoded copy has a different hash from the passport id and
 * loses the Content Credentials the creator is downloading it for.
 *
 * Only a public picture, or one its holder has unsealed, is served. A sealed
 * passport, an unknown id and a document with no pinned picture answer 404 in
 * one plain sentence, because this address is opened by a person pressing a
 * link and a JSON body would itself be downloaded.
 *
 * One caller gets 60 downloads a minute. Each one is a read of the chain and up
 * to 20 MB from a gateway with a monthly allowance, so an open loop here is
 * spend rather than load.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const limit = withinLimit("picture", callerAddress(request));
  if (!limit.ok) {
    return tooManyPage(limit.retryAfter);
  }

  const id = passportIdFrom((await params).id);
  if (id === null) {
    return plain(404, "That is not a passport id. A passport id is 0x and 64 hex characters.");
  }

  let original: Original;
  try {
    original = await findOriginal(id);
  } catch (error) {
    return plain(503, `Monad did not answer: ${reason(error)}. Try again in a moment.`);
  }
  if (original.state === "refused") {
    return plain(original.status, original.message);
  }

  let response: Response;
  try {
    response = await fetch(pinnedAddress(original.cid), {
      signal: AbortSignal.timeout(PICTURE_TIMEOUT_MS),
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    return plain(502, "The IPFS gateway did not answer for this picture. Try again in a moment.");
  }
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    return plain(502, `The IPFS gateway answered ${response.status} for this picture. Try again in a moment.`);
  }

  const declared = Number(response.headers.get("content-length") ?? "");
  const sized = Number.isFinite(declared) && declared > 0;
  if (sized && declared > MAX_PICTURE_BYTES) {
    await response.body.cancel().catch(() => undefined);
    return plain(502, "This picture is larger than any Moolam registers, so it is not served.");
  }

  // The kind of file is read off its own first bytes, not the gateway's word
  // for it, so the name it is saved under always matches what is inside.
  const reader = response.body.getReader();
  let head: Uint8Array;
  try {
    head = await firstBytes(reader);
  } catch {
    return plain(502, "The IPFS gateway stopped partway through this picture. Try again in a moment.");
  }
  const kind = pictureType(head);
  if (kind === null) {
    await reader.cancel().catch(() => undefined);
    return plain(502, "The file pinned for this passport is not a JPEG, PNG or WebP picture, so it is not served.");
  }

  const headers = new Headers({
    "content-type": kind.type,
    "content-disposition": `attachment; filename="${downloadName(original.title, id, kind.extension)}"`,
    "cache-control": `public, max-age=${KEPT_SECONDS}, immutable`,
  });
  if (sized) {
    headers.set("content-length", String(declared));
  }
  return new Response(capped(head, reader, MAX_PICTURE_BYTES), { status: 200, headers });
}

/** At least the bytes a picture's kind is read from, or the whole file when it is shorter. */
async function firstBytes(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < SNIFF_BYTES) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    length += value.byteLength;
  }
  return chunks.length === 1 ? chunks[0] : new Uint8Array(Buffer.concat(chunks));
}

/**
 * The file as it arrives, starting with the bytes already read. A gateway that
 * sends more than the cap, whatever length it declared, has the download
 * broken off rather than finished, so a browser never saves a file this route
 * would have refused.
 */
function capped(
  head: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cap: number,
): ReadableStream<Uint8Array> {
  let sent = 0;
  let started = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = started ? await reader.read() : { done: false as const, value: head };
      started = true;
      if (next.done) {
        controller.close();
        return;
      }
      sent += next.value.byteLength;
      if (sent > cap) {
        await reader.cancel().catch(() => undefined);
        controller.error(new Error("the picture ran past the download cap"));
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
    },
  });
}

function plain(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
