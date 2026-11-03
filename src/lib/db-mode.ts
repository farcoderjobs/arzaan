/**
 * Which database the running server is actually using.
 *
 * Kept in a dependency-free module on purpose: the dirty-document tracker and
 * the sync worker both need this answer, and importing `@/lib/mongodb` from
 * there would pull the env parser (and mongoose) into every model import.
 */

export type DatabaseMode = "local" | "primary" | "fallback";

const globals = globalThis as typeof globalThis & { __posDatabaseMode?: DatabaseMode };

export function setDatabaseMode(mode: DatabaseMode): void {
  globals.__posDatabaseMode = mode;
}

/** Null until the first successful connection. */
export function getDatabaseMode(): DatabaseMode | null {
  return globals.__posDatabaseMode ?? null;
}

/**
 * A local database IS configured but could not be reached, so this process is
 * running on the online database. Writes must not be queued for replication.
 */
export function isUsingFallbackDatabase(): boolean {
  return globals.__posDatabaseMode === "fallback";
}
