"use client";

import { useCallback, useEffect, useState } from "react";
import { money } from "@/lib/currency";
import Link from "next/link";
import { Table, EmptyState, Button, SearchInput, Select, DatePicker } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { Pagination } from "@/components/ui/pagination";
import { error } from "@/utils/toast";
import { cn } from "@/utils/classname";

interface SaleRow {
  _id: string;
  invoiceNumber: string;
  createdAt: string;
  customerName: string | null;
  cashierName: string;
  total: number;
  paymentMethod: string | null;
  status: string;
  itemCount: number;
}

interface Cashier {
  _id: string;
  name: string;
}

interface CustomerOption {
  _id: string;
  name: string;
}

const STATUS_STYLES: Record<string, string> = {
  completed: "bg-green-100 text-green-700",
  held: "bg-amber-100 text-amber-700",
  canceled: "bg-slate-100 text-slate-600",
};

export function SalesClient() {
  const [loading, setLoading] = useState(true);
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage] = useState(15);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [cashierId, setCashierId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [cashiers, setCashiers] = useState<Cashier[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);

  const load = useCallback(async () => {

    try {
      const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
      if (search) params.set("search", search);
      if (status) params.set("status", status);
      if (paymentMethod) params.set("paymentMethod", paymentMethod);
      if (customerId) params.set("customerId", customerId);
      if (cashierId) params.set("cashierId", cashierId);
      if (from) params.set("from", from);
      if (to) params.set("to", to);

      const res = await fetch(`/api/sales?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setSales(data.sales ?? []);
      setTotal(data.total ?? 0);
    } catch {
      error("Error", "Failed to load sales");
    } finally {
      setLoading(false);
    }
  }, [page, perPage, search, status, paymentMethod, customerId, cashierId, from, to]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  useEffect(() => {
    // Load filter options (best effort)
    (async () => {
      try {
        const [cRes, custRes] = await Promise.all([fetch("/api/sales/filters"), fetch("/api/pos/customers?limit=200")]);
        if (cRes.ok) {
          const data = await cRes.json();
          setCashiers(data.cashiers ?? []);
        }
        if (custRes.ok) {
          const data = await custRes.json();
          setCustomers(data.customers ?? []);
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  const hasFilters = search || status || paymentMethod || customerId || cashierId || from || to;

  const columns = [
    {
      key: "invoiceNumber",
      header: "Invoice #",
      render: (row: SaleRow) => (
        <Link href={`/sales/${row._id}`} className="font-mono text-sm font-medium text-blue-600 hover:underline">
          {row.invoiceNumber}
        </Link>
      ),
    },
    {
      key: "createdAt",
      header: "Date",
      render: (row: SaleRow) =>
        new Date(row.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }),
    },
    { key: "customerName", header: "Customer", render: (row: SaleRow) => row.customerName ?? "Walk-in" },
    { key: "cashierName", header: "Cashier", render: (row: SaleRow) => row.cashierName },
    {
      key: "paymentMethod",
      header: "Payment",
      render: (row: SaleRow) => <span className="capitalize">{row.paymentMethod ?? "—"}</span>,
    },
    {
      key: "total",
      header: "Total",
      className: "text-right",
      render: (row: SaleRow) => <span className="font-semibold">{money(row.total)}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (row: SaleRow) => (
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium capitalize", STATUS_STYLES[row.status] ?? "bg-slate-100 text-slate-600")}>
          {row.status}
        </span>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Sales" }]} />
      <PageHeader title="Sales" description="Sales history and receipts" />

      <div className="mb-4 grid gap-3 md:grid-cols-3 lg:grid-cols-4">
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search invoice #…" className="w-full" />
        <Select
          value={status}
          onChange={(v) => { setStatus(v); setPage(1); }}
          placeholder="All statuses"
          options={[
            { value: "completed", label: "Completed" },
            { value: "held", label: "Held" },
            { value: "canceled", label: "Canceled" },
          ]}
        />
        <Select
          value={paymentMethod}
          onChange={(v) => { setPaymentMethod(v); setPage(1); }}
          placeholder="All payment methods"
          options={[
            { value: "cash", label: "Cash" },
            { value: "card", label: "Card" },
            { value: "transfer", label: "Bank Transfer" },
            { value: "credit", label: "Credit" },
            { value: "mixed", label: "Mixed" },
          ]}
        />
        <Select
          value={cashierId}
          onChange={(v) => { setCashierId(v); setPage(1); }}
          placeholder="All cashiers"
          options={cashiers.map((c) => ({ value: c._id, label: c.name }))}
        />
        <Select
          value={customerId}
          onChange={(v) => { setCustomerId(v); setPage(1); }}
          placeholder="All customers"
          options={customers.map((c) => ({ value: c._id, label: c.name }))}
        />
        <DatePicker value={from} onChange={(v) => { setFrom(v); setPage(1); }} placeholder="From" />
        <DatePicker value={to} onChange={(v) => { setTo(v); setPage(1); }} placeholder="To" />
        {hasFilters && (
          <Button
            variant="ghost"
            onClick={() => { setSearch(""); setStatus(""); setPaymentMethod(""); setCustomerId(""); setCashierId(""); setFrom(""); setTo(""); setPage(1); }}
          >
            Clear filters
          </Button>
        )}
      </div>

      <Table
        columns={columns}
        data={sales}
        keyExtractor={(row) => row._id}
        loading={loading}
        empty={<EmptyState label="No sales found" description="Completed POS sales will appear here." />}
      />

      {Math.ceil(total / perPage) > 1 && (
        <div className="mt-4">
          <Pagination page={page} totalPages={Math.ceil(total / perPage)} totalItems={total} itemsPerPage={perPage} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}
