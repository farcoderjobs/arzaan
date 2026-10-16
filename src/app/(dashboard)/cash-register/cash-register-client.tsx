"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Modal, FormField, Input, Textarea, Table, EmptyState, Pagination } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { success, error } from "@/utils/toast";
import { cn } from "@/utils/classname";
import { formatMoney } from "@/lib/commerce";

interface CashRegisterClientProps {
  canOpen: boolean;
  canClose: boolean;
}

interface RegisterSession {
  _id: string;
  status: string;
  openCash: number;
  expectedCash: number;
  countedCash: number | null;
  difference: number | null;
  openedAt: string | null;
  closedAt: string | null;
  openedByName?: string;
  closedByName?: string;
  openedBy?: string | null;
  note: string;
}

interface Summary {
  openingCash: number;
  cashSales: number;
  cashRefunds: number;
  cashExpenses: number;
  cashIncome: number;
  adjustments: number;
  expectedCash: number;
  countedCash: number | null;
  difference: number | null;
}

interface Movement {
  _id: string;
  type: string;
  amount: number;
  description: string;
  userName: string;
  createdAt: string;
}

interface SessionSale {
  _id: string;
  invoiceNumber: string;
  total: number;
  paidAmount: number;
  changeAmount: number;
  paymentMethod: string | null;
  customerName: string | null;
  createdAt: string;
}

const TYPE_LABELS: Record<string, string> = {
  opening: "Opening",
  sale: "Sale",
  refund: "Refund",
  expense: "Expense",
  income: "Income",
  adjustment: "Adjustment",
  closing: "Closing",
  purchase: "Purchase",
  payment_in: "Payment in",
  payment_out: "Payment out",
};

const TYPE_STYLES: Record<string, string> = {
  opening: "bg-blue-100 text-blue-700",
  sale: "bg-green-100 text-green-700",
  refund: "bg-orange-100 text-orange-700",
  expense: "bg-red-100 text-red-700",
  income: "bg-emerald-100 text-emerald-700",
  adjustment: "bg-purple-100 text-purple-700",
  closing: "bg-slate-100 text-slate-600",
};

export function CashRegisterClient({ canOpen, canClose }: CashRegisterClientProps) {
  const [session, setSession] = useState<RegisterSession | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [sales, setSales] = useState<SessionSale[]>([]);
  const [loading, setLoading] = useState(true);

  const [openModal, setOpenModal] = useState(false);
  const [openCash, setOpenCash] = useState("0");
  const [openNote, setOpenNote] = useState("");
  const [opening, setOpening] = useState(false);

  const [closeModal, setCloseModal] = useState(false);
  const [countedCash, setCountedCash] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [closing, setClosing] = useState(false);

  const [movementModal, setMovementModal] = useState<null | "in" | "out" | "adjust">(null);
  const [movementAmount, setMovementAmount] = useState("");
  const [movementDesc, setMovementDesc] = useState("");
  const [savingMovement, setSavingMovement] = useState(false);

  const [history, setHistory] = useState<RegisterSession[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);
  const perPage = 10;

  const load = useCallback(async () => {

    try {
      const res = await fetch("/api/cash-register");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setSession(data.session);
      setSummary(data.summary);
      setMovements(data.movements ?? []);
      setSales(data.sales ?? []);
    } catch {
      error("Error", "Failed to load register session");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(`/api/cash-register?history=1&page=${historyPage}&perPage=${perPage}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setHistory(data.sessions ?? []);
      setHistoryTotal(data.total ?? 0);
    } catch {
      // best effort
    }
  }, [historyPage]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  useEffect(() => {
    void (async () => {
      await loadHistory();
    })();
  }, [loadHistory]);

  const handleOpen = async () => {
    setOpening(true);
    try {
      const res = await fetch("/api/cash-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "open", openCash: Number(openCash) || 0, note: openNote }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Cannot open register", data?.error?.message ?? "Failed to open register");
        return;
      }
      success("Register opened", `Opening cash: ${formatMoney(Number(openCash) || 0)}`);
      setOpenModal(false);
      setOpenCash("0");
      setOpenNote("");
      load();
    } catch {
      error("Error", "Failed to open register");
    } finally {
      setOpening(false);
    }
  };

  const handleClose = async () => {
    if (!session) return;
    setClosing(true);
    try {
      const res = await fetch("/api/cash-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close", registerId: session._id, countedCash: Number(countedCash) || 0, note: closeNote }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Cannot close register", data?.error?.message ?? "Failed to close register");
        return;
      }
      success(
        "Register closed",
        `Expected ${formatMoney(data.data.expectedCash)} — counted ${formatMoney(data.data.countedCash)} — difference ${formatMoney(data.data.difference ?? 0)}`
      );
      setCloseModal(false);
      setCountedCash("");
      setCloseNote("");
      load();
      loadHistory();
    } catch {
      error("Error", "Failed to close register");
    } finally {
      setClosing(false);
    }
  };

  const handleMovement = async () => {
    if (!movementModal) return;
    setSavingMovement(true);
    try {
      const res = await fetch("/api/cash-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: movementModal === "in" ? "cash-in" : movementModal === "out" ? "cash-out" : "adjust",
          amount: Number(movementAmount) || 0,
          description: movementDesc,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Failed", data?.error?.message ?? "Failed to record cash movement");
        return;
      }
      success("Recorded", "Cash movement saved");
      setMovementModal(null);
      setMovementAmount("");
      setMovementDesc("");
      load();
    } catch {
      error("Error", "Failed to record cash movement");
    } finally {
      setSavingMovement(false);
    }
  };

  const isOpen = session?.status === "open";

  const summaryRows: Array<{ label: string; value: number; emphasis?: boolean; tone?: string }> = summary
    ? [
        { label: "Opening cash", value: summary.openingCash },
        { label: "Cash sales", value: summary.cashSales },
        { label: "Cash income", value: summary.cashIncome },
        { label: "Cash refunds", value: summary.cashRefunds },
        { label: "Cash expenses", value: summary.cashExpenses },
        { label: "Adjustments", value: summary.adjustments },
        { label: "Expected cash", value: summary.expectedCash, emphasis: true },
      ]
    : [];

  const movementColumns = [
    { key: "createdAt", header: "Time", render: (r: Movement) => new Date(r.createdAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) },
    {
      key: "type",
      header: "Type",
      render: (r: Movement) => (
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", TYPE_STYLES[r.type] ?? "bg-slate-100 text-slate-600")}>
          {TYPE_LABELS[r.type] ?? r.type}
        </span>
      ),
    },
    { key: "description", header: "Description" },
    { key: "userName", header: "By" },
    {
      key: "amount",
      header: "Amount",
      className: "text-right",
      render: (r: Movement) => (
        <span className={cn("font-semibold", r.amount < 0 ? "text-red-600" : "text-green-700")}>
          {r.amount < 0 ? "−" : "+"}
          {formatMoney(Math.abs(r.amount))}
        </span>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <Breadcrumbs items={[{ label: "Finance", href: "/finance" }, { label: "Cash Register" }]} />
      <PageHeader
        title="Cash Register"
        description="Open, operate and close your cash drawer session"
        actions={
          isOpen ? (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setMovementModal("in")}>Cash In</Button>
              <Button variant="secondary" onClick={() => setMovementModal("out")}>Cash Out</Button>
              <Button variant="secondary" onClick={() => setMovementModal("adjust")}>Adjustment</Button>
              {canClose && <Button variant="danger" onClick={() => { setCountedCash(""); setCloseModal(true); }}>Close Register</Button>}
            </div>
          ) : canOpen ? (
            <Button onClick={() => setOpenModal(true)} disabled={loading}>Open Register</Button>
          ) : null
        }
      />

      {loading ? (
        <div className="h-64 animate-pulse rounded-xl bg-slate-100" />
      ) : !session ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-2xl">💵</div>
          <p className="mt-3 font-medium text-slate-700">No register session</p>
          <p className="mt-1 text-sm text-slate-500">
            {canOpen ? "Open a register with your opening cash to start selling." : "Ask a cashier to open the register."}
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-5">
            {/* Expected cash card */}
            <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-2">
              <p className="text-sm font-medium text-slate-500">Cash in drawer (expected)</p>
              <p className="mt-1 text-3xl font-bold text-slate-900">{formatMoney(summary?.expectedCash ?? 0)}</p>
              <p className="mt-1 text-xs text-slate-400">
                Opened {session.openedAt ? new Date(session.openedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                {session.openedByName ? ` by ${session.openedByName}` : ""}
              </p>
              <span className={cn(
                "mt-3 inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold",
                isOpen ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"
              )}>
                {isOpen ? "OPEN" : session.status.toUpperCase()}
              </span>
              {canOpen && isOpen && (
                <p className="mt-4 text-xs text-slate-400">
                  Use Cash In for other income (e.g. owner deposits) and Cash Out for drawer payouts not tied to an expense record.
                </p>
              )}
            </div>

            {/* Summary breakdown */}
            <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-3">
              <p className="mb-3 text-sm font-semibold text-slate-700">Session summary</p>
              <dl className="space-y-1.5 text-sm">
                {summaryRows.map((row) => (
                  <div key={row.label} className={cn("flex items-center justify-between", row.emphasis && "border-t border-slate-200 pt-2 font-semibold")}>
                    <dt className={row.emphasis ? "text-slate-900" : "text-slate-500"}>{row.label}</dt>
                    <dd className={cn(row.value < 0 ? "text-red-600" : row.emphasis ? "text-slate-900" : "text-slate-700")}>
                      {formatMoney(row.value)}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                Expected = Opening + Sales + Income − Refunds − Expenses ± Adjustments
              </p>
            </div>
          </div>

          {/* Session sales */}
          <div className="mt-6">
            <h2 className="mb-2 text-sm font-semibold text-slate-700">Sales this session</h2>
            <Table
              columns={[
                { key: "invoiceNumber", header: "Invoice", render: (r: SessionSale) => <span className="font-mono text-xs">{r.invoiceNumber}</span> },
                { key: "createdAt", header: "Time", render: (r: SessionSale) => new Date(r.createdAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) },
                { key: "customerName", header: "Customer", render: (r: SessionSale) => r.customerName ?? "Walk-in" },
                { key: "paymentMethod", header: "Method", render: (r: SessionSale) => <span className="capitalize">{r.paymentMethod ?? "—"}</span> },
                { key: "total", header: "Total", className: "text-right", render: (r: SessionSale) => formatMoney(r.total) },
              ]}
              data={sales}
              keyExtractor={(r) => r._id}
              empty={<EmptyState label="No sales yet this session" />}
            />
          </div>

          {/* Drawer movements */}
          <div className="mt-6">
            <h2 className="mb-2 text-sm font-semibold text-slate-700">Drawer movements</h2>
            <Table
              columns={movementColumns}
              data={movements}
              keyExtractor={(r) => r._id}
              empty={<EmptyState label="No movements recorded" />}
            />
          </div>
        </>
      )}

      {/* Closed sessions history */}
      <div className="mt-8">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Closed sessions</h2>
        <Table
          columns={[
            { key: "closedAt", header: "Closed", render: (r: RegisterSession) => (r.closedAt ? new Date(r.closedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—") },
            { key: "openedByName", header: "Opened by", render: (r: RegisterSession) => r.openedByName ?? "—" },
            { key: "openCash", header: "Opening", className: "text-right", render: (r: RegisterSession) => formatMoney(r.openCash) },
            { key: "expectedCash", header: "Expected", className: "text-right", render: (r: RegisterSession) => formatMoney(r.expectedCash) },
            { key: "countedCash", header: "Counted", className: "text-right", render: (r: RegisterSession) => (r.countedCash !== null ? formatMoney(r.countedCash) : "—") },
            {
              key: "difference",
              header: "Difference",
              className: "text-right",
              render: (r: RegisterSession) =>
                r.difference === null ? (
                  "—"
                ) : (
                  <span className={cn("font-semibold", r.difference < 0 ? "text-red-600" : r.difference > 0 ? "text-green-700" : "text-slate-500")}>
                    {r.difference === 0 ? "Balanced" : formatMoney(r.difference)}
                  </span>
                ),
            },
          ]}
          data={history}
          keyExtractor={(r) => r._id}
          empty={<EmptyState label="No closed sessions yet" />}
        />
        {Math.ceil(historyTotal / perPage) > 1 && (
          <div className="mt-4">
            <Pagination page={historyPage} totalPages={Math.ceil(historyTotal / perPage)} totalItems={historyTotal} itemsPerPage={perPage} onPageChange={setHistoryPage} />
          </div>
        )}
      </div>

      {/* Open register modal */}
      <Modal
        open={openModal}
        onClose={() => setOpenModal(false)}
        title="Open Register"
        description="Count and enter the opening cash in the drawer."
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setOpenModal(false)} disabled={opening}>Cancel</Button>,
          <Button key="open" loading={opening} onClick={handleOpen}>Open Register</Button>,
        ]}
      >
        <div className="space-y-4">
          <FormField label="Opening cash" required>
            <Input type="number" min="0" step="0.01" value={openCash} onChange={(e) => setOpenCash(e.target.value)} placeholder="0.00" autoFocus />
          </FormField>
          <FormField label="Note">
            <Textarea value={openNote} onChange={(e) => setOpenNote(e.target.value)} placeholder="Optional note" rows={2} />
          </FormField>
        </div>
      </Modal>

      {/* Close register modal */}
      <Modal
        open={closeModal}
        onClose={() => setCloseModal(false)}
        title="Close Register"
        description={`Count the cash in the drawer and enter the total. Expected: ${formatMoney(summary?.expectedCash ?? 0)}`}
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setCloseModal(false)} disabled={closing}>Cancel</Button>,
          <Button key="close" variant="danger" loading={closing} onClick={handleClose}>Close Register</Button>,
        ]}
      >
        <div className="space-y-4">
          <FormField label="Actual (counted) cash" required>
            <Input type="number" min="0" step="0.01" value={countedCash} onChange={(e) => setCountedCash(e.target.value)} placeholder="0.00" autoFocus />
          </FormField>
          {countedCash !== "" && summary && (
            <div className="rounded-lg bg-slate-50 p-3 text-sm">
              <div className="flex justify-between text-slate-500">
                <span>Difference</span>
                <span className={cn("font-bold", Number(countedCash) - summary.expectedCash < 0 ? "text-red-600" : Number(countedCash) - summary.expectedCash > 0 ? "text-green-700" : "text-slate-600")}>
                  {formatMoney(Math.round((Number(countedCash) - summary.expectedCash) * 100) / 100)}
                </span>
              </div>
            </div>
          )}
          <FormField label="Note">
            <Textarea value={closeNote} onChange={(e) => setCloseNote(e.target.value)} placeholder="Optional closing note" rows={2} />
          </FormField>
        </div>
      </Modal>

      {/* Cash movement modal */}
      <Modal
        open={movementModal !== null}
        onClose={() => setMovementModal(null)}
        title={movementModal === "in" ? "Cash In" : movementModal === "out" ? "Cash Out" : "Cash Adjustment"}
        description={
          movementModal === "adjust"
            ? "Signed correction (positive adds cash, negative removes)."
            : undefined
        }
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setMovementModal(null)} disabled={savingMovement}>Cancel</Button>,
          <Button key="save" loading={savingMovement} onClick={handleMovement}>Save</Button>,
        ]}
      >
        <div className="space-y-4">
          <FormField label="Amount" required>
            <Input type="number" step="0.01" value={movementAmount} onChange={(e) => setMovementAmount(e.target.value)} placeholder="0.00" autoFocus />
          </FormField>
          <FormField label="Description" required>
            <Input value={movementDesc} onChange={(e) => setMovementDesc(e.target.value)} placeholder="Reason for this movement" />
          </FormField>
        </div>
      </Modal>
    </div>
  );
}
