import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Sale, Expense } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { forbidden } from "@/lib/api";
import { round2 } from "@/lib/commerce";
import { parseReportRange, csvResponse } from "@/lib/reports";
import { approvedReturnsTotals, approvedReturnsByDay } from "@/lib/report-returns";

/**
 * GET /api/reports/profit
 * Params: period=day|week|month | from&to (custom), format=csv
 *
 * Revenue is net of approved refunds (returns reduce revenue and COGS the
 * moment they are approved) so these numbers always agree with the dashboard
 * KPI cards for the same window.
 *
 * Gross Profit = Net Revenue − COGS (COGS from the historical sale-item cost price)
 * Net Profit   = Gross Profit − Expenses (non-canceled)
 */

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.reports.profit))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const range = parseReportRange(searchParams);

    const branchId = user.branchId ? new mongoose.Types.ObjectId(user.branchId) : null;
    const saleMatch: Record<string, unknown> = {
      status: "completed",
      createdAt: { $gte: range.from, $lte: range.to },
    };
    if (branchId) saleMatch.branchId = branchId;

    const expenseMatch: Record<string, unknown> = {
      status: { $ne: "canceled" },
      date: { $gte: range.from, $lte: range.to },
    };
    if (branchId) expenseMatch.branchId = branchId;

    // Sale-level net revenue (subtotal − discount, tax-exclusive) — the same
    // definition the dashboard KPI cards use.
    const netRevenueExpr = { $subtract: ["$subtotal", "$discount"] };

    // ---------- Sales aggregates ----------
    // Daily net revenue grouped at the SALE level so sale-level discounts are
    // reflected on the right day (item-level sums miss them).
    const salesNetByDay = await Sale.aggregate([
      { $match: saleMatch },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          netRevenue: { $sum: netRevenueExpr },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const salesTotal = await Sale.aggregate([
      { $match: saleMatch },
      {
        $group: {
          _id: null,
          revenue: { $sum: "$total" },
          netRevenue: { $sum: netRevenueExpr },
          tax: { $sum: "$tax" },
          count: { $sum: 1 },
        },
      },
    ]);

    // COGS recomputed from historical item cost snapshots
    const cogsByDay = await Sale.aggregate([
      { $match: saleMatch },
      { $unwind: "$items" },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          cogs: { $sum: { $multiply: ["$items.costPrice", "$items.quantity"] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    const cogsTotal = cogsByDay.reduce((s, c) => s + (c.cogs ?? 0), 0);

    // ---------- Approved refunds in range (same window rules as the dashboard) ----------
    const [returnsTotals, returnsByDay] = await Promise.all([
      approvedReturnsTotals(range.from, branchId, range.to),
      approvedReturnsByDay(range.from, branchId, range.to),
    ]);

    // ---------- Expenses ----------
    const expensesByCategory = await Expense.aggregate([
      { $match: expenseMatch },
      { $group: { _id: "$category", total: { $sum: "$amount" }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ]);

    const expensesByDay = await Expense.aggregate([
      { $match: expenseMatch },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
          total: { $sum: "$amount" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const expensesTotal = expensesByDay.reduce((s, e) => s + (e.total ?? 0), 0);

    // ---------- Summary (net of approved refunds — matches dashboard KPIs) ----------
    const grossRevenue = round2((salesTotal[0]?.revenue ?? 0) - returnsTotals.refund);
    const netRevenue = round2((salesTotal[0]?.netRevenue ?? 0) - returnsTotals.net);
    const cogs = round2(cogsTotal - returnsTotals.cogs);
    const grossProfit = round2(netRevenue - cogs);
    const expenses = round2(expensesTotal);
    const netProfit = round2(grossProfit - expenses);

    // ---------- Daily series (outer join on day keys, net of refunds) ----------
    const dayMap = new Map<
      string,
      { day: string; revenue: number; refunds: number; cogs: number; grossProfit: number; expenses: number; netProfit: number }
    >();
    const ensureDay = (day: string) => {
      let row = dayMap.get(day);
      if (!row) {
        row = { day, revenue: 0, refunds: 0, cogs: 0, grossProfit: 0, expenses: 0, netProfit: 0 };
        dayMap.set(day, row);
      }
      return row;
    };

    for (const s of salesNetByDay) {
      ensureDay(s._id).revenue = round2(s.netRevenue ?? 0);
    }
    for (const r of returnsByDay) {
      const row = ensureDay(r.day);
      row.refunds = r.refund;
      row.revenue = round2(row.revenue - r.net);
    }
    for (const c of cogsByDay) {
      ensureDay(c._id).cogs = round2(c.cogs ?? 0);
    }
    for (const r of returnsByDay) {
      const row = ensureDay(r.day);
      row.cogs = round2(row.cogs - r.cogs);
    }
    for (const e of expensesByDay) {
      ensureDay(e._id).expenses = round2(e.total ?? 0);
    }
    for (const row of dayMap.values()) {
      row.grossProfit = round2(row.revenue - row.cogs);
      row.netProfit = round2(row.grossProfit - row.expenses);
    }
    const daily = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));

    if (searchParams.get("format") === "csv") {
      const csvRows: Array<Array<string | number>> = [
        ["Day", "Revenue (net)", "Refunds", "COGS", "Gross Profit", "Expenses", "Net Profit"],
        ...daily.map((d) => [d.day, d.revenue, d.refunds, d.cogs, d.grossProfit, d.expenses, d.netProfit]),
        [],
        ["TOTAL (range)", netRevenue, returnsTotals.refund, cogs, grossProfit, expenses, netProfit],
      ];
      return csvResponse(`profit-report-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
    }

    return NextResponse.json({
      range: { from: range.from, to: range.to },
      summary: {
        revenue: netRevenue,
        grossRevenue,
        tax: round2(salesTotal[0]?.tax ?? 0),
        refunds: returnsTotals.refund,
        cogs,
        grossProfit,
        expenses,
        netProfit,
        salesCount: salesTotal[0]?.count ?? 0,
        returnsCount: returnsTotals.count,
        margin: netRevenue ? round2((grossProfit / netRevenue) * 100) : 0,
      },
      expensesByCategory: expensesByCategory.map((e) => ({ category: e._id, total: round2(e.total), count: e.count })),
      daily,
    });
  } catch (error) {
    console.error("GET /api/reports/profit error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
