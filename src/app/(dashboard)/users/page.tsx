import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { UsersClient } from "./users-client";

export const metadata: Metadata = { title: "Users & Access" };

export default async function UsersPage() {
  const user = await requireSessionUser();
  const [canCreate, canUpdate, canDelete] = await Promise.all([
    hasPermission(user, PERMISSIONS.users.create),
    hasPermission(user, PERMISSIONS.users.update),
    hasPermission(user, PERMISSIONS.users.delete),
  ]);
  return <UsersClient canCreate={canCreate} canUpdate={canUpdate} canDelete={canDelete} />;
}
