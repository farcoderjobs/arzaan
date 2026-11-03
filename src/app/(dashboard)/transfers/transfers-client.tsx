"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, FormField, Input, Modal, Select, Table, Textarea } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { success, error } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/utils/classname";

interface TransferItem {
  productId: string;
  name: string;
  sku: string;
  quantity: number;
  receivedQuantity: number;
  batchNumber: string;
  expirationDate: string | null;
  purchaseSource: "import" | "local" | null;
}

interface TransferRow {
  _id: string;
  transferNumber: string;
  status: "draft" | "dispatched" | "partially_received" | "received" | "canceled";
  fromBranchId: string;
  fromBranchName: string | null;
  fromBranchType: string;
  toBranchId: string;
  toBranchName: string | null;
  toBranchType: string;
  items: TransferItem[];
  note: string;
  discrepancyNote: string;
  createdByName: string | null;
  dispatchedAt: string | null;
  receivedAt: string | null;
  createdAt: string;
}

interface BranchOption {
  _id: string;
  name: string;
  type: string;
  status: string;
}

interface WarehouseOption {
  _id: string;
  name: string;
  status: string;
}

interface TransfersClientProps {
  canCreate: boolean;
  canDispatch: boolean;
  canReceive: boolean;
  canCancel: boolean;
}

interface DraftLine {
  productId: string;
  quantity: string;
}

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "dispatched", label: "In transit" },
  { value: "partially_received", label: "Partially received" },
  { value: "received", label: "Received" },
  { value: "canceled", label: "Canceled" },
];

export function TransfersClient({ canCreate, canDispatch, canReceive, canCancel }: TransfersClientProps) {
  const [loading, setLoading] = useState(true);
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);
  const [status, setStatus] = useState("");
  const [inTransitUnits, setInTransitUnits] = useState(0);
  const [products, setProducts] = useState<Array<{ _id: string; name: string; sku: string }>>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    fromBranchId: "",
    toBranchId: "",
    note: "",
    lines: [{ productId: "", quantity: "1" }] as DraftLine[],
  });
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<TransferRow | null>(null);
  const [received, setReceived] = useState<Record<number, string>>({});
  const [discrepancyNote, setDiscrepancyNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ perPage: "50" });
      if (status) params.set("status", status);
      const res = await fetch(`/api/transfers?${params}`);
      const body = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(body, "Failed to load transfers"));
        return;
      }
      setTransfers(body.transfers ?? []);
      setBranches(body.branches ?? []);
      setWarehouses(body.warehouses ?? []);
      setInTransitUnits(body.summary?.inTransitUnits ?? 0);
    } catch {
      error("Error", "Failed to load transfers");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  useEffect(() => {
    const loadProducts = async () => {
      try {
        const res = await fetch("/api/products?perPage=100");
        if (!res.ok) return;
        const body = await res.json();
        setProducts((body.products ?? []).map((p: { _id: string; name: string; sku: string }) => ({ _id: p._id, name: p.name, sku: p.sku })));
      } catch {
        // product list is only needed for the create modal
      }
    };
    void loadProducts();
  }, []);

  // Each endpoint is either a branch (shop) or a standalone warehouse.
  const locations = [
    ...branches.map((b) => ({
      value: `branch:${b._id}`,
      label: `${b.name} (${b.type === "warehouse" ? "warehouse" : "shop"})`,
    })),
    ...warehouses.map((w) => ({ value: `warehouse:${w._id}`, label: `${w.name} (warehouse)` })),
  ];

  const openCreate = () => {
    const shop = branches.find((b) => b.type !== "warehouse");
    const warehouse = warehouses[0];
    const from = warehouse
      ? `warehouse:${warehouse._id}`
      : shop
        ? `branch:${shop._id}`
        : locations[0]?.value ?? "";
    const to = from.startsWith("warehouse:")
      ? shop
        ? `branch:${shop._id}`
        : locations.find((l) => l.value !== from)?.value ?? ""
      : warehouse
        ? `warehouse:${warehouse._id}`
        : locations.find((l) => l.value !== from)?.value ?? "";
    setForm({
      fromBranchId: from,
      toBranchId: to,
      note: "",
      lines: [{ productId: products[0]?._id ?? "", quantity: "1" }],
    });
    setCreateOpen(true);
  };

  const action = async (payload: Record<string, unknown>, key: string) => {
    setBusyId(key);
    try {
      const res = await fetch("/api/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(body, "Transfer action failed"));
        return false;
      }
      success("Saved", typeof body?.message === "string" ? body.message : "Transfer updated");
      await load();
      return true;
    } catch {
      error("Error", "Transfer action failed");
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const create = async () => {
    const lines = form.lines
      .filter((line) => line.productId)
      .map((line) => ({ productId: line.productId, quantity: Number(line.quantity) }));
    if (!form.fromBranchId || !form.toBranchId) {
      error("Error", "Select both locations");
      return;
    }
    if (lines.length === 0 || lines.some((line) => !Number.isInteger(line.quantity) || line.quantity < 1)) {
      error("Error", "Every line needs a product and a whole quantity of at least 1");
      return;
    }
    setSaving(true);
    const [fromKind, fromId] = form.fromBranchId.split(":");
    const [toKind, toId] = form.toBranchId.split(":");
    const ok = await action(
      {
        action: "create",
        ...(fromKind === "warehouse" ? { fromWarehouseId: fromId } : { fromBranchId: fromId }),
        ...(toKind === "warehouse" ? { toWarehouseId: toId } : { toBranchId: toId }),
        items: lines,
        note: form.note,
      },
      "create"
    );
    setSaving(false);
    if (ok) setCreateOpen(false);
  };

  const statusBadge = (row: TransferRow) => {
    const styles: Record<TransferRow["status"], string> = {
      draft: "bg-slate-100 text-slate-600",
      dispatched: "bg-amber-100 text-amber-700",
      partially_received: "bg-blue-100 text-blue-700",
      received: "bg-emerald-100 text-emerald-700",
      canceled: "bg-slate-100 text-slate-500",
    };
    return (
      <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", styles[row.status])}>
        {row.status === "dispatched" ? "in transit" : row.status.replace("_", " ")}
      </span>
    );
  };

  const columns = [
    {
      key: "number",
      header: "Transfer",
      render: (row: TransferRow) => <span className="font-mono text-sm text-slate-800">{row.transferNumber}</span>,
    },
    {
      key: "route",
      header: "Route",
      render: (row: TransferRow) => (
        <span className="text-sm">
          <span className="font-medium">{row.fromBranchName ?? "—"}</span>
          <span className="mx-1 text-slate-400">→</span>
          <span className="font-medium">{row.toBranchName ?? "—"}</span>
          <span className="ms-2 text-xs text-slate-400">
            {row.fromBranchType === "warehouse" ? "warehouse" : "shop"} → {row.toBranchType === "warehouse" ? "warehouse" : "shop"}
          </span>
        </span>
      ),
    },
    {
      key: "items",
      header: "Units",
      render: (row: TransferRow) => {
        const total = row.items.reduce((s, i) => s + i.quantity, 0);
        const done = row.items.reduce((s, i) => s + i.receivedQuantity, 0);
        return (
          <span className="text-sm">
            {done}/{total}
          </span>
        );
      },
    },
    { key: "status", header: "Status", render: statusBadge },
    {
      key: "actions",
      header: "",
      className: "w-56",
      render: (row: TransferRow) => (
        <div className="flex flex-wrap justify-end gap-1">
          {canDispatch && row.status === "draft" ? (
            <Button size="sm" variant="secondary" loading={busyId === `dispatch:${row._id}`} onClick={() => void action({ action: "dispatch", id: row._id }, `dispatch:${row._id}`)}>
              Dispatch
            </Button>
          ) : null}
          {canReceive && (row.status === "dispatched" || row.status === "partially_received") ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setReceipt(row);
                setReceived(
                  Object.fromEntries(row.items.map((item, index) => [index, String(Math.max(0, item.quantity - item.receivedQuantity))]))
                );
                setDiscrepancyNote(row.discrepancyNote ?? "");
              }}
            >
              Receive
            </Button>
          ) : null}
          {canCancel && row.status === "draft" ? (
            <Button
              size="sm"
              variant="ghost"
              loading={busyId === `cancel:${row._id}`}
              onClick={() => void action({ action: "cancel", id: row._id }, `cancel:${row._id}`)}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  const receive = async () => {
    if (!receipt) return;
    const receivedLines = receipt.items.map((_, index) => ({ index, quantity: Number(received[index] || 0) }));
    const ok = await action(
      { action: "receive", id: receipt._id, received: receivedLines, discrepancyNote },
      "receive"
    );
    if (ok) setReceipt(null);
  };

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Stock Transfers" }]} />
      <PageHeader
        title="Stock transfers"
        description="Move stock between shops and warehouses. Goods in transit are tracked until received."
        actions={
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-600">
              In transit: <strong>{inTransitUnits}</strong> units
            </span>
            {canCreate ? <Button onClick={openCreate}>New transfer</Button> : null}
          </div>
        }
      />

      <div className="mb-4 w-full max-w-xs">
        <Select value={status} onChange={setStatus} options={STATUS_OPTIONS} />
      </div>

      <Table
        columns={columns}
        data={transfers}
        keyExtractor={(row) => row._id}
        loading={loading}
        empty={<EmptyState label="No transfers" description="Create a transfer to move stock between locations." />}
      />

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New stock transfer"
        size="lg"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setCreateOpen(false)}>
            Cancel
          </Button>,
          <Button key="save" loading={saving} onClick={() => void create()}>
            Create draft
          </Button>,
        ]}
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="From location" required>
              <Select
                value={form.fromBranchId}
                onChange={(v) => setForm({ ...form, fromBranchId: v })}
                options={locations}
              />
            </FormField>
            <FormField label="To location" required>
              <Select
                value={form.toBranchId}
                onChange={(v) => setForm({ ...form, toBranchId: v })}
                options={locations}
              />
            </FormField>
          </div>

          <div className="space-y-2">
            {form.lines.map((line, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_120px_40px]">
                <Select
                  value={line.productId}
                  onChange={(v) => {
                    const lines = [...form.lines];
                    lines[index] = { ...lines[index], productId: v };
                    setForm({ ...form, lines });
                  }}
                  options={products.map((p) => ({ value: p._id, label: `${p.name}${p.sku ? ` — ${p.sku}` : ""}` }))}
                  placeholder="Select product"
                />
                <Input
                  type="number"
                  min="1"
                  value={line.quantity}
                  onChange={(e) => {
                    const lines = [...form.lines];
                    lines[index] = { ...lines[index], quantity: e.target.value };
                    setForm({ ...form, lines });
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={form.lines.length === 1}
                  onClick={() => setForm({ ...form, lines: form.lines.filter((_, i) => i !== index) })}
                >
                  ✕
                </Button>
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setForm({ ...form, lines: [...form.lines, { productId: "", quantity: "1" }] })}
            >
              Add line
            </Button>
          </div>

          <p className="text-xs text-slate-500">
            Dispatch takes the earliest-expiring batch and copies its expiry and Import/Local origin. If a line spans
            several batches, split it per batch.
          </p>

          <FormField label="Note">
            <Textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} rows={2} />
          </FormField>
        </div>
      </Modal>

      <Modal
        open={receipt !== null}
        onClose={() => setReceipt(null)}
        title={`Receive ${receipt?.transferNumber ?? ""}`}
        size="md"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setReceipt(null)}>
            Cancel
          </Button>,
          <Button key="receive" loading={busyId === "receive"} onClick={() => void receive()}>
            Record receipt
          </Button>,
        ]}
      >
        <div className="space-y-3">
          {(receipt?.items ?? []).map((item, index) => {
            const remaining = Math.max(0, item.quantity - item.receivedQuantity);
            return (
              <div key={index} className="grid items-center gap-2 sm:grid-cols-[1fr_130px]">
                <div className="text-sm">
                  <div className="font-medium text-slate-800">{item.name}</div>
                  <div className="text-xs text-slate-500">
                    {remaining} of {item.quantity} remaining
                    {item.batchNumber ? ` · batch ${item.batchNumber}` : ""}
                    {item.expirationDate ? ` · exp ${String(item.expirationDate).slice(0, 10)}` : ""}
                    {item.purchaseSource ? ` · ${item.purchaseSource}` : ""}
                  </div>
                </div>
                <Input
                  type="number"
                  min="0"
                  max={remaining}
                  value={received[index] ?? ""}
                  onChange={(e) => setReceived({ ...received, [index]: e.target.value })}
                />
              </div>
            );
          })}
          <FormField label="Discrepancy note (short or damaged units)">
            <Textarea value={discrepancyNote} onChange={(e) => setDiscrepancyNote(e.target.value)} rows={2} />
          </FormField>
        </div>
      </Modal>
    </div>
  );
}
