import { describe, it, expect } from "vitest";
import {
  normalizeBarcodeAssignments,
  productBarcodeRows,
  resolveScannedBarcode,
  saleLineKey,
} from "@/lib/product-barcodes";

/**
 * Multiple barcodes = multiple flavours of ONE product with ONE shared stock
 * pool. These tests pin the pure resolution rules used by the product form,
 * the barcode APIs, POS scanning and sales reporting.
 */

const juice = {
  barcode: "100001",
  barcodeLabel: "Orange",
  barcodes: [
    { code: "100002", label: "Mango" },
    { code: "100003", label: "Apple" },
    { code: "100004", label: "Strawberry" },
  ],
};

describe("multi-barcode products", () => {
  it("normalizes codes and keeps flavour labels", () => {
    const result = normalizeBarcodeAssignments(" 100001 ", [
      { code: " 100002 ", label: " Mango " },
      { code: "abc-9", label: "Apple" },
    ]);
    expect(result.duplicate).toBeNull();
    expect(result.entries).toEqual([
      { code: "100002", label: "Mango" },
      { code: "ABC-9", label: "Apple" },
    ]);
  });

  it("rejects empty and duplicate assignments (including the primary barcode)", () => {
    expect(normalizeBarcodeAssignments("100001", [{ code: "   ", label: "x" }]).entries).toEqual([]);

    const primaryDuplicated = normalizeBarcodeAssignments("100001", [
      { code: "100001", label: "Orange again" },
    ]);
    expect(primaryDuplicated.duplicate).toBe("100001");

    const extraDuplicated = normalizeBarcodeAssignments("100001", [
      { code: "100002", label: "Mango" },
      { code: "100002", label: "Mango duplicate" },
    ]);
    expect(extraDuplicated.duplicate).toBe("100002");
  });

  it("lists every barcode of a product, primary first and without duplicates", () => {
    const rows = productBarcodeRows({
      ...juice,
      barcodes: [...juice.barcodes, { code: "100001", label: "duplicate primary" }, { code: "" }],
    });
    expect(rows.map((row) => row.code)).toEqual(["100001", "100002", "100003", "100004"]);
    expect(rows[0]).toEqual({ code: "100001", flavour: "Orange", primary: true });
    expect(rows[1]).toEqual({ code: "100002", flavour: "Mango", primary: false });
  });

  it("resolves any scanned flavour to the same parent product", () => {
    for (const [code, flavour] of [
      ["100001", "Orange"],
      ["100002", "Mango"],
      [" 100003 ", "Apple"],
      ["100004", "Strawberry"],
    ] as const) {
      const resolved = resolveScannedBarcode(juice, code);
      expect(resolved).toEqual({
        code: code.trim(),
        flavour,
        primary: code.trim() === "100001",
      });
      // The line key always starts with the one product id: stock is shared.
      expect(saleLineKey("juice-product", resolved!.code).startsWith("juice-product::")).toBe(true);
    }
    expect(resolveScannedBarcode(juice, "999999")).toBeNull();
  });

  it("keeps flavours on separate cart lines while mapping to one product", () => {
    const orange = saleLineKey("juice-product", "100001");
    const mango = saleLineKey("juice-product", "100002");
    expect(orange).not.toBe(mango);
    expect(orange.split("::")[0]).toBe(mango.split("::")[0]);
    // Rescanning the same barcode merges into the same line.
    expect(saleLineKey("juice-product", "100001")).toBe(orange);
    // A grid pick without a scan still belongs to the product.
    expect(saleLineKey("juice-product", "")).toBe("juice-product");
  });
});
