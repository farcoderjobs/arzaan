/**
 * First-run bootstrap: bring the shop's local MongoDB up to date.
 *
 * A shop PC starts with an empty local database. This script copies every
 * replicated collection from the online database (`MONGODB_URI`) into the local
 * one (`MONGODB_LOCAL_URI`) and then seeds roles/permissions, so the POS opens
 * with the same products, customers and settings that exist online.
 *
 * Safe to re-run:
 *  - documents are inserted with `$setOnInsert` by `_id`, so local edits are
 *    never overwritten and nothing is duplicated;
 *  - sync bookkeeping collections are never copied;
 *  - it refuses to run when the two URIs are the same or the local database is
 *    not reachable.
 *
 * Usage:  npx tsx scripts/hydrate-local-db.ts   (or `npm run db:hydrate`)
 */

import mongoose from "mongoose";
import { envSchema } from "@/config/env";
import { connectDB, disconnectDB, getDatabaseMode } from "@/lib/mongodb";
import { getModelRegistry } from "@/lib/sync/registry";
import { SYNC_TRACKED_COLLECTIONS } from "@/lib/sync/collections";
import { withoutSyncTracking } from "@/lib/sync/tracking";
import { seedRoles } from "@/models/permissions";

const BATCH_SIZE = 500;

async function main() {
  const env = envSchema.parse(process.env);
  const localUri = (process.env.MONGODB_LOCAL_URI ?? "").trim();
  const onlineUri = env.MONGODB_URI;

  if (!localUri) {
    console.error("MONGODB_LOCAL_URI is not set — nothing to hydrate.");
    process.exit(1);
  }
  if (localUri === onlineUri) {
    console.error("MONGODB_LOCAL_URI and MONGODB_URI are the same database; refusing to copy onto itself.");
    process.exit(1);
  }

  await connectDB();
  if (getDatabaseMode() !== "local") {
    console.error(
      "The local MongoDB is not reachable, so the app is on the online database. Start it and run this again."
    );
    process.exit(1);
  }

  const local = mongoose.connection.db;
  if (!local) {
    console.error("No local database handle.");
    process.exit(1);
  }

  const hello = (await local.admin().command({ hello: 1 })) as { setName?: string };
  console.log(`Local database: ${local.databaseName} (replica set: ${hello.setName ?? "NONE — start mongod with --replSet"})`);

  // Make sure the local collections have their indexes before bulk inserts
  // (unique barcodes/SKUs would otherwise only be enforced after first use).
  for (const model of getModelRegistry().values()) {
    await model.init().catch(() => undefined);
  }

  console.log(`Reading from the online database…`);
  const online = mongoose.createConnection(onlineUri, {
    dbName: env.MONGODB_DB_NAME,
    serverSelectionTimeoutMS: 15_000,
  });
  await online.asPromise();
  const source = online.db;
  if (!source) {
    console.error("Could not open the online database.");
    process.exit(1);
  }

  let inserted = 0;
  let existing = 0;

  for (const name of SYNC_TRACKED_COLLECTIONS) {
    const docs = await source.collection(name).find({}).toArray();
    if (docs.length === 0) continue;

    let collectionInserted = 0;
    let collectionExisting = 0;

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = docs.slice(i, i + BATCH_SIZE);
      const ops = batch.map((doc) => ({
        updateOne: {
          filter: { _id: doc._id },
          update: { $setOnInsert: doc },
          upsert: true,
        },
      }));
      const result = await local.collection(name).bulkWrite(ops, { ordered: false });
      collectionInserted += result.upsertedCount;
      collectionExisting += result.matchedCount;
    }

    inserted += collectionInserted;
    existing += collectionExisting;
    console.log(
      `${name}: ${docs.length} read → ${collectionInserted} inserted, ${collectionExisting} already present`
    );
  }

  // Raw driver writes bypass mongoose hooks, but seeding roles uses the models:
  // wrap it so the bootstrap itself is never queued for replication.
  await withoutSyncTracking(() => seedRoles());

  console.log(`\nDone. ${inserted} document(s) inserted, ${existing} already present, roles/permissions seeded.`);

  const counts = await Promise.all(
    ["products", "customers", "users", "roles", "sales"].map(async (name) => {
      const total = await local.collection(name).countDocuments().catch(() => 0);
      return `${name}=${total}`;
    })
  );
  console.log(`Local counts: ${counts.join("  ")}`);

  await online.close();
  await disconnectDB();
}

main().catch((err) => {
  console.error("Hydration failed:", err);
  process.exit(1);
});
