import { NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { forbidden } from "@/lib/api";
import { getSyncStatus } from "@/lib/sync/worker";

/**
 * GET /api/sync/status — everything the Sync Center and the header indicator
 * need: node configuration, pending/conflicted counts, the last run, local
 * database capabilities and whether the center is currently reachable.
 *
 * The browser never talks to the sync collections directly; this endpoint is
 * the single read model for sync state.
 */
export async function GET() {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.sales.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const status = await getSyncStatus();
    return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("GET /api/sync/status error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
