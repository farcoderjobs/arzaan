import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { AuditLog, User, Sale } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { forbidden, notFound, badRequest } from "@/lib/api";
import { assertBranchAccess, BranchAccessError } from "@/lib/branch-access";

/**
 * GET /api/users/[id]/activity → recent actions + sales performed by this user.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.users.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { id } = await params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(badRequest("Invalid user id"), { status: 400 });
    }

    const target = await User.findById(id).select("name email branchId").lean();
    if (!target) return NextResponse.json(notFound("User not found"), { status: 404 });
    assertBranchAccess(user, target.branchId);

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [activity, salesCount] = await Promise.all([
      AuditLog.find({ userId: new mongoose.Types.ObjectId(id), createdAt: { $gte: since } })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
      Sale.countDocuments({ cashierId: new mongoose.Types.ObjectId(id), createdAt: { $gte: since }, status: "completed" }),
    ]);

    return NextResponse.json({
      user: { id, name: target.name, email: target.email },
      salesLast30d: salesCount,
      activity: activity.map((a) => ({
        _id: a._id.toString(),
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId ? a.entityId.toString() : null,
        note: a.note,
        createdAt: a.createdAt,
      })),
    });
  } catch (error) {
    if (error instanceof BranchAccessError) {
      return NextResponse.json(forbidden(error.message), { status: 403 });
    }
    console.error("GET /api/users/[id]/activity error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
