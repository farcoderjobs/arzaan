import { describe, expect, it } from "vitest";
import {
  computeBonusEarnBase,
  computeBonusEarned,
  computeBonusReversal,
  computeSalePaymentFields,
  computeSaleTotals,
  round2,
  validatePayments,
  WholesalePriceUnavailableError,
} from "../src/lib/commerce";

const catalogProduct = (over: Partial<{
  _id: string;
  name: string;
  sku: string;
  sellingPrice: number;
  wholesalePrice: number;
  costPrice: number;
  taxRate: number;
}> = {}) => ({
  _id: "p1",
  name: "Rice bag",
  sku: "RICE-1",
  costPrice: 700,
  sellingPrice: 1000,
  wholesalePrice: 850,
  taxRate: 0,
  currentStock: 100,
  ...over,
});

describe("explicit retail / wholesale pricing", () => {
  it("charges the regular selling price in retail mode", () => {
    const result = computeSaleTotals(
      [{ productId: "p1", quantity: 2, unitDiscount: 0 }],
      [catalogProduct()],
      0,
      "amount",
      "retail"
    );
    expect(result.items[0].sellingPrice).toBe(1000);
    expect(result.items[0].pricingMode).toBe("retail");
    expect(result.total).toBe(2000);
  });

  it("charges the saved wholesale price in wholesale mode", () => {
    const result = computeSaleTotals(
      [{ productId: "p1", quantity: 2, unitDiscount: 0 }],
      [catalogProduct()],
      0,
      "amount",
      "wholesale"
    );
    expect(result.items[0].sellingPrice).toBe(850);
    expect(result.items[0].pricingMode).toBe("wholesale");
    expect(result.total).toBe(1700);
  });

  it("applies discounts and tax to the actual tier price", () => {
    const result = computeSaleTotals(
      [{ productId: "p1", quantity: 2, unitDiscount: 10 }],
      [catalogProduct({ taxRate: 10 })],
      5,
      "percent",
      "wholesale"
    );
    // gross 1700 − 10% line (170) = 1530; sale 5% = 76.5; tax 10% of 1530 = 153
    expect(result.items[0].discount).toBe(170);
    expect(result.discount).toBe(round2(170 + 76.5));
    expect(result.tax).toBe(153);
    expect(result.total).toBe(round2(1700 - 246.5 + 153));
  });

  it("never silently prices a missing wholesale price at zero", () => {
    expect(() =>
      computeSaleTotals(
        [{ productId: "p1", quantity: 1, unitDiscount: 0 }],
        [catalogProduct({ wholesalePrice: 0 })],
        0,
        "amount",
        "wholesale"
      )
    ).toThrow(WholesalePriceUnavailableError);
  });
});

describe("customer bonus math", () => {
  it("earns 1% on a 2,000 net merchandise purchase", () => {
    const base = computeBonusEarnBase({
      subtotal: 2000,
      discount: 0,
      total: 2000,
      bonusRedeemed: 0,
      basis: "net_merchandise",
    });
    expect(computeBonusEarned(base, 1)).toBe(20);
  });

  it("excludes tax and the bonus-funded portion in net-merchandise mode", () => {
    const base = computeBonusEarnBase({
      subtotal: 2200,
      discount: 200,
      total: 2100, // 2000 merchandise + 100 tax
      bonusRedeemed: 100,
      basis: "net_merchandise",
    });
    expect(base).toBe(1900);
    expect(computeBonusEarned(base, 1)).toBe(19);
  });

  it("amount-paid mode includes tax but still excludes redeemed bonus", () => {
    const base = computeBonusEarnBase({
      subtotal: 2200,
      discount: 200,
      total: 2100,
      bonusRedeemed: 100,
      basis: "amount_paid",
    });
    expect(base).toBe(2000);
  });

  it("reverses proportionally and never beyond what was earned", () => {
    expect(computeBonusReversal({ earned: 20, refundAmount: 500, saleTotal: 2000, alreadyReversed: 0 })).toBe(5);
    expect(computeBonusReversal({ earned: 20, refundAmount: 2000, saleTotal: 2000, alreadyReversed: 18 })).toBe(2);
    expect(computeBonusReversal({ earned: 20, refundAmount: 2000, saleTotal: 2000, alreadyReversed: 20 })).toBe(0);
  });

  it("handles fractional percentages with two-decimal money rounding", () => {
    expect(computeBonusEarned(1999.99, 1.5)).toBe(30);
  });
});

describe("bonus as a payment tender", () => {
  it("accepts reward credit alongside cash when the tenders cover the total", () => {
    expect(
      validatePayments([{ method: "cash", amount: 80 }, { method: "bonus", amount: 20 }], 100)
    ).toMatchObject({ ok: true, totalPaid: 100 });
  });

  it("blocks reward credit from overpaying", () => {
    expect(validatePayments([{ method: "bonus", amount: 120 }], 100)).toMatchObject({ ok: false });
  });

  it("keeps change limited to cash and counts bonus as a non-cash tender", () => {
    const fields = computeSalePaymentFields(
      [{ method: "bonus", amount: 30 }, { method: "cash", amount: 80 }],
      100
    );
    expect(fields.paidAmount).toBe(100);
    expect(fields.changeAmount).toBe(10);
    expect(fields.paymentMethod).toBe("mixed");
  });
});
