// The runner's reads for a sealed passport: GET /sealed/status and the env file's token, by name.
// Does NOT cover the verify service's own answers (packages/verifier tests them) or what the CRE
// CLI does with the env file; the dry pass quoted in the README covers the CLI.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { envFileValue, readSealedStatus, serviceHost } from "../src/sealed.js";

const SERVICE = "https://verify.example";
const PASSPORT = `0x${"9".repeat(62)}AB`;
const LOWER = PASSPORT.toLowerCase();

function service(status: number, body: unknown): { fetcher: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetcher = (async (url: string) => {
    urls.push(url);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetcher, urls };
}

describe("the private copy's status", () => {
  it("reads kept and gone from the service, asking with the lower case id", async () => {
    const kept = service(200, { passportId: LOWER, state: "kept", privateRecheck: true });
    expect(await readSealedStatus(SERVICE, PASSPORT, kept.fetcher)).toBe("kept");
    expect(kept.urls).toEqual([`${SERVICE}/sealed/status/${LOWER}`]);

    const gone = service(200, { passportId: LOWER, state: "gone", privateRecheck: true });
    expect(await readSealedStatus(SERVICE, PASSPORT, gone.fetcher)).toBe("gone");
  });

  it("says unknown, never kept or gone, for the service's unknown, a failure, or an answer it cannot trust", async () => {
    for (const [status, body] of [
      [200, { passportId: LOWER, state: "unknown", privateRecheck: true }],
      [200, { passportId: LOWER, state: "maybe" }],
      [200, { passportId: `0x${"1".repeat(64)}`, state: "kept" }],
      [200, { state: "kept" }],
      [200, "<html>not json</html>"],
      [200, [{ passportId: LOWER, state: "kept" }]],
      [429, { error: "slow down" }],
      [500, ""],
      [503, { passportId: LOWER, state: "kept" }],
    ] as const) {
      expect(await readSealedStatus(SERVICE, PASSPORT, service(status, body).fetcher)).toBe("unknown");
    }
  });

  it("says unknown when the service does not answer, and never asks about something that is not an id", async () => {
    const down = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    expect(await readSealedStatus(SERVICE, PASSPORT, down)).toBe("unknown");

    const { fetcher, urls } = service(200, { passportId: LOWER, state: "kept" });
    expect(await readSealedStatus(SERVICE, "../recheck/queue", fetcher)).toBe("unknown");
    expect(urls).toHaveLength(0);
  });
});

describe("the sealed link token in the env file", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "moolam-runner-env-"));
  const file = (name: string, text: string): string => {
    const where = path.join(folder, name);
    fs.writeFileSync(where, text, "utf8");
    return where;
  };

  afterAll(() => {
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it("finds the value by its name, in the forms a dotenv file writes", () => {
    expect(envFileValue(file("plain.env", "CRE_ETH_PRIVATE_KEY=0xabc\nCRE_SEALED_LINK_TOKEN=tok-1\n"), "CRE_SEALED_LINK_TOKEN")).toBe("tok-1");
    expect(envFileValue(file("quoted.env", 'CRE_SEALED_LINK_TOKEN="tok 2"\r\n'), "CRE_SEALED_LINK_TOKEN")).toBe("tok 2");
    expect(envFileValue(file("export.env", "export CRE_SEALED_LINK_TOKEN='tok-3'\n"), "CRE_SEALED_LINK_TOKEN")).toBe("tok-3");
  });

  it("says null when the name is missing, empty, commented out or only a prefix of another name", () => {
    for (const [name, text] of [
      ["missing.env", "CRE_ETH_PRIVATE_KEY=0xabc\n"],
      ["empty.env", "CRE_SEALED_LINK_TOKEN=\n"],
      ["blank.env", 'CRE_SEALED_LINK_TOKEN=""\n'],
      ["comment.env", "# CRE_SEALED_LINK_TOKEN=tok\n"],
      ["longer.env", "CRE_SEALED_LINK_TOKEN_OLD=tok\n"],
    ] as const) {
      expect(envFileValue(file(name, text), "CRE_SEALED_LINK_TOKEN")).toBeNull();
    }
  });

  it("says null for a file it cannot read", () => {
    expect(envFileValue(path.join(folder, "no-such.env"), "CRE_SEALED_LINK_TOKEN")).toBeNull();
  });

  it("knows the verify service's host so a reason can be stripped of it", () => {
    expect(serviceHost("https://verifier-production-d76f.up.railway.app")).toBe("verifier-production-d76f.up.railway.app");
    expect(serviceHost("not an address")).toBeNull();
  });
});
