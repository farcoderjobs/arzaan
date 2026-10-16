export const LOCALES = ["en", "fa", "ps"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_META: Record<Locale, { name: string; nativeName: string; dir: "ltr" | "rtl"; flag: string }> = {
  en: { name: "English", nativeName: "English", dir: "ltr", flag: "🇬🇧" },
  // Dari (Afghan Persian)
  fa: { name: "Dari", nativeName: "دری", dir: "rtl", flag: "🇦🇫" },
  // Pashto
  ps: { name: "Pashto", nativeName: "پښتو", dir: "rtl", flag: "🇦🇫" },
};

export const LOCALE_COOKIE = "pos_locale";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Normalizes browser locales like "fa-AF" or "ps-PK" to a supported locale. */
export function resolveLocale(value: string | null | undefined): Locale {
  if (!value) return DEFAULT_LOCALE;
  const base = value.toLowerCase().split("-")[0];
  return isLocale(base) ? base : DEFAULT_LOCALE;
}
