import { connectDB, disconnectDB } from "@/lib/mongodb";
import { seedRoles } from "@/models/permissions";

async function main() {
  try {
    await connectDB();
    await seedRoles();
    console.log("Seed complete: roles and permissions created");
  } catch (error) {
    console.error("Seed failed:", error);
    process.exit(1);
  } finally {
    await disconnectDB();
  }
}

main();
