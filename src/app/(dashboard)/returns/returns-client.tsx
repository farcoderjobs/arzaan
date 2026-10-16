"use client";

import { useCallback, useEffect, useState } from "react";
import { money } from "@/lib/currency";
import Link from "next/link";
import { Table, EmptyState, Button, SearchInput, Select, Modal } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { Pagination } from "@/components/ui/pagination";
import { success, error } from "@/utils/toast";
import { cn } from "@/utils/classname";
import { Plus } from "@/components/ui/icons";

interface ReturnsClientProps {
  canRefund: boolean;
  canViewSales: boolean;
}

interface ReturnRow {
  _id: string;
  returnNumber: string;
  saleInvoiceNumber: string;
  saleId: string | null;
  customerName: string | null;
  itemsCount: number;
  total: number;
  refundMethod: string;
  status: string;
  reason: string;
  userName: string;
  createdAt: string;
}

const STATUS_STYLES: Record<string, string> = {
  approved: "bg-green-100 text-green-700",
  pending: "bg-amber-100 text-amber-700",
  rejected: "bg-red-100 text-red-600",
};

export function ReturnsClient({ canRefund, canViewSales }: ReturnsClientProps) {
  const [loading, setLoading] = useState(true);
  const [returns, setReturns] = useState<ReturnRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage] = useState(15);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");

  const [approveTarget, setApproveTarget] = useState<ReturnRow | null>(null);
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {

    try {
      const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
      if (search) params.set("search", search);
      if (status) params.set("status", status);
      const res = await fetch(`/api/sales-returns?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setReturns(data.returns ?? []);
      setTotal(data.total ?? 0);
    } catch {
      error("Error", "Failed to load returns");
    } finally {
      setLoading(false);
    }
  }, [page, perPage, search, status]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const act = async (action: "approve" | "reject") => {
    if (!approveTarget) return;
    setActing(true);
    try {
      const res = await fetch("/api/sales-returns", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: approveTarget._id, action }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", data?.error?.message ?? "Action failed");
        return;
      }
      success("Success", action === "approve" ? "Return approved" : "Return rejected");
      setApproveTarget(null);
      load();
    } catch {
      error("Error", "Action failed");
    } finally {
      setActing(false);
    }
  };

  const columns = [
    {
      key: "returnNumber",
      header: "Return #",
      render: (row: ReturnRow) => (
        <Link href={`/returns/${row._id}`} className="font-mono text-sm font-medium text-blue-600 hover:underline">
          {row.returnNumber}
        </Link>
      ),
    },
    {
      key: "sale",
      header: "Original Sale",
      render: (row: ReturnRow) =>
        row.saleId && canViewSales ? (
          <Link href={`/sales/${row.saleId}`} className="font-mono text-sm text-blue-600 hover:underline">
            {row.saleInvoiceNumber}
          </Link>
        ) : (
          <span className="font-mono text-sm">{row.saleInvoiceNumber}</span>
        ),
    },
    { key: "customerName", header: "Customer", render: (row: ReturnRow) => row.customerName ?? "Walk-in" },
    { key: "itemsCount", header: "Items", render: (row: ReturnRow) => row.itemsCount },
    {
      key: "total",
      header: "Refund",
      className: "text-right",
      render: (row: ReturnRow) => <span className="font-semibold text-slate-900">{money(row.total)}</span>,
    },
    {
      key: "refundMethod",
      header: "Method",
      render: (row: ReturnRow) => <span className="text-xs capitalize">{row.refundMethod.replace("_", " ")}</span>,
    },
    { key: "reason", header: "Reason", render: (row: ReturnRow) => <span className="text-xs">{row.reason || "—"}</span> },
    {
      key: "status",
      header: "Status",
      render: (row: ReturnRow) => (
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium capitalize", STATUS_STYLES[row.status] ?? "bg-slate-100 text-slate-600")}>
          {row.status}
        </span>
      ),
    },
    ...(canRefund
      ? [
          {
            key: "actions",
            header: "",
            className: "w-36",
            render: (row: ReturnRow) =>
              row.status === "pending" ? (
                <div className="flex justify-end gap-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); setApproveTarget(row); }}
                    className="rounded-lg px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-50"
                  >
                    Review
                  </button>
                </div>
              ) : null,
          },
        ]
      : []),
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Returns" }]} />
      <PageHeader
        title="Returns & Refunds"
        description="Customer returns linked to original sales"
        actions={
          canRefund ? (
            <Link href="/returns/new">
              <Button><Plus className="mr-2 h-4 w-4" />New Return</Button>
            </Link>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[200px]">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search return #…" className="max-w-sm" />
        </div>
        <div className="w-40">
          <Select
            value={status}
            onChange={(v) => { setStatus(v); setPage(1); }}
            placeholder="All statuses"
            options={[
              { value: "pending", label: "Pending" },
              { value: "approved", label: "Approved" },
              { value: "rejected", label: "Rejected" },
            ]}
          />
        </div>
      </div>

      <Table
        columns={columns}
        data={returns}
        keyExtractor={(row) => row._id}
        loading={loading}
        empty={<EmptyState label="No returns" description="Processed returns will appear here." />}
      />

      {Math.ceil(total / perPage) > 1 && (
        <div className="mt-4">
          <Pagination page={page} totalPages={Math.ceil(total / perPage)} totalItems={total} itemsPerPage={perPage} onPageChange={setPage} />
        </div>
      )}

      <Modal
        open={approveTarget !== null}
        onClose={() => setApproveTarget(null)}
        title={`Review return ${approveTarget?.returnNumber ?? ""}`}
        size="sm"
        footer={[
          <Button key="reject" variant="danger" loading={acting} onClick={() => act("reject")}>Reject</Button>,
          <Button key="approve" loading={acting} onClick={() => act("approve")}>Approve & Refund</Button>,
        ]}
      >
        {approveTarget && (
          <div className="space-y-2 text-sm">
            <p><span className="text-slate-500">Original sale:</span> <span className="font-mono">{approveTarget.saleInvoiceNumber}</span></p>
            <p><span className="text-slate-500">Customer:</span> {approveTarget.customerName ?? "Walk-in"}</p>
            <p><span className="text-slate-500">Items:</span> {approveTarget.itemsCount}</p>
            <p><span className="text-slate-500">Refund:</span> <span className="font-semibold">{money(approveTarget.total)}</span> via <span className="capitalize">{approveTarget.refundMethod.replace("_", " ")}</span></p>
            <p><span className="text-slate-500">Reason:</span> {approveTarget.reason || "—"}</p>
            <p className="text-xs text-slate-400">Approving restocks the items and records the refund transaction.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
