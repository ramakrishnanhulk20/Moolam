import { describe, expect, it } from "vitest";

// The config reads these when it is imported, so the policy this test pins is
// built from known values rather than from whatever is in the machine's own
// environment. The gateway is the one the deployed app uses.
process.env.NEXT_PUBLIC_IPFS_GATEWAY = "https://lavender-personal-grasshopper-978.mypinata.cloud/ipfs/";
process.env.NEXT_PUBLIC_VERIFIER_URL = "https://verifier-production-d76f.up.railway.app";
process.env.NEXT_PUBLIC_MONAD_RPC_URL = "https://rpc1.monad.xyz";

const { default: config } = await import("@/next.config");

async function headers(): Promise<Record<string, string>> {
  const rules = await (config.headers as () => Promise<{ source: string; headers: { key: string; value: string }[] }[]>)();
  // The site-wide rule comes first; the co-sign and connect pages add their own after it (test/cosign-headers.test.ts).
  expect(rules.map((rule) => rule.source)).toEqual(["/:path*", "/:locale/cosign", "/:locale/connect"]);
  return Object.fromEntries(rules[0].headers.map((header) => [header.key, header.value]));
}

describe("the headers every page and every route answers with", () => {
  it("never advertises the framework", () => {
    expect(config.poweredByHeader).toBe(false);
  });

  it("frames no route, not even on a dev server", async () => {
    const env = process.env as Record<string, string | undefined>;
    const was = env.NODE_ENV;
    env.NODE_ENV = "development";
    try {
      expect((await headers())["x-frame-options"]).toBe("DENY");
    } finally {
      env.NODE_ENV = was;
    }
  });

  it("pins the three plain ones", async () => {
    const sent = await headers();
    expect(sent["x-content-type-options"]).toBe("nosniff");
    expect(sent["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(sent["x-frame-options"]).toBe("DENY");
  });

  it("keeps passkey sign in working in the permissions policy", async () => {
    expect((await headers())["permissions-policy"]).toBe(
      'camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=(self "https://auth.privy.io")',
    );
  });

  it("reports on the content policy rather than enforcing it", async () => {
    const sent = await headers();
    expect(sent["content-security-policy"]).toBeUndefined();
    expect(sent["content-security-policy-report-only"]).toBe(
      [
        "default-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self'",
        "img-src 'self' data: blob: https://lavender-personal-grasshopper-978.mypinata.cloud",
        "connect-src 'self' blob: https://auth.privy.io https://api.privy.io https://explorer-api.walletconnect.com wss://relay.walletconnect.org https://verifier-production-d76f.up.railway.app https://rpc1.monad.xyz https://lavender-personal-grasshopper-978.mypinata.cloud",
        "frame-src https://auth.privy.io",
        "worker-src 'self' blob:",
        "child-src 'self' blob: https://auth.privy.io",
        "report-uri /api/csp-report",
        "report-to csp",
      ].join("; "),
    );
  });

  it("names every origin the live site was measured fetching", async () => {
    const policy = (await headers())["content-security-policy-report-only"];
    for (const origin of [
      "https://auth.privy.io",
      "https://api.privy.io",
      "https://explorer-api.walletconnect.com",
      "https://verifier-production-d76f.up.railway.app",
      "https://rpc1.monad.xyz",
    ]) {
      expect(policy, origin).toContain(origin);
    }
  });

  it("names the three a signed in visitor reaches, which a signed out measurement never sees", async () => {
    const policy = (await headers())["content-security-policy-report-only"];

    // The wallet relay in @privy-io's ox builds a Worker from a blob URL, and
    // @walletconnect/core opens this socket. Both are read from the shipped
    // SDKs rather than from a page load, because neither happens until somebody
    // signs in.
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).toContain("wss://relay.walletconnect.org");
    expect(policy).toContain("child-src 'self' blob: https://auth.privy.io");
  });

  it("sends the reports somewhere, which is the only thing that makes report-only a measurement", async () => {
    const sent = await headers();
    expect(sent["content-security-policy-report-only"]).toContain("report-uri /api/csp-report");
    expect(sent["reporting-endpoints"]).toBe('csp="/api/csp-report"');
  });
});

describe("what the image optimizer is allowed to fetch", () => {
  it("names one host and one path on it, so the allowance cannot be spent by a stranger", () => {
    // The optimizer fetches whatever address it is handed. A public gateway
    // here would serve any content id to anyone out of this project's monthly
    // transformations; the account's own gateway answers 403 for anything this
    // account has not pinned.
    expect(config.images?.remotePatterns).toEqual([
      {
        protocol: "https",
        hostname: "lavender-personal-grasshopper-978.mypinata.cloud",
        pathname: "/ipfs/**",
      },
    ]);
  });
});
