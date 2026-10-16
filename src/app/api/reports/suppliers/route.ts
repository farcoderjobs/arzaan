import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Purchase, SupplierTransaction } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { forbidden } from "@/lib/api";
import { round2 } from "@/lib/commerce";
import { parseReportRange, parsePage, escapeRegex, csvResponse } from "@/lib/reports";

/**
 * GET /api/reports/suppliers
 * Params: view=purchases|payments|balances, period | from&to, search,
 *         page, perPage, format=csv
 */

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.reports.purchases))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const range = parseReportRange(searchParams);
    const { page, perPage, skip } = parsePage(searchParams);
    const view = searchParams.get("view")?.trim() || "purchases";
    const search = searchParams.get("search")?.trim() ?? "";

    if (view === "purchases") {
      const baseMatch: Record<string, unknown> = {
        status: { $in: ["completed", "pending"] },
        createdAt: { $gte: range.from, $lte: range.to },
      };
      if (user.branchId) baseMatch.branchId = new mongoose.Types.ObjectId(user.branchId);

      const lookupStages: mongoose.PipelineStage[] = [
        { $lookup: { from: "suppliers", localField: "_id", foreignField: "_id", as: "supplier" } },
        {
          $project: {
            name: { $arrayElemAt: ["$supplier.name", 0] },
            phone: { $arrayElemAt: ["$supplier.phone", 0] },
            total: 1,
            due: 1,
            count: 1,
          },
        },
        ...(search ? [{ $match: { name: new RegExp(escapeRegex(search), "i") } }] : []),
      ];

      const groupStages: mongoose.PipelineStage[] = [
        {
          $group: {
            _id: "$supplierId",
            total: { $sum: "$total" },
            due: { $sum: "$dueAmount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { total: -1 } },
      ];

      const [rowsRaw, totalRaw, totals] = await Promise.all([
        Purchase.aggregate([...baseMatch ? [{ $match: baseMatch }] : [], ...groupStages, ...lookupStages, { $skip: skip }, { $limit: perPage }]),
        Purchase.aggregate([...baseMatch ? [{ $match: baseMatch }] : [], ...groupStages, { $count: "total" }]),
        Purchase.aggregate([...baseMatch ? [{ $match: baseMatch }] : [], { $group: { _id: null, total: { $sum: "$total" }, due: { $sum: "$dueAmount" }, count: { $sum: 1 } } }]),
      ]);

      const rows = rowsRaw.map((r) => ({
        _id: r._id?.toString() ?? "",
        name: r.name ?? "—",
        phone: r.phone ?? "",
        total: round2(r.total ?? 0),
        outstanding: round2(r.due ?? 0),
        orders: r.count ?? 0,
      }));

      if (searchParams.get("format") === "csv") {
        const csvRows: Array<Array<string | number>> = [["Supplier", "Phone", "Purchases", "Outstanding", "Orders"]];
        for (const r of rows) csvRows.push([r.name, r.phone, r.total, r.outstanding, r.orders]);
        csvRows.push([]);
        csvRows.push(["TOTAL", "", round2(totals[0]?.total ?? 0), round2(totals[0]?.due ?? 0), totals[0]?.count ?? 0]);
        return csvResponse(`supplier-purchases-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
      }

      return NextResponse.json({
        view,
        rows,
        total: totalRaw[0]?.total ?? 0,
        page,
        perPage,
        totalPages: Math.ceil((totalRaw[0]?.total ?? 0) / perPage),
        summary: { total: round2(totals[0]?.total ?? 0), outstanding: round2(totals[0]?.due ?? 0), orders: totals[0]?.count ?? 0 },
      });
    }

    if (view === "payments") {
      const match: Record<string, unknown> = { type: "payment" };
      if (user.branchId) match.branchId = new mongoose.Types.ObjectId(user.branchId);
      if (range.from || range.to) match.createdAt = { $gte: range.from, $lte: range.to };

      const [rowsRaw, totalRaw, totals] = await Promise.all([
        SupplierTransaction.aggregate([
          { $match: match },
          {
            $group: {
              _id: "$supplierId",
              paid: { $sum: { $abs: "$amount" } },
              count: { $sum: 1 },
              lastPayment: { $max: "$createdAt" },
            },
          },
          { $sort: { paid: -1 } },
          { $skip: skip },
          { $limit: perPage },
          { $lookup: { from: "suppliers", localField: "_id", foreignField: "_id", as: "supplier" } },
          {
            $project: {
              name: { $arrayElemAt: ["$supplier.name", 0] },
              phone: { $arrayElemAt: ["$supplier.phone", 0] },
              paid: 1,
              count: 1,
              lastPayment: 1,
            },
          },
        ]),
        SupplierTransaction.aggregate([
          { $match: match },
          { $group: { _id: "$supplierId" } },
          { $count: "total" },
        ]),
        SupplierTransaction.aggregate([
          { $match: match },
          { $group: { _id: null, paid: { $sum: { $abs: "$amount" } } } },
        ]),
      ]);

      const rows = rowsRaw.map((r) => ({
        _id: r._id?.toString() ?? "",
        name: r.name ?? "—",
        phone: r.phone ?? "",
        paid: round2(r.paid ?? 0),
        payments: r.count ?? 0,
        lastPayment: r.lastPayment ?? null,
      }));

      if (searchParams.get("format") === "csv") {
        const csvRows: Array<Array<string | number>> = [["Supplier", "Phone", "Total Paid", "Payment Count", "Last Payment"]];
        for (const r of rows) csvRows.push([r.name, r.phone, r.paid, r.payments, r.lastPayment ? new Date(r.lastPayment).toISOString() : ""]);
        return csvResponse(`supplier-payments-report-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
      }

      return NextResponse.json({
        view,
        rows,
        total: totalRaw[0]?.total ?? 0,
        page,
        perPage,
        totalPages: Math.ceil((totalRaw[0]?.total ?? 0) / perPage),
        summary: { paid: round2(totals[0]?.paid ?? 0) },
      });
    }

    // Balances: outstanding payables per supplier
    const ledgerMatch: Record<string, unknown> = {};
    if (user.branchId) ledgerMatch.branchId = new mongoose.Types.ObjectId(user.branchId);

    const [rowsRaw, totalRaw, grand] = await Promise.all([
      SupplierTransaction.aggregate([
        { $match: ledgerMatch },
        { $group: { _id: "$supplierId", balance: { $sum: "$amount" } } },
        { $match: { balance: { $gt: 0.001 } } },
        { $sort: { balance: -1 } },
        { $skip: skip },
        { $limit: perPage },
        { $lookup: { from: "suppliers", localField: "_id", foreignField: "_id", as: "supplier" } },
        {
          $project: {
            name: { $arrayElemAt: ["$supplier.name", 0] },
            phone: { $arrayElemAt: ["$supplier.phone", 0] },
            balance: 1,
          },
        },
        ...(search ? [{ $match: { name: new RegExp(escapeRegex(search), "i") } }] : []),
      ]),
      SupplierTransaction.aggregate([
        { $match: ledgerMatch },
        { $group: { _id: "$supplierId", balance: { $sum: "$amount" } } },
        { $match: { balance: { $gt: 0.001 } } },
        { $count: "total" },
      ]),
      SupplierTransaction.aggregate([
        { $match: ledgerMatch },
        { $group: { _id: "$supplierId", balance: { $sum: "$amount" } } },
        { $match: { balance: { $gt: 0.001 } } },
        { $group: { _id: null, total: { $sum: "$balance" } } },
      ]),
    ]);

    const rows = rowsRaw.map((r) => ({
      _id: r._id?.toString() ?? "",
      name: r.name ?? "—",
      phone: r.phone ?? "",
      balance: round2(r.balance ?? 0),
    }));

    if (searchParams.get("format") === "csv") {
      const csvRows: Array<Array<string | number>> = [["Supplier", "Phone", "Outstanding Payable"]];
      for (const r of rows) csvRows.push([r.name, r.phone, r.balance]);
      csvRows.push([]);
      csvRows.push(["TOTAL PAYABLES", "", round2(grand[0]?.total ?? 0)]);
      return csvResponse(`supplier-balances-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
    }

    return NextResponse.json({
      view,
      rows,
      total: totalRaw[0]?.total ?? 0,
      page,
      perPage,
      totalPages: Math.ceil((totalRaw[0]?.total ?? 0) / perPage),
      summary: { totalPayables: round2(grand[0]?.total ?? 0) },
    });
  } catch (error) {
    console.error("GET /api/reports/suppliers error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
