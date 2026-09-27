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
  },
});
