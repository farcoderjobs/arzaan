import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Role, PermissionModel, User } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { success, badRequest, forbidden, notFound } from "@/lib/api";
import { recordAuditLog, requestMeta, diffForAudit } from "@/lib/audit";
import { clearPermissionCache } from "@/lib/authorization";

/**
 * Roles API.
 * GET    /api/roles                 → all roles with permission ids + names
 * POST   /api/roles                 → create | update (permissions) | clone
 * DELETE /api/roles                 → delete a non-system role with no assigned users
 */

const permissionIdsSchema = z.array(z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid permission id"));

const createSchema = z.object({
  name: z.string().min(2, "Role name is required").max(60).regex(/^[a-zA-Z0-9 _-]+$/, "Letters, numbers, spaces, - and _ only"),
  description: z.string().max(300).default(""),
  permissions: permissionIdsSchema.default([]),
});

const updateSchema = z.object({
  action: z.literal("update"),
  id: z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid role id"),
  name: z.string().min(2).max(60).regex(/^[a-zA-Z0-9 _-]+$/).optional(),
  description: z.string().max(300).optional(),
  permissions: permissionIdsSchema.optional(),
});

const cloneSchema = z.object({
  action: z.literal("clone"),
  id: z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid role id"),
  name: z.string().min(2).max(60).regex(/^[a-zA-Z0-9 _-]+$/),
});

const bodySchema = z.discriminatedUnion("action", [updateSchema, cloneSchema]);

function fieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  err.errors.forEach((e) => {
    const path = e.path[0];
    if (typeof path === "string") out[path] = e.message;
  });
  return out;
}

export async function GET() {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.roles.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const [roles, permissions] = await Promise.all([
      Role.find({}).sort({ name: 1 }).populate<{ permissions: Array<{ _id: mongoose.Types.ObjectId; name: string }> }>("permissions", "name").lean(),
      PermissionModel.find({}).sort({ category: 1, name: 1 }).lean(),
    ]);

    const usersByRole = await User.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
      { $group: { _id: "$roleId", count: { $sum: 1 } } },
    ]);
    const userCounts = new Map(usersByRole.map((r) => [r._id.toString(), r.count]));

    return NextResponse.json({
      roles: roles.map((r) => ({
        _id: r._id.toString(),
        name: r.name,
        description: r.description,
        isSystem: r.isSystem,
        permissions: (r.permissions ?? []).map((p) => ({ _id: p._id.toString(), name: p.name })),
        permissionNames: (r.permissions ?? []).map((p) => p.name),
        userCount: userCounts.get(r._id.toString()) ?? 0,
      })),
      permissions: permissions.map((p) => ({
        _id: p._id.toString(),
        name: p.name,
        description: p.description,
        category: p.category,
      })),
    });
  } catch (error) {
    console.error("GET /api/roles error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.roles.manage))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }
    const meta = requestMeta(req);
    const body = await req.json();

    // ---------- Create ----------
    if (body && typeof body === "object" && !("action" in body)) {
      const parsed = createSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(badRequest("Validation failed", fieldErrors(parsed.error)), { status: 400 });
      }
      const data = parsed.data;

      const existing = await Role.findOne({ name: data.name.trim() });
      if (existing) return NextResponse.json(badRequest("A role with this name already exists"), { status: 400 });

      const validPerms = await PermissionModel.countDocuments({ _id: { $in: data.permissions.map((p) => new mongoose.Types.ObjectId(p)) } });
      if (validPerms !== data.permissions.length) {
        return NextResponse.json(badRequest("One or more permissions do not exist"), { status: 400 });
      }

      const role = await Role.create({
        name: data.name.trim(),
        description: data.description.trim(),
        isSystem: false,
        permissions: data.permissions.map((p) => new mongoose.Types.ObjectId(p)),
      });

      await recordAuditLog({
        user,
        action: "role.create",
        entityType: "Role",
        entityId: role._id.toString(),
        newValue: { name: role.name, permissions: data.permissions },
        ...meta,
      });

      return NextResponse.json(success({ id: role._id.toString() }, "Role created"), { status: 201 });
    }

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(badRequest("Validation failed", fieldErrors(parsed.error)), { status: 400 });
    }
    const payload = parsed.data;

    const role = await Role.findById(payload.id);
    if (!role) return NextResponse.json(notFound("Role not found"), { status: 404 });

    // ---------- Update ----------
    if (payload.action === "update") {
      const before = {
        name: role.name,
        description: role.description,
        permissions: (role.permissions ?? []).map((p) => p.toString()),
      };

      if (payload.permissions !== undefined) {
        const validPerms = await PermissionModel.countDocuments({ _id: { $in: payload.permissions.map((p) => new mongoose.Types.ObjectId(p)) } });
        if (validPerms !== payload.permissions.length) {
          return NextResponse.json(badRequest("One or more permissions do not exist"), { status: 400 });
        }
        // Guard: cannot strip permissions from the SuperAdmin role while users depend on it.
        if (role.name === "SuperAdmin") {
          const adminUsers = await User.countDocuments({ roleId: role._id, status: "active" });
          if (adminUsers > 0 && payload.permissions.length === 0) {
            return NextResponse.json(badRequest("Cannot remove all permissions from the SuperAdmin role while active users hold it"), { status: 400 });
          }
        }
        role.permissions = payload.permissions.map((p) => new mongoose.Types.ObjectId(p));
      }
      if (payload.name !== undefined) {
        if (role.isSystem && payload.name !== role.name) {
          return NextResponse.json(badRequest("System roles cannot be renamed"), { status: 400 });
        }
        const dupe = await Role.findOne({ name: payload.name.trim(), _id: { $ne: role._id } });
        if (dupe) return NextResponse.json(badRequest("A role with this name already exists"), { status: 400 });
        role.name = payload.name.trim();
      }
      if (payload.description !== undefined) role.description = payload.description;

      await role.save();
      clearPermissionCache();

      await recordAuditLog({
        user,
        action: "role.update",
        entityType: "Role",
        entityId: role._id.toString(),
        changes: diffForAudit(before, { name: role.name, description: role.description, permissions: (role.permissions ?? []).map((p) => p.toString()) }),
        ...meta,
      });

      return NextResponse.json(success({ id: role._id.toString() }, "Role updated"));
    }

    // ---------- Clone ----------
    const dupe = await Role.findOne({ name: payload.name.trim() });
    if (dupe) return NextResponse.json(badRequest("A role with this name already exists"), { status: 400 });

    const clone = await Role.create({
      name: payload.name.trim(),
      description: role.description ? `Clone of ${role.name}: ${role.description}`.slice(0, 300) : `Clone of ${role.name}`,
      isSystem: false,
      permissions: role.permissions ?? [],
    });

    await recordAuditLog({
      user,
      action: "role.clone",
      entityType: "Role",
      entityId: clone._id.toString(),
      note: `Cloned from ${role.name}`,
      newValue: { name: clone.name, permissions: (role.permissions ?? []).map((p) => p.toString()) },
      ...meta,
    });

    return NextResponse.json(success({ id: clone._id.toString() }, "Role cloned"), { status: 201 });
  } catch (error) {
    console.error("POST /api/roles error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.roles.manage))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }
    const meta = requestMeta(req);

    const { id } = (await req.json()) as { id?: string };
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(badRequest("Role ID is required"), { status: 400 });
    }

    const role = await Role.findById(id);
    if (!role) return NextResponse.json(notFound("Role not found"), { status: 404 });

    if (role.isSystem) {
      return NextResponse.json(badRequest("System roles cannot be deleted"), { status: 400 });
    }

    const assignedUsers = await User.countDocuments({ roleId: role._id });
    if (assignedUsers > 0) {
      return NextResponse.json(badRequest(`Cannot delete: ${assignedUsers} user(s) still hold this role`), { status: 400 });
    }

    await recordAuditLog({ user, action: "role.delete", entityType: "Role", entityId: role._id.toString(), oldValue: { name: role.name }, ...meta });
    await Role.deleteOne({ _id: role._id });
    clearPermissionCache();

    return NextResponse.json(success(null, "Role deleted"));
  } catch (error) {
    console.error("DELETE /api/roles error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
