import { createHash } from "node:crypto";
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

/**
 * How long one upload gets before it is abandoned. Six times the JSON fetch timeout because this
 * request carries the whole picture, up to the 20 MB upload limit, over a home connection.
 */
const PIN_TIMEOUT_MS = 60_000;

export interface PinOptions {
  /** How long one upload gets. Tests pass a short one; nothing in the service overrides it. */
  timeoutMs?: number;
}

const uploadResponseSchema = z.object({
  data: z.object({
    cid: z.string().min(1),
    size: z.number().optional(),
    network: z.string().nullish(),
  }),
});

/**
 * Pins bytes to public IPFS and returns the content id.
 *
 * Pinata de-duplicates by content, across networks too, so an answer is believed only when it is
 * on the public network and names the content id computed here for the bytes sent. Anything else
 * would let a caller publish, record or delete on the strength of a file that is not this one.
 *
 * Throws when the buffer is empty, when Pinata refuses the upload, when an upload stalls past the
 * timeout, or when the answer is not the shape their API documents. Throws PinNotConfirmed when
 * the answer names another content id or another network. A 5xx is retried once, because a
 * gateway hiccup in the middle of a seed run would otherwise cost a whole set of uploads.
 */
export async function pinFile(
  bytes: Buffer,
  name: string,
  contentType: string,
  options: PinOptions = {},
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

  const expected = contentIdOf(bytes);
  const data = await upload(form, name, options.timeoutMs ?? PIN_TIMEOUT_MS);
  if (data.network !== "public" || data.cid !== expected) {
    throw new PinNotConfirmed(
      `Pinata answered the public pin of ${name} with content id ${data.cid} on network ${String(data.network)}, and these bytes are ${expected} on public`,
    );
  }
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

/**
 * Pinata answered a public pin with a file that is not the bytes sent, or not on the public
 * network. The pin is not believed: nothing downstream may name it or delete anything because of it.
 */
export class PinNotConfirmed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinNotConfirmed";
  }
}

/**
 * How Pinata cuts a file into blocks: 256 KiB leaves, raw, under one balanced root. A file of one
 * leaf is its own block. Checked against a real pin: the 368,362 byte hero picture Pinata answered
 * with bafybeidig23..., in test/pinata.test.ts.
 */
const CHUNK_BYTES = 262_144;

/**
 * The most leaves one root may link. The upload cap is 20 MB, which is 77 leaves, so a file that
 * would need a second layer is refused rather than guessed at.
 */
const MAX_LINKS = 174;

const RAW_CODEC = 0x55;
const DAG_PB_CODEC = 0x70;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * The content id Pinata gives these bytes: CIDv1, sha2-256, in lower case base32.
 *
 * Covers a file of one leaf (a raw block, bafkrei...) and a file of up to 174 leaves (one UnixFS
 * file node linking raw leaves, bafybei...). It does not cover a different chunker, CIDv0, or a
 * folder: a pin Pinata made any of those ways fails the comparison, which is the safe way to be
 * wrong. Throws for an empty buffer and for a file past 174 leaves.
 */
export function contentIdOf(bytes: Buffer): string {
  if (bytes.length === 0) {
    throw new Error("an empty file has no content id this service computes");
  }
  if (bytes.length <= CHUNK_BYTES) {
    return base32(cidBytes(RAW_CODEC, bytes));
  }
  const leaves = Math.ceil(bytes.length / CHUNK_BYTES);
  if (leaves > MAX_LINKS) {
    throw new Error(`a file of ${leaves} blocks is past the ${MAX_LINKS} one root can link`);
  }

  // dag-pb writes the links before the data, and each link carries an empty name and the leaf's size.
  const links: Buffer[] = [];
  const sizes: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
    const leaf = bytes.subarray(at, at + CHUNK_BYTES);
    const link = Buffer.concat([field(1, cidBytes(RAW_CODEC, leaf)), Buffer.from([0x12, 0x00, 0x18]), varint(leaf.length)]);
    links.push(field(2, link));
    sizes.push(Buffer.concat([Buffer.from([0x20]), varint(leaf.length)]));
  }
  // UnixFS: type File (2), the whole size, then each leaf's size.
  const unixfs = Buffer.concat([Buffer.from([0x08, 0x02, 0x18]), varint(bytes.length), ...sizes]);
  return base32(cidBytes(DAG_PB_CODEC, Buffer.concat([...links, field(1, unixfs)])));
}

function cidBytes(codec: number, block: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x01, codec, 0x12, 0x20]), createHash("sha256").update(block).digest()]);
}

function varint(value: number): Buffer {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return Buffer.from(out);
}

/** A protobuf length-delimited field. */
function field(number: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(number << 3) | 2]), varint(payload.length), payload]);
}

function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "b";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32[(value << (5 - bits)) & 31];
  }
  return out;
}

/** Turns an ipfs:// reference, or a bare content id, into a URL anything can GET. */
export function gatewayUrl(uri: string): string {
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    return uri;
  }
  const path = uri.startsWith(IPFS_SCHEME) ? uri.slice(IPFS_SCHEME.length) : uri;
  return `${PINATA_GATEWAY}${path}`;
}

async function upload(
  form: FormData,
  what: string,
  timeoutMs: number,
): Promise<{ cid: string; size?: number; network?: string | null }> {
  let lastServerError = "";

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // A fresh signal per attempt: a retry after a stall needs its own clock, not the remains of
    // the first one's.
    const response = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${readToken()}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
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
 * Where Pinata keeps files on its private network: listed and deleted under this path, and a
 * timed read link minted under its download_link child. The guides print the link path without
 * `/private` and that path answers 404; the API reference and the live account agree on this one.
 */
const PRIVATE_FILES_URL = "https://api.pinata.cloud/v3/files/private";
const PRIVATE_LINK_URL = `${PRIVATE_FILES_URL}/download_link`;

/** Every private call is a small request or a thumbnail under 60 KB, so ten seconds is generous. */
export const PRIVATE_CALL_TIMEOUT_MS = 10_000;

/**
 * How far a name lookup pages before it gives up and says it cannot tell. One passport has one
 * name, so a real answer is one row on the first page; five pages of 100 is far past anything a
 * correct account holds under one name.
 */
export const PRIVATE_LIST_MAX_PAGES = 5;
const PRIVATE_LIST_PAGE_SIZE = 100;

/**
 * The longest read link this client will ask for. The caller fixes the expiry in code, and this
 * cap stops a later caller from minting a link that outlives the run it was made for.
 */
export const PRIVATE_LINK_MAX_SECONDS = 300;

/** The only kind of file this service keeps privately is a baseline JPEG thumbnail. */
const PRIVATE_FILE_TYPE = "image/jpeg";

/** Pinata file ids are UUIDs; anything else is refused before it is put in a path. */
const FILE_ID = /^[0-9A-Za-z-]{1,64}$/;

/** A content id is base32 or base58 letters and digits. "pending" is Pinata's word for none yet. */
const CONTENT_ID = /^[0-9A-Za-z]{20,100}$/;

/** A file Pinata says it holds on the private network under the name this service chose. */
export interface PrivateFile {
  id: string;
  name: string;
  cid: string;
  network: "private";
}

/** One row of a private listing whose name is exactly the one asked for. */
export interface PrivateListing {
  id: string;
  name: string;
  cid: string;
  createdAt?: string;
}

/**
 * Pinata answered a private upload with something other than a private file under the name sent.
 *
 * The case met in the spike: bytes whose content id the account already holds publicly came back
 * as that public file, with `is_duplicate` true and `network` public. Nothing is deleted on this
 * answer, because the id may belong to someone's public pin; the id is carried so the log can name
 * it for an operator to look at.
 */
export class PrivateCopyNotPrivate extends Error {
  readonly fileId: string | undefined;
  constructor(message: string, fileId: string | undefined) {
    super(message);
    this.name = "PrivateCopyNotPrivate";
    this.fileId = fileId;
  }
}

const privateUploadSchema = z.object({
  data: z.object({
    id: z.string().regex(FILE_ID),
    name: z.string().nullish(),
    cid: z.string().min(1),
    network: z.string().nullish(),
  }),
});

const privateListingSchema = z.object({
  data: z.object({
    files: z
      .array(
        z.object({
          id: z.string().min(1),
          name: z.string().nullable(),
          cid: z.string().min(1),
          created_at: z.string().optional(),
        }),
      )
      .nullable(),
    next_page_token: z.string().nullish(),
  }),
});

const downloadLinkSchema = z.object({ data: z.string().min(1) });

/**
 * Uploads bytes to Pinata's private network under an exact name, with key-values beside it, and
 * hands back the file only when Pinata says it is private and named as asked.
 *
 * There is one attempt and no retry: a retry after a stalled upload could leave a second file under
 * the same name, and the caller would rather refuse than guess.
 *
 * Throws PrivateCopyNotPrivate when the answer's network is not `private` (a missing field
 * included) or its name is not the one sent. Throws a plain Error when the bytes or name are empty,
 * when Pinata refuses (the message names the status only), after PRIVATE_CALL_TIMEOUT_MS, or when
 * the answer has no file id.
 */
export async function pinPrivateFile(
  bytes: Buffer,
  name: string,
  keyvalues: Record<string, string>,
): Promise<PrivateFile> {
  if (bytes.length === 0) {
    throw new Error(`Refusing to keep ${name} privately: there are no bytes.`);
  }
  if (name.length === 0) {
    throw new Error("pinPrivateFile needs a file name.");
  }

  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], name, { type: PRIVATE_FILE_TYPE }));
  form.append("network", "private");
  form.append("name", name);
  form.append("keyvalues", JSON.stringify(keyvalues));

  const response = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${readToken()}` },
    body: form,
    signal: AbortSignal.timeout(PRIVATE_CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Pinata refused the private upload of ${name}: ${response.status}`);
  }

  const parsed = privateUploadSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(`Pinata took the private upload of ${name} but answered with no file id this client can read.`);
  }
  const file = parsed.data.data;
  if (file.network !== "private" || file.name !== name) {
    throw new PrivateCopyNotPrivate(
      `Pinata answered the private upload of ${name} with network ${String(file.network)} and name ${String(file.name)}`,
      file.id,
    );
  }
  return { id: file.id, name: file.name, cid: file.cid, network: "private" };
}

/**
 * Every private file whose name is exactly `name`, oldest first as Pinata lists them.
 *
 * Pinata's name filter does not say how it matches, so it is used only to shorten the list; the
 * whole-name equality below is the check. It pages through at most PRIVATE_LIST_MAX_PAGES pages.
 *
 * Throws, and never answers an empty list, when a page cannot be read, when Pinata answers with an
 * error status or a shape this client does not know, or when the pages run out before the listing
 * does: each of those is "cannot tell", and an empty answer would read as "no such file".
 */
export async function findPrivateByName(name: string): Promise<PrivateListing[]> {
  if (name.length === 0) {
    throw new Error("findPrivateByName needs a file name.");
  }

  const found: PrivateListing[] = [];
  let pageToken: string | undefined;
  for (let page = 1; page <= PRIVATE_LIST_MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ name, limit: String(PRIVATE_LIST_PAGE_SIZE) });
    if (pageToken !== undefined) {
      query.set("pageToken", pageToken);
    }
    const response = await fetch(`${PRIVATE_FILES_URL}?${query.toString()}`, {
      headers: { Authorization: `Bearer ${readToken()}` },
      signal: AbortSignal.timeout(PRIVATE_CALL_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Pinata answered ${response.status} to the private listing, so it cannot tell what is kept`);
    }

    const parsed = privateListingSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error("Pinata listed private files in a shape this client does not know, so it cannot tell what is kept");
    }
    const files = parsed.data.data.files ?? [];
    for (const file of files) {
      if (file.name === name) {
        found.push({ id: file.id, name: file.name, cid: file.cid, createdAt: file.created_at });
      }
    }

    const next = parsed.data.data.next_page_token ?? "";
    if (files.length === 0 || next.length === 0) {
      return found;
    }
    pageToken = next;
  }

  throw new Error(
    `The private listing for ${name} ran past ${PRIVATE_LIST_MAX_PAGES} pages, so it cannot tell what is kept`,
  );
}

/**
 * How many pages of 100 one sweep run reads. Two pages bound a run to 200 rows, 200 chain reads and
 * 200 deletes, and the next run goes on from where this one stopped.
 */
export const PRIVATE_SWEEP_PAGES = 2;

/**
 * Up to `maxPages` pages of the account's private files, starting at `from` (Pinata's page token)
 * or at the first page, and the token to go on from, undefined once the listing has ended.
 *
 * No name filter is sent (V8): Pinata does not document how it matches one, and the sweep's own
 * whole-name check is the only one that decides anything. A row with no name is left out, since
 * this service never uploads one. Every row handed back is one Pinata listed.
 *
 * Throws, and never answers a short list, when a page cannot be read, when Pinata answers with an
 * error status or a shape this client does not know: a listing it could not finish is "cannot
 * tell", and the sweep must not act on part of one.
 */
export async function listPrivatePage(
  from: string | undefined,
  maxPages: number = PRIVATE_SWEEP_PAGES,
): Promise<{ files: PrivateListing[]; next: string | undefined }> {
  const found: PrivateListing[] = [];
  let pageToken = from;
  for (let page = 1; page <= maxPages; page += 1) {
    const query = new URLSearchParams({ limit: String(PRIVATE_LIST_PAGE_SIZE) });
    if (pageToken !== undefined) {
      query.set("pageToken", pageToken);
    }
    const response = await fetch(`${PRIVATE_FILES_URL}?${query.toString()}`, {
      headers: { Authorization: `Bearer ${readToken()}` },
      signal: AbortSignal.timeout(PRIVATE_CALL_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Pinata answered ${response.status} to the private listing, so the sweep cannot tell what is kept`);
    }

    const parsed = privateListingSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error("Pinata listed private files in a shape this client does not know, so the sweep cannot tell what is kept");
    }
    const files = parsed.data.data.files ?? [];
    for (const file of files) {
      if (file.name !== null) {
        found.push({ id: file.id, name: file.name, cid: file.cid, createdAt: file.created_at });
      }
    }

    const next = parsed.data.data.next_page_token ?? "";
    if (files.length === 0 || next.length === 0) {
      return { files: found, next: undefined };
    }
    pageToken = next;
  }
  return { files: found, next: pageToken };
}

/**
 * Deletes one private file by its Pinata id.
 *
 * Throws on an id that is not the shape Pinata issues, on any status but 2xx (Pinata documents no
 * answer for an unknown id, so none is read as "already gone"), and after PRIVATE_CALL_TIMEOUT_MS.
 */
export async function deletePrivateFile(id: string): Promise<void> {
  if (!FILE_ID.test(id)) {
    throw new Error("deletePrivateFile was given something that is not a Pinata file id.");
  }
  const response = await fetch(`${PRIVATE_FILES_URL}/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${readToken()}` },
    signal: AbortSignal.timeout(PRIVATE_CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Pinata answered ${response.status} to deleting private file ${id}`);
  }
}

/**
 * Mints a read link to one private file on the account's dedicated gateway, valid for
 * `expiresSeconds` from now.
 *
 * The link is a bearer secret until it expires, so no message this function throws carries it,
 * and the answer is checked before it is returned: https, the configured gateway's host, the
 * `/files/<cid>` path asked for, and a signature parameter. The expiry is the caller's constant;
 * nothing here reads it from a request.
 *
 * Throws on a content id that is not one, an expiry outside 1 to PRIVATE_LINK_MAX_SECONDS, a
 * gateway that is not an account's own `*.mypinata.cloud` host (Pinata signs links for those
 * only), any status but 2xx, a timeout, or an answer that fails the check above.
 */
export async function privateDownloadLink(cid: string, expiresSeconds: number): Promise<string> {
  if (!CONTENT_ID.test(cid)) {
    throw new Error("privateDownloadLink was given something that is not a content id.");
  }
  if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > PRIVATE_LINK_MAX_SECONDS) {
    throw new Error(`A private link lives between 1 and ${PRIVATE_LINK_MAX_SECONDS} seconds.`);
  }
  const gateway = dedicatedGateway();
  const target = `${gateway.origin}/files/${cid}`;

  const response = await fetch(PRIVATE_LINK_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${readToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      url: target,
      date: Math.floor(Date.now() / 1000),
      expires: expiresSeconds,
      method: "GET",
    }),
    signal: AbortSignal.timeout(PRIVATE_CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Pinata answered ${response.status} to the private link request`);
  }

  const parsed = downloadLinkSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Pinata answered the private link request in a shape this client does not know");
  }
  let link: URL;
  try {
    link = new URL(parsed.data.data);
  } catch {
    throw new Error("Pinata answered the private link request with something that is not a URL");
  }
  if (
    link.protocol !== "https:" ||
    link.host !== gateway.host ||
    link.pathname !== `/files/${cid}` ||
    !link.searchParams.has("X-Signature")
  ) {
    throw new Error("Pinata answered the private link request with a link for another host, file or form");
  }
  return link.toString();
}

/**
 * The account's own gateway, taken from PINATA_GATEWAY_URL. Pinata signs private links only for a
 * dedicated `*.mypinata.cloud` host, so the shared public gateway is refused here by name rather
 * than sent off to fail.
 */
function dedicatedGateway(): URL {
  const gateway = new URL(PINATA_GATEWAY);
  if (gateway.protocol !== "https:" || !gateway.hostname.endsWith(".mypinata.cloud")) {
    throw new Error("PINATA_GATEWAY_URL must be the account's own https://<name>.mypinata.cloud gateway to mint a private link.");
  }
  return gateway;
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
