import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { StoreOrder } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { forbidden } from "@/lib/api";
import { round2 } from "@/lib/commerce";
import { parseReportRange, parsePage, csvResponse } from "@/lib/reports";

/**
 * GET /api/reports/store
 * Params: period=day|week|month | from&to (custom), status, page, perPage, format=csv
 *
 * Reports on the online store's own order stream (separate from POS sales):
 * revenue = sum of non-canceled order totals in the range.
 */

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.reports.store))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const range = parseReportRange(searchParams);
    const { page, perPage, skip } = parsePage(searchParams);
    const status = searchParams.get("status")?.trim() ?? "";

    const baseMatch: Record<string, unknown> = {
      createdAt: { $gte: range.from, $lte: range.to },
    };
    // Status filter applies to the table; the summary always uses the full window.
    const tableMatch: Record<string, unknown> = { ...baseMatch };
    if (["pending", "confirmed", "shipped", "delivered", "canceled"].includes(status)) {
      tableMatch.status = status;
    }

    const activeMatch = { ...baseMatch, status: { $ne: "canceled" } };

    // ---------- Summary ----------
    const [summaryAgg, byStatus, unitsAgg, customersAgg] = await Promise.all([
      StoreOrder.aggregate([
        { $match: activeMatch },
        {
          $group: {
            _id: null,
            revenue: { $sum: "$total" },
            orders: { $sum: 1 },
          },
        },
      ]),
      StoreOrder.aggregate([
        { $match: baseMatch },
        { $group: { _id: "$status", count: { $sum: 1 }, total: { $sum: "$total" } } },
        { $sort: { count: -1 } },
      ]),
      StoreOrder.aggregate([
        { $match: activeMatch },
        { $unwind: "$items" },
        { $group: { _id: null, units: { $sum: "$items.quantity" } } },
      ]),
      StoreOrder.aggregate([
        { $match: activeMatch },
        { $group: { _id: "$phone" } },
        { $count: "unique" },
      ]),
    ]);

    const revenue = round2(summaryAgg[0]?.revenue ?? 0);
    const ordersCount = summaryAgg[0]?.orders ?? 0;
    const units = unitsAgg[0]?.units ?? 0;

    // ---------- By day (revenue of non-canceled orders) ----------
    const byDay = await StoreOrder.aggregate([
      { $match: activeMatch },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          revenue: { $sum: "$total" },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // ---------- Top products (units + revenue from order line snapshots) ----------
    const topProductsRaw = await StoreOrder.aggregate([
      { $match: activeMatch },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.productId",
          name: { $first: "$items.name" },
          units: { $sum: "$items.quantity" },
          revenue: { $sum: { $multiply: ["$items.price", "$items.quantity"] } },
        },
      },
      { $sort: { units: -1 } },
      { $limit: 10 },
    ]);

    // ---------- Paged table ----------
    const [orders, tableTotal] = await Promise.all([
      StoreOrder.find(tableMatch)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(perPage)
        .select("orderNumber customerName phone status total items createdAt")
        .lean(),
      StoreOrder.countDocuments(tableMatch),
    ]);

    const topProducts = topProductsRaw.map((p) => ({
      name: p.name ?? "—",
      units: p.units ?? 0,
      revenue: round2(p.revenue ?? 0),
    }));

    if (searchParams.get("format") === "csv") {
      const csvRows: Array<Array<string | number>> = [
        ["Day", "Orders", "Revenue"],
        ...byDay.map((d) => [d._id, d.orders, round2(d.revenue)]),
        [],
        ["TOTAL (range)", ordersCount, revenue],
        [],
        ["Status", "Orders", "Total"],
        ...byStatus.map((s) => [s._id, s.count, round2(s.total ?? 0)]),
        [],
        ["Top products", "Units", "Revenue"],
        ...topProducts.map((p) => [p.name, p.units, p.revenue]),
      ];
      return csvResponse(`store-report-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
    }

    return NextResponse.json({
      range: { from: range.from, to: range.to },
      summary: {
        revenue,
        orders: ordersCount,
        units,
        avgOrder: ordersCount ? round2(revenue / ordersCount) : 0,
        uniqueCustomers: customersAgg[0]?.unique ?? 0,
        pending: byStatus.find((s) => s._id === "pending")?.count ?? 0,
      },
      byStatus: byStatus.map((s) => ({ status: s._id, count: s.count, total: round2(s.total ?? 0) })),
      byDay: byDay.map((d) => ({ day: d._id, revenue: round2(d.revenue), orders: d.orders })),
      topProducts,
      orders: orders.map((o) => ({
        id: o._id.toString(),
        orderNumber: o.orderNumber,
        customerName: o.customerName,
        phone: o.phone,
        status: o.status,
        total: o.total,
        itemCount: o.items.reduce((s, i) => s + i.quantity, 0),
        createdAt: o.createdAt,
      })),
      total: tableTotal,
      page,
      perPage,
      totalPages: Math.ceil(tableTotal / perPage),
    });
  } catch (error) {
    console.error("GET /api/reports/store error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
