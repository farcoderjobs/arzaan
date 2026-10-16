import "dotenv/config";
import { defineConfig } from "@playwright/test";

/**
 * E2E tests run against the same QA server as the integration suite: the
 * webServer entry starts scripts/qa-server.mjs, which seeds the dedicated
 * *-test database and boots `next dev` on QA_PORT.
 *
 * `.env` is loaded first (same as scripts/run-integration.mjs) so TEST_DB
 * resolves to the same database the test harness (tests/helpers/qa.ts) talks
 * to — without it the name silently falls back to "pos-test" and the server
 * and the harness disagree about which users exist (minted tokens → 401).
 *
 * The database guard lives in scripts/qa-server.mjs — it refuses any database
 * name that does not end in "-test", so these tests can never touch
 * production data.
 */
const PORT = process.env.QA_PORT || "3210";
const BASE_URL = process.env.QA_BASE_URL || `http://localhost:${PORT}`;
const TEST_DB = process.env.TEST_MONGODB_DB_NAME || `${process.env.MONGODB_DB_NAME || "pos"}-test`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    // Use the installed Chrome (no browser download needed). Override with
    // QA_CHROME_CHANNEL (e.g. "msedge") or set PLAYWRIGHT_BROWSERS_PATH etc.
    channel: process.env.QA_CHROME_CHANNEL || "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/qa-server.mjs",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      QA_PORT: PORT,
      TEST_MONGODB_DB_NAME: TEST_DB,
    },
  },
});
