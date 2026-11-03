import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { SyncNode } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { badRequest, forbidden, notFound, success } from "@/lib/api";
import { recordAuditLog, requestMeta } from "@/lib/audit";
import { issueNodeKey } from "@/lib/sync/node-auth";

/**
 * Shop-node registry (center side).
 *
 * GET  /api/sync/nodes  → registered nodes with liveness
 * POST /api/sync/nodes  → register a node and/or issue its secret
 *
 * The secret is returned exactly once, in the response that creates it (or
 * rotates it). Only its HMAC is stored, so a lost key must be rotated — it can
 * never be read back.
 */

const registerSchema = z.object({
  nodeId: z.string().min(3).max(64),
  name: z.string().max(120).default(""),
  branchId: z
    .string()
    .refine((v) => v === "" || mongoose.Types.ObjectId.isValid(v), "Invalid branch id")
    .nullish(),
  rotate: z.boolean().default(false),
  action: z.literal("register").default("register"),
});

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("register"), data: registerSchema }),
  z.object({
    action: z.enum(["activate", "deactivate"]),
    nodeId: z.string().min(3).max(64),
  }),
]);

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.settings.manage))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const nodes = await SyncNode.find({}).sort({ createdAt: -1 }).lean();
    return NextResponse.json(
      nodes.map((node) => ({
        _id: String(node._id),
        nodeId: node.nodeId,
        name: node.name,
        status: node.status,
        branchId: node.branchId ? String(node.branchId) : null,
        lastSeenAt: node.lastSeenAt ?? null,
        lastPushAt: node.lastPushAt ?? null,
        lastPullAt: node.lastPullAt ?? null,
        pushedRows: node.pushedRows ?? 0,
        createdAt: node.createdAt,
      }))
    );
  } catch (error) {
    console.error("GET /api/sync/nodes error:", error);
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

    const body = await req.json().catch(() => null);
    // A bare register payload is accepted too (the action field is optional).
    const normalised =
      body && typeof body === "object" && !("action" in body)
        ? { action: "register", data: body }
        : body;

    const parsed = actionSchema.safeParse(normalised);
    if (!parsed.success) {
      return NextResponse.json(badRequest("Validation failed"), { status: 400 });
    }

    if (parsed.data.action !== "register") {
      const node = await SyncNode.findOne({ nodeId: parsed.data.nodeId });
      if (!node) return NextResponse.json(notFound("Node not found"), { status: 404 });
      node.status = parsed.data.action === "activate" ? "active" : "inactive";
      await node.save();
      await recordAuditLog({
        user,
        action: `sync.node_${parsed.data.action}`,
        entityType: "SyncNode",
        entityId: node._id.toString(),
        branchId: node.branchId?.toString() ?? null,
        note: `Node ${node.nodeId}`,
        ...meta,
      });
      return NextResponse.json(success({ nodeId: node.nodeId, status: node.status }));
    }

    const { nodeId, name, branchId, rotate } = parsed.data.data;
    const existing = await SyncNode.findOne({ nodeId });

    if (existing && !rotate) {
      if (name || branchId) {
        existing.name = name || existing.name;
        if (branchId !== undefined) {
          existing.branchId = branchId ? new mongoose.Types.ObjectId(branchId) : null;
        }
        await existing.save();
      }
      return NextResponse.json(
        success({ nodeId, rotated: false }, "Node already registered — pass rotate: true to issue a new key")
      );
    }

    const { key, keyHash } = issueNodeKey();
    let stored = existing;
    if (existing) {
      existing.keyHash = keyHash;
      existing.name = name || existing.name;
      if (branchId !== undefined) {
        existing.branchId = branchId ? new mongoose.Types.ObjectId(branchId) : null;
      }
      existing.status = "active";
      await existing.save();
    } else {
      const [created] = await SyncNode.create([
        {
          nodeId,
          name,
          keyHash,
          branchId: branchId ? new mongoose.Types.ObjectId(branchId) : null,
          status: "active",
        },
      ]);
      stored = created;
    }

    await recordAuditLog({
      user,
      action: existing ? "sync.node_key_rotated" : "sync.node_registered",
      entityType: "SyncNode",
      // Audit rows reference a document id; the human node id ("shop-1") is not
      // an ObjectId and would make the whole audit write fail.
      entityId: stored?._id?.toString() ?? null,
      branchId: branchId ?? null,
      note: `Node ${nodeId}`,
      ...meta,
    });

    return NextResponse.json(
      success(
        { nodeId, key, rotated: Boolean(existing) },
        "Copy this key into SYNC_NODE_KEY on the shop PC — it is not shown again"
      ),
      { status: existing ? 200 : 201 }
    );
  } catch (error) {
    console.error("POST /api/sync/nodes error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
