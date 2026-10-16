/**
 * Area 12 — Branch-level data isolation.
 * Uses the two branch-scoped manager accounts seeded by scripts/seed-test-db.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTS, api, authFor, connectDb, createProduct, purgeTag, tag, type AuthCtx } from "../helpers/qa";
import { User, Branch } from "../../src/models";

describe("branch isolation", () => {
  let admin: AuthCtx;
  let b1: AuthCtx;
  let b2: AuthCtx;
  const cleanupTags: string[] = [];

  beforeAll(async () => {
    await connectDb();
    admin = await authFor(ACCOUNTS.admin);
    b1 = await authFor(ACCOUNTS.branch1);
    b2 = await authFor(ACCOUNTS.branch2);
  });

  afterAll(async () => {
    for (const t of cleanupTags) await purgeTag(t).catch(() => undefined);
  });

  it("branch-scoped customers are invisible to the other branch's manager", async () => {
    const t = tag("brc");
    const branches = await Branch.find({ code: { $in: ["QAB1", "QAB2"] } }).lean();
    const branch1 = branches.find((b) => b.code === "QAB1")!;
    const branch2 = branches.find((b) => b.code === "QAB2")!;
    expect(branch1).toBeTruthy();
    expect(branch2).toBeTruthy();

    // Admin creates one customer in each branch
    const c1 = await api(admin.token).post("/api/customers", { name: `QA B1 ${t}`, branchId: String(branch1._id) });
    const c2 = await api(admin.token).post("/api/customers", { name: `QA B2 ${t}`, branchId: String(branch2._id) });
    expect(c1.status).toBe(201);
    expect(c2.status).toBe(201);
    cleanupTags.push(t);

    const list1 = await api(b1.token).get(`/api/customers?search=${encodeURIComponent(`QA B1 ${t}`)}`);
    expect(list1.status).toBe(200);
    expect(list1.body.customers.some((c: any) => c._id === c1.body.data.customer._id)).toBe(true);
    expect(list1.body.customers.some((c: any) => c._id === c2.body.data.customer._id)).toBe(false);

    const list2 = await api(b2.token).get(`/api/customers?search=${encodeURIComponent(`QA B2 ${t}`)}`);
    expect(list2.status).toBe(200);
    expect(list2.body.customers.some((c: any) => c._id === c2.body.data.customer._id)).toBe(true);
    expect(list2.body.customers.some((c: any) => c._id === c1.body.data.customer._id)).toBe(false);
  });

  it("a branch-scoped manager cannot update a customer owned by another branch (403)", async () => {
    const t = tag("brx");
    const branches = await Branch.find({ code: { $in: ["QAB1", "QAB2"] } }).lean();
    const branch1 = branches.find((b) => b.code === "QAB1")!;
    const branch2 = branches.find((b) => b.code === "QAB2")!;

    const c2 = await api(admin.token).post("/api/customers", { name: `QA Owned B2 ${t}`, branchId: String(branch2._id) });
    cleanupTags.push(t);
    expect(c2.status).toBe(201);

    const res = await api(b1.token).post("/api/customers", {
      id: c2.body.data.customer._id,
      name: `QA Owned B2 ${t} hijacked`,
      branchId: String(branch2._id),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("auto-assigns the creator's branch to new customers (no explicit branchId)", async () => {
    const t = tag("brs");
    cleanupTags.push(t);
    const created = await api(b1.token).post("/api/customers", { name: `QA Auto B1 ${t}` });
    expect(created.status).toBe(201);
    expect(created.body.data.customer.branchId).toBeTruthy();

    // Visible to branch1 manager, invisible to branch2 manager
    const forB2 = await api(b2.token).get(`/api/customers?search=${encodeURIComponent(`QA Auto B1 ${t}`)}`);
    expect(forB2.body.customers.some((c: any) => c._id === created.body.data.customer._id)).toBe(false);
  });

  it("sales lists are branch-scoped (branch2 manager never sees branch1 sales)", async () => {
    const branches = await Branch.find({ code: { $in: ["QAB1", "QAB2"] } }).lean();
    const branch1 = branches.find((b) => b.code === "QAB1")!;

    // Branch1 manager makes a sale (needs a register first).
    // Stock is branch-scoped: inventory movements inherit the branch of the
    // supplier the goods were received from (purchase.branchId = supplier.branchId),
    // and adjustments only inherit the product's branch (null for catalog items).
    // So the stock must be received through a branch1 supplier before a
    // branch1-scoped user can see/sell it.
    const { openRegister, createProduct: mkProduct, createSupplier, receiveStock } = await import("../helpers/qa");
    const product = await mkProduct(admin.token, { sellingPrice: 18 });
    cleanupTags.push(product.tag);
    const supplier = await createSupplier(admin.token, { branchId: String(branch1._id) });
    cleanupTags.push(supplier.tag);
    await receiveStock(admin.token, { supplierId: supplier._id, productId: product._id, quantity: 10, purchasePrice: 9 });
    await openRegister(b1.token, 50);

    const sale = await api(b1.token).post("/api/sales", {
      items: [{ productId: product._id, quantity: 1 }],
      payments: [{ method: "cash", amount: 18 }],
    });
    expect(sale.status).toBe(201);

    const invoice = sale.body.data.invoiceNumber;

    // Branch1 manager sees it
    const list1 = await api(b1.token).get(`/api/sales?search=${encodeURIComponent(invoice)}`);
    expect(list1.body.sales.some((s: any) => s.invoiceNumber === invoice)).toBe(true);

    // Branch2 manager does not
    const list2 = await api(b2.token).get(`/api/sales?search=${encodeURIComponent(invoice)}`);
    expect(list2.status).toBe(200);
    expect(list2.body.sales.some((s: any) => s.invoiceNumber === invoice)).toBe(false);

    // The sale document is stamped with branch1
    const { Sale } = await import("../../src/models");
    const doc = await Sale.findOne({ invoiceNumber: invoice }).lean();
    expect(String(doc?.branchId)).toBe(String(branch1._id));
  });

  it("a branch-scoped manager cannot create users for another branch (403)", async () => {
    const branches = await Branch.find({ code: { $in: ["QAB1", "QAB2"] } }).lean();
    const branch2 = branches.find((b) => b.code === "QAB2")!;
    const roles = await (await import("../../src/models")).Role.find({}).lean();
    const managerRole = roles.find((r) => r.name === "Manager")!;

    const res = await api(b1.token).post("/api/users", {
      name: "QA Cross Branch User",
      email: `qa-cross-${tag()}@qa.test`,
      password: "CrossBranch-Pass-1!",
      roleId: String(managerRole._id),
      branchId: String(branch2._id),
    });
    expect(res.status).toBe(403);
  });

  it("dashboard sales are branch-scoped for branch managers", async () => {
    const branches = await Branch.find({ code: { $in: ["QAB1", "QAB2"] } }).lean();
    const branch1 = branches.find((b) => b.code === "QAB1")!;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { Sale } = await import("../../src/models");
    const expected = await Sale.aggregate([
      { $match: { status: "completed", branchId: branch1._id, createdAt: { $gte: todayStart } } },
      { $group: { _id: null, revenue: { $sum: "$total" }, count: { $sum: 1 } } },
    ]);

    const dash = await api(b1.token).get("/api/dashboard");
    expect(dash.status).toBe(200);
    expect(dash.body.today.transactions).toBe(expected[0]?.count ?? 0);
    expect(dash.body.today.sales).toBeCloseTo(Math.round(((expected[0]?.revenue ?? 0) + Number.EPSILON) * 100) / 100, 2);
  });

  it("unrestricted (HQ) admin sees customers of both branches", async () => {
    const t = tag("brhq");
    cleanupTags.push(t);
    const branches = await Branch.find({ code: { $in: ["QAB1", "QAB2"] } }).lean();
    const b1Doc = branches.find((x) => x.code === "QAB1")!;
    const b2Doc = branches.find((x) => x.code === "QAB2")!;

    const c1 = await api(admin.token).post("/api/customers", { name: `QA HQ ${t} B1`, branchId: String(b1Doc._id) });
    const c2 = await api(admin.token).post("/api/customers", { name: `QA HQ ${t} B2`, branchId: String(b2Doc._id) });
    expect(c1.status).toBe(201);
    expect(c2.status).toBe(201);

    const list = await api(admin.token).get(`/api/customers?search=${encodeURIComponent(`QA HQ ${t}`)}`);
    expect(list.body.customers).toHaveLength(2);
  });
});
