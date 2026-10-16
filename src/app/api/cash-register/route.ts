import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { CashRegister, ICashRegisterDocument } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { success, badRequest, forbidden } from "@/lib/api";
import {
  openRegister,
  closeRegister,
  getRegisterSummary,
  getOpenRegisterForUser,
  addCashTransaction,
  CashRegisterError,
  listCashTransactions,
  listRegisterSales,
} from "@/lib/cash-register";

/**
 * Cash Register API.
 *
 * GET  /api/cash-register              → current session + summary + recent movements
 * GET  /api/cash-register?history=1    → paginated closed sessions
 * POST /api/cash-register              → action: open | close | cash-in | cash-out | adjust
 */

const openSchema = z.object({
  action: z.literal("open"),
  openCash: z.number().min(0).max(1_000_000),
  note: z.string().max(500).default(""),
});

const closeSchema = z.object({
  action: z.literal("close"),
  registerId: z.string().min(1),
  countedCash: z.number().min(0).max(1_000_000),
  note: z.string().max(500).default(""),
});

const movementSchema = z.object({
  action: z.enum(["cash-in", "cash-out", "adjust"]),
  amount: z.number().min(0.01).max(1_000_000),
  description: z.string().min(1, "Description is required").max(500),
});

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.cashRegister.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const sessionId = searchParams.get("sessionId")?.trim() ?? "";
    const history = searchParams.get("history") === "1";
    const page = Math.max(1, Number(searchParams.get("page") ?? 1));
    const perPage = Math.min(100, Math.max(1, Number(searchParams.get("perPage") ?? 10)));

    if (history) {
      const query: Record<string, unknown> = { status: "closed" };
      if (user.branchId) query.branchId = new mongoose.Types.ObjectId(user.branchId);

      const [total, registers] = await Promise.all([
        CashRegister.countDocuments(query),
        CashRegister.find(query)
          .populate<{ openedBy: { name: string } | null }>("openedBy", "name")
          .populate<{ closedBy: { name: string } | null }>("closedBy", "name")
          .sort({ closedAt: -1 })
          .skip((page - 1) * perPage)
          .limit(perPage)
          .lean(),
      ]);

      return NextResponse.json({
        sessions: registers.map((r) => ({
          _id: r._id.toString(),
          status: r.status,
          openCash: r.openCash,
          expectedCash: r.expectedCash,
          countedCash: r.countedCash,
          difference: r.difference,
          openedAt: r.openedAt,
          closedAt: r.closedAt,
          openedByName: (r.openedBy as unknown as { name: string } | null)?.name ?? "—",
          closedByName: (r.closedBy as unknown as { name: string } | null)?.name ?? "—",
          note: r.note,
        })),
        total,
        page,
        perPage,
        totalPages: Math.ceil(total / perPage),
      });
    }

    // Current session: explicit id, else the caller's open session
    const register: mongoose.FlattenMaps<ICashRegisterDocument> | null = sessionId
      ? ((await CashRegister.findById(sessionId).lean()) as mongoose.FlattenMaps<ICashRegisterDocument> | null)
      : ((await getOpenRegisterForUser(user.id)) as mongoose.FlattenMaps<ICashRegisterDocument> | null);

    if (!register) {
      return NextResponse.json({ session: null, summary: null });
    }

    const summary = await getRegisterSummary(register._id.toString());
    const [movements, sales] = await Promise.all([
      listCashTransactions(register._id.toString(), { page: 1, perPage: 25 }),
      listRegisterSales(register._id.toString(), { page: 1, perPage: 10 }),
    ]);

    return NextResponse.json({
      session: {
        _id: register._id.toString(),
        status: register.status,
        branchId: register.branchId ? register.branchId.toString() : null,
        openCash: register.openCash,
        expectedCash: summary.expectedCash,
        countedCash: register.countedCash,
        difference: register.difference,
        openedAt: register.openedAt,
        closedAt: register.closedAt,
        openedBy: register.openedBy ? register.openedBy.toString() : null,
        note: register.note,
      },
      summary,
      movements: movements.transactions,
      sales: sales.sales,
    });
  } catch (error) {
    console.error("GET /api/cash-register error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();

    const body = await req.json().catch(() => ({}));
    const action = (body as { action?: string }).action;

    if (action === "open") {
      if (!(await hasPermission(user, PERMISSIONS.cashRegister.open))) {
        return NextResponse.json(forbidden(), { status: 403 });
      }
      const parsed = openSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(badRequest(parsed.error.errors[0]?.message ?? "Validation failed"), { status: 400 });
      }
      const register = await openRegister({
        userId: user.id,
        branchId: user.branchId,
        openCash: parsed.data.openCash,
        note: parsed.data.note,
      });
      return NextResponse.json(
        success({ registerId: register._id.toString(), openCash: register.openCash }, "Register opened"),
        { status: 201 }
      );
    }

    if (action === "close") {
      // Closing a register requires the dedicated close permission.
      if (!(await hasPermission(user, PERMISSIONS.cashRegister.close))) {
        return NextResponse.json(forbidden("You need the cash register close permission"), { status: 403 });
      }
      const parsed = closeSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(badRequest(parsed.error.errors[0]?.message ?? "Validation failed"), { status: 400 });
      }
      const result = await closeRegister({
        registerId: parsed.data.registerId,
        userId: user.id,
        countedCash: parsed.data.countedCash,
        note: parsed.data.note,
      });
      return NextResponse.json(success(result, "Register closed"));
    }

    if (action === "cash-in" || action === "cash-out" || action === "adjust") {
      if (!(await hasPermission(user, PERMISSIONS.cashRegister.open))) {
        return NextResponse.json(forbidden(), { status: 403 });
      }
      const parsed = movementSchema.safeParse(body);
      if (!parsed.success) {
        const fieldErrors: Record<string, string> = {};
        parsed.error.errors.forEach((err) => {
          const path = err.path[0];
          if (typeof path === "string") fieldErrors[path] = err.message;
        });
        return NextResponse.json(badRequest("Validation failed", fieldErrors), { status: 400 });
      }

      const register = await getOpenRegisterForUser(user.id);
      if (!register) {
        return NextResponse.json(badRequest("No open register session. Open the register first."), { status: 400 });
      }

      const type = action === "cash-in" ? "income" : action === "cash-out" ? "expense" : "adjustment";
      // Drawer movements are signed: outflows negative, adjustments signed by the user.
      const amount = action === "cash-out" ? -parsed.data.amount : parsed.data.amount;
      const tx = await addCashTransaction({
        registerId: register._id.toString(),
        userId: user.id,
        type,
        amount,
        description: parsed.data.description,
        referenceType: "adjustment",
        branchId: user.branchId,
      });

      return NextResponse.json(success({ transactionId: tx._id.toString() }, "Cash movement recorded"), { status: 201 });
    }

    return NextResponse.json(badRequest("Unknown action"), { status: 400 });
  } catch (error) {
    if (error instanceof CashRegisterError) {
      return NextResponse.json({ success: false, error: { code: error.code, message: error.message } }, { status: 400 });
    }
    console.error("POST /api/cash-register error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
