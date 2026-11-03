"use client";

import { useEffect, useRef } from "react";
import JsBarcode from "jsbarcode";
import { isValidEan13 } from "@/lib/barcode";
import { money } from "@/lib/currency";

/**
 * Renders a scannable barcode with JsBarcode.
 *
 * Numeric EAN-13 values use the EAN13 symbology; everything else (legacy
 * alphanumeric SKU-style barcodes, generated codes, etc.) uses CODE128, which
 * encodes the exact same string the POS lookup searches for — so a printed
 * label scans back to the same product.
 */
export function BarcodeSvg({
  value,
  height = 46,
  width = 1.7,
  displayValue = true,
  fontSize = 11,
  margin = 4,
  className,
}: {
  value: string;
  height?: number;
  width?: number;
  displayValue?: boolean;
  fontSize?: number;
  margin?: number;
  className?: string;
}) {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || !value) return;
    const options = {
      height,
      width,
      displayValue,
      fontSize,
      margin,
      textMargin: 1,
      lineColor: "#000000",
      background: "#ffffff",
    };
    try {
      const format = isValidEan13(value) ? "EAN13" : "CODE128";
      JsBarcode(element, value, { ...options, format });
    } catch {
      // Fall back to CODE128 for values the EAN-13 encoder cannot represent.
      try {
        JsBarcode(element, value, { ...options, format: "CODE128" });
      } catch {
        // Invalid code — leave the SVG empty rather than crashing the page.
      }
    }
  }, [value, height, width, displayValue, fontSize, margin]);

  return <svg ref={ref} className={className} role="img" aria-label={`Barcode ${value}`} />;
}

export const LABEL_SIZES = [
  { value: "38x25", label: "38 × 25 mm", width: "38mm", height: "25mm", barcodeHeight: 30 },
  { value: "50x30", label: "50 × 30 mm", width: "50mm", height: "30mm", barcodeHeight: 36 },
  { value: "70x40", label: "70 × 40 mm", width: "70mm", height: "40mm", barcodeHeight: 48 },
] as const;

export type LabelSize = (typeof LABEL_SIZES)[number]["value"];

export type BarcodeLabelData = {
  productName: string;
  sku: string;
  barcode: string;
  price?: number;
  variantName?: string;
};

/**
 * Print-only sheet of barcode labels. Rendered while the page is on screen but
 * hidden (`.print-only` in globals.css), so `window.print()` produces a clean
 * label layout with no dashboard chrome.
 */
export function BarcodePrintSheet({
  product,
  copies,
  size = "38x25",
  showPrice = true,
  storeName,
}: {
  product: BarcodeLabelData;
  copies: number;
  size?: LabelSize;
  showPrice?: boolean;
  storeName?: string;
}) {
  const dims = LABEL_SIZES.find((s) => s.value === size) ?? LABEL_SIZES[0];
  const count = Math.max(1, Math.min(200, Math.floor(copies)));

  return (
    <div className="print-only barcode-print-sheet">
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "2mm",
          alignItems: "flex-start",
        }}
      >
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            style={{
              width: dims.width,
              minHeight: dims.height,
              border: "0.2mm dashed #94a3b8",
              borderRadius: "1mm",
              padding: "1mm",
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              pageBreakInside: "avoid",
              breakInside: "avoid",
            }}
          >
            <p style={{ fontSize: "7pt", fontWeight: 700, lineHeight: 1.1, textAlign: "center", margin: 0 }}>
              {storeName || "POS Store"}
            </p>
            <p style={{ fontSize: "7pt", lineHeight: 1.15, textAlign: "center", margin: 0 }}>
              {product.productName}
              {product.variantName ? ` · ${product.variantName}` : ""}
            </p>
            <BarcodeSvg
              value={product.barcode}
              height={dims.barcodeHeight}
              width={1.3}
              fontSize={8}
              margin={1}
            />
            <p style={{ fontSize: "7pt", lineHeight: 1.1, margin: 0 }}>
              {product.sku ? `SKU ${product.sku}` : ""}
              {showPrice && typeof product.price === "number" ? ` · ${money(product.price)}` : ""}
            </p>
          </div>
        ))}
      </div>
      {!product.barcode && (
        <p style={{ marginTop: "4mm", fontSize: "9pt" }}>
          No barcode assigned — generate one from the Products screen before printing.
        </p>
      )}
    </div>
  );
}
