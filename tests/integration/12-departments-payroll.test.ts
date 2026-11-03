/**
 * Departments, Import/Local purchase restrictions, department reporting and
 * attendance-based payroll — exercised through the real HTTP API.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACCOUNTS,
  api,
  authFor,
  checkoutPayload,
  connectDb,
  createProduct,
  createSupplier,
  dbStock,
  openRegister,
  purgeTag,
  receiveStock,
  tag,
  type AuthCtx,
} from "../helpers/qa";
import {
  AttendanceRecord,
  AuditLog,
  Branch,
  Department,
  EmployeeSalary,
  InventoryMovement,
  PayrollEntry,
  PayrollPeriod,
  Product,
  Purchase,
  Sale,
  User,
} from "../../src/models";

describe("departments, purchase source, department reports & payroll", () => {
  let admin: AuthCtx;
  let branch1: AuthCtx;
  let branch2: AuthCtx;
  let accountant: AuthCtx;
  let branch1Id: string;
  let branch2Id: string;
  let branch1User: { _id: unknown; name: string };

  const cleanupTags: string[] = [];
  const departmentIds: string[] = [];
  const payrollPeriods: string[] = [];

  beforeAll(async () => {
    await connectDb();
    admin = await authFor(ACCOUNTS.admin);
    branch1 = await authFor(ACCOUNTS.branch1);
    branch2 = await authFor(ACCOUNTS.branch2);
    accountant = await authFor(ACCOUNTS.accountant);

    const branches = await Branch.find({ code: { $in: ["QAB1", "QAB2"] } }).lean();
    branch1Id = String(branches.find((b) => b.code === "QAB1")!._id);
    branch2Id = String(branches.find((b) => b.code === "QAB2")!._id);
    const user = await User.findById(branch1.userId).lean();
    branch1User = { _id: user!._id, name: user!.name };
  });

  afterAll(async () => {
    await connectDb();
    await Department.deleteMany({ _id: { $in: departmentIds } }).catch(() => undefined);
    await EmployeeSalary.deleteMany({ userId: branch1.userId }).catch(() => undefined);
    await AttendanceRecord.deleteMany({ userId: branch1.userId, dateKey: { $regex: "^2026-01-" } }).catch(() => undefined);
    for (const period of payrollPeriods) {
      const payroll = await PayrollPeriod.findOne({ branchId: branch1Id, period }).lean().catch(() => null);
      if (payroll) {
        await PayrollEntry.deleteMany({ payrollId: payroll._id }).catch(() => undefined);
        await PayrollPeriod.deleteOne({ _id: payroll._id }).catch(() => undefined);
      }
    }
    for (const t of cleanupTags) await purgeTag(t).catch(() => undefined);
  });

  // -------------------------------------------------------------------------
  // Departments
  // -------------------------------------------------------------------------

  /** Frees the branch1 employee so a test can head a fresh department. */
  async function freeDepartmentHead() {
    await Department.updateMany(
      { branchId: branch1Id, employeeId: branch1.userId, status: "active" },
      { $set: { status: "inactive" } }
    );
  }

  async function createDepartment(overrides: Record<string, unknown> = {}) {
    await freeDepartmentHead();
    const name = `QA Dept ${tag("dep")}`;
    const res = await api(admin.token).post("/api/departments", {
      name,
      branchId: branch1Id,
      employeeId: branch1.userId,
      ...overrides,
    });
    if (res.status === 201) departmentIds.push(res.body.data.department._id);
    return { res, name };
  }

  it("creates a department with an assigned employee and lists it", async () => {
    const { res, name } = await createDepartment({ code: "QA1" });
    expect(res.status).toBe(201);
    expect(res.body.data.department.name).toBe(name);
    expect(res.body.data.department.branchId).toBe(branch1Id);
    expect(res.body.data.department.employeeId).toBe(branch1.userId);
    expect(res.body.data.department.status).toBe("active");

    const list = await api(branch1.token).get("/api/departments?all=1");
    expect(list.status).toBe(200);
    expect(list.body.departments.some((d: any) => d._id === res.body.data.department._id)).toBe(true);
  });

  it("rejects a duplicate department name in the same shop", async () => {
    const { res, name } = await createDepartment();
    expect(res.status).toBe(201);
    const duplicate = await api(admin.token).post("/api/departments", {
      name,
      branchId: branch1Id,
      employeeId: branch1.userId,
    });
    expect(duplicate.status).toBe(400);
  });

  it("rejects assigning one employee to two active departments", async () => {
    const first = await createDepartment();
    expect(first.res.status).toBe(201);
    // Bypass the helper's cleanup on purpose: the employee already heads an
    // active department, so a second assignment must be refused.
    const second = await api(admin.token).post("/api/departments", {
      name: `QA Dept ${tag("dep")}`,
      branchId: branch1Id,
      employeeId: branch1.userId,
    });
    expect(second.status).toBe(400);
    expect(String(second.body.error.message)).toMatch(/another active department|already heads/i);
  });

  it("rejects an employee from another shop", async () => {
    const otherUser = await User.findById(branch2.userId).lean();
    expect(otherUser).toBeTruthy();
    const res = await api(admin.token).post("/api/departments", {
      name: `QA Cross Dept ${tag("dep")}`,
      branchId: branch1Id,
      employeeId: String(otherUser!._id),
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error.message)).toMatch(/same shop/i);
  });

  it("keeps departments invisible to a manager of another shop", async () => {
    const { res } = await createDepartment();
    expect(res.status).toBe(201);
    const list = await api(branch2.token).get("/api/departments?all=1");
    expect(list.status).toBe(200);
    expect(list.body.departments.some((d: any) => d._id === res.body.data.department._id)).toBe(false);

    const edit = await api(branch2.token).put("/api/departments", {
      id: res.body.data.department._id,
      name: "hijacked",
    });
    expect(edit.status).toBe(403);
  });

  it("refuses department creation for cashiers without permission", async () => {
    const cashier = await authFor(ACCOUNTS.cashier);
    const res = await api(cashier.token).post("/api/departments", {
      name: "Nope",
      branchId: branch1Id,
      employeeId: branch1.userId,
    });
    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Purchase source (Import vs Local)
  // -------------------------------------------------------------------------

  it("allows Local purchases for buyers and blocks Import for non-managers", async () => {
    // Suppliers are created by the branch manager; the Accountant can purchase
    // (purchases.create) but holds no purchases.import permission.
    const supplier = await createSupplier(branch1.token);
    const product = await createProduct(admin.token);
    cleanupTags.push(supplier.tag, product.tag);

    const local = await api(accountant.token).post("/api/purchases", {
      action: "create",
      supplierId: supplier._id,
      purchaseSource: "local",
      items: [{ productId: product._id, quantity: 2, purchasePrice: 5 }],
      paidAmount: 0,
      paymentMethod: "account",
    });
    expect(local.status).toBe(201);
    expect(local.body.data.purchase.purchaseSource).toBe("local");

    const imported = await api(accountant.token).post("/api/purchases", {
      action: "create",
      supplierId: supplier._id,
      purchaseSource: "import",
      items: [{ productId: product._id, quantity: 2, purchasePrice: 5 }],
      paidAmount: 0,
      paymentMethod: "account",
    });
    expect(imported.status).toBe(403);
  });

  it("stores the source on the purchase and on the received stock movement", async () => {
    const supplier = await createSupplier(admin.token);
    const product = await createProduct(admin.token);
    cleanupTags.push(supplier.tag, product.tag);

    const res = await api(admin.token).post("/api/purchases", {
      action: "create",
      supplierId: supplier._id,
      purchaseSource: "import",
      items: [
        {
          productId: product._id,
          quantity: 5,
          purchasePrice: 7,
          expirationDate: "2027-06-30",
          batchNumber: `B-${tag("b")}`,
        },
      ],
      paidAmount: 0,
      paymentMethod: "account",
    });
    expect(res.status).toBe(201);
    const purchaseId = res.body.data.purchase._id;

    const purchase = await Purchase.findById(purchaseId).lean();
    expect(purchase?.purchaseSource).toBe("import");

    const movement = await InventoryMovement.findOne({ referenceId: purchaseId, movementType: "PURCHASE_IN" }).lean();
    expect(movement?.purchaseSource).toBe("import");
    expect(movement?.expirationDate).toBeTruthy();
  });

  it("traces the purchase source onto the sale line and its stock movement", async () => {
    const supplier = await createSupplier(admin.token);
    const product = await createProduct(admin.token, { sellingPrice: 20 });
    cleanupTags.push(supplier.tag, product.tag);

    await api(admin.token).post("/api/purchases", {
      action: "create",
      supplierId: supplier._id,
      purchaseSource: "import",
      items: [{ productId: product._id, quantity: 5, purchasePrice: 8, batchNumber: `B-${tag("b")}` }],
      paidAmount: 0,
      paymentMethod: "account",
    });

    await openRegister(admin.token, 0);
    const sale = await api(admin.token).post("/api/sales", checkoutPayload({
      items: [{ productId: product._id, quantity: 2 }],
      payments: [{ method: "cash", amount: 40 }],
    }));
    expect(sale.status).toBe(201);
    const stored = await Sale.findById(sale.body.data.id).lean();
    expect(stored?.items[0]?.purchaseSource).toBe("import");
    const out = await InventoryMovement.findOne({ referenceId: stored!._id, movementType: "SALE_OUT" }).lean();
    expect(out?.purchaseSource).toBe("import");
  });

  // -------------------------------------------------------------------------
  // Department sales reporting
  // -------------------------------------------------------------------------

  it("reports department sales, returns and profit without double counting", async () => {
    const dept = await createDepartment();
    expect(dept.res.status).toBe(201);
    const departmentId = dept.res.body.data.department._id;

    const supplier = await createSupplier(branch1.token);
    const product = await createProduct(admin.token, { sellingPrice: 30, purchasePrice: 12 });
    cleanupTags.push(supplier.tag, product.tag);
    await receiveStock(branch1.token, { supplierId: supplier._id, productId: product._id, quantity: 10, purchasePrice: 12 });
    await openRegister(branch1.token, 0);

    const sale = await api(branch1.token).post("/api/sales", checkoutPayload({
      items: [{ productId: product._id, quantity: 2 }],
      payments: [{ method: "cash", amount: 60 }],
    }));
    expect(sale.status).toBe(201);

    const stored = await Sale.findById(sale.body.data.id).lean();
    expect(stored?.departmentId?.toString()).toBe(departmentId);
    expect(stored?.departmentName).toBe(dept.name);
    expect(stored?.employeeId?.toString()).toBe(branch1.userId);

    const today = new Date().toISOString().slice(0, 10);
    const base = await api(admin.token).get(
      `/api/reports/departments?from=${today}&to=${today}&groupBy=department&departmentId=${departmentId}`
    );
    expect(base.status).toBe(200);
    const row = base.body.rows.find((r: any) => r.key === departmentId);
    expect(row).toBeTruthy();
    expect(row.grossSales).toBeCloseTo(60, 2);
    expect(row.netSales).toBeCloseTo(60, 2);
    expect(row.cogs).toBeCloseTo(24, 2);
    expect(row.profit).toBeCloseTo(36, 2);

    const ret = await api(branch1.token).post("/api/sales-returns", {
      saleId: sale.body.data.id,
      items: [{ productId: product._id, quantity: 1 }],
      refundMethod: "cash",
      reason: `QA return ${tag("r")}`,
    });
    expect(ret.status).toBe(201);

    const after = await api(admin.token).get(
      `/api/reports/departments?from=${today}&to=${today}&groupBy=department&departmentId=${departmentId}`
    );
    const rowAfter = after.body.rows.find((r: any) => r.key === departmentId);
    expect(rowAfter.grossSales).toBeCloseTo(60, 2);
    expect(rowAfter.returns).toBeCloseTo(30, 2);
    expect(rowAfter.netSales).toBeCloseTo(30, 2);
    expect(rowAfter.cogs).toBeCloseTo(12, 2);
    expect(rowAfter.profit).toBeCloseTo(18, 2);

    // Historical attribution survives deactivation.
    const deactivate = await api(admin.token).patch("/api/departments", { action: "deactivate", id: departmentId });
    expect(deactivate.status).toBe(200);
    const saleAfterDeactivate = await Sale.findById(sale.body.data.id).lean();
    expect(saleAfterDeactivate?.departmentId?.toString()).toBe(departmentId);
    expect(saleAfterDeactivate?.departmentName).toBe(dept.name);
  });

  it("refuses department reports for roles without the permission", async () => {
    const cashier = await authFor(ACCOUNTS.cashier);
    const res = await api(cashier.token).get("/api/reports/departments");
    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Attendance + payroll
  // -------------------------------------------------------------------------

  it("applies the seven-day allowance and deducts one day's salary beyond it", async () => {
    const period = "2026-01";
    payrollPeriods.push(period);

    const salary = await api(admin.token).post("/api/payroll", {
      action: "set-salary",
      userId: branch1.userId,
      monthlySalary: 3100,
      note: `QA salary ${tag("sal")}`,
    });
    expect(salary.status).toBe(200);

    // Eight working-day absences in January 2026 (Fridays are rest days).
    const absenceDays = ["01", "05", "06", "07", "08", "12", "13", "14"];
    for (const day of absenceDays) {
      const mark = await api(admin.token).post("/api/attendance", {
        action: "mark",
        userId: branch1.userId,
        date: `${period}-${day}`,
        status: "absent",
        note: "qa absence",
      });
      expect(mark.status).toBe(200);
    }

    const generated = await api(admin.token).post("/api/payroll", { action: "generate", period, branchId: branch1Id });
    expect(generated.status).toBe(201);

    const payroll = await PayrollPeriod.findOne({ branchId: branch1Id, period }).lean();
    expect(payroll?.status).toBe("draft");
    const entry = await PayrollEntry.findOne({ payrollId: payroll!._id, userId: branch1.userId }).lean();
    expect(entry).toBeTruthy();
    expect(entry!.calendarDays).toBe(31);
    expect(entry!.dailyRate).toBe(100);
    expect(entry!.absentDays).toBe(8);
    expect(entry!.allowanceDays).toBe(7);
    expect(entry!.unpaidAbsenceDays).toBe(1);
    expect(entry!.deduction).toBe(100);
    expect(entry!.netPayable).toBe(3000);

    // Regenerating a draft replaces the entries instead of duplicating them.
    const regenerated = await api(admin.token).post("/api/payroll", { action: "generate", period, branchId: branch1Id });
    expect(regenerated.status).toBe(201);
    expect(await PayrollEntry.countDocuments({ payrollId: payroll!._id, userId: branch1.userId })).toBe(1);

    // Attendance changes are audited.
    const audit = await AuditLog.findOne({ entityType: "AttendanceRecord", action: "attendance.mark" }).lean();
    expect(audit).toBeTruthy();
  });

  it("finalizes once, refuses regeneration, and prevents duplicate/over payments", async () => {
    const period = "2026-01";
    const finalize = await api(admin.token).post("/api/payroll", { action: "finalize", period, branchId: branch1Id });
    expect(finalize.status).toBe(200);

    const regenerate = await api(admin.token).post("/api/payroll", { action: "generate", period, branchId: branch1Id });
    expect(regenerate.status).toBe(400);
    expect(String(regenerate.body.error.message)).toMatch(/finalized/i);

    const payroll = await PayrollPeriod.findOne({ branchId: branch1Id, period }).lean();
    const entry = await PayrollEntry.findOne({ payrollId: payroll!._id, userId: branch1.userId }).lean();
    expect(entry!.status).toBe("unpaid");

    const partial = await api(admin.token).post("/api/payroll", {
      action: "pay",
      period,
      branchId: branch1Id,
      userId: branch1.userId,
      amount: 1000,
    });
    expect(partial.status).toBe(200);
    expect(partial.body.data.status).toBe("partial");

    const tooMuch = await api(admin.token).post("/api/payroll", {
      action: "pay",
      period,
      branchId: branch1Id,
      userId: branch1.userId,
      amount: 5000,
    });
    expect(tooMuch.status).toBe(400);

    const rest = await api(admin.token).post("/api/payroll", {
      action: "pay",
      period,
      branchId: branch1Id,
      userId: branch1.userId,
      amount: 2000,
    });
    expect(rest.status).toBe(200);
    expect(rest.body.data.status).toBe("paid");

    const again = await api(admin.token).post("/api/payroll", {
      action: "pay",
      period,
      branchId: branch1Id,
      userId: branch1.userId,
      amount: 10,
    });
    expect(again.status).toBe(400);
  });

  it("honours a corrected absence: clearing it removes the deduction on a draft month", async () => {
    const period = "2026-02";
    payrollPeriods.push(period);

    await api(admin.token).post("/api/payroll", { action: "set-salary", userId: branch1.userId, monthlySalary: 2800 });

    // Mark eight absences, then correct one back to present.
    const days = ["02", "03", "04", "05", "09", "10", "11", "12"];
    for (const day of days) {
      await api(admin.token).post("/api/attendance", {
        action: "mark",
        userId: branch1.userId,
        date: `${period}-${day}`,
        status: "absent",
      });
    }
    const clearance = await api(admin.token).post("/api/attendance", {
      action: "clear",
      userId: branch1.userId,
      date: `${period}-02`,
    });
    expect(clearance.status).toBe(200);

    const generated = await api(admin.token).post("/api/payroll", { action: "generate", period, branchId: branch1Id });
    expect(generated.status).toBe(201);
    const payroll = await PayrollPeriod.findOne({ branchId: branch1Id, period }).lean();
    const entry = await PayrollEntry.findOne({ payrollId: payroll!._id, userId: branch1.userId }).lean();
    expect(entry!.absentDays).toBe(7);
    expect(entry!.unpaidAbsenceDays).toBe(0);
    expect(entry!.deduction).toBe(0);
    expect(entry!.netPayable).toBe(2800);
  });

  it("only lets managers/admins change attendance and payroll", async () => {
    const cashier = await authFor(ACCOUNTS.cashier);
    const attendance = await api(cashier.token).post("/api/attendance", {
      action: "mark",
      userId: branch1.userId,
      date: "2026-03-02",
      status: "absent",
    });
    expect(attendance.status).toBe(403);

    const payroll = await api(cashier.token).get("/api/payroll");
    expect(payroll.status).toBe(403);
  });
});
