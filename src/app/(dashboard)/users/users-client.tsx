"use client";

import { useCallback, useEffect, useState } from "react";
import { Table, EmptyState, Button, Modal, SearchInput, FormField, Input, Select } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Pagination } from "@/components/ui/pagination";
import { success, error } from "@/utils/toast";
import { cn } from "@/utils/classname";
import { Plus, Edit, Trash, Key, Activity } from "@/components/ui/icons";

interface UsersClientProps {
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

interface UserRow {
  _id: string;
  name: string;
  email: string;
  phone: string;
  status: "active" | "inactive" | "pending";
  roleId: string | null;
  roleName: string | null;
  branchId: string | null;
  branchName: string | null;
  lastLoginAt: string | Date | null;
  createdAt: string | Date;
}

interface RoleOption {
  _id: string;
  name: string;
  userCount?: number;
}

interface BranchOption {
  _id: string;
  name: string;
  status: string;
}

interface ActivityData {
  user: { id: string; name: string; email: string };
  salesLast30d: number;
  activity: Array<{ _id: string; action: string; entityType: string; note: string | null; createdAt: string }>;
}

const EMPTY_FORM = {
  name: "",
  email: "",
  phone: "",
  password: "",
  roleId: "",
  branchId: "",
  status: "active" as "active" | "inactive",
};

export function UsersClient({ canCreate, canUpdate, canDelete }: UsersClientProps) {
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage] = useState(15);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "edit" | null>(null);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [pwTarget, setPwTarget] = useState<UserRow | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [pwSaving, setPwSaving] = useState(false);

  const [activityTarget, setActivityTarget] = useState<UserRow | null>(null);
  const [activity, setActivity] = useState<ActivityData | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {

    try {
      const params = new URLSearchParams({ page: String(page), perPage: String(perPage), status: statusFilter });
      if (search) params.set("search", search);
      const res = await fetch(`/api/users?${params}`);
      if (!res.ok) throw new Error("Failed to load users");
      const data = await res.json();
      setUsers(data.users ?? []);
      setTotal(data.total ?? 0);
    } catch {
      error("Error", "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, [page, perPage, search, statusFilter]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  useEffect(() => {
    (async () => {
      try {
        const [rolesRes, branchesRes] = await Promise.all([fetch("/api/roles"), fetch("/api/branches")]);
        if (rolesRes.ok) {
          const rd = await rolesRes.json();
          setRoles(rd.roles ?? []);
        }
        if (branchesRes.ok) {
          const bd = await branchesRes.json();
          setBranches(bd.branches ?? []);
        }
      } catch {
        // filters degrade gracefully
      }
    })();
  }, []);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setErrors({});
    setEditing(null);
    setMode("create");
    setModalOpen(true);
  };

  const openEdit = (u: UserRow) => {
    setForm({
      name: u.name,
      email: u.email,
      phone: u.phone ?? "",
      password: "",
      roleId: u.roleId ?? "",
      branchId: u.branchId ?? "",
      status: u.status === "inactive" ? "inactive" : "active",
    });
    setErrors({});
    setEditing(u);
    setMode("edit");
    setModalOpen(true);
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!form.name.trim() || form.name.trim().length < 2) errs.name = "Name must be at least 2 characters";
    if (!form.roleId) errs.roleId = "Role is required";
    if (mode === "create") {
      if (!/^\S+@\S+\.\S+$/.test(form.email)) errs.email = "Valid email is required";
      if (form.password.length < 8) errs.password = "Password must be at least 8 characters";
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const save = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const payload =
        mode === "create"
          ? {
              name: form.name.trim(),
              email: form.email.trim(),
              phone: form.phone.trim(),
              password: form.password,
              roleId: form.roleId,
              branchId: form.branchId || null,
            }
          : {
              action: "update",
              data: {
                id: editing!._id,
                name: form.name.trim(),
                phone: form.phone.trim(),
                status: form.status,
                roleId: form.roleId || undefined,
                branchId: form.branchId || null,
              },
            };
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", data?.error?.message ?? (typeof data?.error === "string" ? data.error : "Failed to save user"));
        return;
      }
      success("Success", mode === "create" ? "User created" : "User updated");
      setModalOpen(false);
      setMode(null);
      load();
    } catch {
      error("Error", "Failed to save user");
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (u: UserRow) => {
    setBusyId(u._id);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: u.status === "active" ? "deactivate" : "activate", id: u._id }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", data?.error?.message ?? "Failed to change status");
        return;
      }
      success("Success", data.message ?? "Status updated");
      load();
    } catch {
      error("Error", "Failed to change status");
    } finally {
      setBusyId(null);
    }
  };

  const submitPassword = async () => {
    if (!pwTarget) return;
    if (newPassword.length < 8) {
      error("Error", "Password must be at least 8 characters");
      return;
    }
    setPwSaving(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "change-password", data: { id: pwTarget._id, newPassword } }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", data?.error?.message ?? "Failed to change password");
        return;
      }
      success("Password updated", `${pwTarget.name} must sign in with the new password`);
      setPwTarget(null);
      setNewPassword("");
    } catch {
      error("Error", "Failed to change password");
    } finally {
      setPwSaving(false);
    }
  };

  const openActivity = async (u: UserRow) => {
    setActivityTarget(u);
    setActivity(null);
    setActivityLoading(true);
    try {
      const res = await fetch(`/api/users/${u._id}/activity`);
      if (!res.ok) throw new Error();
      setActivity(await res.json());
    } catch {
      error("Error", "Failed to load activity");
    } finally {
      setActivityLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/users", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deleteTarget._id }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", data?.error?.message ?? "Failed to delete user");
        return;
      }
      success("Success", data.message ?? "User deleted");
      setDeleteTarget(null);
      load();
    } catch {
      error("Error", "Failed to delete user");
    } finally {
      setDeleting(false);
    }
  };

  const totalPages = Math.ceil(total / perPage);

  const columns = [
    {
      key: "name",
      header: "User",
      render: (u: UserRow) => (
        <div>
          <p className="font-medium text-slate-900">{u.name}</p>
          <p className="text-xs text-slate-400">{u.email}</p>
        </div>
      ),
    },
    { key: "role", header: "Role", render: (u: UserRow) => u.roleName ?? "—" },
    { key: "branch", header: "Branch", render: (u: UserRow) => u.branchName ?? "All branches" },
    {
      key: "status",
      header: "Status",
      render: (u: UserRow) => (
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-medium",
            u.status === "active" ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"
          )}
        >
          {u.status}
        </span>
      ),
    },
    {
      key: "lastLogin",
      header: "Last login",
      render: (u: UserRow) => (u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "—"),
    },
    {
      key: "actions",
      header: "",
      className: "w-56",
      render: (u: UserRow) => (
        <div className="flex items-center justify-end gap-1">
          {canUpdate && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleStatus(u);
                }}
                disabled={busyId === u._id}
                className={cn(
                  "rounded-lg px-2 py-1 text-xs font-medium",
                  u.status === "active" ? "text-amber-700 hover:bg-amber-50" : "text-green-700 hover:bg-green-50"
                )}
                title={u.status === "active" ? "Deactivate" : "Activate"}
              >
                {u.status === "active" ? "Deactivate" : "Activate"}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setPwTarget(u);
                  setNewPassword("");
                }}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                title="Change password"
              >
                <Key className="h-4 w-4" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  openActivity(u);
                }}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                title="View activity"
              >
                <Activity className="h-4 w-4" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  openEdit(u);
                }}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                title="Edit"
              >
                <Edit className="h-4 w-4" />
              </button>
            </>
          )}
          {canDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setDeleteTarget(u);
              }}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
              title="Delete"
            >
              <Trash className="h-4 w-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Users & Access" }]} />
      <PageHeader
        title="Users"
        description="Create accounts, assign roles and branches, control access"
        actions={canCreate ? <Button onClick={openCreate}><Plus className="mr-2 h-4 w-4" />Add User</Button> : null}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-[200px] flex-1">
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Search by name, email or phone..."
            className="max-w-sm"
          />
        </div>
        <div className="w-36">
          <Select
            value={statusFilter}
            onChange={(v) => {
              setStatusFilter(v);
              setPage(1);
            }}
            options={[
              { value: "", label: "All statuses" },
              { value: "active", label: "Active" },
              { value: "inactive", label: "Inactive" },
            ]}
            className="w-full"
          />
        </div>
      </div>

      <Table
        columns={columns}
        data={users}
        keyExtractor={(u) => u._id}
        loading={loading}
        empty={<EmptyState label="No users" description="Create the first user account to get started." />}
      />

      {totalPages > 1 && (
        <div className="mt-4">
          <Pagination page={page} totalPages={totalPages} totalItems={total} itemsPerPage={perPage} onPageChange={setPage} />
        </div>
      )}

      {/* Create / edit modal */}
      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setMode(null);
        }}
        title={mode === "create" ? "Add User" : "Edit User"}
        size="md"
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
          <FormField label="Full name" required error={errors.name}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="User name" />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Email" required error={errors.email}>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="user@example.com"
                disabled={mode === "edit"}
              />
            </FormField>
            <FormField label="Phone">
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Phone (optional)" />
            </FormField>
          </div>
          {mode === "create" && (
            <FormField label="Password" required error={errors.password}>
              <Input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="Minimum 8 characters"
                autoComplete="new-password"
              />
            </FormField>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Role" required error={errors.roleId}>
              <Select
                value={form.roleId}
                onChange={(v) => setForm({ ...form, roleId: v })}
                options={[{ value: "", label: "Select role..." }, ...roles.map((r) => ({ value: r._id, label: r.name }))]}
              />
            </FormField>
            <FormField label="Branch">
              <Select
                value={form.branchId}
                onChange={(v) => setForm({ ...form, branchId: v })}
                options={[{ value: "", label: "All branches (unrestricted)" }, ...branches.map((b) => ({ value: b._id, label: b.name }))]}
              />
            </FormField>
          </div>
          {mode === "edit" && (
            <FormField label="Status">
              <Select
                value={form.status}
                onChange={(v) => setForm({ ...form, status: v as "active" | "inactive" })}
                options={[
                  { value: "active", label: "Active" },
                  { value: "inactive", label: "Inactive" },
                ]}
              />
            </FormField>
          )}
        </div>
      </Modal>

      {/* Change password modal */}
      <Modal
        open={pwTarget !== null}
        onClose={() => setPwTarget(null)}
        title={`Change password — ${pwTarget?.name ?? ""}`}
        description="The user will be signed out of all devices."
        size="sm"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setPwTarget(null)}>
            Cancel
          </Button>,
          <Button key="save" loading={pwSaving} onClick={submitPassword}>
            Update password
          </Button>,
        ]}
      >
        <FormField label="New password" required>
          <Input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Minimum 8 characters"
            autoComplete="new-password"
          />
        </FormField>
      </Modal>

      {/* Activity modal */}
      <Modal
        open={activityTarget !== null}
        onClose={() => setActivityTarget(null)}
        title={`Activity — ${activityTarget?.name ?? ""}`}
        description={activity ? `${activity.salesLast30d} sales in the last 30 days` : undefined}
        size="md"
      >
        {activityLoading ? (
          <p className="py-6 text-center text-sm text-slate-400">Loading activity…</p>
        ) : activity && activity.activity.length > 0 ? (
          <ul className="max-h-80 space-y-1 overflow-auto">
            {activity.activity.map((a) => (
              <li key={a._id} className="flex items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-slate-50">
                <div>
                  <p className="font-medium text-slate-700">{a.action}</p>
                  <p className="text-xs text-slate-400">
                    {a.entityType}
                    {a.note ? ` — ${a.note}` : ""}
                  </p>
                </div>
                <span className="whitespace-nowrap text-xs text-slate-400">{new Date(a.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState label="No recent activity" description="Actions from the last 30 days will appear here." />
        )}
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete user"
        message={`Delete "${deleteTarget?.name}"? Users with sales history are deactivated instead of deleted. The final Super Admin can never be removed.`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
