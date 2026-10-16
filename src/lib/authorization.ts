import { Role, Permission } from "@/models";
import { AuthUser } from "@/lib/auth";

export type PermissionName = Permission["name"];

interface CachedPermissions {
  perms: Set<string>;
  expires: number;
}

// Short TTL so role/permission changes (including re-seeding) take effect
// without requiring a server restart.
const PERMISSION_CACHE_TTL_MS = 60_000;
const permissionCache = new Map<string, CachedPermissions>();

export async function getUserPermissions(userId: string, roleId: string): Promise<Set<string>> {
  const cacheKey = `${userId}:${roleId}`;
  const cached = permissionCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.perms;
  }

  const role = await Role.findById(roleId).populate<{ permissions: Array<{ name: string }> }>("permissions", "name").lean() as { permissions: Array<{ name: string }> | null } | null;
  const set = new Set<string>();
  if (role && Array.isArray(role.permissions)) {
    for (const p of role.permissions) {
      set.add(p.name);
    }
  }
  permissionCache.set(cacheKey, { perms: set, expires: Date.now() + PERMISSION_CACHE_TTL_MS });
  return set;
}

export async function hasPermission(user: AuthUser, permission: PermissionName): Promise<boolean> {
  const permissions = await getUserPermissions(user.id, user.roleId);
  return permissions.has(permission);
}

export async function requirePermission(user: AuthUser, permission: PermissionName): Promise<void> {
  const ok = await hasPermission(user, permission);
  if (!ok) {
    throw new Error("FORBIDDEN");
  }
}

export async function hasAnyPermission(user: AuthUser, permissions: PermissionName[]): Promise<boolean> {
  const userPerms = await getUserPermissions(user.id, user.roleId);
  return permissions.some((p) => userPerms.has(p));
}

export async function hasAllPermissions(user: AuthUser, permissions: PermissionName[]): Promise<boolean> {
  const userPerms = await getUserPermissions(user.id, user.roleId);
  return permissions.every((p) => userPerms.has(p));
}

export function clearPermissionCache() {
  permissionCache.clear();
}
