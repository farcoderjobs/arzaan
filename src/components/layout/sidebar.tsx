"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SessionUser } from "@/lib/session";
import { PERMISSIONS, PermissionKey } from "@/lib/permissions";
import { useT } from "@/i18n/client";
import type { Dictionary } from "@/i18n/dictionaries";
import { cn } from "@/utils/classname";
import { X } from "@/components/ui/icons";

type PermissionableKey = PermissionKey | "pos" | "finance" | "reports" | "store";

interface NavItem {
  labelKey: keyof Dictionary["nav"];
  href: string;
  icon: string;
  permission?: PermissionableKey | PermissionableKey[] | null;
  badge?: number;
}

const NAV_SECTIONS: Array<{ labelKey: keyof Dictionary["nav"]; items: NavItem[] }> = [
  {
    labelKey: "main",
    items: [
      { labelKey: "dashboard", href: "/dashboard", icon: "📊", permission: "dashboard" },
      { labelKey: "pos", href: "/pos", icon: "🛒", permission: ["products", "sales", "cashRegister"] },
      { labelKey: "products", href: "/products", icon: "📦", permission: "products" },
      { labelKey: "categories", href: "/categories", icon: "🏷️", permission: "categories" },
      { labelKey: "inventory", href: "/inventory", icon: "📋", permission: "inventory" },
    ],
  },
  {
    labelKey: "procurement",
    items: [
      { labelKey: "purchases", href: "/purchases", icon: "📥", permission: "purchases" },
      { labelKey: "customers", href: "/customers", icon: "👥", permission: "customers" },
      { labelKey: "suppliers", href: "/suppliers", icon: "🏭", permission: "suppliers" },
      { labelKey: "sales", href: "/sales", icon: "🧾", permission: "sales" },
      { labelKey: "returns", href: "/returns", icon: "↩️", permission: "sales" },
    ],
  },
  {
    labelKey: "finance",
    items: [
      { labelKey: "cashRegister", href: "/cash-register", icon: "💵", permission: "cashRegister" },
      { labelKey: "finance", href: "/finance", icon: "💳", permission: ["expenses", "cashRegister", "reports"] },
      { labelKey: "reports", href: "/reports", icon: "📈", permission: "reports" },
    ],
  },
  {
    labelKey: "onlineStore",
    items: [
      { labelKey: "storeProducts", href: "/store-products", icon: "🛍️", permission: "store" },
      { labelKey: "storeOrders", href: "/store-orders", icon: "📦", permission: "store" },
    ],
  },
  {
    labelKey: "system",
    items: [
      { labelKey: "users", href: "/users", icon: "🔐", permission: "users" },
      { labelKey: "roles", href: "/roles", icon: "🛡️", permission: "roles" },
      { labelKey: "auditLogs", href: "/audit-logs", icon: "📜", permission: "auditLogs" },
      { labelKey: "syncCenter", href: "/sync", icon: "🔄", permission: "sales" },
      { labelKey: "settings", href: "/settings", icon: "⚙", permission: "settings" },
    ],
  },
];

function hasAnyPermission(user: SessionUser, permission: PermissionableKey | PermissionableKey[] | null | undefined): boolean {
  if (!permission) return true;
  const list = Array.isArray(permission) ? permission : [permission];
  return list.some((p) => {
    if (p === "pos") {
      return user.permissions.some((perm) => perm.startsWith("products.") || perm.startsWith("sales.") || perm.startsWith("cash_register."));
    }
    if (p === "finance") {
      return user.permissions.some((perm) => perm.startsWith("expenses.") || perm.startsWith("cash_register.") || perm.startsWith("reports."));
    }
    if (p === "reports") {
      return user.permissions.some((perm) => perm.startsWith("reports."));
    }
    if (p === "store") {
      return user.permissions.some((perm) => perm.startsWith("store."));
    }
    const values = PERMISSIONS[p];
    if (!values) return false;
    return Object.values(values).some((v) => user.permissions.includes(v));
  });
}

export function Sidebar({ user }: { user: SessionUser }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const t = useT();

  // The hamburger lives in the Header; it opens this drawer via a small DOM event
  // so both components stay independent (the shell can grow without a context).
  useEffect(() => {
    const open = () => setMobileOpen(true);
    window.addEventListener("app:open-sidebar", open);
    return () => window.removeEventListener("app:open-sidebar", open);
  }, []);


  // Lock background scrolling while the drawer is open on phones.
  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [mobileOpen]);

  const visibleSections = NAV_SECTIONS.filter((section) =>
    section.items.some((item) => hasAnyPermission(user, item.permission))
  );

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 start-0 z-50 flex w-[17rem] flex-col border-e border-slate-800/80 bg-slate-900 text-slate-100 shadow-2xl transition-transform duration-300 ease-out lg:w-64 lg:translate-x-0 lg:shadow-none",
          mobileOpen
            ? "translate-x-0"
            : "max-lg:-translate-x-full max-lg:rtl:translate-x-full"
        )}
        aria-label={t.common.appName}
      >
        <div className="flex h-16 items-center gap-3 border-b border-slate-800/80 px-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-base font-black text-white shadow-lg shadow-blue-900/40">
            {t.common.appName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">{t.common.appName}</p>
            <p className="truncate text-[11px] text-slate-400">Retail Edition</p>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white lg:hidden"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {visibleSections.length > 0 ? (
          <nav className="no-scrollbar flex-1 overflow-y-auto px-3 py-4">
            {visibleSections.map((section) => (
              <div key={section.labelKey} className="mb-5 last:mb-2">
                <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                  {t.nav[section.labelKey]}
                </p>
                <ul className="space-y-0.5">
                  {section.items
                    .filter((item) => hasAnyPermission(user, item.permission))
                    .map((item) => {
                      const active = isActive(item.href);
                      return (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            onClick={() => setMobileOpen(false)}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                              "relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors",
                              active
                                ? "bg-blue-500/15 text-white ring-1 ring-inset ring-blue-400/25"
                                : "text-slate-300 hover:bg-white/5 hover:text-white"
                            )}
                          >
                            {active && (
                              <span className="absolute inset-y-2 start-0 w-1 rounded-full bg-blue-400" aria-hidden="true" />
                            )}
                            <span className="text-base leading-none">{item.icon}</span>
                            <span className="min-w-0 flex-1 truncate">{t.nav[item.labelKey]}</span>
                            {item.badge !== undefined && item.badge > 0 && (
                              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-500 px-1.5 text-xs font-semibold text-white">
                                {item.badge}
                              </span>
                            )}
                          </Link>
                        </li>
                      );
                    })}
                </ul>
              </div>
            ))}
          </nav>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-slate-500">
            {t.common.noData}
          </div>
        )}

        <div className="border-t border-slate-800/80 p-3">
          <div className="flex items-center gap-3 rounded-xl px-2 py-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-600 to-slate-700 text-sm font-semibold text-white">
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">{user.name}</p>
              <p className="truncate text-[11px] text-slate-400">{user.email}</p>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
