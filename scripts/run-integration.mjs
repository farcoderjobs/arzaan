/**
 * Integration test orchestrator.
 *
 * 1. Starts the QA server (scripts/qa-server.mjs: seeds the *-test database and
 *    runs `next dev` on QA_PORT).
 * 2. Waits for GET /api/health to answer.
 * 3. Runs the integration vitest suite against it.
 * 4. Tears the server down and exits with vitest's status.
 */
import { spawn } from "node:child_process";
import { config as loadDotenv } from "dotenv";

loadDotenv();

const WIN = process.platform === "win32";
const PORT = process.env.QA_PORT || "3210";
const BASE_URL = `http://localhost:${PORT}`;
const BASE_DB = process.env.MONGODB_DB_NAME || "pos";
const TEST_DB = process.env.TEST_MONGODB_DB_NAME || `${BASE_DB}-test`;

if (!TEST_DB.endsWith("-test")) {
  console.error(`[qa-it] test database name must end with "-test" (got "${TEST_DB}")`);
  process.exit(1);
}

function startServer() {
  return spawn(process.execPath, ["scripts/qa-server.mjs"], {
    env: { ...process.env, QA_PORT: PORT, TEST_MONGODB_DB_NAME: TEST_DB },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

async function waitForHealth(server, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response yet";
  let serverExited = false;
  server.on("exit", () => {
    serverExited = true;
  });
  while (Date.now() < deadline) {
    if (serverExited) {
      throw new Error("qa-server exited before becoming healthy (port already in use? check the log above)");
    }
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return true;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err?.message ?? String(err);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`QA server on ${BASE_URL} did not become healthy in ${timeoutMs / 1000}s (${lastError})`);
}

function stopServer(server) {
  if (WIN) {
    spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
  }
}

const server = startServer();
let stopping = false;

try {
  await waitForHealth(server);
  console.log(`[qa-it] QA server healthy on ${BASE_URL} (db: ${TEST_DB}) — running integration tests`);

  const code = await new Promise((resolve) => {
    const vitest = spawn("npx", ["vitest", "run", "--config", "vitest.integration.config.ts"], {
      env: {
        ...process.env,
        QA_BASE_URL: BASE_URL,
        TEST_MONGODB_DB_NAME: TEST_DB,
        MONGODB_DB_NAME: TEST_DB,
      },
      stdio: "inherit",
      shell: WIN,
    });
    vitest.on("exit", (c) => resolve(c ?? 1));
  });

  stopping = true;
  stopServer(server);
  process.exit(code);
} catch (err) {
  console.error("[qa-it]", err?.message ?? err);
  if (!stopping) stopServer(server);
  process.exit(1);
}
