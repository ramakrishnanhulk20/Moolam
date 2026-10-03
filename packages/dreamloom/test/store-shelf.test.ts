// What this file does not cover: the register and move calls that put a picture into the states it
// tests here, which server-routes.test.ts drives through the routes, or two processes sharing one
// data folder. Pictures are seeded as records on the volume, since filling a shelf of 500 through
// 500 weaves proves nothing more about the eviction rule and takes minutes.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openai = vi.hoisted(() => ({ generate: vi.fn() }));

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  class StandIn {
    images = { generate: openai.generate };
  }
  return { ...actual, default: StandIn };
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const OWNER = "ab".repeat(32);
const PASSPORT = `0x${"a1".repeat(32)}`;
const TX = `0x${"b2".repeat(32)}`;
const START = Date.parse("2026-10-01T00:00:00Z");

let dataDir: string;

function settings(): void {
  const values: Record<string, string> = {
    DREAMLOOM_ORIGIN: "http://localhost:3300",
    OPENAI_API_KEY: "sk-test",
    DATA_DIR: dataDir,
    WEAVES_PER_ADDRESS_PER_DAY: "",
    WEAVES_PER_DAY: "",
  };
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

async function boot() {
  vi.resetModules();
  return { store: await import("@/lib/server/store"), weave: await import("@/app/api/weave/route") };
}

/** A record as the volume holds it, written the way writeRecord does, for the nth oldest picture. */
function seed(n: number, fields: Partial<import("@/lib/server/store").PictureRecord> = {}): string {
  const id = n.toString(16).padStart(32, "0");
  const record = {
    version: 1,
    id,
    sessionHash: OWNER,
    prompt: "a lighthouse seeded for the shelf",
    createdAt: new Date(START + n * 1000).toISOString(),
    contentType: "image/png",
    state: "woven",
    ...fields,
  };
  writeFileSync(path.join(dataDir, "pictures", `${id}.json`), `${JSON.stringify(record)}\n`);
  return id;
}

const held = { state: "registered", mode: "platform", passportId: PASSPORT, registerTx: TX } as const;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "dreamloom-shelf-"));
  mkdirSync(path.join(dataDir, "pictures"), { recursive: true });
  settings();
  openai.generate.mockResolvedValue({ data: [{ b64_json: PNG.toString("base64") }] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("WO-317: the shelf of pictures", () => {
  it("never evicts a picture whose passport waits in Dreamloom's wallet, and it can still be moved", async () => {
    const { store } = await boot();
    // The oldest picture is the one held for a visitor, so the old rule removed it first.
    const waiting = seed(0, held);
    const mid = seed(1, { state: "woven", busy: "register", busyAt: new Date(START).toISOString() });
    for (let n = 2; n < store.MAX_PICTURES; n += 1) seed(n);
    expect(store.listPictures()).toHaveLength(store.MAX_PICTURES);

    for (let weaves = 0; weaves < 3; weaves += 1) store.createPicture({ sessionHash: OWNER, prompt: "one more lighthouse", bytes: PNG });

    expect(store.listPictures()).toHaveLength(store.MAX_PICTURES);
    expect(store.readPicture(waiting)?.state).toBe("registered");
    expect(store.readPicture(mid)?.busy).toBe("register");
    // The ones that went are the oldest of the rest.
    expect([2, 3, 4].map((n) => store.readPicture(n.toString(16).padStart(32, "0")))).toEqual([null, null, null]);
    expect(store.readPicture((5).toString(16).padStart(32, "0"))).not.toBeNull();

    const moved = store.advancePicture(waiting, "moved", { moveTx: TX, movedTo: `0x${"12".repeat(20)}` });
    expect(moved?.state).toBe("moved");
  }, 60_000);

  it("lets a moved picture go once it is the oldest, since nothing is held for anyone", async () => {
    const { store } = await boot();
    const done = seed(0, { ...held, state: "moved", moveTx: TX, movedTo: `0x${"12".repeat(20)}` });
    for (let n = 1; n < store.MAX_PICTURES; n += 1) seed(n);

    store.createPicture({ sessionHash: OWNER, prompt: "one more lighthouse", bytes: PNG });

    expect(store.readPicture(done)).toBeNull();
    expect(store.listPictures()).toHaveLength(store.MAX_PICTURES);
  }, 60_000);

  it("refuses a weave when every picture on the shelf is held, and writes and removes nothing", async () => {
    const { store } = await boot();
    for (let n = 0; n < store.MAX_PICTURES; n += 1) seed(n, held);
    const before = readdirSync(path.join(dataDir, "pictures")).sort();

    expect(() => store.createPicture({ sessionHash: OWNER, prompt: "no room", bytes: PNG })).toThrow(store.ShelfFull);

    expect(readdirSync(path.join(dataDir, "pictures")).sort()).toEqual(before);
    expect(store.roomForAnotherPicture()).toBe(false);
  }, 60_000);

  it("answers POST /api/weave with 503 busy, never a 500, before the image model is called or the weave count moves, when there is no room", async () => {
    const { store, weave } = await boot();
    for (let n = 0; n < store.MAX_PICTURES; n += 1) seed(n, held);
    const before = readdirSync(path.join(dataDir, "pictures")).sort();

    const response = await weave.POST(
      new Request("http://localhost:3300/api/weave", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3300" },
        body: JSON.stringify({ prompt: "a lighthouse with no shelf to stand on" }),
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "busy" });
    expect(openai.generate).not.toHaveBeenCalled();
    // The counters file is written by the first count taken, so its absence is a weave count that never moved.
    expect(existsSync(path.join(dataDir, "counters.json"))).toBe(false);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(readdirSync(path.join(dataDir, "pictures")).sort()).toEqual(before);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("dreamloom: weave: the shelf is full");
  }, 60_000);

  it("still draws and counts a weave when one picture on the shelf can go", async () => {
    const { store, weave } = await boot();
    for (let n = 0; n < store.MAX_PICTURES - 1; n += 1) seed(n, held);
    seed(store.MAX_PICTURES - 1);

    const response = await weave.POST(
      new Request("http://localhost:3300/api/weave", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3300" },
        body: JSON.stringify({ prompt: "a lighthouse with one place left" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(openai.generate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(path.join(dataDir, "counters.json"), "utf8")).weave).toBe(1);
  }, 60_000);
});
