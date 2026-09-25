// Holds the CRE workflow's picture choice, packages/workflow/moolam-verifier/picture.ts, to the
// unseal record's real shape. Does NOT cover the HTTP call that fetches the record, the sandbox's
// own limits, or the fingerprint of the picture fetched: those run only inside the simulator, and
// the Old but strong run against the live passport in proofs/rechecks.txt is their proof.

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

let choosePicture: PictureModule["choosePicture"];

beforeAll(async () => {
  ({ choosePicture } = (await import(pathToFileURL(PICTURE_FILE).href)) as PictureModule);
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
