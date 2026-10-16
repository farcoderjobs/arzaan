/**
 * Shared money formatting for the whole UI.
 *
 * The store operates in Afghan Afghani (AFN), so AFN is the default and the
 * symbol renders as the Afghani sign (؋). The code can be overridden at
 * runtime (e.g. from store settings) via setCurrency() — every formatter in
 * the app goes through here, so prices never fall back to a hard-coded "$".
 */

const SYMBOLS: Record<string, string> = {
  AFN: "؋", // ؋ Afghani
  USD: "$",
  EUR: "€",
  GBP: "£",
  PKR: "₨",
  INR: "₹",
};

let currentCurrency = "AFN";

/** Sets the active currency code (3 letters, case-insensitive). */
export function setCurrency(code: string | null | undefined): void {
  if (code && /^[A-Za-z]{3}$/.test(code)) {
    currentCurrency = code.toUpperCase();
  }
}

export function getCurrency(): string {
  return currentCurrency;
}

/** Symbol (or code prefix) for a currency, defaulting to the active one. */
export function currencySymbol(code: string = currentCurrency): string {
  const upper = (code || currentCurrency).toUpperCase();
  return SYMBOLS[upper] ?? `${upper} `;
}

/** Formats a number as money, e.g. 1234.5 → "؋1,234.50". */
export function money(n: number): string {
  const value = Number(n ?? 0);
  const amount = value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const symbol = currencySymbol();
  return symbol.endsWith(" ") ? `${symbol}${amount}` : `${symbol}${amount}`;
}

export const formatMoney = money;
