// Holds the sealed workflow's pure rules, packages/workflow/moolam-sealed-verifier/private-copy.ts,
// to the verify service's predicate, the shared fixture set and the refusal rules of the threat
// model (B5, B6, B7, D7, D8). Does NOT cover the HTTP calls themselves, the enclave, the decoder or
// the chain: those run only inside the simulator, and the work order's dry run is their proof.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { privatelyRecheckable as runnerPredicate } from "../src/document.js";
import { parseSimulation } from "../src/simulate.js";

type LinkAnswer = { kind: "link"; url: string } | { kind: "refused"; reason: string };

interface PrivateCopyModule {
  MAX_PRIVATE_FILE_BYTES: number;
  privatelyRecheckable: (document: unknown) => boolean;
  metadataFetchUrl: (gateway: string, metadataURI: string) => string | null;
  acceptedLink: (link: unknown, host: string) => string | null;
  readLinkAnswer: (status: number, body: string, host: string, passportId: string) => LinkAnswer;
  privateFileRefusal: (status: number, length: number, passportId: string) => string | null;
  verdictLine: (recomputed: string, distance: number, matched: boolean) => string;
  reportLine: (txHash: string) => string;
  FETCH_TRIES: number;
  firstAnswer: <T>(tries: number, call: () => T) => T;
  refusal: Record<string, (...args: never[]) => string>;
}

// Loaded by path, as workflow-picture.test.ts loads picture.ts: the workflow folder is its own
// project outside this one's rootDir, so this project's compiler must not follow it.
const WORKFLOW_FILE = path.resolve(import.meta.dirname, "../../workflow/moolam-sealed-verifier/private-copy.ts");
const SERVICE_FILE = path.resolve(import.meta.dirname, "../../verifier/src/sealed.ts");
const FIXTURES = path.resolve(import.meta.dirname, "../../verifier/test/fixtures/sealed-documents.json");
const RUNNER_DOCUMENT_FILE = path.resolve(import.meta.dirname, "../src/document.ts");

let copy: PrivateCopyModule;

beforeAll(async () => {
  copy = (await import(pathToFileURL(WORKFLOW_FILE).href)) as PrivateCopyModule;
});

const HOST = "lavender-personal-grasshopper-978.mypinata.cloud";
const GATEWAY = "https://lavender-personal-grasshopper-978.mypinata.cloud/ipfs/";
const PASSPORT = "0x980549624f85e4ef47043383c5a746cbdd1d82797b5b5583e1f5aeb3841d010c";
const TOKEN = "sealed-link-token-4f1b9c0e77d2a6";
const SERVICE_URL = "https://verifier-production-d76f.up.railway.app";
const LINK = `https://${HOST}/files/bafkreigwx2nxhx7uotk6kzevdjwkakowu4al6rt6tetra447xoxpdmcpri?X-Algorithm=PINATA1&X-Date=1790000000&X-Expires=120&X-Method=GET&X-Signature=9c1f0a`;

const fixtures = JSON.parse(fs.readFileSync(FIXTURES, "utf8")) as {
  cases: { name: string; recheckable: boolean; document: unknown }[];
};

/** The predicate's own text, from its signature to the closing brace at the start of a line. */
function predicateText(file: string): string {
  const source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("export function privatelyRecheckable(");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

describe("the sealed workflow's predicate (B7)", () => {
  it.each(fixtures.cases.map((one) => [one.name, one] as const))(
    "agrees with the shared fixture: %s",
    (_name, one) => {
      expect(copy.privatelyRecheckable(one.document)).toBe(one.recheckable);
    },
  );

  it.each(fixtures.cases.map((one) => [one.name, one] as const))(
    "agrees in the runner too: %s",
    (_name, one) => {
      expect(runnerPredicate(one.document)).toBe(one.recheckable);
    },
  );

  it("is the service's predicate byte for byte, in the workflow and in the runner", () => {
    const service = predicateText(SERVICE_FILE);
    expect(predicateText(WORKFLOW_FILE)).toBe(service);
    expect(predicateText(RUNNER_DOCUMENT_FILE)).toBe(service);
  });
});

describe("the metadata address (B6, D8)", () => {
  it("reads an ipfs:// document through the configured gateway", () => {
    expect(copy.metadataFetchUrl(GATEWAY, "ipfs://bafkreimetadata")).toBe(`${GATEWAY}bafkreimetadata`);
    expect(copy.metadataFetchUrl(GATEWAY.slice(0, -1), "ipfs://bafkreimetadata")).toBe(`${GATEWAY}bafkreimetadata`);
  });

  it("refuses an http(s) metadata address, a data URI and anything else a creator could write", () => {
    for (const uri of [
      "https://evil.example/metadata.json",
      "http://169.254.169.254/latest/meta-data",
      `data:application/json,${encodeURIComponent('{"sealed":true,"privateRecheck":true}')}`,
      "ipfs://bafkreimetadata/../../x",
      "ipfs://bafkreimetadata?x=1",
      "ipfs://bafkreimetadata@evil.example",
      "ipfs://",
      "IPFS://bafkreimetadata",
      "bafkreimetadata",
      "",
    ]) {
      expect(copy.metadataFetchUrl(GATEWAY, uri)).toBeNull();
    }
  });
});

describe("the link host check (B6)", () => {
  it("accepts the signed link Pinata writes, and Node's own URL parser reads the same host", () => {
    expect(copy.acceptedLink(LINK, HOST)).toBe(LINK);
    const parsed = new URL(LINK);
    expect(parsed.protocol).toBe("https:");
    expect(parsed.hostname).toBe(HOST);
    expect(parsed.port).toBe("");
    expect(parsed.username).toBe("");
  });

  const refused: [string, unknown][] = [
    ["plain http", LINK.replace("https://", "http://")],
    ["another host", "https://evil.example/files/bafy?X-Signature=1"],
    ["the host as a prefix of another", `https://${HOST}.evil.example/files/bafy`],
    ["the host as a path on another", `https://evil.example/${HOST}/files/bafy`],
    ["the host as a user name", `https://${HOST}@evil.example/files/bafy`],
    ["a user name in front of the host", `https://someone@${HOST}/files/bafy`],
    ["a port", `https://${HOST}:8443/files/bafy`],
    ["upper case letters", `https://${HOST.toUpperCase()}/files/bafy`],
    ["an upper case scheme", `HTTPS://${HOST}/files/bafy`],
    ["a trailing dot", `https://${HOST}./files/bafy`],
    ["a backslash", `https://${HOST}\\@evil.example/files/bafy`],
    ["a space", `https://${HOST}/files/ bafy`],
    ["a tab", `https://${HOST}\t/files/bafy`],
    ["a letter outside ASCII", `https://${HOST.replace("a", "а")}/files/bafy`],
    ["a percent sign in the host", `https://${HOST.replace(".", "%2e")}/files/bafy`],
    ["a fragment", `https://${HOST}/files/bafy#x`],
    ["no path at all", `https://${HOST}`],
    ["a query straight after the host", `https://${HOST}?X-Signature=1`],
    ["one slash", `https:/${HOST}/files/bafy`],
    ["a relative path", "/files/bafy"],
    ["not a string", { url: LINK }],
    ["too long", `https://${HOST}/${"a".repeat(2_100)}`],
  ];

  it.each(refused)("refuses %s", (_name, link) => {
    expect(copy.acceptedLink(link, HOST)).toBeNull();
  });

  it("never accepts a link Node's own parser would send to a different host", () => {
    for (const [, link] of refused) {
      const accepted = copy.acceptedLink(link, HOST);
      if (accepted !== null) {
        expect(new URL(accepted).hostname).toBe(HOST);
      }
    }
  });

  it("refuses every link when the configured host is not a plain lower case host name", () => {
    for (const host of ["", "localhost", `${HOST}:443`, HOST.toUpperCase(), `${HOST}.`]) {
      expect(copy.acceptedLink(LINK, host)).toBeNull();
    }
  });

  it("reads the service's answer and opens only a link on the private gateway", () => {
    const body = JSON.stringify({ url: LINK, expiresAt: "2026-09-24T10:02:00.000Z" });
    expect(copy.readLinkAnswer(200, body, HOST, PASSPORT)).toEqual({ kind: "link", url: LINK });

    const offHost = copy.readLinkAnswer(200, JSON.stringify({ url: "https://evil.example/x" }), HOST, PASSPORT);
    expect(offHost.kind).toBe("refused");
  });

  it("refuses any status but 200 and any body without a url, naming the status and not the body", () => {
    for (const [status, body] of [
      [401, '{"error":"unauthorized"}'],
      [403, `{"error":"not-claimed","url":"${LINK}"}`],
      [404, '{"error":"gone"}'],
      [409, '{"error":"ambiguous"}'],
      [503, ""],
      [200, "<html>not json</html>"],
      [200, "[]"],
      [200, '{"link":"https://x"}'],
    ] as const) {
      const answer = copy.readLinkAnswer(status, body, HOST, PASSPORT);
      expect(answer.kind).toBe("refused");
      const reason = answer.kind === "refused" ? answer.reason : "";
      expect(reason).toContain(PASSPORT);
      expect(reason).toContain(`status ${status}`);
      expect(reason).not.toMatch(/:\/\//);
    }
  });
});

describe("the private file's size cap (B6, D7)", () => {
  it("lets a file up to 60,000 bytes through to the decoder", () => {
    expect(copy.MAX_PRIVATE_FILE_BYTES).toBe(60_000);
    expect(copy.privateFileRefusal(200, 36_589, PASSPORT)).toBeNull();
    expect(copy.privateFileRefusal(200, 60_000, PASSPORT)).toBeNull();
  });

  it("refuses a body over the cap before decode, an empty body and any status but 200", () => {
    expect(copy.privateFileRefusal(200, 60_001, PASSPORT)).toContain("over the 60000 byte cap");
    expect(copy.privateFileRefusal(200, 0, PASSPORT)).toContain("no bytes");
    expect(copy.privateFileRefusal(403, 120, PASSPORT)).toContain("status 403");
    expect(copy.privateFileRefusal(404, 0, PASSPORT)).toContain("status 404");
  });
});

describe("the error lines (B5, D7)", () => {
  it("name the passport and never a URL, a host or the token", () => {
    const lines = Object.entries(copy.refusal).map(([name, make]) => {
      const call = make as (...args: unknown[]) => string;
      return name === "noAnswer" ? call("the private link request", PASSPORT) : call(PASSPORT, 403);
    });
    expect(lines).toHaveLength(14);
    for (const line of lines) {
      expect(line).toContain(PASSPORT);
      for (const leaked of ["://", HOST, "mypinata", "railway", SERVICE_URL, TOKEN, "X-Signature", "X-Algorithm", "download_link"]) {
        expect(line).not.toContain(leaked);
      }
    }
  });

  it("print the verdict and the report in the shape the runner's parser reads", () => {
    const output = [
      `[USER LOG] ${copy.verdictLine("0x1f1bc103fbef6f47", 2, true)}`,
      `[USER LOG] ${copy.reportLine(`0x${"0".repeat(64)}`)}`,
    ].join("\n");
    const parsed = parseSimulation(output);
    expect(parsed).toMatchObject({ reportTx: null, recomputed: "0x1f1bc103fbef6f47", distance: 2, matched: true });
    expect(parseSimulation(copy.reportLine(`0x${"ab".repeat(32)}`)).reportTx).toBe(`0x${"ab".repeat(32)}`);
  });
});

describe("a fetch that does not answer is tried again, a bounded number of times", () => {
  it("tries three times, because the first fetch through a fresh private link can outlast the ten second ceiling", () => {
    expect(copy.FETCH_TRIES).toBe(3);
  });

  it("returns the first answer and makes no further call", () => {
    let calls = 0;
    expect(copy.firstAnswer(3, () => ++calls)).toBe(1);
    expect(calls).toBe(1);
  });

  it("tries again after a call that throws, and returns the answer that follows", () => {
    let calls = 0;
    const answer = copy.firstAnswer(3, () => {
      calls++;
      if (calls < 3) throw new Error("timed out");
      return { statusCode: 200 };
    });
    expect(answer).toEqual({ statusCode: 200 });
    expect(calls).toBe(3);
  });

  it("gives up after the last try and throws what the last try threw", () => {
    let calls = 0;
    expect(() =>
      copy.firstAnswer(3, () => {
        calls++;
        throw new Error(`miss ${calls}`);
      }),
    ).toThrow("miss 3");
    expect(calls).toBe(3);
  });

  it("never retries an answer the server gave, a refusal included", () => {
    let calls = 0;
    expect(copy.firstAnswer(3, () => ({ statusCode: 404, call: ++calls }))).toEqual({ statusCode: 404, call: 1 });
    expect(calls).toBe(1);
  });
});
