import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { Supplier, Purchase, SupplierTransaction } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { z } from "zod";
import { success, badRequest, forbidden, notFound } from "@/lib/api";
import { revalidatePath } from "next/cache";
import mongoose from "mongoose";
import { recordAuditLog, requestMeta } from "@/lib/audit";
import { assertBranchAccess, BranchAccessError } from "@/lib/branch-access";
import { round2 } from "@/lib/commerce";

const createSchema = z.object({
  name: z.string().min(1, "Supplier name is required"),
  phone: z.string().default(""),
  // Email is optional — an empty string must not fail validation.
  email: z.union([z.literal(""), z.string().email("Invalid email")]).default(""),
  address: z.string().default(""),
  note: z.string().default(""),
  status: z.enum(["active", "inactive"]).default("active"),
  branchId: z.string().nullable().optional(),
});

const updateSchema = createSchema.extend({
  id: z.string().min(1, "Supplier ID is required"),
});

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.suppliers.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    // Branch-restricted users only see suppliers belonging to their branch.
    // `?all=1` (management screen) also includes inactive suppliers so they
    // can be edited/reactivated.
    // `?withBalance=1` attaches the outstanding payable derived from the
    // supplier ledger (never a stored field).
    const includeAll = new URL(req.url).searchParams.get("all") === "1";
    const withBalance = new URL(req.url).searchParams.get("withBalance") === "1";
    const query: Record<string, unknown> = {};
    if (!includeAll) query.status = "active";
    if (user.branchId) query.branchId = new mongoose.Types.ObjectId(user.branchId);

    const suppliers = await Supplier.find(query)
      .sort({ name: 1 })
      .lean();

    if (!withBalance || suppliers.length === 0) {
      return NextResponse.json(suppliers);
    }

    // Signed ledger per supplier: purchases add to what we owe, payments subtract.
    // Branch-restricted users only see their own branch's movements.
    const match: Record<string, unknown> = {
      supplierId: { $in: suppliers.map((s) => s._id) },
    };
    if (user.branchId) match.branchId = new mongoose.Types.ObjectId(user.branchId);

    const balances = await SupplierTransaction.aggregate<{
      _id: mongoose.Types.ObjectId;
      balance: number;
    }>([{ $match: match }, { $group: { _id: "$supplierId", balance: { $sum: "$amount" } } }]);
    const balanceMap = new Map(balances.map((b) => [b._id.toString(), round2(b.balance)]));

    return NextResponse.json(
      suppliers.map((s) => ({ ...s, balance: balanceMap.get(s._id.toString()) ?? 0 }))
    );
  } catch (error) {
    console.error("GET /api/suppliers error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();

    const body = await req.json();

    // Same update contract as PUT: a payload carrying an `id` edits that row
    // instead of creating a duplicate supplier with the same name.
    if (body && typeof body === "object" && body.id) {
      return updateSupplier(body, req, user);
    }

    if (!(await hasPermission(user, PERMISSIONS.suppliers.create))) {
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

    // Do not create a new supplier if one with the same name already exists
    const branchFilter = data.branchId ? { branchId: new mongoose.Types.ObjectId(data.branchId) } : {};
    const existing = await Supplier.findOne({ name: data.name.trim(), ...branchFilter });
    if (existing) {
      return NextResponse.json(badRequest("A supplier with this name already exists"), { status: 400 });
    }

    const targetBranchId = (data.branchId || user.branchId) ?? null;
    const supplier = await Supplier.create({
      name: data.name.trim(),
      phone: data.phone.trim(),
      email: data.email.trim().toLowerCase(),
      address: data.address.trim(),
      note: data.note.trim(),
      status: data.status,
      ...(targetBranchId ? { branchId: new mongoose.Types.ObjectId(targetBranchId) } : {}),
    });

    await recordAuditLog({
      user,
      action: "supplier.created",
      entityType: "supplier",
      entityId: supplier._id.toString(),
      branchId: supplier.branchId?.toString() ?? null,
      newValue: { name: data.name.trim() },
      ...requestMeta(req),
    });

    revalidatePath("/api/suppliers");
    return NextResponse.json(success({ supplier }, "Supplier created"), { status: 201 });
  } catch (error) {
    console.error("POST /api/suppliers error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    const body = await req.json();
    return updateSupplier(body, req, user);
  } catch (error) {
    if (error instanceof BranchAccessError) {
      return NextResponse.json(forbidden(error.message), { status: 403 });
    }
    console.error("PUT /api/suppliers error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

/** Shared by PUT and POST-with-id so both paths update the same record. */
async function updateSupplier(
  body: Record<string, unknown>,
  req: NextRequest,
  user: Awaited<ReturnType<typeof requireSessionUser>>
) {
  if (!(await hasPermission(user, PERMISSIONS.suppliers.update))) {
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
    const supplier = await Supplier.findById(data.id);
    if (!supplier) {
      return NextResponse.json(notFound("Supplier not found"), { status: 404 });
    }
    assertBranchAccess(user, supplier.branchId);

    const branchFilter = supplier.branchId ? { branchId: supplier.branchId } : {};
    const existing = await Supplier.findOne({
      name: data.name.trim(),
      ...branchFilter,
      _id: { $ne: supplier._id },
    });
    if (existing) {
      return NextResponse.json(badRequest("A supplier with this name already exists"), { status: 400 });
    }

    supplier.name = data.name.trim();
    supplier.phone = data.phone.trim();
    supplier.email = data.email.trim().toLowerCase();
    supplier.address = data.address.trim();
    supplier.note = data.note.trim();
    supplier.status = data.status;
    await supplier.save();

    await recordAuditLog({
      user,
      action: "supplier.updated",
      entityType: "supplier",
      entityId: supplier._id.toString(),
      branchId: supplier.branchId?.toString() ?? null,
      newValue: { name: supplier.name, status: supplier.status },
      ...requestMeta(req),
    });

    revalidatePath("/api/suppliers");
    return NextResponse.json(success({ supplier }, "Supplier updated"));
  } catch (error) {
    if (error instanceof BranchAccessError) {
      return NextResponse.json(forbidden(error.message), { status: 403 });
    }
    console.error("updateSupplier error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.suppliers.delete))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const body = await req.json();
    const { id } = body as { id?: string };
    if (!id) {
      return NextResponse.json(badRequest("Supplier ID is required"), { status: 400 });
    }

    const supplier = await Supplier.findById(id);
    if (!supplier) {
      return NextResponse.json(notFound("Supplier not found"), { status: 404 });
    }
    assertBranchAccess(user, supplier.branchId);

    // Suppliers with financial history are deactivated, never hard-deleted.
    const hasTransactions = await SupplierTransaction.exists({ supplierId: supplier._id });
    const hasPurchases = await Purchase.exists({ supplierId: supplier._id });
    if (hasTransactions || hasPurchases) {
      supplier.status = "inactive";
      await supplier.save();
      await recordAuditLog({
        user,
        action: "supplier.deactivated",
        entityType: "supplier",
        entityId: supplier._id.toString(),
        branchId: supplier.branchId?.toString() ?? null,
        note: "Supplier deactivated (financial history preserved)",
        ...requestMeta(req),
      });
      revalidatePath("/api/suppliers");
      return NextResponse.json(
        success(null, "Supplier has purchase/payment history — deactivated instead of deleted")
      );
    }

    await Supplier.deleteOne({ _id: supplier._id });
    await recordAuditLog({
      user,
      action: "supplier.deleted",
      entityType: "supplier",
      entityId: supplier._id.toString(),
      branchId: supplier.branchId?.toString() ?? null,
      note: "Supplier deleted",
      ...requestMeta(req),
    });
    revalidatePath("/api/suppliers");
    return NextResponse.json(success(null, "Supplier deleted"));
  } catch (error) {
    if (error instanceof BranchAccessError) {
      return NextResponse.json(forbidden(error.message), { status: 403 });
    }
    console.error("DELETE /api/suppliers error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
