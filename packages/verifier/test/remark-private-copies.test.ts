// Covers scripts/remark-private-copies.ts (review pass 6, sealed #3, V52): it finds every private
// sealed-thumb-<id>.jpg still in the unmarked form kept before V12, and only with --live uploads
// the marked form keepPrivateCopy writes today and then deletes the unmarked file. A dry run prints
// the count and the passport ids and changes nothing. Pinata is a stub at the fetch layer, so the
// real listing, link, upload and delete clients run and nothing leaves the process.
// Does NOT cover a real Pinata account: running the script against one is Ram's call. It does not
// cover what Pinata does with a second file under one name for the moment between the upload and
// the delete, which /sealed/status reads as unknown.

import sharp from "sharp";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
});

const { remarkPrivateCopies } = await import("../scripts/remark-private-copies.js");
const { markedPrivateCopy } = await import("../src/sealed.js");

const PRIVATE_FILES_URL = "https://api.pinata.cloud/v3/files/private";
const LINK_URL = `${PRIVATE_FILES_URL}/download_link`;
const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const GATEWAY = "https://moolam-test.mypinata.cloud";

interface Stored {
  id: string;
  name: string;
  cid: string;
  bytes: Buffer;
}

const account: Stored[] = [];
const uploads: { name: string; bytes: Buffer; network: string }[] = [];
const deletes: string[] = [];
const calls: string[] = [];
let counter = 0;

function idOf(byte: number): Hex {
  return `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as Hex;
}

function store(name: string, bytes: Buffer): Stored {
  counter += 1;
  const file = {
    id: `0199a3c2-5d7e-7f10-9a1b-${counter.toString(16).padStart(12, "0")}`,
    name,
    cid: `bafkreiprivate${counter.toString().padStart(30, "0")}`,
    bytes,
  };
  account.push(file);
  return file;
}

async function thumbnail(seed: number): Promise<Buffer> {
  return await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: seed, g: 80, b: 120 } } })
    .jpeg({ quality: 80 })
    .toBuffer();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  account.length = 0;
  uploads.length = 0;
  deletes.length = 0;
  calls.length = 0;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.split("?")[0]}`);
    if (url.startsWith(`${PRIVATE_FILES_URL}?`) && method === "GET") {
      const files = account.map((file) => ({ id: file.id, name: file.name, cid: file.cid, created_at: "2026-09-20T08:00:00Z" }));
      return json({ data: { files, next_page_token: "" } });
    }
    if (url === LINK_URL && method === "POST") {
      const target = String((JSON.parse(String(init?.body)) as { url: string }).url);
      return json({ data: `${target}?X-Algorithm=PINATA1&X-Expires=60&X-Signature=c2lnbmF0dXJl` });
    }
    if (url.startsWith(`${GATEWAY}/files/`) && method === "GET") {
      const cid = new URL(url).pathname.replace("/files/", "");
      const file = account.find((one) => one.cid === cid);
      return file === undefined ? new Response("gone", { status: 404 }) : new Response(new Uint8Array(file.bytes), { status: 200 });
    }
    if (url === UPLOAD_URL && method === "POST") {
      const form = init?.body as FormData;
      const name = String(form.get("name"));
      const bytes = Buffer.from(await (form.get("file") as File).arrayBuffer());
      uploads.push({ name, bytes, network: String(form.get("network")) });
      const kept = store(name, bytes);
      return json({ data: { id: kept.id, name, cid: kept.cid, network: "private" } });
    }
    if (url.startsWith(`${PRIVATE_FILES_URL}/`) && method === "DELETE") {
      const id = url.slice(PRIVATE_FILES_URL.length + 1);
      deletes.push(id);
      const at = account.findIndex((file) => file.id === id);
      if (at !== -1) account.splice(at, 1);
      return json({ data: null });
    }
    throw new Error(`this test makes no live call: ${method} ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("re-marking private copies kept before V12", () => {
  it("dry by default: prints the count and the passport ids of the unmarked copies and changes nothing", async () => {
    const old = idOf(0x71);
    const current = idOf(0x72);
    store(`sealed-thumb-${old}.jpg`, await thumbnail(10));
    store(`sealed-thumb-${current}.jpg`, markedPrivateCopy(await thumbnail(20), current));
    store("sealed-thumb-0xabc.jpg.exe", await thumbnail(30));
    const printed: string[] = [];

    const summary = await remarkPrivateCopies({ live: false, say: (line) => printed.push(line) });

    expect(summary.unmarked).toEqual([old]);
    expect(summary.remarked).toEqual([]);
    expect(uploads).toEqual([]);
    expect(deletes).toEqual([]);
    const text = printed.join("\n");
    expect(text).toMatch(/\b1\b.*unmarked/);
    expect(text).toContain(old);
    expect(text).not.toContain(current);
    expect(text).not.toContain("X-Signature");
    expect(text).not.toContain("test-token-not-a-real-pinata-jwt");
  });

  it("with --live uploads the marked form under the same name first, then deletes the unmarked file", async () => {
    const old = idOf(0x73);
    const bytes = await thumbnail(40);
    const unmarked = store(`sealed-thumb-${old}.jpg`, bytes);

    const summary = await remarkPrivateCopies({ live: true, say: () => undefined });

    expect(summary.remarked).toEqual([old]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.name).toBe(`sealed-thumb-${old}.jpg`);
    expect(uploads[0]?.network).toBe("private");
    expect(uploads[0]?.bytes.equals(markedPrivateCopy(bytes, old))).toBe(true);
    expect(deletes).toEqual([unmarked.id]);
    expect(calls.indexOf(`POST ${UPLOAD_URL}`)).toBeLessThan(calls.indexOf(`DELETE ${PRIVATE_FILES_URL}/${unmarked.id}`));
    expect(account.map((file) => file.name)).toEqual([`sealed-thumb-${old}.jpg`]);
  });

  it("leaves the unmarked file in place when the marked upload is refused", async () => {
    const old = idOf(0x74);
    const unmarked = store(`sealed-thumb-${old}.jpg`, await thumbnail(50));
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === UPLOAD_URL) return new Response("no", { status: 403 });
      return await real(input, init);
    });

    const summary = await remarkPrivateCopies({ live: true, say: () => undefined });

    expect(summary.remarked).toEqual([]);
    expect(summary.failed.map((one) => one.passportId)).toEqual([old]);
    expect(deletes).toEqual([]);
    expect(account).toEqual([unmarked]);
  });
});

describe("the delete guard", () => {
  it("never deletes the file Pinata answered with as the marked copy", async () => {
    const passportId = idOf(0x5a);
    const unmarked = { id: "0199a3c2-5d7e-7f10-9a1b-00000000aaaa", name: `sealed-thumb-${passportId}.jpg`, cid: "bafkreiunmarked", network: "private" as const };
    const removed: string[] = [];
    const lines: string[] = [];
    const summary = await remarkPrivateCopies({
      live: true,
      say: (line) => lines.push(line),
      deps: {
        list: async () => ({ files: [unmarked], next: undefined }),
        download: async () => await thumbnail(90),
        keep: async () => ({ kept: { ...unmarked, heldBefore: true } }),
        remove: async (fileId) => {
          removed.push(fileId);
        },
      },
    });
    expect(removed).toEqual([]);
    expect(summary.remarked).toEqual([]);
    expect(summary.failed).toEqual([{ passportId, reason: "Pinata answered with the unmarked file itself, so it is left in place" }]);
  });
});
