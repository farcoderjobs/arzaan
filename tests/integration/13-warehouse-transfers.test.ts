/**
 * Warehouse / shop stock transfers: dispatch, partial receipt, cancellation,
 * invalid transfers, stock conservation and batch/expiry/source traceability.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACCOUNTS,
  api,
  authFor,
  checkoutPayload,
  connectDb,
  createProduct,
  createSupplier,
  dbStock,
  openRegister,
  purgeTag,
  tag,
  type AuthCtx,
} from "../helpers/qa";
import { Branch, InventoryMovement, StockTransfer } from "../../src/models";

describe("warehouse & shop stock transfers", () => {
  let admin: AuthCtx;
  let branch1: AuthCtx;
  let branch2: AuthCtx;
  let shopAId: string;
  let shopBId: string;
  let warehouseId: string;

  const cleanupTags: string[] = [];
  const transferIds: string[] = [];
  const warehouseCode = `QAW${Date.now().toString(36).slice(-5).toUpperCase()}`;

  beforeAll(async () => {
    await connectDb();
    admin = await authFor(ACCOUNTS.admin);
    branch1 = await authFor(ACCOUNTS.branch1);
    branch2 = await authFor(ACCOUNTS.branch2);

    const branches = await Branch.find({ code: { $in: ["QAB1", "QAB2"] } }).lean();
    shopAId = String(branches.find((b) => b.code === "QAB1")!._id);
    shopBId = String(branches.find((b) => b.code === "QAB2")!._id);

    const created = await api(admin.token).post("/api/branches", {
      name: `QA Warehouse ${warehouseCode}`,
      code: warehouseCode,
      type: "warehouse",
    });
    expect(created.status).toBe(201);
    warehouseId = created.body.data.id;
  });

  afterAll(async () => {
    await connectDb();
    await StockTransfer.deleteMany({ _id: { $in: transferIds } }).catch(() => undefined);
    if (warehouseId) {
      await InventoryMovement.deleteMany({ branchId: warehouseId }).catch(() => undefined);
      await Branch.deleteOne({ _id: warehouseId }).catch(() => undefined);
    }
    for (const t of cleanupTags) await purgeTag(t).catch(() => undefined);
  });

  /** Product with `quantity` units already received at shop A. */
  async function stockedProduct(quantity = 10, extras: Record<string, unknown> = {}) {
    const supplier = await createSupplier(branch1.token);
    const product = await createProduct(admin.token, { sellingPrice: 25, purchasePrice: 10 });
    cleanupTags.push(supplier.tag, product.tag);
    const purchase = await api(branch1.token).post("/api/purchases", {
      action: "create",
      supplierId: supplier._id,
      purchaseSource: (extras.purchaseSource as string) ?? "local",
      items: [
        {
          productId: product._id,
          quantity,
          purchasePrice: 10,
          batchNumber: (extras.batchNumber as string) ?? "",
          expirationDate: (extras.expirationDate as string) ?? null,
        },
      ],
      paidAmount: 0,
      paymentMethod: "account",
    });
    if (purchase.status !== 201) throw new Error(`stock purchase failed: ${JSON.stringify(purchase.body)}`);
    return { product, purchase: purchase.body.data.purchase, supplier };
  }

  async function createTransfer(from: string, to: string, productId: string, quantity: number, note = tag("trf")) {
    const res = await api(admin.token).post("/api/transfers", {
      action: "create",
      fromBranchId: from,
      toBranchId: to,
      items: [{ productId, quantity }],
      note,
    });
    if (res.status === 201) transferIds.push(res.body.data.transfer._id);
    return res;
  }

  it("creates, dispatches and receives a shop → warehouse transfer without inventing stock", async () => {
    const { product } = await stockedProduct(10);
    expect(await dbStock(product._id, shopAId)).toBe(10);

    const created = await createTransfer(shopAId, warehouseId, product._id, 4);
    expect(created.status).toBe(201);
    expect(created.body.data.transfer.status).toBe("draft");
    // Drafts do not move stock.
    expect(await dbStock(product._id, shopAId)).toBe(10);

    const dispatch = await api(branch1.token).post("/api/transfers", {
      action: "dispatch",
      id: created.body.data.transfer._id,
    });
    expect(dispatch.status).toBe(200);
    expect(dispatch.body.data.transfer.status).toBe("dispatched");
    expect(await dbStock(product._id, shopAId)).toBe(6);
    // Nothing arrives until the destination receives it.
    expect(await dbStock(product._id, warehouseId)).toBe(0);
    expect(await dbStock(product._id)).toBe(6);

    const receive = await api(admin.token).post("/api/transfers", {
      action: "receive",
      id: created.body.data.transfer._id,
    });
    expect(receive.status).toBe(200);
    expect(receive.body.data.transfer.status).toBe("received");
    expect(await dbStock(product._id, warehouseId)).toBe(4);
    expect(await dbStock(product._id, shopAId) + (await dbStock(product._id, warehouseId))).toBe(10);
  });

  it("supports a partial receipt and reports the remainder as in transit", async () => {
    const { product } = await stockedProduct(12);
    const created = await createTransfer(shopAId, warehouseId, product._id, 6);
    expect(created.status).toBe(201);

    const dispatch = await api(branch1.token).post("/api/transfers", { action: "dispatch", id: created.body.data.transfer._id });
    expect(dispatch.status).toBe(200);

    const partial = await api(admin.token).post("/api/transfers", {
      action: "receive",
      id: created.body.data.transfer._id,
      received: [{ index: 0, quantity: 4 }],
      discrepancyNote: "2 cartons damaged in transit",
    });
    expect(partial.status).toBe(200);
    expect(partial.body.data.transfer.status).toBe("partially_received");
    expect(await dbStock(product._id, warehouseId)).toBe(4);
    expect(await dbStock(product._id, shopAId)).toBe(6);
    expect(await dbStock(product._id)).toBe(10);

    const list = await api(admin.token).get("/api/transfers?status=partially_received");
    expect(list.status).toBe(200);
    expect(list.body.summary.inTransitUnits).toBeGreaterThanOrEqual(2);

    const remaining = await api(admin.token).post("/api/transfers", {
      action: "receive",
      id: created.body.data.transfer._id,
    });
    expect(remaining.status).toBe(200);
    expect(remaining.body.data.transfer.status).toBe("received");
    expect(await dbStock(product._id, warehouseId)).toBe(6);
    expect(await dbStock(product._id)).toBe(12);
  });

  it("preserves batch number, expiry and Import origin across the move", async () => {
    const batchNumber = `B-${tag("b")}`;
    const { product } = await stockedProduct(5, {
      batchNumber,
      expirationDate: "2027-12-31",
      purchaseSource: "import",
    });

    const created = await createTransfer(shopAId, warehouseId, product._id, 2);
    expect(created.status).toBe(201);
    const transferId = created.body.data.transfer._id;

    expect((await api(branch1.token).post("/api/transfers", { action: "dispatch", id: transferId })).status).toBe(200);
    const dispatched = await StockTransfer.findById(transferId).lean();
    expect(dispatched?.items[0]?.batchNumber).toBe(batchNumber);
    expect(dispatched?.items[0]?.expirationDate?.toISOString().slice(0, 10)).toBe("2027-12-31");
    expect(dispatched?.items[0]?.purchaseSource).toBe("import");

    const out = await InventoryMovement.findOne({ referenceId: transferId, movementType: "TRANSFER_OUT" }).lean();
    expect(out?.branchId?.toString()).toBe(shopAId);
    expect(out?.batchNumber).toBe(batchNumber);
    expect(out?.purchaseSource).toBe("import");

    expect((await api(admin.token).post("/api/transfers", { action: "receive", id: transferId })).status).toBe(200);
    const incoming = await InventoryMovement.findOne({ referenceId: transferId, movementType: "TRANSFER_IN" }).lean();
    expect(incoming?.branchId?.toString()).toBe(warehouseId);
    expect(incoming?.batchNumber).toBe(batchNumber);
    expect(incoming?.expirationDate?.toISOString().slice(0, 10)).toBe("2027-12-31");
    expect(incoming?.purchaseSource).toBe("import");
  });

  it("refuses to dispatch more than the source holds, and refuses invalid routes", async () => {
    const { product } = await stockedProduct(2);
    const tooMany = await createTransfer(shopAId, warehouseId, product._id, 5);
    expect(tooMany.status).toBe(201);

    const dispatch = await api(branch1.token).post("/api/transfers", { action: "dispatch", id: tooMany.body.data.transfer._id });
    expect(dispatch.status).toBe(400);
    expect(String(dispatch.body.error.message)).toMatch(/only 2 unit/i);
    expect(await dbStock(product._id, shopAId)).toBe(2);

    const sameLocation = await createTransfer(shopAId, shopAId, product._id, 1);
    expect(sameLocation.status).toBe(400);

    const foreign = await api(branch1.token).post("/api/transfers", {
      action: "create",
      fromBranchId: shopBId,
      toBranchId: warehouseId,
      items: [{ productId: product._id, quantity: 1 }],
    });
    expect(foreign.status).toBe(403);

    // Creating a draft from their own shop is allowed (it moves nothing yet).
    const ownShop = await api(branch2.token).post("/api/transfers", {
      action: "create",
      fromBranchId: shopBId,
      toBranchId: warehouseId,
      items: [{ productId: product._id, quantity: 1 }],
    });
    expect(ownShop.status).toBe(201);
    transferIds.push(ownShop.body.data.transfer._id);
  });

  it("cancels only before dispatch and blocks cross-branch dispatch", async () => {
    const { product } = await stockedProduct(5);
    const created = await createTransfer(shopAId, warehouseId, product._id, 2);
    expect(created.status).toBe(201);
    const transferId = created.body.data.transfer._id;

    // A branch2 manager cannot dispatch out of shop A.
    const foreignDispatch = await api(branch2.token).post("/api/transfers", { action: "dispatch", id: transferId });
    expect(foreignDispatch.status).toBe(403);

    const cancel = await api(branch1.token).post("/api/transfers", { action: "cancel", id: transferId });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.transfer.status).toBe("canceled");
    expect(await dbStock(product._id, shopAId)).toBe(5);

    const dispatched = await createTransfer(shopAId, warehouseId, product._id, 2);
    expect((await api(branch1.token).post("/api/transfers", { action: "dispatch", id: dispatched.body.data.transfer._id })).status).toBe(200);
    const cancelAfterDispatch = await api(branch1.token).post("/api/transfers", {
      action: "cancel",
      id: dispatched.body.data.transfer._id,
    });
    expect(cancelAfterDispatch.status).toBe(400);
  });

  it("does not let a warehouse be used as a selling location", async () => {
    const { product } = await stockedProduct(2);
    // Stock the warehouse so the failure is the location rule, not stock.
    const created = await createTransfer(shopAId, warehouseId, product._id, 2);
    expect((await api(branch1.token).post("/api/transfers", { action: "dispatch", id: created.body.data.transfer._id })).status).toBe(200);
    expect((await api(admin.token).post("/api/transfers", { action: "receive", id: created.body.data.transfer._id })).status).toBe(200);

    // Attach the branch-1 manager to the warehouse so their POS would target it.
    // Restored in `finally`: a failed assertion must never leave the shared
    // seeded account stranded on the warehouse — later tests scope data by branch.
    await api(admin.token).post("/api/users", { action: "update", data: { id: branch1.userId, branchId: warehouseId } });
    let registerOpenedHere: string | null = null;
    try {
      const register = await api(branch1.token).post("/api/cash-register", { action: "open", openCash: 0 });
      if (register.status === 201) {
        registerOpenedHere = register.body.data.registerId ?? register.body.data.register?._id ?? null;
      } else {
        // The manager may already hold an open register from an earlier test —
        // either way a register exists, which is all the sale below needs.
        expect(register.status).toBe(400);
        expect(/already/i.test(register.body?.error?.message ?? "")).toBe(true);
      }

      const sale = await api(branch1.token).post("/api/sales", checkoutPayload({
        items: [{ productId: product._id, quantity: 1 }],
        payments: [{ method: "cash", amount: 25 }],
      }));
      expect(sale.status).toBe(400);
      expect(sale.body.error.code).toBe("INVALID_SELLING_LOCATION");
    } finally {
      // A register opened while attached to the warehouse would carry that
      // location into later sales — close it before handing the manager back.
      if (registerOpenedHere) {
        await api(branch1.token).post("/api/cash-register", {
          action: "close",
          registerId: registerOpenedHere,
          countedCash: 0,
          note: "QA cleanup",
        }).catch(() => undefined);
      }
      // Restore the manager to shop A for any later test/file.
      await api(admin.token).post("/api/users", { action: "update", data: { id: branch1.userId, branchId: shopAId } });
    }
  });

  it("keeps transfer-derived stock visible to POS only at the selling location", async () => {
    const { product } = await stockedProduct(3);
    const created = await createTransfer(shopAId, warehouseId, product._id, 2);
    expect((await api(branch1.token).post("/api/transfers", { action: "dispatch", id: created.body.data.transfer._id })).status).toBe(200);
    expect((await api(admin.token).post("/api/transfers", { action: "receive", id: created.body.data.transfer._id })).status).toBe(200);

    // Warehouse stock is not sellable from shop A: 3 received − 2 moved = 1.
    await openRegister(branch1.token, 0);
    const sellable = await api(branch1.token).get(`/api/pos/products?search=${encodeURIComponent(product.name)}`);
    expect(sellable.status).toBe(200);
    const row = sellable.body.products.find(
      (p: { _id: string; currentStock: number }) => p._id === product._id
    );
    expect(row?.currentStock).toBe(1);
  });
});
