// Covers the multipart field limit's answer on the three routes that read a multipart body with
// text fields: /prepare, /edit and /unseal. A body with more text fields than the limit answers
// 400 { "error": "too-many-fields" } whether the file part comes before the fields or after them,
// where it used to answer "Premature close", and nothing is pinned. A body at the limit still
// parses, so the limit itself has not moved. /generate takes a JSON body only and never parses a
// multipart one, so the same body there is refused as "not JSON" and never reaches the limit.
// Pinata is answered by a stub at the fetch layer that only counts; nothing leaves the process.
// Does NOT cover a caller who hangs up in the middle of an upload, which is the other way a file
// read closes early and keeps its old answer, nor /verify, which reads its one file part through
// a different call of the plugin.

import { SignJWT, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000004";
  process.env.PRIVY_APP_ID = id;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  return id;
});

const { buildServer } = await import("../src/server.js");
const { makeImage } = await import("./helpers.js");

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const PASSPORT = `0x${"3e".repeat(32)}`;

let app: FastifyInstance;
let signing: CryptoKey;
let image: Buffer;
let uploads = 0;

async function token(subject: string): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("privy.io")
    .setAudience(APP_ID)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signing);
}

function multipart(fields: Record<string, string>, fileFirst: boolean): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----moolamfields";
  const text = Object.entries(fields).map(([name, value]) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
  );
  const file = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
    ),
    image,
    Buffer.from("\r\n"),
  ]);
  const chunks = fileFirst ? [file, ...text] : [...text, file];
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function send(
  url: string,
  fields: Record<string, string>,
  fileFirst: boolean,
  subject: string,
): Promise<LightMyRequestResponse> {
  const { payload, headers } = multipart(fields, fileFirst);
  return await app.inject({
    method: "POST",
    url,
    payload,
    headers: { ...headers, authorization: `Bearer ${await token(subject)}` },
    remoteAddress: "198.51.100.60",
  });
}

/** Five text fields: one more than the parser takes. The extra ones are the smuggling kind. */
const FIVE = {
  image: "ipfs://bafysmuggled",
  thumbnail: "ipfs://bafythumb",
  manifest: "ipfs://bafymanifest",
  animation_url: "https://example.com/a.mp4",
  external_url: "https://example.com",
};

beforeAll(async () => {
  image = await makeImage(61);
  const pair = await generateKeyPair("ES256", { extractable: true });
  signing = pair.privateKey;
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === UPLOAD_URL) {
      uploads += 1;
      return new Response(JSON.stringify({ data: { cid: `bafyfields${uploads}`, size: 1 } }), { status: 200 });
    }
    return await realFetch(input, init);
  });

  const keys = pair.publicKey;
  app = await buildServer({
    source: { load: async () => [] },
    logger: false,
    prepare: { keys },
    generate: { keys },
    edit: { keys },
    unseal: { keys },
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

describe("a multipart body with more text fields than the limit", () => {
  for (const [route, fields] of [
    ["/prepare", { title: "Too many", kind: "human", sealed: "true", ...FIVE }],
    ["/edit", { title: "Too many", parentId: PASSPORT, note: "n", ...FIVE }],
    ["/unseal", { passportId: PASSPORT, ...FIVE }],
  ] as const) {
    it(`answers 400 too-many-fields on ${route}, file first or last, and pins nothing`, async () => {
      const before = uploads;
      for (const fileFirst of [false, true]) {
        const response = await send(route, fields, fileFirst, `did:privy:fields-${route.slice(1)}-${String(fileFirst)}`);

        expect(response.statusCode, `${route} file first ${String(fileFirst)}`).toBe(400);
        expect(response.json(), `${route} file first ${String(fileFirst)}`).toEqual({ error: "too-many-fields" });
      }
      expect(uploads).toBe(before);
    });
  }

  it("still parses a body at the limit, so the limit itself has not moved", async () => {
    const atLimit = { passportId: "0xnothex", a: "1", b: "2", c: "3" };
    for (const fileFirst of [false, true]) {
      const response = await send("/unseal", atLimit, fileFirst, `did:privy:fields-at-limit-${String(fileFirst)}`);

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain("passportId");
    }
  });

  it("is refused on /generate as a body that is not JSON, because that route never parses multipart", async () => {
    const response = await send(
      "/generate",
      { prompt: "a lighthouse", title: "Too many", creator: "0x0", ...FIVE },
      false,
      "did:privy:fields-generate",
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("Premature close");
    expect(response.json().error).not.toBe("too-many-fields");
  });
});
