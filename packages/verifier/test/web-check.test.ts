// Covers the web check at signing (WO-275b, L22 to L24). One predicate decides what goes to Google:
// a studio upload of a captured picture that is not sealed, not a platform's and not generated, and
// only after the token and the day's prepare slot have let the caller through. What is sent is the
// public thumbnail the passport will publish. Vision gets ten seconds. The key rides in the
// x-goog-api-key header, never the address, and redirects are refused. Vision's answer is parsed by a
// schema under a byte cap; pages are kept only as http or https with a host, query and fragment
// dropped, at most ten of at most 256 characters, and the count the answer shows is the count the
// document stores. Zero hits, a failure and a timeout all answer "silent" and record nothing. The
// day's Vision ceiling comes from VISION_CHECKS_PER_DAY, zero switches the check off, and the key
// never reaches a log line or an answer.
// Does NOT call Google: every detector is a stand-in, and the live detector runs against a stubbed
// fetch. Does NOT cover the studio's own words before upload (WO-277), the hourly per-user cap (held
// by the route's rate limit and tested in test/prepare.test.ts), or that the call runs outside the
// decode gate, which is held by the order of src/routes/prepare.ts and not observable here.

import fs from "node:fs";
import { SignJWT, generateKeyPair } from "jose";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeImage } from "./helpers.js";

const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000031";
  process.env.PRIVY_APP_ID = id;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  // A number nothing else uses, so the ceiling test proves the route read it from the environment.
  process.env.VISION_CHECKS_PER_DAY = "2";
  return id;
});

const stubs = vi.hoisted(() => ({ ensureSigner: vi.fn(), passportExists: vi.fn() }));

vi.mock("../src/c2pa.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/c2pa.js")>()),
  ensureSigner: stubs.ensureSigner,
}));

vi.mock("../src/edit/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/registry.js")>()),
  passportExists: stubs.passportExists,
}));

const { buildServer } = await import("../src/server.js");
const { contentIdOf } = await import("../src/ipfs/pinata.js");
const { parseEnv } = await import("../src/env.js");
const { globalDay } = await import("../src/limits/globalDay.js");
const { SILENT, WEB_CHECK_TIMEOUT_MS, sendsToWeb, webCheck } = await import("../src/webcheck/check.js");
const { MAX_PAGE_CHARS, VISION_ANSWER_MAX_BYTES, VISION_URL, pageAddress, pagesFromAnswer, visionDetector } = await import(
  "../src/webcheck/vision.js"
);
type WebDetector = import("../src/webcheck/vision.js").WebDetector;
type WebCheckSubject = import("../src/webcheck/check.js").WebCheckSubject;

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const KEY = "AIzaSyTESTKEYnotarealonexxxxxxxxxxxxxx1";
const STUDIO: WebCheckSubject = { route: "studio", kind: 1, sealed: false, platform: false, generated: false };
const SHUT = { generations: 0, edits: 0, unseals: 0, links: 0 };
const QUIET = { info: () => undefined, warn: () => undefined };

/** Every pin the Pinata stub took, by name. */
const pins: { name: string; bytes: Buffer }[] = [];
/** Every fetch that was not a pin: there must be none. */
const stray: string[] = [];

let signing: CryptoKey;
let verifying: CryptoKey;
let servers: FastifyInstance[] = [];
let seed = 300;
let address = 10;

beforeAll(async () => {
  stubs.ensureSigner.mockResolvedValue(undefined);
  stubs.passportExists.mockResolvedValue(false);
  const pair = await generateKeyPair("ES256", { extractable: true });
  signing = pair.privateKey;
  verifying = pair.publicKey;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== UPLOAD_URL) {
      stray.push(url);
      throw new Error("no network in this test");
    }
    const form = init?.body as FormData;
    const bytes = Buffer.from(await (form.get("file") as File).arrayBuffer());
    pins.push({ name: String(form.get("name")), bytes });
    return new Response(JSON.stringify({ data: { cid: contentIdOf(bytes), size: bytes.length, network: "public" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(async () => {
  await Promise.all(servers.map(async (server) => await server.close()));
  servers = [];
});

afterAll(() => {
  vi.unstubAllGlobals();
  expect(stray).toEqual([]);
});

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

async function studio(detector: WebDetector | undefined, logger = false): Promise<FastifyInstance> {
  const server = await buildServer({
    source: { load: async () => [] },
    logger,
    prepare: { keys: verifying, webCheck: { detector } },
  });
  await server.ready();
  servers.push(server);
  return server;
}

async function prepare(server: FastifyInstance, fields: Record<string, string> = {}, signedIn = true) {
  const boundary = "----moolamwebcheck";
  const image = await makeImage((seed += 1));
  const text = Object.entries({ title: "Harbour at dusk", kind: "human", ...fields }).map(
    ([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  const payload = Buffer.concat([
    Buffer.from(text.join("")),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="h.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  address += 1;
  const mark = pins.length;
  const response = await server.inject({
    method: "POST",
    url: "/prepare",
    payload,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      ...(signedIn ? { authorization: `Bearer ${await token(`did:privy:web${address}`)}` } : {}),
    },
    remoteAddress: `203.0.113.${address}`,
  });
  const pinned = pins.slice(mark);
  const documentPin = pinned.find((pin) => pin.name.endsWith(".json") && !pin.name.endsWith("-c2pa.json"));
  return {
    status: response.statusCode,
    body: response.body,
    json: response.json() as Record<string, unknown>,
    thumbnail: pinned.find((pin) => pin.name.endsWith("-thumb.jpg"))?.bytes,
    document: documentPin === undefined ? undefined : (JSON.parse(documentPin.bytes.toString("utf8")) as Record<string, unknown>),
  };
}

/** A stand-in detector that answers `found` and keeps every picture it was sent. */
function standIn(found: () => Promise<{ count: number; pages: string[] }>) {
  const sent: Buffer[] = [];
  const detector: WebDetector = async (picture) => {
    sent.push(picture);
    return await found();
  };
  return { detector, sent };
}

/** Everything this process writes to stdout while `work` runs, by every road pino may use. */
async function captureLog<T>(work: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const captured: string[] = [];
  const keep = (chunk: unknown): void => {
    if (typeof chunk === "string") captured.push(chunk);
    else if (chunk instanceof Uint8Array) captured.push(Buffer.from(chunk).toString("utf8"));
  };
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    keep(chunk);
    return true;
  });
  const patched = fs as unknown as Record<string, unknown>;
  const realWrite = fs.write;
  const realWriteSync = fs.writeSync;
  patched.write = (...args: unknown[]): unknown => {
    if (args[0] === 1) {
      keep(args[1]);
      const done = args.find((arg) => typeof arg === "function") as ((...rest: unknown[]) => void) | undefined;
      done?.(null, typeof args[1] === "string" ? Buffer.byteLength(args[1]) : (args[1] as Uint8Array).length);
      return undefined;
    }
    return (realWrite as unknown as (...rest: unknown[]) => unknown)(...args);
  };
  patched.writeSync = (...args: unknown[]): unknown => {
    if (args[0] === 1) {
      keep(args[1]);
      return typeof args[1] === "string" ? Buffer.byteLength(args[1]) : (args[1] as Uint8Array).length;
    }
    return (realWriteSync as unknown as (...rest: unknown[]) => unknown)(...args);
  };
  try {
    const result = await work();
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { result, logged: captured.join("") };
  } finally {
    patched.write = realWrite;
    patched.writeSync = realWriteSync;
    stdout.mockRestore();
  }
}

describe("L22: one predicate decides what goes to Google", () => {
  it("sends only a studio upload of a captured picture that is not sealed, not a platform's and not generated", () => {
    expect(sendsToWeb(STUDIO)).toBe(true);
    const others: WebCheckSubject[] = [
      { ...STUDIO, sealed: true },
      { ...STUDIO, kind: 0 },
      { ...STUDIO, kind: 2 },
      { ...STUDIO, platform: true },
      { ...STUDIO, generated: true },
      { ...STUDIO, route: "platform" },
      { ...STUDIO, route: "generate" },
      { ...STUDIO, route: "edit" },
    ];
    for (const subject of others) {
      expect(sendsToWeb(subject), JSON.stringify(subject)).toBe(false);
    }
  });

  it("sends a public upload's published thumbnail once, and never a sealed picture", async () => {
    const { detector, sent } = standIn(async () => ({ count: 0, pages: [] }));
    const server = await studio(detector);

    const shown = await prepare(server);
    expect(shown.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(shown.thumbnail).toBeDefined();
    expect((sent[0] as Buffer).equals(shown.thumbnail as Buffer)).toBe(true);

    const sealed = await prepare(server, { sealed: "true" });
    expect(sealed.status).toBe(200);
    expect(sealed.json.webCheck).toEqual({ state: "silent" });
    expect(sent).toHaveLength(1);
  }, 60_000);

  it("sends nothing for a caller refused at the token or at the day's prepare ceiling for everyone", async () => {
    const { detector, sent } = standIn(async () => ({ count: 1, pages: ["https://example.com/a"] }));
    const server = await studio(detector);

    expect((await prepare(server, {}, false)).status).toBe(401);
    while (server.globalDay.tryTake("prepares").ok) {
      // Spends today's prepares for everyone, so the next caller meets the ceiling.
    }
    const refused = await prepare(server);
    expect(refused.status).toBe(429);
    expect(refused.json.error).toBe("global-limit");
    expect(sent).toHaveLength(0);
  }, 60_000);

  it("gives up on Vision after ten seconds, aborts the call and answers silent", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const hanging: WebDetector = async (_picture, signal) =>
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        });
      const day = globalDay({ prepares: 5, ...SHUT });
      const waiting = webCheck({ subject: STUDIO, picture: Buffer.from("x"), detector: hanging, takeSlot: () => day.tryTake("prepares"), log: QUIET });
      await vi.advanceTimersByTimeAsync(WEB_CHECK_TIMEOUT_MS - 1);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await waiting).toEqual(SILENT);
      expect(aborted).toBe(true);
      expect(WEB_CHECK_TIMEOUT_MS).toBe(10_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts the key in the x-goog-api-key header, never in the address, and refuses redirects", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ responses: [{ webDetection: { pagesWithMatchingImages: [{ url: "https://example.com/p" }] } }] }), {
        status: 200,
      });
    }) as typeof fetch;
    const picture = Buffer.from("thumbnail bytes");

    const found = await visionDetector(KEY, fetcher)(picture, new AbortController().signal);

    expect(found).toEqual({ count: 1, pages: ["https://example.com/p"] });
    const call = calls[0] as { url: string; init: RequestInit };
    expect(call.url).toBe(VISION_URL);
    expect(call.url).not.toContain(KEY);
    expect((call.init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    expect(call.init.redirect).toBe("error");
    const body = JSON.parse(String(call.init.body));
    expect(body.requests[0].image.content).toBe(picture.toString("base64"));
    expect(body.requests[0].features[0].type).toBe("WEB_DETECTION");
  });
});

describe("L23: Vision's answer is validated like an input, and its absence means nothing", () => {
  it("keeps only http and https pages with a host, without query, fragment or credentials, at most 256 characters", () => {
    expect(pageAddress("https://user:secret@Example.COM:8443/a/b?token=1#frag")).toBe("https://example.com:8443/a/b");
    expect(pageAddress("http://example.com")).toBe("http://example.com/");
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "ftp://example.com/x", "/relative/path", "mailto:a@b.c", 42, "", `https://example.com/${"a".repeat(MAX_PAGE_CHARS)}`]) {
      expect(pageAddress(bad), String(bad)).toBeUndefined();
    }

    const many = Array.from({ length: 14 }, (_unused, at) => ({ url: `https://site${at}.example/page?ref=${at}` }));
    const found = pagesFromAnswer({
      responses: [
        {
          webDetection: {
            pagesWithMatchingImages: [
              ...many,
              { url: "https://site0.example/page#again" },
              { url: "javascript:alert(1)" },
              { url: `https://long.example/${"b".repeat(400)}` },
            ],
          },
        },
      ],
    });
    expect(found.count).toBe(14);
    expect(found.pages).toHaveLength(10);
    expect(found.pages[0]).toBe("https://site0.example/page");
    expect(found.pages.every((page) => page.length <= MAX_PAGE_CHARS && !page.includes("?") && !page.includes("#"))).toBe(true);
  });

  it("refuses an answer of another shape, one carrying Vision's own error, and one past the byte cap", async () => {
    for (const bad of [{}, { responses: [] }, { responses: [{}, {}] }, { responses: [{ error: { code: 7, message: "denied" } }] }, { responses: [{ webDetection: { pagesWithMatchingImages: [{ url: 5 }] } }] }]) {
      expect(() => pagesFromAnswer(bad), JSON.stringify(bad)).toThrow();
    }
    expect(pagesFromAnswer({ responses: [{ webDetection: {} }] })).toEqual({ count: 0, pages: [] });

    const huge = `{"responses":[{"webDetection":{"pagesWithMatchingImages":[${'{"url":"https://example.com/x"},'.repeat(20_000)}{"url":"https://example.com/y"}]}}]}`;
    expect(huge.length).toBeGreaterThan(VISION_ANSWER_MAX_BYTES);
    const streamed = visionDetector(KEY, (async () => new Response(huge, { status: 200 })) as typeof fetch);
    await expect(streamed(Buffer.from("x"), new AbortController().signal)).rejects.toThrow(/byte cap/);
    const declared = visionDetector(KEY, (async () => new Response("{}", { status: 200, headers: { "content-length": String(VISION_ANSWER_MAX_BYTES + 1) } })) as typeof fetch);
    await expect(declared(Buffer.from("x"), new AbortController().signal)).rejects.toThrow(/byte cap/);
  });

  it("answers silent and records nothing for zero hits or a failed call", async () => {
    for (const detector of [standIn(async () => ({ count: 0, pages: [] })).detector, standIn(async () => Promise.reject(new Error("vision 503"))).detector]) {
      const server = await studio(detector);
      const answer = await prepare(server);
      expect(answer.status).toBe(200);
      expect(answer.json.webCheck).toEqual({ state: "silent" });
      expect(answer.document).toBeDefined();
      expect(answer.document?.seenOnline).toBeUndefined();
    }
  }, 60_000);

  it("stores in the document exactly the count and pages the answer shows", async () => {
    const pages = ["https://example.com/one", "https://news.example/two"];
    const server = await studio(standIn(async () => ({ count: 7, pages })).detector);

    const answer = await prepare(server);

    expect(answer.json.webCheck).toEqual({ state: "found", count: 7, pages });
    expect(answer.document?.seenOnline).toEqual({ count: 7, pages });
  }, 60_000);
});

describe("L24: Vision spend is capped and the key never leaves", () => {
  it("stops sending once VISION_CHECKS_PER_DAY is spent for the day, read from the environment", async () => {
    const { detector, sent } = standIn(async () => ({ count: 1, pages: ["https://example.com/a"] }));
    const server = await studio(detector);

    expect((await prepare(server)).json.webCheck).toMatchObject({ state: "found" });
    expect((await prepare(server)).json.webCheck).toMatchObject({ state: "found" });
    const third = await prepare(server);
    expect(third.status).toBe(200);
    expect(third.json.webCheck).toEqual({ state: "silent" });
    expect(sent).toHaveLength(2);
  }, 90_000);

  it("reads 0 as the off switch, refuses a malformed key without repeating it, and sends nothing with no detector", async () => {
    expect(parseEnv({ VISION_CHECKS_PER_DAY: "0" }).VISION_CHECKS_PER_DAY).toBe(0);
    expect(parseEnv({}).VISION_CHECKS_PER_DAY).toBe(300);
    const bad = "short\r\nx-evil: 1";
    expect(() => parseEnv({ GOOGLE_VISION_API_KEY: bad })).toThrow(/GOOGLE_VISION_API_KEY/);
    try {
      parseEnv({ GOOGLE_VISION_API_KEY: bad });
    } catch (error) {
      expect(String(error)).not.toContain("x-evil");
    }

    const { detector, sent } = standIn(async () => ({ count: 1, pages: ["https://example.com/a"] }));
    const off = globalDay({ prepares: 0, ...SHUT });
    expect(await webCheck({ subject: STUDIO, picture: Buffer.from("x"), detector, takeSlot: () => off.tryTake("prepares"), log: QUIET })).toEqual(SILENT);
    const on = globalDay({ prepares: 1, ...SHUT });
    expect(await webCheck({ subject: STUDIO, picture: Buffer.from("x"), detector: undefined, takeSlot: () => on.tryTake("prepares"), log: QUIET })).toEqual(SILENT);
    expect(on.counts().prepares.used).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("never writes the key into a log line or an answer, whatever Vision or the network says", async () => {
    let call = 0;
    const hostile = (async (url: string) => {
      call += 1;
      if (call === 1) throw new Error(`connect ECONNREFUSED ${url}?key=${KEY} with key ${KEY}`);
      return new Response(JSON.stringify({ error: { message: `API key ${KEY} not valid` } }), { status: 403 });
    }) as typeof fetch;

    const { result, logged } = await captureLog(async () => {
      const server = await studio(visionDetector(KEY, hostile), true);
      return [await prepare(server), await prepare(server)];
    });

    expect(call).toBe(2);
    for (const answer of result) {
      expect(answer.status).toBe(200);
      expect(answer.json.webCheck).toEqual({ state: "silent" });
      expect(answer.body).not.toContain(KEY);
    }
    expect(logged).toContain("web check: Vision gave no usable answer");
    for (const line of logged.split("\n")) {
      expect(line).not.toContain(KEY);
    }
  }, 60_000);
});
