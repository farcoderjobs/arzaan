import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { Category, Product } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { z } from "zod";
import { success, badRequest, forbidden, notFound } from "@/lib/api";
import { revalidatePath } from "next/cache";

const createSchema = z.object({
  name: z.string().min(1, "Category name is required"),
  description: z.string().default(""),
  parentId: z.string().optional().nullable(),
  status: z.enum(["active", "inactive"]).default("active"),
});

const updateSchema = createSchema.extend({
  id: z.string().min(1, "Category ID is required"),
});

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.categories.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    // The management screen needs inactive categories too (to edit/reactivate);
    // product filters keep the default active-only list.
    const includeAll = searchParams.get("all") === "1";

    const query = includeAll ? {} : { status: "active" as const };
    const categories = await Category.find(query)
      .populate<{ parentId: { name: string } }>("parentId", "name")
      .sort({ name: 1 })
      .lean() as Array<Record<string, unknown>>;
    return NextResponse.json(categories);
  } catch (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();

    const body = await req.json();

    // Same update contract as PUT: a payload carrying an `id` edits that row.
    // Without this, edit requests that arrive as POST (older clients, direct
    // API calls) silently created a second category with the same name.
    if (body && typeof body === "object" && body.id) {
      return updateCategory(body, user);
    }

    if (!(await hasPermission(user, PERMISSIONS.categories.create))) {
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
    if (data.parentId) {
      const parent = await Category.findById(data.parentId);
      if (!parent) {
        return NextResponse.json(badRequest("Parent category not found"), { status: 400 });
      }
    }

    const existing = await Category.findOne({ name: data.name.trim(), parentId: data.parentId || null });
    if (existing) {
      return NextResponse.json(badRequest("A category with this name already exists"), { status: 400 });
    }

    const category = await Category.create({
      name: data.name.trim(),
      description: data.description.trim(),
      parentId: data.parentId || null,
      status: data.status,
    });

    revalidatePath("/api/categories");
    return NextResponse.json(success({ category }, "Category created"), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    const body = await req.json();
    return updateCategory(body, user);
  } catch (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

/** Shared by PUT and POST-with-id so both paths update the same record. */
async function updateCategory(body: Record<string, unknown>, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (!(await hasPermission(user, PERMISSIONS.categories.update))) {
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
    const category = await Category.findById(data.id);
    if (!category) {
      return NextResponse.json(notFound("Category not found"), { status: 404 });
    }

    if (data.parentId) {
      if (data.parentId === data.id) {
        return NextResponse.json(badRequest("A category cannot be its own parent"), { status: 400 });
      }
      const parent = await Category.findById(data.parentId);
      if (!parent) {
        return NextResponse.json(badRequest("Parent category not found"), { status: 400 });
      }
    }

    const existing = await Category.findOne({
      name: data.name.trim(),
      parentId: data.parentId || null,
      _id: { $ne: category._id },
    });
    if (existing) {
      return NextResponse.json(badRequest("A category with this name already exists"), { status: 400 });
    }

    category.name = data.name.trim();
    category.description = data.description.trim();
    category.parentId = (data.parentId || null) as unknown as typeof category.parentId;
    category.status = data.status;
    await category.save();

    revalidatePath("/api/categories");
    return NextResponse.json(success({ category }, "Category updated"));
  } catch (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.categories.delete))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const body = await req.json();
    const { id } = body as { id?: string };
    if (!id) {
      return NextResponse.json(badRequest("Category ID is required"), { status: 400 });
    }

    const category = await Category.findById(id);
    if (!category) {
      return NextResponse.json(notFound("Category not found"), { status: 404 });
    }

    const hasChildren = await Category.exists({ parentId: category._id });
    if (hasChildren) {
      return NextResponse.json(
        badRequest("This category has subcategories — remove or reassign them first"),
        { status: 400 }
      );
    }

    // Never hard-delete a category that products still reference — deactivate.
    const hasProducts = await Product.exists({ categoryId: category._id });
    if (hasProducts) {
      category.status = "inactive";
      await category.save();
      revalidatePath("/api/categories");
      return NextResponse.json(
        success({ category }, "Category has products — deactivated instead of deleted")
      );
    }

    await Category.deleteOne({ _id: category._id });
    revalidatePath("/api/categories");
    return NextResponse.json(success(null, "Category deleted"));
  } catch (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
