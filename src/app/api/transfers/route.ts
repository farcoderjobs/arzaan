import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { z } from "zod";
import { connectDB } from "@/lib/mongodb";
import { Branch, InventoryMovement, Product, StockTransfer, Warehouse } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { badRequest, forbidden, notFound, success } from "@/lib/api";
import { BranchAccessError, canAccessBranch } from "@/lib/branch-access";
import { recordAuditLog, requestMeta } from "@/lib/audit";
import { getProductBatches } from "@/lib/inventory-batches";
import { getStockForProducts } from "@/lib/sales-service";
import { getWarehouseBatches, getWarehouseStockForProducts } from "@/lib/warehouse-stock";
import { allocateQuantity } from "@/lib/expiry";

/**
 * Stock transfers between locations (warehouse ⇄ shop).
 *
 * Lifecycle: draft → dispatched → (partially_received →) received, or
 * draft → canceled. Stock leaves the source only on dispatch (TRANSFER_OUT) and
 * arrives at the destination only when received (TRANSFER_IN), so:
 *   - total stock never increases merely because goods moved,
 *   - dispatched-but-unreceived goods are visible as "in transit",
 *   - a short receipt leaves the difference in transit instead of inventing stock.
 *
 * Each movement copies the batch number, expiry and purchase source, so Import
 * vs Local origin and expiration remain traceable across locations.
 */

const transferItemSchema = z.object({
  productId: z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid product"),
  quantity: z.number().int().min(1, "Quantity must be at least 1"),
  /** Optional explicit batch; without it FEFO resolves a single batch. */
  batchNumber: z.string().trim().max(60).optional().default(""),
  expirationDate: z.string().trim().nullable().optional(),
  purchaseSource: z.enum(["import", "local"]).nullable().optional(),
});

const createSchema = z.object({
  action: z.literal("create"),
  // Each end is either a branch (shop) or a standalone warehouse — never both.
  fromBranchId: z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid source shop").optional(),
  fromWarehouseId: z
    .string()
    .refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid source warehouse")
    .optional(),
  toBranchId: z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid destination shop").optional(),
  toWarehouseId: z
    .string()
    .refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid destination warehouse")
    .optional(),
  items: z.array(transferItemSchema).min(1, "Add at least one product"),
  note: z.string().max(500).optional().default(""),
});

const dispatchSchema = z.object({
  action: z.literal("dispatch"),
  id: z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid transfer"),
});

const receiveSchema = z.object({
  action: z.literal("receive"),
  id: z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid transfer"),
  /** Per-line received quantities (index matches the transfer line). Omit to receive everything remaining. */
  received: z
    .array(
      z.object({
        index: z.number().int().min(0),
        quantity: z.number().int().min(0),
      })
    )
    .optional(),
  discrepancyNote: z.string().max(500).optional().default(""),
});

const cancelSchema = z.object({
  action: z.literal("cancel"),
  id: z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid transfer"),
});

const bodySchema = z.discriminatedUnion("action", [createSchema, dispatchSchema, receiveSchema, cancelSchema]);

function fieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  err.errors.forEach((e) => {
    const path = e.path[0];
    if (typeof path === "string") out[path] = e.message;
  });
  return out;
}

function makeTransferNumber(): string {
  const now = new Date();
  // Four random digits collided across repeated runs and parallel shops; a time
  // component plus a wider random suffix keeps the unique index satisfied.
  const suffix = `${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 46656)
    .toString(36)
    .padStart(3, "0")}`.toUpperCase();
  return `TRF-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${suffix}`;
}

function toRow(doc: Record<string, unknown>) {
  const from = doc.fromBranchId as { _id?: unknown; name?: string; type?: string } | null;
  const to = doc.toBranchId as { _id?: unknown; name?: string; type?: string } | null;
  const fromWarehouse = doc.fromWarehouseId as { _id?: unknown; name?: string } | null;
  const toWarehouse = doc.toWarehouseId as { _id?: unknown; name?: string } | null;
  const createdBy = doc.createdBy as { _id?: unknown; name?: string } | null;
  const fromId = fromWarehouse
    ? String(fromWarehouse._id ?? doc.fromWarehouseId)
    : doc.fromBranchId
      ? String(from?._id ?? doc.fromBranchId)
      : null;
  const toId = toWarehouse
    ? String(toWarehouse._id ?? doc.toWarehouseId)
    : doc.toBranchId
      ? String(to?._id ?? doc.toBranchId)
      : null;
  return {
    _id: String(doc._id),
    transferNumber: doc.transferNumber,
    status: doc.status,
    // The legacy from/toBranch* fields stay populated so existing consumers
    // (including the transfers table) keep working for warehouses too.
    fromBranchId: fromId,
    fromBranchName: fromWarehouse?.name ?? from?.name ?? null,
    fromBranchType: fromWarehouse ? "warehouse" : from?.type ?? "shop",
    toBranchId: toId,
    toBranchName: toWarehouse?.name ?? to?.name ?? null,
    toBranchType: toWarehouse ? "warehouse" : to?.type ?? "shop",
    fromWarehouseId: doc.fromWarehouseId ? String(fromWarehouse?._id ?? doc.fromWarehouseId) : null,
    toWarehouseId: doc.toWarehouseId ? String(toWarehouse?._id ?? doc.toWarehouseId) : null,
    items: doc.items ?? [],
    note: doc.note ?? "",
    discrepancyNote: doc.discrepancyNote ?? "",
    createdBy: createdBy?._id ? String(createdBy._id) : null,
    createdByName: createdBy?.name ?? null,
    dispatchedAt: doc.dispatchedAt ?? null,
    receivedAt: doc.receivedAt ?? null,
    canceledAt: doc.canceledAt ?? null,
    createdAt: doc.createdAt,
  };
}

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.transfers.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status")?.trim() ?? "";
    const fromBranchId = searchParams.get("fromBranchId")?.trim() ?? "";
    const toBranchId = searchParams.get("toBranchId")?.trim() ?? "";
    const page = Math.max(1, Number(searchParams.get("page") ?? 1));
    const perPage = Math.min(100, Math.max(1, Number(searchParams.get("perPage") ?? 25)));

    // Branch-restricted users see transfers touching their own location.
    const base: Record<string, unknown> = {};
    if (user.branchId) {
      const branch = new mongoose.Types.ObjectId(user.branchId);
      base.$or = [{ fromBranchId: branch }, { toBranchId: branch }];
    }
    if (status) base.status = status;
    if (fromBranchId && mongoose.Types.ObjectId.isValid(fromBranchId)) {
      base.fromBranchId = new mongoose.Types.ObjectId(fromBranchId);
    }
    if (toBranchId && mongoose.Types.ObjectId.isValid(toBranchId)) {
      base.toBranchId = new mongoose.Types.ObjectId(toBranchId);
    }      const [total, rows, statusCounts] = await Promise.all([
      StockTransfer.countDocuments(base),
      StockTransfer.find(base)
        .populate("fromBranchId", "name type")
        .populate("toBranchId", "name type")
        .populate("fromWarehouseId", "name")
        .populate("toWarehouseId", "name")
        .populate("createdBy", "name")
        .sort({ createdAt: -1 })
        .skip((page - 1) * perPage)
        .limit(perPage)
        .lean(),
      StockTransfer.aggregate([
        { $match: base },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);

    // Units in transit = dispatched quantity not yet received.
    const inTransitRows = await StockTransfer.find({
      ...base,
      status: { $in: ["dispatched", "partially_received"] },
    })
      .select("items")
      .lean();
    const inTransitUnits = inTransitRows.reduce(
      (sum, row) =>
        sum +
        (row.items ?? []).reduce((lineSum, item) => lineSum + Math.max(0, item.quantity - item.receivedQuantity), 0),
      0
    );

    // Every location is listed, shops and warehouses alike. A transfer always
    // spans two locations, so hiding the ones the user is not assigned to made
    // the warehouse impossible to pick. Write access is still checked below.
    const branches = await Branch.find({})
      .select("name type status")
      .sort({ name: 1 })
      .lean();
    // Warehouses are separate entities, so they are listed separately and
    // offered as the other end of a transfer.
    const warehouses = await Warehouse.find({})
      .select("name status")
      .sort({ name: 1 })
      .lean();

    return NextResponse.json({
      transfers: rows.map((row) => toRow(row as unknown as Record<string, unknown>)),
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
      summary: {
        inTransitUnits,
        byStatus: Object.fromEntries(statusCounts.map((row) => [row._id, row.count])),
      },
      branches: branches.map((b) => ({
        _id: String(b._id),
        name: b.name,
        type: b.type ?? "shop",
        status: b.status,
      })),
      warehouses: warehouses.map((w) => ({
        _id: String(w._id),
        name: w.name,
        type: "warehouse" as const,
        status: w.status,
      })),
    });
  } catch (error) {
    console.error("GET /api/transfers error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();

    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(badRequest("Validation failed", fieldErrors(parsed.error)), { status: 400 });
    }
    const data = parsed.data;
    const meta = requestMeta(req);

    // ---------------- Create draft ----------------
    if (data.action === "create") {
      if (!(await hasPermission(user, PERMISSIONS.transfers.create))) {
        return NextResponse.json(forbidden(), { status: 403 });
      }
      const sourceBranchId = data.fromBranchId ?? null;
      const destinationBranchId = data.toBranchId ?? null;
      const sourceWarehouseId = data.fromWarehouseId ?? null;
      const destinationWarehouseId = data.toWarehouseId ?? null;

      if (Boolean(sourceBranchId) === Boolean(sourceWarehouseId)) {
        return NextResponse.json(badRequest("Choose one source: a shop or a warehouse"), { status: 400 });
      }
      if (Boolean(destinationBranchId) === Boolean(destinationWarehouseId)) {
        return NextResponse.json(badRequest("Choose one destination: a shop or a warehouse"), { status: 400 });
      }
      if (
        (sourceBranchId && sourceBranchId === destinationBranchId) ||
        (sourceWarehouseId && sourceWarehouseId === destinationWarehouseId)
      ) {
        return NextResponse.json(badRequest("Source and destination must be different locations"), { status: 400 });
      }
      // A branch-restricted user must own the shop end of the transfer; the
      // warehouse end carries no branch, so it needs no branch access.
      if (!canAccessBranch(user, sourceBranchId) && !canAccessBranch(user, destinationBranchId)) {
        return NextResponse.json(forbidden("You do not have access to either location"), { status: 403 });
      }

      const [from, to, sourceWarehouse, destinationWarehouse] = await Promise.all([
        sourceBranchId
          ? Branch.findById(sourceBranchId).select("name type status").lean()
          : Promise.resolve(null),
        destinationBranchId
          ? Branch.findById(destinationBranchId).select("name type status").lean()
          : Promise.resolve(null),
        sourceWarehouseId
          ? Warehouse.findById(sourceWarehouseId).select("name status").lean()
          : Promise.resolve(null),
        destinationWarehouseId
          ? Warehouse.findById(destinationWarehouseId).select("name status").lean()
          : Promise.resolve(null),
      ]);
      if (sourceBranchId && !from) return NextResponse.json(notFound("Source shop not found"), { status: 404 });
      if (destinationBranchId && !to) {
        return NextResponse.json(notFound("Destination shop not found"), { status: 404 });
      }
      if (sourceWarehouseId && !sourceWarehouse) {
        return NextResponse.json(notFound("Source warehouse not found"), { status: 404 });
      }
      if (destinationWarehouseId && !destinationWarehouse) {
        return NextResponse.json(notFound("Destination warehouse not found"), { status: 404 });
      }
      if (
        (from && from.status !== "active") ||
        (to && to.status !== "active") ||
        (sourceWarehouse && sourceWarehouse.status !== "active") ||
        (destinationWarehouse && destinationWarehouse.status !== "active")
      ) {
        return NextResponse.json(badRequest("Both locations must be active"), { status: 400 });
      }

      const productIds = [...new Set(data.items.map((i) => i.productId))];
      const products = await Product.find({ _id: { $in: productIds }, status: { $ne: "archived" } })
        .select("name sku costPrice")
        .lean();
      const productMap = new Map(products.map((p) => [String(p._id), p]));

      const items = [];
      for (const line of data.items) {
        const product = productMap.get(line.productId);
        if (!product) return NextResponse.json(badRequest(`Product ${line.productId} not found`), { status: 400 });
        let expirationDate: Date | null = null;
        if (line.expirationDate) {
          const parsedDate = new Date(line.expirationDate);
          if (Number.isNaN(parsedDate.getTime())) {
            return NextResponse.json(badRequest("Invalid expiration date"), { status: 400 });
          }
          expirationDate = parsedDate;
        }
        items.push({
          productId: new mongoose.Types.ObjectId(line.productId),
          name: product.name,
          sku: product.sku ?? "",
          quantity: line.quantity,
          receivedQuantity: 0,
          unitCost: product.costPrice ?? 0,
          batchNumber: line.batchNumber ?? "",
          expirationDate,
          purchaseSource: line.purchaseSource ?? null,
        });
      }

      const transfer = await StockTransfer.create({
        transferNumber: makeTransferNumber(),
        fromBranchId: sourceBranchId,
        toBranchId: destinationBranchId,
        fromWarehouseId: sourceWarehouseId,
        toWarehouseId: destinationWarehouseId,
        status: "draft",
        items,
        note: data.note ?? "",
        createdBy: user.id,
      });

      await recordAuditLog({
        user,
        action: "transfer.create",
        entityType: "StockTransfer",
        entityId: transfer._id.toString(),
        newValue: {
          from: sourceBranchId ?? sourceWarehouseId,
          to: destinationBranchId ?? destinationWarehouseId,
          items: items.length,
        },
        branchId: user.branchId ?? sourceBranchId ?? destinationBranchId,
        ...meta,
      });

      return NextResponse.json(
        success({ transfer: toRow(transfer.toObject() as unknown as Record<string, unknown>) }, "Transfer created"),
        { status: 201 }
      );
    }

    const transfer = await StockTransfer.findById(data.id);
    if (!transfer) return NextResponse.json(notFound("Transfer not found"), { status: 404 });

    // ---------------- Dispatch ----------------
    if (data.action === "dispatch") {
      if (!(await hasPermission(user, PERMISSIONS.transfers.dispatch))) {
        return NextResponse.json(forbidden(), { status: 403 });
      }
      // A transfer is a two-location operation: acting on either end is enough
      // (same scope the create/cancel rules use), so the receiving shop can
      // dispatch a warehouse order it owns.
      if (!canAccessBranch(user, transfer.fromBranchId) && !canAccessBranch(user, transfer.toBranchId)) {
        return NextResponse.json(forbidden("You do not have access to this transfer"), { status: 403 });
      }
      if (transfer.status !== "draft") {
        return NextResponse.json(badRequest("Only a draft transfer can be dispatched"), { status: 400 });
      }

      const fromBranchId = transfer.fromBranchId ? String(transfer.fromBranchId) : null;
      const fromWarehouseId = transfer.fromWarehouseId ? String(transfer.fromWarehouseId) : null;
      const productIds = transfer.items.map((item) => String(item.productId));
      const [stock, batches] = fromWarehouseId
        ? await Promise.all([
            getWarehouseStockForProducts(productIds, fromWarehouseId),
            getWarehouseBatches(productIds, fromWarehouseId),
          ])
        : await Promise.all([
            getStockForProducts(productIds, fromBranchId),
            getProductBatches(productIds, fromBranchId),
          ]);

      // Resolve the exact batch/source of every line BEFORE moving stock.
      const movements: Array<Record<string, unknown>> = [];
      for (const item of transfer.items) {
        const key = String(item.productId);
        const available = stock.get(key) ?? 0;
        if (available < item.quantity) {
          return NextResponse.json(
            badRequest(`${item.name}: only ${available} unit(s) available at the source location`),
            { status: 400 }
          );
        }

        const productBatches = batches.get(key) ?? [];
        let resolved: { batchNumber: string; expirationDate: Date | null; purchaseSource: string | null };
        if (item.batchNumber || item.expirationDate || item.purchaseSource) {
          const matchBatch = productBatches.find(
            (batch) =>
              batch.batchNumber === (item.batchNumber ?? "") &&
              ((batch.expirationDate === null && !item.expirationDate) ||
                (batch.expirationDate !== null &&
                  item.expirationDate !== null &&
                  batch.expirationDate.getTime() === new Date(item.expirationDate).getTime())) &&
              ((batch.purchaseSource ?? null) === (item.purchaseSource ?? null))
          );
          if (!matchBatch || matchBatch.quantity < item.quantity) {
            return NextResponse.json(
              badRequest(`${item.name}: the selected batch does not have ${item.quantity} unit(s) available`),
              { status: 400 }
            );
          }
          resolved = {
            batchNumber: matchBatch.batchNumber,
            expirationDate: matchBatch.expirationDate,
            purchaseSource: matchBatch.purchaseSource ?? null,
          };
        } else {
          // FEFO must resolve the whole line from a single batch; splitting a
          // line across batches would lose its origin on receipt.
          const [allocation] = allocateQuantity(productBatches, item.quantity, { allowExpired: true });
          if (!allocation || allocation.quantity < item.quantity) {
            return NextResponse.json(
              badRequest(
                `${item.name}: this quantity spans several batches. Split the transfer line per batch (or pick a batch) so expiry and purchase source stay traceable.`
              ),
              { status: 400 }
            );
          }
          resolved = {
            batchNumber: allocation.batchNumber,
            expirationDate: allocation.expirationDate,
            purchaseSource: allocation.purchaseSource ?? null,
          };
        }

        item.batchNumber = resolved.batchNumber;
        item.expirationDate = resolved.expirationDate;
        item.purchaseSource = resolved.purchaseSource as "import" | "local" | null;

        movements.push({
          productId: item.productId,
          branchId: transfer.fromBranchId ?? null,
          warehouseId: transfer.fromWarehouseId ?? null,
          movementType: "TRANSFER_OUT",
          quantity: item.quantity,
          unitCost: item.unitCost,
          batchNumber: resolved.batchNumber,
          expirationDate: resolved.expirationDate,
          purchaseSource: resolved.purchaseSource,
          referenceType: "transfer",
          referenceId: transfer._id,
          note: `Transfer ${transfer.transferNumber} dispatched`,
          userId: new mongoose.Types.ObjectId(user.id),
        });
      }

      await InventoryMovement.insertMany(movements);
      transfer.status = "dispatched";
      transfer.dispatchedBy = new mongoose.Types.ObjectId(user.id);
      transfer.dispatchedAt = new Date();
      await transfer.save();

      await recordAuditLog({
        user,
        action: "transfer.dispatch",
        entityType: "StockTransfer",
        entityId: transfer._id.toString(),
        newValue: { status: "dispatched", units: transfer.items.reduce((s, i) => s + i.quantity, 0) },
        branchId: transfer.fromBranchId?.toString() ?? null,
        ...meta,
      });

      return NextResponse.json(success({ transfer: toRow(transfer.toObject() as unknown as Record<string, unknown>) }, "Transfer dispatched"));
    }

    // ---------------- Receive (supports partial) ----------------
    if (data.action === "receive") {
      if (!(await hasPermission(user, PERMISSIONS.transfers.receive))) {
        return NextResponse.json(forbidden(), { status: 403 });
      }
      if (!canAccessBranch(user, transfer.fromBranchId) && !canAccessBranch(user, transfer.toBranchId)) {
        return NextResponse.json(forbidden("You do not have access to this transfer"), { status: 403 });
      }
      if (!["dispatched", "partially_received"].includes(transfer.status)) {
        return NextResponse.json(badRequest("Only a dispatched transfer can be received"), { status: 400 });
      }

      const requested = new Map<number, number>();
      if (data.received && data.received.length > 0) {
        for (const line of data.received) {
          if (line.index < 0 || line.index >= transfer.items.length) {
            return NextResponse.json(badRequest(`Transfer line ${line.index} does not exist`), { status: 400 });
          }
          requested.set(line.index, line.quantity);
        }
      }

      const movements: Array<Record<string, unknown>> = [];
      let receivedNow = 0;
      transfer.items.forEach((item, index) => {
        const remaining = Math.max(0, item.quantity - (item.receivedQuantity ?? 0));
        const quantity = requested.has(index) ? Math.min(remaining, Math.max(0, requested.get(index) ?? 0)) : remaining;
        if (quantity <= 0) return;
        item.receivedQuantity = (item.receivedQuantity ?? 0) + quantity;
        receivedNow += quantity;
        movements.push({
          productId: item.productId,
          // The destination location (shop or warehouse) now holds the stock.
          branchId: transfer.toBranchId ?? null,
          warehouseId: transfer.toWarehouseId ?? null,
          movementType: "TRANSFER_IN",
          quantity,
          unitCost: item.unitCost,
          batchNumber: item.batchNumber ?? "",
          expirationDate: item.expirationDate ?? null,
          purchaseSource: item.purchaseSource ?? null,
          referenceType: "transfer",
          referenceId: transfer._id,
          note: `Transfer ${transfer.transferNumber} received`,
          userId: new mongoose.Types.ObjectId(user.id),
        });
      });

      if (receivedNow === 0) {
        return NextResponse.json(badRequest("Nothing to receive on this transfer"), { status: 400 });
      }

      await InventoryMovement.insertMany(movements);

      const fullyReceived = transfer.items.every((item) => (item.receivedQuantity ?? 0) >= item.quantity);
      transfer.status = fullyReceived ? "received" : "partially_received";
      transfer.receivedBy = new mongoose.Types.ObjectId(user.id);
      transfer.receivedAt = new Date();
      if (!fullyReceived && data.discrepancyNote) transfer.discrepancyNote = data.discrepancyNote;
      await transfer.save();

      await recordAuditLog({
        user,
        action: "transfer.receive",
        entityType: "StockTransfer",
        entityId: transfer._id.toString(),
        newValue: {
          status: transfer.status,
          unitsReceived: receivedNow,
          shortfall: transfer.items.reduce((s, i) => s + Math.max(0, i.quantity - (i.receivedQuantity ?? 0)), 0),
        },
        note: data.discrepancyNote || undefined,
        branchId: transfer.toBranchId?.toString() ?? null,
        ...meta,
      });

      return NextResponse.json(
        success(
          { transfer: toRow(transfer.toObject() as unknown as Record<string, unknown>) },
          fullyReceived ? "Transfer received" : "Partial receipt recorded"
        )
      );
    }

    // ---------------- Cancel (only before dispatch) ----------------
    if (!(await hasPermission(user, PERMISSIONS.transfers.cancel))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }
    if (!canAccessBranch(user, transfer.fromBranchId) && !canAccessBranch(user, transfer.toBranchId)) {
      return NextResponse.json(forbidden("You do not have access to this transfer"), { status: 403 });
    }
    if (transfer.status !== "draft") {
      return NextResponse.json(badRequest("Only a draft transfer can be canceled; dispatched stock must be received"), {
        status: 400,
      });
    }
    transfer.status = "canceled";
    transfer.canceledBy = new mongoose.Types.ObjectId(user.id);
    transfer.canceledAt = new Date();
    await transfer.save();

    await recordAuditLog({
      user,
      action: "transfer.cancel",
      entityType: "StockTransfer",
      entityId: transfer._id.toString(),
      oldValue: { status: "draft" },
      newValue: { status: "canceled" },
      branchId: transfer.fromBranchId?.toString() ?? null,
      ...meta,
    });

    return NextResponse.json(
      success({ transfer: toRow(transfer.toObject() as unknown as Record<string, unknown>) }, "Transfer canceled")
    );
  } catch (error) {
    if (error instanceof BranchAccessError) {
      return NextResponse.json(forbidden(error.message), { status: 403 });
    }
    console.error("POST /api/transfers error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
