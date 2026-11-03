/**
 * Seeds the dedicated QA test database.
 *
 * - Refuses to run against any database whose name does not end in "-test".
 * - Drops the test database first so every run starts from deterministic data.
 * - Creates the system roles (seedRoles) and the QA accounts used by the
 *   integration + e2e suites, two branches, and two branch-scoped managers.
 *
 * Credentials come from the environment (QA_USER_PASSWORD, JWT_SECRET, ...).
 */
import { config as loadDotenv } from "dotenv";

loadDotenv();

async function main() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB_NAME ?? "";

  if (!uri) throw new Error("[qa-seed] MONGODB_URI is not set");
  if (!dbName.endsWith("-test")) {
    throw new Error(
      `[qa-seed] Refusing to seed "${dbName || "<unset>"}": the test database name must end with "-test".`
    );
  }

  const password = process.env.QA_USER_PASSWORD ?? "qa-test-pass-123!";

  // The QA seed bootstraps a database that has no shop node behind it yet, so
  // its writes must stay OUT of the sync outbox: without this, every seeded
  // role, branch and user is queued with no acting user and the first sync run
  // turns the whole bootstrap into permanent PERMISSION_DENIED conflicts.
  process.env.NODE_ROLE = "center";

  // Imported lazily so the guard above runs before any app module reads env.
  const mongoose = (await import("mongoose")).default;
  const { seedRoles } = (await import("../src/models/permissions"));
  const { User, Branch, Role, SyncNode } = (await import("../src/models"));
  const { hashPassword } = (await import("../src/utils/auth"));

  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 20_000 });
  console.log(`[qa-seed] Dropping test database "${dbName}"...`);
  await mongoose.connection.dropDatabase();

  await seedRoles();
  type BranchId = import("mongoose").Types.ObjectId;
  const roles = await Role.find({}).lean<Array<{ _id: unknown; name: string }>>();
  const roleId = (name: string): BranchId => {
    const role = roles.find((r) => r.name === name);
    if (!role) throw new Error(`[qa-seed] Role "${name}" missing after seedRoles()`);
    return role._id as BranchId;
  };

  // --- Branches (fixed codes — the DB is dropped each run, so no collisions) ---
  const branch1 = await Branch.create({
    name: "QA Branch One",
    code: "QAB1",
    address: "Test street 1",
    phone: "0700000001",
    currency: "AFN",
    taxRate: 0,
    status: "active",
  });
  const branch2 = await Branch.create({
    name: "QA Branch Two",
    code: "QAB2",
    address: "Test street 2",
    phone: "0700000002",
    currency: "AFN",
    taxRate: 0,
    status: "active",
  });

  const hash = hashPassword(password);
  const users: Array<{ email: string; name: string; role: string; branchId?: BranchId }> = [
    { email: "qa-admin@qa.test", name: "QA Admin", role: "SuperAdmin" },
    { email: "qa-manager@qa.test", name: "QA Manager", role: "Manager" },
    { email: "qa-cashier@qa.test", name: "QA Cashier", role: "Cashier" },
    { email: "qa-accountant@qa.test", name: "QA Accountant", role: "Accountant" },
    { email: "qa-branch1@qa.test", name: "QA Branch One Manager", role: "Manager", branchId: branch1._id as BranchId },
    { email: "qa-branch2@qa.test", name: "QA Branch Two Manager", role: "Manager", branchId: branch2._id as BranchId },
  ];

  for (const u of users) {
    await User.create({
      name: u.name,
      email: u.email,
      phone: "",
      passwordHash: hash,
      roleId: roleId(u.role),
      branchId: u.branchId ?? null,
      status: "active",
      lastLoginAt: new Date(),
    });
  }

  // A fixed shop-node identity for the e2e suite: the Playwright webServer is
  // started with the matching SYNC_NODE_ID / SYNC_NODE_KEY, and its
  // SYNC_ONLINE_URL points at the center stub the offline-sync spec controls.
  const { hashNodeKey } = (await import("../src/lib/sync/node-auth"));
  const e2eNodeId = "qa-e2e-node";
  const e2eNodeKey = "qa-e2e-node-key-01";
  await SyncNode.create({
    nodeId: e2eNodeId,
    name: "QA E2E node",
    keyHash: hashNodeKey(e2eNodeKey),
    branchId: null,
    status: "active",
  });

  console.log(
    `[qa-seed] Done. Roles: ${roles.map((r) => r.name).join(", ")} | Users: ${users.map((u) => u.email).join(", ")}`
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[qa-seed] FAILED:", err);
  process.exit(1);
});
