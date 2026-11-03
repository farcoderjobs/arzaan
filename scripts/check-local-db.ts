/**
 * Readiness report for the shop PC's local database.
 *
 * Usage: npm run db:check
 *
 * Answers the three questions that decide whether the POS can work offline:
 *   1. Is the app actually connected to the LOCAL database?
 *   2. Is it a replica set (sales need transactions)?
 *   3. Does it already contain the shop's data and users?
 */

import mongoose from "mongoose";
import { connectDB, disconnectDB, getDatabaseMode, hasLocalDatabase } from "@/lib/mongodb";
import { probeLocalDatabase } from "@/lib/sync/local-db";
import { Role, User } from "@/models";

async function main() {
  await connectDB();
  const info = await probeLocalDatabase(true);
  const mode = getDatabaseMode();

  console.log(`MONGODB_LOCAL_URI configured: ${hasLocalDatabase() ? "yes" : "no"}`);
  console.log(`Active database mode:         ${mode ?? "unknown"}`);
  console.log(`Database:                     ${info.dbName ?? "?"}`);
  console.log(`Topology:                     ${info.topology ?? "standalone (NOT a replica set)"}`);
  console.log(`Transactions supported:       ${info.transactionsSupported ? "yes" : "NO — sales will fail"}`);

  if (mode === "fallback") {
    console.log("\nThe local MongoDB is not reachable, so the app is on the online database.");
    console.log("Start the MongoDB service, then restart the app.");
  }

  const db = mongoose.connection.db;
  if (db) {
    const counts = await Promise.all(
      ["products", "customers", "users", "roles", "sales", "purchases", "inventorymovements"].map(
        async (name) => `${name}=${await db.collection(name).countDocuments().catch(() => 0)}`
      )
    );
    console.log(`\nRows: ${counts.join("  ")}`);
  }

  // Which accounts can actually use the POS features that are permission-gated.
  const users = (await User.find({ status: "active" })
    .select("name email roleId")
    .populate<{ roleId: { name: string; permissions: mongoose.Types.ObjectId[] } | null }>("roleId", "name permissions")
    .lean()) as Array<{ name: string; email: string; roleId?: { name?: string } | null }>;

  const roles = (await Role.find({}).populate("permissions", "name").lean()) as unknown as Array<{
    name: string;
    permissions?: Array<{ name: string }>;
  }>;
  const wholesale = new Set(
    roles.filter((r) => (r.permissions ?? []).some((p) => p.name === "sales.wholesale")).map((r) => r.name)
  );

  console.log("\nActive accounts (wholesale = can use the POS wholesale toggle):");
  for (const u of users) {
    const role = u.roleId?.name ?? "?";
    console.log(`  ${u.email} — ${role}${wholesale.has(role) ? " · wholesale" : ""}`);
  }

  await disconnectDB();
}

main().catch((err) => {
  console.error("Check failed:", err);
  process.exit(1);
});
