import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Sale, CustomerTransaction, CustomerBonusTransaction, Customer, User } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { forbidden } from "@/lib/api";
import { round2 } from "@/lib/commerce";
import { parseReportRange, parsePage, escapeRegex, csvResponse } from "@/lib/reports";

/**
 * GET /api/reports/customers
 * Params: view=purchases|payments|balances, period | from&to, search,
 *         page, perPage, format=csv
 */

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    const { searchParams } = new URL(req.url);
    const view = searchParams.get("view")?.trim() || "purchases";
    const canSalesReports = await hasPermission(user, PERMISSIONS.reports.sales);
    const canBonusReports = await hasPermission(user, PERMISSIONS.bonus.reports);
    // Reward-credit reporting is its own permission; sales reports also covers it
    // so existing report roles keep working unchanged.
    const allowed = view === "bonus" ? canSalesReports || canBonusReports : canSalesReports;
    if (!allowed) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const range = parseReportRange(searchParams);
    const { page, perPage, skip } = parsePage(searchParams);
    const search = searchParams.get("search")?.trim() ?? "";

    const searchStage: mongoose.PipelineStage[] = search
      ? [{ $match: { name: new RegExp(escapeRegex(search), "i") } }]
      : [];

    if (view === "purchases") {
      const baseMatch: Record<string, unknown> = {
        status: "completed",
        createdAt: { $gte: range.from, $lte: range.to },
        customerId: { $ne: null },
      };
      if (user.branchId) baseMatch.branchId = new mongoose.Types.ObjectId(user.branchId);

      const [rowsRaw, totalRaw, totals] = await Promise.all([
        Sale.aggregate([
          { $match: baseMatch },
          {
            $group: {
              _id: "$customerId",
              total: { $sum: "$total" },
              count: { $sum: 1 },
              lastPurchase: { $max: "$createdAt" },
            },
          },
          { $sort: { total: -1 } },
          { $skip: skip },
          { $limit: perPage },
          { $lookup: { from: "customers", localField: "_id", foreignField: "_id", as: "customer" } },
          {
            $project: {
              name: { $arrayElemAt: ["$customer.name", 0] },
              phone: { $arrayElemAt: ["$customer.phone", 0] },
              total: 1,
              count: 1,
              lastPurchase: 1,
            },
          },
        ]),
        Sale.aggregate([
          { $match: baseMatch },
          { $group: { _id: "$customerId" } },
          { $count: "total" },
        ]),
        Sale.aggregate([
          { $match: baseMatch },
          { $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } },
        ]),
      ]);

      const rows = rowsRaw.map((r) => ({
        _id: r._id?.toString() ?? "",
        name: r.name ?? "—",
        phone: r.phone ?? "",
        total: round2(r.total ?? 0),
        orders: r.count ?? 0,
        lastPurchase: r.lastPurchase ?? null,
      }));

      if (searchParams.get("format") === "csv") {
        const csvRows: Array<Array<string | number>> = [["Customer", "Phone", "Purchases", "Orders", "Last Purchase"]];
        for (const r of rows) csvRows.push([r.name, r.phone, r.total, r.orders, r.lastPurchase ? new Date(r.lastPurchase).toISOString() : ""]);
        return csvResponse(`customer-purchases-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
      }

      return NextResponse.json({
        view,
        rows,
        total: totalRaw[0]?.total ?? 0,
        page,
        perPage,
        totalPages: Math.ceil((totalRaw[0]?.total ?? 0) / perPage),
        summary: { total: round2(totals[0]?.total ?? 0), orders: totals[0]?.count ?? 0 },
      });
    }

    if (view === "payments") {
      const match: Record<string, unknown> = { type: "PAYMENT" };
      if (user.branchId) match.branchId = new mongoose.Types.ObjectId(user.branchId);
      if (range.from || range.to) match.createdAt = { $gte: range.from, $lte: range.to };

      const [rowsRaw, totalRaw, totals] = await Promise.all([
        CustomerTransaction.aggregate([
          { $match: match },
          {
            $group: {
              _id: "$customerId",
              paid: { $sum: { $abs: "$amount" } },
              count: { $sum: 1 },
              lastPayment: { $max: "$createdAt" },
            },
          },
          { $sort: { paid: -1 } },
          { $skip: skip },
          { $limit: perPage },
          { $lookup: { from: "customers", localField: "_id", foreignField: "_id", as: "customer" } },
          {
            $project: {
              name: { $arrayElemAt: ["$customer.name", 0] },
              phone: { $arrayElemAt: ["$customer.phone", 0] },
              paid: 1,
              count: 1,
              lastPayment: 1,
            },
          },
        ]),
        CustomerTransaction.aggregate([
          { $match: match },
          { $group: { _id: "$customerId" } },
          { $count: "total" },
        ]),
        CustomerTransaction.aggregate([
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
        const csvRows: Array<Array<string | number>> = [["Customer", "Phone", "Total Paid", "Payment Count", "Last Payment"]];
        for (const r of rows) csvRows.push([r.name, r.phone, r.paid, r.payments, r.lastPayment ? new Date(r.lastPayment).toISOString() : ""]);
        return csvResponse(`customer-payments-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
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

    if (view === "bonus") {
      const match: Record<string, unknown> = {};
      if (user.branchId) match.branchId = new mongoose.Types.ObjectId(user.branchId);
      if (range.from || range.to) match.createdAt = { $gte: range.from, $lte: range.to };

      const pipeline: mongoose.PipelineStage[] = [
        { $match: match },
        {
          $group: {
            _id: "$customerId",
            earned: { $sum: { $cond: [{ $eq: ["$type", "EARN"] }, "$amount", 0] } },
            redeemed: { $sum: { $cond: [{ $eq: ["$type", "REDEEM"] }, { $abs: "$amount" }, 0] } },
            reversed: { $sum: { $cond: [{ $eq: ["$type", "REVERSAL"] }, { $abs: "$amount" }, 0] } },
            entries: { $sum: 1 },
          },
        },
        { $sort: { earned: -1 } },
        { $skip: skip },
        { $limit: perPage },
        { $lookup: { from: "customers", localField: "_id", foreignField: "_id", as: "customer" } },
        {
          $project: {
            name: { $arrayElemAt: ["$customer.name", 0] },
            phone: { $arrayElemAt: ["$customer.phone", 0] },
            balance: { $arrayElemAt: ["$customer.bonusBalance", 0] },
            earned: 1,
            redeemed: 1,
            reversed: 1,
            entries: 1,
          },
        },
        ...searchStage,
      ];

      const [rowsRaw, totalRaw, totals] = await Promise.all([
        CustomerBonusTransaction.aggregate(pipeline),
        CustomerBonusTransaction.aggregate([
          { $match: match },
          { $group: { _id: "$customerId" } },
          { $count: "total" },
        ]),
        CustomerBonusTransaction.aggregate([
          { $match: match },
          {
            $group: {
              _id: null,
              earned: { $sum: { $cond: [{ $eq: ["$type", "EARN"] }, "$amount", 0] } },
              redeemed: { $sum: { $cond: [{ $eq: ["$type", "REDEEM"] }, { $abs: "$amount" }, 0] } },
              reversed: { $sum: { $cond: [{ $eq: ["$type", "REVERSAL"] }, { $abs: "$amount" }, 0] } },
              restored: { $sum: { $cond: [{ $eq: ["$type", "RESTORE"] }, "$amount", 0] } },
              expired: { $sum: { $cond: [{ $eq: ["$type", "EXPIRE"] }, { $abs: "$amount" }, 0] } },
            },
          },
        ]),
      ]);

      // Bonus earned/redeemed by the cashier who took the sale. Reported
      // alongside the customer breakdown so managers can spot cashier patterns.
      const cashierRaw = await CustomerBonusTransaction.aggregate<{
        _id: mongoose.Types.ObjectId | null;
        earned: number;
        redeemed: number;
        entries: number;
      }>([
        { $match: match },
        {
          $group: {
            _id: "$userId",
            earned: { $sum: { $cond: [{ $eq: ["$type", "EARN"] }, "$amount", 0] } },
            redeemed: { $sum: { $cond: [{ $eq: ["$type", "REDEEM"] }, { $abs: "$amount" }, 0] } },
            entries: { $sum: 1 },
          },
        },
        { $sort: { earned: -1 } },
      ]);
      const cashierIds = cashierRaw.map((r) => r._id).filter((id): id is mongoose.Types.ObjectId => Boolean(id));
      const cashiers = await User.find({ _id: { $in: cashierIds } }).select("name").lean();
      const cashierNames = new Map(cashiers.map((c) => [String(c._id), c.name]));
      const byCashier = cashierRaw.map((r) => ({
        cashierId: r._id ? String(r._id) : "",
        name: (r._id ? cashierNames.get(String(r._id)) : "") ?? "Unknown",
        earned: round2(r.earned ?? 0),
        redeemed: round2(r.redeemed ?? 0),
        entries: r.entries ?? 0,
      }));

      // Outstanding liability is lifetime: every customer's live reward balance.
      const liabilityMatch: Record<string, unknown> = {};
      if (user.branchId) liabilityMatch.branchId = new mongoose.Types.ObjectId(user.branchId);
      const liabilityRaw = await Customer.aggregate<{ _id: null; total: number }>([
        { $match: liabilityMatch },
        { $group: { _id: null, total: { $sum: "$bonusBalance" } } },
      ]);
      const liability = round2(Math.max(0, liabilityRaw[0]?.total ?? 0));

      const rows = rowsRaw.map((r) => ({
        _id: r._id?.toString() ?? "",
        name: r.name ?? "—",
        phone: r.phone ?? "",
        balance: round2(r.balance ?? 0),
        earned: round2(r.earned ?? 0),
        redeemed: round2(r.redeemed ?? 0),
        reversed: round2(r.reversed ?? 0),
        entries: r.entries ?? 0,
      }));

      if (searchParams.get("format") === "csv") {
        const csvRows: Array<Array<string | number>> = [["Customer", "Phone", "Earned", "Redeemed", "Reversed", "Balance"]];
        for (const r of rows) csvRows.push([r.name, r.phone, r.earned, r.redeemed, r.reversed, r.balance]);
        csvRows.push([]);
        csvRows.push(["By cashier", "", "Earned", "Redeemed", "", ""]);
        for (const c of byCashier) csvRows.push([c.name, "", c.earned, c.redeemed, "", ""]);
        csvRows.push([]);
        csvRows.push([
          "TOTAL",
          "",
          round2(totals[0]?.earned ?? 0),
          round2(totals[0]?.redeemed ?? 0),
          round2(totals[0]?.reversed ?? 0),
          "",
        ]);
        csvRows.push(["EXPIRED (range)", "", round2(totals[0]?.expired ?? 0)]);
        csvRows.push(["OUTSTANDING LIABILITY", "", liability]);
        return csvResponse(`customer-bonus-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
      }

      return NextResponse.json({
        view,
        rows,
        total: totalRaw[0]?.total ?? 0,
        page,
        perPage,
        totalPages: Math.ceil((totalRaw[0]?.total ?? 0) / perPage),
        byCashier,
        summary: {
          earned: round2(totals[0]?.earned ?? 0),
          redeemed: round2(totals[0]?.redeemed ?? 0),
          reversed: round2(totals[0]?.reversed ?? 0),
          restored: round2(totals[0]?.restored ?? 0),
          expired: round2(totals[0]?.expired ?? 0),
          liability,
        },
      });
    }

    // Balances: outstanding receivables per customer (ledger-derived)
    const ledgerMatch: Record<string, unknown> = {};
    if (user.branchId) ledgerMatch.branchId = new mongoose.Types.ObjectId(user.branchId);

    const balancePipeline: mongoose.PipelineStage[] = [
      { $match: ledgerMatch },
      { $group: { _id: "$customerId", balance: { $sum: "$amount" } } },
      { $match: { balance: { $gt: 0.001 } } },
      { $sort: { balance: -1 } },
      { $skip: skip },
      { $limit: perPage },
      { $lookup: { from: "customers", localField: "_id", foreignField: "_id", as: "customer" } },
      {
        $project: {
          name: { $arrayElemAt: ["$customer.name", 0] },
          phone: { $arrayElemAt: ["$customer.phone", 0] },
          balance: 1,
        },
      },
      ...searchStage,
    ];

    const [rowsRaw, totalRaw, grand] = await Promise.all([
      CustomerTransaction.aggregate(balancePipeline),
      CustomerTransaction.aggregate([
        { $match: ledgerMatch },
        { $group: { _id: "$customerId", balance: { $sum: "$amount" } } },
        { $match: { balance: { $gt: 0.001 } } },
        { $count: "total" },
      ]),
      CustomerTransaction.aggregate([
        { $match: ledgerMatch },
        { $group: { _id: "$customerId", balance: { $sum: "$amount" } } },
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
      const csvRows: Array<Array<string | number>> = [["Customer", "Phone", "Outstanding Balance"]];
      for (const r of rows) csvRows.push([r.name, r.phone, r.balance]);
      csvRows.push([]);
      csvRows.push(["TOTAL RECEIVABLES", "", round2(grand[0]?.total ?? 0)]);
      return csvResponse(`customer-balances-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
    }

    return NextResponse.json({
      view,
      rows,
      total: totalRaw[0]?.total ?? 0,
      page,
      perPage,
      totalPages: Math.ceil((totalRaw[0]?.total ?? 0) / perPage),
      summary: { totalReceivables: round2(grand[0]?.total ?? 0) },
    });
  } catch (error) {
    console.error("GET /api/reports/customers error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
