"use client";

import { useCallback, useEffect, useState } from "react";
import { SessionUser } from "@/lib/session";
import { Table, EmptyState, Button, Modal, Input, Textarea, FormField, Select } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { ConfirmDialog } from "@/components/ui/confirm";
import { success, error } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/utils/classname";
import { Plus, Edit } from "@/components/ui/icons";

interface DepartmentRow {
  _id: string;
  name: string;
  code: string;
  branchId: string | null;
  branchName: string | null;
  employeeId: string | null;
  employeeName: string | null;
  employeeEmail: string | null;
  status: "active" | "inactive";
  note: string;
  deactivatedAt: string | null;
}

interface EmployeeOption {
  _id: string;
  name: string;
  email: string;
  branchId: string | null;
}

interface BranchOption {
  _id: string;
  name: string;
  code: string;
  status: string;
  type: string;
}

interface DepartmentsClientProps {
  user: SessionUser;
  canCreate: boolean;
  canUpdate: boolean;
  canDeactivate: boolean;
}

const emptyForm = {
  name: "",
  code: "",
  branchId: "",
  employeeId: "",
  note: "",
  status: "active" as "active" | "inactive",
};

export function DepartmentsClient({ user, canCreate, canUpdate, canDeactivate }: DepartmentsClientProps) {
  const [loading, setLoading] = useState(true);
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "edit">("create");
  const [editing, setEditing] = useState<DepartmentRow | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [statusTarget, setStatusTarget] = useState<DepartmentRow | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);

  // Branch-restricted users only ever see their own shop, so the branch select
  // is only meaningful for HQ users.
  const branchLocked = Boolean(user.branchId);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/departments?all=${showInactive ? "1" : "0"}`);
      const data = await res.json();
      if (!res.ok) throw new Error(apiErrorMessage(data, "Failed to load departments"));
      setDepartments(data.departments ?? []);
      setEmployees(data.employees ?? []);
      setBranches(data.branches ?? []);
      if (!user.branchId) {
        setForm((prev) => (prev.branchId ? prev : { ...prev, branchId: data.branches?.[0]?._id ?? "" }));
      }
    } catch (err) {
      error("Error", err instanceof Error ? err.message : "Failed to load departments");
    } finally {
      setLoading(false);
    }
  }, [showInactive, user.branchId]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const openCreate = () => {
    setForm({ ...emptyForm, branchId: user.branchId ?? branches[0]?._id ?? "" });
    setErrors({});
    setEditing(null);
    setMode("create");
    setModalOpen(true);
  };

  const openEdit = (row: DepartmentRow) => {
    setForm({
      name: row.name,
      code: row.code,
      branchId: row.branchId ?? user.branchId ?? "",
      employeeId: row.employeeId ?? "",
      note: row.note,
      status: row.status,
    });
    setErrors({});
    setEditing(row);
    setMode("edit");
    setModalOpen(true);
  };

  const employeeOptions = employees
    .filter((e) => (form.branchId ? e.branchId === form.branchId : true))
    .map((e) => ({ value: e._id, label: `${e.name}${e.email ? ` — ${e.email}` : ""}` }));

  const save = async () => {
    const errs: Record<string, string> = {};
    if (form.name.trim().length < 2) errs.name = "Name is required";
    if (!form.employeeId) errs.employeeId = "Select the employee who heads this department";
    if (!form.branchId && !user.branchId) errs.branchId = "Select a shop";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSaving(true);
    try {
      const payload =
        mode === "create"
          ? {
              name: form.name.trim(),
              code: form.code.trim(),
              branchId: form.branchId || undefined,
              employeeId: form.employeeId,
              note: form.note.trim(),
              status: form.status,
            }
          : {
              id: editing?._id,
              name: form.name.trim(),
              code: form.code.trim(),
              employeeId: form.employeeId,
              note: form.note.trim(),
            };
      const res = await fetch("/api/departments", {
        method: mode === "create" ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to save department"));
        return;
      }
      success("Success", mode === "create" ? "Department created" : "Department updated");
      setModalOpen(false);
      await load();
    } catch {
      error("Error", "Failed to save department");
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async () => {
    if (!statusTarget) return;
    setStatusBusy(true);
    try {
      const action = statusTarget.status === "active" ? "deactivate" : "activate";
      const res = await fetch("/api/departments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id: statusTarget._id }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to update department status"));
        return;
      }
      success("Success", action === "deactivate" ? "Department deactivated" : "Department activated");
      setStatusTarget(null);
      await load();
    } catch {
      error("Error", "Failed to update department status");
    } finally {
      setStatusBusy(false);
    }
  };

  const columns = [
    {
      key: "name",
      header: "Department",
      render: (row: DepartmentRow) => (
        <div>
          <span className="font-medium text-slate-900">{row.name}</span>
          {row.code ? <span className="ms-2 text-xs text-slate-500">{row.code}</span> : null}
        </div>
      ),
    },
    { key: "branch", header: "Shop", render: (row: DepartmentRow) => row.branchName ?? "—" },
    {
      key: "employee",
      header: "Head employee",
      render: (row: DepartmentRow) => (
        <div>
          <div className="text-slate-900">{row.employeeName ?? "Unassigned"}</div>
          {row.employeeEmail ? <div className="text-xs text-slate-500">{row.employeeEmail}</div> : null}
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row: DepartmentRow) => (
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-medium",
            row.status === "active" ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"
          )}
        >
          {row.status}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      className: "w-32",
      render: (row: DepartmentRow) => (
        <div className="flex items-center justify-end gap-1">
          {canUpdate && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                openEdit(row);
              }}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              title="Edit"
            >
              <Edit className="h-4 w-4" />
            </button>
          )}
          {canDeactivate && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setStatusTarget(row);
              }}
              className="rounded-lg px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            >
              {row.status === "active" ? "Deactivate" : "Activate"}
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <Breadcrumbs items={[{ label: "Departments" }]} />
      <PageHeader
        title="Departments"
        description="Each department belongs to a shop and is headed by one employee."
        actions={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              Show inactive
            </label>
            {canCreate && (
              <Button onClick={openCreate}>
                <Plus className="mr-2 h-4 w-4" />
                Add Department
              </Button>
            )}
          </div>
        }
      />

      <Table
        columns={columns}
        data={departments}
        keyExtractor={(row) => row._id}
        loading={loading}
        empty={<EmptyState label="No departments" description="Create the first department for this shop." />}
      />

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={mode === "create" ? "Add Department" : "Edit Department"}
        size="sm"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setModalOpen(false)}>
            Cancel
          </Button>,
          <Button key="save" loading={saving} onClick={save}>
            {mode === "create" ? "Create" : "Save"}
          </Button>,
        ]}
      >
        <div className="space-y-4">
          <FormField label="Name" required error={errors.name}>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Cosmetics"
            />
          </FormField>

          <FormField label="Code">
            <Input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              placeholder="Optional short code"
            />
          </FormField>

          {!branchLocked && (
            <FormField label="Shop" required error={errors.branchId}>
              <Select
                value={form.branchId}
                onChange={(v) => setForm({ ...form, branchId: v, employeeId: "" })}
                options={branches
                  .filter((b) => b.type !== "warehouse" && b.status === "active")
                  .map((b) => ({ value: b._id, label: b.name }))}
              />
            </FormField>
          )}

          <FormField label="Head employee" required error={errors.employeeId}>
            <Select
              value={form.employeeId}
              onChange={(v) => setForm({ ...form, employeeId: v })}
              options={employeeOptions}
              placeholder="Select an employee"
            />
          </FormField>

          <FormField label="Note">
            <Textarea
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="Optional note"
              rows={2}
            />
          </FormField>
        </div>
      </Modal>

      <ConfirmDialog
        open={statusTarget !== null}
        onClose={() => setStatusTarget(null)}
        onConfirm={toggleStatus}
        title={statusTarget?.status === "active" ? "Deactivate department" : "Activate department"}
        message={
          statusTarget?.status === "active"
            ? `Deactivate "${statusTarget?.name}"? Historical sales stay attributed to it; new sales are recorded as unassigned unless the employee heads another department.`
            : `Reactivate "${statusTarget?.name}"?`
        }
        confirmLabel={statusTarget?.status === "active" ? "Deactivate" : "Activate"}
        variant={statusTarget?.status === "active" ? "danger" : "primary"}
        loading={statusBusy}
      />
    </div>
  );
}
