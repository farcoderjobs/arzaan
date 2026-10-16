/**
 * Area 11 — Reports and consistency between dashboard totals and the
 * underlying records. Expected values are recomputed straight from MongoDB
 * with independent aggregations (not by reusing app helpers).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTS, api, authFor, connectDb, type AuthCtx } from "../helpers/qa";
import { Sale, SaleReturn, CustomerTransaction, SupplierTransaction } from "../../src/models";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

describe("reports & dashboard consistency", () => {
  let admin: AuthCtx;

  beforeAll(async () => {
    await connectDb();
    admin = await authFor(ACCOUNTS.admin);
  });

  it("dashboard today KPIs equal independent DB aggregates (sales, refunds, count)", async () => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [salesAgg, returnsAgg, dash] = await Promise.all([
      Sale.aggregate([
        { $match: { status: "completed", createdAt: { $gte: todayStart } } },
        { $group: { _id: null, revenue: { $sum: "$total" }, count: { $sum: 1 } } },
      ]),
      SaleReturn.aggregate([
        {
          $match: {
            status: "approved",
            $expr: { $gte: [{ $ifNull: ["$approvedAt", "$createdAt"] }, todayStart] },
          },
        },
        { $group: { _id: null, refund: { $sum: "$total" } } },
      ]),
      api(admin.token).get("/api/dashboard"),
    ]);

    expect(dash.status).toBe(200);
    const revenue = salesAgg[0]?.revenue ?? 0;
    const refunds = returnsAgg[0]?.refund ?? 0;

    expect(dash.body.today.transactions).toBe(salesAgg[0]?.count ?? 0);
    expect(dash.body.today.sales).toBeCloseTo(round2(revenue - refunds), 2);
    expect(dash.body.today.refunds).toBeCloseTo(round2(refunds), 2);
  });

  it("dashboard receivables equal the customer ledger total; payables equal supplier ledgers", async () => {
    // The dashboard counts only POSITIVE per-entity balances (customers who
    // owe money) — replicate that rule independently from the raw ledgers.
    const [customerLedger, supplierLedger, dash] = await Promise.all([
      CustomerTransaction.aggregate([
        { $group: { _id: "$customerId", balance: { $sum: "$amount" } } },
        { $match: { balance: { $gt: 0.001 } } },
        { $group: { _id: null, total: { $sum: "$balance" } } },
      ]),
      SupplierTransaction.aggregate([
        { $group: { _id: "$supplierId", balance: { $sum: "$amount" } } },
        { $match: { balance: { $gt: 0.001 } } },
        { $group: { _id: null, total: { $sum: "$balance" } } },
      ]),
      api(admin.token).get("/api/dashboard"),
    ]);

    expect(dash.status).toBe(200);
    expect(dash.body.receivables).toBeCloseTo(round2(customerLedger[0]?.total ?? 0), 2);
    expect(dash.body.payables).toBeCloseTo(round2(supplierLedger[0]?.total ?? 0), 2);
  });

  it("sales report (period=day) net sales equals dashboard today sales", async () => {
    const [dash, report] = await Promise.all([
      api(admin.token).get("/api/dashboard"),
      api(admin.token).get("/api/reports/sales?period=day&groupBy=day"),
    ]);

    expect(report.status).toBe(200);
    expect(report.body.summary).toBeTruthy();
    expect(report.body.summary.netSales).toBeCloseTo(dash.body.today.sales, 2);
    expect(report.body.summary.refunds).toBeCloseTo(dash.body.today.refunds, 2);
    expect(report.body.summary.count).toBe(dash.body.today.transactions);
  });

  it("report revenue equals the sum of completed sales in range (from&to covers the run)", async () => {
    const from = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const res = await api(admin.token).get(`/api/reports/sales?from=${from}&to=${to}&groupBy=day`);

    expect(res.status).toBe(200);

    const dbAgg = await Sale.aggregate([
      { $match: { status: "completed", createdAt: { $gte: new Date(from), $lte: new Date(`${to}T23:59:59.999Z`) } } },
      { $group: { _id: null, revenue: { $sum: "$total" }, count: { $sum: 1 } } },
    ]);
    expect(res.body.summary.revenue).toBeCloseTo(round2(dbAgg[0]?.revenue ?? 0), 2);
    expect(res.body.summary.count).toBe(dbAgg[0]?.count ?? 0);
  });

  it("supports every documented groupBy mode", async () => {
    for (const groupBy of ["day", "cashier", "customer", "paymentMethod", "category"]) {
      const res = await api(admin.token).get(`/api/reports/sales?period=day&groupBy=${groupBy}`);
      expect(res.status, `groupBy=${groupBy}`).toBe(200);
      expect(Array.isArray(res.body.rows), `groupBy=${groupBy} rows`).toBe(true);
      expect(res.body.groupBy).toBe(groupBy);
    }
  });

  it("exports the sales report as CSV", async () => {
    const res = await fetch(`${process.env.QA_BASE_URL ?? "http://localhost:3210"}/api/reports/sales?period=day&format=csv`, {
      headers: { cookie: `pos_access_token=${admin.token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/csv");
    const text = await res.text();
    expect(text.split("\n").length).toBeGreaterThan(1);
  });

  it("stock report stats agree with movement-derived stock for a fresh product", async () => {
    const { createProduct, dbStock } = await import("../helpers/qa");
    const product = await createProduct(admin.token, { minimumStock: 5 });
    await api(admin.token).post("/api/inventory", { productId: product._id, quantity: 3, movementType: "ADJUSTMENT_IN", reason: "seed low stock" });

    const res = await api(admin.token).get(`/api/inventory?product=${encodeURIComponent(product.sku)}`);
    expect(res.status).toBe(200);
    const row = res.body.products.find((p: any) => p._id === product._id);
    expect(row).toBeTruthy();
    expect(row.currentStock).toBe(await dbStock(product._id));
    expect(row.currentStock).toBe(3);
    // 3 <= reorderPoint 5 → counted as low stock
    expect(res.body.stats.lowStock).toBeGreaterThanOrEqual(1);
  });
});
