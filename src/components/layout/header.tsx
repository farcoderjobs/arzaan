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

  return (
    <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-4 lg:px-6">
      <div className="flex items-center gap-3">
        <button className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden">
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <span className="hidden sm:inline">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <ConnectionIndicator />
        <LanguageSwitcher />

        <button className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100">
          <Bell className="h-5 w-5" />
          <span className="absolute end-1.5 top-1.5 h-2 w-2 rounded-full bg-blue-600" />
        </button>

        <div className="relative">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-blue-700 text-sm font-semibold">
              {user.name.charAt(0).toUpperCase()}
            </div>
            <span className="hidden sm:inline">{user.name}</span>
            <svg className="h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute end-0 top-full z-20 mt-2 w-48 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                <div className="px-4 py-2">
                  <p className="text-sm font-medium text-slate-900">{user.name}</p>
                  <p className="text-xs text-slate-500">{user.email}</p>
                </div>
                <hr className="my-1 border-slate-200" />
                <button
                onClick={() => {
                  setMenuOpen(false);
                  // Drop cached page shells, then sign out (offline queue is kept).
                  void clearAppShellCache().finally(() => logoutAction());
                }}
                  className="flex w-full items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
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
