import { connectDB, disconnectDB } from "@/lib/mongodb";
import { seedRoles } from "@/models/permissions";
import { withoutSyncTracking } from "@/lib/sync/tracking";

async function main() {
  try {
    await connectDB();
    // Seeding is a restore, not a shop edit: queueing dirty markers here would
    // echo the whole role/permission catalog back to the sync center (and can
    // race this process disconnecting).
    await withoutSyncTracking(async () => {
      await seedRoles();
    });
    console.log("Seed complete: roles and permissions created");
  } catch (error) {
    console.error("Seed failed:", error);
    process.exit(1);
  } finally {
    await disconnectDB();
  }
}

main();
