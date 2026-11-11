import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import {
  Purchase,
  Supplier,
  Product,
  InventoryMovement,
  SupplierTransaction,
  Payment,
  User,
  Warehouse,
} from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { z } from "zod";
import { success, badRequest, forbidden, notFound } from "@/lib/api";
import mongoose from "mongoose";
import { revalidatePath } from "next/cache";
import { recordCashMovementIfDrawerOpen } from "@/lib/finance-service";
import { recordAuditLog, requestMeta, diffForAudit } from "@/lib/audit";
import { assertBranchAccess, BranchAccessError } from "@/lib/branch-access";
import { generatePurchaseNumber } from "@/lib/document-number";
import { Department } from "@/models";

const purchaseItemSchema = z.object({
  productId: z.string().min(1, "Product is required"),
  quantity: z.number().int().min(1, "Quantity must be at least 1"),
  purchasePrice: z.number().min(0, "Price cannot be negative"),
  sellingPrice: z.number().min(0, "Price cannot be negative").optional().default(0),
  discount: z.number().min(0).max(100).default(0),
  tax: z.number().min(0).max(100).default(0),
  /** Optional expiry for THIS received batch (separate batches may differ). */
  expirationDate: z.string().trim().nullable().optional(),
  /** Optional human batch code; auto-generated when only an expiry is given. */
  batchNumber: z.string().trim().max(60).optional(),
});

const createPurchaseSchema = z.object({
  supplierId: z.string().min(1, "Supplier is required"),
  /** Import (China) stock is owner/manager-controlled; Local is the default. */
  purchaseSource: z.enum(["import", "local"]).default("local"),
  /**
   * Where the received stock lands: the shop (sellable at the POS) or a
   * warehouse (reserve that only transfers into a shop later).
   */
  locationType: z.enum(["shop", "warehouse"]).default("shop"),
  /** Required when locationType is "warehouse". */
  warehouseId: z.string().nullable().optional(),
  /** Department (mini-store) the local stock is bought for; null = the shop. */
  departmentId: z.string().nullable().optional(),
  items: z.array(purchaseItemSchema).min(1, "At least one item is required"),
  discount: z.number().min(0).max(100).default(0),
  tax: z.number().min(0).max(100).default(0),
  paymentMethod: z.enum(["cash", "card", "transfer", "check", "account", "other"]).default("cash"),
  paidAmount: z.number().min(0).default(0),
  note: z.string().default(""),
});

/** Completing only needs the purchase id — the record already holds the lines. */
const completePurchaseSchema = z.object({
  id: z.string().min(1, "Purchase ID is required"),
});

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.purchases.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const page = Math.max(1, Number(searchParams.get("page") ?? 1));
    const perPage = Math.min(100, Math.max(1, Number(searchParams.get("perPage") ?? 15)));
    const supplierId = searchParams.get("supplierId")?.trim() ?? "";
    const status = searchParams.get("status")?.trim() ?? "";
    const source = searchParams.get("source")?.trim() ?? "";

    const query: Record<string, unknown> = {};
    if (status) query.status = status;
    if (supplierId) query.supplierId = supplierId;
    if (source === "import" || source === "local") query.purchaseSource = source;

    const total = await Purchase.countDocuments(query);      const purchases = await Purchase.find(query)
      .populate<{ supplierId: { name: string } }>("supplierId", "name")
      .populate<{ createdBy: { name: string } }>("createdBy", "name")
      .populate<{ warehouseId: { name: string } }>("warehouseId", "name")
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean() as Array<Record<string, unknown>>;

    return NextResponse.json({
      purchases: purchases.map((p) => ({
        ...p,
        supplierId: p.supplierId as { _id: string; name: string } | null,
        createdBy: p.createdBy as { _id: string; name: string } | null,
        warehouseName: (p.warehouseId as { name?: string } | null)?.name ?? null,
      })),
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    });
  } catch (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();

    const body = await req.json();
    const action = body.action;
    const meta = requestMeta(req);

    if (action === "create") {
      if (!(await hasPermission(user, PERMISSIONS.purchases.create))) {
        return NextResponse.json(forbidden(), { status: 403 });
      }

      const parsed = createPurchaseSchema.safeParse(body);
      if (!parsed.success) {
        const fieldErrors: Record<string, string> = {};
        parsed.error.errors.forEach((err) => {
          const path = err.path[0];
          if (typeof path === "string") fieldErrors[path] = err.message;
        });
        return NextResponse.json(badRequest("Validation failed", fieldErrors), { status: 400 });
      }

      const data = parsed.data;

      // Server-side enforcement, not just a hidden UI option: only holders of
      // purchases.import may record Import (China) stock.
      if (data.purchaseSource === "import" && !(await hasPermission(user, PERMISSIONS.purchases.importStock))) {
        return NextResponse.json(
          forbidden("Import (China) purchases require manager authorisation"),
          { status: 403 }
        );
      }

      const supplier = await Supplier.findById(data.supplierId);
      if (!supplier) {
        return NextResponse.json(notFound("Supplier not found"), { status: 404 });
      }

      // Local stock can be bought for a department (a mini-store inside the
      // shop). "Shop" is the default and means the store's own stock.
      let departmentId: mongoose.Types.ObjectId | null = null;
      let departmentName = "Shop";
      if (data.purchaseSource === "local" && data.departmentId) {
        if (!mongoose.Types.ObjectId.isValid(data.departmentId)) {
          return NextResponse.json(badRequest("Invalid department"), { status: 400 });
        }
        const department = await Department.findById(data.departmentId)
          .select("name branchId status")
          .lean();
        if (!department) return NextResponse.json(notFound("Department not found"), { status: 404 });
        if (department.status !== "active") {
          return NextResponse.json(badRequest("The selected department is inactive"), { status: 400 });
        }
        if (supplier.branchId && String(department.branchId) !== String(supplier.branchId)) {
          return NextResponse.json(badRequest("The department belongs to a different shop"), { status: 400 });
        }
        departmentId = department._id;
        departmentName = department.name;
      }

      // Warehouse receipts are recorded against the warehouse only — never the
      // shop's branch — so the POS never offers (or sells) reserve stock.
      let destinationWarehouseId: mongoose.Types.ObjectId | null = null;
      let receiveInto = "Shop";
      if (data.locationType === "warehouse") {
        if (!data.warehouseId || !mongoose.Types.ObjectId.isValid(data.warehouseId)) {
          return NextResponse.json(badRequest("Select the warehouse that receives this purchase"), {
            status: 400,
          });
        }
        const warehouse = await Warehouse.findById(data.warehouseId).select("name status").lean();
        if (!warehouse) return NextResponse.json(notFound("Warehouse not found"), { status: 404 });
        if (warehouse.status !== "active") {
          return NextResponse.json(badRequest("The selected warehouse is inactive"), { status: 400 });
        }
        destinationWarehouseId = warehouse._id;
        receiveInto = warehouse.name;
      }

      // Fetch products and snapshot names/prices
      const productIds = data.items.map((item) => item.productId);
      const products = await Product.find({ _id: { $in: productIds } }).lean<Array<{ _id: unknown; name: string; sku: string; sellingPrice: number }>>();
      // lean() returns _id as an ObjectId — key by string so lookups with the
      // request's string product ids actually match.
      const productMap = new Map(products.map((p) => [String(p._id), p]));

      for (const item of data.items) {
        const product = productMap.get(item.productId);
        if (!product) {
          return NextResponse.json(badRequest(`Product ${item.productId} not found`), { status: 400 });
        }
      }

      // Every received line may carry its own expiry/batch. Invalid dates are
      // rejected up front instead of silently dropping the expiry information.
      const parsedExpiries = data.items.map((item) => {
        if (!item.expirationDate) return null;
        const date = new Date(item.expirationDate);
        return Number.isNaN(date.getTime()) ? undefined : date;
      });
      if (parsedExpiries.some((d) => d === undefined)) {
        return NextResponse.json(badRequest("Invalid expiration date"), { status: 400 });
      }

      const now = new Date();
      const purchaseNumber = generatePurchaseNumber(now);

      let subtotal = 0;
      const itemsWithSnapshot = data.items.map((item, index) => {
        const product = productMap.get(item.productId)!;
        const itemSubtotal = item.quantity * item.purchasePrice;
        subtotal += itemSubtotal;
        const expirationDate = parsedExpiries[index] ?? null;
        const batchNumber = expirationDate
          ? item.batchNumber?.trim() || `${purchaseNumber}-${index + 1}`
          : item.batchNumber?.trim() ?? "";
        return {
          productId: item.productId,
          name: product.name,
          sku: product.sku,
          quantity: item.quantity,
          purchasePrice: item.purchasePrice,
          sellingPrice: product.sellingPrice,
          discount: item.discount,
          tax: item.tax,
          subtotal: itemSubtotal,
          batchNumber,
          expirationDate,
        };
      });

      const discountAmount = subtotal * (data.discount / 100);
      const taxAmount = (subtotal - discountAmount) * (data.tax / 100);
      const total = subtotal - discountAmount + taxAmount;
      const paidAmount = Math.min(data.paidAmount, total);
      const dueAmount = total - paidAmount;

      const purchase = await Purchase.create({
        purchaseNumber,
        supplierId: data.supplierId,
        branchId: supplier.branchId ?? null,
        purchaseSource: data.purchaseSource,
        locationType: destinationWarehouseId ? "warehouse" : "shop",
        warehouseId: destinationWarehouseId,
        departmentId,
        departmentName,
        status: "pending",
        items: itemsWithSnapshot,
        subtotal,
        discount: data.discount,
        tax: data.tax,
        total,
        paidAmount,
        dueAmount,
        paymentMethod: data.paymentMethod,
        createdBy: user.id,
        note: data.note.trim(),
      });

      // Create inventory IN movements for each item
      for (const item of itemsWithSnapshot) {
        await InventoryMovement.create({
          productId: item.productId,
          branchId: destinationWarehouseId ? null : purchase.branchId ?? null,
          warehouseId: destinationWarehouseId,
          movementType: "PURCHASE_IN",
          quantity: item.quantity,
          unitCost: item.purchasePrice,
          batchNumber: item.batchNumber ?? "",
          expirationDate: item.expirationDate ?? null,
          purchaseSource: purchase.purchaseSource,
          referenceType: "purchase",
          referenceId: purchase._id,
          note: `Purchase ${purchaseNumber}`,
          userId: user.id,
        });
      }

      // Supplier transaction for the purchase
      const supplierBalance = await getSupplierBalance(supplier._id.toString());
      await SupplierTransaction.create({
        supplierId: supplier._id,
        branchId: purchase.branchId ?? null,
        type: "purchase",
        amount: total,
        balanceAfter: supplierBalance + total,
        referenceType: "purchase",
        referenceId: purchase._id,
        description: `Purchase ${purchaseNumber}`,
        userId: user.id,
      });

      // Payment if paid
      if (paidAmount > 0) {
        await Payment.create({
          type: "purchase",
          referenceType: "purchase",
          referenceId: purchase._id,
          amount: paidAmount,
          method: data.paymentMethod,
          description: `Payment for purchase ${purchaseNumber}`,
          userId: user.id,
          branchId: purchase.branchId ?? null,
        });

        // Supplier payment transaction
        const balanceAfterPayment = await getSupplierBalance(supplier._id.toString()) - paidAmount;
        await SupplierTransaction.create({
          supplierId: supplier._id,
          branchId: purchase.branchId ?? null,
          type: "payment",
          amount: -paidAmount,
          balanceAfter: balanceAfterPayment,
          method: data.paymentMethod,
          reference: purchaseNumber,
          referenceType: "purchase",
          referenceId: purchase._id,
          description: `Payment for purchase ${purchaseNumber}`,
          userId: user.id,
        });

        // Cash purchases leave the drawer immediately
        if (data.paymentMethod === "cash") {
          await recordCashMovementIfDrawerOpen({
            userId: user.id,
            branchId: purchase.branchId ? purchase.branchId.toString() : null,
            type: "expense",
            amount: -paidAmount,
            description: `Purchase payment ${purchaseNumber}`,
            referenceType: "supplier_payment",
            referenceId: purchase._id.toString(),
          });
        }
      }

      await recordAuditLog({
        user,
        action: "purchase.create",
        entityType: "Purchase",
        entityId: purchase._id.toString(),
        newValue: { purchaseNumber: purchase.purchaseNumber, total, supplierId: data.supplierId, purchaseSource: purchase.purchaseSource, receiveInto, locationType: data.locationType, departmentName, items: itemsWithSnapshot.length },
        branchId: purchase.branchId?.toString(),
        ...meta,
      });
      revalidatePath("/api/purchases");
      return NextResponse.json(success({ purchase }, "Purchase created"), { status: 201 });
    }

    if (action === "cancel") {
      if (!(await hasPermission(user, PERMISSIONS.purchases.cancel))) {
        return NextResponse.json(forbidden(), { status: 403 });
      }
      const { id } = (body as { id?: string });
      if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        return NextResponse.json(badRequest("Purchase ID is required"), { status: 400 });
      }

      const purchase = await Purchase.findById(id).populate("supplierId");
      if (!purchase) return NextResponse.json(notFound("Purchase not found"), { status: 404 });
      assertBranchAccess(user, purchase.branchId);

      if (purchase.status === "canceled") {
        return NextResponse.json(badRequest("Purchase is already canceled"), { status: 400 });
      }
      if (purchase.status === "completed") {
        // Cancelling a completed purchase reverses stock + supplier balance + payment.
        if (purchase.paidAmount > 0) {
          return NextResponse.json(badRequest("Completed purchases with payments must be reconciled through supplier returns, not canceled"), { status: 400 });
        }
        for (const item of purchase.items) {
          await InventoryMovement.create({
            productId: item.productId,
            branchId: purchase.warehouseId ? null : purchase.branchId,
            warehouseId: purchase.warehouseId ?? null,
            movementType: "SUPPLIER_RETURN_OUT",
            quantity: item.quantity,
            unitCost: item.purchasePrice,
            // Reverse the SAME batch so its remaining quantity (and expiry
            // alert) disappears with the cancelled receipt.
            batchNumber: item.batchNumber ?? "",
            expirationDate: item.expirationDate ?? null,
            purchaseSource: purchase.purchaseSource ?? "local",
            referenceType: "purchase",
            referenceId: purchase._id,
            note: `Cancellation of purchase ${purchase.purchaseNumber}`,
            userId: user.id,
          });
        }
        await SupplierTransaction.create({
          supplierId: purchase.supplierId as unknown as mongoose.Types.ObjectId,
          branchId: purchase.branchId,
          type: "debit",
          amount: -purchase.total,
          balanceAfter: 0,
          referenceType: "purchase",
          referenceId: purchase._id,
          description: `Purchase ${purchase.purchaseNumber} canceled — supplier balance reversed`,
          userId: user.id,
        });
        purchase.status = "canceled";
        await purchase.save();
        await recordAuditLog({ user, action: "purchase.cancel", entityType: "Purchase", entityId: id, oldValue: { status: "completed" }, note: `Canceled ${purchase.purchaseNumber}`, branchId: purchase.branchId?.toString(), ...meta });
        return NextResponse.json(success({ id }, "Purchase canceled with stock + balance reversal"));
      }

      // Cancel a pending/drafted purchase: back out stock already added.
      for (const item of purchase.items) {
        await InventoryMovement.create({
          productId: item.productId,
          branchId: purchase.warehouseId ? null : purchase.branchId,
          warehouseId: purchase.warehouseId ?? null,
          movementType: "SUPPLIER_RETURN_OUT",
          quantity: item.quantity,
          unitCost: item.purchasePrice,
          batchNumber: item.batchNumber ?? "",
          expirationDate: item.expirationDate ?? null,
          purchaseSource: purchase.purchaseSource ?? "local",
          referenceType: "purchase",
          referenceId: purchase._id,
          note: `Cancellation of purchase ${purchase.purchaseNumber}`,
          userId: user.id,
        });
      }
      await SupplierTransaction.create({
        supplierId: purchase.supplierId as unknown as mongoose.Types.ObjectId,
        branchId: purchase.branchId,
        type: "debit",
        amount: -purchase.total,
        balanceAfter: 0,
        referenceType: "purchase",
        referenceId: purchase._id,
        description: `Purchase ${purchase.purchaseNumber} canceled — supplier balance reversed`,
        userId: user.id,
      });
      purchase.status = "canceled";
      await purchase.save();
      await recordAuditLog({ user, action: "purchase.cancel", entityType: "Purchase", entityId: id, oldValue: { status: purchase.status }, note: `Canceled ${purchase.purchaseNumber}`, branchId: purchase.branchId?.toString(), ...meta });
      return NextResponse.json(success({ id }, "Purchase canceled"));
    }

    if (action === "complete") {
      if (!(await hasPermission(user, PERMISSIONS.purchases.create))) {
        return NextResponse.json(forbidden(), { status: 403 });
      }

      const parsed = completePurchaseSchema.safeParse(body);
      if (!parsed.success) {
        const fieldErrors: Record<string, string> = {};
        parsed.error.errors.forEach((err) => {
          const path = err.path[0];
          if (typeof path === "string") fieldErrors[path] = err.message;
        });
        return NextResponse.json(badRequest("Validation failed", fieldErrors), { status: 400 });
      }

      const data = parsed.data;
      const purchase = await Purchase.findById(data.id).populate("supplierId");
      if (!purchase) {
        return NextResponse.json(notFound("Purchase not found"), { status: 404 });
      }

      if (purchase.status !== "pending") {
        return NextResponse.json(badRequest("Cannot complete a purchase that is not pending"), { status: 400 });
      }

      const supplier = purchase.supplierId as unknown as { _id: string; name: string; branchId: string | null } | null;
      if (!supplier) {
        return NextResponse.json(badRequest("Supplier not found"), { status: 400 });
      }

      purchase.status = "completed";
      await purchase.save();

      // Audit the completion.
      await recordAuditLog({
        user,
        action: "purchase.completed",
        entityType: "Purchase",
        entityId: purchase._id.toString(),
        branchId: purchase.branchId?.toString(),
        note: `Purchase #${purchase.purchaseNumber} completed`,
        ...meta,
      });

      // Invalidate cached branch product list so the next POS reload re-reads current costs/stock.
      await revalidatePath("/api/pos/products");

      return NextResponse.json(success({ purchase }, "Purchase completed"));
    }

    return NextResponse.json(badRequest("Unknown action"), { status: 400 });
  } catch (error) {
    if (error instanceof BranchAccessError) {
      return NextResponse.json(forbidden(error.message), { status: 403 });
    }
    console.error("POST /api/purchases error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

async function getSupplierBalance(supplierId: string) {
  // Only sum transactions that belong to this user's accessible branches, so a
  // manager scoped to one branch cannot read another branch's supplier balance
  // and so deleted/expired branches do not reintroduce phantom balances.
  const match: Record<string, unknown> = { supplierId: new mongoose.Types.ObjectId(supplierId) };
  const sessionUser = await requireSessionUser();
  if (sessionUser.branchId) {
    match.branchId = new mongoose.Types.ObjectId(sessionUser.branchId);
  }

  const transactions = await SupplierTransaction.aggregate([
    { $match: match },
    { $group: { _id: null, balance: { $sum: "$amount" } } },
  ]);
  return transactions[0]?.balance ?? 0;
}
