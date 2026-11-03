/**
 * Areas 1, 2, 4, 6, 8 and direct products (3) — expiration batches and alerts,
 * multi-barcode uniqueness / variant lookup, stock-status filters, direct-sale
 * lines, barcode generation and storefront categories from the DB.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACCOUNTS,
  api,
  authFor,
  connectDb,
  createCategory,
  createProduct,
  createSupplier,
  dbStock,
  purgeTag,
  receiveStock,
  tag,
  type AuthCtx,
} from "../helpers/qa";
import { AuditLog, StoreProduct } from "../../src/models";
import { isValidEan13 } from "../../src/lib/barcode";

function dateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

describe(
  "expiration, barcodes, filters, direct sales and store categories",
  () => {
  let admin: AuthCtx;
  let cashier: AuthCtx;
  const cleanupTags: string[] = [];
  const storeProductNames: string[] = [];

  beforeAll(async () => {
    await connectDb();
    admin = await authFor(ACCOUNTS.admin);
    cashier = await authFor(ACCOUNTS.cashier);
  });

  afterAll(async () => {
    for (const name of storeProductNames) {
      await StoreProduct.deleteMany({ name }).catch(() => undefined);
    }
    for (const t of cleanupTags) {
      await purgeTag(t).catch(() => undefined);
    }
  });

  // ---------------------------------------------------------------------------
  // 1 — Expiration dates, batches and alerts
  // ---------------------------------------------------------------------------

  it("records a received batch with its own expiration date and exposes it in filters/alerts", async () => {
    const supplier = await createSupplier(admin.token);
    const product = await createProduct(admin.token);
    cleanupTags.push(supplier.tag, product.tag);

    const res = await api(admin.token).post("/api/purchases", {
      action: "create",
      supplierId: supplier._id,
      items: [
        {
          productId: product._id,
          quantity: 5,
          purchasePrice: 10,
          expirationDate: dateOffset(10),
          batchNumber: "BATCH-A",
        },
      ],
      paidAmount: 0,
      paymentMethod: "transfer",
      note: tag("expiry-pur"),
    });
    expect(res.status).toBe(201);
    const purchase = res.body.data.purchase;
    expect(purchase.items[0].batchNumber).toBe("BATCH-A");
    expect(purchase.items[0].expirationDate).toBeTruthy();

    expect(await dbStock(product._id)).toBe(5);

    // Inventory filter: expiring soon only
    const expiring = await api(admin.token).get(
      `/api/inventory?expiry=expiring&product=${encodeURIComponent(product.sku)}`
    );
    expect(expiring.status).toBe(200);
    const row = expiring.body.products.find((p: { _id: string }) => p._id === product._id);
    expect(row).toBeTruthy();
    expect(row.expiringQty).toBe(5);
    expect(row.expiredQty).toBe(0);
    expect(row.earliestExpiration).toBeTruthy();

    // Inventory filter: expired only — this product must NOT appear
    const expired = await api(admin.token).get(
      `/api/inventory?expiry=expired&product=${encodeURIComponent(product.sku)}`
    );
    expect(expired.body.products.some((p: { _id: string }) => p._id === product._id)).toBe(false);

    // Dashboard notification carries the required display fields
    const dashboard = await api(admin.token).get("/api/dashboard?days=1");
    expect(dashboard.status).toBe(200);
    const alert = dashboard.body.expiry.items.find(
      (item: { productId: string; batchNumber: string }) =>
        item.productId === product._id && item.batchNumber === "BATCH-A"
    );
    expect(alert).toBeTruthy();
    expect(alert.name).toBe(product.name);
    expect(alert.sku).toBe(product.sku);
    expect(alert.quantity).toBe(5);
    expect(alert.status).toBe("expiring");
    expect(typeof alert.daysRemaining).toBe("number");
    expect(dashboard.body.expiry.expiringCount).toBeGreaterThanOrEqual(1);
  });

  it("blocks sales of expired stock by default and logs an authorised override", async () => {
    const supplier = await createSupplier(admin.token);
    const product = await createProduct(admin.token, { sellingPrice: 20 });
    cleanupTags.push(supplier.tag, product.tag);

    const purchase = await api(admin.token).post("/api/purchases", {
      action: "create",
      supplierId: supplier._id,
      items: [
        {
          productId: product._id,
          quantity: 3,
          purchasePrice: 10,
          expirationDate: dateOffset(-5),
        },
      ],
      paidAmount: 0,
      paymentMethod: "transfer",
      note: tag("expired-pur"),
    });
    expect(purchase.status).toBe(201);
    expect(purchase.body.data.purchase.items[0].batchNumber).toMatch(/PUR-/);
    expect(await dbStock(product._id)).toBe(3);

    // Cashier (no sales.override_expired) cannot sell it.
    const blocked = await api(cashier.token).post("/api/sales", {
      items: [{ productId: product._id, quantity: 1 }],
      payments: [{ method: "card", amount: 20 }],
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe("EXPIRED_PRODUCT");

    // Admin holds the override permission; the sale succeeds and is audited.
    const allowed = await api(admin.token).post("/api/sales", {
      items: [{ productId: product._id, quantity: 1 }],
      payments: [{ method: "card", amount: 20 }],
    });
    expect(allowed.status).toBe(201);
    expect(allowed.body.data.expiredOverride).toBe(true);
    expect(await dbStock(product._id)).toBe(2);

    const audit = await AuditLog.findOne({
      action: "sale.expired_override",
      entityId: allowed.body.data.id,
    }).lean();
    expect(audit).toBeTruthy();

    const expiredFilter = await api(admin.token).get("/api/inventory?expiry=expired");
    const row = expiredFilter.body.products.find((p: { _id: string }) => p._id === product._id);
    expect(row?.expiredQty).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // 2 — Multiple barcodes and variants
  // ---------------------------------------------------------------------------

  it("keeps barcodes unique across products/variants and resolves scannable lookups", async () => {
    const parent = await createProduct(admin.token, { name: `QA Lollipop ${tag("lol")}` });
    const variant = await createProduct(admin.token, {
      name: `QA Lollipop Strawberry ${tag("lol")}`,
      parentProductId: parent._id,
      variantName: "Strawberry",
      sellingPrice: 30,
    });
    cleanupTags.push(parent.tag, variant.tag);

    const parentCode = `LOL-${Date.now()}`;
    const add = await api(admin.token).post("/api/products/barcodes", {
      action: "add",
      productId: parent._id,
      code: parentCode,
      label: "Classic",
    });
    expect(add.status).toBe(200);

    const duplicate = await api(admin.token).post("/api/products/barcodes", {
      action: "add",
      productId: variant._id,
      code: parentCode,
      label: "Strawberry",
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error.message).toMatch(/already assigned/i);

    const lookupParent = await api(admin.token).get(`/api/pos/products?barcode=${encodeURIComponent(parentCode)}`);
    expect(lookupParent.body.product?._id).toBe(parent._id);

    const variantCode = `LOL-SB-${Date.now()}`;
    const addVariant = await api(admin.token).post("/api/products/barcodes", {
      action: "add",
      productId: variant._id,
      code: variantCode,
      label: "Strawberry",
    });
    expect(addVariant.status).toBe(200);

    const lookupVariant = await api(admin.token).get(`/api/pos/products?barcode=${encodeURIComponent(variantCode)}`);
    expect(lookupVariant.body.product?._id).toBe(variant._id);
    expect(lookupVariant.body.product?.sellingPrice).toBe(30);

    // Search by barcode in the purchase/product search returns that product.
    const search = await api(admin.token).get(`/api/products?search=${encodeURIComponent(variantCode)}`);
    expect(search.body.products.some((p: { _id: string }) => p._id === variant._id)).toBe(true);

    // Edit the code, then remove it.
    const editedCode = `${parentCode}-X`;
    const edit = await api(admin.token).post("/api/products/barcodes", {
      action: "update",
      productId: parent._id,
      oldCode: parentCode,
      code: editedCode,
      label: "Classic (new)",
    });
    expect(edit.status).toBe(200);
    const oldLookup = await api(admin.token).get(`/api/pos/products?barcode=${encodeURIComponent(parentCode)}`);
    expect(oldLookup.body.product).toBeNull();
    const newLookup = await api(admin.token).get(`/api/pos/products?barcode=${encodeURIComponent(editedCode)}`);
    expect(newLookup.body.product?._id).toBe(parent._id);

    const removed = await api(admin.token).post("/api/products/barcodes", {
      action: "remove",
      productId: parent._id,
      code: editedCode,
    });
    expect(removed.status).toBe(200);

    const list = await api(admin.token).get(`/api/products/barcodes?productId=${parent._id}`);
    expect(list.body.barcodes.some((b: { code: string }) => b.code === editedCode)).toBe(false);
  });

  it("generates a unique, scannable EAN-13 for a product without a barcode", async () => {
    const first = await createProduct(admin.token, { barcode: "" });
    const second = await createProduct(admin.token, { barcode: "" });
    cleanupTags.push(first.tag, second.tag);

    const generated = await api(admin.token).post("/api/products/barcodes", {
      action: "generate",
      productId: first._id,
    });
    expect(generated.status).toBe(200);
    const body = generated.body.data.product;
    expect(body.barcode).toHaveLength(13);
    expect(isValidEan13(body.barcode)).toBe(true);

    const again = await api(admin.token).post("/api/products/barcodes", {
      action: "generate",
      productId: second._id,
    });
    const secondCode = again.body.data.product.barcode;
    expect(secondCode).not.toBe(body.barcode);
    expect(isValidEan13(secondCode)).toBe(true);

    // A printed label scans back to exactly this product.
    const lookup = await api(admin.token).get(`/api/pos/products?barcode=${encodeURIComponent(body.barcode)}`);
    expect(lookup.body.product?._id).toBe(first._id);
  });

  it("supports the new-purchase product search by barcode/SKU and receives it", async () => {
    const supplier = await createSupplier(admin.token);
    const product = await createProduct(admin.token, { purchasePrice: 12 });
    cleanupTags.push(supplier.tag, product.tag);

    // Same endpoint the New Purchase picker queries — a USB scanner types the
    // barcode into that field and Enter resolves it to exactly one product.
    const byBarcode = await api(admin.token).get(
      `/api/products?search=${encodeURIComponent(product.barcode)}&perPage=8`
    );
    expect(byBarcode.status).toBe(200);
    expect(byBarcode.body.products).toHaveLength(1);
    const hit = byBarcode.body.products[0];
    expect(hit._id).toBe(product._id);
    expect(hit.sku).toBe(product.sku);
    expect(Number(hit.costPrice)).toBe(12); // pre-fills the unit-cost field

    const bySku = await api(admin.token).get(
      `/api/products?search=${encodeURIComponent(product.sku)}&perPage=8`
    );
    expect(bySku.body.products.some((p: { _id: string }) => p._id === product._id)).toBe(true);

    // Receiving keeps the picked identity and the existing stock behaviour.
    const purchase = await receiveStock(admin.token, {
      supplierId: supplier._id,
      productId: hit._id,
      quantity: 4,
      purchasePrice: 12,
      note: tag("pur-pick"),
    });
    expect(purchase._id).toBeTruthy();
    expect(await dbStock(product._id)).toBe(4);
  });

  // ---------------------------------------------------------------------------
  // 4 — Low / out-of-stock filters
  // ---------------------------------------------------------------------------

  it("filters the inventory list by low/out stock together with search and pagination", async () => {
    const shared = tag("flt");
    const out = await createProduct(admin.token, { name: `QA Filter ${shared} Out`, minimumStock: 0 });
    const low = await createProduct(admin.token, { name: `QA Filter ${shared} Low`, minimumStock: 10 });
    const ok = await createProduct(admin.token, { name: `QA Filter ${shared} Ok`, minimumStock: 1 });
    cleanupTags.push(out.tag, low.tag, ok.tag);

    // out: 0 units, low: 5 of min 10, ok: 50 units
    await api(admin.token).post("/api/inventory", { productId: low._id, quantity: 5, movementType: "ADJUSTMENT_IN", reason: "seed" });
    await api(admin.token).post("/api/inventory", { productId: ok._id, quantity: 50, movementType: "ADJUSTMENT_IN", reason: "seed" });

    const outList = await api(admin.token).get(`/api/inventory?stockStatus=out&product=${shared}`);
    expect(outList.body.products.map((p: { _id: string }) => p._id)).toEqual([out._id]);
    expect(outList.body.products[0].currentStock).toBe(0);

    const lowList = await api(admin.token).get(`/api/inventory?stockStatus=low&product=${shared}`);
    expect(lowList.body.products.map((p: { _id: string }) => p._id)).toEqual([low._id]);

    // Pagination works with the filter scope intact
    const page1 = await api(admin.token).get(`/api/inventory?product=${shared}&productPerPage=1&productPage=1`);
    const page2 = await api(admin.token).get(`/api/inventory?product=${shared}&productPerPage=1&productPage=2`);
    expect(page1.body.productTotal).toBe(3);
    expect(page1.body.products).toHaveLength(1);
    expect(page2.body.products[0]._id).not.toBe(page1.body.products[0]._id);

    // Searching by barcode keeps working with the status filter
    const byBarcode = await api(admin.token).get(
      `/api/inventory?stockStatus=low&product=${encodeURIComponent(low.barcode)}`
    );
    expect(byBarcode.body.products.some((p: { _id: string }) => p._id === low._id)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 3 — Direct products in POS
  // ---------------------------------------------------------------------------

  it("records direct-sale items without touching stock and prices them server-side", async () => {
    const product = await createProduct(admin.token, { sellingPrice: 20 });
    cleanupTags.push(product.tag);
    await api(admin.token).post("/api/inventory", {
      productId: product._id,
      quantity: 5,
      movementType: "ADJUSTMENT_IN",
      reason: "seed",
    });
    expect(await dbStock(product._id)).toBe(5);

    const sale = await api(admin.token).post("/api/sales", {
      items: [{ productId: product._id, quantity: 1 }],
      directItems: [
        { description: "Market grapes", quantity: 2, unitPrice: 15, unitCost: 10, taxRate: 0 },
      ],
      payments: [{ method: "card", amount: 50 }],
    });
    expect(sale.status).toBe(201);
    expect(sale.body.data.total).toBe(50);

    // Only the stock-managed line moved inventory.
    expect(await dbStock(product._id)).toBe(4);

    const detail = await api(admin.token).get(`/api/sales/${sale.body.data.id}`);
    expect(detail.status).toBe(200);
    const directItem = detail.body.sale.items.find((i: { itemType: string }) => i.itemType === "direct");
    expect(directItem).toBeTruthy();
    expect(directItem.productId).toBeNull();
    expect(directItem.name).toBe("Market grapes");
    expect(directItem.sku).toBe("DIRECT");
    expect(directItem.costPrice).toBe(10); // available to profit-report viewers
    expect(detail.body.sale.items.find((i: { itemType: string }) => i.itemType === "inventory")).toBeTruthy();
  });

  it("rejects invalid direct-sale prices and allows a direct-only sale", async () => {
    const zero = await api(admin.token).post("/api/sales", {
      items: [],
      directItems: [{ description: "Free sample", quantity: 1, unitPrice: 0 }],
      payments: [{ method: "card", amount: 1 }],
    });
    expect(zero.status).toBe(400);

    const directOnly = await api(admin.token).post("/api/sales", {
      directItems: [{ description: "Market oranges", quantity: 1, unitPrice: 8, unitCost: 5 }],
      payments: [{ method: "card", amount: 8 }],
    });
    expect(directOnly.status).toBe(201);
    expect(directOnly.body.data.total).toBe(8);
  });

  // ---------------------------------------------------------------------------
  // 8 — Online store categories from MongoDB
  // ---------------------------------------------------------------------------

  it("builds storefront categories from the category collection (active only, no duplicates)", async () => {
    const category = await createCategory(admin.token);
    cleanupTags.push(category.name.replace("QA Category ", ""));
    const name = `QA Store Item ${tag("store")}`;
    storeProductNames.push(name);

    const created = await api(admin.token).post("/api/store/admin", {
      name,
      description: "QA storefront item",
      price: 12,
      categoryId: category._id,
      stock: 3,
      status: "active",
      accent: "emerald",
      featured: false,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.product.category).toBe(category.name);
    expect(String(created.body.data.product.categoryId)).toBe(category._id);

    const publicList = await api().get("/api/store/products");
    expect(publicList.status).toBe(200);
    const navEntry = publicList.body.categories.find(
      (c: { key: string }) => c.key === `category:${category._id}`
    );
    expect(navEntry).toBeTruthy();
    expect(navEntry.name).toBe(category.name);
    expect(navEntry.slug).toBeTruthy();
    const productRow = publicList.body.products.find((p: { name: string }) => p.name === name);
    expect(productRow.categoryKey).toBe(`category:${category._id}`);

    // Only one nav entry for that category even with the product listed.
    expect(
      publicList.body.categories.filter((c: { name: string }) => c.name === category.name)
    ).toHaveLength(1);

    // Deactivating the category removes it from the storefront navigation.
    const deactivated = await api(admin.token).put("/api/categories", {
      id: category._id,
      name: category.name,
      status: "inactive",
    });
    expect(deactivated.status).toBe(200);

    const afterDeactivate = await api().get("/api/store/products");
    expect(
      afterDeactivate.body.categories.some((c: { key: string }) => c.key === `category:${category._id}`)
    ).toBe(false);
  });
  },
  // First run compiles each API route through the dev server, which is slow on
  // Windows; give these end-to-end flows room without weakening assertions.
  240_000
);
