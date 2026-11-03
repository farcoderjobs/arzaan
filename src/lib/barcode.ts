/**
 * Barcode helpers.
 *
 * New barcodes are generated as EAN-13 in the "200" prefix range, which is
 * reserved for in-store use. Generating one is purely a local labelling
 * convenience: it is NOT a GS1 registration, licence or product authorisation.
 * Codes are rendered/printed as CODE128 so existing alphanumeric SKU-style
 * barcodes stay printable too.
 */

/** In-store prefix for generated codes (GS1 "restricted distribution" range). */
export const INTERNAL_EAN13_PREFIX = "200";

export function normalizeBarcode(code: string): string {
  return code.trim().toUpperCase();
}

/** EAN-13 check digit for the first 12 digits. */
export function ean13CheckDigit(first12: string): number {
  const digits = first12.replace(/\D/g, "");
  if (digits.length !== 12) throw new Error("EAN-13 requires exactly 12 digits");
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = Number(digits[i]);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  const value = code.trim();
  if (!/^\d{13}$/.test(value)) return false;
  return ean13CheckDigit(value.slice(0, 12)) === Number(value[12]);
}

/**
 * Generates an EAN-13 code that passes the checksum.
 * `random` is injectable so tests can produce deterministic codes.
 */
export function generateEan13(
  prefix: string = INTERNAL_EAN13_PREFIX,
  random: () => number = Math.random
): string {
  const cleanPrefix = prefix.replace(/\D/g, "").slice(0, 12) || INTERNAL_EAN13_PREFIX;
  let body = cleanPrefix;
  while (body.length < 12) {
    body += Math.floor(random() * 10) % 10;
  }
  body = body.slice(0, 12);
  return `${body}${ean13CheckDigit(body)}`;
}

/**
 * A code we are willing to store/print: 4–48 characters of letters, digits or
 * hyphens. Barcodes are stored normalized (trimmed, upper-case).
 */
export function isScannableCode(code: string): boolean {
  const value = normalizeBarcode(code);
  return /^[A-Z0-9][A-Z0-9\-_.]{2,47}$/.test(value);
}

/** Suggested human label for a freshly generated code. */
export function suggestedBarcodeLabel(existingCount: number): string {
  return existingCount === 0 ? "Primary" : `Barcode ${existingCount + 1}`;
}
