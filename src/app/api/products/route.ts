import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { Product, Category, Brand, Department } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { z } from "zod";
import { success, badRequest, forbidden, notFound } from "@/lib/api";
import mongoose from "mongoose";

const barcodeEntrySchema = z.object({
  code: z.string().trim().min(1, "Barcode is required"),
  label: z.string().trim().max(80).default(""),
});

const createSchema = z.object({
  name: z.string().min(1, "Product name is required"),
  sku: z.string().min(1, "SKU is required"),
  barcode: z.string().optional(),
  /** Extra barcodes (flavours / packaging variants of the same sellable product). */
  barcodes: z.array(barcodeEntrySchema).max(50).optional(),
  /** Optional product-level expiry (batches received by purchase override it). */
  expirationDate: z.string().trim().nullable().optional(),
  /** Variants are linked product rows with their own price and stock. */
  parentProductId: z.string().trim().nullable().optional(),
  variantName: z.string().trim().max(120).default(""),
  categoryId: z.string().optional().nullable(),
  brandId: z.string().optional().nullable(),
  /** Department that owns the product (sales are reported there). */
  departmentId: z.string().optional().nullable(),
  /** Import (China) vs Local origin, used when a sold batch has no source. */
  purchaseSource: z.enum(["import", "local"]).nullish(),
  purchasePrice: z.number().min(0, "Purchase price cannot be negative").default(0),
  sellingPrice: z.number().min(0, "Selling price cannot be negative").default(0),
  wholesalePrice: z.number().min(0, "Wholesale price cannot be negative").default(0),
  tax: z.number().min(0).max(100).default(0),
  discount: z.number().min(0).max(100).default(0),
  minimumStock: z.number().int().min(0).default(0),
  description: z.string().default(""),
  status: z.enum(["active", "inactive"]).default("active"),
});

const saveSchema = createSchema.extend({
  // `id` present → update, absent/null → create (matches what the client sends).
  id: z.string().min(1).nullish(),
});

/**
 * MongoDB duplicate-key errors (E11000) → 400 with a human message instead of
 * a bare 500. Catches races the pre-insert uniqueness checks cannot (e.g. two
 * submits of the same SKU/barcode at once).
 */
/** Normalizes + de-duplicates the extra barcode list. */
function normalizeBarcodes(entries: Array<{ code: string; label: string }> | undefined) {
  const seen = new Set<string>();
  const result: Array<{ code: string; label: string }> = [];
  for (const entry of entries ?? []) {
    const code = entry.code.trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    result.push({ code, label: entry.label.trim() });
  }
  return result;
}

/**
 * One barcode may identify only one product/variant. Checks both the primary
 * `barcode` field and every entry of the `barcodes` array of other products.
 */
async function findBarcodeConflict(code: string, excludeId?: string) {
  const normalized = code.trim();
  if (!normalized) return null;
  // Case-insensitive so legacy lower-case barcodes cannot be duplicated.
  const exact = new RegExp(`^${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const query: Record<string, unknown> = {
    $or: [{ barcode: exact }, { "barcodes.code": exact }],
  };
  if (excludeId) query._id = { $ne: excludeId };
  return Product.findOne(query).select("name sku barcode").lean();
}

/**
 * Parses an optional date string. Absent/empty input → null (no date).
 * Returns undefined ONLY for an unparseable value so the caller can reject it.
 */
function parseOptionalDate(value: string | null | undefined): Date | null | undefined {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}

function duplicateKeyResponse(error: unknown): NextResponse | null {
  const e = error as { name?: string; message?: string } | null | undefined;
  if (!e || !/E11000/.test(e.message ?? "")) return null;
  const index = /index: ([\w.]+)/.exec(e.message ?? "")?.[1] ?? "";
  const label = index.includes("barcode") ? "barcode" : index.includes("sku") ? "SKU" : index.includes("purchaseNumber") ? "purchase number" : index;
  return NextResponse.json(badRequest(`A product with this ${label} already exists`), { status: 400 });
}

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.products.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const page = Math.max(1, Number(searchParams.get("page") ?? 1));
    const perPage = Math.min(100, Math.max(1, Number(searchParams.get("perPage") ?? 15)));
    const search = searchParams.get("search")?.trim() ?? "";
    const skuFilter = searchParams.get("sku")?.trim() ?? "";
    const status = searchParams.get("status")?.trim() ?? "";
    const categoryId = searchParams.get("categoryId")?.trim() ?? "";
    const brandId = searchParams.get("brandId")?.trim() ?? "";
    const departmentId = searchParams.get("departmentId")?.trim() ?? "";

    const query: Record<string, unknown> = {};
    if (status) query.status = status;
    if (categoryId) query.categoryId = categoryId;
    if (brandId) query.brandId = brandId;
    if (departmentId) query.departmentId = departmentId;

    let textQuery: Record<string, unknown> = {};
    if (search) {
      textQuery = {
        $or: [
          { name: { $regex: search, $options: "i" } },
          { sku: { $regex: search, $options: "i" } },
          { barcode: { $regex: search, $options: "i" } },
          { "barcodes.code": { $regex: search, $options: "i" } },
        ],
      };
    }
    if (skuFilter === "sku" && search) {
      query.sku = { $regex: search, $options: "i" };
      textQuery = {};
    } else if (skuFilter === "barcode" && search) {
      query.barcode = { $regex: search, $options: "i" };
      textQuery = {};
    }

    const andQuery = Object.keys(query).length ? [query, textQuery] : [textQuery];
    const filter = { $and: andQuery.filter(Boolean) } as Record<string, unknown>;

    const total = await Product.countDocuments(filter);      const products = await Product.find(filter)
      .populate<{ categoryId: { name: string } }>("categoryId", "name")
      .populate<{ brandId: { name: string } }>("brandId", "name")
      .populate<{ departmentId: { name: string } }>("departmentId", "name")
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean() as Array<Record<string, unknown>>;

    return NextResponse.json({
      products: products.map((p) => ({
        ...p,
        categoryId: p.categoryId as { _id: string; name: string } | null,
        brandId: p.brandId as { _id: string; name: string } | null,
        departmentId: p.departmentId as { _id: string; name: string } | null,
        departmentName: (p.departmentId as { name?: string } | null)?.name ?? "",
      })),
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    });
  } catch (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.products.create))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const body = await req.json();
    const parsed = saveSchema.safeParse(body);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      parsed.error.errors.forEach((err) => {
        const path = err.path[0];
        if (typeof path === "string") fieldErrors[path] = err.message;
      });
      return NextResponse.json(badRequest("Validation failed", fieldErrors), { status: 400 });
    }

    const data = parsed.data;
    const isUpdate = Boolean(data.id);
    const now = new Date();

    const expirationDate = parseOptionalDate(data.expirationDate);
    if (expirationDate === undefined) {
      return NextResponse.json(badRequest("Validation failed", { expirationDate: "Invalid date" }), { status: 400 });
    }
    const barcodes = normalizeBarcodes(data.barcodes);

    if (!isUpdate) {
      // Create
      if (data.barcode) {
        const conflict = await findBarcodeConflict(data.barcode);
        if (conflict) {
          return NextResponse.json(
            badRequest(`This barcode already exists — it is assigned to ${conflict.name}`),
            { status: 400 }
          );
        }
      }
      for (const entry of barcodes) {
        const conflict = await findBarcodeConflict(entry.code);
        if (conflict) {
          return NextResponse.json(
            badRequest(`This barcode already exists — ${entry.code} is assigned to ${conflict.name}`),
            { status: 400 }
          );
        }
      }
      const skuExists = await Product.findOne({ sku: data.sku });
      if (skuExists) {
        return NextResponse.json(badRequest("A product with this SKU already exists"), { status: 400 });
      }

      if (data.parentProductId) {
        const parent = await Product.findById(data.parentProductId);
        if (!parent) {
          return NextResponse.json(badRequest("Parent product not found"), { status: 400 });
        }
      }

      if (data.categoryId) {
        const cat = await Category.findById(data.categoryId);
        if (!cat) {
          return NextResponse.json(badRequest("Category not found"), { status: 400 });
        }
      }
      if (data.brandId) {
        const brand = await Brand.findById(data.brandId);
        if (!brand) {
          return NextResponse.json(badRequest("Brand not found"), { status: 400 });
        }
      }
      if (data.departmentId) {
        const department = await Department.findById(data.departmentId);
        if (!department) {
          return NextResponse.json(badRequest("Department not found"), { status: 400 });
        }
      }

      const product = await Product.create({
        name: data.name.trim(),
        sku: data.sku.trim().toUpperCase(),
        // Empty barcodes must stay OUT of the document: the unique sparse
        // barcode index treats "" as a value, so two products without a
        // barcode would collide with E11000 (surfaced as a 500). Leaving the
        // path undefined omits the field and the sparse index skips it.
        barcode: data.barcode?.trim().toUpperCase() || undefined,
        barcodes,
        expirationDate: expirationDate ?? null,
        parentProductId: (data.parentProductId || null) as unknown as mongoose.Types.ObjectId | null,
        variantName: data.variantName,
        categoryId: data.categoryId as unknown as mongoose.Types.ObjectId,
        brandId: (data.brandId || null) as unknown as mongoose.Types.ObjectId | null,
        departmentId: (data.departmentId || null) as unknown as mongoose.Types.ObjectId | null,
        purchaseSource: data.purchaseSource ?? null,
        costPrice: data.purchasePrice,
        sellingPrice: data.sellingPrice,
        discountPrice: data.wholesalePrice,
        taxRate: data.tax,
        discount: data.discount,
        reorderPoint: data.minimumStock,
        description: data.description.trim(),
        status: data.status,
      });

      return NextResponse.json(success({ product }, "Product created"), { status: 201 });
    }
    // Update
    const product = await Product.findById(data.id);
    if (!product) {
      return NextResponse.json(notFound("Product not found"), { status: 404 });
    }

    if (data.categoryId) {
      const cat = await Category.findById(data.categoryId);
      if (!cat) {
        return NextResponse.json(badRequest("Category not found"), { status: 400 });
      }
    }
    if (data.brandId) {
      const brand = await Brand.findById(data.brandId);
      if (!brand) {
        return NextResponse.json(badRequest("Brand not found"), { status: 400 });
      }
    }
    if (data.departmentId) {
      const department = await Department.findById(data.departmentId);
      if (!department) {
        return NextResponse.json(badRequest("Department not found"), { status: 400 });
      }
    }

    // SKU uniqueness
    if (data.sku && data.sku !== product.sku) {
      const exists = await Product.findOne({ sku: data.sku, _id: { $ne: product._id } });
      if (exists) {
        return NextResponse.json(badRequest("Another product with this SKU already exists"), { status: 400 });
      }
    }
    const normalizedBarcode = data.barcode?.trim().toUpperCase() ?? "";
    if (normalizedBarcode && normalizedBarcode !== ((product.barcode ?? "").toUpperCase())) {
      const conflict = await findBarcodeConflict(normalizedBarcode, product._id.toString());
      if (conflict) {
        return NextResponse.json(
          badRequest(`This barcode already exists — it is assigned to ${conflict.name}`),
          { status: 400 }
        );
      }
    }
    for (const entry of barcodes) {
      if (entry.code === normalizedBarcode) continue;
      const conflict = await findBarcodeConflict(entry.code, product._id.toString());
      if (conflict) {
        return NextResponse.json(
          badRequest(`This barcode already exists — ${entry.code} is assigned to ${conflict.name}`),
          { status: 400 }
        );
      }
    }
    if (data.parentProductId) {
      if (data.parentProductId === product._id.toString()) {
        return NextResponse.json(badRequest("A product cannot be its own variant parent"), { status: 400 });
      }
      const parent = await Product.findById(data.parentProductId);
      if (!parent) {
        return NextResponse.json(badRequest("Parent product not found"), { status: 400 });
      }
    }

    product.name = data.name.trim();
    product.sku = data.sku.trim().toUpperCase();
    // Same sparse-index rule as create: clearing the barcode unsets the field
    // instead of storing "" (which would collide with other barcode-less rows).
    product.set("barcode", data.barcode?.trim().toUpperCase() || undefined);
    // Only touch the barcode list when the caller actually sent one — editing
    // name/price from the product form must not wipe extra barcodes.
    if (data.barcodes !== undefined) product.barcodes = barcodes;
    product.expirationDate = expirationDate ?? null;
    product.parentProductId = (data.parentProductId || null) as unknown as mongoose.Types.ObjectId | null;
    product.variantName = data.variantName;
    product.categoryId = data.categoryId as unknown as mongoose.Types.ObjectId;
    product.brandId = (data.brandId || null) as unknown as mongoose.Types.ObjectId | null;
    product.departmentId = (data.departmentId || null) as unknown as mongoose.Types.ObjectId | null;
    if (data.purchaseSource !== undefined) product.purchaseSource = data.purchaseSource ?? null;
    product.costPrice = data.purchasePrice;
    product.sellingPrice = data.sellingPrice;
    product.discountPrice = data.wholesalePrice;
    product.taxRate = data.tax;
    product.discount = data.discount;
    product.reorderPoint = data.minimumStock;
    product.description = data.description.trim();
    product.status = data.status;

    await product.save();

    return NextResponse.json(success({ product }, "Product updated"));
  } catch (error) {
    const duplicate = duplicateKeyResponse(error);
    if (duplicate) return duplicate;
    console.error("POST /api/products error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.products.delete))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const body = await req.json();
    const { id } = body as { id?: string };
    if (!id) {
      return NextResponse.json(badRequest("Product ID is required"), { status: 400 });
    }

    const product = await Product.findById(id);
    if (!product) {
      return NextResponse.json(notFound("Product not found"), { status: 404 });
    }

    // Do not hard delete products with sales/inventory history
    const hasSales = await mongoose.model("Sale").exists({ "items.productId": product._id });
    const hasPurchases = await mongoose.model("Purchase").exists({ "items.productId": product._id });
    const hasInventory = await mongoose.model("InventoryMovement").exists({ productId: product._id });

    if (hasSales || hasPurchases || hasInventory) {
      // Archive instead of delete
      product.status = "archived";
      await product.save();
      return NextResponse.json(success({ product }, "Product archived due to existing records"));
    }

    await Product.deleteOne({ _id: product._id });
    return NextResponse.json(success(null, "Product deleted"));
  } catch (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

/** Status toggle: activate ⇄ deactivate (reversible — see the products screen). */
export async function PATCH(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    const canToggle =
      (await hasPermission(user, PERMISSIONS.products.update)) ||
      (await hasPermission(user, PERMISSIONS.products.create));
    if (!canToggle) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const statusSchema = z.object({
      id: z.string().min(1, "Product ID is required"),
      status: z.enum(["active", "inactive"], {
        errorMap: () => ({ message: "Status must be active or inactive" }),
      }),
    });
    const parsed = statusSchema.safeParse(await req.json());
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      parsed.error.errors.forEach((err) => {
        const path = err.path[0];
        if (typeof path === "string") fieldErrors[path] = err.message;
      });
      return NextResponse.json(badRequest("Validation failed", fieldErrors), { status: 400 });
    }

    const product = await Product.findById(parsed.data.id);
    if (!product) {
      return NextResponse.json(notFound("Product not found"), { status: 404 });
    }

    product.status = parsed.data.status;
    await product.save();

    return NextResponse.json(
      success(
        { product },
        parsed.data.status === "active" ? "Product activated" : "Product deactivated"
      )
    );
  } catch (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
