"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SessionUser } from "@/lib/session";
import { PERMISSIONS, PermissionKey } from "@/lib/permissions";
import { useT } from "@/i18n/client";
import type { Dictionary } from "@/i18n/dictionaries";
import { cn } from "@/utils/classname";
import { Menu, X } from "@/components/ui/icons";

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

  const visibleSections = NAV_SECTIONS.filter((section) =>
    section.items.some((item) => hasAnyPermission(user, item.permission))
  );

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setMobileOpen(false)} />
      )}
      <aside
        className={cn(
          "fixed left-0 top-0 z-50 h-full w-64 border-r border-slate-200 bg-white transition-transform lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white font-bold">P</div>
            <div>
              <p className="font-semibold text-slate-900">{t.common.appName}</p>
              <p className="text-xs text-slate-400">Retail Edition</p>
            </div>
          </div>

          {visibleSections.length > 0 ? (
            <nav className="flex-1 overflow-auto px-3 py-4">
              {visibleSections.map((section) => (
                <div key={section.labelKey} className="mb-4">
                  <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                    {t.nav[section.labelKey]}
                  </p>
                  <ul className="space-y-1">
                    {section.items
                      .filter((item) => hasAnyPermission(user, item.permission))
                      .map((item) => {
                        const active = pathname.startsWith(item.href);
                        return (
                          <li key={item.href}>
                            <Link
                              href={item.href}
                              onClick={() => setMobileOpen(false)}
                              className={cn(
                                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                                active
                                  ? "bg-blue-50 text-blue-700"
                                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                              )}
                            >
                              <span className="text-lg">{item.icon}</span>
                              <span className="flex-1">{t.nav[item.labelKey]}</span>
                              {item.badge !== undefined && item.badge > 0 && (
                                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1.5 text-xs font-semibold text-white">
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
            <div className="flex-1 flex items-center justify-center text-sm text-slate-400">
              {t.common.noData}
            </div>
          )}

          <div className="border-t border-slate-200 p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-600">
                {user.name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">{user.name}</p>
                <p className="truncate text-xs text-slate-400">{user.email}</p>
              </div>
            </div>
          </div>
        </div>
      </aside>

      <button
        className="fixed left-4 top-4 z-50 flex h-10 w-10 items-center justify-center rounded-lg bg-white shadow-md lg:hidden"
        onClick={() => setMobileOpen(true)}
      >
        <Menu className="h-5 w-5 text-slate-600" />
      </button>
    </>
  );
}
