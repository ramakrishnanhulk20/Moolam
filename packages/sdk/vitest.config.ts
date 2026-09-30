import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The fork tests share one anvil process per file; running files one at a time keeps a small
    // machine's memory and the forked RPC's rate limit in bounds.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 240_000,
  },
});
