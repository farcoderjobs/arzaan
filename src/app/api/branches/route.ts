import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Branch, User, Product } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { success, badRequest, forbidden, notFound } from "@/lib/api";
import { recordAuditLog, requestMeta, diffForAudit } from "@/lib/audit";

/**
 * Branch management API.
 * GET    /api/branches → list (all roles may read the list for context)
 * POST   /api/branches → create | update (settings.manage)
 * DELETE /api/branches → soft-deactivate when no active users/products reference it
 */

const createSchema = z.object({
  name: z.string().min(2, "Branch name is required").max(120),
  code: z.string().min(2, "Code is required").max(20).regex(/^[A-Za-z0-9_-]+$/, "Letters, numbers, - and _ only"),
  address: z.string().max(300).default(""),
  phone: z.string().max(50).default(""),
  currency: z.string().length(3, "Currency is a 3-letter code").default("AFN"),
  taxRate: z.number().min(0).max(100).default(0),
  status: z.enum(["active", "inactive"]).default("active"),
});

const updateSchema = createSchema.partial().extend({
  action: z.literal("update"),
  id: z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid branch id"),
});

function fieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  err.errors.forEach((e) => {
    const path = e.path[0];
    if (typeof path === "string") out[path] = e.message;
  });
  return out;
}

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();

    const { searchParams } = new URL(req.url);
    const withCounts = searchParams.get("withCounts") === "1";

    // Branch-restricted users may only see their own branch.
    const query: Record<string, unknown> = {};
    if (user.branchId) query._id = new mongoose.Types.ObjectId(user.branchId);

    const branches = await Branch.find(query).sort({ name: 1 }).lean();

    const counts = withCounts
      ? await User.aggregate<{ _id: mongoose.Types.ObjectId; users: number }>([{ $group: { _id: "$branchId", users: { $sum: 1 } } }])
      : [];
    const countMap = new Map(counts.map((c) => [c._id?.toString() ?? "null", c.users]));

    return NextResponse.json({
      branches: branches.map((b) => ({
        _id: b._id.toString(),
        name: b.name,
        code: b.code,
        address: b.address,
        phone: b.phone,
        currency: b.currency,
        taxRate: b.taxRate,
        status: b.status,
        userCount: countMap.get(b._id.toString()) ?? 0,
        createdAt: b.createdAt,
      })),
    });
  } catch (error) {
    console.error("GET /api/branches error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.settings.manage))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }
    const meta = requestMeta(req);
    const body = await req.json();

    // ---------- Create ----------
    if (body && typeof body === "object" && !("action" in body)) {
      const parsed = createSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(badRequest("Validation failed", fieldErrors(parsed.error)), { status: 400 });
      }
      const data = parsed.data;

      const existing = await Branch.findOne({ code: data.code.toUpperCase() });
      if (existing) return NextResponse.json(badRequest("A branch with this code already exists"), { status: 400 });

      const branch = await Branch.create({
        name: data.name.trim(),
        code: data.code.toUpperCase().trim(),
        address: data.address.trim(),
        phone: data.phone.trim(),
        currency: data.currency.toUpperCase(),
        taxRate: data.taxRate,
        status: data.status,
      });

      await recordAuditLog({
        user,
        action: "branch.create",
        entityType: "Branch",
        entityId: branch._id.toString(),
        newValue: { name: branch.name, code: branch.code },
        ...meta,
      });

      return NextResponse.json(success({ id: branch._id.toString() }, "Branch created"), { status: 201 });
    }

    // ---------- Update ----------
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(badRequest("Validation failed", fieldErrors(parsed.error)), { status: 400 });
    }
    const { action: _action, id, ...changes } = parsed.data;

    const branch = await Branch.findById(id);
    if (!branch) return NextResponse.json(notFound("Branch not found"), { status: 404 });

    const before = {
      name: branch.name,
      code: branch.code,
      address: branch.address,
      phone: branch.phone,
      currency: branch.currency,
      taxRate: branch.taxRate,
      status: branch.status,
    };

    if (changes.code !== undefined) {
      const normalized = changes.code.toUpperCase().trim();
      if (normalized !== branch.code) {
        const dupe = await Branch.findOne({ code: normalized, _id: { $ne: branch._id } });
        if (dupe) return NextResponse.json(badRequest("A branch with this code already exists"), { status: 400 });
        branch.code = normalized;
      }
    }
    if (changes.name !== undefined) branch.name = changes.name.trim();
    if (changes.address !== undefined) branch.address = changes.address.trim();
    if (changes.phone !== undefined) branch.phone = changes.phone.trim();
    if (changes.currency !== undefined) branch.currency = changes.currency.toUpperCase();
    if (changes.taxRate !== undefined) branch.taxRate = changes.taxRate;
    if (changes.status !== undefined) {
      if (changes.status === "inactive") {
        const activeUsers = await User.countDocuments({ branchId: branch._id, status: "active" });
        if (activeUsers > 0) {
          return NextResponse.json(badRequest(`Cannot deactivate: ${activeUsers} active user(s) are assigned to this branch`), { status: 400 });
        }
        const activeProducts = await Product.countDocuments({ branchId: branch._id, status: "active" });
        if (activeProducts > 0) {
          return NextResponse.json(badRequest(`Cannot deactivate: ${activeProducts} active product(s) belong to this branch`), { status: 400 });
        }
      }
      branch.status = changes.status;
    }

    await branch.save();

    await recordAuditLog({
      user,
      action: "branch.update",
      entityType: "Branch",
      entityId: branch._id.toString(),
      changes: diffForAudit(before, {
        name: branch.name,
        code: branch.code,
        address: branch.address,
        phone: branch.phone,
        currency: branch.currency,
        taxRate: branch.taxRate,
        status: branch.status,
      }),
      ...meta,
    });

    return NextResponse.json(success({ id: branch._id.toString() }, "Branch updated"));
  } catch (error) {
    console.error("POST /api/branches error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
