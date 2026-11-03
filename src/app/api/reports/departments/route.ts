import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Sale, SaleReturn, Department, User } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { forbidden } from "@/lib/api";
import { round2 } from "@/lib/commerce";
import { parseReportRange } from "@/lib/reports";

/**
 * GET /api/reports/departments
 *
 * Params: from & to (or period), branchId (HQ only), departmentId, employeeId,
 *         groupBy=department|employee|day|product, source=import|local, format=csv
 *
 * Definitions (identical to the profit report):
 *   grossSales  Σ sale.total (completed, in the window)
 *   discounts   Σ sale.discount
 *   tax         Σ sale.tax
 *   returns     Σ approved return.total (bucketed by approval time)
 *   netSales    grossSales − returns
 *   netRevenue  Σ(subtotal − discount) − Σ returned(subtotal − discount)
 *   cogs        Σ item cost − Σ returned item cost
 *   profit      netRevenue − cogs
 *
 * Held/canceled sales never count. Legacy returns with no department snapshot
 * inherit the original sale's department via lookup, so nothing is silently
 * attributed to the wrong team. Sales with no department are reported as
 * "Unassigned" instead of being guessed.
 */

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.reports.departments))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const range = parseReportRange(searchParams);
    const groupBy = searchParams.get("groupBy")?.trim() || "department";
    const departmentId = searchParams.get("departmentId")?.trim() ?? "";
    const employeeId = searchParams.get("employeeId")?.trim() ?? "";
    const requestedBranch = searchParams.get("branchId")?.trim() ?? "";
    const source = searchParams.get("source")?.trim() ?? "";
    const format = searchParams.get("format")?.trim() ?? "";

    if (!["department", "employee", "day", "product"].includes(groupBy)) {
      return NextResponse.json({ error: "Invalid groupBy" }, { status: 400 });
    }

    // Branch-restricted users are always pinned to their own shop.
    const branchId = user.branchId
      ? new mongoose.Types.ObjectId(user.branchId)
      : requestedBranch && mongoose.Types.ObjectId.isValid(requestedBranch)
        ? new mongoose.Types.ObjectId(requestedBranch)
        : null;

    const saleMatch: Record<string, unknown> = {
      status: "completed",
      createdAt: { $gte: range.from, $lte: range.to },
    };
    if (branchId) saleMatch.branchId = branchId;
    if (departmentId && mongoose.Types.ObjectId.isValid(departmentId)) {
      saleMatch.departmentId = new mongoose.Types.ObjectId(departmentId);
    }
    if (employeeId && mongoose.Types.ObjectId.isValid(employeeId)) {
      saleMatch.employeeId = new mongoose.Types.ObjectId(employeeId);
    }
    // Department scoping happens per sold line below, so the sale-level filter
    // must not hide the other departments of a mixed cart.
    const saleItemMatch: Record<string, unknown> = { ...saleMatch };
    if (groupBy === "department") delete saleItemMatch.departmentId;
    if ((source === "import" || source === "local") && !groupBy.includes("product")) {
      // Whole-sale scoping by origin: a sale counts when it contains at least
      // one line from that source. The per-source breakdown below is the exact
      // item-level view.
      saleMatch["items.purchaseSource"] = source;
    }

    // Approved returns in the same window, bucketed by the moment money moved.
    const returnTimeExpr = { $ifNull: ["$approvedAt", "$createdAt"] } as const;
    const returnMatch: Record<string, unknown> = {
      status: "approved",
      ...(branchId ? { branchId } : {}),
    };
    const returnPipeline: mongoose.PipelineStage[] = [
      { $match: returnMatch },
      { $match: { $expr: { $and: [{ $gte: [returnTimeExpr, range.from] }, { $lte: [returnTimeExpr, range.to] }] } } },
      // Legacy returns have no attribution snapshot: inherit the sale's.
      {
        $lookup: {
          from: "sales",
          localField: "saleId",
          foreignField: "_id",
          as: "originalSale",
          pipeline: [{ $project: { departmentId: 1, departmentName: 1, employeeId: 1, cashierId: 1 } }],
        },
      },
      {
        $addFields: {
          attributionDepartmentId: {
            $ifNull: ["$departmentId", { $arrayElemAt: ["$originalSale.departmentId", 0] }],
          },
          attributionDepartmentName: {
            $ifNull: ["$departmentName", { $arrayElemAt: ["$originalSale.departmentName", 0] }],
          },
          attributionEmployeeId: {
            $ifNull: [
              "$employeeId",
              {
                $ifNull: [
                  { $arrayElemAt: ["$originalSale.employeeId", 0] },
                  { $arrayElemAt: ["$originalSale.cashierId", 0] },
                ],
              },
            ],
          },
        },
      },
    ];
    if (departmentId && mongoose.Types.ObjectId.isValid(departmentId) && groupBy !== "department") {
      returnPipeline.push({ $match: { attributionDepartmentId: new mongoose.Types.ObjectId(departmentId) } });
    }
    if (employeeId && mongoose.Types.ObjectId.isValid(employeeId)) {
      returnPipeline.push({ $match: { attributionEmployeeId: new mongoose.Types.ObjectId(employeeId) } });
    }

    const salesSummaryAgg = Sale.aggregate<SummaryRow>([
      { $match: saleMatch },
      {
        $group: {
          _id: null,
          grossSales: { $sum: "$total" },
          discounts: { $sum: "$discount" },
          tax: { $sum: "$tax" },
          netRevenue: { $sum: { $subtract: ["$subtotal", "$discount"] } },
          cogs: {
            $sum: {
              $sum: {
                $map: {
                  input: "$items",
                  as: "i",
                  in: { $multiply: ["$$i.costPrice", "$$i.quantity"] },
                },
              },
            },
          },
          count: { $sum: 1 },
        },
      },
    ]);

    const returnsSummaryPipeline: mongoose.PipelineStage[] = [
      ...returnPipeline,
      {
        $group: {
          _id: null,
          returns: { $sum: "$total" },
          returnedNet: { $sum: { $subtract: ["$subtotal", "$discount"] } },
          returnedCogs: {
            $sum: {
              $sum: {
                $map: {
                  input: "$items",
                  as: "i",
                  in: { $multiply: ["$$i.costPrice", "$$i.quantity"] },
                },
              },
            },
          },
          count: { $sum: 1 },
        },
      },
    ];

    const [salesSummaryRows, returnsSummaryRows] = await Promise.all([
      salesSummaryAgg,
      SaleReturn.aggregate<ReturnsSummaryRow>(returnsSummaryPipeline),
    ]);
    const s = salesSummaryRows[0];
    const r = returnsSummaryRows[0];

    const summary = {
      grossSales: round2(s?.grossSales ?? 0),
      discounts: round2(s?.discounts ?? 0),
      tax: round2(s?.tax ?? 0),
      returns: round2(r?.returns ?? 0),
      netSales: round2((s?.grossSales ?? 0) - (r?.returns ?? 0)),
      netRevenue: round2((s?.netRevenue ?? 0) - (r?.returnedNet ?? 0)),
      cogs: round2((s?.cogs ?? 0) - (r?.returnedCogs ?? 0)),
      profit: round2((s?.netRevenue ?? 0) - (r?.returnedNet ?? 0) - ((s?.cogs ?? 0) - (r?.returnedCogs ?? 0))),
      transactions: s?.count ?? 0,
      returnsCount: r?.count ?? 0,
    };

    // ---------------------------------------------------------------------
    // Grouped rows
    // ---------------------------------------------------------------------
    const keyExpr =
      groupBy === "department"
        ? { $ifNull: ["$departmentId", null] }
        : groupBy === "employee"
          ? { $ifNull: ["$employeeId", "$cashierId"] }
          : groupBy === "day"
            ? { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }
            : "$items.productId";

    const saleRowsPipeline: mongoose.PipelineStage[] = [{ $match: saleMatch }];
    if (groupBy === "product") {
      saleRowsPipeline.push({ $unwind: "$items" });
      if (source === "import" || source === "local") {
        saleRowsPipeline.push({ $match: { "items.purchaseSource": source } });
      }
    }
    saleRowsPipeline.push(
      {
        $group: {
          _id: keyExpr,
          name:
            groupBy === "product"
              ? { $first: "$items.name" }
              : groupBy === "department"
                ? { $first: "$departmentName" }
                : { $first: null },
          grossSales: {
            $sum: groupBy === "product" ? "$items.subtotal" : "$total",
          },
          discounts: { $sum: groupBy === "product" ? "$items.discount" : "$discount" },
          netRevenue: {
            $sum:
              groupBy === "product"
                ? { $subtract: ["$items.subtotal", "$items.discount"] }
                : { $subtract: ["$subtotal", "$discount"] },
          },
          cogs: {
            $sum:
              groupBy === "product"
                ? { $multiply: ["$items.costPrice", "$items.quantity"] }
                : {
                    $sum: {
                      $map: {
                        input: "$items",
                        as: "i",
                        in: { $multiply: ["$$i.costPrice", "$$i.quantity"] },
                      },
                    },
                  },
          },
          transactions: { $sum: 1 },
        },
      },
      { $sort: { grossSales: -1 } }
    );

    const returnRowsPipeline: mongoose.PipelineStage[] = [...returnPipeline];
    const returnKeyExpr =
      groupBy === "department"
        ? "$attributionDepartmentId"
        : groupBy === "employee"
          ? "$attributionEmployeeId"
          : groupBy === "day"
            ? { $dateToString: { format: "%Y-%m-%d", date: returnTimeExpr } }
            : "$items.productId";

    if (groupBy === "product") {
      returnRowsPipeline.push({ $unwind: "$items" });
    }
    returnRowsPipeline.push(
      {
        $group: {
          _id: returnKeyExpr,
          returns: { $sum: groupBy === "product" ? "$items.subtotal" : "$total" },
          returnedNet: {
            $sum:
              groupBy === "product"
                ? "$items.subtotal"
                : { $subtract: ["$subtotal", "$discount"] },
          },
          returnedCogs: {
            $sum:
              groupBy === "product"
                ? { $multiply: ["$items.costPrice", "$items.quantity"] }
                : {
                    $sum: {
                      $map: {
                        input: "$items",
                        as: "i",
                        in: { $multiply: ["$$i.costPrice", "$$i.quantity"] },
                      },
                    },
                  },
          },
          count: { $sum: 1 },
        },
      }
    );

    // -------------------------------------------------------------------
    // Department attribution is LINE based.
    //
    // Every sold line carries the snapshot of its product's department, so a
    // cart that mixes two departments raises BOTH of them. Sale-level amounts
    // (discount, tax, employee benefit) are split across the lines by net
    // merchandise value, which keeps the department rows summing to the shop
    // summary. Lines without a product department fall back to the sale's
    // cashier/employee department, then to "Unassigned".
    // -------------------------------------------------------------------
    const netMerchExpr = { $subtract: ["$items.subtotal", "$items.tax"] } as const;
    const lineNetTotalExpr = {
      $reduce: {
        input: "$items",
        initialValue: 0,
        in: { $add: ["$$value", { $subtract: ["$$this.subtotal", "$$this.tax"] }] },
      },
    } as const;
    const shareExpr = (totalField: string) => ({
      $cond: [
        { $gt: [totalField, 0] },
        { $divide: [netMerchExpr, totalField] },
        0,
      ],
    });

    const departmentSalePipeline: mongoose.PipelineStage[] = [
      { $match: saleItemMatch },
      { $addFields: { lineNetTotal: lineNetTotalExpr } },
      { $unwind: "$items" },
      {
        $addFields: {
          attributionDepartmentId: { $ifNull: ["$items.departmentId", "$departmentId"] },
          attributionDepartmentName: {
            $cond: [
              { $gt: [{ $strLenCP: { $ifNull: ["$items.departmentName", ""] } }, 0] },
              "$items.departmentName",
              "$departmentName",
            ],
          },
        },
      },
      { $addFields: { share: shareExpr("$lineNetTotal") } },
    ];
    if (departmentId && mongoose.Types.ObjectId.isValid(departmentId)) {
      departmentSalePipeline.push({
        $match: { attributionDepartmentId: new mongoose.Types.ObjectId(departmentId) },
      });
    }
    departmentSalePipeline.push(
      {
        $group: {
          _id: "$attributionDepartmentId",
          name: { $first: "$attributionDepartmentName" },
          grossSales: { $sum: { $multiply: ["$total", "$share"] } },
          discounts: { $sum: { $multiply: ["$discount", "$share"] } },
          netRevenue: {
            $sum: { $multiply: [{ $subtract: ["$subtotal", "$discount"] }, "$share"] },
          },
          cogs: { $sum: { $multiply: ["$items.costPrice", "$items.quantity"] } },
          saleIds: { $addToSet: "$_id" },
        },
      },
      { $addFields: { transactions: { $size: "$saleIds" } } },
      { $sort: { grossSales: -1 } }
    );

    const departmentReturnPipeline: mongoose.PipelineStage[] = [
      ...returnPipeline,
      { $addFields: { lineNetTotal: lineNetTotalExpr } },
      { $unwind: "$items" },
      {
        $addFields: {
          returnDepartmentId: { $ifNull: ["$items.departmentId", "$attributionDepartmentId"] },
          returnDepartmentName: {
            $cond: [
              { $gt: [{ $strLenCP: { $ifNull: ["$items.departmentName", ""] } }, 0] },
              "$items.departmentName",
              "$attributionDepartmentName",
            ],
          },
        },
      },
      { $addFields: { share: shareExpr("$lineNetTotal") } },
    ];
    if (departmentId && mongoose.Types.ObjectId.isValid(departmentId)) {
      departmentReturnPipeline.push({
        $match: { returnDepartmentId: new mongoose.Types.ObjectId(departmentId) },
      });
    }
    departmentReturnPipeline.push(
      {
        $group: {
          _id: "$returnDepartmentId",
          returns: { $sum: { $multiply: ["$total", "$share"] } },
          returnedNet: {
            $sum: { $multiply: [{ $subtract: ["$subtotal", "$discount"] }, "$share"] },
          },
          returnedCogs: { $sum: { $multiply: ["$items.costPrice", "$items.quantity"] } },
          returnIds: { $addToSet: "$_id" },
        },
      },
      { $addFields: { count: { $size: "$returnIds" } } }
    );

    const [saleRows, returnRows] = await Promise.all([
      Sale.aggregate(groupBy === "department" ? departmentSalePipeline : saleRowsPipeline),
      SaleReturn.aggregate(groupBy === "department" ? departmentReturnPipeline : returnRowsPipeline),
    ]);

    type Bucket = {
      key: string;
      name: string;
      grossSales: number;
      discounts: number;
      returns: number;
      netSales: number;
      cogs: number;
      profit: number;
      transactions: number;
      returnsCount: number;
    };

    const buckets = new Map<string, Bucket>();
    const bucketKey = (id: unknown) => (id === null || id === undefined ? "unassigned" : String(id));

    for (const row of saleRows) {
      const key = bucketKey(row._id);
      buckets.set(key, {
        key,
        name: (row.name as string) || "",
        grossSales: round2(row.grossSales ?? 0),
        discounts: round2(row.discounts ?? 0),
        returns: 0,
        netSales: round2(row.grossSales ?? 0),
        cogs: round2(row.cogs ?? 0),
        profit: 0,
        transactions: row.transactions ?? 0,
        returnsCount: 0,
      });
    }
    for (const row of returnRows) {
      const key = bucketKey(row._id);
      const bucket =
        buckets.get(key) ??
        {
          key,
          name: "",
          grossSales: 0,
          discounts: 0,
          returns: 0,
          netSales: 0,
          cogs: 0,
          profit: 0,
          transactions: 0,
          returnsCount: 0,
        };
      bucket.returns = round2(bucket.returns + (row.returns ?? 0));
      bucket.cogs = round2(bucket.cogs - (row.returnedCogs ?? 0));
      bucket.netSales = round2(bucket.grossSales - bucket.returns);
      bucket.returnsCount += row.count ?? 0;
      bucket.profit = round2(bucket.netSales - bucket.cogs);
      buckets.set(key, bucket);
    }
    for (const bucket of buckets.values()) {
      bucket.netSales = round2(bucket.grossSales - bucket.returns);
      bucket.profit = round2(bucket.netSales - bucket.cogs);
    }

    // Names for department/employee groups (historical snapshot first, then live).
    // Every active department is listed even with no sales in the window, so
    // the report shows each department rather than only the selling ones.
    const employeeIds = [...buckets.keys()].filter((k) => k !== "unassigned" && mongoose.Types.ObjectId.isValid(k));
    const [departments, employees] = await Promise.all([
      groupBy === "department"
        ? Department.find({
            ...(branchId ? { branchId } : {}),
            ...(departmentId && mongoose.Types.ObjectId.isValid(departmentId)
              ? { _id: new mongoose.Types.ObjectId(departmentId) }
              : {}),
            status: "active",
          })
            .select("name")
            .lean()
        : Promise.resolve([]),
      groupBy === "employee" && employeeIds.length
        ? User.find({ _id: { $in: employeeIds } }).select("name").lean()
        : Promise.resolve([]),
    ]);
    const nameMap = new Map<string, string>();
    for (const d of departments as Array<{ _id: unknown; name: string }>) nameMap.set(String(d._id), d.name);
    for (const e of employees as Array<{ _id: unknown; name: string }>) nameMap.set(String(e._id), e.name);

    if (groupBy === "department") {
      for (const d of departments as Array<{ _id: unknown; name: string }>) {
        const key = String(d._id);
        if (!buckets.has(key)) {
          buckets.set(key, {
            key,
            name: d.name,
            grossSales: 0,
            discounts: 0,
            returns: 0,
            netSales: 0,
            cogs: 0,
            profit: 0,
            transactions: 0,
            returnsCount: 0,
          });
        }
      }
    }

    const rows = [...buckets.values()]
      .map((bucket) => ({
        ...bucket,
        name:
          bucket.name ||
          (bucket.key === "unassigned"
            ? "Unassigned"
            : nameMap.get(bucket.key) ?? (groupBy === "product" ? "Unknown product" : bucket.key)),
        unassigned: bucket.key === "unassigned",
      }))
      .sort((a, b) => b.grossSales - a.grossSales);

    // Purchase-source breakdown (item-level, so it never double counts a sale).
    // Split by department as well, so Import vs Local can be read per team
    // instead of as a single shop-wide number. Sales with no department
    // snapshot are reported as "Shop" rather than being hidden.
    const sourceDepartmentExpr = {
      $cond: [
        { $gt: [{ $strLenCP: { $ifNull: ["$departmentName", ""] } }, 0] },
        "$departmentName",
        "Shop",
      ],
    };
    const sourcePipeline: mongoose.PipelineStage[] = [
      { $match: { ...saleMatch, "items.purchaseSource": { $in: ["import", "local"] } } },
      { $unwind: "$items" },
      { $match: { "items.purchaseSource": { $in: ["import", "local"] } } },
      {
        $group: {
          _id: { source: "$items.purchaseSource", department: sourceDepartmentExpr },
          quantity: { $sum: "$items.quantity" },
          revenue: { $sum: { $subtract: ["$items.subtotal", "$items.discount"] } },
          cogs: { $sum: { $multiply: ["$items.costPrice", "$items.quantity"] } },
        },
      },
      { $sort: { revenue: -1 } },
    ];
    if (source === "import" || source === "local") {
      sourcePipeline.splice(2, 0, { $match: { "items.purchaseSource": source } });
    }
    const sourceRows = await Sale.aggregate(sourcePipeline);

    const payload = {
      range: { from: range.from, to: range.to },
      groupBy,
      summary,
      rows,
      sources: sourceRows.map((row) => {
        const groupId = (row._id ?? {}) as { source?: string; department?: string | null };
        return {
          source: groupId.source ?? "",
          departmentName: groupId.department ?? "Shop",
          quantity: row.quantity ?? 0,
          revenue: round2(row.revenue ?? 0),
          cogs: round2(row.cogs ?? 0),
          profit: round2((row.revenue ?? 0) - (row.cogs ?? 0)),
        };
      }),
      scope: { branchId: branchId ? String(branchId) : null },
    };

    if (format === "csv") {
      const header = [
        groupBy,
        "grossSales",
        "discounts",
        "returns",
        "netSales",
        "cogs",
        "profit",
        "transactions",
        "returnsCount",
      ];
      const lines = [header.join(",")];
      for (const row of rows) {
        lines.push(
          [
            `"${String(row.name).replace(/"/g, '""')}"`,
            row.grossSales,
            row.discounts,
            row.returns,
            row.netSales,
            row.cogs,
            row.profit,
            row.transactions,
            row.returnsCount,
          ].join(",")
        );
      }
      return new NextResponse(lines.join("\n"), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="department-report-${groupBy}.csv"`,
        },
      });
    }

    return NextResponse.json(payload);
  } catch (error) {
    console.error("GET /api/reports/departments error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

type SummaryRow = {
  grossSales: number;
  discounts: number;
  tax: number;
  netRevenue: number;
  cogs: number;
  count: number;
};

type ReturnsSummaryRow = {
  returns: number;
  returnedNet: number;
  returnedCogs: number;
  count: number;
};
