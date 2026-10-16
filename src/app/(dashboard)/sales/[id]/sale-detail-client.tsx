"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, EmptyState } from "@/components/ui";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { error } from "@/utils/toast";
import { cn } from "@/utils/classname";
import { Printer, RefreshCw } from "@/components/ui/icons";
import { money } from "@/lib/currency";

interface SaleDetailClientProps {
  saleId: string;
  canRefund: boolean;
  canSeeCost: boolean;
}

interface SaleItem {
  productId: string;
  name: string;
  sku: string;
  quantity: number;
  sellingPrice: number;
  discount: number;
  tax: number;
  subtotal: number;
  costPrice?: number;
}

interface SalePayment {
  method: string;
  amount: number;
  reference: string;
}

interface SaleReturnRow {
  _id: string;
  returnNumber: string;
  status: string;
  items: Array<{ productId: string; name: string; sku: string; quantity: number; sellingPrice: number; subtotal: number }>;
  total: number;
  refundMethod: string;
  reason: string;
  userName: string;
  approvedByName: string | null;
  createdAt: string;
}

interface SaleData {
  _id: string;
  invoiceNumber: string;
  createdAt: string;
  status: string;
  items: SaleItem[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  paidAmount: number;
  changeAmount: number;
  payments: SalePayment[];
  paymentMethod: string | null;
  note: string;
  customerId: { _id: string; name: string; phone?: string } | null;
  cashierName: string;
  branchName: string;
  branchAddress: string;
  branchPhone: string;
}

export function SaleDetailClient({ saleId, canRefund, canSeeCost }: SaleDetailClientProps) {
  const [loading, setLoading] = useState(true);
  const [sale, setSale] = useState<SaleData | null>(null);
  const [returns, setReturns] = useState<SaleReturnRow[]>([]);

  const load = useCallback(async () => {

    try {
      const res = await fetch(`/api/sales/${saleId}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setSale(data.sale);
      setReturns(data.returns ?? []);
    } catch {
      error("Error", "Failed to load sale");
    } finally {
      setLoading(false);
    }
  }, [saleId]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const printReceipt = () => window.print();

  const returnedQtyByProduct = (productId: string) =>
    returns
      .filter((r) => r.status === "approved" || r.status === "pending")
      .flatMap((r) => r.items)
      .filter((i) => i.productId === productId)
      .reduce((s, i) => s + i.quantity, 0);

  if (loading && !sale) {
    return <div className="mx-auto max-w-4xl"><div className="h-64 animate-pulse rounded-xl bg-slate-100" /></div>;
  }

  if (!sale) {
    return <div className="mx-auto max-w-4xl"><EmptyState label="Sale not found" /></div>;
  }

  const totalReturned = returns.filter((r) => r.status === "approved").reduce((s, r) => s + r.total, 0);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="no-print">
        <Breadcrumbs items={[{ label: "Sales", href: "/sales" }, { label: sale.invoiceNumber }]} />

        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-mono text-2xl font-semibold text-slate-900">{sale.invoiceNumber}</h1>
            <p className="mt-1 text-sm text-slate-500">
              {new Date(sale.createdAt).toLocaleString()} · Cashier {sale.cashierName}
              {sale.status !== "completed" && (
                <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium capitalize text-amber-700">{sale.status}</span>
              )}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={load} loading={loading}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
            <Button variant="secondary" onClick={printReceipt}><Printer className="mr-2 h-4 w-4" />Print Receipt</Button>
            {canRefund && sale.status === "completed" && (
              <Link href={`/returns/new?sale=${sale._id}`}>
                <Button>Process Return</Button>
              </Link>
            )}
          </div>
        </div>
      </div>

      <div className="no-print grid gap-6 lg:grid-cols-3">
        {/* Items + payments */}
        <div className="space-y-6 lg:col-span-2">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3">Item</th>
                  <th className="px-4 py-3 text-right">Qty</th>
                  <th className="px-4 py-3 text-right">Price</th>
                  <th className="px-4 py-3 text-right">Disc</th>
                  <th className="px-4 py-3 text-right">Tax</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  {canSeeCost && <th className="px-4 py-3 text-right">Cost</th>}
                  <th className="px-4 py-3 text-right">Returned</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sale.items.map((item) => {
                  const returned = returnedQtyByProduct(item.productId);
                  return (
                    <tr key={item.productId}>
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-900">{item.name}</p>
                        <p className="text-xs text-slate-400">{item.sku}</p>
                      </td>
                      <td className="px-4 py-3 text-right">{item.quantity}</td>
                      <td className="px-4 py-3 text-right">{money(item.sellingPrice)}</td>
                      <td className="px-4 py-3 text-right">{item.discount > 0 ? `−${money(item.discount)}` : "—"}</td>
                      <td className="px-4 py-3 text-right">{money(item.tax)}</td>
                      <td className="px-4 py-3 text-right font-medium">{money(item.subtotal)}</td>
                      {canSeeCost && <td className="px-4 py-3 text-right text-slate-400">{money(item.costPrice ?? 0)}</td>}
                      <td className={cn("px-4 py-3 text-right", returned > 0 ? "text-amber-600" : "text-slate-300")}>
                        {returned > 0 ? `${returned}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="border-t border-slate-200 bg-slate-50 px-4 py-3">
              <div className="ml-auto max-w-xs space-y-1 text-sm">
                <div className="flex justify-between text-slate-500"><span>Subtotal</span><span>{money(sale.subtotal)}</span></div>
                <div className="flex justify-between text-slate-500"><span>Sale discount</span><span>−{money(sale.discount)}</span></div>
                <div className="flex justify-between text-slate-500"><span>Tax</span><span>{money(sale.tax)}</span></div>
                <div className="flex justify-between text-base font-bold text-slate-900"><span>Total</span><span>{money(sale.total)}</span></div>
                <div className="flex justify-between text-slate-500"><span>Paid</span><span>{money(sale.paidAmount)}</span></div>
                {sale.changeAmount > 0 && (
                  <div className="flex justify-between font-medium text-green-700"><span>Change given</span><span>{money(sale.changeAmount)}</span></div>
                )}
              </div>
            </div>
          </div>

          {/* Payments */}
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="mb-3 font-semibold text-slate-900">Payments</h2>
            {sale.payments.length === 0 ? (
              <p className="text-sm text-slate-400">No payments recorded.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {sale.payments.map((p, i) => (
                  <li key={i} className="flex items-center justify-between py-2">
                    <span className="capitalize text-slate-700">{p.method}{p.reference ? ` · ${p.reference}` : ""}</span>
                    <span className="font-medium">{money(p.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Return history */}
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold text-slate-900">Return History</h2>
              {totalReturned > 0 && <span className="text-sm text-slate-500">Refunded so far: {money(totalReturned)}</span>}
            </div>
            {returns.length === 0 ? (
              <p className="text-sm text-slate-400">No returns for this sale.</p>
            ) : (
              <ul className="space-y-3">
                {returns.map((r) => (
                  <li key={r._id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-mono text-sm font-medium text-slate-900">{r.returnNumber}</p>
                        <p className="text-xs text-slate-400">
                          {new Date(r.createdAt).toLocaleString()} · by {r.userName}
                          {r.approvedByName ? ` · approved by ${r.approvedByName}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={cn(
                          "rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                          r.status === "approved" ? "bg-green-100 text-green-700" : r.status === "pending" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"
                        )}>
                          {r.status}
                        </span>
                        <span className="text-sm font-semibold text-slate-900">{money(r.total)}</span>
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      Refund method: <span className="capitalize">{r.refundMethod}</span> · Reason: {r.reason || "—"}
                    </p>
                    <ul className="mt-2 text-xs text-slate-600">
                      {r.items.map((i, idx) => (
                        <li key={idx}>{i.quantity} × {i.name} @ {money(i.sellingPrice)}</li>
                      ))}
                    </ul>
                    <Link href={`/returns/${r._id}`} className="mt-2 inline-block text-xs font-medium text-blue-600 hover:underline">
                      View return →
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Side info */}
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
            <h2 className="mb-3 font-semibold text-slate-900">Customer</h2>
            {sale.customerId ? (
              <div>
                <Link href={`/customers/${sale.customerId._id}`} className="font-medium text-blue-600 hover:underline">{sale.customerId.name}</Link>
                {sale.customerId.phone && <p className="mt-1 text-slate-500">{sale.customerId.phone}</p>}
              </div>
            ) : (
              <p className="text-slate-400">Walk-in customer</p>
            )}
          </div>
          {sale.note && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
              <h2 className="mb-2 font-semibold text-slate-900">Note</h2>
              <p className="text-slate-600">{sale.note}</p>
            </div>
          )}
        </div>
      </div>

      {/* ============ PRINTABLE RECEIPT (hidden on screen, shown on print) ============ */}
      <div className="print-only mx-auto max-w-[80mm] bg-white p-4 text-[12px] leading-relaxed text-black">
        <div className="text-center">
          <p className="text-base font-bold uppercase">{sale.branchName || "POS Store"}</p>
          {sale.branchAddress && <p>{sale.branchAddress}</p>}
          {sale.branchPhone && <p>Tel: {sale.branchPhone}</p>}
          <p className="mt-2 font-bold">SALES RECEIPT</p>
        </div>

        <div className="mt-3 border-y border-dashed border-black py-2 text-[11px]">
          <div className="flex justify-between"><span>Invoice:</span><span className="font-mono font-bold">{sale.invoiceNumber}</span></div>
          <div className="flex justify-between"><span>Date:</span><span>{new Date(sale.createdAt).toLocaleString()}</span></div>
          <div className="flex justify-between"><span>Cashier:</span><span>{sale.cashierName}</span></div>
          <div className="flex justify-between"><span>Customer:</span><span>{sale.customerId?.name ?? "Walk-in"}</span></div>
        </div>

        <table className="mt-2 w-full text-[11px]">
          <thead>
            <tr className="border-b border-dashed border-black text-left">
              <th>Item</th>
              <th className="text-right">Qty</th>
              <th className="text-right">Price</th>
              <th className="text-right">Amt</th>
            </tr>
          </thead>
          <tbody>
            {sale.items.map((item) => (
              <tr key={item.productId} className="align-top">
                <td>
                  {item.name}
                  {item.discount > 0 && <span className="block text-[10px]">disc −{money(item.discount)}</span>}
                  {item.tax > 0 && <span className="block text-[10px]">tax {money(item.tax)}</span>}
                </td>
                <td className="text-right">{item.quantity}</td>
                <td className="text-right">{money(item.sellingPrice)}</td>
                <td className="text-right">{money(item.subtotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-2 space-y-0.5 border-t border-dashed border-black pt-2 text-[11px]">
          <div className="flex justify-between"><span>Subtotal</span><span>{money(sale.subtotal)}</span></div>
          {sale.discount > 0 && <div className="flex justify-between"><span>Discount</span><span>−{money(sale.discount)}</span></div>}
          {sale.tax > 0 && <div className="flex justify-between"><span>Tax</span><span>{money(sale.tax)}</span></div>}
          <div className="flex justify-between text-sm font-bold"><span>TOTAL</span><span>{money(sale.total)}</span></div>
          {sale.payments.map((p, i) => (
            <div key={i} className="flex justify-between capitalize"><span>Paid ({p.method})</span><span>{money(p.amount)}</span></div>
          ))}
          {sale.changeAmount > 0 && (
            <div className="flex justify-between font-bold"><span>CHANGE</span><span>{money(sale.changeAmount)}</span></div>
          )}
        </div>

        <p className="mt-3 text-center text-[10px]">Thank you for shopping with us!</p>
        <p className="mt-1 text-center text-[10px]">Returns accepted with receipt within 14 days</p>
      </div>

      {/* Print styles live in globals.css (.print-only / .no-print) */}
    </div>
  );
}
