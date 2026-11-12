/**
 * Seeds a database from `data/seed/seed-data.json` (produced by
 * `npm run seed:export`).
 *
 * This is the "make the new PC hold the same data" step: it writes the exported
 * documents with their original `_id`s, so users, roles, products, customers,
 * settings and any history keep pointing at each other exactly as they do on
 * the machine the snapshot came from.
 *
 * Behaviour:
 *  - default: only inserts documents that are missing (`$setOnInsert` by `_id`),
 *    so it is safe to re-run and never overwrites local edits;
 *  - `--replace`: overwrites existing documents with the snapshot (use when the
 *    snapshot is meant to be authoritative — this is destructive);
 *  - `--dry-run`: reports what would change without writing;
 *  - collections with a business unique key (roles, permissions, users) are
 *    matched on that key instead of `_id`, because `npm run seed` mints roles and
 *    permissions with this database's own ids; references to them in the
 *    snapshot are re-pointed by name so users keep a role that exists here;
 *  - a document that still collides on a unique index is reported and skipped
 *    rather than aborting the whole import;
 *  - writes go through the raw driver, so no mongoose hook queues the seeded
 *    documents for replication (a restore must not look like 400 shop edits).
 *
 * Usage:
 *   npm run seed:data
 *   npm run seed:data -- --replace
 *   MONGODB_DB_NAME=seed-verify npm run seed:data -- --dry-run
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { connectDB, disconnectDB, getDatabaseMode } from "@/lib/mongodb";
import { getModelRegistry } from "@/lib/sync/registry";

const EJSON = mongoose.mongo.BSON.EJSON;

const SEED_FILE = path.join(process.cwd(), "data", "seed", "seed-data.json");
const BATCH_SIZE = 500;

/**
 * Collections whose unique index is a business key rather than `_id`.
 *
 * `npm run seed` creates roles and permissions from the code catalog, so a
 * database seeded before an import holds the same names under different ids;
 * matching on the name makes that a no-op instead of a duplicate-key abort.
 */
const NATURAL_KEYS: Record<string, string> = {
  permissions: "name",
  roles: "name",
  users: "email",
};

type Snapshot = {
  meta?: { exportedAt?: string; sourceDatabase?: string };
  collections: Array<{ name: string; docs: Array<Record<string, unknown>> }>;
};

/** One document to write, plus the business key that may already hold it. */
type SeedDoc = {
  id: unknown;
  doc: Record<string, unknown>;
  key?: { field: string; value: unknown };
};

type BatchCounts = { inserted: number; updated: number; unchanged: number; skipped: number };

const args = new Set(process.argv.slice(2));
const replace = args.has("--replace");
const dryRun = args.has("--dry-run");

async function loadSnapshot(): Promise<Snapshot> {
  let raw: string;
  try {
    raw = await readFile(SEED_FILE, "utf8");
  } catch {
    throw new Error(
      `Seed file not found at ${path.relative(process.cwd(), SEED_FILE)} — run "npm run seed:export" first.`
    );
  }

  const parsed = JSON.parse(raw) as Snapshot;
  if (!Array.isArray(parsed.collections) || parsed.collections.length === 0) {
    throw new Error("The seed file has no collections — re-export it.");
  }
  return parsed;
}

const isDuplicateKey = (code: number | undefined): boolean => code === 11000;

/**
 * Writes one batch, tolerating rows that already exist under a different `_id`.
 *
 * An unordered bulk write still applies the rows that do not collide, so the
 * error's own result is counted and only the rejected rows are looked at again:
 * a duplicate key means "already present here" and is skipped, anything else is
 * retried on its own so the failure names the document and stops the import.
 */
async function writeOps(
  collection: mongoose.mongo.Collection,
  batch: SeedDoc[],
  replaceMode: boolean
): Promise<BatchCounts> {
  const counts: BatchCounts = { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };

  const tally = (result: mongoose.mongo.BulkWriteResult | undefined) => {
    if (!result) return;
    counts.inserted += result.upsertedCount ?? 0;
    if (replaceMode) counts.updated += result.modifiedCount ?? 0;
    else counts.unchanged += result.matchedCount ?? 0;
  };

  // Always by `_id` first: that is what keeps the snapshot's relationships
  // intact. The business key is only the fallback for "this database already
  // has that row under another id" (a role seeded from the code catalog).
  const operation = ({ id, doc }: SeedDoc) =>
    (replaceMode
      ? { replaceOne: { filter: { _id: id }, replacement: doc, upsert: true } }
      : { updateOne: { filter: { _id: id }, update: { $setOnInsert: doc }, upsert: true } }) as unknown as
      mongoose.mongo.AnyBulkWriteOperation;

  try {
    tally(await collection.bulkWrite(batch.map(operation), { ordered: false }));
    return counts;
  } catch (err) {
    const bulkError = err as mongoose.mongo.MongoBulkWriteError;
    const rawFailures = bulkError?.writeErrors;
    // The driver types this as `OneOrMore<WriteError>`: an array in practice,
    // a single error object when only one row was rejected.
    const failures = Array.isArray(rawFailures) ? rawFailures : rawFailures ? [rawFailures] : [];
    if (failures.length === 0) throw err;

    tally(bulkError.result);
    for (const failure of failures) {
      const entry = batch[failure.index];
      if (!entry) continue;
      if (!isDuplicateKey(failure.code)) {
        tally(await collection.bulkWrite([operation(entry)], { ordered: false }));
        continue;
      }

      // Duplicate on a unique index. When that index is a business key, the row
      // simply exists here already (with this database's own `_id`), which is
      // what "insert missing only" means — leave it alone.
      const natural = entry.key
        ? await collection.findOne({ [entry.key.field]: entry.key.value })
        : null;
      if (!natural) {
        throw err;
      }
      if (replaceMode) {
        const replaced = await collection.replaceOne(
          { [entry.key!.field]: entry.key!.value },
          entry.doc
        );
        counts.updated += replaced.modifiedCount ?? 0;
        continue;
      }
      counts.skipped += 1;
      console.log(
        `  kept existing ${collection.collectionName}: ${entry.key!.field}=${JSON.stringify(entry.key!.value)}`
      );
    }
    return counts;
  }
}

async function main() {
  const snapshot = await loadSnapshot();

  const totalDocs = snapshot.collections.reduce((sum, c) => sum + c.docs.length, 0);
  console.log(
    `Seed file: ${path.relative(process.cwd(), SEED_FILE)} — ` +
      `${snapshot.collections.length} collection(s), ${totalDocs} document(s)` +
      (snapshot.meta?.exportedAt ? `, exported ${snapshot.meta.exportedAt}` : "")
  );

  if (dryRun) {
    for (const { name, docs } of snapshot.collections) {
      console.log(`  ${name}: ${docs.length} (dry run, nothing written)`);
    }
    return;
  }

  await connectDB();
  const db = mongoose.connection.db;
  if (!db) {
    console.error("No database handle.");
    process.exit(1);
  }
  console.log(`Target: ${db.databaseName} (active database mode: ${getDatabaseMode() ?? "unknown"})`);
  console.log(replace ? "Mode: --replace (existing documents are overwritten)\n" : "Mode: insert missing only\n");

  // Create indexes before bulk writes, so unique guards (SKU, barcode, payroll
  // uniqueness) exist from the first document instead of being built later.
  for (const model of getModelRegistry().values()) {
    await model.init().catch(() => undefined);
  }

  /** `_id` → name for the roles/permissions the snapshot carries. */
  const snapshotNamesById = (collectionName: string) => {
    const map = new Map<string, string>();
    const entry = snapshot.collections.find((c) => c.name === collectionName);
    for (const serialized of entry?.docs ?? []) {
      const decoded = EJSON.deserialize(serialized) as { _id?: unknown; name?: unknown };
      if (decoded._id !== undefined && typeof decoded.name === "string") {
        map.set(String(decoded._id), decoded.name);
      }
    }
    return map;
  };

  /** name → `_id` for what this database already holds. */
  const targetIdsByName = async (collectionName: string) => {
    const map = new Map<string, string>();
    const rows = await db.collection(collectionName).find({}).project({ name: 1 }).toArray();
    for (const row of rows) {
      if (typeof row.name === "string") map.set(row.name, String(row._id));
    }
    return map;
  };

  const [snapshotPermissionNames, snapshotRoleNames, roleIds, permissionIds] = await Promise.all([
    Promise.resolve(snapshotNamesById("permissions")),
    Promise.resolve(snapshotNamesById("roles")),
    targetIdsByName("roles"),
    targetIdsByName("permissions"),
  ]);

  const resolveId = (id: unknown, names: Map<string, string>, targets: Map<string, string>) => {
    const current = String(id);
    const name = names.get(current);
    return (name && targets.get(name)) || current;
  };

  /** Points snapshot references at the rows this database actually has. */
  const remapReferences = (collectionName: string, fields: Record<string, unknown>) => {
    if (collectionName === "users" && fields.roleId) {
      const resolved = resolveId(fields.roleId, snapshotRoleNames, roleIds);
      if (resolved !== String(fields.roleId)) fields.roleId = new mongoose.Types.ObjectId(resolved);
    }
    if (collectionName === "roles" && Array.isArray(fields.permissions)) {
      fields.permissions = fields.permissions.map(
        (id) => new mongoose.Types.ObjectId(resolveId(id, snapshotPermissionNames, permissionIds))
      );
    }
    return fields;
  };

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const { name, docs } of snapshot.collections) {
    const collection = db.collection(name);
    const naturalKey = NATURAL_KEYS[name];
    const batch: SeedDoc[] = docs.map((serialized) => {
      const { _id, ...fields } = EJSON.deserialize(serialized) as Record<string, unknown> & {
        _id: mongoose.Types.ObjectId;
      };
      const doc = remapReferences(name, fields);
      const natural = naturalKey ? doc[naturalKey] : undefined;
      const key =
        naturalKey && natural !== undefined && natural !== null && natural !== ""
          ? { field: naturalKey, value: natural }
          : undefined;
      return { id: _id, doc, key };
    });

    const counts: BatchCounts = { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
    for (let i = 0; i < batch.length; i += BATCH_SIZE) {
      const part = await writeOps(collection, batch.slice(i, i + BATCH_SIZE), replace);
      counts.inserted += part.inserted;
      counts.updated += part.updated;
      counts.unchanged += part.unchanged;
      counts.skipped += part.skipped;
    }

    inserted += counts.inserted;
    updated += counts.updated;
    unchanged += counts.unchanged;
    skipped += counts.skipped;

    const detail = replace
      ? `${counts.inserted} inserted, ${counts.updated} replaced`
      : `${counts.inserted} inserted, ${counts.unchanged} already present`;
    const duplicates = counts.skipped > 0 ? `, ${counts.skipped} skipped (same unique key)` : "";
    console.log(`${name}: ${docs.length} in seed → ${detail}${duplicates}`);
  }

  console.log(
    `\nDone. ${inserted} inserted, ` +
      `${replace ? `${updated} replaced` : `${unchanged} already present`}` +
      `${skipped > 0 ? `, ${skipped} skipped (same unique key)` : ""}.`
  );

  const summary = await Promise.all(
    ["branches", "users", "roles", "permissions", "products", "customers", "sales"].map(
      async (name) => `${name}=${await db.collection(name).countDocuments().catch(() => 0)}`
    )
  );
  console.log(`Target counts: ${summary.join("  ")}`);

  await disconnectDB();
}

main().catch(async (err) => {
  console.error("Seeding failed:", err);
  await disconnectDB().catch(() => undefined);
  process.exit(1);
});
