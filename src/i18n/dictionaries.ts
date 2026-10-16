import type { Locale } from "./config";
import en from "./locales/en";
import fa from "./locales/fa";
import ps from "./locales/ps";
import type { Dictionary } from "./locales/en";

export type { Dictionary };

export const dictionaries: Record<Locale, Dictionary> = { en, fa, ps };

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale] ?? en;
}
