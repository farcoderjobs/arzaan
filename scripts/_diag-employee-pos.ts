/** Throwaway diagnostic: why is the POS employee-purchase toggle hidden? */
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "@/lib/mongodb";
import { Permission, Role, User, StoreSettings } from "@/models";

async function main() {
  await connectDB();
  const perms = await Permission.find({ name: { $regex: "^employee_purchases" } }).lean();
  console.log("employee_purchases permissions in catalog:", perms.map((p) => p.name));

  const roles = await Role.find({}).lean();
  for (const role of roles) {
    const names = new Set(
      perms
        .filter((p) => (role.permissions ?? []).some((id) => String(id) === String(p._id)))
        .map((p) => p.name)
    );
    console.log(
      `role=${role.name} system=${role.isSystem} → process=${names.has("employee_purchases.process")} apply_benefit=${names.has("employee_purchases.apply_benefit")} totalPerms=${(role.permissions ?? []).length}`
    );
  }

  const users = await User.find({}).select("name email role status").lean();
  console.log(
    "users:",
    users.map((u) => `${u.name} <${u.email}> role=${String((u as any).role ?? (u as any).roleId ?? "?")} status=${u.status}`)
  );

  const setting = await StoreSettings.find({ key: { $regex: "^employee\\." } }).lean();
  console.log("employee.* settings:", setting.map((s) => `${s.key}=${JSON.stringify(s.value)}`));

  await disconnectDB();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
