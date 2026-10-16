import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Sale, Expense, CustomerTransaction, SupplierTransaction, Product } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { forbidden } from "@/lib/api";
import { round2 } from "@/lib/commerce";
import { approvedReturnsTotals, approvedReturnsByDay, approvedReturnsByProduct } from "@/lib/report-returns";

/**
 * GET /api/dashboard?days=N (default 1 = today; up to 30 for charts)
 * Everything is computed with aggregation pipelines and scoped to the user's
 * branch. Sections are filtered by the caller's report/finance permissions so
 * the payload never leaks data the user cannot see.
 */

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.dashboard.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const days = Math.min(30, Math.max(1, Number(searchParams.get("days") ?? 1)));
    const branchId = user.branchId ? new mongoose.Types.ObjectId(user.branchId) : null;
    const branchMatch = branchId ? { branchId } : {};

    // Period windows: "today" KPIs + chart range
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const chartStart = new Date(todayStart);
    chartStart.setDate(chartStart.getDate() - (days - 1));

    const canProfit = await hasPermission(user, PERMISSIONS.reports.profit);
    const canFinance = await hasPermission(user, PERMISSIONS.reports.finance);
    const canSales = await hasPermission(user, PERMISSIONS.reports.sales);
    const canInventory = await hasPermission(user, PERMISSIONS.reports.inventory);
    const canPurchases = await hasPermission(user, PERMISSIONS.reports.purchases);

    const saleTodayMatch = { status: "completed" as const, createdAt: { $gte: todayStart }, ...branchMatch };
    const saleChartMatch = { status: "completed" as const, createdAt: { $gte: chartStart }, ...branchMatch };

    // ---------- Sales KPIs (today + selected chart range) ----------
    // The dashboard range selector must affect the KPI cards, not just the
    // charts, so both windows are aggregated with the same pipeline.
    const salesKpiPipeline = (match: Record<string, unknown>): mongoose.PipelineStage[] => [
      { $match: match },
      {
        $group: {
          _id: null,
          revenue: { $sum: "$total" },
          netRevenue: { $sum: { $subtract: ["$subtotal", "$discount"] } },
          count: { $sum: 1 },
          cash: { $sum: { $cond: [{ $eq: ["$paymentMethod", "cash"] }, "$total", 0] } },
          card: { $sum: { $cond: [{ $in: ["$paymentMethod", ["card", "transfer"]] }, "$total", 0] } },
          credit: { $sum: { $cond: [{ $eq: ["$paymentMethod", "credit"] }, "$total", 0] } },
          mixedCash: { $sum: { $cond: [{ $eq: ["$paymentMethod", "mixed"] }, { $sum: { $map: { input: "$payments", as: "p", in: { $cond: [{ $eq: ["$$p.method", "cash"] }, "$$p.amount", 0] } } } }, 0] } },
        },
      },
    ] as mongoose.PipelineStage[];
    const emptySalesKpi = { _id: null, revenue: 0, count: 0, cash: 0, card: 0, credit: 0, mixedCash: 0, netRevenue: 0 };
    const [todaySales, rangeSales] = await Promise.all([
      Sale.aggregate(salesKpiPipeline(saleTodayMatch)),
      Sale.aggregate(salesKpiPipeline(saleChartMatch)),
    ]).then(
      ([today, range]) => [today.length ? today[0] : emptySalesKpi, range.length ? range[0] : emptySalesKpi] as const
    );

    // ---------- Approved returns / refunds ----------
    // A refund reverses revenue, so every sales KPI and chart below is reduced
    // by the approved returns of the same window (the returned stock also
    // leaves COGS). Returns are bucketed by the approval moment because that
    // is when the money actually moved. Shared helpers (/lib/reports) keep
    // the dashboard and the /reports screens on identical definitions.
    const [todayReturns, rangeReturns, rangeReturnsByDay] = await Promise.all([
      approvedReturnsTotals(todayStart, branchId),
      approvedReturnsTotals(chartStart, branchId),
      approvedReturnsByDay(chartStart, branchId),
    ]);

    let todayReturnsCogs = todayReturns.cogs;
    let rangeReturnsCogs = rangeReturns.cogs;
    if (!canProfit) {
      todayReturnsCogs = 0;
      rangeReturnsCogs = 0;
    }

    // ---------- Today's COGS + gross profit (from historical sale item costs) ----------
    let todayCogs = 0;
    if (canProfit) {
      const [cogsAgg] = await Sale.aggregate([
        { $match: saleTodayMatch },
        { $unwind: "$items" },
        { $group: { _id: null, cogs: { $sum: { $multiply: ["$items.costPrice", "$items.quantity"] } } } },
      ]);
      // Returned goods come back to inventory, so their cost leaves COGS.
      todayCogs = round2((cogsAgg?.cogs ?? 0) - todayReturnsCogs);
    }

    // ---------- Today's expenses (non-canceled) ----------
    let todayExpenses = 0;
    if (canProfit || canFinance) {
      const [expAgg] = await Expense.aggregate([
        { $match: { status: { $ne: "canceled" }, date: { $gte: todayStart }, ...branchMatch } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]);
      todayExpenses = round2(expAgg?.total ?? 0);
    }

    const todayRevenue = round2((todaySales?.revenue ?? 0) - todayReturns.refund);
    // Profit math uses net revenue (subtotal − discount, tax-exclusive) — same definition as /reports/profit
    const todayNetRevenue = round2((todaySales?.netRevenue ?? 0) - todayReturns.net);
    const todayGrossProfit = canProfit ? round2(todayNetRevenue - todayCogs) : null;
    const todayNetProfit = canProfit ? round2(todayGrossProfit! - todayExpenses) : null;
    const todayRefunds = round2(todayReturns.refund);

    // ---------- Receivables / payables ----------
    let receivables = 0;
    let payables = 0;
    if (canFinance || canSales) {
      const [rec] = await CustomerTransaction.aggregate([
        { $match: branchMatch },
        { $group: { _id: "$customerId", balance: { $sum: "$amount" } } },
        { $match: { balance: { $gt: 0.001 } } },
        { $group: { _id: null, total: { $sum: "$balance" } } },
      ]);
      receivables = round2(rec?.total ?? 0);
    }
    if (canFinance || canPurchases) {
      const [pay] = await SupplierTransaction.aggregate([
        { $match: branchMatch },
        { $group: { _id: "$supplierId", balance: { $sum: "$amount" } } },
        { $match: { balance: { $gt: 0.001 } } },
        { $group: { _id: null, total: { $sum: "$balance" } } },
      ]);
      payables = round2(pay?.total ?? 0);
    }

    // ---------- Stock alerts ----------
    let lowStock: Array<{ id: string; name: string; stock: number; reorderPoint: number }> = [];
    let outOfStock = 0;
    let lowStockCount = 0;
    if (canInventory) {
      const branchM = branchId ? { branchId } : {};
      const stockPipeline: mongoose.PipelineStage[] = [
        { $match: { status: "active" } },
        {
          $lookup: {
            from: "inventorymovements",
            as: "m",
            let: { pid: "$_id" },
            pipeline: [
              { $match: { $expr: { $eq: ["$productId", "$$pid"] }, ...branchM } },
              { $project: { movementType: 1, quantity: 1 } },
            ],
          },
        },
        {
          $addFields: {
            stock: {
              $sum: {
                $map: {
                  input: "$m",
                  as: "mv",
                  in: {
                    $cond: [
                      { $in: ["$$mv.movementType", ["PURCHASE_IN", "CUSTOMER_RETURN_IN", "ADJUSTMENT_IN", "STOCK_COUNT_IN"]] },
                      "$$mv.quantity",
                      { $multiply: ["$$mv.quantity", -1] },
                    ],
                  },
                },
              },
            },
          },
        },
        { $project: { name: 1, sku: 1, stock: 1, reorderPoint: 1 } },
      ];

      const countPipeline = [...stockPipeline, { $match: { $expr: { $and: [{ $gt: ["$stock", 0] }, { $lte: ["$stock", "$reorderPoint"] }] } } }, { $count: "count" }] as mongoose.PipelineStage[];
      const [outRes, lowRes, lowCountRes] = await Promise.all([
        Product.aggregate([...stockPipeline, { $match: { stock: { $lte: 0 } } }, { $count: "count" }] as mongoose.PipelineStage[]),
        Product.aggregate([...stockPipeline, { $match: { $expr: { $and: [{ $gt: ["$stock", 0] }, { $lte: ["$stock", "$reorderPoint"] }] } } }, { $sort: { stock: 1 } }, { $limit: 10 }] as mongoose.PipelineStage[]),
        Product.aggregate(countPipeline),
      ]);
      outOfStock = outRes[0]?.count ?? 0;
      lowStockCount = lowCountRes[0]?.count ?? 0;
      lowStock = lowRes.map((p: { _id: mongoose.Types.ObjectId; name: string; stock: number; reorderPoint: number }) => ({
        id: p._id.toString(),
        name: p.name,
        stock: p.stock,
        reorderPoint: p.reorderPoint,
      }));
    }

    // ---------- Top products (range, net of approved returns) ----------
    let topProducts: Array<{ name: string; quantity: number; revenue: number }> = [];
    if (canSales || canProfit) {
      const [sold, returnsByProduct] = await Promise.all([
        Sale.aggregate([
          { $match: saleChartMatch },
          { $unwind: "$items" },
          {
            $group: {
              _id: "$items.productId",
              name: { $first: "$items.name" },
              quantity: { $sum: "$items.quantity" },
              revenue: { $sum: "$items.subtotal" },
            },
          },
          { $sort: { quantity: -1 } },
          { $limit: 5 },
        ]),
        approvedReturnsByProduct(chartStart, branchId),
      ]);
      topProducts = sold.map((p) => {
        const ret = returnsByProduct.get(String(p._id));
        return {
          name: p.name,
          quantity: (p.quantity ?? 0) - (ret?.quantity ?? 0),
          revenue: round2((p.revenue ?? 0) - (ret?.refund ?? 0)),
        };
      });
    }

    // ---------- Recent sales (today) ----------
    let recentSales: Array<{ id: string; invoiceNumber: string; total: number; paymentMethod: string | null; createdAt: string; cashierName: string | null }> = [];
    if (canSales) {
      const recent = await Sale.find(saleTodayMatch)
        .sort({ createdAt: -1 })
        .limit(6)
        .populate<{ cashierId: { name: string } | null }>("cashierId", "name")
        .select("invoiceNumber total paymentMethod createdAt cashierId")
        .lean();
      recentSales = recent.map((s) => ({
        id: s._id.toString(),
        invoiceNumber: s.invoiceNumber,
        total: s.total,
        paymentMethod: s.paymentMethod,
        createdAt: s.createdAt.toISOString(),
        cashierName: (s.cashierId as unknown as { name: string } | null)?.name ?? null,
      }));
    }

    // ---------- Chart series (sales over time, revenue vs COGS, profit) ----------
    const salesByDay = await Sale.aggregate([
      { $match: saleChartMatch },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          revenue: { $sum: "$total" },
          netRevenue: { $sum: { $subtract: ["$subtotal", "$discount"] } },
          count: { $sum: 1 },
          cash: { $sum: { $cond: [{ $eq: ["$paymentMethod", "cash"] }, "$total", 0] } },
          card: { $sum: { $cond: [{ $in: ["$paymentMethod", ["card", "transfer"]] }, "$total", 0] } },
          credit: { $sum: { $cond: [{ $eq: ["$paymentMethod", "credit"] }, "$total", 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const cogsByDay = canProfit
      ? await Sale.aggregate([
          { $match: saleChartMatch },
          { $unwind: "$items" },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
              cogs: { $sum: { $multiply: ["$items.costPrice", "$items.quantity"] } },
            },
          },
        ])
      : [];

    const expensesByDay = canProfit || canFinance
      ? await Expense.aggregate([
          { $match: { status: { $ne: "canceled" }, date: { $gte: chartStart }, ...branchMatch } },
          { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } }, total: { $sum: "$amount" } } },
        ])
      : [];

    // Category split for the range
    const categorySplit = canSales
      ? await Sale.aggregate([
          { $match: saleChartMatch },
          { $unwind: "$items" },
          { $lookup: { from: "products", localField: "items.productId", foreignField: "_id", as: "product" } },
          { $addFields: { categoryId: { $arrayElemAt: ["$product.categoryId", 0] } } },
          { $group: { _id: "$categoryId", revenue: { $sum: "$items.subtotal" } } },
          { $sort: { revenue: -1 } },
          { $limit: 8 },
          { $lookup: { from: "categories", localField: "_id", foreignField: "_id", as: "category" } },
          { $project: { name: { $ifNull: [{ $arrayElemAt: ["$category.name", 0] }, "Uncategorized"] }, revenue: { $round: ["$revenue", 2] } } },
        ])
      : [];

    // Returns per day (same window/matching as the KPI returns above, via the
    // shared /lib/reports helper) — the chart buckets subtract these so daily
    // revenue/cogs/profit agree with the KPI cards and /reports/profit.
    const returnsMap = new Map(rangeReturnsByDay.map((r) => [r.day, r]));

    // Fill day buckets for charts
    const dayKeys: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(chartStart);
      d.setDate(d.getDate() + i);
      dayKeys.push(d.toISOString().slice(0, 10));
    }
    const salesMap = new Map(salesByDay.map((s) => [s._id, s]));
    const cogsMap = new Map(cogsByDay.map((c) => [c._id, c.cogs]));
    const expMap = new Map(expensesByDay.map((e) => [e._id, e.total]));

    const chart = dayKeys.map((day) => {
      const s = salesMap.get(day);
      const r = returnsMap.get(day);
      const cogs = round2((cogsMap.get(day) ?? 0) - (r?.cogs ?? 0));
      const expenses = round2(expMap.get(day) ?? 0);
      const revenue = round2((s?.revenue ?? 0) - (r?.refund ?? 0));
      const netRevenue = round2((s?.netRevenue ?? 0) - (r?.refund ?? 0));
      return {
        day,
        revenue,
        count: s?.count ?? 0,
        cash: round2(s?.cash ?? 0),
        card: round2(s?.card ?? 0),
        credit: round2(s?.credit ?? 0),
        cogs,
        grossProfit: canProfit ? round2(netRevenue - cogs) : null,
        profit: canProfit ? round2(netRevenue - cogs - expenses) : null,
      };
    });

    // ---------- Range KPIs (selected dashboard period) ----------
    // Uses the same cogs/expenses series already aggregated for the chart, so
    // the KPI cards and the chart always agree for the chosen window.
    const rangeRevenue = round2(rangeSales?.revenue ?? 0);
    const rangeNetRevenueSales = round2(rangeSales?.netRevenue ?? 0);
    const rangeCogs = round2(cogsByDay.reduce((s, c) => s + c.cogs, 0) - rangeReturnsCogs);
    const rangeExpenses = round2(expensesByDay.reduce((s, e) => s + e.total, 0));
    const rangeRevenueNetOfReturns = round2(rangeRevenue - rangeReturns.refund);
    const rangeNetRevenue = round2(rangeNetRevenueSales - rangeReturns.net);
    const rangeGrossProfit = canProfit ? round2(rangeNetRevenue - rangeCogs) : null;
    const rangeNetProfit = canProfit ? round2(rangeGrossProfit! - rangeExpenses) : null;

    return NextResponse.json({
      today: {
        sales: todayRevenue,
        transactions: todaySales?.count ?? 0,
        grossProfit: todayGrossProfit,
        netProfit: todayNetProfit,
        expenses: canProfit || canFinance ? todayExpenses : null,
        // Refunds are already subtracted from `sales` above — surfacing them
        // separately so the dashboard shows the money that went back out.
        refunds: todayRefunds,
        cashSales: round2((todaySales?.cash ?? 0) + (todaySales?.mixedCash ?? 0)),
        cardSales: round2(todaySales?.card ?? 0),
        creditSales: round2(todaySales?.credit ?? 0),
      },
      range: {
        sales: rangeRevenueNetOfReturns,
        transactions: rangeSales?.count ?? 0,
        grossProfit: rangeGrossProfit,
        netProfit: rangeNetProfit,
        expenses: canProfit || canFinance ? rangeExpenses : null,
        refunds: round2(rangeReturns.refund),
        cashSales: round2((rangeSales?.cash ?? 0) + (rangeSales?.mixedCash ?? 0)),
        cardSales: round2(rangeSales?.card ?? 0),
        creditSales: round2(rangeSales?.credit ?? 0),
      },
      receivables: canFinance || canSales ? receivables : null,
      payables: canFinance || canPurchases ? payables : null,
      stock: canInventory ? { lowStockCount, outOfStock, lowStock } : null,
      topProducts,
      recentSales,
      categorySplit,
      chart,
      canSeeProfit: canProfit,
    });
  } catch (error) {
    console.error("GET /api/dashboard error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
