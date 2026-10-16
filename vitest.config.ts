import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Unit tests for critical business logic (pure functions and modules that do
 * not need a running server).
 *
 * Integration tests (tests/integration/**) need the QA server + dedicated test
 * database — they run via `npm run test:integration` (vitest.integration.config.ts).
 * Playwright e2e specs in tests/e2e/** run via `npm run test:e2e`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "**/node_modules/**"],
    environment: "node",
  },
});
