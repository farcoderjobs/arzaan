/**
 * Exports the current database into `data/seed/seed-data.json`.
 *
 * The result is the seed used by `npm run seed:data` to bring a fresh install
 * (a new shop PC, a staging box, a client server) up with exactly the data this
 * installation has: branches, users, roles/permissions, settings, catalogue,
 * customers, suppliers, store products, and any business history.
 *
 * Rules:
 *  - only replicated business collections are exported; the sync bookkeeping
 *    collections (`syncoutbox`, `syncruns`, `syncstates`, `syncappliedops`,
 *    `syncconflicts`, `syncnodes`) are runtime state and are never seeded;
 *  - session material (`refreshTokenHash`, password-reset fields) is stripped —
 *    the snapshot is committed to git, so live tokens must not travel with it;
 *  - documents keep their `_id`/dates in MongoDB Extended JSON, so a restore
 *    preserves relationships and history exactly instead of minting new ids.
 *
 * Usage:  npm run seed:export
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { connectDB, disconnectDB, getDatabaseMode } from "@/lib/mongodb";
import { getModelRegistry } from "@/lib/sync/registry";
import { SYNC_TRACKED_COLLECTIONS, collectionPriority } from "@/lib/sync/collections";

const EJSON = mongoose.mongo.BSON.EJSON;

/** Never commit live session material. */
const REDACTED_FIELDS = ["refreshTokenHash", "passwordResetTokenHash", "passwordResetExpires"];

const OUT_FILE = path.join(process.cwd(), "data", "seed", "seed-data.json");

type Snapshot = {
  meta: { exportedAt: string; sourceDatabase: string; generator: string };
  counts: Record<string, number>;
  collections: Array<{ name: string; docs: Array<Record<string, unknown>> }>;
};

async function main() {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) {
    console.error("No database handle.");
    process.exit(1);
  }

  // Parents before children, so a reader (and the seeder) sees a stable order.
  const names = [...new Set([...getModelRegistry().keys(), ...SYNC_TRACKED_COLLECTIONS])].sort(
    (a, b) => collectionPriority(a) - collectionPriority(b) || a.localeCompare(b)
  );

  const snapshot: Snapshot = {
    meta: {
      exportedAt: new Date().toISOString(),
      sourceDatabase: db.databaseName,
      generator: "scripts/export-seed-data.ts",
    },
    counts: {},
    collections: [],
  };

  let total = 0;

  for (const name of names) {
    const docs = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
    if (docs.length === 0) continue;

    for (const doc of docs) {
      for (const field of REDACTED_FIELDS) delete (doc as Record<string, unknown>)[field];
    }

    snapshot.collections.push({
      name,
      docs: docs.map((doc) => EJSON.serialize(doc, { relaxed: true }) as Record<string, unknown>),
    });
    snapshot.counts[name] = docs.length;
    total += docs.length;
    console.log(`${name}: ${docs.length}`);
  }

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  console.log(
    `\nExported ${total} document(s) from ${db.databaseName} (active database mode: ${getDatabaseMode() ?? "unknown"})`
  );
  console.log(`Written to ${path.relative(process.cwd(), OUT_FILE)}`);

  await disconnectDB();
}

main().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
