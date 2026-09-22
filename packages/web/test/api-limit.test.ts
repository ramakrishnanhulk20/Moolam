import { beforeEach, describe, expect, it, vi } from "vitest";

const chain = vi.hoisted(() => ({ consentAt: vi.fn(), latest: vi.fn() }));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => Promise<unknown>) => fn,
}));

// The routes want the reader and the error line, and the real client would open
// a viem transport inside a node test.
vi.mock("@/lib/chain/client", () => ({
  chain: { readContract: vi.fn() },
  addresses: {
    registry: "0x0000000000000000000000000000000000000001",
    policy: "0x0000000000000000000000000000000000000002",
    consent: "0x1151E69a82947920546e779c4C8c785b2a3C1277",
  },
  registryAbi: [],
  policyAbi: [],
  consentAbi: [],
  CACHE_TAGS: { index: "moolam-index", chain: "moolam-chain", metadata: "moolam-metadata" },
  HOLD_SECONDS: 60,
  REPUTATION_REGISTRY: "0x0000000000000000000000000000000000000003",
  gatewayUrl: (uri: string) => uri,
  reason: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("@/lib/chain/consent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chain/consent")>()),
  consentAt: chain.consentAt,
}));

vi.mock("@/lib/data/passports", () => ({ latestPassports: chain.latest }));

const { PER_MINUTE, SHARED_BUCKET, callerAddress, forgetCallers, withinLimit } = await import("@/lib/api/limit");
const { GET: consentAtRoute, roundedDown } = await import("@/app/api/consent-at/route");
const { GET: passportsRoute } = await import("@/app/api/passports/route");
const { POST: cspReportRoute } = await import("@/app/api/csp-report/route");

const ID = "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638";

/**
 * A passport id of its own for each test that reads. The route remembers an
 * answer for a minute under the id and the moment, and that memory is the
 * module's own, so two tests asking about the same passport would share it.
 */
let passport = 0;
function freshId(): string {
  passport += 1;
  return `0x${passport.toString(16).padStart(64, "0")}`;
}

/** A moment well inside the window the route accepts, on a second that is not a whole minute. */
const AT = 1_789_717_037;

function ask(url: string, from = "203.0.113.7"): Request {
  return new Request(url, { headers: { "x-vercel-forwarded-for": from } });
}

beforeEach(() => {
  forgetCallers();
  chain.consentAt.mockReset();
  chain.consentAt.mockResolvedValue({ stated: false, entry: null });
  chain.latest.mockReset();
  chain.latest.mockResolvedValue({ source: "envio", passports: [] });
});

describe("which caller a request is counted against", () => {
  it("takes the first address Vercel wrote into its own forwarded header", () => {
    expect(callerAddress(ask("http://localhost/api/passports", "198.51.100.4, 10.0.0.1"))).toBe("198.51.100.4");
  });

  it("falls back to x-real-ip, and to one shared bucket when the host reported nothing", () => {
    const real = new Request("http://localhost/api/passports", { headers: { "x-real-ip": "198.51.100.9" } });
    expect(callerAddress(real)).toBe("198.51.100.9");
    expect(callerAddress(new Request("http://localhost/api/passports"))).toBe(SHARED_BUCKET);
  });

  it("ignores x-forwarded-for, which a caller writes for themselves anywhere Vercel is not in front", () => {
    const forged = new Request("http://localhost/api/passports", { headers: { "x-forwarded-for": "198.51.100.4" } });
    expect(callerAddress(forged)).toBe(SHARED_BUCKET);
  });

  it("gives a caller inventing an address no second bucket", async () => {
    for (let at = 0; at < PER_MINUTE; at += 1) {
      const invented = new Request("http://localhost/api/passports", {
        headers: { "x-forwarded-for": `198.51.100.${at}` },
      });
      expect((await passportsRoute(invented)).status, `ask ${at + 1}`).toBe(200);
    }

    const next = new Request("http://localhost/api/passports", { headers: { "x-forwarded-for": "203.0.113.99" } });
    expect((await passportsRoute(next)).status).toBe(429);
  });
});

describe("the limit itself", () => {
  it("lets a caller through 60 times a minute and no further", () => {
    const now = 1_789_717_000_000;
    for (let at = 0; at < PER_MINUTE; at += 1) {
      expect(withinLimit("passports", "198.51.100.4", now + at).ok, `ask ${at + 1}`).toBe(true);
    }

    const over = withinLimit("passports", "198.51.100.4", now + 1_000);
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.retryAfter).toBe(59);
  });

  it("counts each route and each caller on their own", () => {
    const now = 1_789_717_000_000;
    for (let at = 0; at < PER_MINUTE; at += 1) {
      withinLimit("passports", "198.51.100.4", now);
    }

    expect(withinLimit("consent-at", "198.51.100.4", now).ok).toBe(true);
    expect(withinLimit("passports", "198.51.100.5", now).ok).toBe(true);
  });

  it("opens again when the minute is over", () => {
    const now = 1_789_717_000_000;
    for (let at = 0; at < PER_MINUTE; at += 1) {
      withinLimit("passports", "198.51.100.4", now);
    }

    expect(withinLimit("passports", "198.51.100.4", now + 60_000).ok).toBe(true);
  });

  it("honours a route with a tighter ceiling of its own", () => {
    const now = 1_789_717_000_000;
    for (let at = 0; at < 30; at += 1) {
      expect(withinLimit("csp-report", "198.51.100.4", now, 30).ok, `ask ${at + 1}`).toBe(true);
    }

    expect(withinLimit("csp-report", "198.51.100.4", now, 30).ok).toBe(false);
  });

  it("never forgets a flooder's count while they are still flooding", () => {
    // The table remembers a fixed number of callers and drops one to make room.
    // If the one dropped were whoever arrived first rather than whoever has been
    // quiet longest, a caller already over the limit could clear their own
    // counter by sending traffic from 5,000 other addresses. So the flooder here
    // keeps asking while those addresses arrive, and has to stay refused.
    const now = 1_789_717_000_000;
    for (let at = 0; at < PER_MINUTE; at += 1) {
      withinLimit("passports", "flooder", now);
    }

    let letThrough = 0;
    for (let at = 0; at < 6_000; at += 1) {
      if (withinLimit("passports", "flooder", now).ok) {
        letThrough += 1;
      }
      withinLimit("passports", `crowd-${at}`, now);
    }

    expect(letThrough).toBe(0);
    expect(withinLimit("passports", "flooder", now).ok).toBe(false);
  });

  it("does forget a caller who has gone quiet, so the table cannot grow without bound", () => {
    const now = 1_789_717_000_000;
    withinLimit("passports", "quiet", now);

    for (let at = 0; at < 6_000; at += 1) {
      withinLimit("passports", `crowd-${at}`, now);
    }

    // A fresh window, which is what being forgotten looks like from outside.
    for (let at = 0; at < PER_MINUTE; at += 1) {
      expect(withinLimit("passports", "quiet", now).ok, `ask ${at + 1}`).toBe(true);
    }
  });
});

describe("what the two routes do with it", () => {
  it("answers the scrubber's reader with 429 and a wait once the caller is over", async () => {
    for (let at = 0; at < PER_MINUTE; at += 1) {
      await consentAtRoute(ask(`http://localhost/api/consent-at?id=${ID}&at=${AT + at * 3_600}`));
    }

    const refused = await consentAtRoute(ask(`http://localhost/api/consent-at?id=${ID}&at=${AT}`));

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused.json()).toEqual({ error: "too many requests from here. Wait a moment and ask again." });
  });

  it("answers the passport strip with 429 the same way, without reading the index", async () => {
    for (let at = 0; at < PER_MINUTE; at += 1) {
      await passportsRoute(ask("http://localhost/api/passports?limit=6"));
    }
    chain.latest.mockClear();

    const refused = await passportsRoute(ask("http://localhost/api/passports?limit=6"));

    expect(refused.status).toBe(429);
    expect(chain.latest).not.toHaveBeenCalled();
  });

  it("keeps one caller's flood off another caller", async () => {
    for (let at = 0; at < PER_MINUTE; at += 1) {
      await passportsRoute(ask("http://localhost/api/passports"));
    }

    expect((await passportsRoute(ask("http://localhost/api/passports", "198.51.100.42"))).status).toBe(200);
  });
});

describe("rounding the moment the scrubber asks about", () => {
  it("drops the seconds and leaves a whole minute alone", () => {
    expect(roundedDown(AT)).toBe(1_789_717_020);
    expect(roundedDown(1_789_717_020)).toBe(1_789_717_020);
  });

  it("asks the chain about the minute, not the second", async () => {
    const id = freshId();

    await consentAtRoute(ask(`http://localhost/api/consent-at?id=${id}&at=${AT}`));

    expect(chain.consentAt).toHaveBeenCalledWith(id, 1_789_717_020);
  });

  it("turns a loop over one minute of seconds into one paid read", async () => {
    const id = freshId();

    for (let second = 0; second < 40; second += 1) {
      const answer = await consentAtRoute(ask(`http://localhost/api/consent-at?id=${id}&at=${1_789_717_020 + second}`));
      expect(answer.status).toBe(200);
    }

    expect(chain.consentAt).toHaveBeenCalledTimes(1);
  });

  it("still tells the reader which moment was answered", async () => {
    const answer = await consentAtRoute(ask(`http://localhost/api/consent-at?id=${freshId()}&at=${AT}`));

    expect(await answer.json()).toEqual({ asked: 1_789_717_020, stated: false, entry: null });
  });

  it("offers a whole minute to the shared cache and refuses to let a second fill it", async () => {
    const id = freshId();

    const whole = await consentAtRoute(ask(`http://localhost/api/consent-at?id=${id}&at=1789717020`));
    expect(whole.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=60");

    // The shared cache keys on the address it was asked with, so this one would
    // be an entry of its own for an answer already held under the whole minute.
    const second = await consentAtRoute(ask(`http://localhost/api/consent-at?id=${id}&at=1789717037`));
    expect(second.headers.get("cache-control")).toBe("private, no-store");
    expect(second.status).toBe(200);
  });
});

describe("where a content policy violation is reported", () => {
  function report(body: unknown, from = "203.0.113.7"): Request {
    return new Request("http://localhost/api/csp-report", {
      method: "POST",
      headers: { "x-vercel-forwarded-for": from, "content-type": "application/csp-report" },
      body: JSON.stringify(body),
    });
  }

  const OLD_SHAPE = {
    "csp-report": {
      "document-uri": "https://moolam.xyz/en/studio",
      "violated-directive": "worker-src",
      "blocked-uri": "blob",
      "original-policy": "default-src 'self'; report-uri /api/csp-report",
      "script-sample": "something the page had in it",
    },
  };

  const NEW_SHAPE = [
    {
      type: "csp-violation",
      body: {
        documentURL: "https://moolam.xyz/en/studio",
        effectiveDirective: "connect-src",
        blockedURL: "wss://relay.walletconnect.org",
        sample: "something the page had in it",
      },
    },
  ];

  it("takes the shape report-uri posts and writes one line naming the page, the rule and what was blocked", async () => {
    const lines = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const answer = await cspReportRoute(report(OLD_SHAPE));

    expect(answer.status).toBe(204);
    expect(lines).toHaveBeenCalledTimes(1);
    const line = lines.mock.calls[0][0] as string;
    expect(line).toContain("https://moolam.xyz/en/studio");
    expect(line).toContain("worker-src");
    expect(line).toContain("blob");
    // The body itself never reaches the log: a report is written by whatever is
    // in the visitor's browser, extensions included.
    expect(line).not.toContain("something the page had in it");
    expect(line).not.toContain("original-policy");
    lines.mockRestore();
  });

  it("takes the shape report-to posts as well, so the policy can carry both", async () => {
    const lines = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect((await cspReportRoute(report(NEW_SHAPE))).status).toBe(204);

    const line = lines.mock.calls[0][0] as string;
    expect(line).toContain("connect-src");
    expect(line).toContain("wss://relay.walletconnect.org");
    lines.mockRestore();
  });

  it("says nothing at all about a body it cannot read, and still answers 204", async () => {
    const lines = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const broken = new Request("http://localhost/api/csp-report", {
      method: "POST",
      headers: { "x-vercel-forwarded-for": "203.0.113.7" },
      body: "not json at all",
    });

    expect((await cspReportRoute(broken)).status).toBe(204);
    expect((await cspReportRoute(report({ nothing: true }))).status).toBe(204);
    expect(lines).not.toHaveBeenCalled();
    lines.mockRestore();
  });

  it("takes thirty a minute from one caller and refuses the thirty first", async () => {
    const lines = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    for (let at = 0; at < 30; at += 1) {
      expect((await cspReportRoute(report(OLD_SHAPE))).status, `report ${at + 1}`).toBe(204);
    }

    const refused = await cspReportRoute(report(OLD_SHAPE));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(lines).toHaveBeenCalledTimes(30);
    lines.mockRestore();
  });
});
