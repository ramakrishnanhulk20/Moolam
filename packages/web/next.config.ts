import path from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./lib/i18n/request.ts");

// The repo root, so Turbopack resolves the contract ABIs and the deployment
// file that live in packages/contracts and picks the right lockfile.
const repoRoot = path.resolve(process.cwd(), "..", "..");

const nextConfig: NextConfig = {
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
