import "dotenv/config";

/**
 * Imported first by every e2e spec so that direct database access (through
 * tests/helpers/qa.ts) is pinned to the dedicated QA database before any
 * application module reads process.env.
 */
const base = process.env.MONGODB_DB_NAME ?? "pos";
// Idempotent: if this module is evaluated in a process where the name was
// already suffixed (or TEST_MONGODB_DB_NAME already holds the final name),
// never append a second "-test".
const testDb =
  process.env.TEST_MONGODB_DB_NAME?.trim() || (base.endsWith("-test") ? base : `${base}-test`);

if (!testDb.endsWith("-test")) {
  throw new Error(`[qa-e2e] test database must end with "-test" (got "${testDb}")`);
}

process.env.MONGODB_DB_NAME = testDb;
process.env.QA_USER_PASSWORD ??= "qa-test-pass-123!";
