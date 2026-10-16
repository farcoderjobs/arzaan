import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Integration tests: drive the real HTTP API of a `next dev` server pointed at
 * a dedicated *-test MongoDB database (started by scripts/run-integration.mjs).
 *
 * Files run sequentially (fileParallelism: false) because they share one
 * server/database and register sessions are per-cashier.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/integration/setup-env.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
