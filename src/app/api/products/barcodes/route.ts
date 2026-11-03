import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { z } from "zod";
import { connectDB } from "@/lib/mongodb";
import { Product } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasAnyPermission, hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { success, badRequest, forbidden, notFound } from "@/lib/api";
import { recordAuditLog, requestMeta } from "@/lib/audit";
import { escapeRegex } from "@/lib/reports";
import { generateEan13, isScannableCode, normalizeBarcode, suggestedBarcodeLabel } from "@/lib/barcode";

/**
 * Barcode management.
 *
 * A barcode identifies exactly one sellable product/variant, so uniqueness is
 * checked across the primary `barcode` field AND every entry of `barcodes` of
 * every other product. Variants are separate linked products, which is why a
 * flavour variant can hold its own barcodes without sharing stock or price.
 *
 * `action=generate` creates an EAN-13 in the internal "200" range. That is a
 * local labelling convenience — it is NOT GS1 registration or authorisation.
 */

type BarcodeRow = {
  code: string;
  label: string;
  productId: string;
  productName: string;
  sku: string;
  variantName: string;
  primary: boolean;
};

const addSchema = z.object({
  action: z.enum(["add", "update", "remove", "generate"]),
  productId: z.string().min(1, "Product is required"),
  code: z.string().optional(),
  label: z.string().max(80).optional(),
  /** Previous code when editing an existing barcode. */
  oldCode: z.string().optional(),
});

async function findConflict(code: string, excludeProductId?: string) {
  const normalized = normalizeBarcode(code);
  if (!normalized) return null;
  const exact = new RegExp(`^${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const query: Record<string, unknown> = {
    $or: [{ barcode: exact }, { "barcodes.code": exact }],
  };
  if (excludeProductId) query._id = { $ne: new mongoose.Types.ObjectId(excludeProductId) };
  return Product.findOne(query).select("name sku").lean();
}

function rowsForProduct(product: {
  _id: unknown;
  name: string;
  sku?: string;
  variantName?: string;
  barcode?: string;
  barcodes?: Array<{ code: string; label?: string }>;
}): BarcodeRow[] {
  const rows: BarcodeRow[] = [];
  const primary = (product.barcode ?? "").toUpperCase();
  if (primary) {
    rows.push({
      code: primary,
      label: "Primary",
      productId: String(product._id),
      productName: product.name,
      sku: product.sku ?? "",
      variantName: product.variantName ?? "",
      primary: true,
    });
  }
  for (const entry of product.barcodes ?? []) {
    const code = (entry.code ?? "").toUpperCase();
    if (!code || code === primary) continue;
    rows.push({
      code,
      label: entry.label ?? "",
      productId: String(product._id),
      productName: product.name,
      sku: product.sku ?? "",
      variantName: product.variantName ?? "",
      primary: false,
    });
  }
  return rows;
}

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasAnyPermission(user, [PERMISSIONS.products.view, PERMISSIONS.products.update]))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const productId = searchParams.get("productId")?.trim() ?? "";
    const search = searchParams.get("search")?.trim() ?? "";

    const query: Record<string, unknown> = {};
    if (productId) query._id = new mongoose.Types.ObjectId(productId);
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      query.$or = [
        { name: rx },
        { sku: rx },
        { barcode: rx },
        { "barcodes.code": rx },
        { "barcodes.label": rx },
      ];
    }

    const products = await Product.find(query)
      .select("name sku variantName barcode barcodes")
      .sort({ name: 1 })
      .limit(500)
      .lean();

    const rows = products.flatMap((p) => rowsForProduct(p));

    return NextResponse.json({
      barcodes: rows,
      total: rows.length,
      products: products.length,
    });
  } catch (error) {
    console.error("GET /api/products/barcodes error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    const canManage =
      (await hasPermission(user, PERMISSIONS.products.update)) ||
      (await hasPermission(user, PERMISSIONS.products.create));
    if (!canManage) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const parsed = addSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const err of parsed.error.errors) fieldErrors[String(err.path[0])] = err.message;
      return NextResponse.json(badRequest("Validation failed", fieldErrors), { status: 400 });
    }

    const { action, productId, oldCode } = parsed.data;
    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return NextResponse.json(badRequest("Invalid product id"), { status: 400 });
    }

    const product = await Product.findById(productId);
    if (!product) {
      return NextResponse.json(notFound("Product not found"), { status: 404 });
    }

    const meta = requestMeta(req);
    const extras = (product.barcodes ?? []).map((b) => ({ code: b.code, label: b.label ?? "" }));
    let message = "Barcode updated";
    let auditAction = "product.barcode.updated";

    if (action === "add" || action === "generate") {
      let code = normalizeBarcode(parsed.data.code ?? "");
      let label = parsed.data.label?.trim() ?? "";

      if (action === "generate") {
        let attempt = 0;
        do {
          code = generateEan13();
          attempt += 1;
        } while ((await findConflict(code)) && attempt < 25);
        if (await findConflict(code)) {
          return NextResponse.json(badRequest("Could not generate a unique barcode, please try again"), { status: 400 });
        }
        label = label || suggestedBarcodeLabel((product.barcode ? 1 : 0) + extras.length);
        message = "Barcode generated";
        auditAction = "product.barcode.generated";
      } else {
        if (!isScannableCode(code)) {
          return NextResponse.json(
            badRequest("Validation failed", { code: "Use 4–48 letters, digits, hyphens, dots or underscores" }),
            { status: 400 }
          );
        }
        const conflict = await findConflict(code);
        if (conflict) {
          return NextResponse.json(badRequest(`Barcode ${code} is already assigned to ${conflict.name}`), { status: 400 });
        }
        auditAction = "product.barcode.added";
        message = "Barcode added";
      }

      if (!product.barcode) {
        product.set("barcode", code);
      }
      if (!extras.some((b) => b.code === code) && code !== product.barcode) {
        extras.push({ code, label });
      }
      product.barcodes = extras;
    } else if (action === "update") {
      const source = normalizeBarcode(oldCode ?? parsed.data.code ?? "");
      const nextCode = normalizeBarcode(parsed.data.code ?? "");
      if (!source) {
        return NextResponse.json(badRequest("Barcode to edit is required"), { status: 400 });
      }
      if (!isScannableCode(nextCode)) {
        return NextResponse.json(
          badRequest("Validation failed", { code: "Use 4–48 letters, digits, hyphens, dots or underscores" }),
          { status: 400 }
        );
      }
      const conflict = await findConflict(nextCode, product._id.toString());
      if (conflict) {
        return NextResponse.json(badRequest(`Barcode ${nextCode} is already assigned to ${conflict.name}`), { status: 400 });
      }

      const isPrimary = (product.barcode ?? "").toUpperCase() === source;
      const index = extras.findIndex((b) => b.code.toUpperCase() === source);
      if (!isPrimary && index === -1) {
        return NextResponse.json(notFound("Barcode not found on this product"), { status: 404 });
      }
      if (isPrimary) {
        product.set("barcode", nextCode);
        // Avoid duplicating the primary inside the extra list.
        const remaining = extras.filter((b) => b.code.toUpperCase() !== nextCode);
        const movedIndex = remaining.findIndex((b) => b.code.toUpperCase() === source);
        if (movedIndex !== -1) remaining[movedIndex].label = parsed.data.label?.trim() ?? remaining[movedIndex].label;
        product.barcodes = remaining;
      } else {
        extras[index] = {
          code: nextCode,
          label: parsed.data.label?.trim() ?? extras[index].label,
        };
        if ((product.barcode ?? "").toUpperCase() === nextCode) {
          // Promote semantics stay simple: prevent the extra list duplicating primary.
          extras.splice(index, 1);
        }
        product.barcodes = extras;
      }
    } else {
      const code = normalizeBarcode(parsed.data.code ?? oldCode ?? "");
      if (!code) {
        return NextResponse.json(badRequest("Barcode is required"), { status: 400 });
      }
      const isPrimary = (product.barcode ?? "").toUpperCase() === code;
      if (isPrimary) {
        product.set("barcode", undefined);
      }
      product.barcodes = extras.filter((b) => b.code.toUpperCase() !== code);
      message = "Barcode removed";
      auditAction = "product.barcode.removed";
    }

    await product.save();

    await recordAuditLog({
      user,
      action: auditAction,
      entityType: "Product",
      entityId: product._id.toString(),
      newValue: {
        primary: product.barcode ?? null,
        barcodes: (product.barcodes ?? []).map((b) => b.code),
      },
      branchId: product.branchId?.toString() ?? null,
      ...meta,
    });

    return NextResponse.json(
      success(
        {
          product: {
            _id: product._id.toString(),
            name: product.name,
            sku: product.sku,
            barcode: product.barcode ?? "",
            barcodes: rowsForProduct(product.toObject()),
          },
        },
        message
      )
    );
  } catch (error) {
    console.error("POST /api/products/barcodes error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
