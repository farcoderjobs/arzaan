import mongoose from "mongoose";
import { envSchema } from "@/config/env";
import { getDatabaseMode, setDatabaseMode, type DatabaseMode } from "@/lib/db-mode";

const resolvedEnv = envSchema.parse(process.env);

/**
 * Which database this process is actually talking to.
 *
 * - `local`    → the shop's own MongoDB (`MONGODB_LOCAL_URI`, e.g. the one
 *                MongoDB Compass connects to on the shop PC). This is the
 *                system of record while the shop works, online or not.
 * - `primary`  → `MONGODB_URI` and no local database configured: the historical
 *                behaviour (a "center" with Atlas, or a single-DB install).
 * - `fallback` → a local URI IS configured but not reachable, so the process
 *                started against `MONGODB_URI` instead. Reads/writes work, but
 *                the local database is NOT receiving them, so replication is
 *                paused until the local MongoDB is started and the server is
 *                restarted.
 */
export type { DatabaseMode };

/** Local MongoDB for this shop. Optional so existing installs keep working. */
const LOCAL_URI = (process.env.MONGODB_LOCAL_URI ?? "").trim() || null;

declare global {
  // `var` is required to expose the connection cache on `global`.
  var _mongooseConnectPromise: Promise<typeof mongoose> | undefined;
}

const isTest = process.env.NODE_ENV === "test";

/** A local mongod that is not running should fail fast, not hang for 5s. */
const LOCAL_SELECTION_TIMEOUT_MS = 2_000;
const PRIMARY_SELECTION_TIMEOUT_MS = 5_000;

export function hasLocalDatabase(): boolean {
  return Boolean(LOCAL_URI);
}

export { getDatabaseMode };

/** True when the local database is configured but this process fell back. */
export function isUsingFallbackDatabase(): boolean {
  return getDatabaseMode() === "fallback";
}

function options(timeoutMs: number) {
  return {
    dbName: resolvedEnv.MONGODB_DB_NAME,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: timeoutMs,
    socketTimeoutMS: 45000,
  };
}

async function connectTo(uri: string, timeoutMs: number): Promise<void> {
  await mongoose.connect(uri, options(timeoutMs));
}

/**
 * Picks the database once per process.
 *
 * The choice is remembered on `globalThis` so a dev-server hot reload keeps
 * using the same database it already connected to (switching databases mid-run
 * would silently move new writes between them).
 */
async function resolveConnection(): Promise<void> {
  const mode = getDatabaseMode();

  if (mode === "local") {
    await connectTo(LOCAL_URI as string, LOCAL_SELECTION_TIMEOUT_MS);
    return;
  }
  if (mode === "primary") {
    await connectTo(resolvedEnv.MONGODB_URI, PRIMARY_SELECTION_TIMEOUT_MS);
    return;
  }
  if (mode === "fallback") {
    await connectTo(resolvedEnv.MONGODB_URI, PRIMARY_SELECTION_TIMEOUT_MS);
    return;
  }

  if (!LOCAL_URI) {
    await connectTo(resolvedEnv.MONGODB_URI, PRIMARY_SELECTION_TIMEOUT_MS);
    setDatabaseMode("primary");
    return;
  }

  try {
    await connectTo(LOCAL_URI, LOCAL_SELECTION_TIMEOUT_MS);
    setDatabaseMode("local");
    console.info("[db] using the local shop database");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[db] local MongoDB at ${LOCAL_URI} is unreachable (${message}). ` +
        "Falling back to MONGODB_URI — start the local MongoDB and restart this server to work offline again."
    );
    await mongoose.disconnect().catch(() => undefined);
    await connectTo(resolvedEnv.MONGODB_URI, PRIMARY_SELECTION_TIMEOUT_MS);
    setDatabaseMode("fallback");
  }
}

/**
 * Returns a live mongoose connection.
 *
 * Uses the driver's real `readyState` instead of a cached boolean so that a
 * dropped connection (or a dev-server hot reload that re-evaluates this module)
 * can never leave us with a "connected" flag pointing at a dead client.
 * Concurrent callers share a single in-flight connect promise.
 */
export async function connectDB(): Promise<typeof mongoose> {
  if (isTest) {
    return mongoose as typeof mongoose;
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose as typeof mongoose;
  }

  if (!global._mongooseConnectPromise) {
    global._mongooseConnectPromise = resolveConnection()
      .then(() => mongoose)
      .finally(() => {
        global._mongooseConnectPromise = undefined;
      });
  }

  return global._mongooseConnectPromise;
}

/**
 * Closes the shared connection. Only for standalone scripts (seeds, smoke
 * tests) that need the process to exit — API routes must NOT call this while
 * the server keeps serving other requests.
 */
export async function disconnectDB(): Promise<void> {
  if (!isTest) {
    await mongoose.disconnect();
    global._mongooseConnectPromise = undefined;
  }
}
