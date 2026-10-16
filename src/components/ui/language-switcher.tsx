"use client";

import { useState } from "react";
import { LOCALES, LOCALE_META, type Locale } from "@/i18n/config";
import { useI18n, setLocaleCookie } from "@/i18n/client";

export function LanguageSwitcher() {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);

  const choose = (next: Locale) => {
    setOpen(false);
    if (next === locale) return;
    setLocaleCookie(next);
    // Full reload so server components (html lang/dir, server-rendered text) update too.
    window.location.reload();
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-label={t.common.language}
        title={t.common.language}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
      >
        <svg className="h-[18px] w-[18px] text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 4.62 10.669 4.5 9.5 4.5c1.618 0 3.09.424 4.34 1.154m-.864 12.727A18.02 18.02 0 0113 21" />
        </svg>
        <span className="hidden sm:inline">{LOCALE_META[locale].nativeName}</span>
        <svg className="h-3 w-3 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute end-0 top-full z-20 mt-2 w-44 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
            {LOCALES.map((l) => (
              <button
                key={l}
                onClick={() => choose(l)}
                className={`flex w-full items-center justify-between px-4 py-2 text-sm hover:bg-slate-100 ${
                  l === locale ? "font-semibold text-blue-700" : "text-slate-700"
                }`}
                dir={LOCALE_META[l].dir}
              >
                <span>{LOCALE_META[l].nativeName}</span>
                <span className="text-xs text-slate-400">{LOCALE_META[l].name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
