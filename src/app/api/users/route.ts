import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { User, Role, Branch, Sale, Department } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { success, badRequest, forbidden, notFound } from "@/lib/api";
import { hashPassword } from "@/utils/auth";
import { assertBranchAccess, BranchAccessError } from "@/lib/branch-access";
import { recordAuditLog, requestMeta, diffForAudit } from "@/lib/audit";

/**
 * Users & Access — Users API.
 * GET    /api/users        → paginated list with role/branch names
 * POST   /api/users        → create | update | activate | deactivate | change-password | assign-role | assign-branch
 * DELETE /api/users        → deactivate (never hard-delete; the final active Super Admin is protected)
 */

const objectIdField = z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid id");

const createSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(120),
  email: z.string().email("Invalid email address"),
  phone: z.string().max(50).default(""),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
  roleId: objectIdField,
  branchId: z.string().nullable().optional(),
  departmentId: objectIdField.nullable().optional(),
});

const updateSchema = z.object({
  id: objectIdField,
  name: z.string().min(2).max(120).optional(),
  phone: z.string().max(50).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  roleId: objectIdField.optional(),
  branchId: z.string().nullable().optional(),
  departmentId: objectIdField.nullable().optional(),
});

const passwordSchema = z.object({
  id: objectIdField,
  newPassword: z.string().min(8, "Password must be at least 8 characters").max(128),
});

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("update"), data: updateSchema }),
  z.object({ action: z.literal("activate"), id: objectIdField }),
  z.object({ action: z.literal("deactivate"), id: objectIdField }),
  z.object({ action: z.literal("change-password"), data: passwordSchema }),
]);

function fieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  err.errors.forEach((e) => {
    const path = e.path[0];
    if (typeof path === "string") out[path] = e.message;
  });
  return out;
}

function toRow(
  u: Record<string, unknown>,
  roleName: string | null,
  branchName: string | null,
  department: { _id: string; name: string } | null
) {
  return {
    _id: (u._id as mongoose.Types.ObjectId).toString(),
    name: u.name as string,
    email: u.email as string,
    phone: (u.phone as string) ?? "",
    status: u.status,
    roleId: (u.roleId as mongoose.Types.ObjectId)?.toString() ?? null,
    roleName,
    branchId: u.branchId ? (u.branchId as mongoose.Types.ObjectId).toString() : null,
    branchName,
    departmentId: department?._id ?? null,
    departmentName: department?.name ?? null,
    lastLoginAt: u.lastLoginAt ?? null,
    createdAt: u.createdAt,
  };
}

/**
 * Checks that a department can receive this shop's employee. Returns a human
 * error message, or null when the assignment is valid.
 */
async function checkDepartment(departmentId: string, branchId: string | null): Promise<string | null> {
  if (!mongoose.Types.ObjectId.isValid(departmentId)) return "Invalid department";
  const department = await Department.findById(departmentId).select("name branchId status").lean();
  if (!department) return "Selected department does not exist";
  if (department.status !== "active") return "Selected department is inactive";
  if (!branchId) return "Set the employee's branch before assigning a department";
  if (String(department.branchId) !== branchId) {
    return "The employee and the department must belong to the same shop";
  }
  return null;
}

/**
 * Makes the employee the head of the selected department.
 *
 * The relationship lives on the Department document (one active department per
 * employee and shop), so assigning from the Users screen updates that row
 * instead of creating a second, conflicting copy on the user.
 */
async function assignDepartment(
  userId: string,
  branchId: string | null,
  departmentId: string
): Promise<string | null> {
  const invalid = await checkDepartment(departmentId, branchId);
  if (invalid) return invalid;

  const department = await Department.findById(departmentId);
  if (!department) return "Selected department does not exist";
  if (String(department.employeeId) === userId) return null;

  const current = await Department.findOne({
    employeeId: new mongoose.Types.ObjectId(userId),
    branchId: new mongoose.Types.ObjectId(branchId as string),
    status: "active",
    _id: { $ne: department._id },
  })
    .select("name")
    .lean();
  if (current) {
    return `This employee already heads the department "${current.name}" — change it on the Departments page`;
  }

  department.employeeId = new mongoose.Types.ObjectId(userId);
  await department.save();
  return null;
}

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.users.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const page = Math.max(1, Number(searchParams.get("page") ?? 1));
    const perPage = Math.min(100, Math.max(1, Number(searchParams.get("perPage") ?? 15)));
    const search = searchParams.get("search")?.trim() ?? "";
    const status = searchParams.get("status")?.trim() ?? "";

    const query: Record<string, unknown> = {};
    if (status) query.status = status;
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&"), "i");
      query.$or = [{ name: rx }, { email: rx }, { phone: rx }];
    }
    // Branch-restricted admins only see users of their own branch.
    if (user.branchId) query.branchId = new mongoose.Types.ObjectId(user.branchId);

    const [total, users] = await Promise.all([
      User.countDocuments(query),
      User.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * perPage)
        .limit(perPage)
        .populate<{ roleId: { _id: mongoose.Types.ObjectId; name: string } | null }>("roleId", "name")
        .populate<{ branchId: { _id: mongoose.Types.ObjectId; name: string } | null }>("branchId", "name")
        .lean() as Promise<Array<Record<string, unknown>>>,
    ]);

    // A department owns the employee relationship (one active department per
    // employee per shop), so read it from there instead of duplicating the id
    // on the user document.
    const departments = users.length
      ? await Department.find({
          employeeId: { $in: users.map((u) => u._id as mongoose.Types.ObjectId) },
          status: "active",
        })
          .select("name employeeId")
          .lean()
      : [];
    const departmentByEmployee = new Map(
      departments.map((d) => [String(d.employeeId), { _id: String(d._id), name: d.name }])
    );

    return NextResponse.json({
      users: users.map((u) =>
        toRow(
          u,
          (u.roleId as { name: string } | null)?.name ?? null,
          (u.branchId as { name: string } | null)?.name ?? null,
          departmentByEmployee.get(String(u._id)) ?? null
        )
      ),
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    });
  } catch (error) {
    console.error("GET /api/users error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    const canManage = await hasPermission(user, PERMISSIONS.users.update);
    const canCreate = await hasPermission(user, PERMISSIONS.users.create);
    if (!canManage && !canCreate) {
      return NextResponse.json(forbidden(), { status: 403 });
    }
    const meta = requestMeta(req);

    const body = await req.json().catch(() => null);

    // ---------- Create ----------
    if (body && typeof body === "object" && !("action" in body)) {
      if (!canCreate) return NextResponse.json(forbidden(), { status: 403 });
      const parsed = createSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(badRequest("Validation failed", fieldErrors(parsed.error)), { status: 400 });
      }
      const data = parsed.data;

      const role = await Role.findById(data.roleId);
      if (!role) return NextResponse.json(badRequest("Selected role does not exist"), { status: 400 });

      const emailTaken = await User.findOne({ email: data.email.toLowerCase() });
      if (emailTaken) return NextResponse.json(badRequest("A user with this email already exists"), { status: 400 });

      if (data.branchId) {
        const branch = await Branch.findById(data.branchId);
        if (!branch) return NextResponse.json(badRequest("Selected branch does not exist"), { status: 400 });
        assertBranchAccess(user, branch._id);
      }

      // Validate the department before creating anything, so a rejected
      // assignment cannot leave a half-created user behind.
      if (data.departmentId) {
        const departmentError = await checkDepartment(
          data.departmentId,
          data.branchId ?? null
        );
        if (departmentError) return NextResponse.json(badRequest(departmentError), { status: 400 });
      }

      const created = await User.create({
        name: data.name.trim(),
        email: data.email.toLowerCase().trim(),
        phone: (data.phone ?? "").trim(),
        passwordHash: hashPassword(data.password),
        roleId: data.roleId,
        branchId: data.branchId ? new mongoose.Types.ObjectId(data.branchId) : null,
        status: "active",
      });

      if (data.departmentId) {
        const departmentError = await assignDepartment(
          created._id.toString(),
          created.branchId ? created.branchId.toString() : null,
          data.departmentId
        );
        if (departmentError) {
          // Roll the user back: the request failed as a whole.
          await User.deleteOne({ _id: created._id });
          return NextResponse.json(badRequest(departmentError), { status: 400 });
        }
      }

      await recordAuditLog({
        user,
        action: "user.create",
        entityType: "User",
        entityId: created._id.toString(),
        newValue: { name: created.name, email: created.email, roleId: data.roleId, branchId: created.branchId?.toString() ?? null },
        ...meta,
      });

      return NextResponse.json(success({ id: created._id.toString() }, "User created"), { status: 201 });
    }

    // ---------- Actions ----------
    const parsed = actionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(badRequest("Validation failed", fieldErrors(parsed.error)), { status: 400 });
    }
    if (!canManage) return NextResponse.json(forbidden(), { status: 403 });
    const payload = parsed.data;

    const targetId =
      payload.action === "update" || payload.action === "change-password" ? payload.data.id : payload.id;
    const target = await User.findById(targetId);
    if (!target) return NextResponse.json(notFound("User not found"), { status: 404 });
    assertBranchAccess(user, target.branchId);

    // Guard: the last active SuperAdmin can never be deactivated or demoted.
    const lastAdminGuard = async (
      candidate: { roleId: mongoose.Types.ObjectId; status: string }
    ): Promise<string | null> => {
      if (candidate.status === "active" && candidate.roleId.equals(target.roleId)) return null;
      const targetRole = await Role.findById(target.roleId);
      if (targetRole?.name !== "SuperAdmin") return null;
      const activeAdmins = await User.countDocuments({
        roleId: target.roleId,
        status: "active",
        _id: { $ne: target._id },
      });
      if (activeAdmins === 0) {
        return "Cannot remove or deactivate the final active Super Admin";
      }
      return null;
    };

    if (payload.action === "update") {
      const data = payload.data;
      const before = { name: target.name, phone: target.phone, status: target.status, roleId: target.roleId.toString(), branchId: target.branchId?.toString() ?? null };

      const guard = await lastAdminGuard({
        roleId: data.roleId ? new mongoose.Types.ObjectId(data.roleId) : target.roleId,
        status: data.status ?? target.status,
      });
      if (guard) return NextResponse.json(badRequest(guard), { status: 400 });

      if (data.roleId) {
        const role = await Role.findById(data.roleId);
        if (!role) return NextResponse.json(badRequest("Selected role does not exist"), { status: 400 });
        target.roleId = new mongoose.Types.ObjectId(data.roleId);
      }
      if (data.branchId !== undefined) {
        if (data.branchId === null || data.branchId === "") {
          target.branchId = null;
        } else {
          const branch = await Branch.findById(data.branchId);
          if (!branch) return NextResponse.json(badRequest("Selected branch does not exist"), { status: 400 });
          assertBranchAccess(user, branch._id);
          target.branchId = branch._id;
        }
      }
      if (data.name !== undefined) target.name = data.name.trim();
      if (data.phone !== undefined) target.phone = data.phone.trim();
      if (data.status !== undefined) target.status = data.status;

      // Assigning a department updates the Department row (it owns the head
      // employee), so it must see the employee's final branch.
      if (data.departmentId) {
        const departmentError = await assignDepartment(
          target._id.toString(),
          target.branchId ? target.branchId.toString() : null,
          data.departmentId
        );
        if (departmentError) return NextResponse.json(badRequest(departmentError), { status: 400 });
      }

      await target.save();

      await recordAuditLog({
        user,
        action: "user.update",
        entityType: "User",
        entityId: target._id.toString(),
        changes: diffForAudit(before, {
          name: target.name,
          phone: target.phone,
          status: target.status,
          roleId: target.roleId.toString(),
          branchId: target.branchId?.toString() ?? null,
        }),
        ...meta,
      });

      return NextResponse.json(success({ id: target._id.toString() }, "User updated"));
    }

    if (payload.action === "activate") {
      const guard = await lastAdminGuard({ roleId: target.roleId, status: "active" });
      if (guard) return NextResponse.json(badRequest(guard), { status: 400 });
      target.status = "active";
      await target.save();
      await recordAuditLog({ user, action: "user.activate", entityType: "User", entityId: target._id.toString(), ...meta });
      return NextResponse.json(success({ id: target._id.toString(), status: "active" }, "User activated"));
    }

    if (payload.action === "deactivate") {
      if (target._id.equals(new mongoose.Types.ObjectId(user.id))) {
        return NextResponse.json(badRequest("You cannot deactivate your own account"), { status: 400 });
      }
      const guard = await lastAdminGuard({ roleId: target.roleId, status: "inactive" });
      if (guard) return NextResponse.json(badRequest(guard), { status: 400 });
      target.status = "inactive";
      target.refreshTokenHash = null;
      await target.save();
      await recordAuditLog({ user, action: "user.deactivate", entityType: "User", entityId: target._id.toString(), ...meta });
      return NextResponse.json(success({ id: target._id.toString(), status: "inactive" }, "User deactivated"));
    }

    if (payload.action === "change-password") {
      if (!(await hasPermission(user, PERMISSIONS.users.update))) {
        return NextResponse.json(forbidden(), { status: 403 });
      }
      target.passwordHash = hashPassword(payload.data.newPassword);
      target.refreshTokenHash = null; // force re-login everywhere
      await target.save();
      await recordAuditLog({ user, action: "user.password_change", entityType: "User", entityId: target._id.toString(), ...meta });
      return NextResponse.json(success({ id: target._id.toString() }, "Password updated"));
    }

    return NextResponse.json(badRequest("Unknown action"), { status: 400 });
  } catch (error) {
    if (error instanceof BranchAccessError) {
      return NextResponse.json(forbidden(error.message), { status: 403 });
    }
    console.error("POST /api/users error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.users.delete))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }
    const meta = requestMeta(req);

    const { id } = (await req.json()) as { id?: string };
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(badRequest("User ID is required"), { status: 400 });
    }
    if (id === user.id) {
      return NextResponse.json(badRequest("You cannot delete your own account"), { status: 400 });
    }

    const target = await User.findById(id);
    if (!target) return NextResponse.json(notFound("User not found"), { status: 404 });
    assertBranchAccess(user, target.branchId);

    // Role guard — never remove the final active Super Admin.
    const role = await Role.findById(target.roleId);
    if (role?.name === "SuperAdmin") {
      const activeAdmins = await User.countDocuments({
        roleId: target.roleId,
        status: "active",
        _id: { $ne: target._id },
      });
      if (activeAdmins === 0) {
        return NextResponse.json(badRequest("Cannot delete the final active Super Admin"), { status: 400 });
      }
    }

    // Users with sales history are deactivated, never hard-deleted (referential integrity).
    const hasSales = await Sale.exists({ cashierId: target._id });
    if (hasSales) {
      target.status = "inactive";
      target.refreshTokenHash = null;
      await target.save();
      await recordAuditLog({ user, action: "user.deactivate", entityType: "User", entityId: target._id.toString(), note: "Deactivated instead of deleted (has sales history)", ...meta });
      return NextResponse.json(success(null, "User has sales history — deactivated instead of deleted"));
    }

    await recordAuditLog({ user, action: "user.delete", entityType: "User", entityId: target._id.toString(), oldValue: { email: target.email, name: target.name }, ...meta });
    await User.deleteOne({ _id: target._id });
    return NextResponse.json(success(null, "User deleted"));
  } catch (error) {
    if (error instanceof BranchAccessError) {
      return NextResponse.json(forbidden(error.message), { status: 403 });
    }
    console.error("DELETE /api/users error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
