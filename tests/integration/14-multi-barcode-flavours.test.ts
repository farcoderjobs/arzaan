/**
 * Multi-barcode products sharing ONE inventory quantity.
 *
 * Covers: creating a product with flavour barcodes, scanning every barcode to
 * the same parent product, global barcode uniqueness, purchases carrying
 * flavour/barcode metadata, selling several flavours against shared stock,
 * server-authoritative flavour snapshots, shared-stock validation across cart
 * lines, concurrent sales never overselling, flavour/barcode sales reporting,
 * and returns restoring the parent product exactly once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACCOUNTS,
  api,
  authFor,
  connectDb,
  createProduct,
  createSupplier,
  dbStock,
  purgeTag,
  tag,
  type AuthCtx,
} from "../helpers/qa";
import { SaleReturn } from "../../src/models";

describe("multi-barcode shared inventory", () => {
  let admin: AuthCtx;
  const cleanupTags: string[] = [];

  beforeAll(async () => {
    await connectDb();
    admin = await authFor(ACCOUNTS.admin);
  });

  afterAll(async () => {
    for (const t of cleanupTags) await purgeTag(t).catch(() => undefined);
  });

  function uniqueCode(prefix: string): string {
    return `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`.toUpperCase();
  }

  it("scans every flavour barcode to one product and sells from one shared stock", async () => {
    const shared = tag("juice");
    const codeOrange = uniqueCode("JO");
    const codeMango = uniqueCode("JM");
    const codeApple = uniqueCode("JA");

    // 1 — one product, three barcodes with flavour labels
    const product = await createProduct(admin.token, {
      name: `QA Juice ${shared}`,
      barcode: codeOrange,
      barcodeLabel: "Orange",
      barcodes: [
        { code: codeMango, label: "Mango" },
        { code: codeApple, label: "Apple" },
      ],
    });
    cleanupTags.push(product.tag);
    expect(product._id).toBeTruthy();

    // 2 — every barcode resolves to the SAME parent product + its flavour
    for (const [code, flavour] of [
      [codeOrange, "Orange"],
      [codeMango, "Mango"],
      [codeApple, "Apple"],
    ] as const) {
      const scan = await api(admin.token).get(
        `/api/pos/products?barcode=${encodeURIComponent(code.toLowerCase())}`
      );
      expect(scan.status).toBe(200);
      expect(scan.body.product?._id).toBe(product._id);
      expect(scan.body.product?.matchedBarcode).toBe(code);
      expect(scan.body.product?.flavour).toBe(flavour);
    }

    // 3 — barcodes are globally unique across products
    const duplicate = await api(admin.token).post("/api/products", {
      name: `QA Duplicate ${tag("dup")}`,
      sku: `SKDUP${shared}`.toUpperCase(),
      barcode: codeMango,
      purchasePrice: 1,
      sellingPrice: 2,
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error.message).toMatch(/barcode already exists/i);

    // 4 — purchasing increases the parent product's single quantity once
    const supplier = await createSupplier(admin.token);
    cleanupTags.push(supplier.tag);
    const purchase = await api(admin.token).post("/api/purchases", {
      action: "create",
      supplierId: supplier._id,
      items: [
        {
          productId: product._id,
          quantity: 100,
          purchasePrice: 10,
          barcode: codeOrange,
          // The server re-reads the catalogue label, not the client value.
          flavour: "Wrong flavour",
        },
      ],
      paidAmount: 0,
      paymentMethod: "transfer",
      note: shared,
    });
    expect(purchase.status).toBe(201);
    expect(purchase.body.data.purchase.items[0].barcode).toBe(codeOrange);
    expect(purchase.body.data.purchase.items[0].flavour).toBe("Orange");
    expect(await dbStock(product._id)).toBe(100);

    // 5 — sell three flavours: separate lines, one shared deduction
    const sale = await api(admin.token).post("/api/sales", {
      items: [
        { productId: product._id, quantity: 2, barcode: codeOrange, flavour: "Wrong" },
        { productId: product._id, quantity: 3, barcode: codeMango },
        { productId: product._id, quantity: 1, barcode: codeApple },
      ],
      payments: [{ method: "card", amount: 120 }],
      note: shared,
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.data.total).toBe(120);
    expect(await dbStock(product._id)).toBe(94);

    const detail = await api(admin.token).get(`/api/sales/${sale.body.data.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.sale.items).toHaveLength(3);
    const orangeLine = detail.body.sale.items.find((i: { barcode: string }) => i.barcode === codeOrange);
    const mangoLine = detail.body.sale.items.find((i: { barcode: string }) => i.barcode === codeMango);
    expect(orangeLine.flavour).toBe("Orange");
    expect(mangoLine.flavour).toBe("Mango");
    expect(mangoLine.quantity).toBe(3);

    // Scanned stock lookup now reflects the single shared quantity.
    const afterSale = await api(admin.token).get(
      `/api/pos/products?barcode=${encodeURIComponent(codeApple)}`
    );
    expect(afterSale.body.product?.currentStock).toBe(94);

    // 6 — a barcode not registered on the product is rejected
    const badBarcode = await api(admin.token).post("/api/sales", {
      items: [{ productId: product._id, quantity: 1, barcode: "NOT-REGISTERED-123" }],
      payments: [{ method: "card", amount: 20 }],
    });
    expect(badBarcode.status).toBe(400);
    expect(badBarcode.body.error.code).toBe("BARCODE_NOT_ON_PRODUCT");
    expect(await dbStock(product._id)).toBe(94);

    // 7 — stock is validated on the TOTAL across flavour lines (94 available)
    const overSell = await api(admin.token).post("/api/sales", {
      items: [
        { productId: product._id, quantity: 90, barcode: codeOrange },
        { productId: product._id, quantity: 10, barcode: codeMango },
      ],
      payments: [{ method: "card", amount: 2000 }],
    });
    expect(overSell.status).toBe(400);
    expect(overSell.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(await dbStock(product._id)).toBe(94);

    // 8 — flavour/barcode sales report (date range = today)
    const report = await api(admin.token).get(
      "/api/reports/sales?groupBy=flavour&period=day&perPage=200"
    );
    expect(report.status).toBe(200);
    const codes = [codeOrange, codeMango, codeApple];
    type FlavourRow = {
      barcode: string;
      quantity: number;
      revenue: number;
      flavour: string;
      productName: string;
    };
    const rows = report.body.rows.filter((r: FlavourRow) => codes.includes(r.barcode)) as FlavourRow[];
    expect(rows).toHaveLength(3);
    const byCode = new Map<string, FlavourRow>(rows.map((r) => [r.barcode, r]));
    expect(byCode.get(codeOrange)?.quantity).toBe(2);
    expect(byCode.get(codeOrange)?.revenue).toBe(40);
    expect(byCode.get(codeOrange)?.flavour).toBe("Orange");
    expect(byCode.get(codeMango)?.quantity).toBe(3);
    expect(byCode.get(codeMango)?.revenue).toBe(60);
    expect(byCode.get(codeApple)?.quantity).toBe(1);
    expect(byCode.get(codeApple)?.revenue).toBe(20);

    // 9 — returning a flavour restores the parent product exactly once
    const lookup = await api(admin.token).get(
      `/api/pos/sales-lookup?invoice=${encodeURIComponent(sale.body.data.invoiceNumber)}`
    );
    expect(lookup.status).toBe(200);
    const returnableMango = lookup.body.sale.items.find(
      (line: { barcode: string }) => line.barcode === codeMango
    );
    expect(returnableMango?.flavour).toBe("Mango");
    expect(returnableMango?.lineId).toBeTruthy();

    const returned = await api(admin.token).post("/api/sales-returns", {
      saleId: sale.body.data.id,
      items: [{ lineId: returnableMango.lineId, quantity: 1 }],
      refundMethod: "card",
      reason: shared,
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);
    expect(await dbStock(product._id)).toBe(95);

    const returnDoc = await SaleReturn.findById(returned.body.data.id).lean();
    expect(returnDoc?.items[0].barcode).toBe(codeMango);
    expect(returnDoc?.items[0].flavour).toBe("Mango");

    // Only 2 Mango units remain returnable; restoring more is refused and
    // stock must not move a second time.
    const tooMany = await api(admin.token).post("/api/sales-returns", {
      saleId: sale.body.data.id,
      items: [{ lineId: returnableMango.lineId, quantity: 3 }],
      refundMethod: "card",
      reason: shared,
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe("EXCEEDS_SOLD_QUANTITY");
    expect(await dbStock(product._id)).toBe(95);
  });

  it("never oversells when two registers sell the same shared stock at once", async () => {
    const shared = tag("race");
    const codeA = uniqueCode("RA");
    const codeB = uniqueCode("RB");
    const product = await createProduct(admin.token, {
      name: `QA Race ${shared}`,
      barcode: codeA,
      barcodeLabel: "Red",
      barcodes: [{ code: codeB, label: "Blue" }],
    });
    cleanupTags.push(product.tag);

    const supplier = await createSupplier(admin.token);
    cleanupTags.push(supplier.tag);
    const purchase = await api(admin.token).post("/api/purchases", {
      action: "create",
      supplierId: supplier._id,
      items: [{ productId: product._id, quantity: 100, purchasePrice: 10 }],
      paidAmount: 0,
      paymentMethod: "transfer",
      note: shared,
    });
    expect(purchase.status).toBe(201);
    expect(await dbStock(product._id)).toBe(100);

    const sell = (barcode: string) =>
      api(admin.token).post("/api/sales", {
        items: [{ productId: product._id, quantity: 60, barcode }],
        payments: [{ method: "card", amount: 1200 }],
        note: shared,
      });

    const [first, second] = await Promise.all([sell(codeA), sell(codeB)]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    // Exactly one sale wins; the other is rejected against the committed stock.
    expect(statuses).toEqual([201, 400]);
    const loser = first.status === 400 ? first : second;
    expect(loser.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(await dbStock(product._id)).toBe(40);
  });
}, 240_000);
