import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { z } from "zod";
import { connectDB } from "@/lib/mongodb";
import { InventoryMovement, Warehouse } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasAnyPermission, hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { success, badRequest, forbidden, notFound } from "@/lib/api";
import { recordAuditLog, requestMeta } from "@/lib/audit";
import { STOCK_IN_TYPES } from "@/lib/expiry";

/**
 * Warehouses API — standalone stock locations, NOT branches.
 *
 * GET  /api/warehouses              → every warehouse with its current units/value
 * POST /api/warehouses {action}     → create | update | deactivate
 *
 * Warehouses never sell and have no register, staff assignment or department.
 * Their stock only changes through purchases (HQ) and stock transfers.
 */

const objectIdField = z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid id");

const createSchema = z.object({
  action: z.literal("create"),
  name: z.string().trim().min(2, "Warehouse name is required").max(120),
  code: z
    .string()
    .trim()
    .max(20)
    .regex(/^[A-Za-z0-9_-]*$/, "Letters, numbers, - and _ only")
    .optional()
    .default(""),
  address: z.string().trim().max(300).optional().default(""),
  phone: z.string().trim().max(50).optional().default(""),
  note: z.string().trim().max(300).optional().default(""),
  status: z.enum(["active", "inactive"]).optional().default("active"),
});

const updateSchema = createSchema.omit({ action: true }).partial().extend({
  action: z.literal("update"),
  id: objectIdField,
});

const deactivateSchema = z.object({
  action: z.literal("deactivate"),
  id: objectIdField,
});

const bodySchema = z.discriminatedUnion("action", [createSchema, updateSchema, deactivateSchema]);

function fieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  err.errors.forEach((e) => {
    const path = e.path[0];
    if (typeof path === "string") out[path] = e.message;
  });
  return out;
}

function toRow(doc: Record<string, unknown>, stats?: { items: number; units: number; value: number }) {
  return {
    _id: String(doc._id),
    name: doc.name,
    code: doc.code ?? "",
    address: doc.address ?? "",
    phone: doc.phone ?? "",
    status: doc.status,
    note: doc.note ?? "",
    itemCount: stats?.items ?? 0,
    units: stats?.units ?? 0,
    stockValue: stats?.value ?? 0,
    createdAt: doc.createdAt,
  };
}

export async function GET() {
  try {
    await connectDB();
    const user = await requireSessionUser();
    const canRead =
      (await hasPermission(user, PERMISSIONS.inventory.view)) ||
      (await hasPermission(user, PERMISSIONS.transfers.view)) ||
      (await hasPermission(user, PERMISSIONS.settings.manage));
    if (!canRead) return NextResponse.json(forbidden(), { status: 403 });

    const warehouses = await Warehouse.find({}).sort({ name: 1 }).lean();
    const stats = await InventoryMovement.aggregate<{
      _id: mongoose.Types.ObjectId;
      items: number;
      units: number;
      value: number;
    }>([
      { $match: { warehouseId: { $ne: null } } },
      {
        $group: {
          _id: { warehouse: "$warehouseId", product: "$productId" },
          quantity: {
            $sum: {
              $cond: [
                { $in: ["$movementType", [...STOCK_IN_TYPES]] },
                "$quantity",
                { $multiply: ["$quantity", -1] },
              ],
            },
          },
          cost: { $last: "$unitCost" },
        },
      },
      { $match: { quantity: { $gt: 0 } } },
      {
        $group: {
          _id: "$_id.warehouse",
          items: { $sum: 1 },
          units: { $sum: "$quantity" },
          value: { $sum: { $multiply: ["$quantity", "$cost"] } },
        },
      },
    ]);
    const statsMap = new Map(
      stats.map((row) => [String(row._id), { items: row.items, units: row.units, value: row.value }])
    );

    return NextResponse.json({
      warehouses: warehouses.map((w) =>
        toRow(w as unknown as Record<string, unknown>, statsMap.get(String(w._id)))
      ),
      canManage: await hasPermission(user, PERMISSIONS.settings.manage),
    });
  } catch (error) {
    console.error("GET /api/warehouses error:", error);
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

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(badRequest("Validation failed", fieldErrors(parsed.error)), { status: 400 });
    }
    const data = parsed.data;
    const meta = requestMeta(req);

    if (data.action === "create") {
      const name = data.name.trim();
      const clash = await Warehouse.findOne({ name });
      if (clash) {
        return NextResponse.json(badRequest("A warehouse with this name already exists"), { status: 400 });
      }
      const code = (data.code ?? "").trim().toUpperCase();
      if (code && (await Warehouse.findOne({ code }))) {
        return NextResponse.json(badRequest("A warehouse with this code already exists"), { status: 400 });
      }

      const warehouse = await Warehouse.create({
        name,
        code,
        address: data.address ?? "",
        phone: data.phone ?? "",
        note: data.note ?? "",
        status: data.status ?? "active",
        createdBy: user.id,
      });

      await recordAuditLog({
        user,
        action: "warehouse.create",
        entityType: "Warehouse",
        entityId: warehouse._id.toString(),
        newValue: { name: warehouse.name, code: warehouse.code },
        ...meta,
      });

      return NextResponse.json(
        success({ warehouse: toRow(warehouse.toObject() as unknown as Record<string, unknown>) }, "Warehouse created"),
        { status: 201 }
      );
    }

    const warehouse = await Warehouse.findById(data.id);
    if (!warehouse) return NextResponse.json(notFound("Warehouse not found"), { status: 404 });

    if (data.action === "deactivate") {
      warehouse.status = "inactive";
      await warehouse.save();
      await recordAuditLog({
        user,
        action: "warehouse.deactivate",
        entityType: "Warehouse",
        entityId: warehouse._id.toString(),
        oldValue: { status: "active" },
        newValue: { status: "inactive" },
        ...meta,
      });
      return NextResponse.json(
        success({ warehouse: { _id: String(warehouse._id), status: warehouse.status } }, "Warehouse deactivated")
      );
    }

    if (data.name !== undefined) {
      const name = data.name.trim();
      const clash = await Warehouse.findOne({ name, _id: { $ne: warehouse._id } });
      if (clash) {
        return NextResponse.json(badRequest("A warehouse with this name already exists"), { status: 400 });
      }
      warehouse.name = name;
    }
    if (data.code !== undefined) {
      const code = data.code.trim().toUpperCase();
      if (code) {
        const clash = await Warehouse.findOne({ code, _id: { $ne: warehouse._id } });
        if (clash) {
          return NextResponse.json(badRequest("A warehouse with this code already exists"), { status: 400 });
        }
      }
      warehouse.code = code;
    }
    if (data.address !== undefined) warehouse.address = data.address;
    if (data.phone !== undefined) warehouse.phone = data.phone;
    if (data.note !== undefined) warehouse.note = data.note;
    if (data.status !== undefined) warehouse.status = data.status;
    await warehouse.save();

    await recordAuditLog({
      user,
      action: "warehouse.update",
      entityType: "Warehouse",
      entityId: warehouse._id.toString(),
      newValue: { name: warehouse.name, code: warehouse.code, status: warehouse.status },
      ...meta,
    });

    return NextResponse.json(
      success({ warehouse: toRow(warehouse.toObject() as unknown as Record<string, unknown>) }, "Warehouse updated")
    );
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
      return NextResponse.json(badRequest("That warehouse name or code is already used"), { status: 400 });
    }
    console.error("POST /api/warehouses error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
