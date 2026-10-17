"use client";

import { useState } from "react";
import { SessionUser } from "@/lib/session";
import { logoutAction } from "@/app/actions/auth";
import { Menu, Bell, LogOut } from "@/components/ui/icons";
import { LanguageSwitcher } from "@/components/ui/language-switcher";
import { ConnectionIndicator } from "@/components/layout/connection-indicator";
import { clearAppShellCache } from "@/components/sw-register";
import { useT } from "@/i18n/client";
import { cn } from "@/utils/classname";

interface HeaderProps {
  user: SessionUser;
}

export function Header({ user }: HeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const t = useT();
  const today = new Date();

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center justify-between gap-2 border-b border-slate-200/80 bg-white/85 px-3 backdrop-blur-xl sm:gap-3 sm:px-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event("app:open-sidebar"))}
          className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 active:scale-95 lg:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900 sm:hidden">{t.common.appName}</p>
          <p className="hidden truncate text-sm text-slate-500 sm:block">
            {today.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 sm:gap-1.5">
        <ConnectionIndicator />
        <LanguageSwitcher />

        <button
          type="button"
          className="relative flex h-10 w-10 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
          aria-label="Notifications"
        >
          <Bell className="h-5 w-5" />
          <span className="absolute end-2.5 top-2.5 h-2 w-2 rounded-full bg-blue-600 ring-2 ring-white" />
        </button>

        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            className="flex items-center gap-2 rounded-xl px-1.5 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 sm:px-2.5"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-sm font-semibold text-white shadow-sm">
              {user.name.charAt(0).toUpperCase()}
            </div>
            <span className="hidden max-w-[10rem] truncate sm:inline">{user.name}</span>
            <svg className={cn("hidden h-4 w-4 text-slate-400 transition-transform sm:block", menuOpen && "rotate-180")} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} aria-hidden="true" />
              <div className="absolute end-0 top-full z-20 mt-2 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-xl shadow-slate-900/10">
                <div className="px-4 py-2.5">
                  <p className="truncate text-sm font-medium text-slate-900">{user.name}</p>
                  <p className="truncate text-xs text-slate-500">{user.email}</p>
                </div>
                <hr className="my-1 border-slate-200" />
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    // Drop cached page shells, then sign out (offline queue is kept).
                    void clearAppShellCache().finally(() => logoutAction());
                  }}
                  className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-slate-700 transition hover:bg-slate-100"
                >
                  <LogOut className="h-4 w-4" />
                  {t.auth.signOut}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
