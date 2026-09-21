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
  expect(rules).toHaveLength(1);
  expect(rules[0].source).toBe("/:path*");
  return Object.fromEntries(rules[0].headers.map((header) => [header.key, header.value]));
}

describe("the headers every page and every route answers with", () => {
  it("never advertises the framework", () => {
    expect(config.poweredByHeader).toBe(false);
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
        "img-src 'self' data: blob: https://lavender-personal-grasshopper-978.mypinata.cloud https://ipfs.io https://dweb.link",
        "connect-src 'self' blob: https://auth.privy.io https://api.privy.io https://explorer-api.walletconnect.com https://verifier-production-d76f.up.railway.app https://rpc1.monad.xyz https://lavender-personal-grasshopper-978.mypinata.cloud https://ipfs.io https://dweb.link",
        "frame-src https://auth.privy.io",
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
});
