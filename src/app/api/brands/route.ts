import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { Brand, Product } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { z } from "zod";
import { success, badRequest, forbidden, notFound } from "@/lib/api";
import { revalidatePath } from "next/cache";

const createSchema = z.object({
  name: z.string().min(1, "Brand name is required"),
  description: z.string().default(""),
  status: z.enum(["active", "inactive"]).default("active"),
});

const updateSchema = createSchema.extend({
  id: z.string().min(1, "Brand ID is required"),
});

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.brands.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    // The management screen needs inactive brands too (to edit/reactivate);
    // product filters keep the default active-only list.
    const includeAll = new URL(req.url).searchParams.get("all") === "1";
    const query = includeAll ? {} : { status: "active" as const };
    const brands = await Brand.find(query)
      .sort({ name: 1 })
      .lean();

    return NextResponse.json(brands);
  } catch (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();

    const body = await req.json();

    // Same update contract as PUT: a payload carrying an `id` edits that row
    // instead of creating a second brand with the same name.
    if (body && typeof body === "object" && body.id) {
      return updateBrand(body, user);
    }

    if (!(await hasPermission(user, PERMISSIONS.brands.create))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      parsed.error.errors.forEach((err) => {
        const path = err.path[0];
        if (typeof path === "string") fieldErrors[path] = err.message;
      });
      return NextResponse.json(badRequest("Validation failed", fieldErrors), { status: 400 });
    }

    const data = parsed.data;
    const existing = await Brand.findOne({ name: data.name.trim() });
    if (existing) {
      return NextResponse.json(badRequest("A brand with this name already exists"), { status: 400 });
    }

    const brand = await Brand.create({
      name: data.name.trim(),
      description: data.description.trim(),
      status: data.status,
    });

    revalidatePath("/api/brands");
    return NextResponse.json(success({ brand }, "Brand created"), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    const body = await req.json();
    return updateBrand(body, user);
  } catch (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

/** Shared by PUT and POST-with-id so both paths update the same record. */
async function updateBrand(body: Record<string, unknown>, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (!(await hasPermission(user, PERMISSIONS.brands.update))) {
    return NextResponse.json(forbidden(), { status: 403 });
  }

  try {
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      parsed.error.errors.forEach((err) => {
        const path = err.path[0];
        if (typeof path === "string") fieldErrors[path] = err.message;
      });
      return NextResponse.json(badRequest("Validation failed", fieldErrors), { status: 400 });
    }

    const data = parsed.data;
    const brand = await Brand.findById(data.id);
    if (!brand) {
      return NextResponse.json(notFound("Brand not found"), { status: 404 });
    }

    const existing = await Brand.findOne({ name: data.name.trim(), _id: { $ne: brand._id } });
    if (existing) {
      return NextResponse.json(badRequest("A brand with this name already exists"), { status: 400 });
    }

    brand.name = data.name.trim();
    brand.description = data.description.trim();
    brand.status = data.status;
    await brand.save();

    revalidatePath("/api/brands");
    return NextResponse.json(success({ brand }, "Brand updated"));
  } catch (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.brands.delete))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const body = await req.json();
    const { id } = body as { id?: string };
    if (!id) {
      return NextResponse.json(badRequest("Brand ID is required"), { status: 400 });
    }

    const brand = await Brand.findById(id);
    if (!brand) {
      return NextResponse.json(notFound("Brand not found"), { status: 404 });
    }

    // Never hard-delete a brand that products still reference — deactivate.
    const hasProducts = await Product.exists({ brandId: brand._id });
    if (hasProducts) {
      brand.status = "inactive";
      await brand.save();
      revalidatePath("/api/brands");
      return NextResponse.json(
        success({ brand }, "Brand has products — deactivated instead of deleted")
      );
    }

    await Brand.deleteOne({ _id: brand._id });
    revalidatePath("/api/brands");
    return NextResponse.json(success(null, "Brand deleted"));
  } catch (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
