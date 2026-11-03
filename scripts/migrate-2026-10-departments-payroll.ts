/**
 * Migration: departments, purchase source, attendance/payroll and transfers.
 *
 * Safe to run repeatedly. It NEVER deletes data and never guesses an assumption
 * that could change historical reporting:
 *
 *  - Branch.type            → "shop" for existing branches (they already sell).
 *  - Sale.employeeId        → the cashier who rang the sale.
 *  - Sale.departmentId/name → left null/"" (legacy sales are UNASSIGNED, not
 *    retroactively attributed to today's department).
 *  - Sale item / movement purchaseSource → null (origin unknown before this
 *    release; not assumed Local).
 *  - SaleReturn attribution → copied from the original sale where available;
 *    otherwise remains unassigned.
 *  - New collections + indexes are created.
 *
 * Usage: npx tsx scripts/migrate-2026-10-departments-payroll.ts
 */
import { config as loadDotenv } from "dotenv";

loadDotenv();

async function main() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB_NAME ?? "";
  if (!uri) throw new Error("MONGODB_URI is not set");
  if (!dbName) throw new Error("MONGODB_DB_NAME is not set");

  const mongoose = (await import("mongoose")).default;
  const {
    Branch,
    Sale,
    SaleReturn,
    InventoryMovement,
    Department,
    EmployeeSalary,
    AttendanceRecord,
    PayrollPeriod,
    PayrollEntry,
    StockTransfer,
  } = await import("../src/models");

  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 20_000 });
  console.log(`[migrate] Connected to "${dbName}"`);

  const branches = await Branch.updateMany({ type: { $exists: false } }, { $set: { type: "shop" } });
  console.log(`[migrate] branches.type set to shop: ${branches.modifiedCount}`);

  // Sale attribution is a denormalised snapshot; new sales are written by the
  // service. Legacy sales keep their cashier as the responsible employee and
  // stay explicitly unassigned at department level.
  const salesWithEmployee = await Sale.updateMany(
    { employeeId: { $exists: false } },
    [{ $set: { employeeId: "$cashierId", departmentId: null, departmentName: "" } }]
  );
  console.log(`[migrate] sales attributed to cashier: ${salesWithEmployee.modifiedCount}`);

  const salesWithSource = await Sale.updateMany(
    { "items.purchaseSource": { $exists: false } },
    { $set: { "items.$[].purchaseSource": null } }
  );
  console.log(`[migrate] legacy sale lines marked source-unknown: ${salesWithSource.modifiedCount}`);

  const movementsWithSource = await InventoryMovement.updateMany(
    { purchaseSource: { $exists: false } },
    { $set: { purchaseSource: null } }
  );
  console.log(`[migrate] legacy movements marked source-unknown: ${movementsWithSource.modifiedCount}`);

  // Backfill return attribution from the original sale (only when absent).
  const pendingReturns = await SaleReturn.find({
    $or: [{ employeeId: { $exists: false } }, { departmentId: { $exists: false } }],
  })
    .select("_id saleId")
    .lean();
  let returnsUpdated = 0;
  for (const ret of pendingReturns) {
    const sale = await Sale.findById(ret.saleId).select("employeeId cashierId departmentId departmentName").lean();
    if (!sale) continue;
    await SaleReturn.updateOne(
      { _id: ret._id },
      {
        $set: {
          employeeId: sale.employeeId ?? sale.cashierId ?? null,
          departmentId: sale.departmentId ?? null,
          departmentName: sale.departmentName ?? "",
        },
      }
    );
    returnsUpdated += 1;
  }
  console.log(`[migrate] sale returns attributed from their sale: ${returnsUpdated}`);

  // Create/refresh indexes for the new and changed schemas.
  for (const model of [
    Branch,
    Sale,
    SaleReturn,
    InventoryMovement,
    Department,
    EmployeeSalary,
    AttendanceRecord,
    PayrollPeriod,
    PayrollEntry,
    StockTransfer,
  ]) {
    await model.syncIndexes();
    console.log(`[migrate] indexes synced: ${model.modelName}`);
  }

  console.log("[migrate] Done. No documents were deleted.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[migrate] FAILED:", err);
  process.exit(1);
});
