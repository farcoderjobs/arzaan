import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Sale } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { badRequest, forbidden, notFound } from "@/lib/api";
import { lookupSaleForReturn } from "@/lib/exchange-service";
import { assertBranchAccess, BranchAccessError } from "@/lib/branch-access";

/**
 * GET /api/pos/sales-lookup?invoice=INV-… (or ?saleId=…)
 * Returns the original sale with per-line returnable quantities for the POS
 * refund/exchange screen. Requires refund authority.
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
