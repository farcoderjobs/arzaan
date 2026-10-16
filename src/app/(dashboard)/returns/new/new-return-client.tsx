"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, FormField, Input, Select, Textarea, EmptyState } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { success, error, warning } from "@/utils/toast";
import { cn } from "@/utils/classname";
import { money } from "@/lib/currency";
import { Search } from "@/components/ui/icons";

interface SaleItem {
  productId: string;
  name: string;
  sku: string;
  quantity: number;
  sellingPrice: number;
  subtotal: number;
}

interface SaleData {
  _id: string;
  invoiceNumber: string;
  createdAt: string;
  customerName: string | null;
  items: SaleItem[];
  total: number;
}

interface ExistingReturn {
  _id: string;
  returnNumber: string;
  status: string;
  items: Array<{ productId: string; quantity: number }>;
}

/**
 * Common refund reasons, prefilled so the cashier picks instead of typing.
 * "other" reveals a free-text box for anything not covered.
 */
const REFUND_REASONS = [
  { value: "customer_returned", label: "Customer returned it — changed their mind" },
  { value: "customer_returned_wrong", label: "Customer returned it — wrong item, size or color" },
  { value: "defective", label: "Defective or damaged product" },
  { value: "not_as_described", label: "Not as described" },
  { value: "expired", label: "Expired or near expiry" },
  { value: "duplicate", label: "Duplicate purchase" },
  { value: "other", label: "Other reason…" },
];

const OTHER_REASON = "other";

export function NewReturnClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const presetSaleId = searchParams.get("sale") ?? "";

  const [invoiceSearch, setInvoiceSearch] = useState("");
  const [sale, setSale] = useState<SaleData | null>(null);
  const [existingReturns, setExistingReturns] = useState<ExistingReturn[]>([]);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [refundMethod, setRefundMethod] = useState<"cash" | "original" | "credit">("cash");
  // Reason is prefilled with the most common case (customer returned it).
  const [reasonChoice, setReasonChoice] = useState(REFUND_REASONS[0].value);
  const [customReason, setCustomReason] = useState("");
  const [note, setNote] = useState("");
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loadSale = async (saleId: string) => {
    setSearching(true);
    try {
      const res = await fetch(`/api/sales/${saleId}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setSale({
        _id: data.sale._id,
        invoiceNumber: data.sale.invoiceNumber,
        createdAt: data.sale.createdAt,
        customerName: data.sale.customerId?.name ?? null,
        items: data.sale.items,
        total: data.sale.total,
      });
      setExistingReturns(data.returns ?? []);
    } catch {
      error("Error", "Failed to load sale");
    } finally {
      setSearching(false);
    }
  };

  const findSale = async (query: string) => {
      if (!query.trim()) return;
      setSearching(true);
      setSale(null);
      setQuantities({});
      try {
        // Search sales list by invoice number
        const res = await fetch(`/api/sales?search=${encodeURIComponent(query.trim())}&perPage=5`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        const matches = (data.sales ?? []) as Array<{ _id: string; invoiceNumber: string }>;
        if (matches.length === 0) {
          warning("Not found", `No completed sale matches "${query}"`);
          return;
        }
        await loadSale(matches[0]._id);
      } catch {
        error("Error", "Failed to search sales");
      } finally {
        setSearching(false);
      }
  };

  useEffect(() => {
    if (!presetSaleId) return;
    void (async () => {
      await loadSale(presetSaleId);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetSaleId]);

  const returnedByProduct = (productId: string) =>
    existingReturns
      .filter((r) => r.status === "approved" || r.status === "pending")
      .flatMap((r) => r.items)
      .filter((i) => i.productId === productId)
      .reduce((s, i) => s + i.quantity, 0);

  const returnable = (item: SaleItem) => Math.max(0, item.quantity - returnedByProduct(item.productId));

  const refundTotal = (sale?.items ?? []).reduce((sum, item) => {
    const qty = quantities[item.productId] ?? 0;
    if (qty <= 0 || !item.quantity) return sum;
    return sum + (item.subtotal * qty) / item.quantity;
  }, 0);

  const submit = async () => {
    if (!sale) return;
    const items = Object.entries(quantities)
      .filter(([, qty]) => qty > 0)
      .map(([productId, qty]) => ({ productId, quantity: qty }));
    if (items.length === 0) {
      warning("Nothing selected", "Set a return quantity for at least one item");
      return;
    }
    const reason =
      reasonChoice === OTHER_REASON
        ? customReason.trim()
        : REFUND_REASONS.find((r) => r.value === reasonChoice)?.label ?? reasonChoice;
    if (!reason) {
      warning("Reason required", "Enter the return reason");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/sales-returns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },          body: JSON.stringify({
          saleId: sale._id,
          items,
          refundMethod,
          reason,
          note: note.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Return failed", data?.error?.message ?? "Server rejected the return");
        return;
      }
      success(data.message ?? "Return processed", `Reference ${data.data.returnNumber} — ${money(data.data.total)}`);
      router.push(`/returns/${data.data.id}`);
    } catch {
      error("Error", "Failed to submit return");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl">
      <Breadcrumbs items={[{ label: "Returns", href: "/returns" }, { label: "New Return" }]} />
      <PageHeader title="New Return" description="Find the original sale, select items and quantities to return" />

      {/* Find sale */}
      {!sale && (
        <div className="rounded-xl border border-slate-200 bg-white p-6">
          <FormField label="Invoice number" hint="Enter the invoice number from the original sale">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  value={invoiceSearch}
                  onChange={(e) => setInvoiceSearch(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && findSale(invoiceSearch)}
                  placeholder="e.g. INV-202609-000001"
                  className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
              </div>
              <Button onClick={() => findSale(invoiceSearch)} loading={searching}>Find Sale</Button>
            </div>
          </FormField>
        </div>
      )}

      {sale && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4">
            <div>
              <p className="font-mono text-lg font-semibold text-slate-900">{sale.invoiceNumber}</p>
              <p className="text-sm text-slate-500">
                {new Date(sale.createdAt).toLocaleDateString()} · {sale.customerName ?? "Walk-in"} · Total {money(sale.total)}
              </p>
            </div>
            <Button variant="secondary" onClick={() => { setSale(null); setExistingReturns([]); }}>Change sale</Button>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3">Item</th>
                  <th className="px-4 py-3 text-right">Sold</th>
                  <th className="px-4 py-3 text-right">Already returned</th>
                  <th className="px-4 py-3 text-right">Return qty</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sale.items.map((item) => {
                  const max = returnable(item);
                  return (
                    <tr key={item.productId}>
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-900">{item.name}</p>
                        <p className="text-xs text-slate-400">{item.sku} · {money(item.sellingPrice)}</p>
                      </td>
                      <td className="px-4 py-3 text-right">{item.quantity}</td>
                      <td className={cn("px-4 py-3 text-right", returnedByProduct(item.productId) > 0 ? "text-amber-600" : "text-slate-400")}>
                        {returnedByProduct(item.productId)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {max === 0 ? (
                          <span className="text-xs text-slate-400">Fully returned</span>
                        ) : (
                          <input
                            type="number"
                            min={0}
                            max={max}
                            value={quantities[item.productId] ?? ""}
                            onChange={(e) => {
                              const v = Math.min(Math.max(0, Number(e.target.value) || 0), max);
                              setQuantities((prev) => ({ ...prev, [item.productId]: v }));
                            }}
                            className="w-20 rounded border border-slate-300 px-2 py-1.5 text-right focus:border-blue-500 focus:outline-none"
                            placeholder={`0–${max}`}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Refund method">
              <Select
                value={refundMethod}
                onChange={(v) => setRefundMethod(v as "cash" | "original" | "credit")}
                options={[
                  { value: "cash", label: "Cash refund" },
                  { value: "original", label: "Original payment method" },
                  { value: "credit", label: "Customer store credit" },
                ]}
              />
            </FormField>
            <FormField label="Refund amount (calculated)" hint="Based on what the customer originally paid per unit">
              <Input value={money(refundTotal)} readOnly className="bg-slate-50 font-semibold" />
            </FormField>
          </div>

          <FormField label="Reason" required hint="Pick the reason — pre-filled with the most common cases">
            <div className="space-y-2">
              <Select
                value={reasonChoice}
                onChange={setReasonChoice}
                options={REFUND_REASONS}
              />
              {reasonChoice === OTHER_REASON && (
                <Input
                  value={customReason}
                  onChange={(e) => setCustomReason(e.target.value)}
                  placeholder="Describe the reason"
                  autoFocus
                />
              )}
            </div>
          </FormField>
          <FormField label="Additional note">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional details" rows={2} />
          </FormField>

          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => router.back()}>Cancel</Button>
            <Button onClick={submit} loading={submitting}>
              Process Return — {money(refundTotal)}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
