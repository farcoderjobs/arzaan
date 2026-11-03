import { describe, expect, it } from "vitest";
import {
  INTERNAL_EAN13_PREFIX,
  ean13CheckDigit,
  generateEan13,
  isScannableCode,
  isValidEan13,
  normalizeBarcode,
  suggestedBarcodeLabel,
} from "@/lib/barcode";

describe("EAN-13 checksum", () => {
  it("computes the documented check digit", () => {
    expect(ean13CheckDigit("400638133393")).toBe(1);
    expect(isValidEan13("4006381333931")).toBe(true);
  });

  it("rejects invalid checksums, lengths and non-numeric values", () => {
    expect(isValidEan13("4006381333932")).toBe(false);
    expect(isValidEan13("400638133393")).toBe(false);
    expect(isValidEan13("SKU-1234567890")).toBe(false);
  });
});

describe("barcode generation", () => {
  it("generates a valid EAN-13 in the internal prefix range", () => {
    const code = generateEan13();
    expect(code).toHaveLength(13);
    expect(code.startsWith(INTERNAL_EAN13_PREFIX)).toBe(true);
    expect(isValidEan13(code)).toBe(true);
  });

  it("is deterministic with an injected random source", () => {
    const code = generateEan13("200", () => 0.42);
    expect(code).toBe(`200444444444${ean13CheckDigit("200444444444")}`);
    expect(isValidEan13(code)).toBe(true);
  });

  it("produces different codes for different random draws", () => {
    let seed = 7;
    const pseudoRandom = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      codes.add(generateEan13("200", pseudoRandom));
    }
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe("barcode normalization", () => {
  it("trims and upper-cases codes", () => {
    expect(normalizeBarcode("  abc-123 ")).toBe("ABC-123");
  });

  it("accepts printable alphanumeric codes and rejects empty/too-short ones", () => {
    expect(isScannableCode("ABC-1234")).toBe(true);
    expect(isScannableCode("2001234567890")).toBe(true);
    expect(isScannableCode("ab")).toBe(false);
    expect(isScannableCode("   ")).toBe(false);
  });

  it("suggests labels for extra barcodes", () => {
    expect(suggestedBarcodeLabel(0)).toBe("Primary");
    expect(suggestedBarcodeLabel(2)).toBe("Barcode 3");
  });
});
