"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, FormField, Input, Select, EmptyState } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { ConfirmDialog } from "@/components/ui/confirm";
import { success, error } from "@/utils/toast";
import { cn } from "@/utils/classname";
import { Plus, Edit, Save } from "@/components/ui/icons";

interface SettingsClientProps {
  canManage: boolean;
}

type SettingsPayload = {
  store: {
    storeName: string;
    logoUrl: string;
    address: string;
    phone: string;
    email: string;
    currency: string;
    taxRate: number;
    invoicePrefix: string;
  };
  pos: {
    allowNegativeStock: boolean;
    maxCashierDiscountPercent: number;
    requireCustomerForCredit: boolean;
    autoPrintReceipt: boolean;
    refundRequiresApproval: boolean;
    defaultPaymentMethod: string;
  };
  inventory: {
    lowStockThreshold: number;
    allowNegativeInventory: boolean;
    inventoryValuation: string;
  };
};

interface BranchRow {
  _id: string;
  name: string;
  code: string;
  address: string;
  phone: string;
  currency: string;
  taxRate: number;
  status: "active" | "inactive";
  userCount: number;
}

const TABS = ["Store", "POS", "Inventory", "Branches"] as const;
type Tab = (typeof TABS)[number];

const EMPTY_BRANCH = { name: "", code: "", address: "", phone: "", currency: "AFN", taxRate: "0", status: "active" as "active" | "inactive" };

export function SettingsClient({ canManage }: SettingsClientProps) {
  const [tab, setTab] = useState<Tab>("Store");
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [saving, setSaving] = useState(false);

  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [branchModal, setBranchModal] = useState(false);
  const [branchMode, setBranchMode] = useState<"create" | "edit">("create");
  const [branchForm, setBranchForm] = useState(EMPTY_BRANCH);
  const [branchErrors, setBranchErrors] = useState<Record<string, string>>({});
  const [editingBranch, setEditingBranch] = useState<BranchRow | null>(null);
  const [branchSaving, setBranchSaving] = useState(false);

  const load = useCallback(async () => {

    try {
      const [sRes, bRes] = await Promise.all([fetch("/api/settings"), fetch("/api/branches?withCounts=1")]);
      if (sRes.ok) setSettings(await sRes.json());
      if (bRes.ok) {
        const bd = await bRes.json();
        setBranches(bd.branches ?? []);
      }
    } catch {
      error("Error", "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const saveField = async (fields: Record<string, string | number | boolean>) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", data?.error?.message ?? "Failed to save settings");
        return false;
      }
      setSettings(data.data);
      success("Settings saved", "Changes are live immediately");
      return true;
    } catch {
      error("Error", "Failed to save settings");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const openBranchCreate = () => {
    setBranchForm(EMPTY_BRANCH);
    setBranchErrors({});
    setEditingBranch(null);
    setBranchMode("create");
    setBranchModal(true);
  };

  const openBranchEdit = (b: BranchRow) => {
    setBranchForm({ name: b.name, code: b.code, address: b.address, phone: b.phone, currency: b.currency, taxRate: String(b.taxRate), status: b.status });
    setBranchErrors({});
    setEditingBranch(b);
    setBranchMode("edit");
    setBranchModal(true);
  };

  const saveBranch = async () => {
    const errs: Record<string, string> = {};
    if (branchForm.name.trim().length < 2) errs.name = "Branch name is required";
    if (!/^[A-Za-z0-9_-]{2,20}$/.test(branchForm.code.trim())) errs.code = "2-20 chars: letters, numbers, - and _";
    setBranchErrors(errs);
    if (Object.keys(errs).length) return;

    setBranchSaving(true);
    try {
      const payload =
        branchMode === "create"
          ? { ...branchForm, taxRate: Number(branchForm.taxRate) || 0 }
          : { action: "update", id: editingBranch!._id, ...branchForm, taxRate: Number(branchForm.taxRate) || 0 };
      const res = await fetch("/api/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", data?.error?.message ?? "Failed to save branch");
        return;
      }
      success("Success", branchMode === "create" ? "Branch created" : "Branch updated");
      setBranchModal(false);
      load();
    } catch {
      error("Error", "Failed to save branch");
    } finally {
      setBranchSaving(false);
    }
  };

  if (loading || !settings) {
    return (
      <div className="mx-auto max-w-4xl">
        <Breadcrumbs items={[{ label: "Settings" }]} />
        <PageHeader title="Settings" description="Store, POS and inventory configuration" />
        <p className="py-10 text-center text-sm text-slate-400">Loading settings…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <Breadcrumbs items={[{ label: "Settings" }]} />
      <PageHeader title="Settings" description="Store, POS and inventory configuration" />

      <div className="no-scrollbar mb-5 flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1 sm:mb-6">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "flex-1 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition",
              tab === t ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-100"
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Store tab */}
      {tab === "Store" && (
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-6">
          <StoreSettingsForm canManage={canManage} saving={saving} onSave={saveField} settings={settings.store} />
        </div>
      )}

      {/* POS tab */}
      {tab === "POS" && (
        <PosSettingsForm canManage={canManage} saving={saving} onSave={saveField} settings={settings.pos} />
      )}

      {/* Inventory tab */}
      {tab === "Inventory" && (
        <InventorySettingsForm canManage={canManage} saving={saving} onSave={saveField} settings={settings.inventory} />
      )}

      {/* Branches tab */}
      {tab === "Branches" && (
        <div className="rounded-2xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-4 sm:px-5">
            <div>
              <h3 className="font-semibold text-slate-900">Branches</h3>
              <p className="text-xs text-slate-500">Users assigned to a branch can only access that branch&apos;s data</p>
            </div>
            {canManage && (
              <Button onClick={openBranchCreate}>
                <Plus className="mr-2 h-4 w-4" />
                Add Branch
              </Button>
            )}
          </div>
          {branches.length === 0 ? (
            <EmptyState label="No branches" description="Create your first branch — a single default branch keeps the existing workflow." />
          ) : (
            <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-semibold">Branch</th>
                  <th className="px-4 py-3 font-semibold">Code</th>
                  <th className="px-4 py-3 font-semibold">Users</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  {canManage && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {branches.map((b) => (
                  <tr key={b._id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{b.name}</p>
                      {b.address && <p className="text-xs text-slate-400">{b.address}</p>}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-600">{b.code}</td>
                    <td className="px-4 py-3 text-slate-600">{b.userCount}</td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-xs font-medium",
                          b.status === "active" ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"
                        )}
                      >
                        {b.status}
                      </span>
                    </td>
                    {canManage && (
                      <td className="px-4 py-3 text-right">
                        <button onClick={() => openBranchEdit(b)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" title="Edit branch">
                          <Edit className="h-4 w-4" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      )}

      {/* Branch modal */}
      <Modal
        open={branchModal}
        onClose={() => setBranchModal(false)}
        title={branchMode === "create" ? "Add Branch" : `Edit Branch — ${editingBranch?.name ?? ""}`}
        size="md"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setBranchModal(false)}>
            Cancel
          </Button>,
          <Button key="save" loading={branchSaving} onClick={saveBranch}>
            {branchMode === "create" ? "Create" : "Save"}
          </Button>,
        ]}
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Branch name" required error={branchErrors.name}>
              <Input value={branchForm.name} onChange={(e) => setBranchForm({ ...branchForm, name: e.target.value })} placeholder="e.g. Downtown Store" />
            </FormField>
            <FormField label="Code" required error={branchErrors.code}>
              <Input value={branchForm.code} onChange={(e) => setBranchForm({ ...branchForm, code: e.target.value.toUpperCase() })} placeholder="e.g. DT01" />
            </FormField>
          </div>
          <FormField label="Address">
            <Input value={branchForm.address} onChange={(e) => setBranchForm({ ...branchForm, address: e.target.value })} placeholder="Street address" />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="Phone">
              <Input value={branchForm.phone} onChange={(e) => setBranchForm({ ...branchForm, phone: e.target.value })} placeholder="Phone" />
            </FormField>
            <FormField label="Currency">
              <Input value={branchForm.currency} onChange={(e) => setBranchForm({ ...branchForm, currency: e.target.value.toUpperCase() })} maxLength={3} placeholder="AFN" />
            </FormField>
            <FormField label="Tax %">
              <Input type="number" min="0" max="100" step="0.01" value={branchForm.taxRate} onChange={(e) => setBranchForm({ ...branchForm, taxRate: e.target.value })} />
            </FormField>
          </div>
          <FormField label="Status">
            <Select
              value={branchForm.status}
              onChange={(v) => setBranchForm({ ...branchForm, status: v as "active" | "inactive" })}
              options={[
                { value: "active", label: "Active" },
                { value: "inactive", label: "Inactive" },
              ]}
            />
          </FormField>
        </div>
      </Modal>
    </div>
  );
}

function Modal(props: { open: boolean; onClose: () => void; title: string; description?: string; size?: "sm" | "md"; footer?: React.ReactNode; children: React.ReactNode }) {
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className={cn("w-full rounded-xl bg-white shadow-xl", props.size === "sm" ? "max-w-sm" : "max-w-lg")}>
        <div className="border-b border-slate-200 px-5 py-4">
          <h3 className="font-semibold text-slate-900">{props.title}</h3>
          {props.description && <p className="mt-0.5 text-xs text-slate-500">{props.description}</p>}
        </div>
        <div className="max-h-[70vh] overflow-auto p-5">{props.children}</div>
        {props.footer && <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">{props.footer}</div>}
      </div>
    </div>
  );
}

function Toggle({ label, description, checked, disabled, onChange }: { label: string; description?: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={cn("flex items-start justify-between gap-4 rounded-lg border p-3.5", disabled ? "border-slate-100 opacity-70" : "border-slate-200")}>
      <span>
        <span className="block text-sm font-medium text-slate-700">{label}</span>
        {description && <span className="block text-xs text-slate-400">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn("relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition", checked ? "bg-blue-600" : "bg-slate-300")}
      >
        <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white transition", checked ? "left-[18px]" : "left-0.5")} />
      </button>
    </label>
  );
}

function StoreSettingsForm({ canManage, saving, onSave, settings }: { canManage: boolean; saving: boolean; onSave: (f: Record<string, string | number | boolean>) => Promise<boolean>; settings: SettingsPayload["store"] }) {
  const [form, setForm] = useState(settings);
  const [prevSettings, setPrevSettings] = useState(settings);
  if (prevSettings !== settings) {
    setPrevSettings(settings);
    setForm(settings);
  }
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Store name" required>
          <Input value={form.storeName} disabled={!canManage} onChange={(e) => setForm({ ...form, storeName: e.target.value })} />
        </FormField>
        <FormField label="Logo URL">
          <Input value={form.logoUrl} disabled={!canManage} onChange={(e) => setForm({ ...form, logoUrl: e.target.value })} placeholder="https://…/logo.png" />
        </FormField>
        <FormField label="Address">
          <Input value={form.address} disabled={!canManage} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </FormField>
        <FormField label="Phone">
          <Input value={form.phone} disabled={!canManage} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </FormField>
        <FormField label="Email">
          <Input type="email" value={form.email} disabled={!canManage} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </FormField>
        <FormField label="Currency" hint="3-letter ISO code">
          <Input value={form.currency} disabled={!canManage} maxLength={3} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
        </FormField>
        <FormField label="Default tax %">
          <Input type="number" min="0" max="100" step="0.01" value={form.taxRate} disabled={!canManage} onChange={(e) => setForm({ ...form, taxRate: Number(e.target.value) })} />
        </FormField>
        <FormField label="Invoice prefix" hint="Invoice numbers start with this prefix">
          <Input value={form.invoicePrefix} disabled={!canManage} onChange={(e) => setForm({ ...form, invoicePrefix: e.target.value })} />
        </FormField>
      </div>
      {canManage && (
        <div className="flex justify-end pt-2">
          <Button
            loading={saving}
            onClick={() =>
              onSave({
                "store.name": form.storeName,
                "store.logo": form.logoUrl,
                "store.address": form.address,
                "store.phone": form.phone,
                "store.email": form.email,
                "store.currency": form.currency,
                "store.tax_rate": form.taxRate,
                "store.invoice_prefix": form.invoicePrefix,
              })
            }
          >
            <Save className="mr-2 h-4 w-4" />
            Save store settings
          </Button>
        </div>
      )}
    </>
  );
}

function PosSettingsForm({ canManage, saving, onSave, settings }: { canManage: boolean; saving: boolean; onSave: (f: Record<string, string | number | boolean>) => Promise<boolean>; settings: SettingsPayload["pos"] }) {
  const [form, setForm] = useState(settings);
  const [prevSettings, setPrevSettings] = useState(settings);
  if (prevSettings !== settings) {
    setPrevSettings(settings);
    setForm(settings);
  }
  const [maxDiscount, setMaxDiscount] = useState(String(settings.maxCashierDiscountPercent));
  const [prevMaxDiscount, setPrevMaxDiscount] = useState(settings.maxCashierDiscountPercent);
  if (prevMaxDiscount !== settings.maxCashierDiscountPercent) {
    setPrevMaxDiscount(settings.maxCashierDiscountPercent);
    setMaxDiscount(String(settings.maxCashierDiscountPercent));
  }

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-6">
      <Toggle
        label="Allow negative stock at POS"
        description="Cashiers can sell below zero stock when this is on"
        checked={form.allowNegativeStock}
        disabled={!canManage}
        onChange={(v) => setForm({ ...form, allowNegativeStock: v })}
      />
      <div className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 p-3.5">
        <div>
          <p className="text-sm font-medium text-slate-700">Maximum cashier discount %</p>
          <p className="text-xs text-slate-400">Discounts above this require a manager role</p>
        </div>
        <Input type="number" min="0" max="100" value={maxDiscount} disabled={!canManage} onChange={(e) => setMaxDiscount(e.target.value)} className="w-24" />
      </div>
      <Toggle
        label="Require customer for credit sales"
        description="Credit payments are blocked without a selected customer"
        checked={form.requireCustomerForCredit}
        disabled={!canManage}
        onChange={(v) => setForm({ ...form, requireCustomerForCredit: v })}
      />
      <Toggle label="Auto print receipt" description="Open the print dialog after each completed sale" checked={form.autoPrintReceipt} disabled={!canManage} onChange={(v) => setForm({ ...form, autoPrintReceipt: v })} />
      <Toggle
        label="Refund approval required"
        description="Returns need manager approval before the refund is issued"
        checked={form.refundRequiresApproval}
        disabled={!canManage}
        onChange={(v) => setForm({ ...form, refundRequiresApproval: v })}
      />
      <div className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 p-3.5">
        <div>
          <p className="text-sm font-medium text-slate-700">Default payment method</p>
          <p className="text-xs text-slate-400">Pre-selected at checkout</p>
        </div>
        <Select
          value={form.defaultPaymentMethod}
          disabled={!canManage}
          onChange={(v) => setForm({ ...form, defaultPaymentMethod: v })}
          options={[
            { value: "cash", label: "Cash" },
            { value: "card", label: "Card" },
            { value: "transfer", label: "Transfer" },
            { value: "credit", label: "Credit" },
          ]}
          className="w-36"
        />
      </div>
      {canManage && (
        <div className="flex justify-end pt-2">
          <Button
            loading={saving}
            onClick={() =>
              onSave({
                "pos.allow_negative_stock": form.allowNegativeStock,
                "pos.max_cashier_discount_percent": Number(maxDiscount) || 0,
                "pos.require_customer_for_credit": form.requireCustomerForCredit,
                "pos.auto_print_receipt": form.autoPrintReceipt,
                "pos.refund_requires_approval": form.refundRequiresApproval,
                "pos.default_payment_method": form.defaultPaymentMethod,
              })
            }
          >
            <Save className="mr-2 h-4 w-4" />
            Save POS settings
          </Button>
        </div>
      )}
    </div>
  );
}

function InventorySettingsForm({ canManage, saving, onSave, settings }: { canManage: boolean; saving: boolean; onSave: (f: Record<string, string | number | boolean>) => Promise<boolean>; settings: SettingsPayload["inventory"] }) {
  const [form, setForm] = useState(settings);
  const [prevSettings, setPrevSettings] = useState(settings);
  if (prevSettings !== settings) {
    setPrevSettings(settings);
    setForm(settings);
  }
  const [threshold, setThreshold] = useState(String(settings.lowStockThreshold));
  const [prevThreshold, setPrevThreshold] = useState(settings.lowStockThreshold);
  if (prevThreshold !== settings.lowStockThreshold) {
    setPrevThreshold(settings.lowStockThreshold);
    setThreshold(String(settings.lowStockThreshold));
  }

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-6">
      <div className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 p-3.5">
        <div>
          <p className="text-sm font-medium text-slate-700">Low stock threshold</p>
          <p className="text-xs text-slate-400">Default alert level for products without their own reorder point</p>
        </div>
        <Input type="number" min="0" value={threshold} disabled={!canManage} onChange={(e) => setThreshold(e.target.value)} className="w-24" />
      </div>
      <Toggle
        label="Allow negative inventory"
        description="Permit adjustments that take stock below zero"
        checked={form.allowNegativeInventory}
        disabled={!canManage}
        onChange={(v) => setForm({ ...form, allowNegativeInventory: v })}
      />
      <div className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 p-3.5">
        <div>
          <p className="text-sm font-medium text-slate-700">Inventory valuation method</p>
          <p className="text-xs text-slate-400">Used for stock value reports</p>
        </div>
        <Select
          value={form.inventoryValuation}
          disabled={!canManage}
          onChange={(v) => setForm({ ...form, inventoryValuation: v })}
          options={[
            { value: "average", label: "Average cost" },
            { value: "fifo", label: "FIFO" },
            { value: "standard", label: "Standard cost" },
          ]}
          className="w-40"
        />
      </div>
      {canManage && (
        <div className="flex justify-end pt-2">
          <Button
            loading={saving}
            onClick={() =>
              onSave({
                "inventory.low_stock_threshold": Number(threshold) || 0,
                "inventory.allow_negative": form.allowNegativeInventory,
                "inventory.valuation": form.inventoryValuation,
              })
            }
          >
            <Save className="mr-2 h-4 w-4" />
            Save inventory settings
          </Button>
        </div>
      )}
    </div>
  );
}
