import "dotenv/config";

/**
 * Every test-side database access must hit the dedicated QA database.
 * The orchestrator (scripts/run-integration.mjs) already points the vitest
 * process at it; this file enforces the same rule when tests are run ad-hoc.
 */
const base = process.env.MONGODB_DB_NAME ?? "pos";
// Idempotent: never append a second "-test" if the incoming name is already
// the final test database name.
const testDb =
  process.env.TEST_MONGODB_DB_NAME?.trim() || (base.endsWith("-test") ? base : `${base}-test`);

if (!testDb.endsWith("-test")) {
  throw new Error(
    `[qa] Refusing to run: test database name must end with "-test" (got "${testDb}"). ` +
      `Set TEST_MONGODB_DB_NAME in your environment.`
  );
}

process.env.MONGODB_DB_NAME = testDb;
process.env.QA_USER_PASSWORD ??= "qa-test-pass-123!";
