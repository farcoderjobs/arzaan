import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { z } from "zod";
import { connectDB } from "@/lib/mongodb";
import { DiscountOffer, Department, Category, Product } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { success, badRequest, forbidden, notFound } from "@/lib/api";

/**
 * Discount offers API.
 *
 * GET    /api/discounts?all=1  → offers (inactive included) with target names
 * POST   /api/discounts        → create an offer
 * PUT    /api/discounts        → update an offer (id required)
 * PATCH  /api/discounts        → activate / deactivate an offer
 * DELETE /api/discounts        → remove an offer
 *
 * Offers are resolved by the POS and by the sales service at checkout, so the
 * discounted price and the charged price always come from the same rules.
 */

const objectIdField = z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid id");

const createSchema = z.object({
  name: z.string().trim().min(1, "Offer name is required").max(120),
  percentage: z.number().min(0.01, "Percentage must be greater than 0").max(100, "Percentage cannot exceed 100"),
  startDate: z.string().trim().min(1, "Start date is required"),
  endDate: z.string().trim().min(1, "End date is required"),
  /** Multi-select targets: a product matches any selected department/category/product. */
  departmentIds: z.array(objectIdField).max(500).default([]),
  categoryIds: z.array(objectIdField).max(500).default([]),
  productIds: z.array(objectIdField).max(2000).default([]),
  status: z.enum(["active", "inactive"]).default("active"),
  note: z.string().trim().max(300).default(""),
});

const updateSchema = createSchema.extend({
  id: objectIdField,
});

const statusSchema = z.object({
  id: objectIdField,
  status: z.enum(["active", "inactive"]),
});

function fieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  err.errors.forEach((e) => {
    const path = e.path[0];
    if (typeof path === "string") out[path] = e.message;
  });
  return out;
}

/**
 * Offer dates are calendar days: the start begins at 00:00 and the end covers
 * the whole final day, so "starts 1 Nov, ends 3 Nov" is live for all of 3 Nov.
 */
function parseOfferDate(value: string, endOfDay: boolean): Date | null {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = dateOnly
    ? new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function idOf(value: unknown): string {
  return typeof value === "object" && value !== null && "_id" in value
    ? String((value as { _id: unknown })._id)
    : String(value);
}

function toRow(offer: Record<string, unknown>) {
  const targetIds = (value: unknown) => ((value ?? []) as unknown[]).map(idOf);
  const targetNames = (value: unknown) =>
    ((value ?? []) as Array<{ name?: string } | null>)
      .map((row) => (row && typeof row === "object" ? row.name ?? "" : ""))
      .filter(Boolean);

  return {
    _id: String(offer._id),
    name: offer.name,
    percentage: offer.percentage,
    startDate: offer.startDate,
    endDate: offer.endDate,
    departmentIds: targetIds(offer.departmentIds),
    departmentNames: targetNames(offer.departmentIds),
    categoryIds: targetIds(offer.categoryIds),
    categoryNames: targetNames(offer.categoryIds),
    productIds: targetIds(offer.productIds),
    productNames: targetNames(offer.productIds),
    status: offer.status,
    note: offer.note ?? "",
    createdAt: offer.createdAt,
  };
}

/** Every selected target id must still exist in its catalog. */
async function validateTargets(data: {
  departmentIds: string[];
  categoryIds: string[];
  productIds: string[];
}): Promise<string | null> {
  const checks: Array<{ label: string; ids: string[]; count: (ids: string[]) => Promise<number> }> = [
    {
      label: "department",
      ids: data.departmentIds,
      count: (ids) => Department.countDocuments({ _id: { $in: ids } }),
    },
    {
      label: "category",
      ids: data.categoryIds,
      count: (ids) => Category.countDocuments({ _id: { $in: ids } }),
    },
    {
      label: "product",
      ids: data.productIds,
      count: (ids) => Product.countDocuments({ _id: { $in: ids } }),
    },
  ];

  for (const check of checks) {
    const ids = uniqueIds(check.ids);
    if (ids.length === 0) continue;
    const found = await check.count(ids);
    if (found !== ids.length) {
      return `One or more selected ${check.label}s no longer exist`;
    }
  }
  return null;
}

/** At least one target is required, otherwise the offer would never apply. */
function validateSelection(data: { departmentIds: string[]; categoryIds: string[]; productIds: string[] }) {
  if (
    uniqueIds(data.departmentIds).length === 0 &&
    uniqueIds(data.categoryIds).length === 0 &&
    uniqueIds(data.productIds).length === 0
  ) {
    return "Select at least one department, category or product";
  }
  return null;
}

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.discounts.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const includeAll = searchParams.get("all") === "1";

    const offers = await DiscountOffer.find(includeAll ? {} : { status: "active" })
      .populate("departmentIds", "name")
      .populate("categoryIds", "name")
      .populate("productIds", "name sku")
      .sort({ startDate: -1, createdAt: -1 })
      .lean() as unknown as Array<Record<string, unknown>>;

    return NextResponse.json({ offers: offers.map(toRow), total: offers.length });
  } catch (error) {
    console.error("GET /api/discounts error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.discounts.manage))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const body = await req.json();
    // Older clients / direct API callers send edits as POST with an id.
    if (body && typeof body === "object" && body.id) {
      return updateOffer(body, user);
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(badRequest("Validation failed", fieldErrors(parsed.error)), { status: 400 });
    }

    const data = parsed.data;
    const selectionError = validateSelection(data);
    if (selectionError) {
      return NextResponse.json(badRequest("Validation failed", { targets: selectionError }), { status: 400 });
    }

    const startDate = parseOfferDate(data.startDate, false);
    const endDate = parseOfferDate(data.endDate, true);
    if (!startDate || !endDate) {
      return NextResponse.json(badRequest("Validation failed", { startDate: "Invalid date range" }), { status: 400 });
    }
    if (endDate < startDate) {
      return NextResponse.json(
        badRequest("Validation failed", { endDate: "End date cannot be before the start date" }),
        { status: 400 }
      );
    }

    const targetError = await validateTargets(data);
    if (targetError) return NextResponse.json(badRequest(targetError), { status: 400 });

    const offer = await DiscountOffer.create({
      name: data.name.trim(),
      percentage: data.percentage,
      startDate,
      endDate,
      departmentIds: uniqueIds(data.departmentIds),
      categoryIds: uniqueIds(data.categoryIds),
      productIds: uniqueIds(data.productIds),
      status: data.status,
      note: data.note.trim(),
      createdBy: user.id,
    });

    return NextResponse.json(success({ offer }, "Discount offer created"), { status: 201 });
  } catch (error) {
    console.error("POST /api/discounts error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    return updateOffer(await req.json(), user);
  } catch (error) {
    console.error("PUT /api/discounts error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

async function updateOffer(body: Record<string, unknown>, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (!(await hasPermission(user, PERMISSIONS.discounts.manage))) {
    return NextResponse.json(forbidden(), { status: 403 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(badRequest("Validation failed", fieldErrors(parsed.error)), { status: 400 });
  }

  const data = parsed.data;
  const offer = await DiscountOffer.findById(data.id);
  if (!offer) return NextResponse.json(notFound("Discount offer not found"), { status: 404 });

  const selectionError = validateSelection(data);
  if (selectionError) {
    return NextResponse.json(badRequest("Validation failed", { targets: selectionError }), { status: 400 });
  }

  const startDate = parseOfferDate(data.startDate, false);
  const endDate = parseOfferDate(data.endDate, true);
  if (!startDate || !endDate) {
    return NextResponse.json(badRequest("Validation failed", { startDate: "Invalid date range" }), { status: 400 });
  }
  if (endDate < startDate) {
    return NextResponse.json(
      badRequest("Validation failed", { endDate: "End date cannot be before the start date" }),
      { status: 400 }
    );
  }

  const targetError = await validateTargets(data);
  if (targetError) return NextResponse.json(badRequest(targetError), { status: 400 });

  offer.name = data.name.trim();
  offer.percentage = data.percentage;
  offer.startDate = startDate;
  offer.endDate = endDate;
  offer.departmentIds = uniqueIds(data.departmentIds) as unknown as typeof offer.departmentIds;
  offer.categoryIds = uniqueIds(data.categoryIds) as unknown as typeof offer.categoryIds;
  offer.productIds = uniqueIds(data.productIds) as unknown as typeof offer.productIds;
  offer.status = data.status;
  offer.note = data.note.trim();
  await offer.save();

  return NextResponse.json(success({ offer }, "Discount offer updated"));
}

export async function PATCH(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.discounts.manage))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const parsed = statusSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(badRequest("Validation failed", fieldErrors(parsed.error)), { status: 400 });
    }

    const offer = await DiscountOffer.findById(parsed.data.id);
    if (!offer) return NextResponse.json(notFound("Discount offer not found"), { status: 404 });

    offer.status = parsed.data.status;
    await offer.save();

    return NextResponse.json(
      success({ id: offer._id.toString() }, parsed.data.status === "active" ? "Offer activated" : "Offer deactivated")
    );
  } catch (error) {
    console.error("PATCH /api/discounts error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.discounts.manage))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const body = (await req.json()) as { id?: string };
    if (!body.id || !mongoose.Types.ObjectId.isValid(body.id)) {
      return NextResponse.json(badRequest("Offer ID is required"), { status: 400 });
    }

    const offer = await DiscountOffer.findById(body.id);
    if (!offer) return NextResponse.json(notFound("Discount offer not found"), { status: 404 });

    await DiscountOffer.deleteOne({ _id: offer._id });
    return NextResponse.json(success({ id: body.id }, "Discount offer deleted"));
  } catch (error) {
    console.error("DELETE /api/discounts error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
