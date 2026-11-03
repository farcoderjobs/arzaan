import { SyncConflict, SyncOutbox, SyncRun, SyncState } from "@/models";
import { getState, setState } from "./outbox";

/**
 * Versioning for the shop node's LOCAL database.
 *
 * Mongoose creates the collection indexes it knows about on connect, so a
 * migration here is only needed for things schemas cannot express: back-fills,
 * index changes, or dropping state written by an older build.
 *
 * Rules:
 *  - migrations are additive and idempotent — running one twice is safe;
 *  - the stored version is bumped only after `up()` resolves, so an interrupted
 *    start retries the same migration instead of skipping it;
 *  - downgrades are NOT supported: a build older than the stored version
 *    refuses to touch the sync collections (see `assertLocalSchemaSupported`),
 *    because it cannot know what a newer migration did.
 */

export const LOCAL_SCHEMA_VERSION = 2;

export type LocalMigration = {
  version: number;
  name: string;
  up: () => Promise<void>;
};

export const LOCAL_MIGRATIONS: LocalMigration[] = [
  {
    version: 1,
    name: "baseline",
    up: async () => {
      // The offline-first node layout: previous builds kept the pending queue in
      // the browser (IndexedDB), so there is nothing to import — sales captured
      // offline were already pushed through /api/sync/sale. This migration only
      // establishes the version marker.
    },
  },
  {
    version: 2,
    name: "sync-collection-indexes",
    up: async () => {
      await Promise.all([
        SyncOutbox.createIndexes(),
        SyncConflict.createIndexes(),
        SyncRun.createIndexes(),
        SyncState.createIndexes(),
      ]);
    },
  },
];

export async function localSchemaVersion(): Promise<number> {
  return getState<number>("local.schemaVersion", 0);
}

export type LocalMigrationResult = {
  from: number;
  to: number;
  applied: string[];
};

export async function runLocalMigrations(): Promise<LocalMigrationResult> {
  const from = await localSchemaVersion();
  const applied: string[] = [];

  for (const migration of LOCAL_MIGRATIONS) {
    if (migration.version <= from) continue;
    try {
      await migration.up();
      applied.push(`${migration.version}:${migration.name}`);
      await setState("local.schemaVersion", migration.version);
    } catch (err) {
      console.error(`[sync] local migration ${migration.version}:${migration.name} failed`, err);
      await setState("local.migrationError", {
        at: new Date().toISOString(),
        version: migration.version,
        name: migration.name,
        message: err instanceof Error ? err.message : String(err),
      });
      break;
    }
  }

  const to = await localSchemaVersion();
  if (applied.length > 0) {
    await setState("local.migratedAt", new Date().toISOString());
  }
  return { from, to, applied };
}

/** True when this build can safely touch the local sync collections. */
export async function assertLocalSchemaSupported(): Promise<boolean> {
  const version = await localSchemaVersion();
  if (version > LOCAL_SCHEMA_VERSION) {
    console.error(
      `[sync] the local database is at schema version ${version}, but this build only understands ${LOCAL_SCHEMA_VERSION}. ` +
        "Update the application before syncing from this node."
    );
    return false;
  }
  return true;
}
