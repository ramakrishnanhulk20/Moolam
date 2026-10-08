import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The library half of the studio is pure TypeScript, so the tests run in node
 * with no DOM. The "@" alias mirrors the one in tsconfig.json, which vitest
 * does not read on its own.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/network-guard.ts"],
    // The docs tests render every page through the markdown pipeline. Alone they
    // take about a second; beside 240 other files on this machine they passed
    // the default five seconds and failed the whole run for no fault of theirs.
    // On 8 October 20 seconds still timed out two files in a full run on a busy machine.
    testTimeout: 60_000,
    // The same holds for setup hooks: a fresh clone under load timed out a beforeAll at ten seconds.
    hookTimeout: 60_000,
  },
});
