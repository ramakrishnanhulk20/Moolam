// Holds the CRE workflow's picture choice, packages/workflow/moolam-verifier/picture.ts, to the
// unseal record's real shape, and both workflows' fetch rule, pinned.ts, to R7. Holds the runner's
// copies of the picture rule, the record's thumbnail rule, the byte caps and phash.ts's size rule
// to the originals, and its JPEG size reader to the workflow's decoder. Does NOT cover the
// HTTP capability refusing a redirect by itself (Chainlink's documented behaviour, not ours), the
// HTTP call that fetches the record, the sandbox's
// own limits, or the fingerprint of the picture fetched: those run only inside the simulator, and
// the Old but strong run against the live passport in proofs/rechecks.txt is their proof.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

type PictureChoice =
  | { kind: "fetch"; url: string; reference: string; source: "document" | "unseal record" }
  | { kind: "ask-record" }
  | { kind: "refused"; reason: string };

interface PictureModule {
  choosePicture: (
    document: Record<string, unknown>,
    passportId: string,
    gateway: string,
    record?: { status: number; body: string },
  ) => PictureChoice;
}

// Loaded by path rather than by a static import: the workflow package is its own CommonJS-typed
// project outside this one's rootDir, so this project's compiler must not follow it, while vitest
// runs the file as it is.
const PICTURE_FILE = path.resolve(import.meta.dirname, "../../workflow/moolam-verifier/picture.ts");
const PINNED_FILE = path.resolve(import.meta.dirname, "../../workflow/moolam-verifier/pinned.ts");
const RUNNER_DOCUMENT_FILE = path.resolve(import.meta.dirname, "../src/document.ts");

interface PinnedModule {
  MAX_DOCUMENT_BYTES: number;
  MAX_PICTURE_BYTES: number;
  pinnedFetchUrl: (gateway: string, reference: unknown) => string | null;
  pinnedBodyRefusal: (what: string, status: number, length: number, cap: number) => string | null;
}

let choosePicture: PictureModule["choosePicture"];
let pinned: PinnedModule;

beforeAll(async () => {
  ({ choosePicture } = (await import(pathToFileURL(PICTURE_FILE).href)) as PictureModule);
  pinned = (await import(pathToFileURL(PINNED_FILE).href)) as PinnedModule;
});

const GATEWAY = "https://lavender-personal-grasshopper-978.mypinata.cloud/ipfs/";
const PASSPORT = "0x980549624f85e4ef47043383c5a746cbdd1d82797b5b5583e1f5aeb3841d010c";
const THUMB = "bafkreigwx2nxhx7uotk6kzevdjwkakowu4al6rt6tetra447xoxpdmcpri";

const SEALED_DOCUMENT = {
  name: "Old but strong",
  sealed: true,
  commitment: { algorithm: "sha-256", value: PASSPORT },
};

/** The live answer for "Old but strong", trimmed to the fields the route always sends. */
function recordBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    passportId: PASSPORT,
    image: { cid: "bafybeidrc", uri: "ipfs://bafybeidrc", gatewayUrl: `${GATEWAY}bafybeidrc` },
    thumbnail: { cid: THUMB, uri: `ipfs://${THUMB}`, gatewayUrl: `${GATEWAY}${THUMB}` },
    unsealedBy: "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a",
    unsealedAt: "2026-09-22T12:27:28.511Z",
    ...extra,
  });
}

function reasonOf(choice: PictureChoice): string {
  return choice.kind === "refused" ? choice.reason : "";
}

describe("the workflows fetch only pinned content (R7)", () => {
  const PUBLIC = { name: "Public" };

  it.each([
    ["an http thumbnail", { thumbnail: "http://example.com/thumb.jpg" }],
    ["an https thumbnail", { thumbnail: "https://evil.example/thumb.jpg" }],
    ["a link-local image", { image: "http://169.254.169.254/latest/meta-data" }],
    ["a thumbnail with a path after the id", { thumbnail: `ipfs://${THUMB}/../x` }],
    ["a bare id with no scheme", { thumbnail: THUMB }],
  ])("refuses %s named by the document, naming no address", (_name, picture) => {
    const choice = choosePicture({ ...PUBLIC, ...picture }, PASSPORT, GATEWAY);
    expect(choice.kind).toBe("refused");
    expect(reasonOf(choice)).toContain("not an IPFS content id");
    expect(reasonOf(choice)).toContain(PASSPORT);
    expect(reasonOf(choice)).not.toContain("://");
  });

  it("fetches a document's ipfs:// thumbnail through the configured gateway", () => {
    expect(choosePicture({ ...PUBLIC, thumbnail: `ipfs://${THUMB}` }, PASSPORT, GATEWAY)).toEqual({
      kind: "fetch",
      url: `${GATEWAY}${THUMB}`,
      reference: `ipfs://${THUMB}`,
      source: "document",
    });
  });

  it("builds a gateway URL for ipfs://<cid> and for nothing else", () => {
    expect(pinned.pinnedFetchUrl(GATEWAY, `ipfs://${THUMB}`)).toBe(`${GATEWAY}${THUMB}`);
    expect(pinned.pinnedFetchUrl(GATEWAY.slice(0, -1), `ipfs://${THUMB}`)).toBe(`${GATEWAY}${THUMB}`);
    for (const reference of [
      "https://evil.example/metadata.json",
      "http://169.254.169.254/latest",
      `data:application/json,${encodeURIComponent("{}")}`,
      `ipfs://${THUMB}?x=1`,
      `ipfs://${THUMB}@evil.example`,
      "IPFS://bafkrei",
      "ipfs://",
      "",
      42,
    ]) {
      expect(pinned.pinnedFetchUrl(GATEWAY, reference)).toBeNull();
    }
  });

  it("refuses a redirect status and an over-cap body before a byte is parsed", () => {
    expect(pinned.pinnedBodyRefusal("thumbnail", 302, 0, pinned.MAX_PICTURE_BYTES)).toContain("status 302");
    expect(pinned.pinnedBodyRefusal("thumbnail", 200, 60_001, pinned.MAX_PICTURE_BYTES)).toContain("over the 60000 byte cap");
    expect(pinned.pinnedBodyRefusal("metadata", 200, 32_001, pinned.MAX_DOCUMENT_BYTES)).toContain("over the 32000 byte cap");
    expect(pinned.pinnedBodyRefusal("thumbnail", 200, 23_800, pinned.MAX_PICTURE_BYTES)).toBeNull();
  });

  it("is one predicate: the runner's copy is the workflow's text byte for byte", () => {
    const text = (file: string): string => {
      const source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      const start = source.indexOf("export function pinnedContentId(");
      expect(start).toBeGreaterThan(-1);
      return source.slice(start, source.indexOf("\n}\n", start) + 2);
    };
    expect(text(RUNNER_DOCUMENT_FILE)).toBe(text(PINNED_FILE));
  });
});

describe("the workflow's picture for an unsealed passport", () => {
  it("asks for the record only when the document is sealed and names no picture", () => {
    expect(choosePicture(SEALED_DOCUMENT, PASSPORT, GATEWAY)).toEqual({ kind: "ask-record" });
    expect(choosePicture({ name: "Public", thumbnail: `ipfs://${THUMB}` }, PASSPORT, GATEWAY)).toMatchObject({
      kind: "fetch",
      source: "document",
    });
  });

  it("builds the gateway URL from the record's ipfs:// thumbnail", () => {
    const choice = choosePicture(SEALED_DOCUMENT, PASSPORT, GATEWAY, { status: 200, body: recordBody() });
    expect(choice).toEqual({
      kind: "fetch",
      url: `${GATEWAY}${THUMB}`,
      reference: `ipfs://${THUMB}`,
      source: "unseal record",
    });
  });

  it("refuses an http(s) thumbnail address in the record and never fetches it", () => {
    for (const uri of [`https://evil.example/${THUMB}`, `http://169.254.169.254/latest`]) {
      const choice = choosePicture(SEALED_DOCUMENT, PASSPORT, GATEWAY, {
        status: 200,
        body: recordBody({ thumbnail: { uri, gatewayUrl: uri } }),
      });
      expect(choice.kind).toBe("refused");
      expect(reasonOf(choice)).not.toContain("evil");
      expect(reasonOf(choice)).not.toContain("169.254");
    }
  });

  it("refuses an ipfs:// address that smuggles a path or a query onto the gateway", () => {
    for (const uri of [`ipfs://${THUMB}/../../x`, `ipfs://${THUMB}?x=1`, "ipfs://", `ipfs://${THUMB}@evil.example`]) {
      const choice = choosePicture(SEALED_DOCUMENT, PASSPORT, GATEWAY, {
        status: 200,
        body: recordBody({ thumbnail: { uri } }),
      });
      expect(choice.kind).toBe("refused");
    }
  });

  it("refuses a record whose cid and uri disagree", () => {
    const choice = choosePicture(SEALED_DOCUMENT, PASSPORT, GATEWAY, {
      status: 200,
      body: recordBody({ thumbnail: { cid: "bafkreiother", uri: `ipfs://${THUMB}` } }),
    });
    expect(choice.kind).toBe("refused");
  });

  it("refuses a record that names a different passport, and compares ids in one letter case", () => {
    const other = `0x${"1".repeat(64)}`;
    const refused = choosePicture(SEALED_DOCUMENT, PASSPORT, GATEWAY, {
      status: 200,
      body: recordBody({ passportId: other }),
    });
    expect(reasonOf(refused)).toContain("names another passport");
    expect(reasonOf(refused)).not.toContain(other);

    const upper = choosePicture(SEALED_DOCUMENT, PASSPORT, GATEWAY, {
      status: 200,
      body: recordBody({ passportId: PASSPORT.toUpperCase().replace("0X", "0x") }),
    });
    expect(upper.kind).toBe("fetch");
  });

  it("stops on a 404 exactly as a sealed passport does, naming the status and the passport", () => {
    const choice = choosePicture(SEALED_DOCUMENT, PASSPORT, GATEWAY, { status: 404, body: "{}" });
    expect(reasonOf(choice)).toContain("status 404");
    expect(reasonOf(choice)).toContain(PASSPORT);
  });

  it("stops on any other status or an unparseable body, and never names a URL", () => {
    for (const record of [
      { status: 503, body: '{"error":"lookup-unavailable"}' },
      { status: 500, body: "" },
      { status: 200, body: "<html>not json</html>" },
      { status: 200, body: "[]" },
    ]) {
      const choice = choosePicture(SEALED_DOCUMENT, PASSPORT, GATEWAY, record);
      expect(choice.kind).toBe("refused");
      expect(reasonOf(choice)).toContain(PASSPORT);
      expect(reasonOf(choice)).not.toMatch(/https?:\/\//);
    }
  });

  it("keeps refusing a document that is neither sealed nor names a picture", () => {
    const choice = choosePicture({ name: "Nothing here" }, PASSPORT, GATEWAY, { status: 200, body: recordBody() });
    expect(reasonOf(choice)).toContain("no thumbnail or image");
  });
});

describe("the fingerprint's size rule, before any spend (tally R12)", () => {
  const PHASH_FILE = path.resolve(import.meta.dirname, "../../workflow/moolam-verifier/phash.ts");
  const DECODE_FILE = path.resolve(import.meta.dirname, "../../workflow/moolam-verifier/decode.ts");
  const JPEG_JS = path.resolve(import.meta.dirname, "../../workflow/moolam-verifier/node_modules/jpeg-js/index.js");

  interface PhashModule {
    fingerprintSizeRefusal: (width: number, height: number) => string | null;
    perceptualHash: (pixels: Uint8Array, width: number, height: number, channels: number) => bigint;
  }
  interface DecodeModule {
    decodeJpeg: (bytes: Uint8Array) => { pixels: Uint8Array; width: number; height: number; channels: number };
  }
  interface JpegJs {
    encode: (image: { data: Uint8Array; width: number; height: number }, quality: number) => { data: Uint8Array };
  }

  function jpeg(encoder: JpegJs, width: number, height: number): Uint8Array {
    const data = new Uint8Array(width * height * 4);
    for (let at = 0; at < data.length; at += 1) {
      data[at] = (at * 37) % 251;
    }
    return new Uint8Array(encoder.encode({ data, width, height }, 90).data);
  }

  it("is one predicate: the runner's copy is phash.ts's text and gives the same answer everywhere", async () => {
    const phash = (await import(pathToFileURL(PHASH_FILE).href)) as PhashModule;
    const runner = await import(pathToFileURL(RUNNER_DOCUMENT_FILE).href);
    const text = (file: string): string => {
      const source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      const start = source.indexOf("export function fingerprintSizeRefusal(");
      expect(start).toBeGreaterThan(-1);
      return source.slice(start, source.indexOf("\n}\n", start) + 2);
    };
    expect(text(RUNNER_DOCUMENT_FILE)).toBe(text(PHASH_FILE));
    for (const [width, height] of [[512, 29], [29, 512], [31, 31], [32, 32], [512, 32], [33, 1000], [0, 0]] as const) {
      expect(runner.fingerprintSizeRefusal(width, height)).toBe(phash.fingerprintSizeRefusal(width, height));
    }
  });

  it("reads a JPEG's size as the workflow's decoder does, and refuses exactly what perceptualHash refuses", async () => {
    const phash = (await import(pathToFileURL(PHASH_FILE).href)) as PhashModule;
    const { decodeJpeg } = (await import(pathToFileURL(DECODE_FILE).href)) as DecodeModule;
    const encoder = (await import(pathToFileURL(JPEG_JS).href)) as { default?: JpegJs } & JpegJs;
    const runner = await import(pathToFileURL(RUNNER_DOCUMENT_FILE).href);
    for (const [width, height] of [[512, 29], [29, 512], [512, 384], [32, 32], [31, 64]] as const) {
      const bytes = jpeg(encoder.default ?? encoder, width, height);
      const decoded = decodeJpeg(bytes);
      expect(runner.jpegSize(bytes)).toEqual({ width: decoded.width, height: decoded.height });

      const refusal = runner.fingerprintSizeRefusal(width, height) as string | null;
      const hashing = (): bigint => phash.perceptualHash(decoded.pixels, decoded.width, decoded.height, decoded.channels);
      if (refusal === null) {
        expect(hashing).not.toThrow();
      } else {
        expect(hashing).toThrowError(refusal);
      }
    }
    expect(runner.jpegSize(new TextEncoder().encode("<html>not a picture</html>"))).toBeNull();
  });
});

describe("the runner's copies of the workflow's picture rules agree with the originals (tally R2, R12)", () => {
  it("reads every document the way choosePicture does before it spends", async () => {
    const runner = await import(pathToFileURL(RUNNER_DOCUMENT_FILE).href);
    const documents: Record<string, unknown>[] = [
      { name: "Public", thumbnail: `ipfs://${THUMB}` },
      { name: "Public", image: `ipfs://${THUMB}` },
      { name: "Both", thumbnail: `ipfs://${THUMB}`, image: "https://a.example/x.jpg" },
      { name: "Thumbnail wins", thumbnail: "https://a.example/x.jpg", image: `ipfs://${THUMB}` },
      { name: "Empty thumbnail", thumbnail: "", image: `ipfs://${THUMB}` },
      { name: "Number", thumbnail: 42 },
      { name: "Sentence", sealed: true, image: "the picture was lost" },
      { name: "Nothing" },
      { name: "Sealed", sealed: true },
      { name: "Sealed with null", sealed: true, thumbnail: null },
      { name: "Sealed but a string", sealed: "yes" },
      { name: "Path", thumbnail: `ipfs://${THUMB}/x` },
    ];
    for (const document of documents) {
      const workflow = choosePicture(document, PASSPORT, GATEWAY);
      const copy = runner.pictureRule(document) as { kind: string; cid?: string };
      expect(copy.kind, JSON.stringify(document)).toBe(workflow.kind);
      if (workflow.kind === "fetch") {
        expect(`${GATEWAY}${copy.cid ?? ""}`).toBe(workflow.url);
      }
    }
  });

  it("reads an unseal record's thumbnail the way choosePicture does", async () => {
    const runner = await import(pathToFileURL(RUNNER_DOCUMENT_FILE).href);
    for (const thumbnail of [
      { cid: THUMB, uri: `ipfs://${THUMB}` },
      { uri: `ipfs://${THUMB}` },
      { cid: "bafkreiother", uri: `ipfs://${THUMB}` },
      { uri: `https://evil.example/${THUMB}` },
      { uri: `ipfs://${THUMB}?x=1` },
      "ipfs://bare-string",
      null,
    ]) {
      const workflow = choosePicture(SEALED_DOCUMENT, PASSPORT, GATEWAY, { status: 200, body: recordBody({ thumbnail }) });
      const copy = runner.recordPicture(thumbnail) as string | null;
      expect(copy === null ? "refused" : `${GATEWAY}${copy}`, JSON.stringify(thumbnail)).toBe(
        workflow.kind === "fetch" ? workflow.url : "refused",
      );
    }
  });

  it("holds pictures and documents to the workflow's byte caps", async () => {
    const runner = await import(pathToFileURL(RUNNER_DOCUMENT_FILE).href);
    expect(runner.MAX_PICTURE_BYTES).toBe(pinned.MAX_PICTURE_BYTES);
    expect(runner.MAX_DOCUMENT_BYTES).toBe(pinned.MAX_DOCUMENT_BYTES);
  });
});
