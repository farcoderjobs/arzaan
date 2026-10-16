import { Metadata } from "next";
import Link from "next/link";
import { requireSessionUser } from "@/lib/session";
import { PageHeader, Breadcrumbs } from "@/components/layout";

export const metadata: Metadata = { title: "Reports" };

const REPORTS = [
  { href: "/reports/sales", label: "Sales", description: "Daily, weekly, monthly and custom-range sales by cashier, customer, payment method and category.", permission: "reports.sales", icon: "🧾" },
  { href: "/reports/products", label: "Products", description: "Quantity sold, revenue, COGS, gross profit, best selling, slow moving and never sold.", permission: "reports.products", icon: "📦" },
  { href: "/reports/inventory", label: "Inventory", description: "Current stock, low stock, out of stock, valuation, movements and adjustments.", permission: "reports.inventory", icon: "📋" },
  { href: "/reports/purchases", label: "Purchases", description: "Totals, by supplier, by product and outstanding supplier balances.", permission: "reports.purchases", icon: "📥" },
  { href: "/reports/customers", label: "Customers", description: "Purchases, payments and outstanding customer balances.", permission: "reports.sales", icon: "👥" },
  { href: "/reports/suppliers", label: "Suppliers", description: "Purchases, payments and outstanding supplier balances.", permission: "reports.purchases", icon: "🏭" },
  { href: "/reports/finance", label: "Finance", description: "Expenses, cash flow, customer receivables and supplier payables.", permission: "reports.finance", icon: "💳" },
  { href: "/reports/profit", label: "Profit", description: "Revenue − COGS = Gross Profit; Gross Profit − Expenses = Net Profit.", permission: "reports.profit", icon: "📈" },
  { href: "/reports/store", label: "Online Store", description: "Storefront orders, revenue, best sellers and order status — separate from POS sales.", permission: "reports.store", icon: "🛍️" },
] as const;

export default async function ReportsPage() {
  const user = await requireSessionUser();
  const available = REPORTS.filter((r) => user.permissions.includes(r.permission));

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Reports" }]} />
      <PageHeader title="Reports" description="Business intelligence across sales, inventory, finance and profit" />

      {available.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          You do not have permission to view any reports.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {available.map((r) => (
            <Link
              key={r.href}
              href={r.href}
              className="group rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-blue-300 hover:shadow"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-xl">{r.icon}</span>
                <div>
                  <p className="font-semibold text-slate-900 group-hover:text-blue-700">{r.label}</p>
                  <p className="text-xs text-slate-400">View report →</p>
                </div>
              </div>
              <p className="mt-3 text-sm text-slate-500">{r.description}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
