/**
 * Multi-barcode products.
 *
 * A product carries one primary `barcode` plus an optional list of extra
 * barcodes. Every barcode can carry an optional flavour/variant label, but all
 * of them belong to the SAME inventory row — barcodes never hold their own
 * stock. These helpers are pure so the POS, the APIs and the tests all resolve
 * a scan the same way.
 */

import { normalizeBarcode } from "@/lib/barcode";

export type BarcodeEntry = { code: string; label?: string };

export type ProductBarcodesLike = {
  barcode?: string | null;
  /** Flavour/variant label of the primary barcode. */
  barcodeLabel?: string | null;
  barcodes?: BarcodeEntry[] | null;
};

export type ResolvedProductBarcode = {
  code: string;
  flavour: string;
  primary: boolean;
};

/**
 * Normalizes and de-duplicates a submitted barcode list.
 *
 * The primary barcode is not allowed to repeat inside the extra list, and no
 * code may appear twice in the payload. A duplicate is returned to the caller
 * so it can reject the request instead of silently dropping a barcode.
 */
export function normalizeBarcodeAssignments(
  primary: string | undefined | null,
  entries: BarcodeEntry[] | undefined | null
): { entries: Array<{ code: string; label: string }>; duplicate: string | null } {
  const seen = new Set<string>();
  const primaryCode = normalizeBarcode(primary ?? "");
  if (primaryCode) seen.add(primaryCode);

  const result: Array<{ code: string; label: string }> = [];
  for (const entry of entries ?? []) {
    const code = normalizeBarcode(entry?.code ?? "");
    if (!code) continue;
    if (seen.has(code)) return { entries: result, duplicate: code };
    seen.add(code);
    result.push({ code, label: (entry?.label ?? "").trim() });
  }
  return { entries: result, duplicate: null };
}

/** Every scannable barcode of a product, primary first, without duplicates. */
export function productBarcodeRows(product: ProductBarcodesLike): ResolvedProductBarcode[] {
  const rows: ResolvedProductBarcode[] = [];
  const primary = normalizeBarcode(product.barcode ?? "");
  if (primary) {
    rows.push({
      code: primary,
      flavour: (product.barcodeLabel ?? "").trim(),
      primary: true,
    });
  }
  for (const entry of product.barcodes ?? []) {
    const code = normalizeBarcode(entry?.code ?? "");
    if (!code || rows.some((row) => row.code === code)) continue;
    rows.push({
      code,
      flavour: (entry?.label ?? "").trim(),
      primary: false,
    });
  }
  return rows;
}

/**
 * Resolves a scanned code to its barcode + flavour on this product.
 * Case/whitespace insensitive; returns null when the code is not registered.
 */
export function resolveScannedBarcode(
  product: ProductBarcodesLike,
  scanned: string
): ResolvedProductBarcode | null {
  const code = normalizeBarcode(scanned);
  if (!code) return null;
  return productBarcodeRows(product).find((row) => row.code === code) ?? null;
}

/**
 * Identity of a POS cart line.
 *
 * Lines of the same product stay separate when they were scanned through
 * different barcodes (different flavours), so flavour reporting stays exact.
 * They still share the product's single stock pool.
 */
export function saleLineKey(productId: string, barcode?: string | null): string {
  const code = normalizeBarcode(barcode ?? "");
  return code ? `${productId}::${code}` : productId;
}
