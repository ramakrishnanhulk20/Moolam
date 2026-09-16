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

const pictureHosts = [ownGateway, "ipfs.io", "dweb.link"].filter((host, at, all) => all.indexOf(host) === at);

const nextConfig: NextConfig = {
  // Pinned pictures are fetched by the optimizer, not by the browser, so the
  // gateway serves each one once and every later view is answered from the
  // optimizer's cache. A pinned file is content addressed and can never change
  // under its own address, so the cache is held for a year.
  images: {
    remotePatterns: pictureHosts.map((hostname) => ({ protocol: "https" as const, hostname })),
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
