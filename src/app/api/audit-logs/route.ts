import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { AuditLog, User, Branch } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { forbidden } from "@/lib/api";
import { parseReportRange, parsePage, escapeRegex, csvResponse } from "@/lib/reports";

/**
 * Audit Logs API — READ ONLY.
 * There is deliberately no POST/PUT/DELETE: audit rows are append-only and
 * cannot be modified by normal users (or any user) through the application.
 * Writes only happen inside recordAuditLog() from server business flows.
 */
export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.auditLogs.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const range = parseReportRange(searchParams);
    const { page, perPage, skip } = parsePage(searchParams);
    const action = searchParams.get("action")?.trim() ?? "";
    const entityType = searchParams.get("entityType")?.trim() ?? "";
    const userId = searchParams.get("userId")?.trim() ?? "";
    const search = searchParams.get("search")?.trim() ?? "";

    const query: Record<string, unknown> = {
      createdAt: { $gte: range.from, $lte: range.to },
    };
    if (action) query.action = new RegExp(`^${escapeRegex(action)}`, "i");
    if (entityType) query.entityType = entityType;
    if (userId && mongoose.Types.ObjectId.isValid(userId)) query.userId = new mongoose.Types.ObjectId(userId);
    if (user.branchId) query.branchId = new mongoose.Types.ObjectId(user.branchId);
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      query.$or = [{ action: rx }, { entityType: rx }, { note: rx }];
    }

    const [total, logs, distinctActions] = await Promise.all([
      AuditLog.countDocuments(query),
      AuditLog.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(perPage)
        .populate<{ userId: { _id: mongoose.Types.ObjectId; name: string; email: string } | null }>("userId", "name email")
        .populate<{ branchId: { _id: mongoose.Types.ObjectId; name: string } | null }>("branchId", "name")
        .lean(),
      AuditLog.distinct("action"),
    ]);

    if (searchParams.get("format") === "csv") {
      const rows: Array<Array<string | number>> = [["Timestamp", "User", "Action", "Entity", "Entity ID", "Branch", "Details"]];
      for (const log of logs) {
        rows.push([
          log.createdAt.toISOString(),
          (log.userId as unknown as { name: string } | null)?.name ?? "system",
          log.action,
          log.entityType,
          log.entityId ? log.entityId.toString() : "",
          (log.branchId as unknown as { name: string } | null)?.name ?? "",
          log.note ?? "",
        ]);
      }
      return csvResponse(`audit-logs-${new Date().toISOString().slice(0, 10)}.csv`, rows);
    }

    return NextResponse.json({
      logs: logs.map((log) => ({
        _id: log._id.toString(),
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId ? log.entityId.toString() : null,
        userId: log.userId ? (log.userId as unknown as { _id: mongoose.Types.ObjectId })._id.toString() : null,
        userName: (log.userId as unknown as { name: string } | null)?.name ?? "system",
        userEmail: (log.userId as unknown as { email: string } | null)?.email ?? "",
        branchName: (log.branchId as unknown as { name: string } | null)?.name ?? null,
        // `.lean()` returns the Map field as a plain object, but hydrated
        // documents expose an ES6 Map — normalize both to a plain object.
        changes: log.changes
          ? log.changes instanceof Map
            ? Object.fromEntries(log.changes as unknown as Map<string, unknown>)
            : (log.changes as unknown as Record<string, unknown>)
          : {},
        note: log.note,
        ip: log.ip,
        createdAt: log.createdAt,
      })),
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
      actions: distinctActions.sort(),
    });
  } catch (error) {
    console.error("GET /api/audit-logs error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
