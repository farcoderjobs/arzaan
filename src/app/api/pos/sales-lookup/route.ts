import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Product, Sale } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { badRequest, forbidden, notFound } from "@/lib/api";
import { lookupSaleForReturn } from "@/lib/exchange-service";
import { assertBranchAccess, BranchAccessError } from "@/lib/branch-access";

/**
 * GET /api/pos/sales-lookup?invoice=INV-… (or ?saleId=… or ?barcode=…)
 * Returns the original sale with per-line returnable quantities for the POS
 * refund/exchange screen. Requires refund authority.
 *
 * A scanned barcode/SKU finds the most recent completed sale that still has a
 * returnable unit of that product, so a cashier can refund without the receipt
 * number. Amounts still come from the sale snapshot (wholesale price, line and
 * sale discounts, employee benefit), never from the current catalog price.
 */
export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.sales.refund))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const invoice = searchParams.get("invoice")?.trim() ?? "";
    const saleId = searchParams.get("saleId")?.trim() ?? "";
    const barcode = searchParams.get("barcode")?.trim() ?? "";

    if (barcode) {
      const escaped = barcode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const product = await Product.findOne({
        status: { $ne: "archived" },
        $or: [
          { barcode: new RegExp(`^${escaped}$`, "i") },
          { "barcodes.code": new RegExp(`^${escaped}$`, "i") },
          { sku: new RegExp(`^${escaped}$`, "i") },
        ],
      })
        .select("_id name sku barcode")
        .lean();
      if (!product) {
        return NextResponse.json(notFound("No product matches that barcode"), { status: 404 });
      }

      const saleQuery: Record<string, unknown> = {
        status: "completed",
        "items.productId": product._id,
      };
      if (user.branchId) saleQuery.branchId = new mongoose.Types.ObjectId(user.branchId);

      // Newest sales first: the cashier is almost always returning something
      // bought today. Walk a few back in case they were already refunded.
      const candidates = await Sale.find(saleQuery)
        .sort({ createdAt: -1 })
        .limit(20)
        .select("_id")
        .lean();

      for (const candidate of candidates) {
        const data = await lookupSaleForReturn(candidate._id.toString());
        if (!data) continue;
        const matched = data.sale.items.find(
          (line) => line.productId === product._id.toString() && line.returnableQuantity > 0
        );
        if (!matched) continue;
        return NextResponse.json({
          success: true,
          ...data,
          matchedProductId: product._id.toString(),
          matchedLineId: matched.lineId,
          matchedProductName: product.name,
        });
      }

      return NextResponse.json(
        notFound("No returnable sale found for that product"),
        { status: 404 }
      );
    }

    if (!invoice && !saleId) {
      return NextResponse.json(badRequest("Provide a receipt/invoice number or sale ID"), { status: 400 });
    }

    const query: Record<string, unknown> = { status: "completed" };
    if (saleId) {
      if (!mongoose.isValidObjectId(saleId)) {
        return NextResponse.json(badRequest("Invalid sale ID"), { status: 400 });
      }
      query._id = new mongoose.Types.ObjectId(saleId);
    } else {
      query.invoiceNumber = {
        $regex: `^${invoice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        $options: "i",
      };
    }
    if (user.branchId) query.branchId = new mongoose.Types.ObjectId(user.branchId);

    const sale = await Sale.findOne(query).select("_id branchId").lean();
    if (!sale) {
      return NextResponse.json(notFound("No completed sale matches that receipt number"), { status: 404 });
    }
    assertBranchAccess(user, sale.branchId);

    const data = await lookupSaleForReturn(sale._id.toString());
    if (!data) {
      return NextResponse.json(notFound("Sale not found"), { status: 404 });
    }

    return NextResponse.json({ success: true, ...data });
  } catch (error) {
    if (error instanceof BranchAccessError) {
      return NextResponse.json(forbidden(error.message), { status: 403 });
    }
    console.error("GET /api/pos/sales-lookup error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
