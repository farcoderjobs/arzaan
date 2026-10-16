import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { Product, Category, Brand } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { z } from "zod";
import { success, badRequest, forbidden, notFound } from "@/lib/api";
import mongoose from "mongoose";

const createSchema = z.object({
  name: z.string().min(1, "Product name is required"),
  sku: z.string().min(1, "SKU is required"),
  barcode: z.string().optional(),
  categoryId: z.string().optional().nullable(),
  brandId: z.string().optional().nullable(),
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

    const query: Record<string, unknown> = {};
    if (status) query.status = status;
    if (categoryId) query.categoryId = categoryId;
    if (brandId) query.brandId = brandId;

    let textQuery: Record<string, unknown> = {};
    if (search) {
      textQuery = {
        $or: [
          { name: { $regex: search, $options: "i" } },
          { sku: { $regex: search, $options: "i" } },
          { barcode: { $regex: search, $options: "i" } },
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
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean() as Array<Record<string, unknown>>;

    return NextResponse.json({
      products: products.map((p) => ({
        ...p,
        categoryId: p.categoryId as { _id: string; name: string } | null,
        brandId: p.brandId as { _id: string; name: string } | null,
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

    if (!isUpdate) {
      // Create
      if (data.barcode) {
        const exists = await Product.findOne({ barcode: data.barcode });
        if (exists) {
          return NextResponse.json(badRequest("A product with this barcode already exists"), { status: 400 });
        }
      }
      const skuExists = await Product.findOne({ sku: data.sku });
      if (skuExists) {
        return NextResponse.json(badRequest("A product with this SKU already exists"), { status: 400 });
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

      const product = await Product.create({
        name: data.name.trim(),
        sku: data.sku.trim().toUpperCase(),
        // Empty barcodes must stay OUT of the document: the unique sparse
        // barcode index treats "" as a value, so two products without a
        // barcode would collide with E11000 (surfaced as a 500). Leaving the
        // path undefined omits the field and the sparse index skips it.
        barcode: data.barcode?.trim().toUpperCase() || undefined,
        categoryId: data.categoryId as unknown as mongoose.Types.ObjectId,
        brandId: (data.brandId || null) as unknown as mongoose.Types.ObjectId | null,
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

    // SKU uniqueness
    if (data.sku && data.sku !== product.sku) {
      const exists = await Product.findOne({ sku: data.sku, _id: { $ne: product._id } });
      if (exists) {
        return NextResponse.json(badRequest("Another product with this SKU already exists"), { status: 400 });
      }
    }
    if (data.barcode && data.barcode !== product.barcode) {
      const exists = await Product.findOne({ barcode: data.barcode, _id: { $ne: product._id } });
      if (exists) {
        return NextResponse.json(badRequest("Another product with this barcode already exists"), { status: 400 });
      }
    }

    product.name = data.name.trim();
    product.sku = data.sku.trim().toUpperCase();
    // Same sparse-index rule as create: clearing the barcode unsets the field
    // instead of storing "" (which would collide with other barcode-less rows).
    product.set("barcode", data.barcode?.trim().toUpperCase() || undefined);
    product.categoryId = data.categoryId as unknown as mongoose.Types.ObjectId;
    product.brandId = (data.brandId || null) as unknown as mongoose.Types.ObjectId | null;
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
    return duplicateKeyResponse(error) ?? NextResponse.json({ error: "Internal error" }, { status: 500 });
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
