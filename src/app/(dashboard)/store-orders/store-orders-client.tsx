"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Select, Modal, Pagination, SearchInput, Table, EmptyState, PageHeader } from "@/components/ui";
import { money } from "@/lib/currency";
import { success, error as toastError } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/utils/classname";

interface OrderItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
}

interface StoreOrderRow {
  id: string;
  orderNumber: string;
  customerName: string;
  phone: string;
  email: string;
  address: string;
  note: string;
  items: OrderItem[];
  subtotal: number;
  total: number;
  status: "pending" | "confirmed" | "shipped" | "delivered" | "canceled";
  createdAt: string;
}

const STATUS_META: Record<string, { label: string; chip: string; next: Array<{ value: string; label: string }> }> = {
  pending: {
    label: "Pending",
    chip: "bg-amber-100 text-amber-700",
    next: [
      { value: "confirmed", label: "Confirm order" },
      { value: "canceled", label: "Cancel order" },
    ],
  },
  confirmed: {
    label: "Confirmed",
    chip: "bg-blue-100 text-blue-700",
    next: [
      { value: "shipped", label: "Mark shipped" },
      { value: "canceled", label: "Cancel order" },
    ],
  },
  shipped: {
    label: "Shipped",
    chip: "bg-violet-100 text-violet-700",
    next: [{ value: "delivered", label: "Mark delivered" }],
  },
  delivered: { label: "Delivered", chip: "bg-emerald-100 text-emerald-700", next: [] },
  canceled: { label: "Canceled", chip: "bg-slate-100 text-slate-500", next: [] },
};

export function StoreOrdersClient() {
  const [rows, setRows] = useState<StoreOrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [detail, setDetail] = useState<StoreOrderRow | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);

  const perPage = 15;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
      if (search) params.set("search", search);
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/store/orders/admin?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setRows(data.orders ?? []);
      setTotal(data.total ?? 0);
      setTotalPages(data.totalPages ?? 1);
    } catch {
      toastError("Error", "Failed to load store orders");
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const updateStatus = async (order: StoreOrderRow, status: string) => {
    setActionId(order.id);
    try {
      const res = await fetch("/api/store/orders/admin", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: order.id, status }),
      });
      const data = await res.json();
      if (!res.ok) {
        toastError("Update failed", apiErrorMessage(data, "Could not update the order"));
        return;
      }
      success("Order updated", `${order.orderNumber} → ${status}`);
      setDetail(null);
      void load();
    } catch {
      toastError("Error", "Could not update the order");
    } finally {
      setActionId(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Store Orders"
        description="Orders placed on the public online store. Customers pay on delivery — call them to confirm."
      />

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <SearchInput
          value={search}
          onChange={setSearch}
          onSearch={() => setPage(1)}
          placeholder="Search order #, name or phone…"
          className="w-72"
          loading={loading}
        />
        <Select
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
          options={[
            { value: "", label: "All statuses" },
            ...Object.entries(STATUS_META).map(([value, meta]) => ({ value, label: meta.label })),
          ]}
          className="w-44"
        />
        <span className="ml-auto text-sm text-slate-500">{total} orders</span>
      </div>

      <Table<StoreOrderRow>
        columns={[
          {
            key: "orderNumber",
            header: "Order",
            render: (r) => (
              <div>
                <p className="font-mono text-sm font-semibold text-slate-900">{r.orderNumber}</p>
                <p className="text-xs text-slate-400">{new Date(r.createdAt).toLocaleString()}</p>
              </div>
            ),
          },
          {
            key: "customer",
            header: "Customer",
            render: (r) => (
              <div>
                <p className="font-medium text-slate-900">{r.customerName}</p>
                <p className="text-xs text-slate-500">📞 {r.phone}</p>
              </div>
            ),
          },
          {
            key: "items",
            header: "Items",
            className: "text-right",
            render: (r) => `${r.items.reduce((s, i) => s + i.quantity, 0)}`,
          },
          { key: "total", header: "Total", className: "text-right", render: (r) => <span className="font-semibold text-slate-900">{money(r.total)}</span> },
          {
            key: "status",
            header: "Status",
            render: (r) => {
              const meta = STATUS_META[r.status] ?? STATUS_META.pending;
              return <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold", meta.chip)}>{meta.label}</span>;
            },
          },
          {
            key: "actions",
            header: "Actions",
            render: (r) => (
              <Button variant="secondary" size="sm" onClick={() => setDetail(r)}>
                View
              </Button>
            ),
          },
        ]}
        data={rows}
        keyExtractor={(r) => r.id}
        loading={loading}
        onRowClick={(r) => setDetail(r)}
        empty={<EmptyState label="No store orders yet" description="Orders placed on the storefront appear here." />}
      />

      {totalPages > 1 && (
        <div className="mt-4">
          <Pagination page={page} totalPages={totalPages} totalItems={total} itemsPerPage={perPage} onPageChange={setPage} />
        </div>
      )}

      {/* Detail modal */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail ? `Order ${detail.orderNumber}` : ""}
        description={detail ? `${new Date(detail.createdAt).toLocaleString()} · ${(STATUS_META[detail.status] ?? STATUS_META.pending).label}` : ""}
        size="lg"
        footer={
          detail &&
          (STATUS_META[detail.status]?.next.length ?? 0) > 0 ? (
            <div className="flex w-full items-center justify-between gap-3">
              <p className="text-xs text-slate-400">
                {detail.status === "confirmed" || detail.status === "pending" ? "Canceling puts the items back in stock." : " "}
              </p>
              <div className="flex gap-2">
                {STATUS_META[detail.status].next.map((n) => (
                  <Button
                    key={n.value}
                    variant={n.value === "canceled" ? "danger" : "primary"}
                    size="sm"
                    disabled={actionId === detail.id}
                    loading={actionId === detail.id}
                    onClick={() => updateStatus(detail, n.value)}
                  >
                    {n.label}
                  </Button>
                ))}
              </div>
            </div>
          ) : undefined
        }
      >
        {detail && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Customer</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{detail.customerName}</p>
                <p className="text-sm text-slate-600">📞 {detail.phone}</p>
                {detail.email && <p className="text-sm text-slate-600">✉️ {detail.email}</p>}
              </div>
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Delivery</p>
                <p className="mt-1 text-sm text-slate-700">{detail.address || "No address given"}</p>
                {detail.note && <p className="mt-1 text-xs italic text-slate-500">“{detail.note}”</p>}
              </div>
            </div>

            <div className="overflow-hidden rounded-lg border border-slate-200">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Line total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {detail.items.map((item, i) => (
                    <tr key={`${item.productId}-${i}`}>
                      <td className="px-3 py-2 font-medium text-slate-900">{item.name}</td>
                      <td className="px-3 py-2 text-right text-slate-600">{money(item.price)}</td>
                      <td className="px-3 py-2 text-right text-slate-600">{item.quantity}</td>
                      <td className="px-3 py-2 text-right font-semibold text-slate-900">{money(item.price * item.quantity)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50">
                    <td colSpan={3} className="px-3 py-2 text-right text-sm font-medium text-slate-500">
                      Total
                    </td>
                    <td className="px-3 py-2 text-right text-base font-bold text-slate-900">{money(detail.total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
