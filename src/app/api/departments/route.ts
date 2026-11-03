import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { z } from "zod";
import { connectDB } from "@/lib/mongodb";
import { Department, User, Branch, Sale } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { success, badRequest, forbidden, notFound } from "@/lib/api";
import { BranchAccessError, assertBranchAccess } from "@/lib/branch-access";
import { recordAuditLog, requestMeta } from "@/lib/audit";

/**
 * Departments API.
 *
 * GET    /api/departments?all=1  → departments of the accessible branch(es) + assignable employees
 * POST   /api/departments        → create
 * PUT    /api/departments        → update (name/code/employee/note/status)
 * PATCH  /api/departments        → deactivate | activate (history is never deleted)
 *
 * A department belongs to one shop and is headed by exactly one employee. The
 * database enforces one name per shop and at most one ACTIVE department per
 * employee, so a duplicate assignment cannot be created by a race either.
 */

const objectIdField = z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid id");

const createSchema = z.object({
  name: z.string().trim().min(2, "Department name is required").max(120),
  code: z.string().trim().max(20).optional().default(""),
  branchId: objectIdField.optional(),
  employeeId: objectIdField,
  note: z.string().trim().max(300).optional().default(""),
  status: z.enum(["active", "inactive"]).optional().default("active"),
});

const updateSchema = z.object({
  id: objectIdField,
  name: z.string().trim().min(2, "Department name is required").max(120).optional(),
  code: z.string().trim().max(20).optional(),
  employeeId: objectIdField.optional(),
  note: z.string().trim().max(300).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

const actionSchema = z.object({
  action: z.enum(["deactivate", "activate"]),
  id: objectIdField,
});

function fieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  err.errors.forEach((e) => {
    const path = e.path[0];
    if (typeof path === "string") out[path] = e.message;
  });
  return out;
}

function toRow(d: Record<string, unknown>) {
  const employee = d.employeeId as { _id?: unknown; name?: string; email?: string } | null;
  const branch = d.branchId as { _id?: unknown; name?: string } | null;
  return {
    _id: String(d._id),
    name: d.name as string,
    code: (d.code as string) ?? "",
    branchId: branch?._id ? String(branch._id) : d.branchId ? String(d.branchId) : null,
    branchName: branch?.name ?? null,
    employeeId: employee?._id ? String(employee._id) : d.employeeId ? String(d.employeeId) : null,
    employeeName: employee?.name ?? null,
    employeeEmail: employee?.email ?? null,
    status: d.status as string,
    note: (d.note as string) ?? "",
    deactivatedAt: d.deactivatedAt ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.departments.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const includeAll = searchParams.get("all") === "1";

    // Branch-restricted users only ever see their own shop's departments.
    const query: Record<string, unknown> = {};
    if (user.branchId) query.branchId = new mongoose.Types.ObjectId(user.branchId);
    if (!includeAll) query.status = "active";

    const departments = await Department.find(query)
      .populate<{ employeeId: { _id: unknown; name: string; email: string } }>("employeeId", "name email")
      .populate<{ branchId: { _id: unknown; name: string } }>("branchId", "name")
      .sort({ name: 1 })
      .lean() as Array<Record<string, unknown>>;

    // Employees that may be assigned: active users of the visible branches.
    const employeeQuery: Record<string, unknown> = { status: "active" };
    if (user.branchId) employeeQuery.branchId = new mongoose.Types.ObjectId(user.branchId);
    const employees = await User.find(employeeQuery).select("name email branchId").sort({ name: 1 }).lean();

    const branches = await Branch.find(user.branchId ? { _id: new mongoose.Types.ObjectId(user.branchId) } : {})
      .select("name code status type")
      .sort({ name: 1 })
      .lean();

    return NextResponse.json({
      departments: departments.map(toRow),
      employees: employees.map((e) => ({
        _id: String(e._id),
        name: e.name,
        email: e.email,
        branchId: e.branchId ? String(e.branchId) : null,
      })),
      branches: branches.map((b) => ({
        _id: String(b._id),
        name: b.name,
        code: b.code,
        status: b.status,
        type: b.type ?? "shop",
      })),
    });
  } catch (error) {
    console.error("GET /api/departments error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.departments.create))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const parsed = createSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(badRequest("Validation failed", fieldErrors(parsed.error)), { status: 400 });
    }
    const data = parsed.data;

    const branchId = data.branchId ?? user.branchId;
    if (!branchId) {
      return NextResponse.json(badRequest("A department must belong to a shop"), { status: 400 });
    }

    try {
      assertBranchAccess(user, branchId);
    } catch (err) {
      if (err instanceof BranchAccessError) {
        return NextResponse.json(forbidden(err.message), { status: 403 });
      }
      throw err;
    }

    const branch = await Branch.findById(branchId);
    if (!branch) return NextResponse.json(notFound("Shop not found"), { status: 404 });
    if (branch.status !== "active") {
      return NextResponse.json(badRequest("The selected shop is inactive"), { status: 400 });
    }
    if ((branch.type ?? "shop") === "warehouse") {
      return NextResponse.json(badRequest("A warehouse is a stock location, not a department shop"), { status: 400 });
    }

    const employeeError = await validateEmployee(data.employeeId, branchId);
    if (employeeError) return NextResponse.json(badRequest(employeeError), { status: 400 });

    const name = data.name.trim();
    const existing = await Department.findOne({ branchId, name });
    if (existing) {
      return NextResponse.json(badRequest("A department with this name already exists in this shop"), { status: 400 });
    }

    const department = await Department.create({
      name,
      code: data.code?.trim().toUpperCase() ?? "",
      branchId,
      employeeId: data.employeeId,
      status: data.status ?? "active",
      note: data.note ?? "",
      createdBy: user.id,
    });

    const meta = requestMeta(req);
    await recordAuditLog({
      user,
      action: "department.create",
      entityType: "Department",
      entityId: department._id.toString(),
      newValue: { name: department.name, employeeId: String(department.employeeId) },
      branchId: branchId.toString(),
      ...meta,
    });

    const created = await Department.findById(department._id)
      .populate("employeeId", "name email")
      .populate("branchId", "name")
      .lean();
    return NextResponse.json(
      success({ department: toRow(created as unknown as Record<string, unknown>) }, "Department created"),
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
      return NextResponse.json(
        badRequest("That employee already heads another active department in this shop"),
        { status: 400 }
      );
    }
    console.error("POST /api/departments error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.departments.update))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const parsed = updateSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(badRequest("Validation failed", fieldErrors(parsed.error)), { status: 400 });
    }
    const data = parsed.data;

    const department = await Department.findById(data.id);
    if (!department) return NextResponse.json(notFound("Department not found"), { status: 404 });
    try {
      assertBranchAccess(user, department.branchId);
    } catch (err) {
      if (err instanceof BranchAccessError) {
        return NextResponse.json(forbidden(err.message), { status: 403 });
      }
      throw err;
    }

    const before = {
      name: department.name,
      employeeId: String(department.employeeId),
      status: department.status,
      note: department.note,
    };

    const nextStatus = data.status ?? department.status;
    const nextEmployee = data.employeeId ?? String(department.employeeId);

    if (data.employeeId && data.employeeId !== String(department.employeeId)) {
      const employeeError = await validateEmployee(data.employeeId, String(department.branchId));
      if (employeeError) return NextResponse.json(badRequest(employeeError), { status: 400 });
      department.employeeId = new mongoose.Types.ObjectId(data.employeeId);
    }
    if (data.name !== undefined) {
      const name = data.name.trim();
      const clash = await Department.findOne({ branchId: department.branchId, name, _id: { $ne: department._id } });
      if (clash) {
        return NextResponse.json(badRequest("A department with this name already exists in this shop"), { status: 400 });
      }
      department.name = name;
    }
    if (data.code !== undefined) department.code = data.code.trim().toUpperCase();
    if (data.note !== undefined) department.note = data.note;

    if (nextStatus === "active" && department.status !== "active") {
      // Reactivating must respect the one-active-department-per-employee rule.
      const clash = await Department.findOne({
        branchId: department.branchId,
        employeeId: nextEmployee,
        status: "active",
        _id: { $ne: department._id },
      });
      if (clash) {
        return NextResponse.json(
          badRequest(`This employee already heads the active department "${clash.name}"`),
          { status: 400 }
        );
      }
      department.status = "active";
      department.deactivatedAt = null;
      department.deactivatedBy = null;
    } else if (data.status === "inactive") {
      department.status = "inactive";
      department.deactivatedAt = new Date();
      department.deactivatedBy = new mongoose.Types.ObjectId(user.id);
    }

    await department.save();

    const meta = requestMeta(req);
    await recordAuditLog({
      user,
      action: "department.update",
      entityType: "Department",
      entityId: department._id.toString(),
      oldValue: before,
      newValue: {
        name: department.name,
        employeeId: String(department.employeeId),
        status: department.status,
        note: department.note,
      },
      branchId: department.branchId.toString(),
      ...meta,
    });

    const updated = await Department.findById(department._id)
      .populate("employeeId", "name email")
      .populate("branchId", "name")
      .lean();
    return NextResponse.json(
      success({ department: toRow(updated as unknown as Record<string, unknown>) }, "Department updated")
    );
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
      return NextResponse.json(
        badRequest("That employee already heads another active department in this shop"),
        { status: 400 }
      );
    }
    console.error("PUT /api/departments error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    const parsed = actionSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(badRequest("Validation failed", fieldErrors(parsed.error)), { status: 400 });
    }

    const department = await Department.findById(parsed.data.id);
    if (!department) return NextResponse.json(notFound("Department not found"), { status: 404 });
    try {
      assertBranchAccess(user, department.branchId);
    } catch (err) {
      if (err instanceof BranchAccessError) {
        return NextResponse.json(forbidden(err.message), { status: 403 });
      }
      throw err;
    }

    const meta = requestMeta(req);
    if (parsed.data.action === "deactivate") {
      if (!(await hasPermission(user, PERMISSIONS.departments.deactivate))) {
        return NextResponse.json(forbidden(), { status: 403 });
      }
      if (department.status === "inactive") {
        return NextResponse.json(badRequest("Department is already inactive"), { status: 400 });
      }
      // Departments are never hard-deleted: sales and returns keep pointing at
      // them, so history stays intact and the row is only deactivated.
      department.status = "inactive";
      department.deactivatedAt = new Date();
      department.deactivatedBy = new mongoose.Types.ObjectId(user.id);
      await department.save();

      const sales = await Sale.countDocuments({ departmentId: department._id });
      await recordAuditLog({
        user,
        action: "department.deactivate",
        entityType: "Department",
        entityId: department._id.toString(),
        oldValue: { status: "active" },
        newValue: { status: "inactive", attributedSales: sales },
        note: `Deactivated ${department.name}`,
        branchId: department.branchId.toString(),
        ...meta,
      });
      return NextResponse.json(
        success({ department: { _id: String(department._id), status: department.status } }, "Department deactivated")
      );
    }

    if (!(await hasPermission(user, PERMISSIONS.departments.update))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }
    const clash = await Department.findOne({
      branchId: department.branchId,
      employeeId: department.employeeId,
      status: "active",
      _id: { $ne: department._id },
    });
    if (clash) {
      return NextResponse.json(
        badRequest(`This employee already heads the active department "${clash.name}"`),
        { status: 400 }
      );
    }
    department.status = "active";
    department.deactivatedAt = null;
    department.deactivatedBy = null;
    await department.save();

    await recordAuditLog({
      user,
      action: "department.activate",
      entityType: "Department",
      entityId: department._id.toString(),
      oldValue: { status: "inactive" },
      newValue: { status: "active" },
      branchId: department.branchId.toString(),
      ...meta,
    });
    return NextResponse.json(
      success({ department: { _id: String(department._id), status: department.status } }, "Department activated")
    );
  } catch (error) {
    console.error("PATCH /api/departments error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

/**
 * An employee may only head a department of their own shop, and must be active.
 * Returns a human error message, or null when the assignment is valid.
 */
async function validateEmployee(employeeId: string, branchId: unknown): Promise<string | null> {
  if (!mongoose.Types.ObjectId.isValid(employeeId)) return "Invalid employee";
  const employee = await User.findById(employeeId).select("status branchId name").lean();
  if (!employee) return "Employee not found";
  if (employee.status !== "active") return "The selected employee is not active";
  if (!employee.branchId || String(employee.branchId) !== String(branchId)) {
    return "The employee must belong to the same shop as the department";
  }
  return null;
}
