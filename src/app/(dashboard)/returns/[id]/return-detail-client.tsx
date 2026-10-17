"use client";

import { useCallback, useEffect, useState } from "react";
import { money } from "@/lib/currency";
import Link from "next/link";
import { Button, EmptyState } from "@/components/ui";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { success, error } from "@/utils/toast";
import { cn } from "@/utils/classname";

interface ReturnDetailClientProps {
  returnId: string;
  canRefund: boolean;
  canViewSales: boolean;
}

interface ReturnData {
  _id: string;
  returnNumber: string;
  saleId: string | null;
  saleInvoiceNumber: string;
  status: string;
  items: Array<{ productId: string; name: string; sku: string; quantity: number; sellingPrice: number; subtotal: number }>;
  total: number;
  refundMethod: string;
  reason: string;
  note: string;
  userName: string;
  approvedByName: string | null;
  createdAt: string;
  customerId: { _id: string | null; name: string } | null;
}

export function ReturnDetailClient({ returnId, canRefund, canViewSales }: ReturnDetailClientProps) {
  const [loading, setLoading] = useState(true);
  const [ret, setRet] = useState<ReturnData | null>(null);
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {

    try {
      const res = await fetch(`/api/sales-returns/${returnId}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setRet(data.return);
    } catch {
      error("Error", "Failed to load return");
    } finally {
      setLoading(false);
    }
  }, [returnId]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const act = async (action: "approve" | "reject") => {
    setActing(true);
    try {
      const res = await fetch("/api/sales-returns", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: returnId, action }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", data?.error?.message ?? "Action failed");
        return;
      }
      success("Success", action === "approve" ? "Return approved" : "Return rejected");
      load();
    } catch {
      error("Error", "Action failed");
    } finally {
      setActing(false);
    }
  };

  if (loading && !ret) {
    return <div className="mx-auto max-w-4xl"><div className="h-48 animate-pulse rounded-xl bg-slate-100" /></div>;
  }

  if (!ret) {
    return <div className="mx-auto max-w-4xl"><EmptyState label="Return not found" /></div>;
  }

  return (
    <div className="mx-auto max-w-4xl">
      <Breadcrumbs items={[{ label: "Returns", href: "/returns" }, { label: ret.returnNumber }]} />

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-2xl font-semibold text-slate-900">{ret.returnNumber}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {new Date(ret.createdAt).toLocaleString()} · by {ret.userName}
          </p>
        </div>
        <span className={cn(
          "rounded-full px-3 py-1 text-sm font-medium capitalize",
          ret.status === "approved" ? "bg-green-100 text-green-700" : ret.status === "pending" ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-600"
        )}>
          {ret.status}
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full min-w-[440px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3">Item</th>
                  <th className="px-4 py-3 text-right">Qty</th>
                  <th className="px-4 py-3 text-right">Price</th>
                  <th className="px-4 py-3 text-right">Refund</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {ret.items.map((i) => (
                  <tr key={i.productId}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{i.name}</p>
                      <p className="text-xs text-slate-400">{i.sku}</p>
                    </td>
                    <td className="px-4 py-3 text-right">{i.quantity}</td>
                    <td className="px-4 py-3 text-right">{money(i.sellingPrice)}</td>
                    <td className="px-4 py-3 text-right font-medium">{money(i.subtotal)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-200 bg-slate-50">
                  <td colSpan={3} className="px-4 py-3 text-right font-semibold text-slate-700">Total refund</td>
                  <td className="px-4 py-3 text-right text-base font-bold text-slate-900">{money(ret.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {ret.status === "pending" && canRefund && (
            <div className="flex justify-end gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <Button variant="danger" loading={acting} onClick={() => act("reject")}>Reject</Button>
              <Button loading={acting} onClick={() => act("approve")}>Approve & Restock & Refund</Button>
            </div>
          )}
        </div>

        <div className="space-y-6 text-sm">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="mb-3 font-semibold text-slate-900">Details</h2>
            <dl className="space-y-2">
              <div className="flex justify-between">
                <dt className="text-slate-500">Original sale</dt>
                <dd>
                  {ret.saleId && canViewSales ? (
                    <Link href={`/sales/${ret.saleId}`} className="font-mono text-blue-600 hover:underline">{ret.saleInvoiceNumber}</Link>
                  ) : (
                    <span className="font-mono">{ret.saleInvoiceNumber}</span>
                  )}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Customer</dt>
                <dd>{ret.customerId?.name ?? "Walk-in"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Refund method</dt>
                <dd className="capitalize">{ret.refundMethod.replace("_", " ")}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Approved by</dt>
                <dd>{ret.approvedByName ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Reason</dt>
                <dd className="mt-0.5">{ret.reason || "—"}</dd>
              </div>
              {ret.note && (
                <div>
                  <dt className="text-slate-500">Note</dt>
                  <dd className="mt-0.5">{ret.note}</dd>
                </div>
              )}
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
