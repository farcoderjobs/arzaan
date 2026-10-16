import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { z } from "zod";
import { connectDB } from "@/lib/mongodb";
import { StoreProduct } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { success, badRequest, forbidden, notFound } from "@/lib/api";
import { recordAuditLog, requestMeta } from "@/lib/audit";
import { parsePage } from "@/lib/reports";

/**
 * Admin CRUD for online store products (/store-products in the dashboard).
 * These are curated separately from POS products — only what an admin adds
 * here is sold on the public storefront.
 */

const ACCENTS = ["indigo", "emerald", "rose", "amber", "sky", "violet", "slate"] as const;

const saveSchema = z.object({
  id: z.string().min(1).nullish(),
  name: z.string().trim().min(2, "Name is required").max(160),
  description: z.string().trim().max(1000).default(""),
  price: z.number().min(0, "Price cannot be negative"),
  compareAtPrice: z.number().min(0).default(0),
  accent: z.enum(ACCENTS).default("indigo"),
  imageUrl: z.string().trim().max(500).default(""),
  category: z.string().trim().max(80).default("General"),
  stock: z.number().int().min(0, "Stock cannot be negative").default(0),
  featured: z.boolean().default(false),
  status: z.enum(["active", "inactive"]).default("active"),
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function uniqueSlug(base: string, excludeId?: string): Promise<string> {
  let slug = base || "product";
  let attempt = 0;
  // Append -2, -3… until the slug is free (or belongs to the edited row).
  for (;;) {
    const existing = await StoreProduct.findOne({
      slug,
      ...(excludeId ? { _id: { $ne: new mongoose.Types.ObjectId(excludeId) } } : {}),
    });
    if (!existing) return slug;
    attempt += 1;
    slug = `${base}-${attempt}`;
  }
}

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    // The admin table is not a read-only screen — managing products requires
    // the manage permission for every verb (server-enforced, not just hidden UI).
    if (!(await hasPermission(user, PERMISSIONS.store.manage))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const { page, perPage } = parsePage(searchParams);
    const search = searchParams.get("search")?.trim() ?? "";
    const status = searchParams.get("status")?.trim() ?? "";

    const query: Record<string, unknown> = {};
    if (status === "active" || status === "inactive") query.status = status;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
      ];
    }

    const total = await StoreProduct.countDocuments(query);
    const products = await StoreProduct.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean();

    return NextResponse.json({
      products: products.map((p) => ({ ...p, id: p._id.toString() })),
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    });
  } catch (error) {
    console.error("GET /api/store/admin error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.store.manage))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const parsed = saveSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const err of parsed.error.errors) {
        fieldErrors[String(err.path[0])] = err.message;
      }
      return NextResponse.json(badRequest("Validation failed", fieldErrors), { status: 400 });
    }
    const data = parsed.data;

    if (data.compareAtPrice > 0 && data.compareAtPrice <= data.price) {
      return NextResponse.json(
        badRequest("Compare-at price must be higher than the selling price", {
          compareAtPrice: "Must be higher than the price",
        }),
        { status: 400 }
      );
    }

    const slug = await uniqueSlug(slugify(data.name));
    const product = await StoreProduct.create({ ...data, slug });

    await recordAuditLog({
      user,
      action: "store.product.created",
      entityType: "StoreProduct",
      entityId: product._id,
      newValue: { name: product.name, price: product.price, stock: product.stock },
      ...requestMeta(req),
    });

    return NextResponse.json(success({ product: { ...product.toObject(), id: product._id.toString() } }, "Product added to the online store"), {
      status: 201,
    });
  } catch (error) {
    console.error("POST /api/store/admin error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.store.manage))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const body = await req.json().catch(() => null);
    const id = typeof body?.id === "string" ? body.id : "";
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(badRequest("Product ID is required"), { status: 400 });
    }

    const product = await StoreProduct.findById(id);
    if (!product) {
      return NextResponse.json(notFound("Store product not found"), { status: 404 });
    }

    // Toggle-only patch (status / featured) — used by the row switches. When
    // `name` is present it is a full edit, handled by the saveSchema below.
    const toggleSchema = z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      status: z.enum(["active", "inactive"]).optional(),
      featured: z.boolean().optional(),
    });
    const toggleParsed = toggleSchema.safeParse(body);
    if (toggleParsed.success && toggleParsed.data.name === undefined) {
      const before = { status: product.status, featured: product.featured };
      if (toggleParsed.data.status) product.status = toggleParsed.data.status;
      if (toggleParsed.data.featured !== undefined) product.featured = toggleParsed.data.featured;
      await product.save();
      await recordAuditLog({
        user,
        action: "store.product.updated",
        entityType: "StoreProduct",
        entityId: product._id,
        changes: {
          status: { before: before.status, after: product.status },
          featured: { before: before.featured, after: product.featured },
        },
        ...requestMeta(req),
      });
      return NextResponse.json(success({ product: { ...product.toObject(), id: product._id.toString() } }, "Product updated"));
    }

    const parsed = saveSchema.safeParse(body);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const err of parsed.error.errors) {
        fieldErrors[String(err.path[0])] = err.message;
      }
      return NextResponse.json(badRequest("Validation failed", fieldErrors), { status: 400 });
    }
    const data = parsed.data;

    if (data.compareAtPrice > 0 && data.compareAtPrice <= data.price) {
      return NextResponse.json(
        badRequest("Compare-at price must be higher than the selling price", {
          compareAtPrice: "Must be higher than the price",
        }),
        { status: 400 }
      );
    }

    const before = {
      name: product.name,
      price: product.price,
      stock: product.stock,
      status: product.status,
    };

    product.name = data.name;
    // Keep the slug stable once created (links/orders reference it), unless the
    // product was never meaningfully named.
    if (!product.slug) product.slug = await uniqueSlug(slugify(data.name), product._id.toString());
    product.description = data.description;
    product.price = data.price;
    product.compareAtPrice = data.compareAtPrice;
    product.accent = data.accent;
    product.imageUrl = data.imageUrl;
    product.category = data.category || "General";
    product.stock = data.stock;
    product.featured = data.featured;
    product.status = data.status;
    await product.save();

    await recordAuditLog({
      user,
      action: "store.product.updated",
      entityType: "StoreProduct",
      entityId: product._id,
      changes: {
        name: { before: before.name, after: product.name },
        price: { before: before.price, after: product.price },
        stock: { before: before.stock, after: product.stock },
        status: { before: before.status, after: product.status },
      },
      ...requestMeta(req),
    });

    return NextResponse.json(success({ product: { ...product.toObject(), id: product._id.toString() } }, "Product updated"));
  } catch (error) {
    console.error("PATCH /api/store/admin error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.store.manage))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const body = await req.json().catch(() => null);
    const id = typeof body?.id === "string" ? body.id : "";
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(badRequest("Product ID is required"), { status: 400 });
    }

    const product = await StoreProduct.findById(id);
    if (!product) {
      return NextResponse.json(notFound("Store product not found"), { status: 404 });
    }

    await product.deleteOne();
    await recordAuditLog({
      user,
      action: "store.product.deleted",
      entityType: "StoreProduct",
      entityId: product._id,
      oldValue: { name: product.name, price: product.price },
      ...requestMeta(req),
    });

    return NextResponse.json(success(null, "Product removed from the online store"));
  } catch (error) {
    console.error("DELETE /api/store/admin error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
