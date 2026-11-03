import { describe, expect, it } from "vitest";
import { computeDirectItemTotals, computeSaleTotals } from "@/lib/commerce";

describe("direct-sale pricing", () => {
  it("prices lines server-side with tax and no product reference", () => {
    const result = computeDirectItemTotals([
      { description: " Market grapes ", quantity: 2, unitPrice: 15, unitCost: 10, taxRate: 10 },
    ]);

    expect(result.subtotal).toBe(30);
    expect(result.tax).toBe(3);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      productId: null,
      itemType: "direct",
      name: "Market grapes",
      sku: "DIRECT",
      quantity: 2,
      sellingPrice: 15,
      costPrice: 10,
      discount: 0,
      tax: 3,
      subtotal: 33,
    });
  });

  it("keeps direct lines out of inventory pricing and clamps invalid input", () => {
    const direct = computeDirectItemTotals([
      { description: "Odd lot", quantity: 1.9, unitPrice: 10, unitCost: -5, taxRate: 200 },
    ]);
    expect(direct.items[0].quantity).toBe(1);
    expect(direct.items[0].costPrice).toBe(0); // negative cost clamped
    expect(direct.items[0].tax).toBe(10); // 200% clamped to 100%
  });

  it("adds direct revenue on top of inventory totals without touching item math", () => {
    const inventory = computeSaleTotals(
      [{ productId: "p1", quantity: 1, unitDiscount: 0 }],
      [
        {
          _id: "p1",
          name: "Cola",
          sku: "COLA",
          costPrice: 5,
          sellingPrice: 10,
          wholesalePrice: 8,
          taxRate: 0,
          currentStock: 10,
        },
      ],
      0,
      "amount"
    );
    const direct = computeDirectItemTotals([
      { description: "Grapes", quantity: 1, unitPrice: 20, unitCost: 12, taxRate: 0 },
    ]);
    expect(inventory.subtotal + direct.subtotal).toBe(30);
    expect([...inventory.items, ...direct.items]).toHaveLength(2);
  });
});
