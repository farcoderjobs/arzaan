import { describe, it, expect } from "vitest";
import {
  round2,
  validateUnitDiscounts,
  validateSaleDiscount,
  computeSaleTotals,
  validatePayments,
  computeSalePaymentFields,
  MAX_DISCOUNT_PERCENT,
} from "../src/lib/commerce";

const product = (over: Partial<{ costPrice: number; sellingPrice: number; discountPrice: number; taxRate: number; _id: string; name: string; sku: string; currentStock: number }> = {}) => ({
  _id: "p1",
  name: "Widget",
  sku: "W-1",
  costPrice: 6,
  sellingPrice: 10,
  discountPrice: 0,
  taxRate: 0,
  currentStock: 100,
  ...over,
});

describe("round2", () => {
  it("rounds floating point drift to 2 decimals", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
  });
});

describe("discount validation", () => {
  it("rejects negative discounts", () => {
    expect(validateUnitDiscounts([{ unitDiscount: -1 }], "amount")).toMatch(/Invalid discount/);
    expect(validateSaleDiscount(-5, "amount")).toMatch(/Invalid sale discount/);
  });

  it("rejects percent discounts above 100", () => {
    expect(validateUnitDiscounts([{ unitDiscount: 101 }], "percent")).toMatch(/cannot exceed/);
    expect(validateSaleDiscount(150, "percent")).toMatch(/cannot exceed/);
  });

  it("allows amounts above 100 (money) but clamps to line total at compute time", () => {
    expect(validateUnitDiscounts([{ unitDiscount: 500 }], "amount")).toBeNull();
    expect(validateSaleDiscount(500, "amount")).toBeNull();
  });

  it("rejects non-finite values", () => {
    expect(validateUnitDiscounts([{ unitDiscount: NaN }], "amount")).toMatch(/Invalid/);
    expect(validateSaleDiscount(Infinity, "percent")).toMatch(/Invalid/);
  });
});

describe("computeSaleTotals (server-authoritative pricing)", () => {
  it("computes simple line totals", () => {
    const r = computeSaleTotals(
      [{ productId: "p1", quantity: 3, unitDiscount: 0 }],
      [product()],
      0,
      "amount"
    );
    expect(r.subtotal).toBe(30);
    expect(r.tax).toBe(0);
    expect(r.total).toBe(30);
    expect(r.items[0].sellingPrice).toBe(10);
  });

  it("ignores client-sent prices entirely — only server prices are used", () => {
    // Even if the client could mutate product data, computeSaleTotals takes prices
    // exclusively from the serverProduct list.
    const r = computeSaleTotals(
      [{ productId: "p1", quantity: 2, unitDiscount: 0 }],
      [product({ sellingPrice: 10 })],
      0,
      "amount"
    );
    expect(r.items[0].sellingPrice).toBe(10);
    expect(r.total).toBe(20);
  });

  it("applies per-line amount discount", () => {
    const r = computeSaleTotals(
      [{ productId: "p1", quantity: 2, unitDiscount: 3 }],
      [product()],
      0,
      "amount"
    );
    // gross 20 - 3 = 17
    expect(r.subtotal).toBe(20);
    expect(r.items[0].discount).toBe(3);
    expect(r.items[0].subtotal).toBe(17);
    expect(r.total).toBe(17);
  });

  it("applies per-line percent discount", () => 	{
    const r = computeSaleTotals(
      [{ productId: "p1", quantity: 2, unitDiscount: 50 }],
      [product()],
      0,
      "percent"
    );
    // gross 20 - 50% = 10
    expect(r.items[0].subtotal).toBe(10);
    expect(r.total).toBe(10);
  });

  it("caps line amount discount at line gross (no negative prices)", () => {
    const r = computeSaleTotals(
      [{ productId: "p1", quantity: 1, unitDiscount: 999 }],
      [product()],
      0,
      "amount"
    );
    expect(r.items[0].subtotal).toBe(0);
    expect(r.total).toBe(0);
  });

  it("invariant: total === subtotal - discount + tax (line discounts included)", () => {
    const r = computeSaleTotals(
      [{ productId: "p1", quantity: 2, unitDiscount: 3 }, { productId: "p2", quantity: 1, unitDiscount: 0 }],
      [product(), product({ _id: "p2", costPrice: 4 })],
      2,
      "amount"
    );
    expect(r.total).toBe(round2(r.subtotal - r.discount + r.tax));
    // gross 30 − line disc 3 − sale disc 2 = 25
    expect(r.total).toBe(25);
  });

  it("applies sale-level percent discount to the subtotal", () => {
    const r = computeSaleTotals(
      [{ productId: "p1", quantity: 4, unitDiscount: 0 }],
      [product()],
      25,
      "percent"
    );
    expect(r.subtotal).toBe(40);
    expect(r.discount).toBe(10);
    expect(r.total).toBe(30);
  });

  it("caps sale-level amount discount at subtotal", () => {
    const r = computeSaleTotals(
      [{ productId: "p1", quantity: 1, unitDiscount: 0 }],
      [product()],
      999,
      "amount"
    );
    expect(r.discount).toBe(10);
    expect(r.total).toBe(0);
  });

  it("computes tax on the discounted line", () => {
    const r = computeSaleTotals(
      [{ productId: "p1", quantity: 1, unitDiscount: 0 }],
      [product({ taxRate: 10 })],
      0,
      "amount"
    );
    // 10 + 10% = 11
    expect(r.tax).toBe(1);
    expect(r.total).toBe(11);
  });

  it("uses discountPrice when it is a cheaper promo price", () => {
    const r = computeSaleTotals(
      [{ productId: "p1", quantity: 1, unitDiscount: 0 }],
      [product({ discountPrice: 8 })],
      0,
      "amount"
    );
    expect(r.items[0].sellingPrice).toBe(8);
    expect(r.total).toBe(8);
  });

  it("ignores discountPrice when higher than sellingPrice", () => {
    const r = computeSaleTotals(
      [{ productId: "p1", quantity: 1, unitDiscount: 0 }],
      [product({ discountPrice: 12 })],
      0,
      "amount"
    );
    expect(r.items[0].sellingPrice).toBe(10);
  });

  it("throws for unknown product (server must reject)", () => {
    expect(() =>
      computeSaleTotals([{ productId: "ghost", quantity: 1, unitDiscount: 0 }], [product()], 0, "amount")
    ).toThrow(/not found/);
  });

  it("carries costPrice through for COGS (historical snapshot)", () => {
    const r = computeSaleTotals(
      [{ productId: "p1", quantity: 2, unitDiscount: 0 }],
      [product({ costPrice: 6 })],
      0,
      "amount"
    );
    expect(r.items[0].costPrice).toBe(6);
  });
});

describe("validatePayments", () => {
  it("rejects empty payments", () => {
    expect(validatePayments([], 10)).toMatchObject({ ok: false });
  });

  it("rejects zero/negative/NaN amounts", () => {
    expect(validatePayments([{ method: "cash", amount: 0 }], 10)).toMatchObject({ ok: false });
    expect(validatePayments([{ method: "cash", amount: -3 }], 10)).toMatchObject({ ok: false });
    expect(validatePayments([{ method: "cash", amount: NaN }], 10)).toMatchObject({ ok: false });
  });

  it("rejects unknown methods", () => {
    expect(validatePayments([{ method: "crypto" as never, amount: 10 }], 10)).toMatchObject({ ok: false });
  });

  it("rejects underpayment without credit", () => {
    expect(validatePayments([{ method: "cash", amount: 5 }], 10)).toMatchObject({ ok: false });
  });

  it("accepts exact payment", () => {
    expect(validatePayments([{ method: "cash", amount: 10 }], 10)).toMatchObject({ ok: true, totalPaid: 10 });
  });

  it("allows cash overpay and computes change later", () => {
    expect(validatePayments([{ method: "cash", amount: 15 }], 10)).toMatchObject({ ok: true });
  });

  it("blocks non-cash overpay", () => {
    expect(validatePayments([{ method: "card", amount: 12 }], 10)).toMatchObject({ ok: false });
  });

  it("allows underpayment when credit covers the rest", () => {
    expect(
      validatePayments([{ method: "cash", amount: 4 }, { method: "credit", amount: 6 }], 10)
    ).toMatchObject({ ok: true });
  });

  it("allows overpay via cash even with allowOverpay=false when change is due... only within cash rule", () => {
    // allowOverpay=false blocks cash beyond remaining balance
    expect(
      validatePayments([{ method: "cash", amount: 15 }], 10, { allowOverpay: false })
    ).toMatchObject({ ok: false });
  });
});

describe("computeSalePaymentFields (change math)", () => {
  it("splits single payment method", () => {
    const r = computeSalePaymentFields([{ method: "card", amount: 10 }], 10);
    expect(r.paymentMethod).toBe("card");
    expect(r.paidAmount).toBe(10);
    expect(r.changeAmount).toBe(0);
  });

  it("marks multiple methods as mixed", () => {
    const r = computeSalePaymentFields(
      [{ method: "cash", amount: 5 }, { method: "card", amount: 5 }],
      10
    );
    expect(r.paymentMethod).toBe("mixed");
    expect(r.paidAmount).toBe(10);
  });

  it("computes change for excess cash and caps paidAmount at total", () => {
    const r = computeSalePaymentFields([{ method: "cash", amount: 15 }], 10);
    expect(r.changeAmount).toBe(5);
    expect(r.paidAmount).toBe(10);
  });

  it("mixed payment with cash overpay: change only from cash", () => {
    const r = computeSalePaymentFields(
      [{ method: "card", amount: 8 }, { method: "cash", amount: 7 }],
      10
    );
    // card 8 + cash 7 = 15, total 10 → change 5 (from cash only)
    expect(r.changeAmount).toBe(5);
    expect(r.paidAmount).toBe(10);
  });
});
