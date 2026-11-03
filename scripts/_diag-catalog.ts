/** Throwaway diagnostic: which bonus/employee permissions exist in the catalog? */
import { connectDB, disconnectDB } from "@/lib/mongodb";
import { Permission, Role } from "@/models";

async function main() {
  await connectDB();
  const all = await Permission.find({}).lean();
  console.log("catalog size:", all.length);
  console.log(
    "bonus:*",
    all.filter((p) => p.name.startsWith("bonus.")).map((p) => p.name)
  );
  console.log(
    "employee_purchases:*",
    all.filter((p) => p.name.startsWith("employee_purchases.")).map((p) => p.name)
  );
  const roles = await Role.find({ name: "SuperAdmin" }).lean();
  console.log("SuperAdmin first perms:", (roles[0]?.permissions ?? []).length);
  await disconnectDB();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
