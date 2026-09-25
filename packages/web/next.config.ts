import path from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./lib/i18n/request.ts");

// The repo root, so Turbopack resolves the contract ABIs and the deployment
// file that live in packages/contracts and picks the right lockfile.
const repoRoot = path.resolve(process.cwd(), "..", "..");

// The account's own IPFS gateway, read the same way lib/images.ts reads it. The
// config file cannot import from the app, so the one line is written twice.
const ownGateway = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_IPFS_GATEWAY ?? "https://gateway.pinata.cloud/ipfs/").hostname;
  } catch {
    return "gateway.pinata.cloud";
  }
})();

// One host, and one path on it. The optimizer fetches whatever address it is
// handed, so a public gateway in this list is a stranger's free image service
// paid for out of this project's monthly transformations: anyone with a list of
// content ids could spend the allowance in an afternoon. The account's own
// Pinata gateway answers 403 for anything this account has not pinned, so
// naming it alone bounds the optimizer to this project's own files.
const pictureHosts = [ownGateway];

/** The origin of a configured URL, or nothing when the variable is unset or malformed. */
function originOf(value: string | undefined, fallback: string): string[] {
  try {
    return [new URL(value === undefined || value.trim() === "" ? fallback : value.trim()).origin];
  } catch {
    return [];
  }
}

// The two services the browser talks to directly, read the same way lib/env.ts
// reads them and with the same fallbacks. The verify page fetches the verifier
// and reads Monad from the browser, so both belong in connect-src; a local
// setup lists its own localhost service here, which costs a deployed build
// nothing because the deployed build has the real values.
const serviceOrigins = [
  ...originOf(process.env.NEXT_PUBLIC_VERIFIER_URL, "http://localhost:4010"),
  ...originOf(process.env.NEXT_PUBLIC_MONAD_RPC_URL, "https://rpc1.monad.xyz"),
];

const pictureOrigins = pictureHosts.map((host) => `https://${host}`);

/** Where the browser posts what this policy would have blocked. */
const REPORT_ROUTE = "/api/csp-report";

// Measured on the live site signed out, page by page, from what the browser
// really fetched: the app itself, Privy for sign in, WalletConnect's explorer
// on the studio, the verify service, the gateway, and blob: and data: for the
// dropped file's own preview. Three more are in the list from reading the
// shipped SDKs rather than from a load, because they only happen once somebody
// signs in: the wallet relay ox in @privy-io connects a Worker built from a
// blob URL, @walletconnect/core opens wss://relay.walletconnect.org, and Privy
// draws auth.privy.io in a frame.
//
// 'unsafe-inline' stays on script-src because Next's bootstrap script is
// inline: the nonce alternative forces every page to render on the request,
// which would cost this site its static pages. The policy ships report-only
// because the list was measured signed out, and a policy that breaks sign in
// would be worse than no policy at all. report-uri is what turns report-only
// from a comment into a measurement; report-to is the newer spelling of the
// same thing and a browser that ignores the relative endpoint still honours
// report-uri.
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  `img-src 'self' data: blob: ${pictureOrigins.join(" ")}`,
  `connect-src 'self' blob: https://auth.privy.io https://api.privy.io https://explorer-api.walletconnect.com wss://relay.walletconnect.org ${[...serviceOrigins, ...pictureOrigins].join(" ")}`,
  "frame-src https://auth.privy.io",
  "worker-src 'self' blob:",
  // The fallback a browser too old for frame-src and worker-src reads instead.
  "child-src 'self' blob: https://auth.privy.io",
  `report-uri ${REPORT_ROUTE}`,
  "report-to csp",
].join("; ");

const nextConfig: NextConfig = {
  // The framework's name and version is a free hint to anyone looking for a
  // version with a known hole in it.
  poweredByHeader: false,
  // The dev badge sat over the Home tab of the phone bar at the bottom left.
  // Dev only.
  devIndicators: { position: "top-right" },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "x-content-type-options", value: "nosniff" },
          { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
          { key: "x-frame-options", value: "DENY" },
          // publickey-credentials-get has to stay allowed for this origin and
          // for auth.privy.io, or passkey sign in stops working.
          {
            key: "permissions-policy",
            value: 'camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=(self "https://auth.privy.io")',
          },
          { key: "reporting-endpoints", value: `csp="${REPORT_ROUTE}"` },
          { key: "content-security-policy-report-only", value: contentSecurityPolicy },
        ],
      },
    ];
  },

  // Pinned pictures are fetched by the optimizer, not by the browser, so the
  // gateway serves each one once and every later view is answered from the
  // optimizer's cache. A pinned file is content addressed and can never change
  // under its own address, so the cache is held for a year.
  images: {
    remotePatterns: pictureHosts.map((hostname) => ({ protocol: "https" as const, hostname, pathname: "/ipfs/**" })),
    qualities: [70, 75],
    minimumCacheTTL: 31_536_000,
    // The optimizer reads the gateway once per width it is asked for, so the
    // list of widths is the list of times one picture can cost a request. Three
    // screen widths and three grid widths cover a phone through a large desktop
    // and cap that at six, rather than the eight screen widths Next offers by
    // default on top of eight more for grids.
    deviceSizes: [640, 1080, 1920],
    imageSizes: [128, 256, 384],
  },

  // Turbopack ships a page as thirty-odd hashed chunks, and without maps there
  // is no way to say what is inside one. scripts/perf/bundle.mjs reads these to
  // name the ten heaviest modules on a route. Maps cost build time and a public
  // copy of the source, so they are only written when a measurement asks:
  // ANALYZE=1 NEXT_DIST_DIR=.next-wo66 npx next build.
  productionBrowserSourceMaps: process.env.ANALYZE === "1",

  // Next writes its own AGENTS.md and CLAUDE.md next to the app. This repo keeps
  // its rules for agents in one place, so those files are not wanted here.
  agentRules: false,

  // The dev server refuses its hot reload socket to an origin it was not told
  // about, and a page opened on 127.0.0.1 rather than localhost is a different
  // origin to it: the film never hydrates there. This is read by next dev only
  // and has no effect on a build or on the deployed site.
  allowedDevOrigins: ["127.0.0.1", "localhost"],

  // A verification build must never write into the directory the dev server is
  // serving from, so the build directory is chosen by the environment.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,

  // The documentation pages and the proof transcripts live above this package,
  // so the routes that read them say so rather than having the bundler guess.
  outputFileTracingIncludes: {
    "/[locale]/docs/[[...slug]]": ["../../docs/**/*.md", "../../docs/nav.json"],
    "/docs-files/[...path]": ["../../docs/**/*.txt", "../../proofs/**/*.txt"],
    "/docs-search": ["../../docs/**/*.md", "../../docs/nav.json"],
  },
};

export default withNextIntl(nextConfig);
