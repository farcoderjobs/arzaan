import { describe, it, expect } from "vitest";
import { offerMatchesProduct, pickBestOffer } from "../src/lib/discount-rules";
import { computeSaleTotals } from "../src/lib/commerce";

describe("discount offer matching", () => {
  const product = { id: "p1", categoryId: "c1", departmentId: "d1" };

  const offer = (overrides: Partial<Parameters<typeof pickBestOffer>[0][number]> = {}) => ({
    id: "o1",
    name: "Offer",
    percentage: 5,
    productIds: [] as string[],
    categoryIds: [] as string[],
    departmentIds: [] as string[],
    ...overrides,
  });

  it("matches a directly selected product", () => {
    expect(offerMatchesProduct(offer({ productIds: ["p1"] }), product)).toBe(true);
  });

  it("matches every product of a selected category", () => {
    expect(offerMatchesProduct(offer({ categoryIds: ["c1"] }), product)).toBe(true);
  });

  it("matches a product in a selected department", () => {
    expect(offerMatchesProduct(offer({ departmentIds: ["d1"] }), product)).toBe(true);
  });

  it("does not apply when only unrelated targets are selected", () => {
    expect(
      offerMatchesProduct(offer({ productIds: ["p2"], categoryIds: ["c2"], departmentIds: ["d2"] }), product)
    ).toBe(false);
  });

  it("never applies an offer with no targets", () => {
    expect(offerMatchesProduct(offer(), product)).toBe(false);
  });

  it("picks the highest matching percentage instead of stacking offers", () => {
    const best = pickBestOffer(
      [
        offer({ id: "o1", percentage: 5, categoryIds: ["c1"] }),
        offer({ id: "o2", percentage: 12, productIds: ["p1"] }),
        offer({ id: "o3", percentage: 8, departmentIds: ["d1"] }),
      ],
      product
    );
    expect(best?.id).toBe("o2");
    expect(best?.percentage).toBe(12);
  });

  it("returns null when nothing matches", () => {
    expect(pickBestOffer([offer({ categoryIds: ["c9"] })], product)).toBeNull();
  });
});

describe("computeSaleTotals with an automatic offer", () => {
  const products = [
    {
      _id: "p1",
      name: "Detergent",
      sku: "D1",
      costPrice: 2,
      sellingPrice: 10,
      wholesalePrice: 8,
      taxRate: 0,
      currentStock: 10,
    },
  ];

  it("deducts the offer percentage from the line before tax", () => {
    const totals = computeSaleTotals(
      [{ productId: "p1", quantity: 2, unitDiscount: 0, offerDiscountPercent: 5 }],
      products,
      0,
      "amount"
    );
    expect(totals.subtotal).toBe(20);
    expect(totals.discount).toBe(1);
    expect(totals.total).toBe(19);
  });

  it("adds the offer on top of a manual line discount", () => {
    const totals = computeSaleTotals(
      [{ productId: "p1", quantity: 1, unitDiscount: 2, offerDiscountPercent: 10 }],
      products,
      0,
      "amount"
    );
    expect(totals.discount).toBe(3);
    expect(totals.total).toBe(7);
  });

  it("never discounts more than the line value", () => {
    const totals = computeSaleTotals(
      [{ productId: "p1", quantity: 1, unitDiscount: 10, offerDiscountPercent: 50 }],
      products,
      0,
      "amount"
    );
    expect(totals.discount).toBe(10);
    expect(totals.total).toBe(0);
  });

  it("leaves totals unchanged without an offer", () => {
    const totals = computeSaleTotals([{ productId: "p1", quantity: 1, unitDiscount: 0 }], products, 0, "amount");
    expect(totals.discount).toBe(0);
    expect(totals.total).toBe(10);
  });
});
