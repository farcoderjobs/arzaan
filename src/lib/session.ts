import { getCurrentUser, requireAuth } from "@/lib/auth";
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
  const user = await requireAuth();
  const perms = await getUserPermissions(user.id, user.roleId);
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
