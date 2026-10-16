import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Expense, CashTransaction, CustomerTransaction, SupplierTransaction } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { forbidden } from "@/lib/api";
import { round2 } from "@/lib/commerce";
import { parseReportRange, parsePage, csvResponse } from "@/lib/reports";

/**
 * GET /api/reports/finance
 * Params: view=expenses|cashflow|receivables|payables, period | from&to,
 *         category, page, perPage, format=csv
 */

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.reports.finance))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const range = parseReportRange(searchParams);
    const { page, perPage, skip } = parsePage(searchParams);
    const view = searchParams.get("view")?.trim() || "expenses";
    const category = searchParams.get("category")?.trim() ?? "";

    const branchId = user.branchId ? new mongoose.Types.ObjectId(user.branchId) : null;
    const branchMatch = branchId ? { branchId } : {};

    if (view === "expenses") {
      const match: Record<string, unknown> = {
        status: { $ne: "canceled" },
        date: { $gte: range.from, $lte: range.to },
        ...branchMatch,
      };
      if (category) match.category = category;

      const [byCategory, byDay, totals] = await Promise.all([
        Expense.aggregate([
          { $match: match },
          { $group: { _id: "$category", total: { $sum: "$amount" }, count: { $sum: 1 } } },
          { $sort: { total: -1 } },
        ]),
        Expense.aggregate([
          { $match: match },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
              total: { $sum: "$amount" },
            },
          },
          { $sort: { _id: 1 } },
          { $skip: skip },
          { $limit: perPage },
        ]),
        Expense.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }]),
      ]);

      const expenseTotal = round2(totals[0]?.total ?? 0);

      if (searchParams.get("format") === "csv") {
        const csvRows: Array<Array<string | number>> = [["Category", "Total", "Count"]];
        for (const r of byCategory) csvRows.push([r._id, round2(r.total), r.count]);
        csvRows.push([]);
        csvRows.push(["TOTAL", expenseTotal, totals[0]?.count ?? 0]);
        return csvResponse(`finance-expenses-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
      }

      return NextResponse.json({
        view,
        byCategory: byCategory.map((r) => ({ category: r._id, total: round2(r.total), count: r.count })),
        byDay: byDay.map((r) => ({ day: r._id, total: round2(r.total) })),
        summary: { total: expenseTotal, count: totals[0]?.count ?? 0 },
        page,
        perPage,
      });
    }

    if (view === "cashflow") {
      // Drawer movement totals by day and by type (closing rows excluded from flows)
      const match: Record<string, unknown> = {
        type: { $ne: "closing" },
        createdAt: { $gte: range.from, $lte: range.to },
        ...branchMatch,
      };

      const [byDay, byType, totals] = await Promise.all([
        CashTransaction.aggregate([
          { $match: match },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
              inflow: { $sum: { $cond: [{ $gt: ["$amount", 0] }, "$amount", 0] } },
              outflow: { $sum: { $cond: [{ $lt: ["$amount", 0] }, { $abs: "$amount" }, 0] } },
            },
          },
          { $sort: { _id: 1 } },
          { $skip: skip },
          { $limit: perPage },
        ]),
        CashTransaction.aggregate([
          { $match: match },
          { $group: { _id: "$type", inflow: { $sum: { $cond: [{ $gt: ["$amount", 0] }, "$amount", 0] } }, outflow: { $sum: { $cond: [{ $lt: ["$amount", 0] }, { $abs: "$amount" }, 0] } } } },
          { $sort: { inflow: -1 } },
        ]),
        CashTransaction.aggregate([
          { $match: match },
          {
            $group: {
              _id: null,
              inflow: { $sum: { $cond: [{ $gt: ["$amount", 0] }, "$amount", 0] } },
              outflow: { $sum: { $cond: [{ $lt: ["$amount", 0] }, { $abs: "$amount" }, 0] } },
            },
          },
        ]),
      ]);

      const inflow = round2(totals[0]?.inflow ?? 0);
      const outflow = round2(totals[0]?.outflow ?? 0);

      if (searchParams.get("format") === "csv") {
        const csvRows: Array<Array<string | number>> = [["Day", "Inflow", "Outflow", "Net"]];
        for (const r of byDay) csvRows.push([r._id, round2(r.inflow), round2(r.outflow), round2(r.inflow - r.outflow)]);
        csvRows.push([]);
        csvRows.push(["TOTAL", inflow, outflow, round2(inflow - outflow)]);
        return csvResponse(`finance-cashflow-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
      }

      return NextResponse.json({
        view,
        byDay: byDay.map((r) => ({ day: r._id, inflow: round2(r.inflow), outflow: round2(r.outflow), net: round2(r.inflow - r.outflow) })),
        byType: byType.map((r) => ({ type: r._id, inflow: round2(r.inflow), outflow: round2(r.outflow) })),
        summary: { inflow, outflow, net: round2(inflow - outflow) },
        page,
        perPage,
      });
    }

    if (view === "receivables") {
      const match: Record<string, unknown> = { ...branchMatch };
      const [rowsRaw, grand] = await Promise.all([
        CustomerTransaction.aggregate([
          { $match: match },
          { $group: { _id: "$customerId", balance: { $sum: "$amount" } } },
          { $match: { balance: { $gt: 0.001 } } },
          { $sort: { balance: -1 } },
          { $skip: skip },
          { $limit: perPage },
          { $lookup: { from: "customers", localField: "_id", foreignField: "_id", as: "customer" } },
          { $project: { name: { $arrayElemAt: ["$customer.name", 0] }, balance: 1 } },
        ]),
        CustomerTransaction.aggregate([
          { $match: match },
          { $group: { _id: "$customerId", balance: { $sum: "$amount" } } },
          { $match: { balance: { $gt: 0.001 } } },
          { $group: { _id: null, total: { $sum: "$balance" } } },
        ]),
      ]);

      const rows = rowsRaw.map((r) => ({ _id: r._id?.toString() ?? "", name: r.name ?? "—", balance: round2(r.balance) }));
      const total = rowsRaw.length;

      if (searchParams.get("format") === "csv") {
        const csvRows: Array<Array<string | number>> = [["Customer", "Outstanding"]];
        for (const r of rows) csvRows.push([r.name, r.balance]);
        csvRows.push([]);
        csvRows.push(["TOTAL RECEIVABLES", round2(grand[0]?.total ?? 0)]);
        return csvResponse(`finance-receivables-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
      }

      return NextResponse.json({
        view,
        rows,
        summary: { totalReceivables: round2(grand[0]?.total ?? 0) },
        page,
        perPage,
        totalPages: Math.ceil(total / perPage),
      });
    }

    // payables
    const match: Record<string, unknown> = { ...branchMatch };
    const [rowsRaw, grand] = await Promise.all([
      SupplierTransaction.aggregate([
        { $match: match },
        { $group: { _id: "$supplierId", balance: { $sum: "$amount" } } },
        { $match: { balance: { $gt: 0.001 } } },
        { $sort: { balance: -1 } },
        { $skip: skip },
        { $limit: perPage },
        { $lookup: { from: "suppliers", localField: "_id", foreignField: "_id", as: "supplier" } },
        { $project: { name: { $arrayElemAt: ["$supplier.name", 0] }, balance: 1 } },
      ]),
      SupplierTransaction.aggregate([
        { $match: match },
        { $group: { _id: "$supplierId", balance: { $sum: "$amount" } } },
        { $match: { balance: { $gt: 0.001 } } },
        { $group: { _id: null, total: { $sum: "$balance" } } },
      ]),
    ]);

    const rows = rowsRaw.map((r) => ({ _id: r._id?.toString() ?? "", name: r.name ?? "—", balance: round2(r.balance) }));
    const total = rowsRaw.length;

    if (searchParams.get("format") === "csv") {
      const csvRows: Array<Array<string | number>> = [["Supplier", "Outstanding"]];
      for (const r of rows) csvRows.push([r.name, r.balance]);
      csvRows.push([]);
      csvRows.push(["TOTAL PAYABLES", round2(grand[0]?.total ?? 0)]);
      return csvResponse(`finance-payables-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
    }

    return NextResponse.json({
      view,
      rows,
      summary: { totalPayables: round2(grand[0]?.total ?? 0) },
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    });
  } catch (error) {
    console.error("GET /api/reports/finance error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
