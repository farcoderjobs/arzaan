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

type Snapshot = {
  meta?: { exportedAt?: string; sourceDatabase?: string };
  collections: Array<{ name: string; docs: Array<Record<string, unknown>> }>;
};

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

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const { name, docs } of snapshot.collections) {
    const collection = db.collection(name);
    let collectionInserted = 0;
    let collectionUpdated = 0;
    let collectionUnchanged = 0;

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = docs.slice(i, i + BATCH_SIZE);
      const decode = (serialized: Record<string, unknown>) => {
        const { _id, ...fields } = EJSON.deserialize(serialized) as Record<string, unknown> & {
          _id: mongoose.Types.ObjectId;
        };
        return { _id, fields };
      };

      if (replace) {
        const ops = batch.map((serialized) => {
          const { _id, fields } = decode(serialized);
          return { replaceOne: { filter: { _id }, replacement: fields, upsert: true } };
        });
        const result = await collection.bulkWrite(ops, { ordered: false });
        collectionInserted += result.upsertedCount;
        collectionUpdated += result.modifiedCount;
      } else {
        const ops = batch.map((serialized) => {
          const { _id, fields } = decode(serialized);
          return { updateOne: { filter: { _id }, update: { $setOnInsert: fields }, upsert: true } };
        });
        const result = await collection.bulkWrite(ops, { ordered: false });
        collectionInserted += result.upsertedCount;
        collectionUnchanged += result.matchedCount;
      }
    }

    inserted += collectionInserted;
    updated += collectionUpdated;
    unchanged += collectionUnchanged;

    const detail = replace
      ? `${collectionInserted} inserted, ${collectionUpdated} replaced`
      : `${collectionInserted} inserted, ${collectionUnchanged} already present`;
    console.log(`${name}: ${docs.length} in seed → ${detail}`);
  }

  console.log(
    `\nDone. ${inserted} inserted, ${replace ? `${updated} replaced` : `${unchanged} already present`}.`
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
