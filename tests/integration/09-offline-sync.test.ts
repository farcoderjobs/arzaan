/**
 * Area 13 — Offline sales persistence, synchronization retries, duplicate
 * prevention, and concurrency/atomicity guarantees.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import {
  ACCOUNTS,
  api,
  authFor,
  checkoutPayload,
  connectDb,
  createProduct,
  dbStock,
  tag,
  type AuthCtx,
} from "../helpers/qa";
import { Sale } from "../../src/models";

describe("offline sync & idempotency", () => {
  let admin: AuthCtx;
  let cashier: AuthCtx;

  beforeAll(async () => {
    await connectDb();
    admin = await authFor(ACCOUNTS.admin);
    cashier = await authFor(ACCOUNTS.cashier);
  });

  async function seededProduct(price: number, stock: number) {
    const product = await createProduct(admin.token, { sellingPrice: price, purchasePrice: Math.round(price * 0.5) });
    await api(admin.token).post("/api/inventory", { productId: product._id, quantity: stock, movementType: "ADJUSTMENT_IN", reason: "seed" });
    return product;
  }

  it("syncs an offline sale, then replays are idempotent (no double stock deduction)", async () => {
    const product = await seededProduct(30, 10);
    const idem = `qa-sync-${tag()}`;
    const payload = {
      clientTransactionId: idem,
      deviceId: "qa-device-1",
      items: [{ productId: product._id, quantity: 2 }],
      payments: [{ method: "card", amount: 60 }],
    };

    const first = await api(cashier.token).post("/api/sync/sale", payload);
    expect(first.status).toBe(201);
    expect(first.body.data.invoiceNumber).toMatch(/^INV/);
    expect(await dbStock(product._id)).toBe(8);

    // Retries (offline client resends) must not duplicate anything
    for (let i = 0; i < 3; i++) {
      const replay = await api(cashier.token).post("/api/sync/sale", payload);
      expect(replay.status).toBe(200);
      expect(replay.body.alreadySynced).toBe(true);
      expect(replay.body.data.id).toBe(first.body.data.id);
    }

    const count = await Sale.countDocuments({ clientTransactionId: idem });
    expect(count).toBe(1);
    expect(await dbStock(product._id)).toBe(8);
  });

  it("rejects sync without a session (offline retries after expiry → 401, not 500)", async () => {
    const res = await api().post("/api/sync/sale", {
      clientTransactionId: `qa-noauth-${tag()}`,
      items: [{ productId: "000000000000000000000000", quantity: 1 }],
      payments: [{ method: "card", amount: 10 }],
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("surfaces stock conflicts as 409 (server moved on while device was offline)", async () => {
    const product = await seededProduct(20, 1);
    const res = await api(cashier.token).post("/api/sync/sale", {
      clientTransactionId: `qa-conflict-${tag()}`,
      items: [{ productId: product._id, quantity: 5 }],
      payments: [{ method: "card", amount: 100 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(await dbStock(product._id)).toBe(1);
  });

  it("concurrent duplicate syncs (same clientTransactionId) store exactly one sale", async () => {
    const product = await seededProduct(15, 10);
    const idem = `qa-race-${tag()}`;
    const payload = {
      clientTransactionId: idem,
      items: [{ productId: product._id, quantity: 1 }],
      payments: [{ method: "card", amount: 15 }],
    };

    const results = await Promise.all([
      api(cashier.token).post("/api/sync/sale", payload),
      api(cashier.token).post("/api/sync/sale", payload),
    ]);

    for (const r of results) {
      expect([200, 201, 409]).toContain(r.status);
      if (r.status === 201 || r.status === 200) {
        expect(r.body.success === true || r.body.alreadySynced === true).toBe(true);
      }
    }
    expect(await Sale.countDocuments({ clientTransactionId: idem })).toBe(1);
    expect(await dbStock(product._id)).toBe(9); // exactly one deduction
  });

  it("atomicity: concurrent sales of the last unit — exactly one succeeds", async () => {
    const product = await seededProduct(50, 1);
    const payloads = [
      checkoutPayload({ items: [{ productId: product._id, quantity: 1 }], payments: [{ method: "card", amount: 50 }], clientTransactionId: `qa-atomic-a-${tag()}` }),
      checkoutPayload({ items: [{ productId: product._id, quantity: 1 }], payments: [{ method: "card", amount: 50 }], clientTransactionId: `qa-atomic-b-${tag()}` }),
    ];

    const results = await Promise.all([
      api(admin.token).post("/api/sales", payloads[0]),
      api(admin.token).post("/api/sales", payloads[1]),
    ]);

    const successes = results.filter((r) => r.status === 201);
    const failures = results.filter((r) => r.status !== 201);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].status).toBe(400);
    expect(failures[0].body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(await dbStock(product._id)).toBe(0);
  });

  it("sequential retries after a stock conflict do not accumulate phantom sales", async () => {
    const product = await seededProduct(25, 2);
    const idem = `qa-retry-${tag()}`;
    const payload = {
      clientTransactionId: idem,
      items: [{ productId: product._id, quantity: 3 }],
      payments: [{ method: "card", amount: 75 }],
    };

    // First attempt fails (not enough stock), client later retries after stock arrives
    const conflict = await api(cashier.token).post("/api/sync/sale", payload);
    expect(conflict.status).toBe(409);
    expect(await Sale.countDocuments({ clientTransactionId: idem })).toBe(0);

    await api(admin.token).post("/api/inventory", { productId: product._id, quantity: 5, movementType: "ADJUSTMENT_IN", reason: "restock" });

    const retry = await api(cashier.token).post("/api/sync/sale", payload);
    expect(retry.status).toBe(201);
    expect(await Sale.countDocuments({ clientTransactionId: idem })).toBe(1);
    expect(await dbStock(product._id)).toBe(4);

    // A further retry with the same id is idempotent
    const final = await api(cashier.token).post("/api/sync/sale", payload);
    expect(final.status).toBe(200);
    expect(final.body.alreadySynced).toBe(true);
    expect(await dbStock(product._id)).toBe(4);
  });

  it("held sales survive a sync replay boundary (status held is honored)", async () => {
    const product = await seededProduct(12, 5);
    const idem = `qa-held-${tag()}`;
    const res = await api(cashier.token).post("/api/sync/sale", {
      clientTransactionId: idem,
      items: [{ productId: product._id, quantity: 1 }],
      payments: [{ method: "cash", amount: 12 }],
      status: "held",
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("held");
    expect(await dbStock(product._id)).toBe(5); // held ⇒ no deduction

    const replay = await api(cashier.token).post("/api/sync/sale", {
      clientTransactionId: idem,
      items: [{ productId: product._id, quantity: 1 }],
      payments: [{ method: "cash", amount: 12 }],
      status: "held",
    });
    expect(replay.status).toBe(200);
    expect(replay.body.alreadySynced).toBe(true);
    expect(await Sale.countDocuments({ clientTransactionId: idem })).toBe(1);
  });
});
