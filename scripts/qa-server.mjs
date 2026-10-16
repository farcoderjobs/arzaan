/**
 * QA server: seeds the dedicated test database, then runs `next dev` against it.
 *
 * Used by:
 *  - scripts/run-integration.mjs (integration tests)
 *  - playwright.config.ts webServer (e2e tests)
 *
 * Environment:
 *  - QA_PORT            port for the QA server (default 3210)
 *  - TEST_MONGODB_DB_NAME  test database (default "<MONGODB_DB_NAME>-test"); must end in "-test"
 *  - QA_SKIP_SEED=1     skip the DB drop+seed (e.g. iterating on a single spec)
 */
import { spawn } from "node:child_process";
import net from "node:net";
import { config as loadDotenv } from "dotenv";

loadDotenv();

const WIN = process.platform === "win32";
const PORT = process.env.QA_PORT || "3210";
const BASE_DB = process.env.MONGODB_DB_NAME || "pos";
const TEST_DB = process.env.TEST_MONGODB_DB_NAME || `${BASE_DB}-test`;

function fail(message) {
  console.error(`[qa-server] ${message}`);
  process.exit(1);
}

if (!TEST_DB.endsWith("-test")) {
  fail(`test database name must end with "-test" (got "${TEST_DB}")`);
}
if (TEST_DB === BASE_DB && !BASE_DB.endsWith("-test")) {
  fail(`test database must differ from the primary database ("${BASE_DB}")`);
}
if (!process.env.MONGODB_URI) fail("MONGODB_URI is not set (copy .env.example → .env)");
if (!process.env.JWT_SECRET) fail("JWT_SECRET is not set (copy .env.example → .env)");

function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port: Number(port), host: "127.0.0.1" });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });
}

function run(cmd, args, { env, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: "inherit", shell: WIN });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} exited with code ${code}`))
    );
  });
}

const env = {
  ...process.env,
  MONGODB_DB_NAME: TEST_DB,
  APP_URL: `http://localhost:${PORT}`,
  NEXT_PUBLIC_APP_URL: `http://localhost:${PORT}`,
  // The dev server must never inherit a test-runner NODE_ENV.
  NODE_ENV: "development",
};

if (await portInUse(PORT)) {
  fail(`port ${PORT} is already in use — free it or set QA_PORT to another port`);
}

if (process.env.QA_SKIP_SEED !== "1") {
  console.log(`[qa-server] Seeding test database "${TEST_DB}" ...`);
  await run("npx", ["tsx", "scripts/seed-test-db.ts"], { env, label: "seed-test-db" });
} else {
  console.log("[qa-server] QA_SKIP_SEED=1 — skipping database seed");
}

console.log(`[qa-server] Starting next dev on http://localhost:${PORT} (db: ${TEST_DB})`);
const server = spawn("npx", ["next", "dev", "-p", PORT], {
  env,
  stdio: "inherit",
  shell: WIN,
});

const forward = (signal) => () => {
  server.kill(signal);
};
process.on("SIGINT", forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));

server.on("exit", (code) => process.exit(code ?? 0));
