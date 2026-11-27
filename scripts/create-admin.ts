/**
 * Creates (or resets) a SuperAdmin account in the shop's local database so a
 * fresh install can be logged into.
 *
 * Usage:
 *   npm run db:admin                      → admin@pos.local / Admin@12345
 *   ADMIN_EMAIL=me@shop.local ADMIN_PASSWORD='S3cret!' npm run db:admin
 *
 * Safe to re-run: an existing account with the same email gets its password
 * reset and is re-activated instead of failing on the unique email index.
 */
import { connectDB, disconnectDB, getDatabaseMode } from "@/lib/mongodb";
import { seedRoles } from "@/models/permissions";
import { withoutSyncTracking } from "@/lib/sync/tracking";
import { Branch, Role, User } from "@/models";
import { hashPassword } from "@/utils/auth";
import mongoose from "mongoose";

const EMAIL = (process.env.ADMIN_EMAIL ?? "admin@pos.local").trim().toLowerCase();
const PASSWORD = process.env.ADMIN_PASSWORD ?? "Admin@12345";
const NAME = process.env.ADMIN_NAME ?? "Store Admin";

async function main() {
  await connectDB();
  const db = mongoose.connection.db?.databaseName ?? "?";
  console.log(`[admin] database: ${db} (${getDatabaseMode() ?? "unknown"})`);

  await withoutSyncTracking(async () => {
    await seedRoles();

    const role = await Role.findOne({ name: "SuperAdmin" }).lean();
    if (!role) throw new Error("SuperAdmin role is missing after seedRoles()");

    // The POS is branch-scoped; give a brand-new install somewhere to sell from.
    let branch = await Branch.findOne({ type: "shop", status: "active" }).sort({ createdAt: 1 }).lean();
    if (!branch) {
      branch = await Branch.create({
        name: "Main Store",
        code: "MAIN",
        address: "",
        phone: "",
        currency: "AFN",
        taxRate: 0,
        status: "active",
        type: "shop",
      }).then((created) => created.toObject());
      console.log(`[admin] created branch "${branch.name}" (${branch.code})`);
    }

    const existing = await User.findOne({ email: EMAIL }).lean();
    if (existing) {
      await User.updateOne(
        { _id: existing._id },
        {
          $set: {
            name: NAME,
            passwordHash: hashPassword(PASSWORD),
            roleId: role._id,
            branchId: branch?._id ?? null,
            status: "active",
            refreshTokenHash: null,
            passwordResetTokenHash: null,
            passwordResetExpires: null,
          },
        }
      );
      console.log(`[admin] reset existing account: ${EMAIL}`);
    } else {
      await User.create({
        name: NAME,
        email: EMAIL,
        phone: "",
        passwordHash: hashPassword(PASSWORD),
        roleId: role._id,
        branchId: branch?._id ?? null,
        status: "active",
      });
      console.log(`[admin] created account: ${EMAIL}`);
    }
  });

  console.log("");
  console.log("=== Login ready ===");
  console.log(`  Email:    ${EMAIL}`);
  console.log(`  Password: ${PASSWORD}`);
  console.log(`  Role:     SuperAdmin`);
  console.log("");

  await disconnectDB();
}

main().catch((err) => {
  console.error("[admin] FAILED:", err);
  process.exit(1);
});
