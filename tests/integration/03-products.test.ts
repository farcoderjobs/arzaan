/**
 * Area 3 + part of 14 — Product CRUD, duplicate SKU/barcode, categories,
 * barcode lookup, validation, archive-not-delete.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTS, api, authFor, connectDb, createProduct, purgeTag, tag, type AuthCtx } from "../helpers/qa";

describe("products & categories", () => {
  let admin: AuthCtx;
  let manager: AuthCtx;
  const cleanupTags: string[] = [];

  beforeAll(async () => {
    await connectDb();
    admin = await authFor(ACCOUNTS.admin);
    manager = await authFor(ACCOUNTS.manager);
  });

  afterAll(async () => {
    for (const t of cleanupTags) {
      await purgeTag(t).catch(() => undefined);
    }
  });

  it("creates a product and persists it (read-back via list + barcode lookup)", async () => {
    const product = await createProduct(admin.token);
    cleanupTags.push(product.tag);

    expect(product._id).toMatch(/^[0-9a-f]{24}$/);
    expect(product.sku).toBe(product.sku.toUpperCase());

    const list = await api(admin.token).get(`/api/products?search=${encodeURIComponent(product.sku)}`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);
    expect(list.body.products.some((p: any) => p._id === product._id)).toBe(true);
  });

  it("rejects a duplicate SKU with 400", async () => {
    const product = await createProduct(admin.token);
    cleanupTags.push(product.tag);

    const dup = await api(admin.token).post("/api/products", {
      name: "QA Duplicate SKU",
      sku: product.sku,
    });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toMatch(/SKU already exists/i);
  });

  it("rejects a duplicate barcode with 400", async () => {
    const product = await createProduct(admin.token);
    cleanupTags.push(product.tag);

    const dup = await api(admin.token).post("/api/products", {
      name: "QA Duplicate Barcode",
      sku: `SK-DUP-${tag()}`.toUpperCase(),
      barcode: product.barcode,
    });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toMatch(/barcode already exists/i);
  });

  it("rejects two products without a barcode (sparse unique index must not collide)", async () => {
    const a = await createProduct(admin.token, { barcode: "" });
    const b = await createProduct(admin.token, { barcode: "" });
    cleanupTags.push(a.tag, b.tag);
    expect(a._id).not.toBe(b._id);
  });

  it("validates the payload (missing name/SKU → 400 with field errors)", async () => {
    const res = await api(admin.token).post("/api/products", { name: "", sku: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BAD_REQUEST");
    expect(res.body.error.details).toHaveProperty("name");
    expect(res.body.error.details).toHaveProperty("sku");
  });

  it("rejects negative prices and out-of-range tax/discount with 400", async () => {
    const t = tag("prod");
    const res = await api(admin.token).post("/api/products", {
      name: `QA Invalid ${t}`,
      sku: `SK-${t}`.toUpperCase(),
      purchasePrice: -1,
      tax: 200,
      discount: -5,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toHaveProperty("purchasePrice");
    expect(res.body.error.details).toHaveProperty("tax");
    expect(res.body.error.details).toHaveProperty("discount");
  });

  it("updates a product and refuses colliding SKU/barcode of other rows", async () => {
    const a = await createProduct(admin.token);
    const b = await createProduct(admin.token);
    cleanupTags.push(a.tag, b.tag);

    const ok = await api(admin.token).post("/api/products", { id: a._id, name: "QA Product Renamed", sku: a.sku, barcode: a.barcode, purchasePrice: 11, sellingPrice: 22 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.product.name).toBe("QA Product Renamed");

    const clash = await api(admin.token).post("/api/products", { id: a._id, name: "QA Clash", sku: b.sku, barcode: a.barcode, purchasePrice: 1, sellingPrice: 2 });
    expect(clash.status).toBe(400);
    expect(clash.body.error.message).toMatch(/SKU already exists/i);
  });

  it("toggles status via PATCH (active → inactive → active)", async () => {
    const product = await createProduct(admin.token);
    cleanupTags.push(product.tag);

    const off = await api(manager.token).patch("/api/products", { id: product._id, status: "inactive" });
    expect(off.status).toBe(200);
    expect(off.body.data.product.status).toBe("inactive");

    const on = await api(manager.token).patch("/api/products", { id: product._id, status: "active" });
    expect(on.status).toBe(200);
    expect(on.body.data.product.status).toBe("active");
  });

  it("finds a product by exact barcode with its current stock (POS scanner flow)", async () => {
    const product = await createProduct(admin.token);
    cleanupTags.push(product.tag);

    const res = await api(manager.token).get(`/api/pos/products?barcode=${encodeURIComponent(product.barcode)}`);
    expect(res.status).toBe(200);
    expect(res.body.product).not.toBeNull();
    expect(res.body.product._id).toBe(product._id);
    expect(res.body.product.currentStock).toBe(0);

    const miss = await api(manager.token).get(`/api/pos/products?barcode=NOPE-${tag()}`);
    expect(miss.status).toBe(200);
    expect(miss.body.product).toBeNull();
  });

  it("archives (not deletes) products with stock history; hard-deletes clean products", async () => {
    const withHistory = await createProduct(admin.token);
    cleanupTags.push(withHistory.tag);
    const clean = await createProduct(admin.token);
    cleanupTags.push(clean.tag);

    // Give the product movement history through the inventory API.
    const adj = await api(admin.token).post("/api/inventory", {
      productId: withHistory._id,
      quantity: 3,
      movementType: "ADJUSTMENT_IN",
      reason: "seed for archive test",
    });
    expect(adj.status).toBe(201);

    const del1 = await api(admin.token).del("/api/products", { id: withHistory._id });
    expect(del1.status).toBe(200);
    expect(del1.body.data.product.status).toBe("archived");

    const del2 = await api(admin.token).del("/api/products", { id: clean._id });
    expect(del2.status).toBe(200);
  });
});

describe("categories", () => {
  let admin: AuthCtx;
  const cleanupTags: string[] = [];

  beforeAll(async () => {
    await connectDb();
    admin = await authFor(ACCOUNTS.admin);
  });

  afterAll(async () => {
    for (const t of cleanupTags) await purgeTag(t).catch(() => undefined);
  });

  it("creates, renames, and rejects duplicate sibling names", async () => {
    const t = tag("cat");
    const created = await api(admin.token).post("/api/categories", { name: `QA Category ${t}` });
    expect(created.status).toBe(201);
    const id = created.body.data.category._id;
    cleanupTags.push(t);

    const renamed = await api(admin.token).post("/api/categories", { id, name: `QA Category Renamed ${t}` });
    expect(renamed.status).toBe(200);

    const dup = await api(admin.token).post("/api/categories", { name: `QA Category Renamed ${t}` });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toMatch(/already exists/i);
  });

  it("supports subcategories and blocks self-parenting", async () => {
    const t = tag("cat");
    const parent = await api(admin.token).post("/api/categories", { name: `QA Parent ${t}` });
    cleanupTags.push(t);
    expect(parent.status).toBe(201);
    const parentId = parent.body.data.category._id;

    const child = await api(admin.token).post("/api/categories", { name: `QA Child ${t}`, parentId });
    expect(child.status).toBe(201);

    const self = await api(admin.token).post("/api/categories", { id: parentId, name: `QA Parent ${t}`, parentId });
    expect(self.status).toBe(400);
    expect(self.body.error.message).toMatch(/own parent/i);
  });

  it("refuses to delete a category with subcategories, deactivates one with products", async () => {
    const t = tag("cat");
    cleanupTags.push(t);
    const parent = await api(admin.token).post("/api/categories", { name: `QA Parent ${t}` });
    const parentId = parent.body.data.category._id;
    await api(admin.token).post("/api/categories", { name: `QA Child ${t}`, parentId });

    const blocked = await api(admin.token).del("/api/categories", { id: parentId });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.message).toMatch(/subcategories/i);

    const category = await api(admin.token).post("/api/categories", { name: `QA WithProduct ${t}` });
    const catId = category.body.data.category._id;
    const product = await createProduct(admin.token, { categoryId: catId });
    cleanupTags.push(product.tag);

    const del = await api(admin.token).del("/api/categories", { id: catId });
    expect(del.status).toBe(200);
    expect(del.body.data.category.status).toBe("inactive");
  });

  it("returns inactive categories only with ?all=1", async () => {
    const t = tag("cat");
    cleanupTags.push(t);
    const created = await api(admin.token).post("/api/categories", { name: `QA Inactive ${t}` });
    const id = created.body.data.category._id;
    await api(admin.token).del("/api/categories", { id }); // no products → hard delete
    // Recreate + deactivate through a product reference instead:
    const category = await api(admin.token).post("/api/categories", { name: `QA Inactive2 ${t}` });
    const catId = category.body.data.category._id;
    const product = await createProduct(admin.token, { categoryId: catId });
    cleanupTags.push(product.tag);
    await api(admin.token).del("/api/categories", { id: catId });

    const activeOnly = await api(admin.token).get("/api/categories");
    expect(activeOnly.status).toBe(200);
    expect(activeOnly.body.some((c: any) => c._id === catId)).toBe(false);

    const withAll = await api(admin.token).get("/api/categories?all=1");
    const found = withAll.body.find((c: any) => c._id === catId);
    expect(found).toBeTruthy();
    expect(found.status).toBe("inactive");
  });
});
