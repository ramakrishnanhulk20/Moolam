// Covers the kit's refusals that need no chain: the rpId rule for a platform's server passkey (P20),
// the terms rule shared with MoolamConsent and the verify service (P9, P24), and how the platform key
// travels to the service (P7): only in the Authorization header, never in a URL, a body, an error or
// a redirect, and never over plain http to another host; and every answer is read under 256 KB but
// the platform prepare's, which carries the signed file. The deliverTo option is refused by shape
// before any chain call, never quoting the email (P29), and rides only in the prepare's multipart body.
// Does NOT cover the chain-side refusals of setupPlatform and transferPassport, which fork.test.ts
// runs against the real registry, or what a platform's own code does with the key. The revert
// reason is read from an error made by a different copy of viem, as a platform's own clients throw.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { revertReason } from "../src/chain.js";
import type { PlatformWalletClient } from "../src/chain.js";
import { prepareForm, type DeliverTo } from "../src/prepare.js";
import { registerAsPlatform } from "../src/register.js";
import { termsProblem } from "../src/terms.js";
import { rpIdProblem, ServerPasskey } from "../src/passkey.js";
import { MAX_PREPARE_ANSWER_BYTES, callService, checkedUrl } from "../src/service.js";

const KEY = "0f".repeat(32);

describe("the rpId a platform binds its server key under", () => {
  it("accepts the platform's own hostname", () => {
    expect(rpIdProblem("images.example-platform.com")).toBeNull();
    expect(rpIdProblem("xn--bcher-kva.example")).toBeNull();
  });

  it("refuses Moolam's hostname and every name under it", () => {
    expect(rpIdProblem("moolam.vercel.app")).toMatch(/never Moolam's/);
    expect(rpIdProblem("cosign.moolam.vercel.app")).toMatch(/never Moolam's/);
  });

  it("refuses localhost, IP addresses and single labels", () => {
    for (const bad of ["localhost", "dev.localhost", "127.0.0.1", "[::1]", "intranet"]) {
      expect(rpIdProblem(bad), bad).not.toBeNull();
    }
  });

  it("refuses any spelling the URL parser would rewrite, so the name checked is the name hashed", () => {
    for (const bad of ["Images.Example.com", "example.com:443", "example.com/path", "user@example.com", "example.com.", " example.com", "bücher.example"]) {
      expect(rpIdProblem(bad), bad).not.toBeNull();
    }
  });

  it("keeps the private key out of JSON and console output", () => {
    const passkey = ServerPasskey.fromPrivateKey(ServerPasskey.newPrivateKey(), "images.example-platform.com");
    expect(Object.keys(JSON.parse(JSON.stringify(passkey)))).toEqual(["qx", "qy", "rpId"]);
    expect(() => ServerPasskey.fromPrivateKey(ServerPasskey.newPrivateKey(), "localhost")).toThrow(/localhost/);
  });
});

describe("the AI-use terms", () => {
  it("accepts what MoolamConsent accepts", () => {
    expect(termsProblem({ aiTraining: "notAllowed" })).toBeNull();
    expect(termsProblem({ aiInference: "constrained", constraintInfo: "Ask licensing@example.com" })).toBeNull();
    expect(termsProblem({ dataMining: "constrained", constraintInfo: "x".repeat(256) })).toBeNull();
  });

  it("refuses what MoolamConsent or the service would refuse", () => {
    const refused = [
      { aiInference: "constrained" },
      { aiTraining: "allowed", constraintInfo: "not needed" },
      { dataMining: "constrained", constraintInfo: "x".repeat(257) },
      { dataMining: "constrained", constraintInfo: "café" },
      { dataMining: "constrained", constraintInfo: "line\nbreak" },
      { dataMining: "constrained", constraintInfo: " padded" },
      { aiTraining: "maybe" },
      { aiTrainng: "allowed" },
      {},
    ];
    for (const terms of refused) {
      expect(termsProblem(terms as never), JSON.stringify(terms)).not.toBeNull();
    }
  });
});

describe("the platform key on the wire", () => {
  let server: Server;
  let base: string;
  const seen: { url: string; authorization: string | undefined; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({ url: request.url ?? "", authorization: request.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
        if (request.url === "/moved") {
          response.writeHead(302, { location: `${base}/elsewhere` }).end();
          return;
        }
        if (request.url === "/large") {
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ file: "A".repeat(300 * 1024) }));
          return;
        }
        if (request.url === "/refuse") {
          response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "agent-signature-refused" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("sends the key only in the Authorization header", async () => {
    const quiet = vi.spyOn(console, "log");
    await callService({ verifyUrl: base, platformKey: KEY }, { method: "POST", path: "/ok", what: "a call", body: { a: 1 }, timeoutMs: 5_000 }, z.object({ ok: z.literal(true) }));
    const call = seen.at(-1);
    expect(call?.authorization).toBe(`Bearer ${KEY}`);
    expect(call?.url).not.toContain(KEY);
    expect(call?.body).not.toContain(KEY);
    expect(quiet).not.toHaveBeenCalled();
    quiet.mockRestore();
  });

  it("refuses to follow a redirect, so the header never reaches another address", async () => {
    const before = seen.length;
    await expect(
      callService({ verifyUrl: base, platformKey: KEY }, { method: "GET", path: "/moved", what: "a call", timeoutMs: 5_000 }, z.unknown()),
    ).rejects.toMatchObject({ code: "service-unreachable" });
    expect(seen.slice(before).map((one) => one.url)).toEqual(["/moved"]);
  });

  it("names a refusal by the service's code and never by the key or the URL", async () => {
    const attempt = callService({ verifyUrl: base, platformKey: KEY }, { method: "GET", path: "/refuse", what: "the co-sign status", timeoutMs: 5_000 }, z.unknown());
    await expect(attempt).rejects.toMatchObject({ code: "service-refused", details: { status: 403, error: "agent-signature-refused" } });
    const error = (await attempt.catch((caught: unknown) => caught)) as Error;
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(KEY);
    expect(error.message).not.toContain("/refuse");
  });

  it("reads an answer past 256 KB only where the call names the larger cap the platform prepare uses", async () => {
    const call = { method: "GET" as const, path: "/large", what: "a call", timeoutMs: 5_000 };
    const schema = z.object({ file: z.string() });
    await expect(callService({ verifyUrl: base, platformKey: KEY }, call, schema)).rejects.toMatchObject({ code: "unexpected-answer" });
    const read = await callService({ verifyUrl: base, platformKey: KEY }, { ...call, maxAnswerBytes: MAX_PREPARE_ANSWER_BYTES }, schema);
    expect(read.file).toHaveLength(300 * 1024);
  });

  it("refuses plain http to any host but this machine, and a URL carrying a query", () => {
    expect(() => checkedUrl("http://verify.example.com", "verifyUrl")).toThrow(/https/);
    expect(() => checkedUrl(`https://verify.example.com/?key=${KEY}`, "verifyUrl")).toThrow(/query/);
    expect(checkedUrl("https://verify.example.com", "verifyUrl").host).toBe("verify.example.com");
  });
});

describe("the email a platform-mode passport waits for", () => {
  const EMAIL = "Maker.Person+art@example.com";

  it("is refused by shape before any chain call, and the error never quotes it", async () => {
    // Any chain read would throw on this wallet, so a refusal here proves the check ran first.
    const untouchable = new Proxy({}, { get: () => { throw new Error("the chain was touched"); } }) as PlatformWalletClient;
    const base = { verifyUrl: "https://verify.example.com", platformKey: KEY, agentAccount: {} as never, passkey: {} as never, walletClient: untouchable, title: "A title" };
    const refused: unknown[] = [
      { email: EMAIL, verifiedBy: "phone" },
      { email: EMAIL },
      { email: "   ", verifiedBy: "google" },
      { email: `${"a".repeat(250)}@example.com`, verifiedBy: "google" },
      { email: EMAIL, verifiedBy: "google", wallet: "0x0" },
      [EMAIL],
    ];
    for (const deliverTo of refused) {
      const attempt = registerAsPlatform(new Uint8Array([1]), { ...base, deliverTo: deliverTo as DeliverTo });
      const error = (await attempt.catch((caught: unknown) => caught)) as Error & { code: string };
      expect(error.code, JSON.stringify(deliverTo)).toBe("invalid-input");
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain("Maker.Person");
      expect(error.message).toMatch(/deliverTo/);
    }
  });

  it("travels as one multipart field of exactly the email and the word, nowhere else", () => {
    const signed = { message: { mode: 0, pictureHash: `0x${"11".repeat(32)}`, platformId: `0x${"22".repeat(32)}`, nonce: `0x${"33".repeat(32)}`, issuedAt: 1n }, signature: "0x44" } as const;
    const form = prepareForm(new Uint8Array([1]), "platform", "A title", signed as never, undefined, { email: EMAIL, verifiedBy: "google" });
    expect(JSON.parse(form.get("deliverTo") as string)).toEqual({ email: EMAIL, verifiedBy: "google" });
    expect([...form.keys()].filter((name) => (typeof form.get(name) === "string" ? (form.get(name) as string).includes(EMAIL) : false))).toEqual(["deliverTo"]);
    expect(prepareForm(new Uint8Array([1]), "platform", "A title", signed as never).has("deliverTo")).toBe(false);
  });
});

describe("a revert thrown by the platform's own copy of viem", () => {
  // Shaped like viem's classes but not them, as a second copy of viem would throw.
  class OtherCopyRevert extends Error {
    override name = "ContractFunctionRevertedError";
    shortMessage = "The contract function reverted.";
    data = { errorName: "PassportExists" };
  }

  class OtherCopyError extends Error {
    shortMessage = "Execution reverted.";
    constructor(readonly inner: Error) {
      super("Execution reverted.");
    }
    walk(match: (inner: unknown) => boolean): unknown {
      if (match(this)) return this;
      return match(this.inner) ? this.inner : null;
    }
  }

  it("names the custom error the contract reverted with", () => {
    expect(revertReason(new OtherCopyError(new OtherCopyRevert()))).toBe("PassportExists");
  });

  it("falls back to the short message, then to the plain message", () => {
    expect(revertReason(new OtherCopyError(new Error("inner")))).toBe("Execution reverted.");
    expect(revertReason(new Error("plain"))).toBe("plain");
    expect(revertReason("text")).toBe("text");
  });
});
