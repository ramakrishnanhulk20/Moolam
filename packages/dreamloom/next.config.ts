import path from "node:path";
import type { NextConfig } from "next";

// The platform kit is a workspace package: its link in node_modules points at
// packages/sdk/dist, so the bundler and the file tracer must both be allowed to
// look above this package.
const repoRoot = path.resolve(process.cwd(), "..", "..");

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // A verification build must never write into the directory the dev server
  // is serving from, so the build directory is chosen by the environment.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  agentRules: false,
};

export default nextConfig;
