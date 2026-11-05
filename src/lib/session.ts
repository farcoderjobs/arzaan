import { getCurrentUser, requireAuth } from "@/lib/auth";
import { beginSyncActor } from "@/lib/sync/tracking";
import { assertLicenseActive } from "@/lib/license";
import { getUserPermissions, hasPermission as checkPermission, requirePermission as checkRequiredPermission } from "@/lib/authorization";
import { PermissionName } from "@/lib/authorization";
import { AuthUser } from "@/lib/auth";

export interface SessionUser extends AuthUser {
  permissions: string[];
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  const permissions = await getUserPermissions(user.id, user.roleId);
  return {
    ...user,
    permissions: Array.from(permissions),
  };
}

export async function requireSessionUser(): Promise<SessionUser> {
  // The actor MUST be established before the first `await`. An AsyncLocalStorage
  // transition only affects the context that is executing right now: once this
  // function suspends, the route handler resumes in *its own* context and would
  // never see an actor entered later — every document written by the request
  // would be queued for replication with no acting user. This function's prologue
  // still runs inside the caller's frame, so entering a placeholder here and
  // filling it in after the awaits gives the whole request (and the mongoose
  // hooks that queue replication) one shared, mutable actor object.
  const actor = beginSyncActor();

  // Every authenticated page and API route passes through here, so an expired
  // subscription stops the whole application (not just the screens).
  await assertLicenseActive();

  const user = await requireAuth();
  const perms = await getUserPermissions(user.id, user.roleId);

  // Fills the shared object — visible to everything that inherited the store.
  actor.userId = user.id;
  actor.branchId = user.branchId;

  return {
    ...user,
    permissions: Array.from(perms),
  };
}

export async function hasPermission(permission: PermissionName): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  return checkPermission(user, permission);
}

export async function requirePermission(permission: PermissionName): Promise<void> {
  const user = await requireAuth();
  return checkRequiredPermission(user, permission);
}
