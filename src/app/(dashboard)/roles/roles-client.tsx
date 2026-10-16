"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Modal, FormField, Input, EmptyState } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { ConfirmDialog } from "@/components/ui/confirm";
import { success, error } from "@/utils/toast";
import { cn } from "@/utils/classname";
import { Plus, Edit, Trash, Copy, Shield } from "@/components/ui/icons";

interface RolesClientProps {
  canManage: boolean;
}

interface RoleRow {
  _id: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: Array<{ _id: string; name: string }>;
  permissionNames: string[];
  userCount: number;
}

interface PermissionRow {
  _id: string;
  name: string;
  description: string;
  category: string;
}

export function RolesClient({ canManage }: RolesClientProps) {
  const [loading, setLoading] = useState(true);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [permissions, setPermissions] = useState<PermissionRow[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [draftPerms, setDraftPerms] = useState<Set<string>>(new Set());
  const [savingPerms, setSavingPerms] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", description: "" });
  const [createError, setCreateError] = useState("");
  const [creating, setCreating] = useState(false);

  const [cloneTarget, setCloneTarget] = useState<RoleRow | null>(null);
  const [cloneName, setCloneName] = useState("");
  const [cloning, setCloning] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<RoleRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {

    try {
      const res = await fetch("/api/roles");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setRoles(data.roles ?? []);
      setPermissions(data.permissions ?? []);
      setSelectedRoleId((prev) => prev ?? data.roles?.[0]?._id ?? null);
    } catch {
      error("Error", "Failed to load roles");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const selectedRole = useMemo(() => roles.find((r) => r._id === selectedRoleId) ?? null, [roles, selectedRoleId]);

  const [prevSelectedRole, setPrevSelectedRole] = useState(selectedRole);
  if (prevSelectedRole !== selectedRole) {
    setPrevSelectedRole(selectedRole);
    if (selectedRole) setDraftPerms(new Set(selectedRole.permissions.map((p) => p._id)));
  }

  const categories = useMemo(() => {
    const map = new Map<string, PermissionRow[]>();
    for (const p of permissions) {
      const list = map.get(p.category) ?? [];
      list.push(p);
      map.set(p.category, list);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [permissions]);

  const dirty = useMemo(() => {
    if (!selectedRole) return false;
    const current = new Set(selectedRole.permissions.map((p) => p._id));
    return current.size !== draftPerms.size || Array.from(draftPerms).some((id) => !current.has(id));
  }, [selectedRole, draftPerms]);

  const togglePerm = (id: string) => {
    setDraftPerms((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleCategory = (perms: PermissionRow[]) => {
    const allSelected = perms.every((p) => draftPerms.has(p._id));
    setDraftPerms((prev) => {
      const next = new Set(prev);
      for (const p of perms) {
        if (allSelected) next.delete(p._id);
        else next.add(p._id);
      }
      return next;
    });
  };

  const savePermissions = async () => {
    if (!selectedRole) return;
    setSavingPerms(true);
    try {
      const res = await fetch("/api/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", id: selectedRole._id, permissions: Array.from(draftPerms) }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", data?.error?.message ?? "Failed to save permissions");
        return;
      }
      success("Permissions saved", `${selectedRole.name} updated`);
      await load();
    } catch {
      error("Error", "Failed to save permissions");
    } finally {
      setSavingPerms(false);
    }
  };

  const createRole = async () => {
    setCreateError("");
    if (createForm.name.trim().length < 2) {
      setCreateError("Role name must be at least 2 characters");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: createForm.name.trim(), description: createForm.description.trim(), permissions: [] }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCreateError(data?.error?.message ?? "Failed to create role");
        return;
      }
      success("Role created", createForm.name);
      setCreateOpen(false);
      setCreateForm({ name: "", description: "" });
      await load();
    } catch {
      setCreateError("Failed to create role");
    } finally {
      setCreating(false);
    }
  };

  const cloneRole = async () => {
    if (!cloneTarget) return;
    setCloning(true);
    try {
      const res = await fetch("/api/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clone", id: cloneTarget._id, name: cloneName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", data?.error?.message ?? "Failed to clone role");
        return;
      }
      success("Role cloned", cloneName);
      setCloneTarget(null);
      setCloneName("");
      await load();
    } catch {
      error("Error", "Failed to clone role");
    } finally {
      setCloning(false);
    }
  };

  const deleteRole = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/roles", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deleteTarget._id }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", data?.error?.message ?? "Failed to delete role");
        return;
      }
      success("Role deleted", deleteTarget.name);
      setDeleteTarget(null);
      setSelectedRoleId(null);
      await load();
    } catch {
      error("Error", "Failed to delete role");
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl">
        <Breadcrumbs items={[{ label: "Roles" }]} />
        <PageHeader title="Roles & Permissions" description="Define what each role can do" />
        <p className="py-10 text-center text-sm text-slate-400">Loading roles…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Roles" }]} />
      <PageHeader
        title="Roles & Permissions"
        description="Define roles and control exactly what each role can do"
        actions={
          canManage ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add Role
            </Button>
          ) : null
        }
      />

      {roles.length === 0 ? (
        <EmptyState label="No roles" description="Create a role to get started." />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          {/* Role list */}
          <div className="space-y-2">
            {roles.map((role) => (
              <button
                key={role._id}
                onClick={() => setSelectedRoleId(role._id)}
                className={cn(
                  "w-full rounded-xl border p-4 text-left transition",
                  role._id === selectedRoleId ? "border-blue-500 bg-blue-50" : "border-slate-200 bg-white hover:border-slate-300"
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 font-semibold text-slate-900">
                    <Shield className={cn("h-4 w-4", role.isSystem ? "text-blue-600" : "text-slate-400")} />
                    {role.name}
                  </span>
                  {role.isSystem && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-500">System</span>
                  )}
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {role.permissions.length} permissions · {role.userCount} users
                </p>
                {canManage && (
                  <div className="mt-2 flex gap-1">
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label="Clone role"
                      onClick={(e) => {
                        e.stopPropagation();
                        setCloneTarget(role);
                        setCloneName(`${role.name} Copy`);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), setCloneTarget(role), setCloneName(`${role.name} Copy`))}
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </span>
                    {!role.isSystem && role.userCount === 0 && (
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label="Delete role"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(role);
                        }}
                        onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), setDeleteTarget(role))}
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </div>
                )}
              </button>
            ))}
          </div>

          {/* Permission matrix */}
          <div className="rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <div>
                <h3 className="font-semibold text-slate-900">{selectedRole?.name ?? "Select a role"}</h3>
                <p className="text-xs text-slate-500">{selectedRole?.description || "Toggle permissions and save"}</p>
              </div>
              {canManage && selectedRole && (
                <Button onClick={savePermissions} loading={savingPerms} disabled={!dirty}>
                  {dirty ? "Save changes" : "Saved"}
                </Button>
              )}
            </div>
            <div className="max-h-[560px] overflow-auto p-5">
              {categories.map(([category, perms]) => {
                const allSelected = perms.every((p) => draftPerms.has(p._id));
                const someSelected = perms.some((p) => draftPerms.has(p._id));
                return (
                  <div key={category} className="mb-5 last:mb-0">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{category}</p>
                      {canManage && (
                        <button onClick={() => toggleCategory(perms)} className="text-xs font-medium text-blue-600 hover:underline">
                          {allSelected ? "Unselect all" : someSelected ? "Select all" : "Select all"}
                        </button>
                      )}
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {perms.map((p) => {
                        const checked = draftPerms.has(p._id);
                        return (
                          <label
                            key={p._id}
                            className={cn(
                              "flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm transition",
                              checked ? "border-blue-300 bg-blue-50" : "border-slate-200 hover:border-slate-300"
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!canManage}
                              onChange={() => togglePerm(p._id)}
                              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                            />
                            <span>
                              <span className="block font-medium text-slate-700">{p.name}</span>
                              {p.description && <span className="block text-xs text-slate-400">{p.description}</span>}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Create modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Add Role"
        size="sm"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setCreateOpen(false)}>
            Cancel
          </Button>,
          <Button key="create" loading={creating} onClick={createRole}>
            Create
          </Button>,
        ]}
      >
        <div className="space-y-4">
          <FormField label="Role name" required error={createError}>
            <Input value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} placeholder="e.g. Store Supervisor" />
          </FormField>
          <FormField label="Description">
            <Input value={createForm.description} onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })} placeholder="What does this role do?" />
          </FormField>
        </div>
      </Modal>

      {/* Clone modal */}
      <Modal
        open={cloneTarget !== null}
        onClose={() => setCloneTarget(null)}
        title={`Clone role — ${cloneTarget?.name ?? ""}`}
        description="The copy starts with the same permissions."
        size="sm"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setCloneTarget(null)}>
            Cancel
          </Button>,
          <Button key="clone" loading={cloning} onClick={cloneRole}>
            Clone
          </Button>,
        ]}
      >
        <FormField label="New role name" required>
          <Input value={cloneName} onChange={(e) => setCloneName(e.target.value)} placeholder="Role name" />
        </FormField>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={deleteRole}
        title="Delete role"
        message={`Delete "${deleteTarget?.name}"? Only roles with no assigned users can be deleted.`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
