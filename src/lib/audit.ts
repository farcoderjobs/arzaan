import mongoose from "mongoose";
import { AuditLog } from "@/models";
import { AuthUser } from "@/lib/auth";

/**
 * Audit log service — append-only.
 *
 * Records every security-relevant action with a consistent shape:
 *   userId, action, entityType, entityId, oldValue, newValue, branchId, timestamp (createdAt)
 *
 * `changes` stores { field: { before, after } } pairs; for simple actions the
 * payload is stored under `note`. Audit rows are never updated or deleted by
 * application code — there is no update/delete API for them.
 */

export type AuditChange = { before?: unknown; after?: unknown };

export type AuditInput = {
  user?: Pick<AuthUser, "id" | "branchId"> | null;
  action: string;
  entityType: string;
  entityId?: string | mongoose.Types.ObjectId | null;
  oldValue?: unknown;
  newValue?: unknown;
  branchId?: string | mongoose.Types.ObjectId | null;
  ip?: string | null;
  userAgent?: string | null;
  note?: string | null;
  changes?: Record<string, AuditChange>;
};

/** Compute a { field: { before, after } } diff between two flat-ish objects. */
export function diffForAudit(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  fields?: string[]
): Record<string, AuditChange> {
  const changes: Record<string, AuditChange> = {};
  const keys = fields ?? Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]));
  for (const key of keys) {
    const b = before?.[key];
    const a = after?.[key];
    const bs = normalize(b);
    const as = normalize(a);
    if (bs !== as) changes[key] = { before: b ?? null, after: a ?? null };
  }
  return changes;
}

function normalize(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Fire-and-forget audit writer. Never throws into the caller's flow — a failed
 * audit write is logged but must not roll back business operations. When called
 * inside a transaction, pass the session so the row commits atomically.
 */
export async function recordAuditLog(input: AuditInput, session?: mongoose.ClientSession | null): Promise<void> {
  try {
    const branchId = input.branchId ?? input.user?.branchId ?? null;
    const changes = input.changes ?? {};
    if (input.oldValue !== undefined || input.newValue !== undefined) {
      changes.value = { before: input.oldValue ?? null, after: input.newValue ?? null };
    }
    await AuditLog.create(
      [
        {
          action: input.action.slice(0, 120),
          entityType: input.entityType,
          entityId: input.entityId ? new mongoose.Types.ObjectId(input.entityId.toString()) : null,
          userId: input.user?.id ? new mongoose.Types.ObjectId(input.user.id) : null,
          branchId: branchId ? new mongoose.Types.ObjectId(branchId.toString()) : null,
          changes,
          ip: input.ip ?? null,
          userAgent: input.userAgent ? input.userAgent.slice(0, 500) : null,
          note: input.note ?? null,
        },
      ],
      session ? { session } : undefined
    );
  } catch (err) {
    console.error("[audit] failed to record", input.action, err);
  }
}

/** Extracts request metadata for audit rows. */
export function requestMeta(req: Request): { ip: string | null; userAgent: string | null } {
  const h = req.headers;
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    null;
  return { ip, userAgent: h.get("user-agent") };
}
