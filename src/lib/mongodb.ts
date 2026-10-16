import mongoose from "mongoose";
import { envSchema } from "@/config/env";

const resolvedEnv = envSchema.parse(process.env);

declare global {
  // `var` is required to expose the connection cache on `global`.
  var _mongooseConnectPromise: Promise<typeof mongoose> | undefined;
}

const isTest = process.env.NODE_ENV === "test";

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
    global._mongooseConnectPromise = mongoose
      .connect(resolvedEnv.MONGODB_URI, {
        dbName: resolvedEnv.MONGODB_DB_NAME,
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      })
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
