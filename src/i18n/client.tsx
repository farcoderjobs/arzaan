"use client";

import { createContext, useContext, type ReactNode } from "react";
import { LOCALE_COOKIE, LOCALE_META, DEFAULT_LOCALE, type Locale } from "./config";
import { dictionaries, type Dictionary } from "./dictionaries";

type I18nValue = {
  locale: Locale;
  dir: "ltr" | "rtl";
  t: Dictionary;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  locale,
  dict,
  children,
}: {
  locale: Locale;
  dict: Dictionary;
  children: ReactNode;
}) {
  const value: I18nValue = { locale, dir: LOCALE_META[locale].dir, t: dict };
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Safe fallback so components render even outside the provider (e.g. tests).
    return { locale: DEFAULT_LOCALE, dir: LOCALE_META[DEFAULT_LOCALE].dir, t: dictionaries[DEFAULT_LOCALE] };
  }
  return ctx;
}

/** Convenience hook returning just the dictionary. */
export function useT(): Dictionary {
  return useI18n().t;
}

/** Client-side: persists the chosen locale in a cookie and reloads so the server re-renders with the new dir/lang. */
export function setLocaleCookie(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}
