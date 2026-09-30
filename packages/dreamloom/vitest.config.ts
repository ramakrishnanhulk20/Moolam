import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// vitest does not read tsconfig paths, so the "@" alias is repeated here. The
// platform kit is deliberately not aliased: it resolves through its own built
// package, exactly as it would for an outside platform.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
