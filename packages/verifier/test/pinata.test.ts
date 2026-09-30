// Covers the upload timeout on pinFile with fetch stubbed: an upload that never answers is
// abandoned rather than held open forever, and the retry after a 5xx gets a clock of its own.
// Also covers WO-255: a try that fails for a passing reason is tried again at most twice, after
// 1 s and 3 s or a short Retry-After, inside the pin's one deadline; any other status fails at once;
// a retry answered with the same content id is the success; each failed try is one log line with
// its status and the file's role, never the token or the bytes. These waits are real, so the block
// takes about fifteen seconds. It does NOT cover the private upload, which keeps its single try.
// Also covers the four private-network calls against a recording fetch: what each one sends, the
// 10 second bound on every one of them (B15), the refusal of an upload Pinata did not keep private
// under the name sent (B16), whole-name matching and "cannot tell" on a bad or endless listing
// (B3), and a read link that is checked before it is returned and never printed in an error.
// Also covers V11: a public pin is believed only when Pinata answers with the content id computed
// here for the bytes sent, on the public network. The local content id is checked against a real
// picture Pinata pinned (test/fixtures/pinned-hero.jpg, the hero passport, whose content id is in
// packages/web/public/hero/degrade.json) and against a one-block file.
// Also covers review pass 4, V20: files null reads as an empty list and a missing files key as
// "cannot tell", in the public unseal lookup and in both private listing parsers alike.
// From review pass 7 (V67): a private upload says whether Pinata answered with a file it already
// held, read from its duplicate flag, and a missing flag counts as held, since nothing then shows
// this request made the file.
// Does NOT cover a real pin to Pinata (the live check in the README and
// scripts/pinata-private-smoke.ts do that), the gateway URL helper, or the JSON shape check on the
// public upload, which the prepare and generate route tests exercise.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
});

const {
  PRIVATE_CALL_TIMEOUT_MS,
  PRIVATE_LIST_MAX_PAGES,
  PinNotConfirmed,
  PinRefused,
  PrivateCopyNotPrivate,
  contentIdOf,
  deletePrivateFile,
  findPrivateByName,
  pinFile,
  pinPrivateFile,
  privateDownloadLink,
} = await import("../src/ipfs/pinata.js");

const BYTES = Buffer.from("a few bytes that stand in for a picture");
const TIMEOUT_MS = 80;
const NAME = `sealed-thumb-0x${"ab".repeat(32)}.jpg`;
const FILE_ID = "0199a3c2-5d7e-7f10-9a1b-2c3d4e5f6a7b";
const CID = "bafkreifqi353vfs5ucdx3ydewealjk6ufwfqahuzvjsipbgwwks4tfwkh4";
const SIGNED = `https://moolam-test.mypinata.cloud/files/${CID}?X-Algorithm=PINATA1&X-Date=1&X-Expires=30&X-Method=GET&X-Signature=abc123`;

/** Every signal the stub was handed, so a second attempt can be told apart from the first. */
const seen: AbortSignal[] = [];

/** One request as the recording fetch saw it. */
interface Sent {
  url: string;
  method: string;
  authorization: string | null;
  form?: FormData;
  json?: Record<string, unknown>;
}

const sent: Sent[] = [];

/** Answers nothing and settles only when the caller's own timeout gives up. */
async function stall(signal: AbortSignal): Promise<Response> {
  return await new Promise<Response>((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(signal.reason);
    });
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Records every call and answers them in order from the list given. */
function recording(...answers: Array<() => Response>): void {
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = init?.body;
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      form: body instanceof FormData ? body : undefined,
      json: typeof body === "string" ? (JSON.parse(body) as Record<string, unknown>) : undefined,
    });
    const next = answers.shift();
    if (next === undefined) {
      throw new Error("the recording fetch was called more times than the test expected");
    }
    return next();
  });
}

function privateAnswer(overrides: Record<string, unknown> = {}): Response {
  return json({
    data: { id: FILE_ID, name: NAME, cid: CID, network: "private", is_duplicate: false, ...overrides },
  });
}

describe("pinning through Pinata", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    seen.length = 0;
  });

  it("gives up on an upload that stalls past the timeout", async () => {
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      seen.push(signal);
      return await stall(signal);
    });

    const started = Date.now();
    await expect(pinFile(BYTES, "stalled.jpg", "image/jpeg", { timeoutMs: TIMEOUT_MS })).rejects.toThrow(
      /abort|timeout|timed out/i,
    );

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(true);
  });

  it("gives the retry after a server error its own signal", async () => {
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      seen.push(signal);
      if (seen.length === 1) {
        return new Response("the gateway is unhappy", { status: 502 });
      }
      return await stall(signal);
    });

    // Long enough for the 1 s wait before the retry; the stalled retry then ends on the same deadline.
    await expect(
      pinFile(BYTES, "retried.jpg", "image/jpeg", { timeoutMs: 1_500, log: { warn: vi.fn() } }),
    ).rejects.toThrow(/abort|timeout|timed out/i);

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  }, 10_000);
});

describe("WO-255: a pin that failed for a passing reason is tried again", () => {
  const right = contentIdOf(BYTES);
  const pinned = () => json({ data: { cid: right, size: BYTES.length, network: "public" } });

  afterEach(() => {
    vi.unstubAllGlobals();
    sent.length = 0;
  });

  it("pins on the second try after the 408 Pinata answered live, and logs the failed try", async () => {
    recording(
      () => json({ error: { code: 408, message: "client disconnected" } }, 408),
      pinned,
    );
    const log = { warn: vi.fn() };

    const started = Date.now();
    const outcome = await pinFile(BYTES, "firefly-roots-942486fb.json", "application/json", { log });

    expect(outcome).toEqual({ cid: right, uri: `ipfs://${right}`, size: BYTES.length });
    expect(sent).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(log.warn.mock.calls).toEqual([
      [{ role: "metadata", try: 1, status: 408, retrying: true }, "pin: a try at Pinata failed"],
    ]);
  }, 10_000);

  it("fails with the old refusal after three 503s, as a pin that may have landed, and never logs the token or bytes", async () => {
    recording(
      () => new Response("down", { status: 503 }),
      () => new Response("down", { status: 503 }),
      () => new Response("down", { status: 503 }),
    );
    const log = { warn: vi.fn() };

    const started = Date.now();
    const failure = (await pinFile(BYTES, "sky-0badc0de.jpg", "image/jpeg", { log }).catch((error: unknown) => error)) as Error;

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PinRefused);
    expect(failure.message).toBe("Pinata refused to pin sky-0badc0de.jpg: 503 down (try 3)");
    expect(sent).toHaveLength(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_900);
    expect(log.warn.mock.calls.map(([details]) => details)).toEqual([
      { role: "image", try: 1, status: 503, retrying: true },
      { role: "image", try: 2, status: 503, retrying: true },
      { role: "image", try: 3, status: 503, retrying: false },
    ]);
    const logged = JSON.stringify(log.warn.mock.calls);
    expect(logged).not.toContain("test-token-not-a-real-pinata-jwt");
    expect(logged).not.toContain(BYTES.toString());
  }, 15_000);

  it("fails a 401 at once, with no retry and nothing that may have landed", async () => {
    recording(() => new Response("invalid token", { status: 401 }));
    const log = { warn: vi.fn() };

    const started = Date.now();
    const failure = await pinFile(BYTES, "sky-0badc0de-thumb.jpg", "image/jpeg", { log }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PinRefused);
    expect(sent).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(500);
    expect(log.warn.mock.calls.map(([details]) => details)).toEqual([
      { role: "thumbnail", try: 1, status: 401, retrying: false },
    ]);
  });

  it("waits a Retry-After of 2 s, and the planned 1 s when the Retry-After is 10 s or more", async () => {
    recording(() => new Response("slow down", { status: 429, headers: { "retry-after": "2" } }), pinned);
    let started = Date.now();
    await pinFile(BYTES, "picture.jpg", "image/jpeg", { log: { warn: vi.fn() } });
    const honoured = Date.now() - started;

    recording(() => new Response("slow down", { status: 503, headers: { "retry-after": "10" } }), pinned);
    started = Date.now();
    await pinFile(BYTES, "picture.jpg", "image/jpeg", { log: { warn: vi.fn() } });
    const capped = Date.now() - started;

    expect(honoured).toBeGreaterThanOrEqual(1_950);
    expect(honoured).toBeLessThan(2_900);
    expect(capped).toBeGreaterThanOrEqual(950);
    expect(capped).toBeLessThan(1_900);
  }, 15_000);

  it("counts a retry Pinata answers with the file it already holds under the same content id as the success", async () => {
    recording(
      () => new Response("stored, then the gateway fell over", { status: 502 }),
      () => json({ data: { cid: right, size: BYTES.length, network: "public", is_duplicate: true } }),
    );

    const outcome = await pinFile(BYTES, "picture.jpg", "image/jpeg", { log: { warn: vi.fn() } });

    expect(outcome.cid).toBe(right);
    expect(sent).toHaveLength(2);
    // The retry sends the very bytes the first try did, so it can only ever name the one content id.
    const [first, second] = await Promise.all(
      sent.map(async (call) => Buffer.from(await (call.form?.get("file") as File).arrayBuffer())),
    );
    expect(first?.equals(BYTES)).toBe(true);
    expect(second?.equals(BYTES)).toBe(true);
  }, 10_000);

  it("keeps the whole pin, waits and tries included, inside the deadline", async () => {
    // A wait that would end past the deadline is not taken: the 3 s wait after the second 503
    // does not fit in 3.5 s, so the pin fails at about 1 s rather than trying a third time.
    recording(() => new Response("down", { status: 503 }), () => new Response("down", { status: 503 }));
    let started = Date.now();
    await expect(pinFile(BYTES, "picture.jpg", "image/jpeg", { timeoutMs: 3_500, log: { warn: vi.fn() } })).rejects.toThrow(
      /503/,
    );
    expect(sent).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(1_900);

    // A retry that stalls is cut off at the one deadline, not given a full timeout of its own.
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      seen.push(signal);
      return seen.length === 1 ? new Response("down", { status: 503 }) : await stall(signal);
    });
    started = Date.now();
    await expect(pinFile(BYTES, "picture.jpg", "image/jpeg", { timeoutMs: 2_500, log: { warn: vi.fn() } })).rejects.toThrow(
      /abort|timeout|timed out/i,
    );
    const elapsed = Date.now() - started;
    seen.length = 0;

    expect(elapsed).toBeGreaterThanOrEqual(2_400);
    expect(elapsed).toBeLessThan(2_800);
  }, 15_000);
});

describe("V11: a public pin is the bytes sent, on the public network", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("computes the content id Pinata gave a real 368 KB picture, and a one-block file's", () => {
    const hero = readFileSync(path.join(import.meta.dirname, "fixtures", "pinned-hero.jpg"));
    expect(`0x${createHash("sha256").update(hero).digest("hex")}`).toBe(
      "0xb328bab5adc8751cd06fc6164480941d6186a5089f2f4b8182cca625a4413c7c",
    );
    expect(contentIdOf(hero)).toBe("bafybeidig23ixqssin5577gzqshz5xmpkxjr2pfpwtprizwfolgohm5dv4");
    expect(contentIdOf(BYTES)).toMatch(/^bafkrei[a-z2-7]{52}$/);
    expect(contentIdOf(BYTES)).not.toBe(contentIdOf(Buffer.concat([BYTES, Buffer.from(" ")])));
  });

  it("accepts the answer whose content id and network match, and refuses one that differs in either", async () => {
    const right = contentIdOf(BYTES);
    const answers: Array<[string, Record<string, unknown>, boolean]> = [
      ["the bytes' own content id, public", { cid: right, network: "public" }, true],
      ["another file's content id", { cid: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku", network: "public" }, false],
      ["the private network's duplicate", { cid: right, network: "private" }, false],
      ["no network field", { cid: right }, false],
    ];
    for (const [label, data, accepted] of answers) {
      vi.stubGlobal("fetch", async () => json({ data: { size: BYTES.length, ...data } }));
      const outcome = await pinFile(BYTES, "picture.jpg", "image/jpeg").catch((error: unknown) => error);
      if (accepted) {
        expect(outcome, label).toEqual({ cid: right, uri: `ipfs://${right}`, size: BYTES.length });
      } else {
        expect(outcome, label).toBeInstanceOf(PinNotConfirmed);
      }
      vi.unstubAllGlobals();
    }
  });
});

describe("the private network calls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sent.length = 0;
  });

  // B15: every Pinata call this order adds is bounded at ten seconds.
  it("B15: gives each of the four private calls a 10 second timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    recording(
      () => privateAnswer(),
      () => json({ data: { files: [], next_page_token: "" } }),
      () => json({ data: null }),
      () => json({ data: SIGNED }),
    );

    await pinPrivateFile(BYTES, NAME, { passportId: `0x${"ab".repeat(32)}` });
    await findPrivateByName(NAME);
    await deletePrivateFile(FILE_ID);
    await privateDownloadLink(CID, 30);

    expect(PRIVATE_CALL_TIMEOUT_MS).toBe(10_000);
    expect(timeout.mock.calls).toEqual([[10_000], [10_000], [10_000], [10_000]]);
  });

  it("uploads to the private network under the exact name, with the passport id as a key-value", async () => {
    recording(() => privateAnswer());
    const passportId = `0x${"ab".repeat(32)}`;

    const file = await pinPrivateFile(BYTES, NAME, { passportId });

    expect(file).toEqual({ id: FILE_ID, name: NAME, cid: CID, network: "private", heldBefore: false });
    const call = sent[0] as Sent;
    expect(call.url).toBe("https://uploads.pinata.cloud/v3/files");
    expect(call.method).toBe("POST");
    expect(call.authorization).toBe("Bearer test-token-not-a-real-pinata-jwt");
    expect(call.form?.get("network")).toBe("private");
    expect(call.form?.get("name")).toBe(NAME);
    expect(JSON.parse(String(call.form?.get("keyvalues")))).toEqual({ passportId });
    const uploaded = call.form?.get("file") as File;
    expect(uploaded.name).toBe(NAME);
    expect(Buffer.from(await uploaded.arrayBuffer()).equals(BYTES)).toBe(true);
  });

  // B16: the private copy is private or it does not exist.
  it("B16: refuses the de-duplicated public answer, a missing network and a different name, naming the file id", async () => {
    for (const [label, answer] of [
      ["the duplicate public file", { network: "public", is_duplicate: true }],
      ["no network field", { network: undefined }],
      ["another name", { name: "sealed-thumb-0xother.jpg" }],
    ] as const) {
      recording(() => privateAnswer(answer));
      const refusal = await pinPrivateFile(BYTES, NAME, { passportId: "0x1" }).catch((error: unknown) => error);

      expect(refusal, label).toBeInstanceOf(PrivateCopyNotPrivate);
      expect((refusal as InstanceType<typeof PrivateCopyNotPrivate>).fileId, label).toBe(FILE_ID);
      vi.unstubAllGlobals();
    }
  });

  it("V67: says the file was held before when Pinata flags a duplicate or leaves the flag out", async () => {
    for (const [label, answer, held] of [
      ["a duplicate", { is_duplicate: true }, true],
      ["no flag", { is_duplicate: undefined }, true],
      ["a null flag", { is_duplicate: null }, true],
      ["a new file", { is_duplicate: false }, false],
    ] as const) {
      recording(() => privateAnswer(answer));

      const file = await pinPrivateFile(BYTES, NAME, { passportId: "0x1" });

      expect(file.heldBefore, label).toBe(held);
      vi.unstubAllGlobals();
    }
  });

  it("names only the status when Pinata refuses a private upload, and never retries it", async () => {
    recording(() => new Response("plan does not include private files, request echoed: Bearer secret", { status: 403 }));

    const refusal = (await pinPrivateFile(BYTES, NAME, {}).catch((error: unknown) => error)) as Error;

    expect(refusal.message).toContain("403");
    expect(refusal.message).not.toContain("Bearer");
    expect(sent).toHaveLength(1);
  });

  // B3: lookups match the whole name.
  it("B3: keeps only rows whose name is exactly the one asked for, across pages", async () => {
    recording(
      () =>
        json({
          data: {
            files: [
              { id: "a1", name: NAME, cid: CID, created_at: "2026-09-23T10:00:00Z" },
              { id: "a2", name: `${NAME}.bak`, cid: CID },
              { id: "a3", name: null, cid: CID },
            ],
            next_page_token: "page-two",
          },
        }),
      () => json({ data: { files: [{ id: "b1", name: NAME, cid: "pending" }, { id: "b2", name: NAME.slice(0, -5), cid: CID }], next_page_token: "page-three" } }),
      () => json({ data: { files: [], next_page_token: "page-four" } }),
    );

    const found = await findPrivateByName(NAME);

    expect(found.map((row) => row.id)).toEqual(["a1", "b1"]);
    expect(sent).toHaveLength(3);
    const first = new URL((sent[0] as Sent).url);
    expect(`${first.origin}${first.pathname}`).toBe("https://api.pinata.cloud/v3/files/private");
    expect(first.searchParams.get("name")).toBe(NAME);
    expect(first.searchParams.get("pageToken")).toBeNull();
    expect(new URL((sent[1] as Sent).url).searchParams.get("pageToken")).toBe("page-two");
  });

  it("B3: answers an empty list only when Pinata said the listing ended", async () => {
    recording(() => json({ data: { files: [{ id: "x", name: "sealed-thumb-0x1.jpg", cid: CID }], next_page_token: "" } }));

    expect(await findPrivateByName(NAME)).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("B3: throws, never answers none, on an error status, an unknown shape, or pages that do not end", async () => {
    recording(() => new Response("down", { status: 500 }));
    await expect(findPrivateByName(NAME)).rejects.toThrow(/500.*cannot tell/);
    vi.unstubAllGlobals();

    recording(() => json({ data: { rows: [] } }));
    await expect(findPrivateByName(NAME)).rejects.toThrow(/shape.*cannot tell/);
    vi.unstubAllGlobals();

    recording(() => json({ files: [] }));
    await expect(findPrivateByName(NAME)).rejects.toThrow(/cannot tell/);
    vi.unstubAllGlobals();

    sent.length = 0;
    const endless = Array.from(
      { length: PRIVATE_LIST_MAX_PAGES },
      (_, page) => () => json({ data: { files: [{ id: `p${page}`, name: "other.jpg", cid: CID }], next_page_token: `t${page}` } }),
    );
    recording(...endless);
    await expect(findPrivateByName(NAME)).rejects.toThrow(/ran past 5 pages/);
    expect(sent).toHaveLength(PRIVATE_LIST_MAX_PAGES);
  });

  it("deletes one private file by id and treats any non-2xx as a failure", async () => {
    recording(() => json({ data: null }));
    await deletePrivateFile(FILE_ID);
    expect(sent[0]).toMatchObject({ url: `https://api.pinata.cloud/v3/files/private/${FILE_ID}`, method: "DELETE" });

    recording(() => new Response("not found", { status: 404 }));
    await expect(deletePrivateFile(FILE_ID)).rejects.toThrow(/404/);

    sent.length = 0;
    await expect(deletePrivateFile("../public/some-id")).rejects.toThrow(/not a Pinata file id/);
    expect(sent).toHaveLength(0);
  });

  it("mints a read link on the proven path for the dedicated gateway, with the caller's expiry", async () => {
    recording(() => json({ data: SIGNED }));

    const link = await privateDownloadLink(CID, 30);

    expect(link).toBe(new URL(SIGNED).toString());
    const call = sent[0] as Sent;
    expect(call.url).toBe("https://api.pinata.cloud/v3/files/private/download_link");
    expect(call.method).toBe("POST");
    expect(call.json).toMatchObject({
      url: `https://moolam-test.mypinata.cloud/files/${CID}`,
      expires: 30,
      method: "GET",
    });
    expect(Math.abs((call.json?.date as number) - Date.now() / 1000)).toBeLessThan(5);
  });

  it("refuses a link for another host, file or form, and never prints the link it refused", async () => {
    for (const bad of [
      `https://evil.example/files/${CID}?X-Signature=abc`,
      `http://moolam-test.mypinata.cloud/files/${CID}?X-Signature=abc`,
      `https://moolam-test.mypinata.cloud/files/bafkreiother0000000000000000000000?X-Signature=abc`,
      `https://moolam-test.mypinata.cloud/files/${CID}`,
      "not a url at all",
    ]) {
      recording(() => json({ data: bad }));
      const refusal = (await privateDownloadLink(CID, 30).catch((error: unknown) => error)) as Error;
      expect(refusal, bad).toBeInstanceOf(Error);
      expect(refusal.message, bad).not.toContain(bad);
      expect(refusal.message, bad).not.toContain("X-Signature");
      vi.unstubAllGlobals();
    }

    recording(() => new Response(`echo ${SIGNED}`, { status: 500 }));
    const failed = (await privateDownloadLink(CID, 30).catch((error: unknown) => error)) as Error;
    expect(failed.message).toContain("500");
    expect(failed.message).not.toContain("X-Signature");
  });

  it("refuses an expiry outside 1 to 300 seconds and a content id that is not one, before any call", async () => {
    recording();
    for (const expires of [0, -1, 301, 1.5, Number.NaN]) {
      await expect(privateDownloadLink(CID, expires), String(expires)).rejects.toThrow(/between 1 and 300/);
    }
    for (const cid of ["pending", "", "../../v3/keys", `${CID}?x=1`]) {
      await expect(privateDownloadLink(cid, 30), cid).rejects.toThrow(/not a content id/);
    }
    expect(sent).toHaveLength(0);
  });

  it("refuses to mint a link through the shared public gateway", async () => {
    vi.resetModules();
    const kept = process.env.PINATA_GATEWAY_URL;
    process.env.PINATA_GATEWAY_URL = "https://gateway.pinata.cloud/ipfs/";
    try {
      const fresh = await import("../src/ipfs/pinata.js");
      recording();
      await expect(fresh.privateDownloadLink(CID, 30)).rejects.toThrow(/mypinata\.cloud/);
      expect(sent).toHaveLength(0);
    } finally {
      process.env.PINATA_GATEWAY_URL = kept;
      vi.resetModules();
    }
  });
});

describe("V20: the three shapes of an empty listing, in both listing parsers", () => {
  const PASSPORT = `0x${"cd".repeat(32)}` as `0x${string}`;
  const shapes = {
    empty: { data: { files: [], next_page_token: "" } },
    nulled: { data: { files: null, next_page_token: "" } },
    missing: { data: { next_page_token: "" } },
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    sent.length = 0;
  });

  it("reads the public unseal lookup's null as none and a missing files key as cannot tell", async () => {
    const { findUnsealRecord } = await import("../src/unseal.js");
    const answerWith = (body: unknown) => ({ fetchImpl: (async () => json(body)) as unknown as typeof fetch });

    expect(await findUnsealRecord(PASSPORT, answerWith(shapes.empty))).toEqual({ state: "none" });
    expect(await findUnsealRecord(PASSPORT, answerWith(shapes.nulled))).toEqual({ state: "none" });
    expect(await findUnsealRecord(PASSPORT, answerWith(shapes.missing))).toMatchObject({ state: "unavailable" });
  }, 30_000);

  it("reads the private listings' null as an empty list and a missing files key as cannot tell", async () => {
    const { listPrivatePage } = await import("../src/ipfs/pinata.js");
    for (const shape of ["empty", "nulled"] as const) {
      recording(() => json(shapes[shape]), () => json(shapes[shape]));
      expect(await findPrivateByName(NAME), shape).toEqual([]);
      expect(await listPrivatePage(undefined, 1), shape).toEqual({ files: [], next: undefined });
      vi.unstubAllGlobals();
    }

    recording(() => json(shapes.missing), () => json(shapes.missing));
    await expect(findPrivateByName(NAME)).rejects.toThrow(/cannot tell/);
    await expect(listPrivatePage(undefined, 1)).rejects.toThrow(/cannot tell/);
  });
});
