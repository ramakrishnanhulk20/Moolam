import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { Passport } from "@/lib/chain/registry";

/**
 * The download link and the download itself agree (WO-195).
 *
 * F4: a passport page may draw a picture the download route refuses, such as
 * one named as ipfs://cid/path. The poster offers the download only when the
 * route's own rule would serve it, so the link never leads to a 404.
 *
 * F5: a gateway that compresses its answer declares the compressed length,
 * while fetch hands over the bytes unpacked. Passing that length on would cut
 * the saved file short, so it is dropped.
 *
 * Every fetch lands on a stub standing in for the gateway, so nothing here
 * leaves the machine.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: en, namespace }),
  getFormatter: async () => ({
    dateTime: (date: Date) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(date),
  }),
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) => createElement("a", { href: props.href }, props.children as never),
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": "true" }),
}));

const reads = vi.hoisted(() => ({ getPassport: vi.fn(), heldUnseal: vi.fn() }));
vi.mock("@/lib/chain/registry", () => ({ getPassport: reads.getPassport }));
vi.mock("@/lib/data/unseal", () => ({ heldUnseal: reads.heldUnseal }));

const { readArt } = await import("@/components/passport/art");
const { Poster } = await import("@/components/passport/Poster");
const { GET } = await import("@/app/api/passports/[id]/picture/route");
const { forgetCallers } = await import("@/lib/api/limit");

const ID = `0x${"ab".repeat(32)}` as Hex;
const DOCUMENT_CID = "bafkreidocument";
const PICTURE_CID = "bafkreipicture";

/** A small JPEG-shaped file: the three bytes every JPEG opens with, then noise. */
const PICTURE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 4_000 }, (_, at) => (at * 31) % 251)]);

/** What the gateway holds, by the path after /ipfs/, and the headers it answers with. */
let pinned: Record<string, { body: Uint8Array | string; headers?: Record<string, string> }> = {};

const passport: Passport = {
  id: ID,
  exactHash: ID,
  parentId: `0x${"00".repeat(32)}` as Hex,
  creator: "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a",
  generatorAgentId: 0n,
  phash: 0x6ccf137087789a25n,
  blockhash256: `0x${"11".repeat(32)}` as Hex,
  manifestHash: `0x${"22".repeat(32)}` as Hex,
  kind: 1,
  fingerprintVersion: 1,
  registeredAt: 1_788_876_082n,
  disputed: false,
  metadataURI: `ipfs://${DOCUMENT_CID}`,
};

beforeEach(() => {
  forgetCallers();
  pinned = {};
  reads.getPassport.mockReset().mockResolvedValue({ id: ID, metadataURI: `ipfs://${DOCUMENT_CID}`, registeredAt: 1_788_876_082n });
  reads.heldUnseal.mockReset().mockResolvedValue({ state: "sealed" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const address = new URL(input instanceof Request ? input.url : String(input));
      const at = address.pathname.indexOf("/ipfs/");
      const file = at < 0 ? undefined : pinned[address.pathname.slice(at + "/ipfs/".length)];
      if (file === undefined) {
        return new Response("not pinned", { status: 404 });
      }
      const body = typeof file.body === "string" ? new TextEncoder().encode(file.body) : file.body;
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(body.byteLength), ...file.headers },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

async function posterFor(document: Record<string, unknown>, metadataURI = `ipfs://${DOCUMENT_CID}`): Promise<string> {
  pinned[metadataURI.slice("ipfs://".length)] = { body: JSON.stringify(document) };
  const art = await readArt(metadataURI);
  expect(art.imageUrl, "the page still draws the picture").toBeDefined();
  return render(await Poster({ passport: { ...passport, metadataURI }, art, locale: "en" }));
}

function downloads(markup: string): number {
  return markup.split("data-download-original").length - 1;
}

describe("the download link on the poster (F4)", () => {
  it("shows for a picture named as a bare content id", async () => {
    const markup = await posterFor({ name: "Harbour", image: `ipfs://${PICTURE_CID}` });
    expect(downloads(markup)).toBe(1);
    expect(markup).toContain(`/api/passports/${ID}/picture`);
  });

  it("does not show for an ipfs://cid/path picture, which the route refuses", async () => {
    const markup = await posterFor({ name: "Harbour", image: `ipfs://${PICTURE_CID}/picture.jpg` });
    expect(downloads(markup)).toBe(0);
  });

  it("does not show for a picture named on the app's own gateway over https, which the route refuses too", async () => {
    const gateway = new URL(`https://${(await import("@/lib/images")).PICTURE_HOSTS[0]}/ipfs/${PICTURE_CID}`);
    const markup = await posterFor({ name: "Harbour", image: gateway.href });
    expect(downloads(markup)).toBe(0);
  });

  it("does not show when the document itself sits under a path, which the route will not read", async () => {
    const markup = await posterFor({ name: "Harbour", image: `ipfs://${PICTURE_CID}` }, `ipfs://${DOCUMENT_CID}/metadata.json`);
    expect(downloads(markup)).toBe(0);
  });
});

describe("the length the route passes on (F5)", () => {
  async function download(): Promise<Response> {
    pinned[DOCUMENT_CID] = { body: JSON.stringify({ name: "Harbour", image: `ipfs://${PICTURE_CID}` }) };
    return await GET(new Request(`http://localhost/api/passports/${ID}/picture`), { params: Promise.resolve({ id: ID }) });
  }

  it("sends no content-length for a gzip-encoded gateway answer, and the whole file still arrives", async () => {
    pinned[PICTURE_CID] = { body: PICTURE, headers: { "content-encoding": "gzip", "content-length": "1200" } };

    const response = await download();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PICTURE);
  });

  it("still sends the gateway's length for a plain answer", async () => {
    pinned[PICTURE_CID] = { body: PICTURE };

    const response = await download();
    expect(response.headers.get("content-length")).toBe(String(PICTURE.byteLength));
    await response.arrayBuffer();
  });
});
