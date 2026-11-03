import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { success, unauthorized } from "@/lib/api";
import { authenticateNode, touchNode } from "@/lib/sync/node-auth";
import { collectDeltas, parseCursors } from "@/lib/sync/deltas";

/**
 * POST /api/sync/pull — reference-data deltas for one shop node.
 *
 * Reference data only (catalogue, customers, suppliers, users, roles,
 * settings); transactional history travels one way, node → center. Cursors are
 * supplied by the node per collection, so an interrupted pull resumes where it
 * stopped instead of re-sending everything.
 */
export async function POST(req: NextRequest) {
  try {
    await connectDB();

    const node = await authenticateNode(req.headers);
    if (!node) {
      return NextResponse.json(
        unauthorized("Invalid or inactive sync node credentials"),
        { status: 401 }
      );
    }

    const body = (await req.json().catch(() => null)) as
      | { cursors?: unknown; limit?: number }
      | null;

    const batch = await collectDeltas(node, parseCursors(body?.cursors), body?.limit);
    await touchNode(node.nodeId, { lastPullAt: new Date() });

    return NextResponse.json(success(batch));
  } catch (error) {
    console.error("POST /api/sync/pull error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
