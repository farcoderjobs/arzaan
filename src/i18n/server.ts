import { cookies } from "next/headers";
import { LOCALE_COOKIE, DEFAULT_LOCALE, isLocale, type Locale } from "./config";

/** Server-side: reads the locale cookie (set by the language switcher). */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const value = store.get(LOCALE_COOKIE)?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
