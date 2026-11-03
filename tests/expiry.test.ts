import { describe, expect, it } from "vitest";
import {
  EXPIRING_WINDOW_DAYS,
  addDays,
  allocateQuantity,
  classifyExpiration,
  daysUntil,
  expiredQuantity,
  sellableQuantity,
  summarizeBatches,
} from "@/lib/expiry";

const NOW = new Date(2026, 9, 25, 12, 0, 0); // 25 Oct 2026, local noon

describe("expiration status", () => {
  it("treats a past date as expired and today/future as not expired", () => {
    expect(classifyExpiration(addDays(NOW, -1), NOW)).toBe("expired");
    expect(classifyExpiration(NOW, NOW)).toBe("expiring");
    expect(classifyExpiration(addDays(NOW, 10), NOW)).toBe("expiring");
    expect(classifyExpiration(addDays(NOW, EXPIRING_WINDOW_DAYS), NOW)).toBe("expiring");
    expect(classifyExpiration(addDays(NOW, EXPIRING_WINDOW_DAYS + 1), NOW)).toBe("ok");
  });

  it("handles products without an expiration date", () => {
    expect(classifyExpiration(null, NOW)).toBe("none");
    expect(classifyExpiration(undefined, NOW)).toBe("none");
    expect(daysUntil(null, NOW)).toBeNull();
  });

  it("counts calendar days remaining", () => {
    expect(daysUntil(addDays(NOW, 7), NOW)).toBe(7);
    expect(daysUntil(addDays(NOW, -3), NOW)).toBe(-3);
  });

  it("returns a zeroed summary for undated stock", () => {
    const summary = summarizeBatches([{ batchNumber: "", quantity: 12 }], NOW);
    expect(summary).toMatchObject({
      expiredQty: 0,
      expiringQty: 0,
      datedQty: 0,
      quantity: 12,
      earliestExpiration: null,
      status: "none",
    });
  });
});

describe("batch expiry summary", () => {
  const batches = [
    { batchNumber: "A", expirationDate: addDays(NOW, -2), quantity: 3 },
    { batchNumber: "B", expirationDate: addDays(NOW, 5), quantity: 2 },
    { batchNumber: "", expirationDate: null, quantity: 4 },
  ];

  it("separates expired stock from stock expiring soon", () => {
    const summary = summarizeBatches(batches, NOW);
    expect(summary.expiredQty).toBe(3);
    expect(summary.expiringQty).toBe(2);
    expect(summary.datedQty).toBe(5);
    expect(summary.quantity).toBe(9); // expired stock still counts in stock
    expect(summary.status).toBe("expired");
    expect(summary.earliestExpiration?.getTime()).toBe(addDays(NOW, -2).getTime());
  });

  it("reports sellable vs expired quantities", () => {
    expect(expiredQuantity(batches, NOW)).toBe(3);
    expect(sellableQuantity(batches, NOW)).toBe(6);
  });
});

describe("FEFO allocation", () => {
  const batches = [
    { batchNumber: "A", expirationDate: addDays(NOW, -2), quantity: 3 },
    { batchNumber: "B", expirationDate: addDays(NOW, 5), quantity: 2 },
    { batchNumber: "", expirationDate: null, quantity: 4 },
  ];

  it("skips expired batches by default and sells earliest expiry first", () => {
    const allocation = allocateQuantity(batches, 4, { now: NOW });
    expect(allocation).toEqual([
      { batchNumber: "B", expirationDate: addDays(NOW, 5), quantity: 2 },
      { batchNumber: "", expirationDate: null, quantity: 2 },
    ]);
  });

  it("only consumes expired stock when every sellable batch is exhausted and an override is allowed", () => {
    const allocation = allocateQuantity(batches, 7, { allowExpired: true, now: NOW });
    expect(allocation.map((a) => [a.batchNumber, a.quantity])).toEqual([
      ["B", 2],
      ["", 4],
      ["A", 1],
    ]);
  });

  it("returns nothing when all stock is expired and overrides are off", () => {
    expect(
      allocateQuantity([{ batchNumber: "X", expirationDate: addDays(NOW, -1), quantity: 5 }], 2, {
        now: NOW,
      })
    ).toEqual([]);
  });
});
