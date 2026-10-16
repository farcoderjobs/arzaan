import mongoose from "mongoose";
import { AuthUser } from "@/lib/auth";

/**
 * Branch access model:
 *  - user.branchId === null  → unrestricted (Super Admin / HQ): can access every branch.
 *  - user.branchId !== null  → restricted to that branch only.
 *
 * Every branch-sensitive query MUST be scoped with `branchScope(user)` and every
 * write must validate the target with `assertBranchAccess(user, targetBranchId)`.
 */

export type BranchScope = {
  branchId?: mongoose.Types.ObjectId;
};

/** Mongo match clause restricting a `branchId` field to the user's accessible branches. */
export function branchScope(user: Pick<AuthUser, "branchId">): BranchScope {
  if (!user.branchId) return {};
  return { branchId: new mongoose.Types.ObjectId(user.branchId) };
}

export class BranchAccessError extends Error {
  code = "BRANCH_ACCESS_DENIED";
  constructor(message = "You do not have access to this branch") {
    super(message);
  }
}

/**
 * Normalizes the many shapes a branch reference can arrive in: a raw ObjectId,
 * a string id, `null`, or a *populated* document (`{ _id, name, ... }`) —
 * `Document.toString()` yields "[object Object]", which would otherwise deny
 * access incorrectly.
 */
function toBranchIdString(
  value: mongoose.Types.ObjectId | string | null | undefined | { _id?: mongoose.Types.ObjectId | string | null }
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (typeof value === "object" && "_id" in value && value._id != null) {
    return String(value._id);
  }
  return String(value);
}

/**
 * Throws when the user is branch-restricted and the target document belongs to
 * another branch. `null` target branch (HQ/unassigned docs) is only reachable
 * for unrestricted users.
 */
export function assertBranchAccess(
  user: Pick<AuthUser, "branchId">,
  targetBranchId:
    | mongoose.Types.ObjectId
    | string
    | null
    | undefined
    | { _id?: mongoose.Types.ObjectId | string | null }
): void {
  if (!user.branchId) return; // unrestricted
  const target = toBranchIdString(targetBranchId);
  if (target !== user.branchId) {
    throw new BranchAccessError();
  }
}

/** True when the user may read/write data in the given branch. */
export function canAccessBranch(
  user: Pick<AuthUser, "branchId">,
  targetBranchId: mongoose.Types.ObjectId | string | null | undefined
): boolean {
  try {
    assertBranchAccess(user, targetBranchId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the set of ObjectId strings for branches the current user can access.
 * Super Admins and HQ users (no explicit branch assignment) see all of them;
 * branch-restricted users see only their own branch.
 *
 * Used for aggregate queries (balances, supplier ledgers) where the caller
 * wants the filtered set rather than a single branch match.
 */
export function resolveBranchIds(user: Pick<AuthUser, "branchId">): Set<string> {
  if (!user.branchId) return new Set<string>(); // caller must apply no branch filter
  return new Set([user.branchId.toString()]);
}
